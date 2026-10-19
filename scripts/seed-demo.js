// Optionale Entwicklungs-Dummydaten – bewusst getrennt von der echten Konfiguration (nicht Teil des Systems).
// Aufruf:  npm run seed:demo   (das System muss vorher über die Ersteinrichtung angelegt worden sein)
// Alle Namen, Ränge und Abteilungen hier sind reine Demo-Konfiguration und im Admin-Bereich frei änderbar.
import { migrate, get, run, now } from '../server/core/db.js';
import { hashPassword } from '../server/core/auth.js';
import { assignMemberNumber } from '../server/core/members.js';
import { registerConfig } from '../server/core/config.js';
import orgModule from '../server/modules/org.js';
import '../server/modules/market.js'; // registriert die Auswahllisten der Börse
import { syncLookups, slugify } from '../server/core/lookups.js';
import { newLinkToken } from '../server/core/partner-auth.js';
import partnersModule from '../server/modules/partners.js';
import marketModule from '../server/modules/market.js';
import { allocateNumber } from '../server/core/numbers.js';
import { tx } from '../server/core/db.js';
import vehiclesModule from '../server/modules/vehicles.js';
import mapModule from '../server/modules/map.js';
import warehouseModule from '../server/modules/warehouses.js';
import { bookStock } from '../server/core/stock.js';

registerConfig(orgModule.config);
registerConfig(partnersModule.config);
registerConfig(vehiclesModule.config);
registerConfig(mapModule.config);
registerConfig(warehouseModule.config);
registerConfig(marketModule.config); // Standardwerte für Dienstnummern (Präfix, Startnummer)

migrate();
if (!get('SELECT 1 x FROM users')) {
  console.error('Bitte zuerst die Ersteinrichtung im Browser durchführen.');
  process.exit(1);
}
const t = now();

const departments = [
  ['Führung', '#f5a524'], ['Operativ', '#ef4444'], ['Legal', '#a78bfa'],
  ['Finance', '#22c4a8'], ['Logistics', '#22d3ee'], ['Intelligence', '#4f8cff'],
];
const deptId = {};
departments.forEach(([name, color], i) => {
  const row = get('SELECT id FROM departments WHERE name = ?', name);
  deptId[name] = row?.id ?? Number(run('INSERT INTO departments (name,description,color,sort_order,created_at) VALUES (?,?,?,?,?)', name, 'Demo-Abteilung', color, i + 1, t).lastInsertRowid);
});

// [Name, Farbe, Abteilung, Vorgesetzter Rang] – Reihenfolge = Hierarchie. Legal ist eigenständig und nur über den Vorgesetzten angebunden.
const ranks = [
  ['Leitung', '#f5a524', 'Führung', null],
  ['Stellvertretende Leitung', '#fbbf24', 'Führung', 'Leitung'],
  ['Berater der Leitung', '#a78bfa', 'Führung', 'Stellvertretende Leitung'],
  ['Bereichsleiter', '#f87171', 'Operativ', 'Berater der Leitung'],
  ['Standortleiter', '#fb923c', 'Operativ', 'Bereichsleiter'],
  ['Abteilungsleiter', '#4f8cff', 'Operativ', 'Standortleiter'],
  ['Teamleiter', '#38bdf8', 'Operativ', 'Abteilungsleiter'],
  ['Senior-Mitarbeiter', '#22d3ee', 'Operativ', 'Teamleiter'],
  ['Mitarbeiter', '#2dd4bf', 'Operativ', 'Senior-Mitarbeiter'],
  ['Beobachter', '#84cc16', 'Operativ', 'Mitarbeiter'],
  ['Techniker', '#a3a3a3', 'Logistics', 'Beobachter'],
  ['Anwärter', '#94a3b8', null, 'Techniker'],
  ['Leiter Recht', '#c4b5fd', 'Legal', 'Berater der Leitung'],
  ['Rechtsberater', '#ddd6fe', 'Legal', 'Leiter Recht'],
  ['GESPERRT', '#ef4444', null, null],
];
const rankId = {};
ranks.forEach(([name, color, dept, parent], i) => {
  const row = get('SELECT id FROM ranks WHERE name = ?', name);
  rankId[name] = row?.id ?? Number(run('INSERT INTO ranks (name,description,color,sort_order,department_id,parent_rank_id,created_at) VALUES (?,?,?,?,?,?,?)',
    name, '', color, i + 1, dept ? deptId[dept] : null, parent ? rankId[parent] : null, t).lastInsertRowid);
});

