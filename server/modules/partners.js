import { all, get, run, tx, now } from '../core/db.js';
import { HttpError, bad, conflict, forbidden, notFound, str, strList } from '../core/http.js';
import { hashPassword, verifyPassword, rateLimit } from '../core/auth.js';
import { getConfig } from '../core/config.js';
import { audit } from '../core/audit.js';
import {
  PARTNER_COOKIE, newLinkToken, randomCode, CODE_RE, createPartnerSession, destroyPartnerSession, destroyPartnerSessions,
} from '../core/partner-auth.js';
import { partnerApps, isPartnerApp } from '../core/partner-apps.js';
import { setupRequired } from './system.js';
import { allocateNumber } from '../core/numbers.js';
import { decodeDocument, DOC_MIME } from '../core/images.js';
import { purgePartner } from '../core/purge.js';
import { levelBrief } from '../core/levels.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DB_PATH } from '../core/db.js';

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const parseApps = (p) => { try { return JSON.parse(p.apps).filter(isPartnerApp); } catch { return []; } };
const linkPath = (token) => `/p/${token}`;
const dto = (p, { withLink }) => ({
  id: p.id, number: p.partner_number, name: p.name, note: p.note, status: p.status, apps: parseApps(p),
  lastLoginAt: p.last_login_at, createdAt: p.created_at,
  type: typeOf(p), typeLabel: TYPES[typeOf(p)], contactName: p.contact_name, firstName: p.first_name, lastName: p.last_name, birthDate: p.birth_date, postalCode: p.postal_code, street: p.street,
  umail: p.umail_local ? `${p.umail_local}@umail.com` : '', umailLocal: p.umail_local, phone: p.phone, accountNumber: p.account_number, 
  level: levelBrief(p.id), levelEnabled: !!p.level_enabled, itemsMode: p.items_mode, allowOther: !!p.allow_other, itemIds: p.items_mode === 'selected' ? all('SELECT item_id FROM partner_items WHERE partner_id = ?', p.id).map((x) => x.item_id) : [],
  docs: { id: !!p.id_doc_ext, license: !!p.license_doc_ext, weapon: !!p.weapon_doc_ext, clearance: !!p.clearance_doc_ext },
  locked: !!(p.locked_until && p.locked_until > now()), lockedUntil: p.locked_until && p.locked_until > now() ? p.locked_until : null,
  dealCount: p.deal_count ?? 0,
  linkPath: withLink ? linkPath(p.link_token) : undefined,
});
/** Format-Regeln für die Stammdaten externer Zugänge */
const docDir = () => join(dirname(DB_PATH), 'partner-docs');
const docFile = (id, kind, ext) => join(docDir(), `${id}-${kind}.${ext}`);
/** Art des Zugangs: Lieferant (liefert uns Ware, alle Personendaten + Dokumente) oder Ankäufer (kauft von uns, nur Name/Ansprechpartner). In der Datenbank steht „customer“ für Ankäufer. */
const TYPES = { buyer: 'Ankäufer', supplier: 'Lieferant' };
const typeOf = (p) => (p.partner_type === 'supplier' ? 'supplier' : 'buyer');
const formatPhone = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(v ?? '').trim(); };
const PROFILE_FIELDS = ['first_name', 'last_name', 'birth_date', 'postal_code', 'street', 'umail_local', 'phone', 'account_number'];

