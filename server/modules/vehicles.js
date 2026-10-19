import { all, get, run, tx, now, DB_PATH } from '../core/db.js';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bad, conflict, forbidden, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { allocateNumber } from '../core/numbers.js';
import { labelForUser } from '../core/identity.js';
import { deptWhere, requireDept, clampDept, defaultDept, assignableDepts, canSeeDept } from '../core/scope.js';
import { registerLookup, lookupEntries, isActiveEntry } from '../core/lookups.js';
import { decodeImage, IMAGE_MIME } from '../core/images.js';
import { registerWidget } from './dashboard.js';

/**
 * Fahrzeugverwaltung. Rechte sind fein getrennt: ansehen (nur lesen), Standort sehen, anlegen, bearbeiten, löschen, zuweisen.
 * Zugewiesene Mitglieder erscheinen ausschließlich als Dienstnummer (Anonymität).
 */
registerLookup({
  key: 'vehicles.fuel', module: 'Fahrzeuge', label: 'Kraftstoff-Arten', description: 'Feste Arten (Diesel, Benzin, Strom) – Beschriftung und Farbe sind anpassbar.',
  fixed: [{ key: 'diesel', label: 'Diesel', color: '#f59e0b' }, { key: 'petrol', label: 'Benzin', color: '#ef4444' }, { key: 'electric', label: 'Strom', color: '#22d3ee' }],
});
registerLookup({
  key: 'vehicles.condition', module: 'Fahrzeuge', label: 'Fahrzeugzustände', description: 'Feste Zustände – Beschriftung und Farbe sind anpassbar.',
  fixed: [
    { key: 'ready', label: 'Einsatzbereit', color: '#34d399' }, { key: 'damaged', label: 'Beschädigt', color: '#fb923c' },
    { key: 'maintenance', label: 'In Wartung', color: '#60a5fa' }, { key: 'broken', label: 'Defekt', color: '#f87171' }, { key: 'retired', label: 'Außer Dienst', color: '#94a3b8' },
  ],
});
registerLookup({
  key: 'vehicles.category', module: 'Fahrzeuge', label: 'Fahrzeugklassen', description: 'Z. B. PKW, Transporter, Motorrad, Boot, Hubschrauber – frei erweiterbar.',
  usage: (id) => get('SELECT COUNT(*) c FROM vehicles WHERE category_id = ?', id).c,
});

registerWidget({
  id: 'vehicles-overview', title: 'Fuhrpark', size: 'medium', permission: 'vehicles.view',
  data: (ctx) => {
    const dw = deptWhere(ctx.user, 'department_id');
    const counts = Object.fromEntries(all(`SELECT condition_key k, COUNT(*) c FROM vehicles WHERE is_active = 1 AND ${dw.sql} GROUP BY condition_key`, ...dw.params).map((x) => [x.k, x.c]));
    const today = new Date().toISOString().slice(0, 10);
    return {
      total: get(`SELECT COUNT(*) c FROM vehicles WHERE is_active = 1 AND ${dw.sql}`, ...dw.params).c,
      conditions: lookupEntries('vehicles.condition').map((e) => ({ key: e.key, label: e.label, color: e.color, count: counts[e.key] ?? 0 })),
      lowFuel: get(`SELECT COUNT(*) c FROM vehicles WHERE is_active = 1 AND fuel_level IS NOT NULL AND fuel_level < 20 AND ${dw.sql}`, ...dw.params).c,
      inspectionOverdue: get(`SELECT COUNT(*) c FROM vehicles WHERE is_active = 1 AND inspection_due IS NOT NULL AND inspection_due < ? AND ${dw.sql}`, today, ...dw.params).c,
      mine: get(`SELECT COUNT(*) c FROM vehicles WHERE is_active = 1 AND assigned_user_id = ? AND ${dw.sql}`, ctx.user.id, ...dw.params).c,
    };
  },
});

