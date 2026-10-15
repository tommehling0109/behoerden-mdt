import { all, get, run, tx, now } from '../core/db.js';
import { bad, conflict, forbidden, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { allocateNumber } from '../core/numbers.js';
import { getConfig } from '../core/config.js';
import { labelForUser, memberLabel } from '../core/identity.js';
import { notify } from '../core/notifications.js';
import { loadAccess } from '../core/permissions.js';
import { registerLookup, lookupEntries, isActiveEntry } from '../core/lookups.js';
import { bookStock, usedSpace, totalStock, quote, slotsFor } from '../core/stock.js';
import { registerMapLayer, postalCoords } from './map.js';
import { registerWidget } from './dashboard.js';
import { purgeItem } from '../core/purge.js';

/**
 * Lagersystem: mehrere Lagerstandorte (Koordinaten oder Postleitzahl), Größe/Kapazität, Zugangsinfo, rollenbasierte Zugriffe
 * (ansehen / verwalten), Bestand je Item mit Verlauf und – je Item – eine Preisspanne (min/max), aus der die Börse den
 * Preisvorschlag für Partner automatisch berechnet (siehe core/stock.js).
 */
registerLookup({
  key: 'warehouse.type', module: 'Lager', label: 'Lagerarten', description: 'Z. B. Lager, Depot, Garage, Tresor – frei erweiterbar.',
  usage: (id) => get('SELECT COUNT(*) c FROM warehouses WHERE type_id = ?', id).c,
});

const SQL = `SELECT w.*, t.label type_label, t.color type_color, d.name dept_name, d.color dept_color
  FROM warehouses w LEFT JOIN lookups t ON t.id = w.type_id LEFT JOIN departments d ON d.id = w.department_id`;
const POSTAL_RE = /^\d{1,6}$/;
const nonNeg = (v, name, max = 100_000_000) => {
  if (v === null || v === '' || v === undefined) return null;
  if (!Number.isInteger(v) || v < 0 || v > max) throw bad(`${name}: ganze Zahl von 0 bis ${max.toLocaleString('de-DE')} erforderlich.`);
  return v;
};

/** Zugriffsstufe eines Mitglieds auf ein Lager: 'manage' | 'view' | null. */
export function levelFor(user, wh) {
  if (user.isAdmin || user.perms.has('warehouse.manage')) return 'manage';
  if (!user.perms.has('warehouse.view')) return null;
  const mine = new Set(user.roles.map((r) => r.id));
  const rows = all('SELECT role_id, level FROM warehouse_access WHERE warehouse_id = ?', wh.id).filter((a) => mine.has(a.role_id));
  const best = rows.some((a) => a.level === 'manage') ? 'manage' : rows.length ? 'view' : null;
  return wh.restricted ? best : (best ?? 'view');
}
/** Darf das Mitglied im Lager buchen (ein-/auslagern)? Wirft sonst 403/404. */
export function assertCanBook(user, warehouseId) {
  const wh = get('SELECT * FROM warehouses WHERE id = ?', warehouseId);
  if (!wh) throw bad('Unbekanntes Lager.');
  const lvl = levelFor(user, wh);
  if (!lvl) throw notFound('Lager nicht gefunden.');
  if (lvl !== 'manage' || !user.perms.has('warehouse.stock')) throw forbidden('Für Buchungen in diesem Lager fehlt dir die Berechtigung.');
  return wh;
}
const visible = (user) => all(`${SQL} ORDER BY w.is_active DESC, w.name`).map((w) => ({ w, level: levelFor(user, w) })).filter((x) => x.level);
const load = (user, id) => {
  const w = get(`${SQL} WHERE w.id = ?`, id);
  if (!w) throw notFound('Lager nicht gefunden.');
  const level = levelFor(user, w);
  if (!level) throw notFound('Lager nicht gefunden.');
  return { w, level };
};

function dto(w, level, user, { detail = false } = {}) {
  const used = usedSpace(w.id);
  const at = w.loc_x != null ? { x: w.loc_x, y: w.loc_y } : w.postal ? postalCoords(w.postal) : null;
  const out = {
    id: w.id, number: w.warehouse_number, name: w.name, isActive: !!w.is_active, description: w.description,
    type: w.type_id ? { id: w.type_id, label: w.type_label, color: w.type_color } : null,
    location: { text: w.location_text, postal: w.postal, x: w.loc_x, y: w.loc_y, resolved: at },
    capacity: w.capacity, used, sizeInfo: w.size_info,
    accessInfo: user.perms.has('warehouse.view_access') ? w.access_info : null,
    restricted: !!w.restricted, level, canBook: level === 'manage' && user.perms.has('warehouse.stock'),
    department: w.department_id ? { id: w.department_id, name: w.dept_name, color: w.dept_color } : null,
    notes: w.notes, itemCount: get('SELECT COUNT(*) c FROM warehouse_stock WHERE warehouse_id = ? AND quantity > 0', w.id).c,
    updatedAt: w.updated_at,
  };
  if (detail && level === 'manage') {
    const rec = parseRecipients(w.rent_recipients);
    out.rent = { enabled: !!w.rent_enabled, cents: w.rent_cents, weekday: w.rent_weekday, hour: w.rent_hour, roleIds: rec.roles, userIds: rec.users, lastNotified: w.rent_last_date, dueDate: w.rent_due_date, paidDate: w.rent_paid_date, unpaid: !!w.rent_due_date && (!w.rent_paid_date || w.rent_paid_date < w.rent_due_date) };
    out.access = all('SELECT a.role_id, a.level, r.name role_name, r.color role_color FROM warehouse_access a JOIN roles r ON r.id = a.role_id WHERE a.warehouse_id = ? ORDER BY r.name', w.id)
      .map((a) => ({ roleId: a.role_id, roleName: a.role_name, color: a.role_color, level: a.level }));
  }
  return out;
}

const itemRow = (i, user) => {
  const prices = user.perms.has('warehouse.prices');
  const visibleIds = new Set(visible(user).map((x) => x.w.id));
  const total = all('SELECT warehouse_id, quantity FROM warehouse_stock WHERE item_id = ?', i.id).filter((s) => visibleIds.has(s.warehouse_id)).reduce((a, s) => a + s.quantity, 0);
  return {
    id: i.id, name: i.name, description: i.description, unit: i.unit, space: i.space, stackSize: i.stack_size, isActive: !!i.is_active, targetStock: i.target_stock,
    category: i.category_id ? { id: i.category_id, label: i.cat_label, color: i.cat_color } : null, totalStock: total,
    minPrice: prices ? i.min_price : undefined, maxPrice: prices ? i.max_price : undefined,
    suggestedPrice: prices ? (quote(i.id, 1)?.unitPrice ?? null) : undefined,
  };
};
const ITEM_SQL = 'SELECT i.*, l.label cat_label, l.color cat_color FROM market_items i LEFT JOIN lookups l ON l.id = i.category_id';

/** Lagerkosten-Erinnerung: wöchentlich (Wochentag 0=Sonntag … 6=Samstag, volle Stunde) an Rollen und/oder einzelne Mitglieder. */
const parseRecipients = (s) => { try { const r = JSON.parse(s); return { roles: Array.isArray(r.roles) ? r.roles : [], users: Array.isArray(r.users) ? r.users : [] }; } catch { return { roles: [], users: [] }; } };
function rentFields(r) {
  if (!r || typeof r !== 'object') throw bad('Ungültige Angaben zu den Lagerkosten.');
  const out = {};
  if (r.enabled !== undefined) out.rent_enabled = r.enabled ? 1 : 0;
  if (r.cents !== undefined) out.rent_cents = nonNeg(r.cents, 'Lagerkosten', 1_000_000_000) ?? 0;
  if (r.weekday !== undefined) { if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) throw bad('Ungültiger Wochentag.'); out.rent_weekday = r.weekday; }
  if (r.hour !== undefined) { if (!Number.isInteger(r.hour) || r.hour < 0 || r.hour > 23) throw bad('Ungültige Uhrzeit (0–23).'); out.rent_hour = r.hour; }
  if (r.roleIds !== undefined || r.userIds !== undefined) {
    const roles = [...new Set(r.roleIds ?? [])], users = [...new Set(r.userIds ?? [])];
    if (!roles.every((i) => Number.isInteger(i) && get('SELECT 1 x FROM roles WHERE id = ?', i))) throw bad('Unbekannte Rolle bei den Empfängern.');
    if (!users.every((i) => Number.isInteger(i) && get("SELECT 1 x FROM users WHERE id = ? AND status = 'active'", i))) throw bad('Unbekanntes oder inaktives Mitglied bei den Empfängern.');
    out.rent_recipients = JSON.stringify({ roles, users });
  }
  return out;
}
/** Empfänger der Erinnerung: gewählte Rollen und Mitglieder; ohne Auswahl alle mit dem Recht „Lager verwalten“. */
function rentRecipients(w) {
  const rec = parseRecipients(w.rent_recipients), ids = new Set(rec.users);
  for (const rid of rec.roles) for (const u of all('SELECT user_id FROM user_roles WHERE role_id = ?', rid)) ids.add(u.user_id);
  let list = all("SELECT id FROM users WHERE status = 'active'").map((u) => u.id).filter((id) => ids.has(id));
  if (!rec.roles.length && !rec.users.length) list = all("SELECT id FROM users WHERE status = 'active'").map((u) => u.id).filter((id) => { const a = loadAccess(id); return a.isAdmin || a.perms.has('warehouse.manage'); });
  return list.map((id) => ({ type: 'user', id }));
}
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
/** Sendet fällige Erinnerungen (einmal pro Woche am eingestellten Wochentag ab der eingestellten Uhrzeit). */
export function runRentReminders(at = new Date()) {
  const today = localDay(at);
  let sent = 0;
  for (const w of all('SELECT * FROM warehouses WHERE is_active = 1 AND rent_enabled = 1')) {
    if (w.rent_last_date === today || at.getDay() !== w.rent_weekday || at.getHours() < w.rent_hour) continue;
    run('UPDATE warehouses SET rent_last_date = ?, rent_due_date = ? WHERE id = ?', today, today, w.id);
    const cur = getConfig('market.currency') ?? '$', amount = w.rent_cents > 0 ? ` Fällig: ${(w.rent_cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}.` : '';
    sent += notify(rentRecipients(w), { key: `warehouse:${w.id}:rent:${today}`, title: `${w.warehouse_number} · Lagerkosten fällig`, body: `${w.name}: Die wöchentlichen Lagerkosten sind zu bezahlen.${amount}`, target: { app: 'warehouse' } });
  }
  return sent;
}