/** Prüft/normalisiert die Stammdaten; bei Lieferanten sind alle Felder (inkl. Ausweis) Pflicht. */
function profileFromBody(b, cur = {}) {
  const out = {};
  const pick = (k, bk) => (b[bk] !== undefined ? b[bk] : undefined);
  const set = (col, v) => { out[col] = v; };
  const v = (bk, col) => (b[bk] !== undefined ? b[bk] : cur[col]);
  if (b.firstName !== undefined) set('first_name', str(b.firstName, 'Vorname', { max: 40, required: false }));
  if (b.lastName !== undefined) set('last_name', str(b.lastName, 'Nachname', { max: 40, required: false }));
  if (b.birthDate !== undefined) {
    const d = b.birthDate === null || b.birthDate === '' ? null : String(b.birthDate);
    if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(new Date(d).getTime()) || d < '1900-01-01' || d > now().slice(0, 10))) throw bad('Geburtsdatum: gültiges Datum erforderlich (TT.MM.JJJJ).');
    set('birth_date', d);
  }
  if (b.postalCode !== undefined) { const p = String(b.postalCode ?? '').trim(); if (p && !/^[A-Za-z0-9 -]{1,12}$/.test(p)) throw bad('Postal Code: nur Buchstaben, Ziffern und Bindestrich.'); set('postal_code', p); }
  if (b.street !== undefined) set('street', str(b.street, 'Straße', { max: 80, required: false }));
  if (b.umail !== undefined) {
    const l = String(b.umail ?? '').trim().toLowerCase().replace(/@umail\.com$/, '');
    if (l && !/^[a-z0-9._-]{2,40}$/.test(l)) throw bad('UMail: nur Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich (die Endung @umail.com ist fest).');
    set('umail_local', l);
  }
  if (b.phone !== undefined) { const ph = formatPhone(b.phone); if (ph && !/^\(\d{3}\) \d{3}-\d{4}$/.test(ph)) throw bad('Telefonnummer: Format (555) 123-4567.'); set('phone', ph); }
  if (b.accountNumber !== undefined) { const a = String(b.accountNumber ?? '').trim().toUpperCase(); if (a && !/^[A-Z0-9-]{3,20}$/.test(a)) throw bad('Kontonummer: 3–20 Zeichen (Buchstaben/Ziffern), z. B. LS28180705.'); set('account_number', a); }
  if (b.type !== undefined) { const t = b.type === 'customer' ? 'buyer' : b.type; if (!TYPES[t]) throw bad('Art: Lieferant oder Ankäufer.'); set('partner_type', t === 'supplier' ? 'supplier' : 'customer'); }
  if (b.contactName !== undefined) set('contact_name', str(b.contactName, 'Ansprechpartner', { max: 80, required: false }));
  void pick; void v;
  return out;
}
function requireComplete(merged, has, strictBuyer = true) {
  const miss = [];
  if (merged.partner_type === 'supplier') {
    for (const [col, label] of [['first_name', 'Vorname'], ['last_name', 'Nachname'], ['street', 'Straße'], ['postal_code', 'Postal Code'], ['phone', 'Telefonnummer'], ['umail_local', 'UMail'], ['account_number', 'Kontonummer']]) if (!merged[col]) miss.push(label);
    void has; // Dokumente (Ausweis, Führerschein, Waffenschein, Führungszeugnis) sind optional: nicht jeder Lieferant kann sie vorlegen
    if (miss.length) throw bad(`Bei Lieferanten sind folgende Angaben Pflicht: ${miss.join(', ')}.`);
  } else if (strictBuyer && !merged.contact_name) throw bad('Bei Ankäufern ist der Ansprechpartner Pflicht (zusätzlich zum Namen bzw. der Bezeichnung).');
}
/** Börsen-Freigabe eines Zugangs: Artikel-Modus (alle freigegebenen / nur ausgewählte), Auswahl und „Sonstiges“ (Freitext-Artikel). */
function marketAccessFrom(b) {
  if (b.itemsMode === undefined && b.itemIds === undefined && b.allowOther === undefined) return null;
  if (b.itemsMode !== undefined && !['all', 'selected'].includes(b.itemsMode)) throw bad('Artikel-Freigabe: alle oder ausgewählte.');
  if (b.itemIds !== undefined && (!Array.isArray(b.itemIds) || !b.itemIds.every((i) => Number.isInteger(i) && get('SELECT 1 x FROM market_items WHERE id = ? AND is_other = 0', i)))) throw bad('Unbekannter Artikel in der Auswahl.');
  return { mode: b.itemsMode, ids: b.itemIds === undefined ? undefined : [...new Set(b.itemIds)], other: b.allowOther === undefined ? undefined : !!b.allowOther };
}
function applyMarketAccess(id, a) {
  if (a.mode !== undefined) run('UPDATE partners SET items_mode = ? WHERE id = ?', a.mode, id);
  if (a.other !== undefined) run('UPDATE partners SET allow_other = ? WHERE id = ?', a.other ? 1 : 0, id);
  if (a.ids !== undefined) { run('DELETE FROM partner_items WHERE partner_id = ?', id); for (const i of a.ids) run('INSERT INTO partner_items (partner_id,item_id) VALUES (?,?)', id, i); }
}
function saveDoc(id, kind, data) {
  const { buf, ext } = decodeDocument(data, 6 * 1024 * 1024, bad);
  mkdirSync(docDir(), { recursive: true });
  for (const e of ['pdf', 'png', 'jpg', 'webp']) if (e !== ext) try { unlinkSync(docFile(id, kind, e)); } catch { /* egal */ }
  writeFileSync(docFile(id, kind, ext), buf);
  return ext;
}