// [Benutzername, RP-Name, Rang, Abteilung, Vorgesetzter (Benutzername), Status]
const members = [
  ['santiago.navarro', 'Santiago Navarro', 'Berater der Leitung', 'Führung', null, 'active'],
  ['alejandro.mendoza', 'Alejandro Mendoza', 'Leiter Recht', 'Legal', 'santiago.navarro', 'active'],
  ['mateo.salazar', 'Mateo Salazar', 'Rechtsberater', 'Legal', 'alejandro.mendoza', 'active'],
  ['diego.velazquez', 'Diego Velázquez', 'Bereichsleiter', 'Operativ', 'santiago.navarro', 'active'],
  ['javier.morales', 'Javier Morales', 'Standortleiter', 'Operativ', 'diego.velazquez', 'active'],
  ['emiliano.castillo', 'Emiliano Castillo', 'Abteilungsleiter', 'Operativ', 'javier.morales', 'active'],
  ['rafael.hernandez', 'Rafael Hernández', 'Teamleiter', 'Operativ', 'emiliano.castillo', 'active'],
  ['fernando.cabrera', 'Fernando Cabrera', 'Senior-Mitarbeiter', 'Operativ', 'rafael.hernandez', 'active'],
  ['miguel.torres', 'Miguel Ángel Torres', 'Mitarbeiter', 'Operativ', 'fernando.cabrera', 'active'],
  ['carlos.ramirez', 'Carlos Ramírez', 'Beobachter', 'Operativ', 'fernando.cabrera', 'active'],
  ['sebastian.vargas', 'Sebastián Vargas', 'Techniker', 'Logistics', 'rafael.hernandez', 'active'],
  ['eduardo.villanueva', 'Eduardo Villanueva', 'Mitarbeiter', 'Finance', 'emiliano.castillo', 'active'],
  ['luis.reyes', 'Luis Fernando Reyes', 'Anwärter', null, null, 'pending'],
  ['andres.zamora', 'Andrés Zamora', null, null, null, 'pending'],
  ['ricardo.mendoza', 'Ricardo Mendoza', 'GESPERRT', null, null, 'blocked'],
];
const pw = hashPassword('demo-passwort-123');
let created = 0;
for (const [username, name, rank, dept, , status] of members) {
  if (get('SELECT 1 x FROM users WHERE username = ?', username)) continue;
  const id = Number(run(
    'INSERT INTO users (username,display_name,password_hash,status,rank_id,department_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    username, name, pw, status, rank ? rankId[rank] : null, dept ? deptId[dept] : null, t, t,
  ).lastInsertRowid);
  if (status === 'active' || status === 'blocked') assignMemberNumber(id); // gesperrte Mitglieder behalten ihre Nummer
  created++;
}
for (const [username, , , , sup] of members) {
  if (sup) run('UPDATE users SET supervisor_id = (SELECT id FROM users WHERE username = ?) WHERE username = ? AND supervisor_id IS NULL', sup, username);
}
// ── Börse: Demo-Kategorien, Items, Übergabeorte, Gesuche und ein Demo-Partner ──
syncLookups();
const lookupId = (listKey, label, description = '', color = '#4f8cff') => {
  const row = get('SELECT id FROM lookups WHERE list_key = ? AND label = ? COLLATE NOCASE', listKey, label);
  if (row) return row.id;
  const max = get('SELECT COALESCE(MAX(sort_order),0) m FROM lookups WHERE list_key = ?', listKey).m;
  return Number(run('INSERT INTO lookups (list_key,key,label,description,color,sort_order,is_active,is_system) VALUES (?,?,?,?,?,?,1,0)',
    listKey, slugify(label), label, description, color, max + 1).lastInsertRowid);
};
const cat = { raw: lookupId('market.item_category', 'Rohstoffe', '', '#22c4a8'), weapons: lookupId('market.item_category', 'Waffen', '', '#ef4444'), valuables: lookupId('market.item_category', 'Wertsachen', '', '#f5a524') };
lookupId('market.handover_place', 'Lager Nord', 'Hintereingang, Tor 3 – dort klingeln und Namen nennen.');
lookupId('market.handover_place', 'Werkstatt Süd', 'Hinterhof, schwarze Tür. Nur nach Absprache.');
const itemId = {};
for (const [name, c, unit, ref] of [['Eisen', cat.raw, 'Stück', 50], ['Gold', cat.valuables, 'Barren', 900], ['Schrott', cat.raw, 'kg', 8], ['Pistole', cat.weapons, 'Stück', 1200], ['Schmuck', cat.valuables, 'Stück', 300]]) {
  itemId[name] = get('SELECT id FROM market_items WHERE name = ? COLLATE NOCASE', name)?.id
    ?? Number(run('INSERT INTO market_items (name,description,category_id,unit,reference_price,is_active,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)', name, '', c, unit, ref, t, t).lastInsertRowid);
}
if (!get('SELECT 1 x FROM market_wanted')) {
  run(`INSERT INTO market_wanted (item_id,quantity,unit_price,note,status,created_at,updated_at) VALUES (?,?,?,?, 'open', ?, ?)`, itemId.Eisen, 500, 65, 'Dringend – gute Qualität', t, t);
  run(`INSERT INTO market_wanted (item_id,quantity,unit_price,note,status,created_at,updated_at) VALUES (?,?,?,?, 'open', ?, ?)`, itemId.Gold, 20, 950, 'Barren, sauber', t, t);
}
let partnerInfo = 'Demo-Partner existiert bereits.';
if (!get(`SELECT 1 x FROM partners WHERE name = 'Demo-Händler'`)) {
  const token = newLinkToken();
  tx(() => run(`INSERT INTO partners (partner_number,name,note,link_token,code_hash,status,apps,created_at,updated_at) VALUES (?,'Demo-Händler','Demo-Zugang für Entwicklung',?,?,'active','["market"]',?,?)`,
    allocateNumber('partner_number', 'partners.number_prefix', 'partners.number_start'), token, hashPassword('123456'), t, t));
  partnerInfo = `Demo-Partner: http://127.0.0.1:3847/p/${token}  (Code: 123456)`;
}