/** Nach dem Speichern der Erinnerung: liegt der eingestellte Zeitpunkt heute schon hinter uns, wird heute nicht mehr nachträglich erinnert. */
function armRent(id) {
  const w = get('SELECT * FROM warehouses WHERE id = ?', id), at = new Date();
  if (w?.rent_enabled && at.getDay() === w.rent_weekday && at.getHours() >= w.rent_hour) run('UPDATE warehouses SET rent_last_date = ? WHERE id = ?', localDay(at), id);
}

function whFields(b, partial) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) out.name = str(b.name, 'Name', { min: 2, max: 80 });
  if (b.typeId !== undefined) {
    const t = b.typeId == null || b.typeId === '' ? null : b.typeId;
    if (t != null && !isActiveEntry('warehouse.type', t)) throw bad('Unbekannte Lagerart.');
    out.type_id = t;
  }
  if (b.description !== undefined) out.description = str(b.description, 'Beschreibung', { max: 500, required: false });
  if (b.locationText !== undefined) out.location_text = str(b.locationText, 'Standort', { max: 120, required: false });
  if (b.postal !== undefined) {
    const p = b.postal == null ? '' : String(b.postal).trim();
    if (p && !POSTAL_RE.test(p)) throw bad('Postleitzahl: nur Ziffern.');
    if (p && !postalCoords(p)) throw bad(`Die Postleitzahl ${p} ist auf der Karte nicht bekannt.`);
    out.postal = p || null;
  }
  if (b.locX !== undefined || b.locY !== undefined) {
    const x = b.locX === '' ? null : b.locX, y = b.locY === '' ? null : b.locY;
    if ((x == null) !== (y == null)) throw bad('Bitte beide Koordinaten (X und Y) angeben oder beide leer lassen.');
    if (x != null && (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 20000 || Math.abs(y) > 20000)) throw bad('Ungültige Koordinaten.');
    out.loc_x = x; out.loc_y = y;
  }
  if (b.capacity !== undefined) out.capacity = nonNeg(b.capacity, 'Kapazität (Slots)');
  if (b.sizeInfo !== undefined) out.size_info = str(b.sizeInfo, 'Größe', { max: 120, required: false });
  if (b.accessInfo !== undefined) out.access_info = str(b.accessInfo, 'Zugang', { max: 500, required: false });
  if (b.notes !== undefined) out.notes = str(b.notes, 'Notizen', { max: 1000, required: false });
  if (b.restricted !== undefined) out.restricted = b.restricted ? 1 : 0;
  if (b.isActive !== undefined) out.is_active = b.isActive ? 1 : 0;
  if (b.rent !== undefined) Object.assign(out, rentFields(b.rent));
  if (b.departmentId !== undefined) {
    const d = b.departmentId == null || b.departmentId === '' ? null : b.departmentId;
    if (d != null && !get('SELECT 1 x FROM departments WHERE id = ?', d)) throw bad('Unbekannte Abteilung.');
    out.department_id = d;
  }
  return out;
}
function setAccess(id, list) {
  if (!Array.isArray(list)) throw bad('Ungültige Zugriffsliste.');
  run('DELETE FROM warehouse_access WHERE warehouse_id = ?', id);
  for (const a of list) {
    if (!get('SELECT 1 x FROM roles WHERE id = ?', a.roleId)) throw bad('Unbekannte Rolle.');
    if (!['view', 'manage'].includes(a.level)) throw bad('Ungültige Zugriffsstufe.');
    run('INSERT OR REPLACE INTO warehouse_access (warehouse_id,role_id,level) VALUES (?,?,?)', id, a.roleId, a.level);
  }
}

