import { all, get, run, now, tx } from '../core/db.js';
import { bad, forbidden, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { getConfig } from '../core/config.js';
import { notify } from '../core/notifications.js';
import { memberLabel } from '../core/identity.js';

/**
 * Watchlist (in der Benutzer-App): registrierte Benutzer – z. B. Ex-Mitglieder –, die gesondert beobachtet werden. Sichtbar nur für die Führung (Recht „users.watchlist“),
 * für die dazu beauftragten Mitglieder (Beobachter) und für den, der den Eintrag angelegt hat – nie für die Person selbst. Wer Benutzer bearbeiten darf („users.edit“),
 * setzt Personen auf die Liste und nimmt sie wieder herunter. Beobachter erfahren, wenn die Person sich anmeldet (bei gesperrten: einen Anmeldeversuch macht).
 */
const has = (u, p) => u.isAdmin || u.perms.has(p);
const userRow = (id) => get('SELECT id, member_number, status, rank_id FROM users WHERE id = ?', id);
const lbl = (viewer, id) => { const u = userRow(id); return u ? (u.id === viewer.id ? `${memberLabel(u)} (Du)` : memberLabel(u)) : 'Gelöschtes Mitglied'; };
const observersOf = (id) => all('SELECT observer_id FROM user_watch_observers WHERE user_id = ?', id).map((r) => r.observer_id);
const activeIds = (ids, what) => { const out = []; for (const id of new Set(ids ?? [])) { if (!Number.isInteger(id) || !get("SELECT 1 x FROM users WHERE id = ? AND status = 'active'", id)) throw bad(`${what}: unbekanntes Mitglied.`); out.push(id); } return out; };

/** Darf der Betrachter diesen Eintrag sehen? (nie die beobachtete Person selbst) */
const canSee = (viewer, w) => w.user_id !== viewer.id && (has(viewer, 'users.watchlist') || w.added_by === viewer.id || observersOf(w.user_id).includes(viewer.id));

function dto(w, viewer) {
  const u = get('SELECT u.id, u.member_number, u.status, r.name rank_name, r.color rank_color FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?', w.user_id);
  return {
    userId: w.user_id, memberNumber: u?.member_number ?? null, label: lbl(viewer, w.user_id), status: u?.status ?? null, rank: u?.rank_name ? { name: u.rank_name, color: u.rank_color } : null,
    reason: w.reason, observers: observersOf(w.user_id).map((id) => ({ id, label: lbl(viewer, id) })), addedBy: w.added_by ? lbl(viewer, w.added_by) : null, addedAt: w.added_at, updatedAt: w.updated_at,
    canEdit: has(viewer, 'users.edit'),
  };
}
/** Für die Benutzerliste und das Profil: Eintrag (für den roten Hinweis), wenn der Betrachter ihn sehen darf. */
export function watchFor(viewer, userId) {
  const w = get('SELECT * FROM user_watch WHERE user_id = ?', userId);
  return w && canSee(viewer, w) ? { reason: w.reason, observers: observersOf(userId).length, canEdit: has(viewer, 'users.edit') } : null;
}

// ── Hinweis an die Beobachter bei Anmeldung / Anmeldeversuch ──
const lastNote = new Map();
export function watchLoginNotice(userId, { blocked = false } = {}) {
  if (!getConfig('users.watch_notify')) return;
  const w = get('SELECT * FROM user_watch WHERE user_id = ?', userId); if (!w) return;
  const k = `${userId}:${blocked ? 'b' : 'l'}`, t = Date.now(); if (t - (lastNote.get(k) ?? 0) < 30 * 60_000) return; lastNote.set(k, t);
  const ids = observersOf(userId).filter((id) => id !== userId); if (!ids.length) return;
  const nr = userRow(userId)?.member_number ?? `Mitglied #${userId}`;
  notify(ids.map((id) => ({ type: 'user', id })), { key: `watch:${userId}:${blocked ? 'blocked' : 'login'}:${now()}`, title: blocked ? `Watchlist: ${nr} versucht sich anzumelden` : `Watchlist: ${nr} hat sich angemeldet`, body: w.reason.slice(0, 120), target: { app: 'users', watch: true } });
}

export default {
  name: 'watchlist',
  permissions: [['users.watchlist', 'Watchlist: alle beobachteten Personen sehen (Führung) – Eintragen/Entfernen mit „Benutzer bearbeiten“']],
  config: [
    { key: 'users.watch_notify', group: 'Mitglieder', label: 'Watchlist: Beobachter bei Anmeldung benachrichtigen', help: 'Beauftragte Beobachter erfahren (höchstens alle 30 Minuten), wenn eine beobachtete Person sich anmeldet – bei gesperrten Zugängen, wenn sie es versucht.', type: 'bool', default: true },
  ],
  routes(r) {
    const V = { perm: 'users.view' };
    r.get('/api/watchlist', V, (ctx) => ({
      entries: all('SELECT * FROM user_watch ORDER BY added_at DESC').filter((w) => canSee(ctx.user, w)).map((w) => dto(w, ctx.user)),
      canManage: has(ctx.user, 'users.edit'), canViewAll: has(ctx.user, 'users.watchlist'),
    }));
    r.get('/api/watchlist/options', { perm: 'users.edit' }, (ctx) => ({
      candidates: all('SELECT id, member_number, status FROM users WHERE id != ? AND id NOT IN (SELECT user_id FROM user_watch) ORDER BY member_number, id', ctx.user.id).map((u) => ({ id: u.id, label: memberLabel(u), status: u.status })),
      members: all("SELECT id, member_number, status FROM users WHERE status = 'active' ORDER BY member_number, id").map((u) => ({ id: u.id, label: u.id === ctx.user.id ? `${memberLabel(u)} (Du)` : memberLabel(u) })),
    }));
    r.post('/api/watchlist', { perm: 'users.edit' }, (ctx) => {
      const b = ctx.body, uid = b.userId, u = Number.isInteger(uid) ? userRow(uid) : null;
      if (!u) throw bad('Bitte eine Person auswählen.'); if (u.id === ctx.user.id) throw bad('Du kannst dich nicht selbst auf die Watchlist setzen.');
      if (get('SELECT 1 x FROM user_watch WHERE user_id = ?', uid)) throw bad('Diese Person steht schon auf der Watchlist.');
      const reason = str(b.reason, 'Grund', { min: 3, max: 600 }), obs = activeIds(b.observers, 'Beobachter').filter((id) => id !== uid), t = now();
      tx(() => {
        run('INSERT INTO user_watch (user_id,reason,added_by,added_at,updated_at) VALUES (?,?,?,?,?)', uid, reason, ctx.user.id, t, t);
        for (const id of obs) run('INSERT INTO user_watch_observers (user_id,observer_id) VALUES (?,?)', uid, id);
        audit(ctx, { action: 'watchlist.added', module: 'users', targetType: 'user', targetId: uid, targetLabel: memberLabel(u), after: { observers: obs.length } });
      });
      notify(obs.filter((id) => id !== ctx.user.id).map((id) => ({ type: 'user', id })), { key: `watch:${uid}:assign:${t}`, title: `Du beobachtest jetzt ${memberLabel(u)}`, body: reason.slice(0, 120), target: { app: 'users', watch: true } });
      ctx.status = 201; return { entry: dto(get('SELECT * FROM user_watch WHERE user_id = ?', uid), ctx.user) };
    });
    const load = (ctx) => { const w = get('SELECT * FROM user_watch WHERE user_id = ?', Number(ctx.params.id)); if (!w || !canSee(ctx.user, w)) throw notFound('Eintrag nicht gefunden.'); return w; };
    r.patch('/api/watchlist/:id', { perm: 'users.edit' }, (ctx) => {
      const w = load(ctx), b = ctx.body, t = now(); let added = [];
      tx(() => {
        if (b.reason !== undefined) run('UPDATE user_watch SET reason = ? WHERE user_id = ?', str(b.reason, 'Grund', { min: 3, max: 600 }), w.user_id);
        if (b.observers !== undefined) {
          const want = activeIds(b.observers, 'Beobachter').filter((id) => id !== w.user_id), have = new Set(observersOf(w.user_id));
          for (const id of have) if (!want.includes(id)) run('DELETE FROM user_watch_observers WHERE user_id = ? AND observer_id = ?', w.user_id, id);
          added = want.filter((id) => !have.has(id)); for (const id of added) run('INSERT INTO user_watch_observers (user_id,observer_id) VALUES (?,?)', w.user_id, id);
        }
        run('UPDATE user_watch SET updated_at = ? WHERE user_id = ?', t, w.user_id);
        audit(ctx, { action: 'watchlist.updated', module: 'users', targetType: 'user', targetId: w.user_id, targetLabel: userRow(w.user_id)?.member_number ?? `Mitglied #${w.user_id}` });
      });
      const nr = userRow(w.user_id)?.member_number ?? `Mitglied #${w.user_id}`;
      notify(added.filter((id) => id !== ctx.user.id).map((id) => ({ type: 'user', id })), { key: `watch:${w.user_id}:assign:${t}`, title: `Du beobachtest jetzt ${nr}`, body: get('SELECT reason FROM user_watch WHERE user_id = ?', w.user_id).reason.slice(0, 120), target: { app: 'users', watch: true } });
      return { entry: dto(get('SELECT * FROM user_watch WHERE user_id = ?', w.user_id), ctx.user) };
    });
    r.delete('/api/watchlist/:id', { perm: 'users.edit' }, (ctx) => {
      const w = load(ctx); if (!has(ctx.user, 'users.edit')) throw forbidden();
      run('DELETE FROM user_watch WHERE user_id = ?', w.user_id);
      audit(ctx, { action: 'watchlist.removed', module: 'users', targetType: 'user', targetId: w.user_id, targetLabel: userRow(w.user_id)?.member_number ?? `Mitglied #${w.user_id}` });
      return { ok: true };
    });
  },
};