const FUELS = ['diesel', 'petrol', 'electric'];
const CONDITIONS = ['ready', 'damaged', 'maintenance', 'broken', 'retired'];
const imgDir = () => join(dirname(DB_PATH), 'vehicles');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SQL = `SELECT v.*, c.label cat_label, c.color cat_color, f.label fuel_label, f.color fuel_color, k.label cond_label, k.color cond_color, d.name dept_name, d.color dept_color
  FROM vehicles v LEFT JOIN lookups c ON c.id = v.category_id
  LEFT JOIN lookups f ON f.list_key = 'vehicles.fuel' AND f.key = v.fuel_type
  LEFT JOIN lookups k ON k.list_key = 'vehicles.condition' AND k.key = v.condition_key
  LEFT JOIN departments d ON d.id = v.department_id`;

function dto(v, user) {
  const loc = user.perms.has('vehicles.view_location');
  return {
    id: v.id, number: v.vehicle_number, plate: v.plate, vin: v.vin, name: v.name, isActive: !!v.is_active,
    category: v.category_id ? { id: v.category_id, label: v.cat_label, color: v.cat_color } : null,
    fuel: { key: v.fuel_type, label: v.fuel_label ?? v.fuel_type, color: v.fuel_color ?? '#94a3b8' }, fuelLevel: v.fuel_level,
    condition: { key: v.condition_key, label: v.cond_label ?? v.condition_key, color: v.cond_color ?? '#94a3b8' },
    color: v.color, mileage: v.mileage, seats: v.seats, inspectionDue: v.inspection_due, notes: v.notes,
    department: v.department_id ? { id: v.department_id, name: v.dept_name, color: v.dept_color } : null,
    assignedTo: v.assigned_user_id ? { id: v.assigned_user_id, label: labelForUser(v.assigned_user_id, user.id) } : null,
    imageUrl: v.image_ext ? `/api/vehicles/${v.id}/image?v=${v.image_version}` : null,
    location: loc ? { text: v.location_text, slot: v.parking_slot, x: v.loc_x, y: v.loc_y } : null,
    createdAt: v.created_at, updatedAt: v.updated_at,
  };
}
const load = (id, user) => { const v = get(`${SQL} WHERE v.id = ?`, id); if (v && user) requireDept(user, v.department_id, 'Fahrzeug nicht gefunden.'); return v; };

function addHistory(vehicleId, userId, kind, text) {
  run('INSERT INTO vehicle_events (vehicle_id,user_id,kind,text,created_at) VALUES (?,?,?,?,?)', vehicleId, userId, kind, text, now());
}