registerMapLayer({
  key: 'warehouses', label: 'Lager', icon: 'storage', color: '#f59e0b', perm: 'warehouse.view', topic: 'warehouse',
  items: (user) => visible(user).filter(({ w }) => w.is_active && (w.loc_x != null || w.postal)).map(({ w }) => ({
    id: w.id, name: w.name, postal: w.postal, x: w.loc_x ?? undefined, y: w.loc_y ?? undefined,
    subtitle: [w.type_label, w.capacity != null ? `${usedSpace(w.id).toLocaleString('de-DE')} / ${w.capacity.toLocaleString('de-DE')} Slots belegt` : null, w.warehouse_number].filter(Boolean).join(' · '),
  })),
});

registerWidget({
  id: 'warehouse-overview', title: 'Lager', size: 'medium', permission: 'warehouse.view',
  data: (ctx) => {
    const list = visible(ctx.user).filter(({ w }) => w.is_active);
    const ids = new Set(list.map(({ w }) => w.id));
    const stock = all('SELECT s.warehouse_id, s.item_id, s.quantity FROM warehouse_stock s WHERE s.quantity > 0').filter((s) => ids.has(s.warehouse_id));
    const byItem = new Map();
    for (const s of stock) byItem.set(s.item_id, (byItem.get(s.item_id) ?? 0) + s.quantity);
    const items = all('SELECT id, name, unit, target_stock FROM market_items WHERE is_active = 1').filter((i) => i.target_stock > 0);
    return {
      warehouses: list.map(({ w }) => ({ id: w.id, name: w.name, used: usedSpace(w.id), capacity: w.capacity })).sort((a, b) => (b.capacity ? b.used / b.capacity : 0) - (a.capacity ? a.used / a.capacity : 0)).slice(0, 5),
      count: list.length, kinds: byItem.size, units: [...byItem.values()].reduce((a, b) => a + b, 0),
      low: items.map((i) => ({ name: i.name, unit: i.unit, stock: byItem.get(i.id) ?? 0, target: i.target_stock })).filter((i) => i.stock < i.target * 0.25).sort((a, b) => a.stock / a.target - b.stock / b.target).slice(0, 4),
    };
  },
});

