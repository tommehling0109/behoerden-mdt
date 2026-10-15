import { get, run, now, DB_PATH } from '../core/db.js';
import { bad, notFound, forbidden } from '../core/http.js';
import { audit } from '../core/audit.js';
import { decodeDocument, DOC_MIME } from '../core/images.js';
import { personalFields, USER_DOCS } from '../core/personal.js';
import { memberLabel } from '../core/identity.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Personalakte: persönliche Angaben und Dokumente (Ausweis, Führerschein, Waffenschein, Führungszeugnis) der Mitglieder.
 * Sichtbar nur für das Mitglied selbst und für Berechtigte (users.personnel_view); ändern/hochladen mit users.personnel_edit.
 * Die Angaben tauchen nirgends sonst auf – die Anonymität (nur Personalnummer) bleibt bestehen.
 */
const docDir = () => join(dirname(DB_PATH), 'user-docs');
const docFile = (id, kind, ext) => join(docDir(), `${id}-${kind}.${ext}`);
export const userDocFiles = (id) => Object.keys(USER_DOCS).flatMap((k) => ['pdf', 'png', 'jpg', 'webp'].map((e) => docFile(id, k, e)));

const dto = (u) => ({
  id: u.id, firstName: u.first_name, lastName: u.last_name, street: u.street, postalCode: u.postal_code, phone: u.phone,
  umail: u.umail_local ? `${u.umail_local}@umail.com` : '', umailLocal: u.umail_local, accountNumber: u.account_number,
  docs: Object.fromEntries(Object.entries(USER_DOCS).map(([k, [col]]) => [k, !!u[col]])),
});
const mayView = (ctx, id) => ctx.user.id === id || ctx.user.perms.has('users.personnel_view');

export default {
  name: 'personnel',
  permissions: [
    ['users.personnel_view', 'Personalakte ansehen (persönliche Angaben und Dokumente der Mitglieder)'],
    ['users.personnel_edit', 'Personalakte bearbeiten (Angaben ändern, Dokumente hochladen)'],
  ],
  routes(r) {
    r.get('/api/users/:id/personnel', (ctx) => {
      const id = Number(ctx.params.id);
      if (!mayView(ctx, id)) throw forbidden('Für die Personalakte fehlt dir das Recht „users.personnel_view“.');
      const u = get('SELECT * FROM users WHERE id = ?', id);
      if (!u) throw notFound('Benutzer nicht gefunden.');
      return { personnel: dto(u), canEdit: ctx.user.perms.has('users.personnel_edit') };
    });
    r.put('/api/users/:id/personnel', { perm: 'users.personnel_edit' }, (ctx) => {
      const id = Number(ctx.params.id);
      const u = get('SELECT * FROM users WHERE id = ?', id);
      if (!u) throw notFound('Benutzer nicht gefunden.');
      const f = personalFields(ctx.body);
      const cols = Object.keys(f);
      if (cols.length) run(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => f[c]), now(), id);
      audit(ctx, { action: 'user.personnel_updated', module: 'users', targetType: 'user', targetId: id, targetLabel: memberLabel(u), after: { fields: cols } }); // bewusst ohne Werte
      return { personnel: dto(get('SELECT * FROM users WHERE id = ?', id)) };
    });
    r.post('/api/users/:id/docs/:kind', { perm: 'users.personnel_edit', bodyLimit: 8 * 1024 * 1024 }, (ctx) => {
      const id = Number(ctx.params.id), def = USER_DOCS[ctx.params.kind];
      if (!def) throw notFound('Unbekanntes Dokument.');
      const u = get('SELECT * FROM users WHERE id = ?', id);
      if (!u) throw notFound('Benutzer nicht gefunden.');
      const { buf, ext } = decodeDocument(ctx.body.data, 5 * 1024 * 1024, bad);
      mkdirSync(docDir(), { recursive: true });
      for (const e of ['pdf', 'png', 'jpg', 'webp']) if (e !== ext) try { unlinkSync(docFile(id, ctx.params.kind, e)); } catch { /* egal */ }
      writeFileSync(docFile(id, ctx.params.kind, ext), buf);
      run(`UPDATE users SET ${def[0]} = ?, updated_at = ? WHERE id = ?`, ext, now(), id);
      audit(ctx, { action: 'user.document_uploaded', module: 'users', targetType: 'user', targetId: id, targetLabel: `${memberLabel(u)} · ${def[1]}` });
      return { personnel: dto(get('SELECT * FROM users WHERE id = ?', id)) };
    });
    r.get('/api/users/:id/docs/:kind', (ctx) => {
      const id = Number(ctx.params.id), def = USER_DOCS[ctx.params.kind];
      if (!def) throw notFound('Unbekanntes Dokument.');
      if (!mayView(ctx, id)) throw forbidden('Für die Personalakte fehlt dir das Recht „users.personnel_view“.');
      const u = get(`SELECT ${def[0]} e FROM users WHERE id = ?`, id);
      const file = u?.e && docFile(id, ctx.params.kind, u.e);
      if (!file || !existsSync(file)) throw notFound('Dokument nicht vorhanden.');
      ctx.raw = { contentType: DOC_MIME[u.e], body: readFileSync(file), inline: true, cache: 'no-store' };
    });
    r.delete('/api/users/:id/docs/:kind', { perm: 'users.personnel_edit' }, (ctx) => {
      const id = Number(ctx.params.id), def = USER_DOCS[ctx.params.kind];
      if (!def) throw notFound('Unbekanntes Dokument.');
      const u = get('SELECT * FROM users WHERE id = ?', id);
      if (!u) throw notFound('Benutzer nicht gefunden.');
      for (const e of ['pdf', 'png', 'jpg', 'webp']) try { unlinkSync(docFile(id, ctx.params.kind, e)); } catch { /* egal */ }
      run(`UPDATE users SET ${def[0]} = NULL, updated_at = ? WHERE id = ?`, now(), id);
      audit(ctx, { action: 'user.document_removed', module: 'users', targetType: 'user', targetId: id, targetLabel: `${memberLabel(u)} · ${def[1]}` });
      return { personnel: dto(get('SELECT * FROM users WHERE id = ?', id)) };
    });
  },
};
