import { all, get, run, now } from '../core/db.js';
import { bad, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { labelForUser } from '../core/identity.js';
import { notify, staffWith } from '../core/notifications.js';

/**
 * Changelog: Update-Einträge direkt auf dem Desktop (links) – je Eintrag Version, Titel, Datum und Punkte
 * (neue Funktion, geändert, behoben, entfernt, Sicherheit). Sehen: „changelog.view“; anlegen/bearbeiten/löschen: „changelog.manage“.
 */
export const KINDS = { new: 'Neu', changed: 'Geändert', fixed: 'Behoben', removed: 'Entfernt', security: 'Sicherheit' };
const today = () => now().slice(0, 10);

const dto = (e, viewerId) => ({
  id: e.id, version: e.version || null, title: e.title, releasedAt: e.released_at, items: JSON.parse(e.items),
  author: e.author_id ? labelForUser(e.author_id, viewerId) : null, createdAt: e.created_at,
});
const load = (id) => { const e = get('SELECT * FROM changelog_entries WHERE id = ?', Number(id)); if (!e) throw notFound('Eintrag nicht gefunden.'); return e; };

function fields(b, partial) {
  const out = {};
  if (!partial || b.title !== undefined) out.title = str(b.title, 'Titel', { min: 2, max: 80 });
  if (!partial || b.version !== undefined) out.version = str(b.version ?? '', 'Version', { max: 20, required: false }) ?? '';
  if (!partial || b.releasedAt !== undefined) {
    const d = b.releasedAt ? String(b.releasedAt) : today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(new Date(d).getTime())) throw bad('Ungültiges Datum.');
    out.released_at = d;
  }
  if (!partial || b.items !== undefined) {
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 30) throw bad('Bitte 1 bis 30 Punkte angeben.');
    out.items = JSON.stringify(b.items.map((i) => {
      if (!KINDS[i?.kind]) throw bad('Ungültige Art eines Punktes.');
      return { kind: i.kind, text: str(i.text, 'Text', { min: 2, max: 240 }) };
    }));
  }
  return out;
}