const DOC_KINDS = { id: 'id_doc_ext', license: 'license_doc_ext', weapon: 'weapon_doc_ext', clearance: 'clearance_doc_ext' };
const DOC_LABEL = { id: 'Ausweis', license: 'Führerschein', weapon: 'Waffenschein', clearance: 'Führungszeugnis' };
const LIST_SQL = 'SELECT p.*, (SELECT COUNT(*) FROM market_deals d WHERE d.partner_id = p.id) deal_count FROM partners p';
const cleanApps = (v) => {
  const apps = strList(v, 'Apps');
  for (const a of apps) if (!isPartnerApp(a)) throw bad(`Unbekannte App: ${a}`);
  return apps;
};
const sessionCookie = (ctx, token, expires) =>
  `${PARTNER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((new Date(expires) - Date.now()) / 1000))}${ctx.secure ? '; Secure' : ''}`;

export default {
  name: 'partners',
  permissions: [
    ['partners.view', 'Externe Zugänge ansehen'],
    ['partners.manage', 'Externe Zugänge erstellen, bearbeiten, Links und Codes verwalten'],
    ['partners.documents', 'Externe Zugänge: Ausweis/Waffenschein ansehen und hochladen'],
    ['partners.delete', 'Externe Zugänge samt aller Geschäfte, Kredite und Daten endgültig löschen'],
  ],
  config: [
    { key: 'coop.host', group: 'Externe Zugänge (neutral)', label: 'Eigene Subdomain für Externe', help: 'Unter diesem Hostnamen (z. B. coop.example.com) sehen Partner und Firmen nur ihren Zugang – ohne Logo, Panelname oder Firmenname und ohne Zugriff auf das eigentliche System. DNS-Eintrag und Proxy-Host müssen auf diesen Server zeigen. Die Links der Zugänge werden mit diesem Host angezeigt.', type: 'string', default: 'coop.example.com', max: 120, public: true, perm: 'partners.manage' },
    { key: 'coop.title', group: 'Externe Zugänge (neutral)', label: 'Neutraler Titel auf der Subdomain', help: 'Erscheint statt des Systemnamens (Browser-Tab, Anmeldung, Desktop).', type: 'string', default: 'Partnerportal', max: 40, perm: 'partners.manage' },
    { key: 'coop.mask', group: 'Externe Zugänge (neutral)', label: 'Auf der Subdomain ausblenden (kommagetrennt)', help: 'Diese Texte werden in der Oberfläche der Externen entfernt – Standard: das Nummernpräfix „MDT-“.', type: 'string', default: 'MDT-', max: 200, perm: 'partners.manage' },
    { key: 'partners.number_prefix', group: 'Zugang', label: 'Präfix der Partner-Nummer', help: 'Im Partner-Portal erscheint nur diese Nummer, nie der Name (z. B. MDT-P-100001).', type: 'string', default: 'MDT-P-', max: 12 },
    { key: 'partners.number_start', group: 'Zugang', label: 'Startnummer der Partner', type: 'number', default: 100001, min: 1, max: 99999999 },
    { key: 'partners.session_hours', group: 'Zugang', label: 'Sitzungsdauer externer Zugänge (Stunden)', type: 'number', default: 24, min: 1, max: 720 },
  ],
  init() {
    for (const r of all('SELECT id FROM partners WHERE partner_number IS NULL ORDER BY id')) {
      tx(() => run('UPDATE partners SET partner_number = ? WHERE id = ?', allocateNumber('partner_number', 'partners.number_prefix', 'partners.number_start'), r.id));
    }
  },
  routes(r) {
    // ── Verwaltung (Mitarbeiter) ──
    r.get('/api/partners', { perm: 'partners.view' }, (ctx) => {
      const canLink = ctx.user.perms.has('partners.manage');
      return { partners: all(`${LIST_SQL} WHERE p.user_id IS NULL ORDER BY p.created_at DESC`).map((p) => dto(p, { withLink: canLink })), apps: partnerApps(), items: all('SELECT id, name, unit FROM market_items WHERE is_other = 0 AND is_active = 1 ORDER BY name').map((i) => ({ id: i.id, name: i.name, unit: i.unit })) };
    });

    r.post('/api/partners', { perm: 'partners.manage', bodyLimit: 14 * 1024 * 1024 }, (ctx) => {
      const b = ctx.body;
      const prof = profileFromBody(b);
      const supplier = prof.partner_type === 'supplier';
      const name = supplier ? ([prof.first_name, prof.last_name].filter(Boolean).join(' ') || str(b.name, 'Name', { min: 2, max: 60 })) : str(b.name, 'Name oder Bezeichnung', { min: 2, max: 60 });
      const merged = { partner_type: 'customer', ...prof };
      const docBodies = { id: b.idDoc, license: b.licenseDoc, weapon: b.weaponDoc, clearance: b.clearanceDoc };
      if (Object.values(docBodies).some(Boolean) && !ctx.user.perms.has('partners.documents')) throw forbidden('Für Dokument-Uploads fehlt dir das Recht „partners.documents“.');
      requireComplete(merged, Object.fromEntries(Object.entries(docBodies).map(([k, v]) => [k, !!v])), prof.partner_type !== undefined); // ohne ausdrückliche Art gilt „Ankäufer“ (Altbestand/API)
      const note = str(b.note, 'Notiz', { max: 300, required: false });
      const apps = cleanApps(b.apps);
      const marketAccess = marketAccessFrom(b);
      let code = randomCode();
      if (b.code) {
        if (typeof b.code !== 'string' || !CODE_RE.test(b.code)) throw bad('Der Code muss aus 6–12 Buchstaben oder Ziffern bestehen.');
        code = b.code;
      }
      const t = now();
      const token = newLinkToken();
      const id = tx(() => {
        const res = run('INSERT INTO partners (partner_number,name,note,link_token,code_hash,status,apps,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          allocateNumber('partner_number', 'partners.number_prefix', 'partners.number_start'), name, note, token, hashPassword(code), 'active', JSON.stringify(apps), ctx.user.id, t, t);
        const pid = Number(res.lastInsertRowid);
        const cols = Object.keys(prof);
        if (cols.length) run(`UPDATE partners SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => prof[c]), pid);
        for (const [k, v] of Object.entries(docBodies)) if (v) run(`UPDATE partners SET ${DOC_KINDS[k]} = ? WHERE id = ?`, saveDoc(pid, k, v), pid);
        if (marketAccess) applyMarketAccess(pid, marketAccess);
        if (b.levelEnabled) run('UPDATE partners SET level_enabled = 1, level_since = ? WHERE id = ?', now(), pid);
        return pid;
      });
      audit(ctx, { action: 'partner.created', module: 'partners', targetType: 'partner', targetId: id, targetLabel: name, after: { name, apps } });
      ctx.status = 201;
      return { partner: dto(get(`${LIST_SQL} WHERE p.id = ?`, id), { withLink: true }), code }; // Code wird nur hier einmal angezeigt
    });

    r.patch('/api/partners/:id', { perm: 'partners.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get(`${LIST_SQL} WHERE p.id = ?`, id);
      if (!cur) throw notFound('Zugang nicht gefunden.');
      const b = ctx.body;
      const before = dto(cur, { withLink: false });
      const prof = profileFromBody(b, cur);
      requireComplete({ ...cur, ...prof }, { id: !!cur.id_doc_ext, license: !!cur.license_doc_ext, weapon: !!cur.weapon_doc_ext }, prof.partner_type !== undefined || prof.contact_name !== undefined);
      tx(() => {
        const pc = Object.keys(prof);
        if (pc.length) run(`UPDATE partners SET ${pc.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...pc.map((c) => prof[c]), id);
        if (prof.first_name !== undefined || prof.last_name !== undefined) { const f = prof.first_name ?? cur.first_name, l = prof.last_name ?? cur.last_name; if (f || l) run('UPDATE partners SET name = ? WHERE id = ?', [f, l].filter(Boolean).join(' '), id); }
        if (b.name !== undefined) run('UPDATE partners SET name = ? WHERE id = ?', str(b.name, 'Name', { min: 2, max: 60 }), id);
        if (b.note !== undefined) run('UPDATE partners SET note = ? WHERE id = ?', str(b.note, 'Notiz', { max: 300, required: false }), id);
        if (b.apps !== undefined) run('UPDATE partners SET apps = ? WHERE id = ?', JSON.stringify(cleanApps(b.apps)), id);
        const ma = marketAccessFrom(b); if (ma) applyMarketAccess(id, ma);
        if (b.levelEnabled !== undefined) { const on = b.levelEnabled ? 1 : 0; if (on !== cur.level_enabled) run('UPDATE partners SET level_enabled = ?, level_since = CASE WHEN ? = 1 THEN ? ELSE level_since END WHERE id = ?', on, on, now(), id); }
        if (b.status !== undefined) {
          if (!['active', 'disabled'].includes(b.status)) throw bad('Ungültiger Status.');
          run('UPDATE partners SET status = ? WHERE id = ?', b.status, id);
          if (b.status === 'disabled') destroyPartnerSessions(id); // Link deaktiviert ⇒ sofort abgemeldet
        }
        run('UPDATE partners SET updated_at = ? WHERE id = ?', now(), id);
      });
      const after = dto(get(`${LIST_SQL} WHERE p.id = ?`, id), { withLink: true });
      const action = b.status === 'disabled' ? 'partner.disabled' : b.status === 'active' && before.status === 'disabled' ? 'partner.enabled' : 'partner.updated';
      audit(ctx, { action, module: 'partners', targetType: 'partner', targetId: id, targetLabel: after.name, before, after: { ...after, linkPath: undefined } });
      return { partner: after };
    });

    // Neuer Zugangscode (zufällig oder festgelegt) – beendet bestehende Sitzungen, hebt eine Sperre auf
    r.post('/api/partners/:id/code', { perm: 'partners.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get('SELECT name FROM partners WHERE id = ?', id);
      if (!cur) throw notFound('Zugang nicht gefunden.');
      let code = randomCode();
      if (ctx.body.code) {
        if (typeof ctx.body.code !== 'string' || !CODE_RE.test(ctx.body.code)) throw bad('Der Code muss aus 6–12 Buchstaben oder Ziffern bestehen.');
        code = ctx.body.code;
      }
      run('UPDATE partners SET code_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hashPassword(code), now(), id);
      destroyPartnerSessions(id);
      audit(ctx, { action: 'partner.code_reset', module: 'partners', targetType: 'partner', targetId: id, targetLabel: cur.name });
      return { code };
    });

    // Neuer Link (alter Link wird ungültig)
    r.post('/api/partners/:id/link', { perm: 'partners.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get('SELECT name FROM partners WHERE id = ?', id);
      if (!cur) throw notFound('Zugang nicht gefunden.');
      const token = newLinkToken();
      run('UPDATE partners SET link_token = ?, updated_at = ? WHERE id = ?', token, now(), id);
      destroyPartnerSessions(id);
      audit(ctx, { action: 'partner.link_regenerated', module: 'partners', targetType: 'partner', targetId: id, targetLabel: cur.name });
      return { linkPath: linkPath(token) };
    });

    // Dokumente (Ausweis / Waffenschein)
    r.post('/api/partners/:id/docs/:kind', { perm: 'partners.documents', bodyLimit: 8 * 1024 * 1024 }, (ctx) => {
      const id = Number(ctx.params.id), col = DOC_KINDS[ctx.params.kind];
      if (!col) throw notFound('Unbekanntes Dokument.');
      const cur = get('SELECT name FROM partners WHERE id = ?', id);
      if (!cur) throw notFound('Zugang nicht gefunden.');
      run(`UPDATE partners SET ${col} = ?, updated_at = ? WHERE id = ?`, saveDoc(id, ctx.params.kind, ctx.body.data), now(), id);
      audit(ctx, { action: 'partner.document_uploaded', module: 'partners', targetType: 'partner', targetId: id, targetLabel: `${cur.name} · ${DOC_LABEL[ctx.params.kind]}` });
      return { partner: dto(get(`${LIST_SQL} WHERE p.id = ?`, id), { withLink: true }) };
    });
    r.get('/api/partners/:id/docs/:kind', { perm: 'partners.documents' }, (ctx) => {
      const id = Number(ctx.params.id), col = DOC_KINDS[ctx.params.kind];
      const p = col && get(`SELECT ${col} e FROM partners WHERE id = ?`, id);
      const file = p?.e && docFile(id, ctx.params.kind, p.e);
      if (!file || !existsSync(file)) throw notFound('Dokument nicht vorhanden.');
      ctx.raw = { contentType: DOC_MIME[p.e], body: readFileSync(file), inline: true, cache: 'no-store' };
    });

    r.delete('/api/partners/:id', { perm: ['partners.manage', 'partners.delete'] }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get(`${LIST_SQL} WHERE p.id = ?`, id);
      if (!cur) throw notFound('Zugang nicht gefunden.');
      const loans = get('SELECT COUNT(*) c FROM credit_loans WHERE partner_id = ?', id).c;
      if (cur.deal_count > 0 || loans > 0) {
        const parts = [cur.deal_count > 0 && `${cur.deal_count} Börsen-Geschäft(e)`, loans > 0 && `${loans} Kredit(e)`].filter(Boolean).join(' und ');
        if (ctx.query.force !== '1') throw conflict(`Zu diesem Zugang gibt es ${parts}. Deaktiviere ihn, damit der Verlauf erhalten bleibt – oder lösche ihn samt aller Daten (nur mit dem Recht „partners.delete“).`);
        if (!ctx.user.perms.has('partners.delete')) throw forbidden('Zum Löschen samt aller Daten fehlt dir das Recht „partners.delete“.');
      } else if (!ctx.user.perms.has('partners.manage') && !ctx.user.perms.has('partners.delete')) {
        throw forbidden();
      }
      tx(() => purgePartner(id));
      audit(ctx, { action: 'partner.deleted', module: 'partners', targetType: 'partner', targetId: id, targetLabel: cur.name, before: { deals: cur.deal_count, loans } });
      return { ok: true };
    });

    // ── Partner-Zugang über Link + Code (öffentlich) ──
    const byToken = (token) => get('SELECT * FROM partners WHERE link_token = ?', token);
    const invalid = () => new HttpError(404, 'Dieser Link ist ungültig oder wurde deaktiviert.', 'link_invalid');

    r.get('/api/p/:token/session', { auth: false }, (ctx) => {
      const p = byToken(ctx.params.token);
      if (!p || p.status !== 'active') throw invalid();
      const mine = ctx.partner && ctx.partner.id === p.id;
      return { valid: true, authenticated: !!mine, partner: mine ? { number: p.partner_number, apps: parseApps(p), level: levelBrief(p.id) } : null };
    });

    r.post('/api/p/:token/login', { auth: false }, (ctx) => {
      if (setupRequired()) throw invalid();
      const p = byToken(ctx.params.token);
      if (!p || p.status !== 'active') throw invalid();
      if (!rateLimit(`pl|${ctx.ip}`, 20, 10 * 60_000)) throw new HttpError(429, 'Zu viele Versuche. Bitte warte einige Minuten.', 'rate_limited');
      if (p.locked_until && p.locked_until > now()) throw new HttpError(429, `Zu viele Fehlversuche. Der Zugang ist bis ${new Date(p.locked_until).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr gesperrt.`, 'locked');
      const code = typeof ctx.body.code === 'string' ? ctx.body.code.trim() : '';
      if (!code || !verifyPassword(code, p.code_hash)) {
        const attempts = (p.locked_until && p.locked_until <= now() ? 0 : p.failed_attempts) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          run('UPDATE partners SET failed_attempts = 0, locked_until = ? WHERE id = ?', new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString(), p.id);
          audit(ctx, { action: 'partner.locked', module: 'partners', targetType: 'partner', targetId: p.id, targetLabel: p.name });
        } else run('UPDATE partners SET failed_attempts = ? WHERE id = ?', attempts, p.id);
        audit(ctx, { action: 'partner.login_failed', module: 'partners', targetType: 'partner', targetId: p.id, targetLabel: p.name });
        throw new HttpError(401, attempts >= MAX_ATTEMPTS ? `Zu viele Fehlversuche. Der Zugang ist für ${LOCK_MINUTES} Minuten gesperrt.` : 'Der Code ist nicht korrekt.', 'invalid_code');
      }
      run('UPDATE partners SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now(), p.id);
      const s = createPartnerSession(p.id, { ip: ctx.ip, ua: ctx.req.headers['user-agent'], hours: getConfig('partners.session_hours') });
      ctx.headers['Set-Cookie'] = sessionCookie(ctx, s.token, s.expires);
      audit({ ip: ctx.ip, actorName: `Partner: ${p.name}` }, { action: 'partner.login', module: 'partners', targetType: 'partner', targetId: p.id, targetLabel: p.name });
      return { partner: { number: p.partner_number, apps: parseApps(p), level: levelBrief(p.id) } };
    });

    r.post('/api/p/logout', { auth: false }, (ctx) => {
      if (ctx.partnerToken) destroyPartnerSession(ctx.partnerToken);
      ctx.headers['Set-Cookie'] = `${PARTNER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
      return { ok: true };
    });

    // Sperrbildschirm im Partner-Portal: Zugangscode erneut bestätigen
    r.post('/api/p/unlock', { auth: 'partner' }, (ctx) => {
      if (!rateLimit(`punlock|${ctx.partner.id}`, 8, 10 * 60_000)) throw new HttpError(429, 'Zu viele Versuche. Bitte warte einige Minuten.', 'rate_limited');
      const p = get('SELECT code_hash FROM partners WHERE id = ?', ctx.partner.id);
      const code = typeof ctx.body.code === 'string' ? ctx.body.code.trim() : '';
      if (!code || !verifyPassword(code, p.code_hash)) throw new HttpError(401, 'Der Code ist nicht korrekt.', 'invalid_code');
      return { ok: true };
    });

    r.get('/api/p/me', { auth: 'partner' }, (ctx) => ({
      partner: { number: ctx.partner.number, apps: [...ctx.partner.apps].filter(isPartnerApp), level: levelBrief(ctx.partner.id) },
      apps: partnerApps().filter((a) => ctx.partner.apps.has(a.id)),
    }));
  },
};