/** Eingaben prüfen → Spaltenwerte. partial=true: nur übergebene Felder. */
function fields(b, user, partial) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) out.name = str(b.name, 'Fahrzeug', { min: 2, max: 80 });
  if (has('plate')) { out.plate = str(b.plate, 'Kennzeichen', { min: 2, max: 14 }).toUpperCase(); }
  if (has('vin') && (b.vin !== undefined || !partial)) {
    const vin = b.vin == null || b.vin === '' ? '' : str(b.vin, 'Fahrgestellnummer', { min: 5, max: 30 }).toUpperCase();
    if (vin && !/^[A-Z0-9-]+$/.test(vin)) throw bad('Die Fahrgestellnummer darf nur Buchstaben, Ziffern und Bindestriche enthalten.');
    out.vin = vin || null;
  }
  if (has('categoryId') && b.categoryId !== undefined) {
    const c = b.categoryId == null || b.categoryId === '' ? null : b.categoryId;
    if (c != null && !isActiveEntry('vehicles.category', c)) throw bad('Unbekannte Fahrzeugklasse.');
    out.category_id = c;
  }
  if (has('fuel')) { if (!FUELS.includes(b.fuel)) throw bad('Kraftstoff: Diesel, Benzin oder Strom wählen.'); out.fuel_type = b.fuel; }
  if (b.fuelLevel !== undefined) {
    if (b.fuelLevel === null || b.fuelLevel === '') out.fuel_level = null;
    else if (!Number.isInteger(b.fuelLevel) || b.fuelLevel < 0 || b.fuelLevel > 100) throw bad('Tank/Akku: ganze Zahl von 0 bis 100.');
    else out.fuel_level = b.fuelLevel;
  }
  if (has('condition') && (b.condition !== undefined || !partial)) {
    const c = b.condition ?? 'ready';
    if (!CONDITIONS.includes(c)) throw bad('Unbekannter Fahrzeugzustand.');
    out.condition_key = c;
  }
  if (b.color !== undefined) out.color = str(b.color, 'Farbe', { max: 40, required: false });
  for (const [k, col, label, max] of [['mileage', 'mileage', 'Kilometerstand', 99999999], ['seats', 'seats', 'Sitzplätze', 99]]) {
    if (b[k] === undefined) continue;
    if (b[k] === null || b[k] === '') out[col] = null;
    else if (!Number.isInteger(b[k]) || b[k] < 0 || b[k] > max) throw bad(`${label}: ganze Zahl von 0 bis ${max}.`);
    else out[col] = b[k];
  }
  if (b.locationText !== undefined) out.location_text = str(b.locationText, 'Standort', { max: 120, required: false });
  if (b.parkingSlot !== undefined) out.parking_slot = str(b.parkingSlot, 'Stellplatz', { max: 30, required: false });
  if (b.locX !== undefined || b.locY !== undefined) {
    const x = b.locX === '' ? null : b.locX, y = b.locY === '' ? null : b.locY;
    if ((x == null) !== (y == null)) throw bad('Bitte beide Koordinaten (X und Y) angeben oder beide leer lassen.');
    if (x != null && (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 20000 || Math.abs(y) > 20000)) throw bad('Ungültige Koordinaten.');
    out.loc_x = x; out.loc_y = y;
  }
  if (b.inspectionDue !== undefined) {
    if (b.inspectionDue === null || b.inspectionDue === '') out.inspection_due = null;
    else if (!DATE_RE.test(b.inspectionDue)) throw bad('Ungültiges Datum für die Hauptuntersuchung.');
    else out.inspection_due = b.inspectionDue;
  }
  if (b.notes !== undefined) out.notes = str(b.notes, 'Notizen', { max: 1000, required: false });
  if (b.isActive !== undefined) out.is_active = b.isActive ? 1 : 0;
  if (b.departmentId !== undefined) {
    const d = b.departmentId == null || b.departmentId === '' ? null : b.departmentId;
    if (d != null && !get('SELECT 1 x FROM departments WHERE id = ?', d)) throw bad('Unbekannte Abteilung.');
    out.department_id = clampDept(user, d);
  }
  if (b.assignedUserId !== undefined) {
    if (!user.perms.has('vehicles.assign')) throw forbidden('Für die Zuweisung an Mitglieder fehlt dir das Recht „vehicles.assign“.');
    const a = b.assignedUserId == null || b.assignedUserId === '' ? null : b.assignedUserId;
    if (a != null && !get(`SELECT 1 x FROM users WHERE id = ? AND status = 'active'`, a)) throw bad('Unbekanntes Mitglied.');
    if (a != null && !canSeeDept(user, get('SELECT department_id d FROM users WHERE id = ?', a)?.d ?? null)) throw bad('Dieses Mitglied gehört zu einer anderen Behörde.');
    out.assigned_user_id = a;
  }
  return out;
}