// Karte & Fahrzeuge (nur wenn noch leer)
const lk = (list, label, color, i) => { const k = slugify(label); const r = get('SELECT id FROM lookups WHERE list_key = ? AND key = ?', list, k); return r?.id ?? Number(run('INSERT INTO lookups (list_key,key,label,color,sort_order,is_active,is_system) VALUES (?,?,?,?,?,1,0)', list, k, label, color, i).lastInsertRowid); };
// Lager + Preisspannen (nur wenn noch leer)
if (!get('SELECT 1 x FROM warehouses')) {
  const tDepot = lk('warehouse.type', 'Depot', '#f59e0b', 1), tGarage = lk('warehouse.type', 'Garage', '#22d3ee', 2);
  // Preisspannen für die Börse: [Item, Min, Max, Zielbestand]
  for (const [n, lo, hi, tgt] of [['Eisen', 40, 70, 500], ['Gold', 800, 1000, 50], ['Schrott', 5, 12, 2000], ['Pistole', 1000, 1400, 20]]) {
    run('UPDATE market_items SET min_price = ?, max_price = ?, target_stock = ? WHERE id = ?', lo, hi, tgt, itemId[n]);
  }
  const mkWh = (name, type, postal, locText, cap, size, access, restricted) => Number(run(
    'INSERT INTO warehouses (warehouse_number,name,type_id,postal,location_text,capacity,size_info,access_info,restricted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    allocateNumber('warehouse_number', 'warehouse.number_prefix', 'warehouse.number_start'), name, type, postal, locText, cap, size, access, restricted, t, t).lastInsertRowid);
  const w1 = mkWh('Lager Nord', tDepot, '5022', 'Hintereingang, Tor 3', 2000, '240 m², große Halle', 'Hintereingang, Tor 3 – dort klingeln. Schlüssel bei Logistics.', 0);
  mkWh('Garage Süd', tGarage, '10022', 'Hinterhof Werkstatt', 400, '60 m²', 'Nur nach Absprache, schwarze Tür.', 1);
  bookStock({ warehouseId: w1, itemId: itemId.Eisen, delta: 120, kind: 'in', note: 'Startbestand' });
  bookStock({ warehouseId: w1, itemId: itemId.Schrott, delta: 300, kind: 'in', note: 'Startbestand' });
}

if (!get('SELECT 1 x FROM map_points')) {
  const cFarm = lk('map.category', 'Farming', '#84cc16', 1), cLager = lk('map.category', 'Lager', '#f59e0b', 2), cTreff = lk('map.category', 'Treffpunkt', '#06b6d4', 3);
  for (const [n, d, c, ic, x, y] of [['Eisen-Farm', '- Nur nachts\n- 2 Fahrzeuge', cFarm, 'wrench', 1200, -300], ['Lager Hafen', '- Schlüssel bei Logistics', cLager, 'storage', 1000, -3200], ['Treffpunkt Mitte', '- Kurze Absprachen', cTreff, 'flag', 200, -600]])
    run('INSERT INTO map_points (name,description,category_id,icon,x,y,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', n, d, c, ic, x, y, 'all', t, t);
}
if (!get('SELECT 1 x FROM vehicles')) {
  for (const [n, p, f, lvl, c, lx, ly, loc] of [['Mercedes G-Klasse', 'AZ 047', 'diesel', 80, 'ready', -100, 200, 'Garage Nord'], ['Tesla Model S', 'AZ 100', 'electric', 15, 'damaged', 400, -500, 'Ladepark'], ['Dodge Charger', 'AZ 220', 'petrol', 55, 'maintenance', null, null, 'Werkstatt Süd']])
    run('INSERT INTO vehicles (vehicle_number,plate,name,fuel_type,fuel_level,condition_key,location_text,loc_x,loc_y,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      allocateNumber('vehicle_number', 'vehicles.number_prefix', 'vehicles.number_start'), p, n, f, lvl, c, loc, lx, ly, t, t);
}
console.log(`Demo-Daten: ${departments.length} Abteilungen, ${ranks.length} Ränge, ${created} neue Mitglieder. Passwort der Demo-Benutzer: demo-passwort-123`);
console.log(partnerInfo);