export default {
  name: 'warehouse',
  permissions: [
    ['warehouse.view', 'Lager ansehen (Standorte, Größe, Bestand)'],
    ['warehouse.view_access', 'Lager: Zugangsinformationen sehen'],
    ['warehouse.stock', 'Lager: Bestand ein-/auslagern, korrigieren und umlagern'],
    ['warehouse.manage', 'Lager anlegen, bearbeiten, löschen und Zugriffe festlegen'],
    ['warehouse.items', 'Lager: Artikel (Items) anlegen und bearbeiten'],
    ['warehouse.prices', 'Lager: Preisspannen (Min/Max) sehen und festlegen'],
  ],
  config: [
    { key: 'warehouse.number_prefix', group: 'Lager', label: 'Präfix der Lagernummer', type: 'string', default: 'MDT-L-', max: 12 },
    { key: 'warehouse.number_start', group: 'Lager', label: 'Startnummer der Lager', type: 'number', default: 1001, min: 1, max: 99999999 },
    {
      key: 'warehouse.price_strategy', group: 'Lager', label: 'Automatischer Preisvorschlag (Börse)', type: 'select', default: 'stock',
      help: 'Wie aus der Preisspanne (Min/Max) eines Items der Vorschlag für Partner entsteht: nach Bestand (je voller das Lager gegenüber dem Zielbestand, desto näher am Mindestpreis), oder fest Mindest-, Mittel- oder Höchstpreis.',
      options: [{ value: 'stock', label: 'Nach Lagerbestand (Zielbestand)' }, { value: 'mid', label: 'Mittelwert der Spanne' }, { value: 'min', label: 'Mindestpreis' }, { value: 'max', label: 'Höchstpreis' }],
    },
  ],
  init() {
    setTimeout(() => { try { runRentReminders(); } catch { /* DB evtl. schon geschlossen */ } }, 8000).unref();
    setInterval(() => { try { runRentReminders(); } catch { /* egal */ } }, 5 * 60_000).unref();
    for (const r of all('SELECT id FROM warehouses WHERE warehouse_number IS NULL ORDER BY id')) {
      tx(() => run('UPDATE warehouses SET warehouse_number = ? WHERE id = ?', allocateNumber('warehouse_number', 'warehouse.number_prefix', 'warehouse.number_start'), r.id));
    }
  },
  routes(r) {
    r.get('/api/warehouse/options', { perm: 'warehouse.view' }, (ctx) => ({
      types: lookupEntries('warehouse.type', { onlyActive: true }),
      categories: lookupEntries('market.item_category', { onlyActive: true }),
      departments: all('SELECT id, name, color FROM departments ORDER BY sort_order, name'),
      roles: ctx.user.perms.has('warehouse.manage') ? all('SELECT id, name, color FROM roles ORDER BY name') : [],
      members: ctx.user.perms.has('warehouse.manage') ? all("SELECT id, member_number, status FROM users WHERE status = 'active' ORDER BY member_number, id").map((u) => ({ id: u.id, label: memberLabel(u) })) : [],
      weekdays: WEEKDAYS,
      items: all('SELECT id, name, unit, space, stack_size stackSize FROM market_items WHERE is_active = 1 ORDER BY name'),
      canManage: ctx.user.perms.has('warehouse.manage'), canItems: ctx.user.perms.has('warehouse.items'), canPrices: ctx.user.perms.has('warehouse.prices'),
      currency: getConfig('market.currency') ?? '$',
    }));

    r.get('/api/warehouses', { perm: 'warehouse.view' }, (ctx) => {
      const q = (ctx.query.q ?? '').toLowerCase();
      let rows = visible(ctx.user);
      if (q) rows = rows.filter(({ w }) => `${w.name} ${w.warehouse_number} ${w.location_text} ${w.postal ?? ''}`.toLowerCase().includes(q));
      if (ctx.query.type) rows = rows.filter(({ w }) => String(w.type_id) === ctx.query.type);
      if (ctx.query.active === '1') rows = rows.filter(({ w }) => w.is_active);
      return { warehouses: rows.map(({ w, level }) => dto(w, level, ctx.user)), total: rows.length };
    });

    r.get('/api/warehouses/:id', { perm: 'warehouse.view' }, (ctx) => {
      const { w, level } = load(ctx.user, Number(ctx.params.id));
      const prices = ctx.user.perms.has('warehouse.prices');
      const stock = all(`SELECT s.item_id, s.quantity, i.name, i.unit, i.space, i.stack_size, i.min_price, i.max_price, l.label cat_label, l.color cat_color
        FROM warehouse_stock s JOIN market_items i ON i.id = s.item_id LEFT JOIN lookups l ON l.id = i.category_id WHERE s.warehouse_id = ? AND s.quantity > 0 ORDER BY i.name`, w.id)
        .map((s) => ({ itemId: s.item_id, name: s.name, unit: s.unit, quantity: s.quantity, space: slotsFor(s, s.quantity), stacks: Math.ceil(s.quantity / s.stack_size), slotsPerStack: s.space, stackSize: s.stack_size, category: s.cat_label ? { label: s.cat_label, color: s.cat_color } : null,
          minPrice: prices ? s.min_price : undefined, maxPrice: prices ? s.max_price : undefined }));
      const events = all(`SELECT e.*, i.name item_name, i.unit item_unit FROM warehouse_events e LEFT JOIN market_items i ON i.id = e.item_id WHERE e.warehouse_id = ? ORDER BY e.id DESC LIMIT 100`, w.id)
        .map((e) => ({ id: e.id, kind: e.kind, item: e.item_name, unit: e.item_unit, delta: e.delta, after: e.quantity_after, note: e.note, dealId: e.deal_id, actor: e.user_id ? labelForUser(e.user_id, ctx.user.id) : 'System', createdAt: e.created_at }));
      return { warehouse: dto(w, level, ctx.user, { detail: true }), stock, events };
    });

    r.post('/api/warehouses', { perm: 'warehouse.manage' }, (ctx) => {
      const f = whFields(ctx.body, false);
      if (get('SELECT 1 x FROM warehouses WHERE name = ?', f.name)) throw conflict('Ein Lager mit diesem Namen existiert bereits.');
      const id = tx(() => {
        const t = now();
        const cols = { warehouse_number: allocateNumber('warehouse_number', 'warehouse.number_prefix', 'warehouse.number_start'), ...f, created_by: ctx.user.id, created_at: t, updated_at: t };
        const res = run(`INSERT INTO warehouses (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`, ...Object.values(cols));
        if (ctx.body.access !== undefined) setAccess(Number(res.lastInsertRowid), ctx.body.access);
        if (ctx.body.rent !== undefined) armRent(Number(res.lastInsertRowid));
        return Number(res.lastInsertRowid);
      });
      const w = get(`${SQL} WHERE w.id = ?`, id);
      audit(ctx, { action: 'warehouse.created', module: 'warehouse', targetType: 'warehouse', targetId: id, targetLabel: `${w.warehouse_number} · ${w.name}` });
      ctx.status = 201;
      return { warehouse: dto(w, 'manage', ctx.user, { detail: true }) };
    });

    r.patch('/api/warehouses/:id', { perm: 'warehouse.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get(`${SQL} WHERE w.id = ?`, id);
      if (!cur) throw notFound('Lager nicht gefunden.');
      const f = whFields(ctx.body, true);
      if (f.name && get('SELECT 1 x FROM warehouses WHERE name = ? AND id != ?', f.name, id)) throw conflict('Ein Lager mit diesem Namen existiert bereits.');
      if (f.capacity != null && f.capacity < usedSpace(id)) throw conflict(`Die Kapazität darf nicht unter der aktuellen Belegung (${usedSpace(id).toLocaleString('de-DE')}) liegen.`);
      tx(() => {
        const cols = Object.keys(f);
        if (cols.length) run(`UPDATE warehouses SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => f[c]), now(), id);
        if (ctx.body.access !== undefined) setAccess(id, ctx.body.access);
        if (ctx.body.rent !== undefined) armRent(id);
      });
      const w = get(`${SQL} WHERE w.id = ?`, id);
      audit(ctx, { action: 'warehouse.updated', module: 'warehouse', targetType: 'warehouse', targetId: id, targetLabel: `${w.warehouse_number} · ${w.name}`, before: { name: cur.name, capacity: cur.capacity, restricted: cur.restricted }, after: { name: w.name, capacity: w.capacity, restricted: w.restricted } });
      return { warehouse: dto(w, 'manage', ctx.user, { detail: true }) };
    });

    // Lagerkosten als bezahlt bestätigen (nimmt das Problem aus der Problemleiste)
    r.post('/api/warehouses/:id/rent/paid', { perm: 'warehouse.manage' }, (ctx) => {
      const id = Number(ctx.params.id), w = get('SELECT * FROM warehouses WHERE id = ?', id);
      if (!w) throw notFound('Lager nicht gefunden.');
      if (!w.rent_due_date || (w.rent_paid_date && w.rent_paid_date >= w.rent_due_date)) throw conflict('Es sind keine Lagerkosten offen.');
      run('UPDATE warehouses SET rent_paid_date = ?, updated_at = ? WHERE id = ?', localDay(new Date()), now(), id);
      audit(ctx, { action: 'warehouse.rent_paid', module: 'warehouse', targetType: 'warehouse', targetId: id, targetLabel: `${w.warehouse_number} · ${w.name}`, after: { dueDate: w.rent_due_date } });
      return { ok: true };
    });

    r.delete('/api/warehouses/:id', { perm: 'warehouse.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get('SELECT * FROM warehouses WHERE id = ?', id);
      if (!cur) throw notFound('Lager nicht gefunden.');
      if (get('SELECT COALESCE(SUM(quantity),0) q FROM warehouse_stock WHERE warehouse_id = ?', id).q > 0 && !(ctx.query.force === '1' && ctx.user.isSuperadmin)) throw conflict('Das Lager ist nicht leer. Lagere den Bestand aus oder um – oder setze das Lager auf inaktiv. (Superadmins können es samt Inhalt löschen.)');
      run('DELETE FROM warehouse_stock WHERE warehouse_id = ?', id);
      run('DELETE FROM warehouses WHERE id = ?', id);
      audit(ctx, { action: 'warehouse.deleted', module: 'warehouse', targetType: 'warehouse', targetId: id, targetLabel: `${cur.warehouse_number} · ${cur.name}` });
      return { ok: true };
    });

    // ── Bestand ──
    r.post('/api/warehouses/:id/stock', { perm: 'warehouse.stock' }, (ctx) => {
      const wh = assertCanBook(ctx.user, Number(ctx.params.id));
      if (!wh.is_active) throw conflict('Dieses Lager ist inaktiv.');
      const item = get('SELECT id, name, unit FROM market_items WHERE id = ?', ctx.body.itemId);
      if (!item) throw bad('Unbekanntes Item.');
      const qty = ctx.body.quantity;
      if (!Number.isInteger(qty) || qty < 0 || qty > 100_000_000) throw bad('Menge: ganze Zahl von 0 bis 100.000.000 erforderlich.');
      const action = ctx.body.action;
      if (!['in', 'out', 'set'].includes(action)) throw bad('Aktion: einlagern, auslagern oder korrigieren.');
      if (action !== 'set' && qty === 0) throw bad('Menge muss größer als 0 sein.');
      const note = str(ctx.body.note, 'Notiz', { max: 200, required: false });
      const after = tx(() => {
        const cur = get('SELECT quantity FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ?', wh.id, item.id)?.quantity ?? 0;
        const delta = action === 'in' ? qty : action === 'out' ? -qty : qty - cur;
        if (delta === 0) return cur;
        return bookStock({ warehouseId: wh.id, itemId: item.id, delta, kind: action === 'set' ? 'adjust' : action, userId: ctx.user.id, note });
      });
      audit(ctx, { action: `warehouse.stock_${action}`, module: 'warehouse', targetType: 'warehouse', targetId: wh.id, targetLabel: `${wh.name} · ${item.name}`, after: { quantity: after } });
      return { quantity: after, used: usedSpace(wh.id) };
    });

    r.post('/api/warehouses/:id/transfer', { perm: 'warehouse.stock' }, (ctx) => {
      const from = assertCanBook(ctx.user, Number(ctx.params.id));
      const to = assertCanBook(ctx.user, ctx.body.toId);
      if (from.id === to.id) throw bad('Quelle und Ziel sind dasselbe Lager.');
      if (!to.is_active) throw conflict('Das Ziel-Lager ist inaktiv.');
      const item = get('SELECT id, name FROM market_items WHERE id = ?', ctx.body.itemId);
      if (!item) throw bad('Unbekanntes Item.');
      const qty = ctx.body.quantity;
      if (!Number.isInteger(qty) || qty < 1 || qty > 100_000_000) throw bad('Menge: ganze Zahl ab 1 erforderlich.');
      const note = str(ctx.body.note, 'Notiz', { max: 200, required: false });
      tx(() => {
        bookStock({ warehouseId: from.id, itemId: item.id, delta: -qty, kind: 'transfer_out', userId: ctx.user.id, note: [`→ ${to.name}`, note].filter(Boolean).join(' · ') });
        bookStock({ warehouseId: to.id, itemId: item.id, delta: qty, kind: 'transfer_in', userId: ctx.user.id, note: [`← ${from.name}`, note].filter(Boolean).join(' · ') });
      });
      audit(ctx, { action: 'warehouse.stock_transfer', module: 'warehouse', targetType: 'warehouse', targetId: from.id, targetLabel: `${from.name} → ${to.name} · ${item.name}`, after: { quantity: qty } });
      return { ok: true };
    });

    // ── Artikel (Items) mit Preisspanne ──
    r.get('/api/warehouse/items', { perm: 'warehouse.view' }, (ctx) => ({ items: all(`${ITEM_SQL} ORDER BY i.is_active DESC, i.name`).map((i) => itemRow(i, ctx.user)) }));

    const itemFields = (b, user, partial) => {
      const out = {};
      if (!partial || b.name !== undefined) out.name = str(b.name, 'Name', { min: 2, max: 80 });
      if (!partial || b.description !== undefined) out.description = str(b.description, 'Beschreibung', { max: 300, required: false });
      if (!partial || b.unit !== undefined) out.unit = str(b.unit ?? 'Stück', 'Einheit', { min: 1, max: 20 });
      if (b.space !== undefined) { if (!Number.isInteger(b.space) || b.space < 1 || b.space > 100000) throw bad('Slots pro Stapel: ganze Zahl ab 1.'); out.space = b.space; }
      if (b.stackSize !== undefined) { if (!Number.isInteger(b.stackSize) || b.stackSize < 1 || b.stackSize > 100000) throw bad('Maximale Menge pro Stapel: ganze Zahl ab 1.'); out.stack_size = b.stackSize; }
      if (b.targetStock !== undefined) out.target_stock = nonNeg(b.targetStock, 'Zielbestand');
      if (b.categoryId !== undefined) {
        const c = b.categoryId == null || b.categoryId === '' ? null : b.categoryId;
        if (c != null && !isActiveEntry('market.item_category', c)) throw bad('Unbekannte Kategorie.');
        out.category_id = c;
      }
      if (b.isActive !== undefined) out.is_active = b.isActive ? 1 : 0;
      if (b.minPrice !== undefined || b.maxPrice !== undefined) {
        if (!user.perms.has('warehouse.prices')) throw forbidden('Für Preisspannen fehlt dir das Recht „warehouse.prices“.');
        if (b.minPrice !== undefined) out.min_price = nonNeg(b.minPrice, 'Mindestpreis');
        if (b.maxPrice !== undefined) out.max_price = nonNeg(b.maxPrice, 'Höchstpreis');
      }
      return out;
    };
    const checkRange = (id, f) => {
      const cur = id ? get('SELECT min_price, max_price FROM market_items WHERE id = ?', id) : {};
      const lo = 'min_price' in f ? f.min_price : cur.min_price, hi = 'max_price' in f ? f.max_price : cur.max_price;
      if ((lo == null) !== (hi == null)) throw bad('Bitte Mindest- und Höchstpreis gemeinsam angeben (oder beide leer lassen).');
      if (lo != null && lo > hi) throw bad('Der Mindestpreis darf nicht über dem Höchstpreis liegen.');
    };
    r.post('/api/warehouse/items', { perm: 'warehouse.items' }, (ctx) => {
      const f = itemFields(ctx.body, ctx.user, false);
      checkRange(null, f);
      if (get('SELECT 1 x FROM market_items WHERE name = ? COLLATE NOCASE', f.name)) throw conflict('Ein Item mit diesem Namen existiert bereits.');
      const t = now();
      const cols = { description: '', unit: 'Stück', ...f, created_at: t, updated_at: t };
      const res = run(`INSERT INTO market_items (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`, ...Object.values(cols));
      const id = Number(res.lastInsertRowid);
      audit(ctx, { action: 'warehouse.item_created', module: 'warehouse', targetType: 'item', targetId: id, targetLabel: f.name, after: { name: f.name, minPrice: f.min_price ?? null, maxPrice: f.max_price ?? null } });
      ctx.status = 201;
      return { item: itemRow(get(`${ITEM_SQL} WHERE i.id = ?`, id), ctx.user) };
    });
    r.patch('/api/warehouse/items/:id', { perm: 'warehouse.items' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get('SELECT * FROM market_items WHERE id = ?', id);
      if (!cur) throw notFound('Item nicht gefunden.');
      const f = itemFields(ctx.body, ctx.user, true);
      checkRange(id, f);
      if (f.name && get('SELECT 1 x FROM market_items WHERE name = ? COLLATE NOCASE AND id != ?', f.name, id)) throw conflict('Ein Item mit diesem Namen existiert bereits.');
      const cols = Object.keys(f);
      if (cols.length) run(`UPDATE market_items SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => f[c]), now(), id);
      const i = get(`${ITEM_SQL} WHERE i.id = ?`, id);
      audit(ctx, { action: 'warehouse.item_updated', module: 'warehouse', targetType: 'item', targetId: id, targetLabel: i.name, before: { minPrice: cur.min_price, maxPrice: cur.max_price }, after: { minPrice: i.min_price, maxPrice: i.max_price } });
      return { item: itemRow(i, ctx.user) };
    });
    r.delete('/api/warehouse/items/:id', { perm: 'warehouse.items' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get('SELECT * FROM market_items WHERE id = ?', id);
      if (!cur) throw notFound('Item nicht gefunden.');
      const force = ctx.query.force === '1' && ctx.user.isSuperadmin;
      if (!force) {
        if (totalStock(id) > 0) throw conflict('Vom Item liegt noch Bestand in Lagern. (Superadmins können es samt Bestand löschen.)');
        if (get('SELECT COUNT(*) c FROM market_deals WHERE item_id = ?', id).c > 0 || get('SELECT COUNT(*) c FROM market_wanted WHERE item_id = ?', id).c > 0) throw conflict('Das Item wird in der Börse verwendet. Deaktiviere es stattdessen.');
      }
      tx(() => purgeItem(id));
      audit(ctx, { action: 'warehouse.item_deleted', module: 'warehouse', targetType: 'item', targetId: id, targetLabel: cur.name });
      return { ok: true };
    });
  },
};
