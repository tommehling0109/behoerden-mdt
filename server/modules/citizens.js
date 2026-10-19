import { all, get, run, tx, now } from '../core/db.js';
import { bad, conflict, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { allocateNumber } from '../core/numbers.js';
import { labelForUser } from '../core/identity.js';
import { casesOfCitizen, casesOfPlate, CASE_TYPES, CASE_STATUSES } from '../core/case-access.js';

/**
 * Bürgerregister (Staatsdatenbank): alle registrierten Einwohner mit Stammdaten, Kontaktdaten, Fahrzeugen, Lizenzen und verlinkten Akten.
 * Das Register ist behördenübergreifend – wer das Recht „citizens.view“ hat, sieht alle Einträge. Verlinkte Akten erscheinen nur,
 * wenn der Betrachter sie nach den Akten-Regeln (Behörde, Freigabe, Vertraulichkeit) auch sehen darf.
 */
const STATUS = { active: 'Gemeldet', deceased: 'Verstorben', missing: 'Vermisst' };
const GENDERS = { '': 'Keine Angabe', m: 'Männlich', f: 'Weiblich', d: 'Divers' };
const VEHICLE_STATUS = { registered: ['Zugelassen', '#10b981'], stolen: ['Gestohlen gemeldet', '#ef4444'], impounded: ['Sichergestellt', '#f59e0b'], deregistered: ['Abgemeldet', '#94a3b8'] };
const LICENSE_STATUS = { valid: ['Gültig', '#10b981'], suspended: ['Gesperrt', '#f59e0b'], revoked: ['Entzogen', '#ef4444'], expired: ['Abgelaufen', '#94a3b8'] };
const LICENSE_KINDS = ['Führerschein Klasse B', 'Führerschein Klasse A (Motorrad)', 'Führerschein Klasse C (LKW)', 'Bootsführerschein', 'Flugschein', 'Waffenschein', 'Jagdschein', 'Gewerbeschein'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLATE_RE = /^[\p{L}\p{N} .-]{2,12}$/u;

const date = (v, label, { required = false } = {}) => {
  if (v == null || v === '') { if (required) throw bad(`${label}: Datum erforderlich.`); return null; }
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${label}: ungültiges Datum (JJJJ-MM-TT).`);
  return v;
};
const txt = (b, k, label, max, out, col = k) => { if (b[k] !== undefined) out[col] = str(b[k], label, { max, required: false }); };

function fields(b, partial) {
  const o = {};
  if (!partial || b.lastName !== undefined) o.last_name = str(b.lastName, 'Nachname', { min: 1, max: 60 });
  if (!partial || b.firstName !== undefined) o.first_name = str(b.firstName, 'Vorname', { min: 1, max: 60 });
  if (b.birthDate !== undefined) o.birth_date = date(b.birthDate, 'Geburtsdatum');
  txt(b, 'birthPlace', 'Geburtsort', 80, o, 'birth_place'); txt(b, 'nationality', 'Nationalität', 60, o); txt(b, 'phone', 'Telefonnummer', 30, o);
  txt(b, 'email', 'E-Mail', 120, o); txt(b, 'street', 'Straße', 100, o); txt(b, 'postal', 'Postleitzahl', 12, o); txt(b, 'city', 'Ort', 80, o);
  txt(b, 'occupation', 'Beruf', 80, o); txt(b, 'notes', 'Notizen', 2000, o);
  if (b.gender !== undefined) { if (!Object.hasOwn(GENDERS, b.gender)) throw bad('Geschlecht: ungültiger Wert.'); o.gender = b.gender; }
  if (b.status !== undefined) { if (!Object.hasOwn(STATUS, b.status)) throw bad('Status: ungültiger Wert.'); o.status = b.status; }
  if (b.heightCm !== undefined) { if (b.heightCm === null || b.heightCm === '') o.height_cm = null; else if (!Number.isInteger(b.heightCm) || b.heightCm < 40 || b.heightCm > 260) throw bad('Größe: 40–260 cm.'); else o.height_cm = b.heightCm; }
  if (o.email && !/^[^\s@]+@[^\s@]+$/.test(o.email)) throw bad('E-Mail: ungültige Adresse.');
  return o;
}

const brief = (c, vehicles = []) => ({
  id: c.id, number: c.citizen_number, lastName: c.last_name, firstName: c.first_name, name: `${c.first_name} ${c.last_name}`.trim(), birthDate: c.birth_date, phone: c.phone, email: c.email,
  address: [c.street, [c.postal, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', '), status: c.status, statusLabel: STATUS[c.status], isWanted: !!c.is_wanted, plates: vehicles,
});
const vehicleDto = (v) => ({ id: v.id, plate: v.plate, makeModel: v.make_model, color: v.color, vin: v.vin, status: v.status, statusLabel: VEHICLE_STATUS[v.status][0], statusColor: VEHICLE_STATUS[v.status][1], notes: v.notes, registeredAt: v.registered_at });
const licenseDto = (l) => ({ id: l.id, kind: l.kind, status: l.status, statusLabel: LICENSE_STATUS[l.status][0], statusColor: LICENSE_STATUS[l.status][1], issuedAt: l.issued_at, validUntil: l.valid_until, note: l.note });
const caseBrief = (c) => ({ id: c.id, number: c.case_number, type: c.type_key, typeLabel: CASE_TYPES[c.type_key]?.label ?? c.type_key, typeColor: CASE_TYPES[c.type_key]?.color, title: c.title, status: c.status, statusLabel: CASE_STATUSES[c.status]?.label ?? c.status, incidentAt: c.incident_at, role: c.role });

function detail(c, user) {
  const vehicles = all('SELECT * FROM citizen_vehicles WHERE citizen_id = ? ORDER BY plate', c.id).map((v) => ({ ...vehicleDto(v), cases: casesOfPlate(user, v.plate).map(caseBrief) }));
  return {
    ...brief(c), birthPlace: c.birth_place, gender: c.gender, genderLabel: GENDERS[c.gender], nationality: c.nationality, street: c.street, postal: c.postal, city: c.city, occupation: c.occupation, heightCm: c.height_cm,
    notes: c.notes, wantedReason: c.wanted_reason, wantedAt: c.wanted_at, wantedBy: c.wanted_by ? labelForUser(c.wanted_by, user.id) : null,
    createdAt: c.created_at, updatedAt: c.updated_at, createdBy: c.created_by ? labelForUser(c.created_by, user.id) : null,
    vehicles, licenses: all('SELECT * FROM citizen_licenses WHERE citizen_id = ? ORDER BY kind', c.id).map(licenseDto),
    cases: casesOfCitizen(user, c.id).map(caseBrief),
  };
}
const load = (id) => { const c = get('SELECT * FROM citizens WHERE id = ?', Number(id)); if (!c) throw notFound('Bürger nicht gefunden.'); return c; };
const label = (c) => `${c.citizen_number ?? ''} · ${c.first_name} ${c.last_name}`.trim().replace(/^· /, '');

export default {
  name: 'citizens',
  permissions: [
    ['citizens.view', 'Bürgerregister: Einwohner, Fahrzeuge und Lizenzen ansehen'],
    ['citizens.create', 'Bürgerregister: Einwohner anlegen'],
    ['citizens.edit', 'Bürgerregister: Einwohner bearbeiten'],
    ['citizens.delete', 'Bürgerregister: Einwohner löschen'],
    ['citizens.vehicles', 'Bürgerregister: Fahrzeuge zulassen, ändern und abmelden'],
    ['citizens.licenses', 'Bürgerregister: Führerscheine und Lizenzen verwalten'],
    ['citizens.wanted', 'Bürgerregister: Personen zur Fahndung ausschreiben und Fahndung aufheben'],
  ],
  config: [
    { key: 'citizens.number_prefix', group: 'Bürgerregister', label: 'Präfix der Bürgernummer', type: 'string', default: 'SA-', max: 12 },
    { key: 'citizens.number_start', group: 'Bürgerregister', label: 'Startnummer der Bürgernummern', type: 'number', default: 100001, min: 1, max: 99999999 },
  ],
  routes(r) {
    r.get('/api/citizens/options', { perm: 'citizens.view' }, (ctx) => ({
      statuses: Object.entries(STATUS).map(([key, label]) => ({ key, label })), genders: Object.entries(GENDERS).map(([key, label]) => ({ key, label })),
      vehicleStatuses: Object.entries(VEHICLE_STATUS).map(([key, [label, color]]) => ({ key, label, color })), licenseStatuses: Object.entries(LICENSE_STATUS).map(([key, [label, color]]) => ({ key, label, color })),
      licenseKinds: LICENSE_KINDS, can: Object.fromEntries(['create', 'edit', 'delete', 'vehicles', 'licenses', 'wanted'].map((k) => [k, ctx.user.isAdmin || ctx.user.perms.has(`citizens.${k}`)])),
    }));

    r.get('/api/citizens', { perm: 'citizens.view' }, (ctx) => {
      const where = [], p = [], { q, wanted } = ctx.query;
      if (wanted === '1') where.push('c.is_wanted = 1');
      if (q) {
        const like = `%${String(q).trim().replace(/[%_]/g, '')}%`;
        where.push(`(c.last_name LIKE ? OR c.first_name LIKE ? OR (c.first_name || ' ' || c.last_name) LIKE ? OR (c.last_name || ' ' || c.first_name) LIKE ? OR c.citizen_number LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.birth_date LIKE ?
          OR EXISTS (SELECT 1 FROM citizen_vehicles v WHERE v.citizen_id = c.id AND v.plate LIKE ?))`);
        p.push(like, like, like, like, like, like, like, like, like);
      }
      const rows = all(`SELECT c.* FROM citizens c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.is_wanted DESC, c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE LIMIT 100`, ...p);
      const plates = (id) => all('SELECT plate FROM citizen_vehicles WHERE citizen_id = ? AND status != ? ORDER BY plate', id, 'deregistered').map((x) => x.plate);
      return { citizens: rows.map((c) => brief(c, plates(c.id))), total: get(`SELECT COUNT(*) n FROM citizens c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...p).n, wantedCount: get('SELECT COUNT(*) n FROM citizens WHERE is_wanted = 1').n };
    });

    r.get('/api/citizens/:id', { perm: 'citizens.view' }, (ctx) => ({ citizen: detail(load(ctx.params.id), ctx.user) }));

    // Kennzeichen-Abfrage: Halter, Fahrzeug und verlinkte Akten
    r.get('/api/citizens/plate/:plate', { perm: 'citizens.view' }, (ctx) => {
      const v = get('SELECT v.*, c.first_name, c.last_name, c.citizen_number, c.id cid FROM citizen_vehicles v JOIN citizens c ON c.id = v.citizen_id WHERE v.plate = ? COLLATE NOCASE', String(ctx.params.plate).trim());
      if (!v) throw notFound('Kein Fahrzeug mit diesem Kennzeichen registriert.');
      return { vehicle: { ...vehicleDto(v), owner: { id: v.cid, name: `${v.first_name} ${v.last_name}`, number: v.citizen_number } }, cases: casesOfPlate(ctx.user, v.plate).map(caseBrief) };
    });

    r.post('/api/citizens', { perm: 'citizens.create' }, (ctx) => {
      const f = fields(ctx.body, false), t = now();
      if (f.birth_date && get('SELECT 1 x FROM citizens WHERE lower(last_name) = lower(?) AND lower(first_name) = lower(?) AND birth_date = ?', f.last_name, f.first_name, f.birth_date)) throw conflict('Dieser Bürger (Name und Geburtsdatum) ist bereits registriert.');
      const id = tx(() => {
        const cols = { citizen_number: allocateNumber('citizen_number', 'citizens.number_prefix', 'citizens.number_start'), ...f, created_by: ctx.user.id, created_at: t, updated_at: t };
        return Number(run(`INSERT INTO citizens (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`, ...Object.values(cols)).lastInsertRowid);
      });
      const c = load(id);
      audit(ctx, { action: 'citizen.created', module: 'citizens', targetType: 'citizen', targetId: id, targetLabel: label(c) });
      ctx.status = 201;
      return { citizen: detail(c, ctx.user) };
    });

    r.patch('/api/citizens/:id', { perm: 'citizens.edit' }, (ctx) => {
      const cur = load(ctx.params.id), f = fields(ctx.body, true);
      const keys = Object.keys(f);
      if (keys.length) run(`UPDATE citizens SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => f[k]), now(), cur.id);
      const c = load(cur.id);
      audit(ctx, { action: 'citizen.updated', module: 'citizens', targetType: 'citizen', targetId: cur.id, targetLabel: label(c), after: { fields: keys } });
      return { citizen: detail(c, ctx.user) };
    });

    r.delete('/api/citizens/:id', { perm: 'citizens.delete' }, (ctx) => {
      const c = load(ctx.params.id);
      run('UPDATE case_persons SET name_text = ? WHERE citizen_id = ? AND name_text = ?', `${c.first_name} ${c.last_name}`.trim(), c.id, ''); // Name bleibt in den Akten erhalten
      run('DELETE FROM citizens WHERE id = ?', c.id);
      audit(ctx, { action: 'citizen.deleted', module: 'citizens', targetType: 'citizen', targetId: c.id, targetLabel: label(c) });
      return { ok: true };
    });

    // Fahndung
    r.post('/api/citizens/:id/wanted', { perm: 'citizens.wanted' }, (ctx) => {
      const c = load(ctx.params.id), on = !!ctx.body.wanted, reason = on ? str(ctx.body.reason, 'Grund der Fahndung', { min: 3, max: 500 }) : '';
      run('UPDATE citizens SET is_wanted = ?, wanted_reason = ?, wanted_by = ?, wanted_at = ?, updated_at = ? WHERE id = ?', on ? 1 : 0, reason, on ? ctx.user.id : null, on ? now() : null, now(), c.id);
      audit(ctx, { action: on ? 'citizen.wanted_set' : 'citizen.wanted_cleared', module: 'citizens', targetType: 'citizen', targetId: c.id, targetLabel: label(c), after: { reason } });
      return { citizen: detail(load(c.id), ctx.user) };
    });

    // Fahrzeuge
    const vehicleFields = (b, partial) => {
      const o = {};
      if (!partial || b.plate !== undefined) { o.plate = str(b.plate, 'Kennzeichen', { min: 2, max: 12 }).toUpperCase(); if (!PLATE_RE.test(o.plate)) throw bad('Kennzeichen: 2–12 Zeichen (Buchstaben, Ziffern, Leerzeichen, Punkt, Bindestrich).'); }
      if (!partial || b.makeModel !== undefined) o.make_model = str(b.makeModel, 'Marke / Modell', { min: 2, max: 80 });
      txt(b, 'color', 'Farbe', 40, o); txt(b, 'vin', 'Fahrgestellnummer', 30, o); txt(b, 'notes', 'Notizen', 500, o);
      if (b.status !== undefined) { if (!Object.hasOwn(VEHICLE_STATUS, b.status)) throw bad('Fahrzeugstatus: ungültiger Wert.'); o.status = b.status; }
      if (b.registeredAt !== undefined) o.registered_at = date(b.registeredAt, 'Zulassungsdatum');
      return o;
    };
    r.post('/api/citizens/:id/vehicles', { perm: 'citizens.vehicles' }, (ctx) => {
      const c = load(ctx.params.id), f = vehicleFields(ctx.body, false), t = now();
      if (get('SELECT 1 x FROM citizen_vehicles WHERE plate = ? COLLATE NOCASE', f.plate)) throw conflict('Dieses Kennzeichen ist bereits vergeben.');
      const cols = { citizen_id: c.id, registered_at: t.slice(0, 10), ...f, created_by: ctx.user.id, created_at: t, updated_at: t };
      const id = Number(run(`INSERT INTO citizen_vehicles (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`, ...Object.values(cols)).lastInsertRowid);
      audit(ctx, { action: 'citizen.vehicle_added', module: 'citizens', targetType: 'citizen', targetId: c.id, targetLabel: label(c), after: { plate: f.plate, makeModel: f.make_model } });
      ctx.status = 201;
      return { citizen: detail(c, ctx.user), vehicleId: id };
    });
    r.patch('/api/citizens/:id/vehicles/:vid', { perm: 'citizens.vehicles' }, (ctx) => {
      const c = load(ctx.params.id), v = get('SELECT * FROM citizen_vehicles WHERE id = ? AND citizen_id = ?', Number(ctx.params.vid), c.id);
      if (!v) throw notFound('Fahrzeug nicht gefunden.');
      const f = vehicleFields(ctx.body, true);
      if (f.plate && f.plate !== v.plate && get('SELECT 1 x FROM citizen_vehicles WHERE plate = ? COLLATE NOCASE AND id != ?', f.plate, v.id)) throw conflict('Dieses Kennzeichen ist bereits vergeben.');
      // Halterwechsel: nur innerhalb des Registers (Zielbürger muss existieren)
      if (ctx.body.ownerId !== undefined) { load(ctx.body.ownerId); f.citizen_id = Number(ctx.body.ownerId); }
      const keys = Object.keys(f);
      if (keys.length) run(`UPDATE citizen_vehicles SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => f[k]), now(), v.id);
      audit(ctx, { action: 'citizen.vehicle_updated', module: 'citizens', targetType: 'citizen', targetId: c.id, targetLabel: label(c), after: { plate: f.plate ?? v.plate, fields: keys } });
      return { citizen: detail(c, ctx.user) };
    });
    r.delete('/api/citizens/:id/vehicles/:vid', { perm: 'citizens.vehicles' }, (ctx) => {
      const c = load(ctx.params.id), v = get('SELECT * FROM citizen_vehicles WHERE id = ? AND citizen_id = ?', Number(ctx.params.vid), c.id);
      if (!v) throw notFound('Fahrzeug nicht gefunden.');
      run('DELETE FROM citizen_vehicles WHERE id = ?', v.id);
      audit(ctx, { action: 'citizen.vehicle_removed', module: 'citizens', targetType: 'citizen', targetId: c.id, targetLabel: label(c), after: { plate: v.plate } });
      return { citizen: detail(c, ctx.user) };
    });

    // Lizenzen
    const licenseFields = (b, partial) => {
      const o = {};
      if (!partial || b.kind !== undefined) o.kind = str(b.kind, 'Lizenz', { min: 2, max: 60 });
      if (b.status !== undefined) { if (!Object.hasOwn(LICENSE_STATUS, b.status)) throw bad('Lizenzstatus: ungültiger Wert.'); o.status = b.status; }
      if (b.issuedAt !== undefined) o.issued_at = date(b.issuedAt, 'Ausgestellt am'); if (b.validUntil !== undefined) o.valid_until = date(b.validUntil, 'Gültig bis');
      txt(b, 'note', 'Notiz', 300, o);
      return o;
    };
    r.post('/api/citizens/:id/licenses', { perm: 'citizens.licenses' }, (ctx) => {
      const c = load(ctx.params.id), f = licenseFields(ctx.body, false);
      run(`INSERT INTO citizen_licenses (citizen_id,${Object.keys(f).join(',')},created_at) VALUES (?,${Object.keys(f).map(() => '?').join(',')},?)`, c.id, ...Object.values(f), now());
      audit(ctx, { action: 'citizen.license_added', module: 'citizens', targetType: 'citizen', targetId: c.id, targetLabel: label(c), after: { kind: f.kind } });
      ctx.status = 201; return { citizen: detail(c, ctx.user) };
    });
    r.patch('/api/citizens/:id/licenses/:lid', { perm: 'citizens.licenses' }, (ctx) => {
      const c = load(ctx.params.id), l = get('SELECT * FROM citizen_licenses WHERE id = ? AND citizen_id = ?', Number(ctx.params.lid), c.id);
      if (!l) throw notFound('Lizenz nicht gefunden.');
      const f = licenseFields(ctx.body, true), keys = Object.keys(f);
      if (keys.length) run(`UPDATE citizen_licenses SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => f[k]), l.id);
      audit(ctx, { action: 'citizen.license_updated', module: 'citizens', targetType: 'citizen', targetId: c.id, targetLabel: label(c), after: { kind: f.kind ?? l.kind, status: f.status ?? l.status } });
      return { citizen: detail(c, ctx.user) };
    });
    r.delete('/api/citizens/:id/licenses/:lid', { perm: 'citizens.licenses' }, (ctx) => {
      const c = load(ctx.params.id), l = get('SELECT * FROM citizen_licenses WHERE id = ? AND citizen_id = ?', Number(ctx.params.lid), c.id);
      if (!l) throw notFound('Lizenz nicht gefunden.');
      run('DELETE FROM citizen_licenses WHERE id = ?', l.id);
      audit(ctx, { action: 'citizen.license_removed', module: 'citizens', targetType: 'citizen', targetId: c.id, targetLabel: label(c), after: { kind: l.kind } });
      return { citizen: detail(c, ctx.user) };
    });
  },
};