const TRACK = {
  name: 'Fahrzeug', plate: 'Kennzeichen', vin: 'Fahrgestellnummer', fuel_type: 'Kraftstoff', fuel_level: 'Tank/Akku', condition_key: 'Zustand',
  mileage: 'Kilometerstand', location_text: 'Standort', parking_slot: 'Stellplatz', inspection_due: 'Hauptuntersuchung', is_active: 'Aktiv', color: 'Farbe', seats: 'Sitzplätze',
};
function changeLines(before, after, user) {
  const lines = [];
  const lab = (k, v) => (k === 'fuel_type' ? (lookupEntries('vehicles.fuel').find((e) => e.key === v)?.label ?? v)
    : k === 'condition_key' ? (lookupEntries('vehicles.condition').find((e) => e.key === v)?.label ?? v)
      : k === 'is_active' ? (v ? 'ja' : 'nein') : v == null || v === '' ? '–' : v);
  for (const [k, name] of Object.entries(TRACK)) if (k in after && String(before[k] ?? '') !== String(after[k] ?? '')) lines.push({ kind: k === 'condition_key' ? 'condition' : k.startsWith('location') || k === 'parking_slot' ? 'location' : 'updated', text: `${name}: ${lab(k, before[k])} → ${lab(k, after[k])}` });
  if ('loc_x' in after && (before.loc_x !== after.loc_x || before.loc_y !== after.loc_y)) lines.push({ kind: 'location', text: `Position: ${before.loc_x == null ? '–' : `${Math.round(before.loc_x)}, ${Math.round(before.loc_y)}`} → ${after.loc_x == null ? '–' : `${Math.round(after.loc_x)}, ${Math.round(after.loc_y)}`}` });
  if ('category_id' in after && before.category_id !== after.category_id) lines.push({ kind: 'updated', text: 'Fahrzeugklasse geändert' });
  if ('department_id' in after && before.department_id !== after.department_id) lines.push({ kind: 'updated', text: 'Abteilung geändert' });
  if ('assigned_user_id' in after && before.assigned_user_id !== after.assigned_user_id) {
    lines.push({ kind: 'assigned', text: `Zugewiesen: ${before.assigned_user_id ? labelForUser(before.assigned_user_id) : '–'} → ${after.assigned_user_id ? labelForUser(after.assigned_user_id) : '–'}` });
  }
  void user;
  return lines;
}

