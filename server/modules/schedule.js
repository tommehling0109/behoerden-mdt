import { all, get, run, now, tx } from '../core/db.js';
import { bad, forbidden, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { getConfig } from '../core/config.js';
import { notify } from '../core/notifications.js';
import { memberLabel } from '../core/identity.js';
import { registerLookup, lookupEntries, lookupEntry, isActiveEntry, lookupByKey } from '../core/lookups.js';
import { registerWidget } from './dashboard.js';

/**
 * Termine & Aufträge: ein gemeinsamer Kalender (Termine mit Art, Ort, Beteiligten, Zu-/Absage und Erinnerungen) und Aufträge, die an Mitglieder verteilt
 * werden (Frist, Priorität, Status je Beauftragtem, optional einem Termin zugeordnet). Erinnerungen laufen serverseitig (Benachrichtigung).
 * Rechte: schedule.view (Kalender + eigene Aufträge) · schedule.create (Termine anlegen) · schedule.tasks.assign (Aufträge vergeben) · schedule.manage (alles sehen/ändern).
 * Namen anderer Mitglieder erscheinen nie – nur Personalnummern.
 */
const has = (u, p) => u.isAdmin || u.perms.has(p);
const KINDS = [['meeting', 'Besprechung', '#5b8def'], ['handover', 'Übergabe / Treffen', '#f59e0b'], ['mission', 'Einsatz / Aktion', '#ef4444'], ['delivery', 'Lieferung / Abholung', '#22c55e'],
  ['court', 'Gericht / Behörde', '#a855f7'], ['training', 'Training / Einweisung', '#06b6d4'], ['other', 'Sonstiges', '#94a3b8']];
registerLookup({ key: 'schedule.event_kind', module: 'Termine', label: 'Art von Terminen', description: 'Besprechung, Übergabe, Einsatz … – Farbe und Beschriftung im Kalender, frei erweiterbar.',
  fixed: KINDS.map(([key, label, color]) => ({ key, label, color })), usage: (id) => get('SELECT COUNT(*) c FROM cal_events WHERE kind_id = ?', id).c });

const REMIND = [[0, 'Zum Termin'], [5, '5 Minuten vorher'], [15, '15 Minuten vorher'], [30, '30 Minuten vorher'], [60, '1 Stunde vorher'], [120, '2 Stunden vorher'], [1440, '1 Tag vorher'], [2880, '2 Tage vorher']];
const REMIND_MIN = new Set(REMIND.map(([m]) => m));
const PRIORITIES = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', urgent: 'Dringend' };
const RSVP = { pending: 'Offen', yes: 'Zugesagt', maybe: 'Vielleicht', no: 'Abgesagt' };
const TASK_STATES = { open: 'Offen', accepted: 'Angenommen', done: 'Erledigt', declined: 'Abgelehnt' };
const json = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const iso = (v, name, required = true) => {
  if (v == null || v === '') { if (required) throw bad(`${name} ist erforderlich.`); return null; }
  const t = Date.parse(v); if (typeof v !== 'string' || !Number.isFinite(t)) throw bad(`${name}: ungültiges Datum.`);
  return new Date(t).toISOString();
};
const taskNo = (id) => `AUF-${String(id).padStart(4, '0')}`;
const lbl = (viewer, u) => (u ? (u.id === viewer.id ? `${memberLabel(u)} (Du)` : memberLabel(u)) : 'Gelöschtes Mitglied');
const userRow = (id) => get('SELECT id, member_number, status FROM users WHERE id = ?', id);
const activeUsers = (ids, what) => { const out = []; for (const id of new Set(ids)) { if (!Number.isInteger(id) || !get("SELECT 1 x FROM users WHERE id = ? AND status = 'active'", id)) throw bad(`${what}: unbekanntes Mitglied.`); out.push(id); } return out; };
const U = (id) => ({ type: 'user', id });
const when = (iso0, allDay) => new Date(iso0).toLocaleString('de-DE', allDay ? { dateStyle: 'medium' } : { dateStyle: 'short', timeStyle: 'short' });

// ── Termine ──
const kindOf = (id) => { const e = id ? lookupEntry(id) : null; return e ? { id: e.id, key: e.key, label: e.label, color: e.color } : null; };
const participants = (id) => all('SELECT p.user_id, p.rsvp, u.member_number, u.status FROM cal_participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.event_id = ? ORDER BY u.member_number, p.user_id', id);
const isParticipant = (ev, uid) => !!get('SELECT 1 x FROM cal_participants WHERE event_id = ? AND user_id = ?', ev.id, uid);
const canSeeEvent = (u, ev) => ev.visibility === 'team' || ev.created_by === u.id || has(u, 'schedule.manage') || isParticipant(ev, u.id);
const canEditEvent = (u, ev) => has(u, 'schedule.manage') || (ev.created_by === u.id && has(u, 'schedule.create'));
function eventDto(ev, u, full = false) {
  const ps = participants(ev.id), mine = ps.find((p) => p.user_id === u.id);
  const base = {
    id: ev.id, title: ev.title, kind: kindOf(ev.kind_id), location: ev.location, startsAt: ev.starts_at, endsAt: ev.ends_at, allDay: !!ev.all_day, visibility: ev.visibility, status: ev.status,
    participantCount: ps.length, mine: ev.created_by === u.id || !!mine, rsvp: mine?.rsvp ?? null, canEdit: canEditEvent(u, ev),
  };
  if (!full) return base;
  const creator = userRow(ev.created_by);
  return { ...base, description: ev.description, reminders: json(ev.reminders, []), createdBy: creator ? lbl(u, creator) : 'Gelöschtes Mitglied', createdAt: ev.created_at,
    participants: ps.map((p) => ({ userId: p.user_id, label: lbl(u, { id: p.user_id, member_number: p.member_number, status: p.status }), rsvp: p.rsvp, isMe: p.user_id === u.id })),
    tasks: all('SELECT * FROM cal_tasks WHERE event_id = ? ORDER BY due_at, id', ev.id).filter((t) => canSeeTask(u, t)).map((t) => taskDto(t, u)) };
}
const loadEvent = (u, id) => { const ev = get('SELECT * FROM cal_events WHERE id = ?', Number(id)); if (!ev || !canSeeEvent(u, ev)) throw notFound('Termin nicht gefunden.'); return ev; };

function eventInput(b, partial, user) {
  const out = {};
  if (!partial || b.title !== undefined) out.title = str(b.title, 'Titel', { min: 2, max: 120 });
  if (!partial || b.description !== undefined) out.description = str(b.description ?? '', 'Beschreibung', { max: 4000, required: false });
  if (!partial || b.location !== undefined) out.location = str(b.location ?? '', 'Ort', { max: 120, required: false });
  if (!partial || b.startsAt !== undefined) out.starts_at = iso(b.startsAt, 'Beginn');
  if (b.endsAt !== undefined || !partial) out.ends_at = iso(b.endsAt, 'Ende', false);
  if (!partial || b.allDay !== undefined) out.all_day = b.allDay ? 1 : 0;
  if (!partial || b.visibility !== undefined) { if (!['team', 'invited'].includes(b.visibility ?? 'team')) throw bad('Sichtbarkeit: ungültige Auswahl.'); out.visibility = b.visibility ?? 'team'; }
  if (!partial || b.kindId !== undefined) {
    const k = b.kindId ?? lookupByKey('schedule.event_kind', 'other')?.id;
    if (!isActiveEntry('schedule.event_kind', k)) throw bad('Art: ungültige Auswahl.'); out.kind_id = k;
  }
  if (!partial || b.reminders !== undefined) {
    const r = b.reminders ?? []; if (!Array.isArray(r) || r.length > 4 || !r.every((m) => REMIND_MIN.has(m))) throw bad('Erinnerungen: ungültige Auswahl (höchstens vier).');
    out.reminders = JSON.stringify([...new Set(r)].sort((a, c) => a - c));
  }
  return out;
}
function setParticipants(ev, ids, user) {
  const want = activeUsers(ids ?? [], 'Beteiligte'); if (want.length > 60) throw bad('Höchstens 60 Beteiligte.');
  const have = new Set(all('SELECT user_id FROM cal_participants WHERE event_id = ?', ev.id).map((r) => r.user_id));
  for (const id of have) if (!want.includes(id)) run('DELETE FROM cal_participants WHERE event_id = ? AND user_id = ?', ev.id, id);
  const added = want.filter((id) => !have.has(id));
  for (const id of added) run("INSERT INTO cal_participants (event_id,user_id,rsvp) VALUES (?,?,'pending')", ev.id, id);
  const fresh = get('SELECT * FROM cal_events WHERE id = ?', ev.id);
  notify(added.filter((id) => id !== user.id).map(U), { key: `sch:ev:${ev.id}:invite:${now()}`, title: 'Neuer Termin: du bist beteiligt', body: `${fresh.title} – ${when(fresh.starts_at, fresh.all_day)}`, target: { app: 'schedule', eventId: ev.id } });
}

// ── Aufträge ──
const assignees = (id) => all('SELECT a.*, u.member_number, u.status ustatus FROM cal_task_assignees a LEFT JOIN users u ON u.id = a.user_id WHERE a.task_id = ? ORDER BY u.member_number, a.user_id', id);
const canSeeTask = (u, t) => t.created_by === u.id || has(u, 'schedule.manage') || !!get('SELECT 1 x FROM cal_task_assignees WHERE task_id = ? AND user_id = ?', t.id, u.id);
const canEditTask = (u, t) => has(u, 'schedule.manage') || (t.created_by === u.id && has(u, 'schedule.tasks.assign'));
const isOverdue = (t) => !!t.due_at && ['open', 'in_progress'].includes(t.status) && t.due_at < now();
function taskDto(t, u, full = false) {
  const as = assignees(t.id), mine = as.find((a) => a.user_id === u.id), ev = t.event_id ? get('SELECT id, title, starts_at, all_day, visibility, created_by FROM cal_events WHERE id = ?', t.event_id) : null;
  const evVisible = ev && canSeeEvent(u, { ...ev });
  const base = {
    id: t.id, number: taskNo(t.id), title: t.title, priority: t.priority, priorityLabel: PRIORITIES[t.priority], status: t.status, dueAt: t.due_at, overdue: isOverdue(t), canEdit: canEditTask(u, t),
    myState: mine?.state ?? null, event: evVisible ? { id: ev.id, title: ev.title, startsAt: ev.starts_at } : null, updatedAt: t.updated_at, doneAt: t.done_at,
    assignees: as.map((a) => ({ userId: a.user_id, label: lbl(u, { id: a.user_id, member_number: a.member_number, status: a.ustatus }), state: a.state, stateLabel: TASK_STATES[a.state], isMe: a.user_id === u.id, ...(full ? { note: a.note, updatedAt: a.updated_at } : {}) })),
  };
  if (!full) return base;
  return { ...base, description: t.description, createdAt: t.created_at, createdBy: lbl(u, userRow(t.created_by)) };
}
const loadTask = (u, id) => { const t = get('SELECT * FROM cal_tasks WHERE id = ?', Number(id)); if (!t || !canSeeTask(u, t)) throw notFound('Auftrag nicht gefunden.'); return t; };
function recalc(taskId) {
  const t = get('SELECT * FROM cal_tasks WHERE id = ?', taskId); if (!t || t.status === 'cancelled') return;
  const as = all('SELECT state FROM cal_task_assignees WHERE task_id = ?', taskId), active = as.filter((a) => a.state !== 'declined');
  const status = active.length && active.every((a) => a.state === 'done') ? 'done' : as.some((a) => a.state === 'accepted' || a.state === 'done') ? 'in_progress' : 'open';
  run('UPDATE cal_tasks SET status = ?, done_at = ?, updated_at = ? WHERE id = ?', status, status === 'done' ? (t.done_at ?? now()) : null, now(), taskId);
}
function taskInput(b, partial) {
  const out = {};
  if (!partial || b.title !== undefined) out.title = str(b.title, 'Titel', { min: 2, max: 140 });
  if (!partial || b.description !== undefined) out.description = str(b.description ?? '', 'Beschreibung', { max: 4000, required: false });
  if (!partial || b.priority !== undefined) { if (!PRIORITIES[b.priority ?? 'normal']) throw bad('Priorität: ungültige Auswahl.'); out.priority = b.priority ?? 'normal'; }
  if (!partial || b.dueAt !== undefined) out.due_at = iso(b.dueAt, 'Frist', false);
  if (b.eventId !== undefined) { if (b.eventId !== null && !(Number.isInteger(b.eventId) && get('SELECT 1 x FROM cal_events WHERE id = ?', b.eventId))) throw bad('Termin: unbekannt.'); out.event_id = b.eventId; }
  return out;
}
function setAssignees(t, ids, user) {
  const want = activeUsers(ids ?? [], 'Beauftragte'); if (!want.length) throw bad('Mindestens eine Person muss beauftragt werden.'); if (want.length > 40) throw bad('Höchstens 40 Beauftragte.');
  const have = new Set(all('SELECT user_id FROM cal_task_assignees WHERE task_id = ?', t.id).map((r) => r.user_id));
  for (const id of have) if (!want.includes(id)) run('DELETE FROM cal_task_assignees WHERE task_id = ? AND user_id = ?', t.id, id);
  const added = want.filter((id) => !have.has(id)); const ts = now();
  for (const id of added) run("INSERT INTO cal_task_assignees (task_id,user_id,state,note,updated_at) VALUES (?,?,'open','',?)", t.id, id, ts);
  const fresh = get('SELECT * FROM cal_tasks WHERE id = ?', t.id);
  notify(added.filter((id) => id !== user.id).map(U), { key: `sch:task:${t.id}:assign:${ts}`, title: `Neuer Auftrag ${taskNo(t.id)}`, body: `${fresh.title}${fresh.due_at ? ` – fällig ${when(fresh.due_at, false)}` : ''}`, target: { app: 'schedule', taskId: t.id } });
  recalc(t.id);
}

// ── Erinnerungen (serverseitig, einmal je Empfänger/Zeitpunkt) ──
const once = (kind, ref, uid, off) => Number(run('INSERT OR IGNORE INTO cal_reminder_log (kind,ref_id,user_id,off,sent_at) VALUES (?,?,?,?,?)', kind, ref, uid, off, now()).changes) === 1;
export function runScheduleReminders(at = new Date()) {
  const t = at.getTime(), nowIso = at.toISOString(); let sent = 0;
  // Termine: Erinnerung, sobald (Beginn − Vorlauf) erreicht ist und der Termin noch nicht begonnen hat (Vorlauf 0: bis 10 Minuten danach)
  for (const ev of all("SELECT * FROM cal_events WHERE status = 'planned' AND reminders != '[]' AND starts_at >= ? AND starts_at <= ?", new Date(t - 10 * 60_000).toISOString(), new Date(t + 3 * 86400_000).toISOString())) {
    const start = Date.parse(ev.starts_at), ids = new Set([ev.created_by, ...all("SELECT user_id FROM cal_participants WHERE event_id = ? AND rsvp != 'no'", ev.id).map((p) => p.user_id)].filter(Boolean));
    for (const off of json(ev.reminders, [])) {
      const due = start - off * 60_000; if (t < due || t > start + (off === 0 ? 10 * 60_000 : 0)) continue;
      for (const uid of ids) if (once('event', ev.id, uid, off)) sent += notify([U(uid)], { key: `sch:ev:${ev.id}:${ev.starts_at}:${off}`, title: off === 0 ? `Termin jetzt: ${ev.title}` : `Termin in ${REMIND.find(([m]) => m === off)?.[1].replace(' vorher', '') ?? `${off} Min.`}: ${ev.title}`, body: `${when(ev.starts_at, ev.all_day)}${ev.location ? ` · ${ev.location}` : ''}`, target: { app: 'schedule', eventId: ev.id } });
    }
  }
  // Aufträge: kurz vor der Frist und einmal bei Überfälligkeit (Beauftragte, bei Überfälligkeit auch Auftraggeber)
  const hours = Number(getConfig('schedule.task_reminder_hours')) || 0;
  for (const tk of all("SELECT * FROM cal_tasks WHERE status IN ('open','in_progress') AND due_at IS NOT NULL AND due_at <= ?", new Date(t + Math.max(hours, 0) * 3600_000).toISOString())) {
    const due = Date.parse(tk.due_at), over = t >= due;
    if (!over && !(hours > 0)) continue;
    const as = all("SELECT user_id FROM cal_task_assignees WHERE task_id = ? AND state IN ('open','accepted')", tk.id).map((a) => a.user_id), ids = over ? [...new Set([...as, tk.created_by].filter(Boolean))] : as;
    for (const uid of ids) if (once('task', tk.id, uid, over ? 2 : 1)) sent += notify([U(uid)], { key: `sch:task:${tk.id}:${tk.due_at}:${over ? 'over' : 'soon'}`, title: over ? `Auftrag überfällig: ${tk.title}` : `Auftrag bald fällig: ${tk.title}`, body: `${taskNo(tk.id)} · Frist ${when(tk.due_at, false)}`, target: { app: 'schedule', taskId: tk.id } });
  }
  void nowIso;
  return sent;
}

/**
 * Problemleiste: überfällige Aufträge. Normal: ab 24 Std. überfällig ein Problem, ab 72 Std. kritisch. Wichtige/dringende Aufträge (Priorität „Hoch“/„Dringend“): ab 6 Std. Problem, ab 24 Std. kritisch.
 * Sichtbar für Beauftragte, Auftraggeber und alle mit „schedule.manage“ (gleiche Sicht wie in der App); Schwellen in der Konfiguration (Gruppe „Probleme“).
 */
export function overdueTaskProblems(user) {
  const num = (k, d) => { const v = Number(getConfig(k)); return Number.isFinite(v) && v >= 0 ? v : d; };
  const lim = { normal: [num('problems.task_warn_hours', 24), num('problems.task_critical_hours', 72)], important: [num('problems.task_important_warn_hours', 6), num('problems.task_important_critical_hours', 24)] };
  const t = Date.now(), out = [];
  for (const tk of all("SELECT * FROM cal_tasks WHERE status IN ('open','in_progress') AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at", new Date(t).toISOString())) {
    if (!canSeeTask(user, tk)) continue;
    const [warn, crit0] = lim[['high', 'urgent'].includes(tk.priority) ? 'important' : 'normal'], crit = Math.max(warn, crit0), hours = (t - Date.parse(tk.due_at)) / 3600_000;
    if (hours < warn) continue;
    const open = all("SELECT user_id FROM cal_task_assignees WHERE task_id = ? AND state IN ('open','accepted')", tk.id).map((a) => ({ id: a.user_id, member_number: userRow(a.user_id)?.member_number }));
    const critical = hours >= crit, who = open.length ? open.map((a) => (a.id === user.id ? 'Du' : a.member_number ?? `Mitglied #${a.id}`)).join(', ') : '–';
    out.push({ id: `task:${tk.id}:over:${critical ? 'crit' : 'warn'}`, severity: critical ? 'critical' : 'warn', title: `${taskNo(tk.id)} · Auftrag überfällig: ${tk.title}`,
      detail: `${PRIORITIES[tk.priority]} · fällig war ${when(tk.due_at, false)} · offen bei ${who}`, since: tk.due_at, target: { app: 'schedule', taskId: tk.id } });
  }
  return out;
}

function summary(u) {
  const mine = all("SELECT t.* FROM cal_tasks t JOIN cal_task_assignees a ON a.task_id = t.id WHERE a.user_id = ? AND a.state IN ('open','accepted') AND t.status IN ('open','in_progress') ORDER BY t.due_at IS NULL, t.due_at, t.id", u.id);
  const n = now(), next = all("SELECT * FROM cal_events WHERE status = 'planned' AND COALESCE(ends_at, starts_at) >= ? ORDER BY starts_at LIMIT 40", n).filter((e) => canSeeEvent(u, e) && (e.created_by === u.id || isParticipant(e, u.id) || e.visibility === 'team')).slice(0, 4);
  return { openTasks: mine.length, overdue: mine.filter(isOverdue).length, tasks: mine.slice(0, 4).map((t) => taskDto(t, u)), next: next.map((e) => eventDto(e, u)) };
}
registerWidget({ id: 'schedule', title: 'Termine & Aufträge', size: 'medium', permission: 'schedule.view', data: (ctx) => summary(ctx.user) });

export default {
  name: 'schedule',
  permissions: [
    ['schedule.view', 'Termine & Aufträge: Kalender sehen, auf Termine zu-/absagen, eigene Aufträge bearbeiten'],
    ['schedule.create', 'Termine & Aufträge: Termine anlegen und eigene Termine ändern'],
    ['schedule.tasks.assign', 'Termine & Aufträge: Aufträge an Mitglieder vergeben und eigene Aufträge ändern'],
    ['schedule.manage', 'Termine & Aufträge: alle Termine und Aufträge sehen, ändern und löschen'],
  ],
  config: [
    { key: 'problems.task_warn_hours', group: 'Probleme', label: 'Aufträge: überfällig gilt als Problem nach (Stunden)', help: 'Ein vergebener Auftrag, der so lange über der Frist ist, erscheint in der Problemleiste (Auftraggeber, Beauftragte und Verwaltung sehen ihn).', type: 'number', default: 24, min: 0, max: 720 },
    { key: 'problems.task_critical_hours', group: 'Probleme', label: 'Aufträge: überfällig gilt als kritisch nach (Stunden)', type: 'number', default: 72, min: 0, max: 720 },
    { key: 'problems.task_important_warn_hours', group: 'Probleme', label: 'Wichtige Aufträge (Hoch/Dringend): Problem nach (Stunden)', help: 'Ausnahme für Aufträge mit Priorität „Hoch“ oder „Dringend“.', type: 'number', default: 6, min: 0, max: 720 },
    { key: 'problems.task_important_critical_hours', group: 'Probleme', label: 'Wichtige Aufträge (Hoch/Dringend): kritisch nach (Stunden)', type: 'number', default: 24, min: 0, max: 720 },
    { key: 'schedule.task_reminder_hours', group: 'Termine & Aufträge', label: 'Auftragserinnerung (Stunden vor der Frist)', help: 'Beauftragte werden so viele Stunden vor der Frist erinnert; bei Überfälligkeit einmal zusätzlich auch der Auftraggeber. 0 = nur bei Überfälligkeit.', type: 'number', default: 24, min: 0, max: 720 },
  ],
  init() {
    // Einmalig: bestehenden Rollen das Sehen erlauben (neue Rechte gelten sonst nur für Administratoren)
    if (!get("SELECT 1 x FROM sequences WHERE name = 'schedule_seeded'")) {
      run("INSERT INTO sequences (name,next_value) VALUES ('schedule_seeded',1)");
      if (get("SELECT 1 x FROM permissions WHERE key = 'schedule.view'")) run("INSERT OR IGNORE INTO role_permissions (role_id,permission_key) SELECT id, 'schedule.view' FROM roles");
    }
    setTimeout(() => { try { runScheduleReminders(); } catch { /* DB evtl. schon geschlossen */ } }, 12_000).unref();
    setInterval(() => { try { runScheduleReminders(); } catch { /* egal */ } }, 60_000).unref();
  },
  routes(r) {
    const V = { perm: 'schedule.view' };

    r.get('/api/schedule/options', V, (ctx) => ({
      kinds: lookupEntries('schedule.event_kind', { onlyActive: true }), reminders: REMIND.map(([value, label]) => ({ value, label })), priorities: Object.entries(PRIORITIES).map(([value, label]) => ({ value, label })),
      taskStates: TASK_STATES, rsvp: RSVP, me: ctx.user.id,
      members: all("SELECT id, member_number, status FROM users WHERE status = 'active' ORDER BY member_number, id").map((u) => ({ id: u.id, label: lbl(ctx.user, u) })),
      canCreate: has(ctx.user, 'schedule.create'), canAssign: has(ctx.user, 'schedule.tasks.assign'), canManage: has(ctx.user, 'schedule.manage'),
    }));
    r.get('/api/schedule/summary', V, (ctx) => summary(ctx.user));

    // ── Termine ──
    r.get('/api/schedule/events', V, (ctx) => {
      const from = iso(ctx.query.from, 'von'), to = iso(ctx.query.to, 'bis');
      const events = all('SELECT * FROM cal_events WHERE starts_at < ? AND COALESCE(ends_at, starts_at) >= ? ORDER BY starts_at, id LIMIT 800', to, from).filter((e) => canSeeEvent(ctx.user, e)).map((e) => eventDto(e, ctx.user));
      const tasks = all("SELECT * FROM cal_tasks WHERE due_at >= ? AND due_at < ? AND status != 'cancelled' ORDER BY due_at, id LIMIT 400", from, to).filter((t) => canSeeTask(ctx.user, t)).map((t) => taskDto(t, ctx.user));
      return { events, tasks };
    });
    r.get('/api/schedule/events/:id', V, (ctx) => ({ event: eventDto(loadEvent(ctx.user, ctx.params.id), ctx.user, true) }));
    r.post('/api/schedule/events', { perm: 'schedule.create' }, (ctx) => {
      const v = eventInput(ctx.body, false, ctx.user); if (v.ends_at && v.ends_at < v.starts_at) throw bad('Das Ende liegt vor dem Beginn.');
      const id = tx(() => {
        const t = now(), nid = Number(run('INSERT INTO cal_events (title,kind_id,description,location,starts_at,ends_at,all_day,visibility,status,reminders,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          v.title, v.kind_id, v.description, v.location, v.starts_at, v.ends_at, v.all_day, v.visibility, 'planned', v.reminders, ctx.user.id, t, t).lastInsertRowid);
        setParticipants({ id: nid }, ctx.body.participants, ctx.user);
        audit(ctx, { action: 'schedule.event_created', module: 'schedule', targetType: 'cal_event', targetId: nid, targetLabel: v.title });
        return nid;
      });
      ctx.status = 201; return { event: eventDto(get('SELECT * FROM cal_events WHERE id = ?', id), ctx.user, true) };
    });
    r.patch('/api/schedule/events/:id', V, (ctx) => {
      const ev = loadEvent(ctx.user, ctx.params.id); if (!canEditEvent(ctx.user, ev)) throw forbidden('Diesen Termin darfst du nicht ändern.');
      const v = eventInput(ctx.body, true, ctx.user), start = v.starts_at ?? ev.starts_at, end = v.ends_at !== undefined ? v.ends_at : ev.ends_at;
      if (end && end < start) throw bad('Das Ende liegt vor dem Beginn.');
      if (ctx.body.status !== undefined) { if (!['planned', 'cancelled'].includes(ctx.body.status)) throw bad('Status: ungültig.'); v.status = ctx.body.status; }
      tx(() => {
        const cols = Object.keys(v);
        if (cols.length) run(`UPDATE cal_events SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => v[c]), now(), ev.id);
        if (ctx.body.participants !== undefined) setParticipants(ev, ctx.body.participants, ctx.user);
        const fresh = get('SELECT * FROM cal_events WHERE id = ?', ev.id), ids = [...new Set([fresh.created_by, ...all('SELECT user_id FROM cal_participants WHERE event_id = ?', ev.id).map((p) => p.user_id)])].filter((id) => id && id !== ctx.user.id);
        if (v.status === 'cancelled' && ev.status !== 'cancelled') notify(ids.map(U), { key: `sch:ev:${ev.id}:cancel:${now()}`, title: 'Termin abgesagt', body: `${fresh.title} – ${when(fresh.starts_at, fresh.all_day)}`, target: { app: 'schedule', eventId: ev.id } });
        else if (v.starts_at && v.starts_at !== ev.starts_at) notify(ids.map(U), { key: `sch:ev:${ev.id}:moved:${now()}`, title: 'Termin verschoben', body: `${fresh.title} – neu: ${when(fresh.starts_at, fresh.all_day)}`, target: { app: 'schedule', eventId: ev.id } });
        audit(ctx, { action: v.status === 'cancelled' && ev.status !== 'cancelled' ? 'schedule.event_cancelled' : 'schedule.event_updated', module: 'schedule', targetType: 'cal_event', targetId: ev.id, targetLabel: fresh.title });
      });
      return { event: eventDto(get('SELECT * FROM cal_events WHERE id = ?', ev.id), ctx.user, true) };
    });
    r.delete('/api/schedule/events/:id', V, (ctx) => {
      const ev = loadEvent(ctx.user, ctx.params.id); if (!canEditEvent(ctx.user, ev)) throw forbidden('Diesen Termin darfst du nicht löschen.');
      run('DELETE FROM cal_events WHERE id = ?', ev.id); run("DELETE FROM cal_reminder_log WHERE kind = 'event' AND ref_id = ?", ev.id);
      audit(ctx, { action: 'schedule.event_deleted', module: 'schedule', targetType: 'cal_event', targetId: ev.id, targetLabel: ev.title });
      return { ok: true };
    });
    r.post('/api/schedule/events/:id/rsvp', V, (ctx) => {
      const ev = loadEvent(ctx.user, ctx.params.id); if (!['yes', 'maybe', 'no'].includes(ctx.body.response)) throw bad('Bitte Zusage, Vielleicht oder Absage wählen.');
      if (!isParticipant(ev, ctx.user.id)) throw forbidden('Du bist an diesem Termin nicht beteiligt.');
      run('UPDATE cal_participants SET rsvp = ? WHERE event_id = ? AND user_id = ?', ctx.body.response, ev.id, ctx.user.id);
      audit(ctx, { action: 'schedule.event_rsvp', module: 'schedule', targetType: 'cal_event', targetId: ev.id, targetLabel: ev.title, after: { response: ctx.body.response } });
      if (ev.created_by && ev.created_by !== ctx.user.id) notify([U(ev.created_by)], { key: `sch:ev:${ev.id}:rsvp:${ctx.user.id}:${now()}`, title: `${RSVP[ctx.body.response]}: ${ev.title}`, body: `${memberLabel(userRow(ctx.user.id))} · ${when(ev.starts_at, ev.all_day)}`, target: { app: 'schedule', eventId: ev.id } });
      return { event: eventDto(ev, ctx.user, true) };
    });

    // ── Aufträge ──
    r.get('/api/schedule/tasks', V, (ctx) => {
      const scope = ['mine', 'created', 'all'].includes(ctx.query.scope) ? ctx.query.scope : 'mine';
      if (scope === 'all' && !has(ctx.user, 'schedule.manage')) throw forbidden();
      let rows = all('SELECT * FROM cal_tasks ORDER BY due_at IS NULL, due_at, id DESC');
      rows = scope === 'all' ? rows : scope === 'created' ? rows.filter((t) => t.created_by === ctx.user.id) : rows.filter((t) => get('SELECT 1 x FROM cal_task_assignees WHERE task_id = ? AND user_id = ?', t.id, ctx.user.id));
      const st = ctx.query.status ?? 'open';
      const counts = { open: rows.filter((t) => ['open', 'in_progress'].includes(t.status)).length, closed: rows.filter((t) => ['done', 'cancelled'].includes(t.status)).length, all: rows.length };
      if (st === 'open') rows = rows.filter((t) => ['open', 'in_progress'].includes(t.status)); else if (st === 'closed') rows = rows.filter((t) => ['done', 'cancelled'].includes(t.status));
      return { tasks: rows.slice(0, 300).map((t) => taskDto(t, ctx.user)), counts };
    });
    r.get('/api/schedule/tasks/:id', V, (ctx) => ({ task: taskDto(loadTask(ctx.user, ctx.params.id), ctx.user, true) }));
    r.post('/api/schedule/tasks', { perm: 'schedule.tasks.assign' }, (ctx) => {
      const v = taskInput(ctx.body, false);
      const id = tx(() => {
        const t = now(), nid = Number(run('INSERT INTO cal_tasks (title,description,priority,status,due_at,event_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', v.title, v.description, v.priority, 'open', v.due_at, v.event_id ?? null, ctx.user.id, t, t).lastInsertRowid);
        setAssignees({ id: nid }, ctx.body.assignees, ctx.user);
        audit(ctx, { action: 'schedule.task_created', module: 'schedule', targetType: 'cal_task', targetId: nid, targetLabel: `${taskNo(nid)} ${v.title}` });
        return nid;
      });
      ctx.status = 201; return { task: taskDto(get('SELECT * FROM cal_tasks WHERE id = ?', id), ctx.user, true) };
    });
    r.patch('/api/schedule/tasks/:id', V, (ctx) => {
      const t = loadTask(ctx.user, ctx.params.id); if (!canEditTask(ctx.user, t)) throw forbidden('Diesen Auftrag darfst du nicht ändern.');
      const v = taskInput(ctx.body, true);
      tx(() => {
        const cols = Object.keys(v); if (cols.length) run(`UPDATE cal_tasks SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => v[c]), now(), t.id);
        if (ctx.body.assignees !== undefined) setAssignees(t, ctx.body.assignees, ctx.user);
        if (ctx.body.status !== undefined) {
          if (!['cancelled', 'reopen'].includes(ctx.body.status)) throw bad('Status: ungültig.');
          if (ctx.body.status === 'cancelled') { run("UPDATE cal_tasks SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), t.id); notify(all('SELECT user_id FROM cal_task_assignees WHERE task_id = ?', t.id).map((a) => a.user_id).filter((id) => id !== ctx.user.id).map(U), { key: `sch:task:${t.id}:cancel:${now()}`, title: `Auftrag zurückgezogen: ${t.title}`, body: taskNo(t.id), target: { app: 'schedule', taskId: t.id } }); }
          else { run("UPDATE cal_tasks SET status = 'open', updated_at = ? WHERE id = ?", now(), t.id); recalc(t.id); }
        } else if (v.due_at !== undefined && v.due_at !== t.due_at) {
          notify(all("SELECT user_id FROM cal_task_assignees WHERE task_id = ? AND state IN ('open','accepted')", t.id).map((a) => a.user_id).filter((id) => id !== ctx.user.id).map(U), { key: `sch:task:${t.id}:due:${now()}`, title: `Frist geändert: ${t.title}`, body: `${taskNo(t.id)} · ${v.due_at ? `neu: ${when(v.due_at, false)}` : 'ohne Frist'}`, target: { app: 'schedule', taskId: t.id } });
        }
        audit(ctx, { action: 'schedule.task_updated', module: 'schedule', targetType: 'cal_task', targetId: t.id, targetLabel: `${taskNo(t.id)} ${v.title ?? t.title}` });
      });
      return { task: taskDto(get('SELECT * FROM cal_tasks WHERE id = ?', t.id), ctx.user, true) };
    });
    r.post('/api/schedule/tasks/:id/state', V, (ctx) => {
      const t = loadTask(ctx.user, ctx.params.id), state = ctx.body.state;
      if (!TASK_STATES[state]) throw bad('Status: ungültig.');
      const mine = get('SELECT * FROM cal_task_assignees WHERE task_id = ? AND user_id = ?', t.id, ctx.user.id); if (!mine) throw forbidden('Dieser Auftrag ist nicht dir zugewiesen.');
      if (t.status === 'cancelled') throw bad('Der Auftrag wurde zurückgezogen.');
      const note = str(ctx.body.note ?? '', 'Notiz', { max: 1000, required: false });
      run('UPDATE cal_task_assignees SET state = ?, note = ?, updated_at = ? WHERE task_id = ? AND user_id = ?', state, note, now(), t.id, ctx.user.id); recalc(t.id);
      audit(ctx, { action: 'schedule.task_state', module: 'schedule', targetType: 'cal_task', targetId: t.id, targetLabel: `${taskNo(t.id)} ${t.title}`, after: { state } });
      if (t.created_by && t.created_by !== ctx.user.id) notify([U(t.created_by)], { key: `sch:task:${t.id}:state:${ctx.user.id}:${now()}`, title: `${TASK_STATES[state]}: ${t.title}`, body: `${taskNo(t.id)} · ${memberLabel(userRow(ctx.user.id))}${note ? ` – ${note.slice(0, 120)}` : ''}`, target: { app: 'schedule', taskId: t.id } });
      return { task: taskDto(get('SELECT * FROM cal_tasks WHERE id = ?', t.id), ctx.user, true) };
    });
    r.delete('/api/schedule/tasks/:id', V, (ctx) => {
      const t = loadTask(ctx.user, ctx.params.id); if (!canEditTask(ctx.user, t)) throw forbidden('Diesen Auftrag darfst du nicht löschen.');
      run('DELETE FROM cal_tasks WHERE id = ?', t.id); run("DELETE FROM cal_reminder_log WHERE kind = 'task' AND ref_id = ?", t.id);
      audit(ctx, { action: 'schedule.task_deleted', module: 'schedule', targetType: 'cal_task', targetId: t.id, targetLabel: `${taskNo(t.id)} ${t.title}` });
      return { ok: true };
    });
  },
};
