import { all, get, run, now, tx } from '../core/db.js';
import { bad, forbidden, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { getConfig } from '../core/config.js';
import { notify, staffWith } from '../core/notifications.js';
import { memberLabel } from '../core/identity.js';
import { registerWidget } from './dashboard.js';

/**
 * Einarbeitung: eine einstellbare Checkliste für neue Mitglieder. Die Schritte (Titel, Beschreibung, wer bestätigt) legt die Führung selbst fest (onboarding.manage).
 * Wird ein Mitglied zum ersten Mal freigeschaltet, startet seine Einarbeitung automatisch und die Führung erfährt davon. Schritte vom Typ „Mitglied“ hakt das
 * neue Mitglied selbst ab (z. B. „Codex gelesen“), Schritte vom Typ „Führung“ bestätigt, wer onboarding.check hat (nie für sich selbst). Sind alle Schritte
 * erledigt, gilt die Einarbeitung als abgeschlossen. Bestehende Mitglieder sind davon nicht betroffen (sie lassen sich bei Bedarf manuell aufnehmen).
 */
const has = (u, p) => u.isAdmin || u.perms.has(p);
const CONFIRM = { leader: 'Führung', self: 'Mitglied selbst' };
const lbl = (viewer, u) => (u ? (u.id === viewer.id ? `${memberLabel(u)} (Du)` : memberLabel(u)) : 'Gelöschtes Mitglied');
const userRow = (id) => get('SELECT u.id, u.member_number, u.status, r.name rank_name, r.color rank_color FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?', id);
const enabled = () => !!getConfig('onboarding.enabled');
const activeSteps = () => all('SELECT * FROM onboarding_steps WHERE is_active = 1 ORDER BY sort_order, id');
const stepDto = (s) => ({ id: s.id, title: s.title, description: s.description, confirmBy: s.confirm_by, confirmLabel: CONFIRM[s.confirm_by], isActive: !!s.is_active, sortOrder: s.sort_order });

/** Fortschritt eines Mitglieds: Schritte mit Erledigt-Stand. */
function progress(viewer, userId) {
  const done = new Map(all('SELECT step_id, done_by, done_at FROM onboarding_progress WHERE user_id = ?', userId).map((p) => [p.step_id, p]));
  return activeSteps().map((s) => {
    const p = done.get(s.id);
    return { ...stepDto(s), done: !!p, doneAt: p?.done_at ?? null, doneBy: p ? (p.done_by === userId ? 'selbst' : lbl(viewer, userRow(p.done_by))) : null };
  });
}
function rowDto(viewer, o) {
  const u = userRow(o.user_id), steps = progress(viewer, o.user_id);
  return {
    userId: o.user_id, label: lbl(viewer, u), userStatus: u?.status ?? null, rank: u?.rank_name ? { name: u.rank_name, color: u.rank_color } : null,
    startedAt: o.started_at, completedAt: o.completed_at, skipped: !!o.skipped, steps, done: steps.filter((s) => s.done).length, total: steps.length,
  };
}
/** Eigene Checkliste (null, wenn keine Einarbeitung läuft oder die Funktion aus ist). */
export function onboardingFor(user) {
  const o = enabled() ? get('SELECT * FROM user_onboarding WHERE user_id = ?', user.id) : null;
  if (!o) return { active: false };
  const r = rowDto(user, o);
  return { active: !o.completed_at, completedAt: o.completed_at, skipped: !!o.skipped, ...r };
}

/** Prüft, ob alle Schritte erledigt sind, und setzt/entfernt den Abschluss. */
function recompute(userId) {
  const o = get('SELECT * FROM user_onboarding WHERE user_id = ?', userId); if (!o || o.skipped) return;
  const steps = activeSteps(), done = new Set(all('SELECT step_id FROM onboarding_progress WHERE user_id = ?', userId).map((p) => p.step_id));
  const complete = steps.length > 0 && steps.every((s) => done.has(s.id));
  if (complete && !o.completed_at) {
    run('UPDATE user_onboarding SET completed_at = ? WHERE user_id = ?', now(), userId);
    const nr = memberLabel(userRow(userId) ?? { id: userId });
    notify([...staffWith('onboarding.check', userId), { type: 'user', id: userId }], { key: `onboarding:done:${userId}`, title: `Einarbeitung abgeschlossen: ${nr}`, body: 'Alle Schritte der Checkliste sind erledigt.', target: { app: 'onboarding' } });
  } else if (!complete && o.completed_at) run('UPDATE user_onboarding SET completed_at = NULL WHERE user_id = ?', userId);
}

/** Startet die Einarbeitung eines Mitglieds (einmalig; ohne aktive Schritte oder bei ausgeschalteter Funktion passiert nichts). */
export function startOnboarding(userId) {
  if (!enabled() || get('SELECT 1 x FROM user_onboarding WHERE user_id = ?', userId) || !activeSteps().length) return false;
  const u = userRow(userId); if (!u || u.status !== 'active') return false;
  run('INSERT INTO user_onboarding (user_id, started_at) VALUES (?,?)', userId, now());
  const to = staffWith('onboarding.check', userId);
  if (to.length) notify(to, { key: `onboarding:start:${userId}`, title: `Neues Mitglied: ${memberLabel(u)}`, body: 'Die Einarbeitung wurde gestartet – die Checkliste steht in der App „Einarbeitung“.', target: { app: 'onboarding' } });
  notify([{ type: 'user', id: userId }], { key: `onboarding:welcome:${userId}`, title: 'Willkommen – deine Einarbeitung', body: 'Auf dem Dashboard findest du deine Checkliste. Hake ab, was du selbst erledigt hast.', target: { app: 'dashboard' } });
  return true;
}

registerWidget({ id: 'onboarding', title: 'Deine Einarbeitung', size: 'medium', pinTop: true, data: (ctx) => onboardingFor(ctx.user) });

const DEFAULT_STEPS = [
  ['Codex gelesen und verstanden', 'Lies den Codex auf dem Dashboard vollständig durch.', 'self'],
  ['Hilfe und Panel angesehen', 'Mach die Tour und sieh dir in der Hilfe-App die Kapitel zu deinen Apps an.', 'self'],
  ['Vorstellung bei der Führung', 'Stelle dich deinem Ansprechpartner aus der Führung vor.', 'leader'],
  ['Abläufe und Lager gezeigt bekommen', 'Dir wurde gezeigt, wie Farming, Lager und Verkauf bei uns laufen.', 'leader'],
  ['Regeln besprochen', 'Verschwiegenheit, Umgang mit Ressourcen und wen du bei Unsicherheit fragst.', 'leader'],
  ['Probeauftrag erledigt', 'Ein erster kleiner Auftrag wurde zuverlässig erledigt.', 'leader'],
];

export default {
  name: 'onboarding',
  permissions: [
    ['onboarding.check', 'Einarbeitung: Fortschritt aller neuen Mitglieder sehen, Schritte bestätigen, Einarbeitung starten und beenden'],
    ['onboarding.manage', 'Einarbeitung: die Schritte der Checkliste anlegen, ändern und ordnen'],
  ],
  config: [
    { key: 'onboarding.enabled', group: 'Mitglieder', label: 'Einarbeitung neuer Mitglieder', help: 'Neu freigeschaltete Mitglieder bekommen automatisch die Einarbeitungs-Checkliste (Dashboard). Die Schritte stellt die Führung in der App „Einarbeitung“ ein.', type: 'bool', default: true },
  ],
  init() {
    if (!get("SELECT 1 x FROM sequences WHERE name = 'onboarding_seeded'")) {
      run("INSERT INTO sequences (name,next_value) VALUES ('onboarding_seeded',1)");
      if (!get('SELECT 1 x FROM onboarding_steps')) DEFAULT_STEPS.forEach(([title, description, by], i) => run('INSERT INTO onboarding_steps (sort_order,title,description,confirm_by,is_active,created_at,updated_at) VALUES (?,?,?,?,1,?,?)', i + 1, title, description, by, now(), now()));
    }
  },
  routes(r) {
    const C = { perm: ['onboarding.check', 'onboarding.manage'] };
    // Eigene Checkliste (Dashboard)
    r.get('/api/onboarding/me', (ctx) => onboardingFor(ctx.user));
    r.post('/api/onboarding/me/steps/:stepId', (ctx) => {
      const o = get('SELECT * FROM user_onboarding WHERE user_id = ?', ctx.user.id); if (!o || !enabled()) throw notFound('Keine Einarbeitung aktiv.');
      const s = get('SELECT * FROM onboarding_steps WHERE id = ? AND is_active = 1', Number(ctx.params.stepId)); if (!s) throw notFound('Schritt nicht gefunden.');
      if (s.confirm_by !== 'self') throw forbidden('Diesen Schritt bestätigt die Führung.');
      setStep(ctx.user.id, s.id, ctx.body.done !== false, ctx.user.id);
      return onboardingFor(ctx.user);
    });

    // Übersicht für die Führung
    r.get('/api/onboarding', C, (ctx) => {
      const rows = all('SELECT * FROM user_onboarding ORDER BY (completed_at IS NOT NULL), started_at DESC').map((o) => rowDto(ctx.user, o));
      return {
        enabled: enabled(), rows, steps: all('SELECT * FROM onboarding_steps ORDER BY sort_order, id').map(stepDto), canManage: has(ctx.user, 'onboarding.manage'), canCheck: has(ctx.user, 'onboarding.check'),
        candidates: has(ctx.user, 'onboarding.check') ? all("SELECT id, member_number, status FROM users WHERE status = 'active' AND id NOT IN (SELECT user_id FROM user_onboarding) ORDER BY member_number, id").map((u) => ({ id: u.id, label: lbl(ctx.user, u) })) : [],
      };
    });
    r.post('/api/onboarding/:userId/steps/:stepId', { perm: 'onboarding.check' }, (ctx) => {
      const uid = Number(ctx.params.userId), o = get('SELECT * FROM user_onboarding WHERE user_id = ?', uid); if (!o) throw notFound('Für dieses Mitglied läuft keine Einarbeitung.');
      const s = get('SELECT * FROM onboarding_steps WHERE id = ? AND is_active = 1', Number(ctx.params.stepId)); if (!s) throw notFound('Schritt nicht gefunden.');
      if (uid === ctx.user.id && s.confirm_by === 'leader' && !ctx.user.isAdmin) throw forbidden('Schritte der Führung bestätigt jemand anderes für dich.');
      const done = ctx.body.done !== false; setStep(uid, s.id, done, ctx.user.id);
      audit(ctx, { action: 'onboarding.step', module: 'onboarding', targetType: 'user', targetId: uid, targetLabel: memberLabel(userRow(uid) ?? { id: uid }), after: { step: s.title, done } });
      return { row: rowDto(ctx.user, get('SELECT * FROM user_onboarding WHERE user_id = ?', uid)) };
    });
    r.post('/api/onboarding/:userId/start', { perm: 'onboarding.check' }, (ctx) => {
      const uid = Number(ctx.params.userId), u = userRow(uid); if (!u || u.status !== 'active') throw bad('Unbekanntes oder inaktives Mitglied.');
      if (get('SELECT 1 x FROM user_onboarding WHERE user_id = ?', uid)) throw bad('Für dieses Mitglied läuft bereits eine Einarbeitung.');
      if (!activeSteps().length) throw bad('Es gibt keine aktiven Schritte – lege zuerst Schritte an.');
      run('INSERT INTO user_onboarding (user_id, started_at) VALUES (?,?)', uid, now());
      notify([{ type: 'user', id: uid }], { key: `onboarding:welcome:${uid}:${now()}`, title: 'Deine Einarbeitung wurde gestartet', body: 'Auf dem Dashboard findest du deine Checkliste.', target: { app: 'dashboard' } });
      audit(ctx, { action: 'onboarding.started', module: 'onboarding', targetType: 'user', targetId: uid, targetLabel: memberLabel(u) });
      ctx.status = 201; return { row: rowDto(ctx.user, get('SELECT * FROM user_onboarding WHERE user_id = ?', uid)) };
    });
    r.post('/api/onboarding/:userId/finish', { perm: 'onboarding.check' }, (ctx) => {
      const uid = Number(ctx.params.userId), o = get('SELECT * FROM user_onboarding WHERE user_id = ?', uid); if (!o) throw notFound('Für dieses Mitglied läuft keine Einarbeitung.');
      if (o.completed_at) throw bad('Die Einarbeitung ist bereits abgeschlossen.');
      run('UPDATE user_onboarding SET completed_at = ?, skipped = 1 WHERE user_id = ?', now(), uid);
      audit(ctx, { action: 'onboarding.finished', module: 'onboarding', targetType: 'user', targetId: uid, targetLabel: memberLabel(userRow(uid) ?? { id: uid }), after: { skipped: true } });
      return { row: rowDto(ctx.user, get('SELECT * FROM user_onboarding WHERE user_id = ?', uid)) };
    });
    r.delete('/api/onboarding/:userId', { perm: 'onboarding.check' }, (ctx) => {
      const uid = Number(ctx.params.userId); if (!get('SELECT 1 x FROM user_onboarding WHERE user_id = ?', uid)) throw notFound('Für dieses Mitglied läuft keine Einarbeitung.');
      tx(() => { run('DELETE FROM onboarding_progress WHERE user_id = ?', uid); run('DELETE FROM user_onboarding WHERE user_id = ?', uid); });
      audit(ctx, { action: 'onboarding.removed', module: 'onboarding', targetType: 'user', targetId: uid, targetLabel: memberLabel(userRow(uid) ?? { id: uid }) });
      return { ok: true };
    });

    // Schritte der Checkliste
    const stepInput = (b, cur = {}) => {
      const out = {};
      if (b.title !== undefined || !cur.id) out.title = str(b.title, 'Titel', { min: 2, max: 120 });
      if (b.description !== undefined) out.description = str(b.description, 'Beschreibung', { max: 400, required: false });
      if (b.confirmBy !== undefined || !cur.id) { if (!CONFIRM[b.confirmBy]) throw bad('Bestätigung: „Führung“ oder „Mitglied selbst“.'); out.confirm_by = b.confirmBy; }
      if (b.isActive !== undefined) out.is_active = b.isActive ? 1 : 0;
      return out;
    };
    const afterStepChange = () => { for (const o of all('SELECT user_id FROM user_onboarding WHERE skipped = 0')) recompute(o.user_id); };
    r.post('/api/onboarding/steps', { perm: 'onboarding.manage' }, (ctx) => {
      const f = stepInput(ctx.body), max = get('SELECT COALESCE(MAX(sort_order),0) m FROM onboarding_steps').m, count = get('SELECT COUNT(*) c FROM onboarding_steps').c;
      if (count >= 30) throw bad('Es sind höchstens 30 Schritte möglich.');
      const id = Number(run('INSERT INTO onboarding_steps (sort_order,title,description,confirm_by,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', max + 1, f.title, f.description ?? '', f.confirm_by, f.is_active ?? 1, now(), now()).lastInsertRowid);
      afterStepChange();
      audit(ctx, { action: 'onboarding.step_created', module: 'onboarding', targetType: 'onboarding_step', targetId: id, targetLabel: f.title, after: { confirmBy: f.confirm_by } });
      ctx.status = 201; return { step: stepDto(get('SELECT * FROM onboarding_steps WHERE id = ?', id)) };
    });
    r.patch('/api/onboarding/steps/:id', { perm: 'onboarding.manage' }, (ctx) => {
      const cur = get('SELECT * FROM onboarding_steps WHERE id = ?', Number(ctx.params.id)); if (!cur) throw notFound('Schritt nicht gefunden.');
      const f = stepInput(ctx.body, cur), keys = Object.keys(f);
      if (keys.length) run(`UPDATE onboarding_steps SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => f[k]), now(), cur.id);
      afterStepChange();
      audit(ctx, { action: 'onboarding.step_updated', module: 'onboarding', targetType: 'onboarding_step', targetId: cur.id, targetLabel: f.title ?? cur.title, before: { title: cur.title, confirmBy: cur.confirm_by, active: !!cur.is_active }, after: f });
      return { step: stepDto(get('SELECT * FROM onboarding_steps WHERE id = ?', cur.id)) };
    });
    r.post('/api/onboarding/steps/:id/move', { perm: 'onboarding.manage' }, (ctx) => {
      const list = all('SELECT id FROM onboarding_steps ORDER BY sort_order, id').map((s) => s.id), i = list.indexOf(Number(ctx.params.id)); if (i < 0) throw notFound('Schritt nicht gefunden.');
      const j = ctx.body.dir === 'up' ? i - 1 : ctx.body.dir === 'down' ? i + 1 : -1; if (j < 0 || j >= list.length) return { ok: true };
      [list[i], list[j]] = [list[j], list[i]];
      tx(() => list.forEach((id, k) => run('UPDATE onboarding_steps SET sort_order = ? WHERE id = ?', k + 1, id)));
      return { ok: true };
    });
    r.delete('/api/onboarding/steps/:id', { perm: 'onboarding.manage' }, (ctx) => {
      const cur = get('SELECT * FROM onboarding_steps WHERE id = ?', Number(ctx.params.id)); if (!cur) throw notFound('Schritt nicht gefunden.');
      tx(() => { run('DELETE FROM onboarding_progress WHERE step_id = ?', cur.id); run('DELETE FROM onboarding_steps WHERE id = ?', cur.id); });
      afterStepChange();
      audit(ctx, { action: 'onboarding.step_deleted', module: 'onboarding', targetType: 'onboarding_step', targetId: cur.id, targetLabel: cur.title });
      return { ok: true };
    });
  },
};

function setStep(userId, stepId, done, byId) {
  if (done) run('INSERT OR REPLACE INTO onboarding_progress (user_id, step_id, done_by, done_at) VALUES (?,?,?,?)', userId, stepId, byId, now());
  else run('DELETE FROM onboarding_progress WHERE user_id = ? AND step_id = ?', userId, stepId);
  recompute(userId);
}
