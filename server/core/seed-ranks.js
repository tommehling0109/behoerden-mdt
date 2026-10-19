import { get, run, now } from './db.js';

/**
 * Behörden des Staates (Abteilungen) mit ihren Rängen – aufsteigend, der nächsthöhere Rang ist jeweils der Vorgesetzte.
 * Wird einmalig bei der Einrichtung angelegt (bzw. beim Start, wenn das System noch keine Ränge hat) – danach frei änderbar.
 * Rangnamen sind systemweit eindeutig, deshalb steht das Kürzel der Behörde dahinter.
 */
const AGENCIES = [
  { code: 'LSPD', name: 'Los Santos Police Department', color: '#3b82f6', ranks: ['Police Officer I', 'Police Officer II', 'Police Officer III', 'Senior Lead Officer', 'Sergeant I', 'Sergeant II', 'Lieutenant', 'Captain', 'Commander', 'Deputy Chief', 'Chief of Police'] },
  { code: 'BCSO', name: "Blaine County Sheriff's Office", color: '#a16207', ranks: ['Deputy Trainee', 'Deputy', 'Senior Deputy', 'Corporal', 'Sergeant', 'Lieutenant', 'Captain', 'Undersheriff', 'Sheriff'] },
  { code: 'SAHP', name: 'San Andreas Highway Patrol (State Troopers)', color: '#1d4ed8', ranks: ['Probationary Trooper', 'Trooper', 'Senior Trooper', 'Corporal', 'Sergeant', 'Lieutenant', 'Captain', 'Major', 'Colonel', 'Commissioner'] },
  { code: 'SAPR', name: 'San Andreas Park Rangers', color: '#15803d', ranks: ['Ranger Trainee', 'Park Ranger', 'Senior Ranger', 'Ranger Sergeant', 'Ranger Lieutenant', 'Ranger Captain', 'Chief Ranger'] },
  { code: 'FIB', name: 'Federal Investigation Bureau', color: '#475569', ranks: ['Probationary Agent', 'Special Agent', 'Senior Special Agent', 'Supervisory Special Agent', 'Assistant Special Agent in Charge', 'Special Agent in Charge', 'Assistant Director', 'Deputy Director', 'Director'] },
  { code: 'DOJ', name: 'Department of Justice', color: '#7c3aed', ranks: ['Justizangestellter', 'Pflichtverteidiger', 'Assistant District Attorney', 'Deputy District Attorney', 'District Attorney', 'Richter', 'Oberrichter', 'Attorney General'] },
  { code: 'SAFR', name: 'San Andreas Fire & Rescue', color: '#dc2626', ranks: ['Probationary Firefighter', 'Firefighter', 'Paramedic', 'Engineer', 'Lieutenant', 'Captain', 'Battalion Chief', 'Fire Chief'] },
];
/** Verlauf von hell (unterster Rang) zu kräftig (Spitze) innerhalb der Behördenfarbe */
const shade = (hex, i, n) => {
  const k = 0.55 + 0.45 * (n <= 1 ? 1 : i / (n - 1));
  const c = [1, 3, 5].map((o) => Math.round(parseInt(hex.slice(o, o + 2), 16) * k + 255 * (1 - k) * 0.35));
  return '#' + c.map((x) => Math.min(255, x).toString(16).padStart(2, '0')).join('');
};

export function seedRanks() {
  if (get("SELECT 1 x FROM sequences WHERE name = 'ranks_seeded'")) return false;
  run("INSERT INTO sequences (name,next_value) VALUES ('ranks_seeded',1)");
  if (get('SELECT 1 x FROM ranks LIMIT 1')) return false; // es gibt schon eigene Ränge – nichts überschreiben
  let deptSort = 0, rankSort = 0;
  for (const a of AGENCIES) {
    const ex = get('SELECT id FROM departments WHERE name = ? COLLATE NOCASE', a.name);
    const deptId = ex?.id ?? Number(run('INSERT INTO departments (name,description,color,sort_order,created_at) VALUES (?,?,?,?,?)', a.name, `Behörde ${a.code}`, a.color, ++deptSort, now()).lastInsertRowid);
    const ids = a.ranks.map((r, i) => Number(run('INSERT INTO ranks (name,description,color,sort_order,department_id,parent_rank_id,created_at) VALUES (?,?,?,?,?,NULL,?)',
      `${r} (${a.code})`, `${a.code} – Rang ${i + 1} von ${a.ranks.length}`, shade(a.color, i, a.ranks.length), ++rankSort, deptId, now()).lastInsertRowid));
    ids.forEach((id, i) => { if (i < ids.length - 1) run('UPDATE ranks SET parent_rank_id = ? WHERE id = ?', ids[i + 1], id); }); // Vorgesetzter Rang = nächsthöherer
  }
  seedRoles();
  return true;
}

/**
 * Rollen nach Verantwortung (unabhängig von der Behörde): jede Stufe enthält alle Rechte der Stufen darunter.
 * Der Rang bildet die Hierarchie ab, die Rolle steuert die Rechte. Zusätzlich gibt es die frei vergebbare Rolle „Administrator“.
 * Der Superadmin braucht keine Rolle – er hat immer alles.
 */