export default {
  name: 'changelog',
  permissions: [
    ['changelog.view', 'Changelog: Updates auf dem Desktop und alle älteren Einträge ansehen'],
    ['changelog.manage', 'Changelog: Einträge anlegen, bearbeiten und löschen'],
  ],
  init() {
    // Einmalig: bestehende Rollen dürfen das Changelog sehen
    if (get("SELECT 1 x FROM sequences WHERE name = 'changelog_view_granted'")) return;
    run("INSERT INTO sequences (name,next_value) VALUES ('changelog_view_granted',1)");
    if (get("SELECT 1 x FROM permissions WHERE key = 'changelog.view'")) run("INSERT OR IGNORE INTO role_permissions (role_id,permission_key) SELECT id, 'changelog.view' FROM roles");
  },
  routes(r) {
    r.get('/api/changelog', { perm: 'changelog.view' }, (ctx) => {
      const limit = Math.min(Math.max(parseInt(ctx.query.limit, 10) || 3, 1), 50), offset = Math.max(parseInt(ctx.query.offset, 10) || 0, 0);
      return {
        entries: all('SELECT * FROM changelog_entries ORDER BY released_at DESC, id DESC LIMIT ? OFFSET ?', limit, offset).map((e) => dto(e, ctx.user.id)),
        total: get('SELECT COUNT(*) c FROM changelog_entries').c, canManage: ctx.user.perms.has('changelog.manage'), kinds: KINDS,
      };
    });

    // Ungelesen = neu oder seit der letzten Bestätigung geändert. Wer noch nie etwas bestätigt hat, bekommt nur die neuesten Einträge.
    r.get('/api/changelog/unread', { perm: 'changelog.view' }, (ctx) => {
      const rows = all('SELECT e.*, a.user_id seen FROM changelog_entries e LEFT JOIN changelog_ack a ON a.entry_id = e.id AND a.user_id = ? WHERE a.user_id IS NULL OR a.acked_updated_at < e.updated_at ORDER BY e.released_at DESC, e.id DESC', ctx.user.id);
      const first = !get('SELECT 1 x FROM changelog_ack WHERE user_id = ?', ctx.user.id), cap = first ? 5 : 10;
      return { entries: rows.slice(0, cap).map((e) => ({ ...dto(e, ctx.user.id), changed: !!e.seen, updatedAt: e.updated_at })), more: Math.max(0, rows.length - cap), total: rows.length };
    });
    // Bestätigen: alles, was bis zum angezeigten Stand (upTo = neuester Änderungszeitpunkt der gezeigten Einträge) neu oder geändert war
    r.post('/api/changelog/ack', { perm: 'changelog.view' }, (ctx) => {
      const upTo = ctx.body.upTo ? new Date(ctx.body.upTo) : null;
      if (!upTo || Number.isNaN(upTo.getTime())) throw bad('Stand der angezeigten Einträge fehlt.');
      const t = now(), titles = [];
      let n = 0;
      for (const e of all('SELECT e.id, e.title, e.version, e.updated_at, a.user_id seen FROM changelog_entries e LEFT JOIN changelog_ack a ON a.entry_id = e.id AND a.user_id = ? WHERE (a.user_id IS NULL OR a.acked_updated_at < e.updated_at) AND e.updated_at <= ?', ctx.user.id, upTo.toISOString())) {
        run('INSERT INTO changelog_ack (user_id,entry_id,acked_updated_at,acked_at) VALUES (?,?,?,?) ON CONFLICT(user_id,entry_id) DO UPDATE SET acked_updated_at = excluded.acked_updated_at, acked_at = excluded.acked_at', ctx.user.id, e.id, e.updated_at, t);
        run('INSERT INTO changelog_ack_log (user_id,entry_id,entry_title,entry_version,entry_updated_at,first_ack,acked_at) VALUES (?,?,?,?,?,?,?)', ctx.user.id, e.id, e.title, e.version, e.updated_at, e.seen ? 0 : 1, t);
        titles.push(`${e.version ? e.version + ' · ' : ''}${e.title}${e.seen ? ' (geändert)' : ''}`); n++;
      }
      if (n) audit(ctx, { action: 'changelog.acknowledged', module: 'changelog', targetType: 'changelog', targetLabel: `${n} Update${n === 1 ? '' : 's'} bestätigt`, after: { entries: titles } });
      return { acknowledged: n };
    });

    // Verwaltung: wann hat dieses Mitglied zuletzt Updates bestätigt, was liegt noch offen, Verlauf der Bestätigungen
    r.get('/api/users/:id/changelog', { perm: 'users.view' }, (ctx) => {
      const id = Number(ctx.params.id);
      if (!get('SELECT 1 x FROM users WHERE id = ?', id)) throw notFound('Benutzer nicht gefunden.');
      const open = all('SELECT e.id, e.title, e.version, a.user_id seen FROM changelog_entries e LEFT JOIN changelog_ack a ON a.entry_id = e.id AND a.user_id = ? WHERE a.user_id IS NULL OR a.acked_updated_at < e.updated_at ORDER BY e.released_at DESC, e.id DESC', id);
      return {
        lastAckAt: get('SELECT MAX(acked_at) t FROM changelog_ack_log WHERE user_id = ?', id)?.t ?? null,
        open: open.map((e) => ({ id: e.id, title: e.title, version: e.version || null, changed: !!e.seen })),
        history: all('SELECT * FROM changelog_ack_log WHERE user_id = ? ORDER BY id DESC LIMIT 200', id).map((h) => ({ id: h.id, title: h.entry_title, version: h.entry_version || null, entryUpdatedAt: h.entry_updated_at, changed: !h.first_ack, ackedAt: h.acked_at })),
      };
    });

    r.post('/api/changelog', { perm: 'changelog.manage' }, (ctx) => {
      const v = fields(ctx.body, false), t = now();
      const id = Number(run('INSERT INTO changelog_entries (version,title,released_at,items,author_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', v.version, v.title, v.released_at, v.items, ctx.user.id, t, t).lastInsertRowid);
      notify(staffWith('changelog.view', ctx.user.id), { key: `changelog:${id}:new`, title: v.version ? `Update ${v.version}` : 'Neues Update', body: v.title });
      audit(ctx, { action: 'changelog.created', module: 'changelog', targetType: 'changelog', targetId: id, targetLabel: `${v.version ? v.version + ' · ' : ''}${v.title}` });
      ctx.status = 201;
      return { entry: dto(load(id), ctx.user.id) };
    });

    r.patch('/api/changelog/:id', { perm: 'changelog.manage' }, (ctx) => {
      const e = load(ctx.params.id), v = fields(ctx.body, true), cols = Object.keys(v);
      if (cols.length) run(`UPDATE changelog_entries SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => v[c]), now(), e.id);
      audit(ctx, { action: 'changelog.updated', module: 'changelog', targetType: 'changelog', targetId: e.id, targetLabel: `${v.version ?? e.version ? (v.version ?? e.version) + ' · ' : ''}${v.title ?? e.title}` });
      return { entry: dto(load(e.id), ctx.user.id) };
    });

    r.delete('/api/changelog/:id', { perm: 'changelog.manage' }, (ctx) => {
      const e = load(ctx.params.id);
      run('DELETE FROM changelog_entries WHERE id = ?', e.id);
      audit(ctx, { action: 'changelog.deleted', module: 'changelog', targetType: 'changelog', targetId: e.id, targetLabel: `${e.version ? e.version + ' · ' : ''}${e.title}` });
      return { ok: true };
    });
  },
};
