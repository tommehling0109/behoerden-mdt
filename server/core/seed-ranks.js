import { get, run, now } from './db.js';

/**
 * Standard-Ränge der Organisation (aufsteigend). Jeder Rang ist dem nächsthöheren untergeordnet (Hierarchie für die Namensanzeige).
 * Wird einmalig bei der Einrichtung angelegt (bzw. beim Start, wenn das System noch keine Ränge hat) – danach frei änderbar.
 */
const RANKS = [
  ['Anwärter', 'Neuling', 'Lernt die internen Abläufe kennen und unterstützt höhergestellte Mitglieder bei einfachen Aufgaben.'],
  ['Techniker', 'Technik / Versorgung', 'Kümmert sich um Ausrüstung, Fahrzeuge und technische Angelegenheiten.'],
  ['Beobachter', 'Informationsbeschaffung', 'Sammelt Informationen und meldet Auffälligkeiten an die Führung.'],
  ['Mitarbeiter', 'Ausführendes Mitglied', 'Übernimmt operative Aufgaben innerhalb der Organisation.'],
  ['Senior-Mitarbeiter', 'Erfahrenes Mitglied', 'Besonders erfahrenes und vertrauenswürdiges Mitglied. Wird für wichtige Aufgaben eingesetzt.'],
  ['Teamleiter', 'Unterführer', 'Führt kleinere Gruppen und sorgt dafür, dass Anweisungen der Führung umgesetzt werden.'],
  ['Abteilungsleiter', 'Abteilungsführung', 'Führt mehrere Mitglieder und koordiniert größere Bereiche der Organisation.'],
  ['Standortleiter', 'Leiter eines Gebiets', 'Verantwortlich für einen bestimmten Standort oder eine Region und die dortigen Mitglieder.'],
  ['Bereichsleiter', 'Bereichsführung', 'Koordiniert mehrere Gebiete und deren Führungskräfte.'],
  ['Rechtsberater', 'Rechtsberatung', 'Rechtlicher Berater der Organisation. Kümmert sich um Verträge, rechtliche Fragen, Verhandlungen und berät die Führung.'],
  ['Berater der Leitung', 'Oberster Berater', 'Vertrauensperson der Führung. Entwickelt Strategien und berät bei wichtigen Entscheidungen.'],
  ['Stellvertretende Leitung', 'Stellvertreter', 'Vertritt die Leitung, überwacht die Führungsebene und setzt deren Entscheidungen durch.'],
  ['Leitung', 'Oberste Leitung', 'Höchste Autorität. Trifft die endgültigen Entscheidungen und steht an der Spitze der gesamten Organisation.'],
];
/** Farbverlauf von Grau (unten) über Blau bis Gold (Spitze) */
const COLORS = ['#94a3b8', '#8da2bd', '#7a9bc4', '#6a93cc', '#5b8def', '#4f7be0', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#f59e0b', '#f97316', '#facc15'];

export function seedRanks() {
  if (get("SELECT 1 x FROM sequences WHERE name = 'ranks_seeded'")) return false;
  run("INSERT INTO sequences (name,next_value) VALUES ('ranks_seeded',1)");
  if (get('SELECT 1 x FROM ranks LIMIT 1')) return false; // es gibt schon eigene Ränge – nichts überschreiben
  const ids = [];
  RANKS.forEach(([name, title, text], i) => {
    const res = run('INSERT INTO ranks (name,description,color,sort_order,parent_rank_id,created_at) VALUES (?,?,?,?,NULL,?)', name, `${title} – ${text}`, COLORS[i], i + 1, now());
    ids.push(Number(res.lastInsertRowid));
  });
  seedRoles(RANKS.map(([name, title], i) => ({ name, desc: title, color: COLORS[i] })));
  ids.forEach((id, i) => { if (i < ids.length - 1) run('UPDATE ranks SET parent_rank_id = ? WHERE id = ?', ids[i + 1], id); }); // Vorgesetzter Rang = nächsthöherer
  return true;
}

/**
 * Rollen passend zu den Rängen: pro Rang eine Rolle mit aufsteigenden Rechten (jede Stufe enthält alle Rechte der Stufen darunter).
 * Die oberste Stufe ist Administrator-Rolle (alle Rechte). Zusätzlich gibt es die frei vergebbare Rolle „Administrator“.
 * Der Superadmin braucht keine Rolle – er hat immer alles.
 */
const LEVELS = [
  ['chat.view', 'chat.send', 'map.view', 'vehicles.view', 'warehouse.view', 'market.view', 'org.view', 'board.view', 'changelog.view', 'legal.view', 'market.trade', 'schedule.view', 'activity.absence'],
  ['warehouse.stock', 'vehicles.view_location', 'vehicles.edit', 'contacts.view'],
  ['map.edit', 'chat.pin'],
  ['market.deals.manage', 'schedule.create', 'vehicles.create', 'warehouse.view_access', 'contacts.edit', 'legal.cases.view'],
  ['market.wanted.manage', 'warehouse.items', 'partners.view'],
  ['users.view', 'tab.view', 'credit.view', 'stats.view', 'schedule.tasks.assign'],
  ['users.approve', 'schedule.manage', 'activity.view', 'onboarding.check', 'chat.moderate', 'market.catalog.manage', 'finance.view', 'vehicles.delete'],
  ['warehouse.manage', 'warehouse.prices', 'tab.statements', 'credit.manage', 'lookups.view'],
  ['partners.manage', 'activity.manage', 'onboarding.manage', 'users.create', 'users.edit', 'credit.payments', 'chat.partners', 'chat.manage', 'tickets.manage', 'board.manage', 'contacts.delete', 'contacts.bank', 'legal.cases.edit', 'legal.cases.billing'],
  ['partners.documents', 'users.watchlist', 'tab.manage_companies', 'credit.limits', 'finance.manual', 'finance.export', 'audit.view', 'roles.view', 'lookups.manage'],
  ['users.personnel_view', 'users.personnel_edit', 'users.avatar_edit', 'users.avatar_remove', 'audit.export', 'org.manage', 'admin.access', 'config.view', 'changelog.manage', 'help.manage', 'contacts.secret', 'legal.manage', 'legal.cases.confidential', 'legal.cases.delete'],
  ['users.password_reset', 'partners.levels', 'roles.manage', 'system.backup', 'system.apps', 'config.edit', 'market.delete', 'credit.delete', 'tab.delete', 'partners.delete', 'finance.delete', 'tickets.delete', 'users.delete'],
  [], // Stufe 13: Administrator-Rolle (alle Rechte)
];

export function seedRoles(rankNames) {
  const t = now();
  const mk = (name, desc, color, admin, sort) => {
    const ex = get('SELECT id FROM roles WHERE name = ? COLLATE NOCASE', name);
    if (ex) return ex.id;
    return Number(run('INSERT INTO roles (name,description,color,is_admin,is_system,sort_order,created_at) VALUES (?,?,?,?,?,?,?)', name, desc, color, admin ? 1 : 0, admin ? 1 : 0, sort, t).lastInsertRowid);
  };
  mk('Administrator', 'Voller Zugriff auf alle Funktionen. Frei vergebbar (der Superadmin braucht sie nicht).', '#f59e0b', true, 0);
  const have = new Set();
  rankNames.forEach(({ name, desc, color }, i) => {
    for (const k of LEVELS[i] ?? []) have.add(k);
    const admin = i === rankNames.length - 1;
    const id = mk(name, `Rolle zum Rang „${name}“ (${desc}) – Rechte wachsen mit dem Rang.`, color, admin, i + 1);
    if (!admin) for (const k of have) if (get('SELECT 1 x FROM permissions WHERE key = ?', k)) run('INSERT OR IGNORE INTO role_permissions (role_id,permission_key) VALUES (?,?)', id, k);
  });
}