const LEVELS = [
  ['citizens.view', 'cases.view', 'chat.view', 'chat.send', 'map.view', 'vehicles.view', 'warehouse.view', 'market.view', 'org.view', 'board.view', 'changelog.view', 'legal.view', 'market.trade', 'schedule.view', 'activity.absence'],
  ['citizens.create', 'citizens.edit', 'citizens.vehicles', 'cases.create', 'cases.edit', 'warehouse.stock', 'vehicles.view_location', 'vehicles.edit', 'contacts.view'],
  ['map.edit', 'chat.pin'],
  ['market.deals.manage', 'schedule.create', 'vehicles.create', 'warehouse.view_access', 'contacts.edit', 'legal.cases.view'],
  ['market.wanted.manage', 'warehouse.items', 'partners.view'],
  ['citizens.licenses', 'citizens.wanted', 'cases.share', 'users.view', 'tab.view', 'credit.view', 'stats.view', 'schedule.tasks.assign'],
  ['users.approve', 'schedule.manage', 'activity.view', 'onboarding.check', 'chat.moderate', 'market.catalog.manage', 'finance.view', 'vehicles.delete'],
  ['warehouse.manage', 'warehouse.prices', 'tab.statements', 'credit.manage', 'lookups.view'],
  ['cases.catalog', 'cases.confidential', 'cases.delete', 'citizens.delete', 'partners.manage', 'activity.manage', 'onboarding.manage', 'users.create', 'users.edit', 'users.badge', 'credit.payments', 'chat.partners', 'chat.manage', 'tickets.manage', 'board.manage', 'contacts.delete', 'contacts.bank', 'legal.cases.edit', 'legal.cases.billing'],
  ['partners.documents', 'users.watchlist', 'tab.manage_companies', 'credit.limits', 'finance.manual', 'finance.export', 'audit.view', 'roles.view', 'lookups.manage'],
  ['users.personnel_view', 'users.personnel_edit', 'users.avatar_edit', 'users.avatar_remove', 'audit.export', 'org.manage', 'admin.access', 'config.view', 'changelog.manage', 'help.manage', 'contacts.secret', 'legal.manage', 'legal.cases.confidential', 'legal.cases.delete'],
  ['users.password_reset', 'partners.levels', 'roles.manage', 'system.backup', 'system.apps', 'config.edit', 'market.delete', 'credit.delete', 'tab.delete', 'partners.delete', 'finance.delete', 'tickets.delete', 'users.delete'],
  [], // Stufe 13: Administrator-Rolle (alle Rechte)
];

const ROLES = [
  { name: 'Beamter', desc: 'Grundrechte für den täglichen Dienst', color: '#60a5fa', upto: 2 },
  { name: 'Dienstgruppenleiter', desc: 'Führt eine Schicht oder Streife, vergibt Aufträge', color: '#34d399', upto: 5 },
  { name: 'Dienststellenleitung', desc: 'Personal, Einarbeitung und Verwaltung einer Dienststelle', color: '#f59e0b', upto: 8 },
  { name: 'Behördenleitung', desc: 'Leitung einer Behörde mit erweiterten Verwaltungsrechten', color: '#f97316', upto: 10 },
  { name: 'Justiz (DOJ)', desc: 'Staatsanwaltschaft und Gerichte: Urteile, Ergebnisse, Freigaben und Katalog', color: '#7c3aed', extra: ['citizens.view', 'citizens.create', 'citizens.edit', 'citizens.licenses', 'citizens.wanted', 'cases.view', 'cases.create', 'cases.edit', 'cases.share', 'cases.verdict', 'cases.confidential', 'cases.catalog', 'cases.delete', 'departments.all'] },
  { name: 'Personalabteilung', desc: 'Dienstnummern, Freischaltung und Personalakten', color: '#a78bfa', extra: ['users.view', 'users.create', 'users.edit', 'users.approve', 'users.badge', 'users.personnel_view', 'users.personnel_edit', 'org.view', 'onboarding.check', 'onboarding.manage'] },
];

export function seedRoles() {
  const t = now();
  const mk = (name, desc, color, admin, sort) => {
    const ex = get('SELECT id FROM roles WHERE name = ? COLLATE NOCASE', name);
    if (ex) return ex.id;
    return Number(run('INSERT INTO roles (name,description,color,is_admin,is_system,sort_order,created_at) VALUES (?,?,?,?,?,?,?)', name, desc, color, admin ? 1 : 0, admin ? 1 : 0, sort, t).lastInsertRowid);
  };
  mk('Administrator', 'Voller Zugriff auf alle Funktionen. Frei vergebbar (der Superadmin braucht sie nicht).', '#ef4444', true, 0);
  const grant = (id, keys) => { for (const k of keys) if (get('SELECT 1 x FROM permissions WHERE key = ?', k)) run('INSERT OR IGNORE INTO role_permissions (role_id,permission_key) VALUES (?,?)', id, k); };
  ROLES.forEach((r, i) => {
    const id = mk(r.name, r.desc, r.color, false, i + 1);
    grant(id, r.extra ?? LEVELS.slice(0, r.upto + 1).flat());
  });
}
