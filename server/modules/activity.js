import { all, get, run, now, tx } from '../core/db.js';
import { bad, forbidden, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { getConfig } from '../core/config.js';
import { notify, staffWith } from '../core/notifications.js';
import { memberLabel } from '../core/identity.js';

/**
 * Aktivität & Abmeldung: zeigt, wer im Panel aktiv ist (zuletzt aktiv, aktive Tage) und wer sich abgemeldet hat (Urlaub, Pause). Jedes Mitglied meldet sich
 * selbst für einen Zeitraum ab – wer abgemeldet ist, gilt nicht als inaktiv und fällt nicht auf. Die Übersicht sehen nur Berechtigte (activity.view); sie zeigt
 * ausschließlich Dienstnummern. Aktiv zählt, wer das Panel mit entsperrtem Bildschirm geöffnet hat (Herzschlag der Online-Liste) oder sich anmeldet.
 * Ein Wochenhinweis nennt der Führung die inaktiven Mitglieder. Rechte: activity.absence (eigene Abmeldung) · activity.view (Übersicht) · activity.manage (für andere eintragen/beenden).
 */
const has = (u, p) => u.isAdmin || u.perms.has(p);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayStr = () => now().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const cfgNum = (k, d, min = 1) => { const v = Number(getConfig(k)); return Number.isFinite(v) && v >= min ? v : d; };
const lbl = (viewer, u) => (u ? (u.id === viewer.id ? `${memberLabel(u)} (Du)` : memberLabel(u)) : 'Gelöschtes Mitglied');
const validDay = (v, name) => { const s = String(v ?? ''); if (!DAY_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw bad(`${name}: gültiges Datum erforderlich.`); return s; };

/** Aktivität verbuchen (höchstens alle 2 Minuten je Mitglied in die Datenbank). */
const lastTouch = new Map();
export function touchActivity(userId) {
  const t = Date.now(); if (t - (lastTouch.get(userId) ?? 0) < 120_000) return; lastTouch.set(userId, t);
  const ts = now();
  run('UPDATE users SET last_active_at = ? WHERE id = ?', ts, userId);
  run('INSERT OR IGNORE INTO user_activity (user_id, day) VALUES (?,?)', userId, ts.slice(0, 10));
}

const absenceDto = (a, viewer, withUser = false) => ({
  id: a.id, from: a.from_date, to: a.to_date, reason: a.reason, createdAt: a.created_at, byOther: a.created_by != null && a.created_by !== a.user_id,
  ...(withUser ? { userId: a.user_id } : {}),
  canEnd: a.user_id === viewer.id || has(viewer, 'activity.manage'),
});
const absencesOf = (userId, from) => all('SELECT * FROM user_absences WHERE user_id = ? AND to_date >= ? ORDER BY from_date', userId, from);
const activeDaysSince = (userId, fromDay) => get('SELECT COUNT(*) n FROM user_activity WHERE user_id = ? AND day >= ?', userId, fromDay).n;

/** 'absent' | 'active' | 'inactive' | 'new' (noch nie aktiv, aber erst kurz dabei) */
function statusOf(u, today, absentNow, inactiveDays) {
  if (absentNow) return 'absent';
  const last = u.last_active_at ? u.last_active_at.slice(0, 10) : null;
  if (last) return diffDays(today, last) >= inactiveDays ? 'inactive' : 'active';
  return diffDays(today, (u.created_at ?? now()).slice(0, 10)) >= inactiveDays ? 'inactive' : 'new';
}
const members = () => all(`SELECT u.id, u.member_number, u.status, u.created_at, u.last_active_at, r.name rank_name, r.color rank_color FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.status = 'active' ORDER BY u.member_number, u.id`);

/** Für die Übersicht und die Problemleiste: alle aktiven Mitglieder mit Status. */
function overview(viewer) {
  const today = todayStr(), inactiveDays = cfgNum('activity.inactive_days', 7), since14 = addDays(today, -13), since30 = addDays(today, -29);
  const abs = all('SELECT * FROM user_absences WHERE to_date >= ? ORDER BY from_date', today);
  const byUser = new Map(); for (const a of abs) { (byUser.get(a.user_id) ?? byUser.set(a.user_id, []).get(a.user_id)).push(a); }
  const rows = members().map((u) => {
    const list = byUser.get(u.id) ?? [], cur = list.find((a) => a.from_date <= today) ?? null, next = list.find((a) => a.from_date > today) ?? null;
    const status = statusOf(u, today, !!cur, inactiveDays), last = u.last_active_at ? u.last_active_at.slice(0, 10) : null;
    return {
      id: u.id, label: lbl(viewer, u), rank: u.rank_name ? { name: u.rank_name, color: u.rank_color } : null, status, lastActiveAt: u.last_active_at,
      daysSince: last ? diffDays(today, last) : null, days14: activeDaysSince(u.id, since14), days30: activeDaysSince(u.id, since30),
      absence: cur ? absenceDto(cur, viewer) : null, upcoming: next ? absenceDto(next, viewer) : null,
    };
  });
  return { today, inactiveDays, rows };
}

/** Problemleiste: inaktive Mitglieder (ohne Abmeldung) als ein Eintrag – nur für die Übersichts-Berechtigten. */
export function inactiveProblems() {
  const today = todayStr(), n = cfgNum('activity.inactive_days', 7), out = [];
  const abs = new Set(all('SELECT DISTINCT user_id FROM user_absences WHERE from_date <= ? AND to_date >= ?', today, today).map((r) => r.user_id));
  const list = members().filter((u) => statusOf(u, today, abs.has(u.id), n) === 'inactive');
  if (!list.length) return out;
  const oldest = list.map((u) => u.last_active_at ?? u.created_at).sort()[0];
  out.push({ id: 'activity:inactive', severity: 'warn', title: `${list.length} Mitglied${list.length === 1 ? '' : 'er'} inaktiv (seit ${n}+ Tagen ohne Abmeldung)`, detail: list.slice(0, 6).map((u) => memberLabel(u)).join(', ') + (list.length > 6 ? ' …' : ''), since: oldest, target: { app: 'activity' } });
  return out;
}

/** Wöchentlicher Hinweis an die Führung (einmal je Kalenderwoche, solange es inaktive Mitglieder gibt). */
export function runActivityDigest() {
  if (!getConfig('activity.notify_inactive')) return;
  const today = todayStr(), monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const list = inactiveProblems(); if (!list.length) return;
  const to = staffWith('activity.view'); if (!to.length) return;
  const n = cfgNum('activity.inactive_days', 7);
  const names = members().filter((u) => statusOf(u, today, !!get('SELECT 1 x FROM user_absences WHERE user_id = ? AND from_date <= ? AND to_date >= ?', u.id, today, today), n) === 'inactive');
  notify(to, { key: `activity:inactive:${monday}`, title: `${names.length} Mitglied${names.length === 1 ? '' : 'er'} inaktiv`, body: names.slice(0, 10).map((u) => memberLabel(u)).join(', ') + (names.length > 10 ? ' …' : ''), target: { app: 'activity' } });
}

export default {
  name: 'activity',
  permissions: [
    ['activity.absence', 'Aktivität: sich selbst für einen Zeitraum abmelden (Urlaub, Pause) und die eigene Aktivität sehen'],
    ['activity.view', 'Aktivität: Übersicht über alle Mitglieder (zuletzt aktiv, aktive Tage, Abmeldungen)'],
    ['activity.manage', 'Aktivität: Abmeldungen für andere Mitglieder eintragen und beenden'],
  ],
  config: [
    { key: 'activity.inactive_days', group: 'Aktivität', label: 'Inaktiv nach (Tagen)', help: 'Wer so lange nicht mehr aktiv war und nicht abgemeldet ist, gilt als inaktiv (Übersicht, Problemleiste, Wochenhinweis).', type: 'number', default: 7, min: 1, max: 90 },
    { key: 'activity.absence_max_days', group: 'Aktivität', label: 'Abmeldung: längster Zeitraum (Tage)', help: 'So lange darf eine einzelne Abmeldung höchstens dauern. Für längere Pausen meldet man sich erneut ab.', type: 'number', default: 60, min: 1, max: 365 },
    { key: 'activity.notify_inactive', group: 'Aktivität', label: 'Wochenhinweis über inaktive Mitglieder', help: 'Die Führung (Recht „activity.view“) bekommt einmal pro Woche eine Benachrichtigung, solange Mitglieder inaktiv sind.', type: 'bool', default: true },
    { key: 'activity.notify_absence', group: 'Aktivität', label: 'Führung bei Abmeldung benachrichtigen', help: 'Meldet sich ein Mitglied ab, erfährt es die Führung (Recht „activity.view“).', type: 'bool', default: true },
  ],
  init() {
    // Einmalig: alle bestehenden Rollen dürfen sich selbst abmelden (neue Rechte gelten sonst nur für Administratoren)
    if (!get("SELECT 1 x FROM sequences WHERE name = 'activity_seeded'")) {
      run("INSERT INTO sequences (name,next_value) VALUES ('activity_seeded',1)");
      if (get("SELECT 1 x FROM permissions WHERE key = 'activity.absence'")) run("INSERT OR IGNORE INTO role_permissions (role_id,permission_key) SELECT id, 'activity.absence' FROM roles");
    }
    setTimeout(() => { try { runActivityDigest(); } catch { /* DB evtl. schon geschlossen */ } }, 20_000).unref();
    setInterval(() => { try { runActivityDigest(); } catch { /* egal */ } }, 3_600_000).unref();
  },
  routes(r) {
    // Eigene Sicht: Abmeldungen und eigene Aktivität
    r.get('/api/activity/me', { perm: 'activity.absence' }, (ctx) => {
      const today = todayStr(), u = get('SELECT id, member_number, status, created_at, last_active_at FROM users WHERE id = ?', ctx.user.id), list = absencesOf(ctx.user.id, addDays(today, -30));
      const cur = list.find((a) => a.from_date <= today && a.to_date >= today) ?? null;
      return {
        today, maxDays: cfgNum('activity.absence_max_days', 60), inactiveDays: cfgNum('activity.inactive_days', 7),
        state: statusOf(u, today, !!cur, cfgNum('activity.inactive_days', 7)), lastActiveAt: u.last_active_at, days14: activeDaysSince(ctx.user.id, addDays(today, -13)), days30: activeDaysSince(ctx.user.id, addDays(today, -29)),
        absences: list.map((a) => absenceDto(a, ctx.user)), canView: has(ctx.user, 'activity.view'), canManage: has(ctx.user, 'activity.manage'),
      };
    });
    // Übersicht (Führung)
    r.get('/api/activity/overview', { perm: 'activity.view' }, (ctx) => ({ ...overview(ctx.user), canManage: has(ctx.user, 'activity.manage'), maxDays: cfgNum('activity.absence_max_days', 60) }));
    // Abmeldung eintragen (für sich selbst; für andere mit activity.manage)
    r.post('/api/activity/absences', { perm: 'activity.absence' }, (ctx) => {
      const b = ctx.body, uid = b.userId == null ? ctx.user.id : Number(b.userId), other = uid !== ctx.user.id;
      if (other && !has(ctx.user, 'activity.manage')) throw forbidden('Für andere Mitglieder fehlt dir das Recht „activity.manage“.');
      const target = get("SELECT id, member_number, status FROM users WHERE id = ? AND status = 'active'", uid); if (!target) throw bad('Unbekanntes oder inaktives Mitglied.');
      const from = validDay(b.from, 'Von'), to = validDay(b.to, 'Bis'), today = todayStr(), max = cfgNum('activity.absence_max_days', 60);
      if (to < from) throw bad('Das Ende liegt vor dem Beginn.');
      if (to < today) throw bad('Der Zeitraum liegt in der Vergangenheit.');
      if (from < addDays(today, -1)) throw bad('Der Beginn darf höchstens einen Tag zurückliegen.');
      if (diffDays(to, from) + 1 > max) throw bad(`Eine Abmeldung darf höchstens ${max} Tage dauern.`);
      if (from > addDays(today, 365)) throw bad('Der Beginn liegt zu weit in der Zukunft.');
      if (get('SELECT 1 x FROM user_absences WHERE user_id = ? AND from_date <= ? AND to_date >= ?', uid, to, from)) throw bad('In diesem Zeitraum besteht bereits eine Abmeldung.');
      const reason = str(b.reason, 'Grund', { max: 200, required: false });
      const id = Number(run('INSERT INTO user_absences (user_id,from_date,to_date,reason,created_by,created_at) VALUES (?,?,?,?,?,?)', uid, from, to, reason, ctx.user.id, now()).lastInsertRowid);
      audit(ctx, { action: 'activity.absence_added', module: 'activity', targetType: 'user', targetId: uid, targetLabel: memberLabel(target), after: { from, to, reason: reason || undefined } });
      if (getConfig('activity.notify_absence')) {
        const to2 = staffWith('activity.view', uid);
        if (to2.length) notify(to2, { key: `activity:absence:${id}`, title: `Abmeldung: ${memberLabel(target)}`, body: `${from.split('-').reverse().join('.')} – ${to.split('-').reverse().join('.')}${reason ? ` · ${reason.slice(0, 80)}` : ''}`, target: { app: 'activity' } });
      }
      if (other) notify([{ type: 'user', id: uid }], { key: `activity:absence-by:${id}`, title: 'Du wurdest abgemeldet', body: `${from.split('-').reverse().join('.')} – ${to.split('-').reverse().join('.')}`, target: { app: 'activity' } });
      ctx.status = 201;
      return { absence: absenceDto(get('SELECT * FROM user_absences WHERE id = ?', id), ctx.user) };
    });
    // Zurückmelden / Abmeldung löschen
    r.delete('/api/activity/absences/:id', { perm: 'activity.absence' }, (ctx) => {
      const a = get('SELECT * FROM user_absences WHERE id = ?', Number(ctx.params.id)); if (!a) throw notFound('Abmeldung nicht gefunden.');
      if (a.user_id !== ctx.user.id && !has(ctx.user, 'activity.manage')) throw forbidden('Du darfst nur deine eigenen Abmeldungen beenden.');
      const today = todayStr(), target = get('SELECT id, member_number, status FROM users WHERE id = ?', a.user_id);
      if (a.to_date < today) throw bad('Diese Abmeldung ist bereits beendet.');
      let result;
      tx(() => {
        // Bereits begonnen ⇒ der Zeitraum endet gestern (der Verlauf bleibt erhalten); noch nicht begonnen ⇒ wird gelöscht
        if (a.from_date < today) { run('UPDATE user_absences SET to_date = ? WHERE id = ?', addDays(today, -1), a.id); result = 'ended'; }
        else { run('DELETE FROM user_absences WHERE id = ?', a.id); result = 'deleted'; }
      });
      audit(ctx, { action: 'activity.absence_ended', module: 'activity', targetType: 'user', targetId: a.user_id, targetLabel: target ? memberLabel(target) : 'Mitglied', before: { from: a.from_date, to: a.to_date }, after: { result } });
      return { ok: true, result };
    });
  },
};