export default {
  name: 'vehicles',
  permissions: [
    ['vehicles.view', 'Fahrzeuge ansehen (nur lesen)'],
    ['vehicles.view_location', 'Fahrzeug-Standorte und Positionen sehen'],
    ['vehicles.create', 'Fahrzeuge anlegen'],
    ['vehicles.edit', 'Fahrzeuge bearbeiten'],
    ['vehicles.delete', 'Fahrzeuge löschen'],
    ['vehicles.assign', 'Fahrzeuge Mitgliedern zuweisen'],
  ],
  config: [
    { key: 'vehicles.number_prefix', group: 'Fahrzeuge', label: 'Präfix der Fahrzeugnummer', type: 'string', default: 'MDT-V-', max: 12 },
    { key: 'vehicles.number_start', group: 'Fahrzeuge', label: 'Startnummer der Fahrzeuge', type: 'number', default: 1001, min: 1, max: 99999999 },
  ],
  init() {
    for (const r of all('SELECT id FROM vehicles WHERE vehicle_number IS NULL ORDER BY id')) {
      tx(() => run('UPDATE vehicles SET vehicle_number = ? WHERE id = ?', allocateNumber('vehicle_number', 'vehicles.number_prefix', 'vehicles.number_start'), r.id));
    }
  },
  routes(r) {
    r.get('/api/vehicles/options', { perm: 'vehicles.view' }, (ctx) => ({
      categories: lookupEntries('vehicles.category', { onlyActive: true }),
      fuels: lookupEntries('vehicles.fuel'), conditions: lookupEntries('vehicles.condition'),
      departments: assignableDepts(ctx.user),
      members: ctx.user.perms.has('vehicles.assign') ? all(`SELECT id, member_number, status FROM users WHERE status = 'active' AND ${deptWhere(ctx.user, 'department_id').sql} ORDER BY member_number`, ...deptWhere(ctx.user, 'department_id').params).map((u) => ({ id: u.id, label: labelForUser(u.id, ctx.user.id) })) : [],
    }));

    r.get('/api/vehicles', { perm: 'vehicles.view' }, (ctx) => {
      const where = [];
      const p = [];
      const { q, condition, fuel, category, assigned } = ctx.query;
      if (q) { where.push('(v.plate LIKE ? OR v.name LIKE ? OR v.vin LIKE ? OR v.vehicle_number LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
      if (CONDITIONS.includes(condition)) { where.push('v.condition_key = ?'); p.push(condition); }
      if (FUELS.includes(fuel)) { where.push('v.fuel_type = ?'); p.push(fuel); }
      if (category) { where.push('v.category_id = ?'); p.push(Number(category)); }
      if (assigned === 'me') { where.push('v.assigned_user_id = ?'); p.push(ctx.user.id); }
      const dw = deptWhere(ctx.user, 'v.department_id'); where.push(dw.sql); p.push(...dw.params);
      const rows = all(`${SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY v.is_active DESC, v.updated_at DESC`, ...p);
      const dc = deptWhere(ctx.user, 'department_id');
      const counts = Object.fromEntries(all(`SELECT condition_key k, COUNT(*) c FROM vehicles WHERE is_active = 1 AND ${dc.sql} GROUP BY condition_key`, ...dc.params).map((x) => [x.k, x.c]));
      return { vehicles: rows.map((v) => dto(v, ctx.user)), counts, total: get(`SELECT COUNT(*) c FROM vehicles WHERE ${dc.sql}`, ...dc.params).c };
    });

    r.get('/api/vehicles/:id', { perm: 'vehicles.view' }, (ctx) => {
      const v = load(Number(ctx.params.id), ctx.user);
      if (!v) throw notFound('Fahrzeug nicht gefunden.');
      const history = all('SELECT * FROM vehicle_events WHERE vehicle_id = ? ORDER BY id DESC LIMIT 100', v.id).map((e) => ({
        id: e.id, kind: e.kind, text: e.text, createdAt: e.created_at, actor: e.user_id ? labelForUser(e.user_id, ctx.user.id) : 'System',
      }));
      return { vehicle: dto(v, ctx.user), history };
    });

    r.post('/api/vehicles', { perm: 'vehicles.create' }, (ctx) => {
      const f = fields(ctx.body, ctx.user, false);
      if (ctx.body.departmentId === undefined) f.department_id = defaultDept(ctx.user);
      if (get('SELECT 1 x FROM vehicles WHERE plate = ?', f.plate)) throw conflict('Dieses Kennzeichen ist bereits vergeben.');
      if (f.vin && get('SELECT 1 x FROM vehicles WHERE vin = ?', f.vin)) throw conflict('Diese Fahrgestellnummer existiert bereits.');
      const id = tx(() => {
        const t = now();
        const cols = { vehicle_number: allocateNumber('vehicle_number', 'vehicles.number_prefix', 'vehicles.number_start'), ...f, created_by: ctx.user.id, created_at: t, updated_at: t };
        const res = run(`INSERT INTO vehicles (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`, ...Object.values(cols));
        addHistory(Number(res.lastInsertRowid), ctx.user.id, 'created', 'Fahrzeug angelegt');
        return Number(res.lastInsertRowid);
      });
      const v = load(id);
      audit(ctx, { action: 'vehicle.created', module: 'vehicles', targetType: 'vehicle', targetId: id, targetLabel: `${v.vehicle_number} · ${v.plate}`, after: { plate: v.plate, name: v.name } });
      ctx.status = 201;
      return { vehicle: dto(v, ctx.user) };
    });

    r.patch('/api/vehicles/:id', { perm: 'vehicles.edit' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = load(id, ctx.user);
      if (!cur) throw notFound('Fahrzeug nicht gefunden.');
      const f = fields(ctx.body, ctx.user, true);
      if (f.plate && get('SELECT 1 x FROM vehicles WHERE plate = ? AND id != ?', f.plate, id)) throw conflict('Dieses Kennzeichen ist bereits vergeben.');
      if (f.vin && get('SELECT 1 x FROM vehicles WHERE vin = ? AND id != ?', f.vin, id)) throw conflict('Diese Fahrgestellnummer existiert bereits.');
      const lines = changeLines(cur, f, ctx.user);
      tx(() => {
        const cols = Object.keys(f);
        if (cols.length) run(`UPDATE vehicles SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => f[c]), now(), id);
        for (const l of lines) addHistory(id, ctx.user.id, l.kind, l.text);
      });
      const v = load(id);
      audit(ctx, { action: 'vehicle.updated', module: 'vehicles', targetType: 'vehicle', targetId: id, targetLabel: `${v.vehicle_number} · ${v.plate}`, after: Object.fromEntries(lines.map((l, i) => [i, l.text])) });
      return { vehicle: dto(v, ctx.user) };
    });

    r.delete('/api/vehicles/:id', { perm: 'vehicles.delete' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = load(id, ctx.user);
      if (!cur) throw notFound('Fahrzeug nicht gefunden.');
      if (cur.image_ext) try { unlinkSync(join(imgDir(), `${id}.${cur.image_ext}`)); } catch { /* egal */ }
      run('DELETE FROM vehicles WHERE id = ?', id);
      audit(ctx, { action: 'vehicle.deleted', module: 'vehicles', targetType: 'vehicle', targetId: id, targetLabel: `${cur.vehicle_number} · ${cur.plate}` });
      return { ok: true };
    });

    // Fahrzeugbild
    r.post('/api/vehicles/:id/image', { perm: 'vehicles.edit', bodyLimit: 4 * 1024 * 1024 }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = load(id, ctx.user);
      if (!cur) throw notFound('Fahrzeug nicht gefunden.');
      const { buf, ext } = decodeImage(ctx.body.data, 2 * 1024 * 1024, bad);
      mkdirSync(imgDir(), { recursive: true });
      if (cur.image_ext && cur.image_ext !== ext) try { unlinkSync(join(imgDir(), `${id}.${cur.image_ext}`)); } catch { /* egal */ }
      writeFileSync(join(imgDir(), `${id}.${ext}`), buf);
      run('UPDATE vehicles SET image_ext = ?, image_version = image_version + 1, updated_at = ? WHERE id = ?', ext, now(), id);
      addHistory(id, ctx.user.id, 'updated', 'Fahrzeugbild geändert');
      audit(ctx, { action: 'vehicle.updated', module: 'vehicles', targetType: 'vehicle', targetId: id, targetLabel: `${cur.vehicle_number} · ${cur.plate}`, after: { image: true } });
      return { vehicle: dto(load(id), ctx.user) };
    });
    r.delete('/api/vehicles/:id/image', { perm: 'vehicles.edit' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = load(id, ctx.user);
      if (!cur) throw notFound('Fahrzeug nicht gefunden.');
      if (cur.image_ext) try { unlinkSync(join(imgDir(), `${id}.${cur.image_ext}`)); } catch { /* egal */ }
      run('UPDATE vehicles SET image_ext = NULL, image_version = image_version + 1, updated_at = ? WHERE id = ?', now(), id);
      audit(ctx, { action: 'vehicle.updated', module: 'vehicles', targetType: 'vehicle', targetId: id, targetLabel: `${cur.vehicle_number} · ${cur.plate}`, after: { image: false } });
      return { vehicle: dto(load(id), ctx.user) };
    });
    r.get('/api/vehicles/:id/image', { perm: 'vehicles.view' }, (ctx) => {
      const v = get('SELECT id, image_ext FROM vehicles WHERE id = ?', Number(ctx.params.id));
      const file = v?.image_ext && join(imgDir(), `${v.id}.${v.image_ext}`);
      if (!file || !existsSync(file)) throw notFound('Kein Bild vorhanden.');
      ctx.raw = { contentType: IMAGE_MIME[v.image_ext], body: readFileSync(file), inline: true, cache: 'private, max-age=86400' };
    });
  },
};
