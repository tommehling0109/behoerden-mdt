import { all, get, run, now } from '../core/db.js';
import { bad, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { labelForUser } from '../core/identity.js';
import { notify, staffWith } from '../core/notifications.js';
import { publish } from '../core/realtime.js';

/**
 * Schwarzes Brett: Ankündigungen, die direkt auf dem Desktop aller Mitglieder stehen (keine eigene App, nicht für externe Partner).
 * Sehen: „board.view“. Anlegen, bearbeiten, anpinnen, entfernen: „board.manage“. Verfasser erscheinen nur als Personalnummer.
 */
const LEVELS = ['info', 'important', 'urgent', 'success'];
const AUDIENCES = ['all', 'internal', 'external']; // Ticker: alle, nur Mitglieder, nur Externe
const tickerChanged = (kind) => publish({ topic: 'ticker', kind, staff: 1, partnerScope: 'all' }); // Laufband bei Mitgliedern UND Externen live aktualisieren
/** Laufende Ticker für eine Zielgruppe: aktiv, nicht abgelaufen. */
const activeTickers = (aud) => all("SELECT id, title, body, level, ticker_until FROM board_posts WHERE ticker = 1 AND (ticker_until IS NULL OR ticker_until > ?) AND ticker_audience IN ('all', ?) ORDER BY pinned DESC, id DESC LIMIT 10", now(), aud)
  .map((p) => ({ id: p.id, text: p.body ? `${p.title} – ${p.body.replace(/\s+/g, ' ').slice(0, 180)}` : p.title, level: p.level, until: p.ticker_until }));

const dto = (p, viewerId) => ({
  id: p.id, title: p.title, body: p.body, level: p.level, pinned: !!p.pinned, ticker: !!p.ticker, tickerAudience: p.ticker_audience, tickerUntil: p.ticker_until,
  author: p.author_id ? labelForUser(p.author_id, viewerId) : null, createdAt: p.created_at, updatedAt: p.updated_at,
});
const load = (id) => { const p = get('SELECT * FROM board_posts WHERE id = ?', Number(id)); if (!p) throw notFound('Ankündigung nicht gefunden.'); return p; };
function input(b, partial = false) {
  const out = {};
  if (!partial || b.title !== undefined) out.title = str(b.title, 'Titel', { min: 2, max: 80 });
  if (!partial || b.body !== undefined) out.body = str(b.body ?? '', 'Text', { max: 1500, required: false }) ?? '';
  if (!partial || b.level !== undefined) { if (!LEVELS.includes(b.level ?? 'info')) throw bad('Ungültige Hervorhebung.'); out.level = b.level ?? 'info'; }
  if (!partial || b.pinned !== undefined) out.pinned = b.pinned ? 1 : 0;
  if (b.ticker !== undefined) out.ticker = b.ticker ? 1 : 0;
  if (b.tickerAudience !== undefined) { if (!AUDIENCES.includes(b.tickerAudience)) throw bad('Ungültige Zielgruppe für den Ticker.'); out.ticker_audience = b.tickerAudience; }
  if (b.tickerUntil !== undefined) {
    if (b.tickerUntil === null || b.tickerUntil === '') out.ticker_until = null;
    else { const d = new Date(b.tickerUntil); if (Number.isNaN(d.getTime())) throw bad('Ungültiges Datum für das Ende des Tickers.'); out.ticker_until = d.toISOString(); }
  }
  return out;
}

export default {
  name: 'board',
  permissions: [
    ['board.view', 'Schwarzes Brett: Ankündigungen auf dem Desktop sehen'],
    ['board.manage', 'Schwarzes Brett: Ankündigungen anlegen, bearbeiten, anpinnen und entfernen'],
  ],
  init() {
    // Einmalig: bestehende Rollen dürfen das Brett sehen (neue Rechte sind sonst für niemanden sichtbar)
    if (get("SELECT 1 x FROM sequences WHERE name = 'board_view_granted'")) return;
    run("INSERT INTO sequences (name,next_value) VALUES ('board_view_granted',1)");
    if (get("SELECT 1 x FROM permissions WHERE key = 'board.view'")) run("INSERT OR IGNORE INTO role_permissions (role_id,permission_key) SELECT id, 'board.view' FROM roles");
  },
  routes(r) {
    r.get('/api/board', { perm: 'board.view' }, (ctx) => ({
      posts: all('SELECT * FROM board_posts ORDER BY pinned DESC, id DESC LIMIT 100').map((p) => dto(p, ctx.user.id)),
      canManage: ctx.user.perms.has('board.manage'),
    }));

    // Ungelesen = neu oder im Inhalt (Überschrift, Text, Hervorhebung) seit der letzten Bestätigung geändert. Erstmalig: nur die neuesten fünf.
    const stamp = 'COALESCE(p.content_at, p.updated_at)';
    r.get('/api/board/unread', { perm: 'board.view' }, (ctx) => {
      const rows = all(`SELECT p.*, ${stamp} stamp, a.user_id seen FROM board_posts p LEFT JOIN board_ack a ON a.post_id = p.id AND a.user_id = ? WHERE a.user_id IS NULL OR a.acked_updated_at < ${stamp} ORDER BY p.pinned DESC, p.id DESC`, ctx.user.id);
      const first = !get('SELECT 1 x FROM board_ack WHERE user_id = ?', ctx.user.id), cap = first ? 5 : 10;
      return { posts: rows.slice(0, cap).map((p) => ({ ...dto(p, ctx.user.id), changed: !!p.seen, updatedAt: p.stamp })), more: Math.max(0, rows.length - cap), total: rows.length };
    });
    r.post('/api/board/ack', { perm: 'board.view' }, (ctx) => {
      const upTo = ctx.body.upTo ? new Date(ctx.body.upTo) : null;
      if (!upTo || Number.isNaN(upTo.getTime())) throw bad('Stand der angezeigten Einträge fehlt.');
      const t = now(), titles = [];
      let n = 0;
      for (const p of all(`SELECT p.id, p.title, p.level, ${stamp} stamp, a.user_id seen FROM board_posts p LEFT JOIN board_ack a ON a.post_id = p.id AND a.user_id = ? WHERE (a.user_id IS NULL OR a.acked_updated_at < ${stamp}) AND ${stamp} <= ?`, ctx.user.id, upTo.toISOString())) {
        run('INSERT INTO board_ack (user_id,post_id,acked_updated_at,acked_at) VALUES (?,?,?,?) ON CONFLICT(user_id,post_id) DO UPDATE SET acked_updated_at = excluded.acked_updated_at, acked_at = excluded.acked_at', ctx.user.id, p.id, p.stamp, t);
        run('INSERT INTO board_ack_log (user_id,post_id,post_title,post_level,post_updated_at,first_ack,acked_at) VALUES (?,?,?,?,?,?,?)', ctx.user.id, p.id, p.title, p.level, p.stamp, p.seen ? 0 : 1, t);
        titles.push(`${p.title}${p.seen ? ' (geändert)' : ''}`); n++;
      }
      if (n) audit(ctx, { action: 'board.acknowledged', module: 'board', targetType: 'board_post', targetLabel: `${n} Aushang${n === 1 ? '' : 'e'} bestätigt`, after: { posts: titles } });
      return { acknowledged: n };
    });
    // Verwaltung: Bestätigungen eines Mitglieds
    r.get('/api/users/:id/board', { perm: 'users.view' }, (ctx) => {
      const id = Number(ctx.params.id);
      if (!get('SELECT 1 x FROM users WHERE id = ?', id)) throw notFound('Benutzer nicht gefunden.');
      const open = all(`SELECT p.id, p.title, p.level, a.user_id seen FROM board_posts p LEFT JOIN board_ack a ON a.post_id = p.id AND a.user_id = ? WHERE a.user_id IS NULL OR a.acked_updated_at < ${stamp} ORDER BY p.id DESC`, id);
      return {
        lastAckAt: get('SELECT MAX(acked_at) t FROM board_ack_log WHERE user_id = ?', id)?.t ?? null,
        open: open.map((p) => ({ id: p.id, title: p.title, level: p.level, changed: !!p.seen })),
        history: all('SELECT * FROM board_ack_log WHERE user_id = ? ORDER BY id DESC LIMIT 200', id).map((h) => ({ id: h.id, title: h.post_title, level: h.post_level, changed: !h.first_ack, ackedAt: h.acked_at })),
      };
    });

    // Laufband: für Mitglieder (jeder aktive Benutzer) und Externe getrennt – jeweils nur die für sie bestimmten Meldungen
    r.get('/api/ticker', () => ({ items: activeTickers('internal') }));
    r.get('/api/p/ticker', { auth: 'partner' }, () => ({ items: activeTickers('external') }));

    r.post('/api/board', { perm: 'board.manage' }, (ctx) => {
      const v = input(ctx.body), t = now();
      const cols = { ...v, author_id: ctx.user.id, created_at: t, updated_at: t, content_at: t }, keys = Object.keys(cols);
      const id = Number(run(`INSERT INTO board_posts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...Object.values(cols)).lastInsertRowid);
      if (v.ticker) tickerChanged('created');
      if (v.level === 'important' || v.level === 'urgent') notify(staffWith('board.view', ctx.user.id), { key: `board:${id}:new`, title: v.level === 'urgent' ? 'Dringende Ankündigung' : 'Neue Ankündigung', body: v.title });
      audit(ctx, { action: 'board.created', module: 'board', targetType: 'board_post', targetId: id, targetLabel: v.title, after: { level: v.level, pinned: !!v.pinned } });
      ctx.status = 201;
      return { post: dto(get('SELECT * FROM board_posts WHERE id = ?', id), ctx.user.id) };
    });

    r.patch('/api/board/:id', { perm: 'board.manage' }, (ctx) => {
      const p = load(ctx.params.id), v = input(ctx.body, true), cols = Object.keys(v);
      if (cols.length) run(`UPDATE board_posts SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => v[c]), now(), p.id);
      if (cols.some((c) => ['title', 'body', 'level'].includes(c))) run('UPDATE board_posts SET content_at = ? WHERE id = ?', now(), p.id); // nur Änderungen am Inhalt müssen erneut bestätigt werden (nicht Anpinnen o. Ä.)
      if (p.ticker || v.ticker || cols.some((c) => c.startsWith('ticker') || ['title', 'body', 'level'].includes(c))) tickerChanged('updated');
      audit(ctx, { action: 'board.updated', module: 'board', targetType: 'board_post', targetId: p.id, targetLabel: v.title ?? p.title, before: { level: p.level, pinned: !!p.pinned }, after: { level: v.level ?? p.level, pinned: v.pinned !== undefined ? !!v.pinned : !!p.pinned } });
      return { post: dto(get('SELECT * FROM board_posts WHERE id = ?', p.id), ctx.user.id) };
    });

    r.delete('/api/board/:id', { perm: 'board.manage' }, (ctx) => {
      const p = load(ctx.params.id);
      run('DELETE FROM board_posts WHERE id = ?', p.id);
      if (p.ticker) tickerChanged('deleted');
      audit(ctx, { action: 'board.deleted', module: 'board', targetType: 'board_post', targetId: p.id, targetLabel: p.title });
      return { ok: true };
    });
  },
};
