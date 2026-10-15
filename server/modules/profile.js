import { get, run, now, DB_PATH } from '../core/db.js';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bad, forbidden, notFound } from '../core/http.js';
import { audit } from '../core/audit.js';
import { publish } from '../core/realtime.js';
import { decodeImage, IMAGE_MIME } from '../core/images.js';

/**
 * Profilbilder: jedes Mitglied lädt sein eigenes hoch (PNG/JPEG/WebP, Typ per Dateikopf geprüft, max. 2 MB, kein SVG).
 * Mitglieder mit dem Recht „users.avatar_remove“ können Bilder anderer entfernen (z. B. bei unpassenden Inhalten).
 * Bilder werden zusammen mit der Personalnummer gezeigt – Namen bleiben anonym.
 */
const dir = () => join(dirname(DB_PATH), 'avatars');
const fileOf = (id, ext) => join(dir(), `${id}.${ext}`);
const dropFile = (id, ext) => { if (ext) try { unlinkSync(fileOf(id, ext)); } catch { /* egal */ } };
/** Live: Listen, Chat und Kopfzeile aktualisieren das Bild sofort (Thema „profile“ geht an alle Mitarbeiter). */
const changed = (userId, kind) => publish({ topic: 'profile', kind, entityType: 'user', entityId: userId, staff: 1 });

export default {
  name: 'profile',
  permissions: [['users.avatar_edit', 'Profilbilder anderer Mitglieder hochladen/ändern'], ['users.avatar_remove', 'Profilbilder anderer Mitglieder entfernen']],
  routes(r) {
    r.get('/api/avatars/:id', (ctx) => {
      const u = get("SELECT id, avatar_ext, avatar_version FROM users WHERE id = ? AND status = 'active'", Number(ctx.params.id));
      const file = u?.avatar_ext && fileOf(u.id, u.avatar_ext);
      if (!file || !existsSync(file)) throw notFound('Kein Profilbild.');
      ctx.raw = { contentType: IMAGE_MIME[u.avatar_ext], body: readFileSync(file), inline: true, cache: 'private, max-age=31536000, immutable' }; // die URL enthält die Version
    });

    r.post('/api/account/avatar', { bodyLimit: 3 * 1024 * 1024 }, (ctx) => {
      const { buf, ext } = decodeImage(ctx.body.data, 2 * 1024 * 1024, bad);
      const cur = get('SELECT avatar_ext FROM users WHERE id = ?', ctx.user.id);
      mkdirSync(dir(), { recursive: true });
      if (cur?.avatar_ext && cur.avatar_ext !== ext) dropFile(ctx.user.id, cur.avatar_ext);
      writeFileSync(fileOf(ctx.user.id, ext), buf);
      run('UPDATE users SET avatar_ext = ?, avatar_version = avatar_version + 1 WHERE id = ?', ext, ctx.user.id);
      const v = get('SELECT avatar_version v FROM users WHERE id = ?', ctx.user.id).v;
      audit(ctx, { action: 'account.avatar_set', module: 'users', targetType: 'user', targetId: ctx.user.id });
      changed(ctx.user.id, 'avatar_set');
      return { avatarUrl: `/api/avatars/${ctx.user.id}?v=${v}` };
    });
    r.delete('/api/account/avatar', (ctx) => {
      const cur = get('SELECT avatar_ext FROM users WHERE id = ?', ctx.user.id);
      dropFile(ctx.user.id, cur?.avatar_ext);
      run('UPDATE users SET avatar_ext = NULL, avatar_version = avatar_version + 1 WHERE id = ?', ctx.user.id);
      audit(ctx, { action: 'account.avatar_removed', module: 'users', targetType: 'user', targetId: ctx.user.id });
      changed(ctx.user.id, 'avatar_removed');
      return { ok: true };
    });
    r.post('/api/users/:id/avatar', { perm: 'users.avatar_edit', bodyLimit: 3 * 1024 * 1024 }, (ctx) => {
      const id = Number(ctx.params.id);
      const u = get('SELECT id, avatar_ext FROM users WHERE id = ?', id);
      if (!u) throw notFound('Benutzer nicht gefunden.');
      const { buf, ext } = decodeImage(ctx.body.data, 2 * 1024 * 1024, bad);
      mkdirSync(dir(), { recursive: true });
      if (u.avatar_ext && u.avatar_ext !== ext) dropFile(id, u.avatar_ext);
      writeFileSync(fileOf(id, ext), buf);
      run('UPDATE users SET avatar_ext = ?, avatar_version = avatar_version + 1 WHERE id = ?', ext, id);
      audit(ctx, { action: 'user.avatar_set', module: 'users', targetType: 'user', targetId: id });
      changed(id, 'avatar_set');
      return { avatarUrl: `/api/avatars/${id}?v=${get('SELECT avatar_version v FROM users WHERE id = ?', id).v}` };
    });
    r.delete('/api/users/:id/avatar', { perm: 'users.avatar_remove' }, (ctx) => {
      const id = Number(ctx.params.id);
      const u = get('SELECT id, avatar_ext, member_number FROM users WHERE id = ?', id);
      if (!u) throw notFound('Benutzer nicht gefunden.');
      if (!u.avatar_ext) throw forbidden('Dieses Mitglied hat kein Profilbild.');
      dropFile(id, u.avatar_ext);
      run('UPDATE users SET avatar_ext = NULL, avatar_version = avatar_version + 1 WHERE id = ?', id);
      audit(ctx, { action: 'user.avatar_removed', module: 'users', targetType: 'user', targetId: id });
      changed(id, 'avatar_removed');
      return { ok: true };
    });
  },
};

export const avatarUrl = (id, ext, version) => (ext ? `/api/avatars/${id}?v=${version}` : null);
