import { all, get, run, now, DB_PATH } from '../core/db.js';
import { bad, notFound, forbidden, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { decodeDocument, DOC_MIME } from '../core/images.js';
import { memberLabel, labelForUser } from '../core/identity.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Weitere Dateien zu Mitgliedern (Personalakte) und externen Zugängen: eigene Dokumente mit Name und Beschreibung,
 * zusätzlich zu den festen Dokumenten (Ausweis, Führerschein, …). Rechte wie bei den festen Dokumenten:
 *  Mitglied: sehen = users.personnel_view (oder man selbst), ändern = users.personnel_edit · Partner: partners.documents.
 */
const MAX_FILES = 25;
const dir = () => join(dirname(DB_PATH), 'extra-files');
const fileOf = (f) => join(dir(), `${f.id}.${f.ext}`);
const TYPES = { user: 'Mitglied', partner: 'Externer Zugang' };

const dto = (f, viewerId) => ({ id: f.id, name: f.name, description: f.description, ext: f.ext, size: f.size, createdAt: f.created_at, uploadedBy: f.uploaded_by ? labelForUser(f.uploaded_by, viewerId) : null });
function owner(type, id) {
  if (!TYPES[type]) throw notFound('Unbekannter Typ.');
  if (!Number.isInteger(id)) throw notFound('Nicht gefunden.');
  const o = type === 'user' ? get('SELECT id, member_number, status FROM users WHERE id = ?', id) : get('SELECT id, partner_number, name FROM partners WHERE id = ?', id);
  if (!o) throw notFound('Nicht gefunden.');
  return { o, label: type === 'user' ? memberLabel(o) : `${o.partner_number ?? ''} ${o.name ?? ''}`.trim() };
}
const mayView = (ctx, type, id) => (type === 'user' ? ctx.user.id === id || ctx.user.perms.has('users.personnel_view') : ctx.user.perms.has('partners.documents'));
const mayEdit = (ctx, type) => ctx.user.perms.has(type === 'user' ? 'users.personnel_edit' : 'partners.documents');
const deny = (type) => forbidden(type === 'user' ? 'Dafür fehlt dir das Recht „users.personnel_view“ bzw. „users.personnel_edit“.' : 'Dafür fehlt dir das Recht „partners.documents“.');

export default {
  name: 'extrafiles',
  routes(r) {
    r.get('/api/extra-files/:type/:id', (ctx) => {
      const { type } = ctx.params, id = Number(ctx.params.id);
      owner(type, id);
      if (!mayView(ctx, type, id)) throw deny(type);
      return { files: all('SELECT * FROM extra_files WHERE owner_type = ? AND owner_id = ? ORDER BY id', type, id).map((f) => dto(f, ctx.user.id)), canEdit: mayEdit(ctx, type) };
    });

    r.post('/api/extra-files/:type/:id', { bodyLimit: 8 * 1024 * 1024 }, (ctx) => {
      const { type } = ctx.params, id = Number(ctx.params.id), { label } = owner(type, id);
      if (!mayEdit(ctx, type)) throw deny(type);
      const name = str(ctx.body.name, 'Name', { min: 2, max: 80 }), description = str(ctx.body.description ?? '', 'Beschreibung', { max: 300, required: false }) ?? '';
      if (get('SELECT COUNT(*) c FROM extra_files WHERE owner_type = ? AND owner_id = ?', type, id).c >= MAX_FILES) throw bad(`Es sind höchstens ${MAX_FILES} weitere Dateien möglich.`);
      const { buf, ext } = decodeDocument(ctx.body.data, 6 * 1024 * 1024, bad);
      const res = run('INSERT INTO extra_files (owner_type,owner_id,name,description,ext,size,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?)', type, id, name, description, ext, buf.length, ctx.user.id, now());
      const fid = Number(res.lastInsertRowid);
      mkdirSync(dir(), { recursive: true });
      writeFileSync(join(dir(), `${fid}.${ext}`), buf);
      audit(ctx, { action: 'extrafile.uploaded', module: 'extrafiles', targetType: type, targetId: id, targetLabel: `${label} · ${name}` });
      ctx.status = 201;
      return { file: dto(get('SELECT * FROM extra_files WHERE id = ?', fid), ctx.user.id) };
    });

    const loadFile = (ctx) => {
      const f = get('SELECT * FROM extra_files WHERE id = ?', Number(ctx.params.fid));
      if (!f) throw notFound('Datei nicht gefunden.');
      return f;
    };
    r.get('/api/extra-file/:fid', (ctx) => {
      const f = loadFile(ctx);
      if (!mayView(ctx, f.owner_type, f.owner_id)) throw deny(f.owner_type);
      if (!existsSync(fileOf(f))) throw notFound('Datei nicht gefunden.');
      ctx.raw = { contentType: DOC_MIME[f.ext], body: readFileSync(fileOf(f)), inline: true, cache: 'no-store' };
    });
    r.patch('/api/extra-file/:fid', (ctx) => {
      const f = loadFile(ctx);
      if (!mayEdit(ctx, f.owner_type)) throw deny(f.owner_type);
      const name = ctx.body.name !== undefined ? str(ctx.body.name, 'Name', { min: 2, max: 80 }) : f.name;
      const description = ctx.body.description !== undefined ? (str(ctx.body.description, 'Beschreibung', { max: 300, required: false }) ?? '') : f.description;
      run('UPDATE extra_files SET name = ?, description = ? WHERE id = ?', name, description, f.id);
      audit(ctx, { action: 'extrafile.updated', module: 'extrafiles', targetType: f.owner_type, targetId: f.owner_id, targetLabel: name });
      return { file: dto(get('SELECT * FROM extra_files WHERE id = ?', f.id), ctx.user.id) };
    });
    r.delete('/api/extra-file/:fid', (ctx) => {
      const f = loadFile(ctx);
      if (!mayEdit(ctx, f.owner_type)) throw deny(f.owner_type);
      purgeFile(f);
      audit(ctx, { action: 'extrafile.removed', module: 'extrafiles', targetType: f.owner_type, targetId: f.owner_id, targetLabel: f.name });
      return { ok: true };
    });
  },
};

function purgeFile(f) { try { unlinkSync(fileOf(f)); } catch { /* egal */ } run('DELETE FROM extra_files WHERE id = ?', f.id); }
