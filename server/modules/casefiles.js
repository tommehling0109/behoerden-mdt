import { all, get, run, tx, now } from '../core/db.js';
import { bad, conflict, forbidden, notFound, str, intList } from '../core/http.js';
import { audit } from '../core/audit.js';
import { labelForUser } from '../core/identity.js';
import { notify } from '../core/notifications.js';
import { seesAllDepartments, deptIdsOf, clampDept, defaultDept, canSeeDept } from '../core/scope.js';
import { CASE_TYPES, CASE_STATUSES, CLOSED_STATUSES, caseVisible, hasPerm } from '../core/case-access.js';

/**
 * Aktensystem des Staates: Ordnungswidrigkeiten, Straftaten, Verkehrsvorfälle, Verwaltungsrecht, Zivilrecht und Ermittlungsverfahren.
 * Eine Akte gehört einer führenden Behörde. Sie ist für diese Behörde, für ausdrücklich freigegebene Behörden und – wenn „staatsweit“ –
 * für alle sichtbar; vertrauliche Akten nur für das Team und Inhaber des Rechts „cases.confidential“.
 * Bestandteile: Sachverhalt, Tatablauf, beteiligte Personen (verknüpft mit dem Bürgerregister), Tatvorwürfe aus dem Katalog,
 * Beweise/Asservate, verknüpfte Fahrzeuge (Kennzeichen → Bürgerregister) und ein Verlauf.
 */
const PRIORITIES = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', urgent: 'Dringend' };
const ROLES = { suspect: 'Beschuldigter', defendant: 'Angeklagter', witness: 'Zeuge', victim: 'Geschädigter', reporter: 'Anzeigeerstatter', applicant: 'Antragsteller', respondent: 'Antragsgegner', officer: 'Einsatzkraft', other: 'Sonstige' };
const EVIDENCE_KINDS = { photo: 'Foto', video: 'Video / Bodycam', statement: 'Aussage / Protokoll', object: 'Gegenstand (Asservat)', document: 'Dokument', forensic: 'Spurensicherung', digital: 'Digitale Daten', other: 'Sonstiges' };
const FAVORS = { incriminating: 'Belastend', exonerating: 'Entlastend', neutral: 'Neutral' };
const CHARGE_STATUS = { alleged: 'Vorgeworfen', convicted: 'Verurteilt / festgesetzt', acquitted: 'Freigesprochen', dropped: 'Eingestellt' };
const VEHICLE_ROLES = { involved: 'Beteiligt', used: 'Tatfahrzeug', stolen: 'Gestohlen', damaged: 'Beschädigt', seized: 'Sichergestellt' };
const EVENT_KINDS = { note: 'Notiz', status: 'Status', system: 'System', decision: 'Entscheidung' };

const DEFAULT_CATALOG = [
  ['OWI-01', 'Geschwindigkeitsüberschreitung', 'misdemeanor', 25000, 0], ['OWI-02', 'Falschparken', 'misdemeanor', 10000, 0], ['OWI-03', 'Rotlichtverstoß', 'misdemeanor', 30000, 0],
  ['OWI-04', 'Ruhestörung', 'misdemeanor', 15000, 0], ['OWI-05', 'Fahren ohne Licht', 'misdemeanor', 10000, 0], ['OWI-06', 'Verunreinigung öffentlicher Flächen', 'misdemeanor', 8000, 0],
  ['VK-01', 'Fahren ohne Führerschein', 'traffic', 150000, 0], ['VK-02', 'Trunkenheit im Straßenverkehr', 'traffic', 250000, 3], ['VK-03', 'Unfallflucht', 'traffic', 300000, 6], ['VK-04', 'Gefährdung des Straßenverkehrs', 'traffic', 200000, 2],
  ['ST-01', 'Diebstahl', 'criminal', 200000, 6], ['ST-02', 'Fahrzeugdiebstahl', 'criminal', 400000, 12], ['ST-03', 'Raub', 'criminal', 500000, 24], ['ST-04', 'Körperverletzung', 'criminal', 300000, 12],
  ['ST-05', 'Schwere Körperverletzung', 'criminal', 800000, 36], ['ST-06', 'Sachbeschädigung', 'criminal', 150000, 0], ['ST-07', 'Besitz von Betäubungsmitteln', 'criminal', 250000, 6], ['ST-08', 'Handel mit Betäubungsmitteln', 'criminal', 1500000, 48],
  ['ST-09', 'Waffenbesitz ohne Erlaubnis', 'criminal', 500000, 12], ['ST-10', 'Bedrohung', 'criminal', 200000, 6], ['ST-11', 'Hausfriedensbruch', 'criminal', 100000, 0], ['ST-12', 'Widerstand gegen Vollstreckungsbeamte', 'criminal', 300000, 12],
  ['ST-13', 'Geiselnahme', 'criminal', 5000000, 120], ['ST-14', 'Mord', 'criminal', 0, 240],
  ['VW-01', 'Gewerbebetrieb ohne Anmeldung', 'administrative', 300000, 0], ['VW-02', 'Verstoß gegen behördliche Auflagen', 'administrative', 200000, 0], ['VW-03', 'Falsche Angaben gegenüber Behörden', 'administrative', 150000, 0],
];

const DATETIME = (v, label) => { if (v == null || v === '') return null; const d = new Date(v); if (Number.isNaN(d.getTime())) throw bad(`${label}: ungültiges Datum.`); return d.toISOString(); };
const oneOf = (v, map, label) => { if (!Object.hasOwn(map, v)) throw bad(`${label}: ungültiger Wert.`); return v; };
const posInt = (v, label, max, def = 0) => { if (v == null || v === '') return def; if (!Number.isInteger(v) || v < 0 || v > max) throw bad(`${label}: ganze Zahl von 0 bis ${max.toLocaleString('de-DE')} erforderlich.`); return v; };
const insert = (table, cols) => { const k = Object.keys(cols); return Number(run(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`, ...Object.values(cols)).lastInsertRowid); };
const update = (table, id, cols) => { const k = Object.keys(cols); if (k.length) run(`UPDATE ${table} SET ${k.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...Object.values(cols), id); };

// ── Zugriff ──
const inTeam = (user, c) => c.lead_user_id === user.id || c.created_by === user.id || !!get('SELECT 1 x FROM case_team WHERE case_id = ? AND user_id = ?', c.id, user.id);
/** Lesezugriff nach den Sichtbarkeitsregeln (gleiche SQL wie die Liste). */
function loadCase(user, id) {
  const v = caseVisible(user, 'c');
  const c = get(`SELECT c.* FROM cases c WHERE c.id = ? AND ${v.sql}`, Number(id), ...v.params);
  if (!c) throw notFound('Akte nicht gefunden.');
  return c;
}
/** Schreibzugriff: führende Behörde (bzw. alle Behörden) oder Team der Akte; freigegebene Behörden dürfen nur lesen. */
const mayWrite = (user, c) => hasPerm(user, 'cases.edit') && (seesAllDepartments(user) || canSeeDept(user, c.department_id) && c.department_id != null || inTeam(user, c) || c.department_id == null);
function loadForEdit(user, id) {
  const c = loadCase(user, id);
  if (!hasPerm(user, 'cases.edit')) throw forbidden('Für das Bearbeiten von Akten fehlt dir das Recht „cases.edit“.');
  if (!mayWrite(user, c)) throw forbidden('Diese Akte wird von einer anderen Behörde geführt – du darfst sie lesen, aber nicht ändern.');
  return c;
}
const touch = (id) => run('UPDATE cases SET updated_at = ? WHERE id = ?', now(), id);
const logEvent = (caseId, userId, kind, text) => run('INSERT INTO case_events (case_id,kind,text,created_by,created_at) VALUES (?,?,?,?,?)', caseId, kind, text, userId, now());

function nextCaseNumber(typeKey) {
  const prefix = CASE_TYPES[typeKey].prefix, y = new Date().getFullYear(), name = `case_${prefix}_${y}`;
  const n = get('SELECT next_value v FROM sequences WHERE name = ?', name)?.v ?? 1;
  run('INSERT INTO sequences (name,next_value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET next_value = excluded.next_value', name, n + 1);
  return `${prefix}-${y}-${String(n).padStart(4, '0')}`;
}

// ── DTOs ──
const deptOf = (id) => (id ? get('SELECT id, name, color FROM departments WHERE id = ?', id) : null);
const typeDto = (k) => ({ key: k, label: CASE_TYPES[k]?.label ?? k, color: CASE_TYPES[k]?.color ?? '#94a3b8', prefix: CASE_TYPES[k]?.prefix });
const statusDto = (k) => ({ key: k, label: CASE_STATUSES[k]?.label ?? k, color: CASE_STATUSES[k]?.color ?? '#94a3b8', closed: CLOSED_STATUSES.includes(k) });
function briefDto(c, user) {
  const persons = all('SELECT p.*, z.first_name, z.last_name FROM case_persons p LEFT JOIN citizens z ON z.id = p.citizen_id WHERE p.case_id = ? ORDER BY p.id LIMIT 3', c.id);
  return {
    id: c.id, number: c.case_number, type: typeDto(c.type_key), title: c.title, status: statusDto(c.status), priority: c.priority, priorityLabel: PRIORITIES[c.priority],
    department: deptOf(c.department_id), scope: c.scope, confidential: !!c.confidential, incidentAt: c.incident_at, location: c.location, updatedAt: c.updated_at, createdAt: c.created_at,
    lead: c.lead_user_id ? { id: c.lead_user_id, label: labelForUser(c.lead_user_id, user.id) } : null,
    people: persons.map((p) => (p.first_name ? `${p.first_name} ${p.last_name}` : p.name_text) || 'Unbekannt'), mine: c.lead_user_id === user.id || c.created_by === user.id,
  };
}
function personDto(p) {
  const z = p.citizen_id ? get('SELECT id, citizen_number, first_name, last_name, birth_date, phone, is_wanted FROM citizens WHERE id = ?', p.citizen_id) : null;
  return { id: p.id, role: p.role, roleLabel: ROLES[p.role] ?? p.role, note: p.note, citizenId: z?.id ?? null, name: z ? `${z.first_name} ${z.last_name}` : (p.name_text || 'Unbekannte Person'),
    number: z?.citizen_number ?? null, birthDate: z?.birth_date ?? null, phone: z?.phone ?? null, isWanted: !!z?.is_wanted, registered: !!z };
}
const chargeDto = (c) => ({ id: c.id, personId: c.person_id, catalogId: c.catalog_id, title: c.title, statute: c.statute, count: c.count, status: c.status, statusLabel: CHARGE_STATUS[c.status], fineCents: c.fine_cents, jailMonths: c.jail_months, note: c.note });
const evidenceDto = (e, user) => ({ id: e.id, tag: e.tag, kind: e.kind, kindLabel: EVIDENCE_KINDS[e.kind] ?? e.kind, title: e.title, description: e.description, collectedAt: e.collected_at, collectedBy: e.collected_by ? labelForUser(e.collected_by, user.id) : null, location: e.location, linkUrl: e.link_url, favors: e.favors, favorsLabel: FAVORS[e.favors] });

function detail(c, user) {
  const persons = all('SELECT * FROM case_persons WHERE case_id = ? ORDER BY id', c.id).map(personDto);
  const charges = all('SELECT * FROM case_charges WHERE case_id = ? ORDER BY id', c.id).map(chargeDto);
  const totals = { fineCents: 0, jailMonths: 0 };
  for (const ch of charges) if (!['dropped', 'acquitted'].includes(ch.status)) { totals.fineCents += ch.fineCents * ch.count; totals.jailMonths += ch.jailMonths * ch.count; }
  const mayEdit = mayWrite(user, c);
  return {
    ...briefDto(c, user), summary: c.summary, narrative: c.narrative, outcome: c.outcome, closedAt: c.closed_at, createdBy: c.created_by ? labelForUser(c.created_by, user.id) : null,
    persons, charges, totals,
    evidence: all('SELECT * FROM case_evidence WHERE case_id = ? ORDER BY id', c.id).map((e) => evidenceDto(e, user)),
    vehicles: all('SELECT cv.*, v.make_model, v.color, v.status vstatus, z.first_name, z.last_name, z.id zid FROM case_vehicles cv LEFT JOIN citizen_vehicles v ON v.id = cv.citizen_vehicle_id LEFT JOIN citizens z ON z.id = v.citizen_id WHERE cv.case_id = ? ORDER BY cv.id', c.id)
      .map((v) => ({ id: v.id, plate: v.plate, role: v.role, roleLabel: VEHICLE_ROLES[v.role], description: v.description, makeModel: v.make_model ?? null, color: v.color ?? null, registered: !!v.citizen_vehicle_id, ownerId: v.zid ?? null, owner: v.first_name ? `${v.first_name} ${v.last_name}` : null })),
    events: all('SELECT * FROM case_events WHERE case_id = ? ORDER BY id DESC LIMIT 200', c.id).map((e) => ({ id: e.id, kind: e.kind, kindLabel: EVENT_KINDS[e.kind] ?? e.kind, text: e.text, createdAt: e.created_at, by: e.created_by ? labelForUser(e.created_by, user.id) : 'System' })),
    team: all('SELECT user_id FROM case_team WHERE case_id = ?', c.id).map((t) => ({ id: t.user_id, label: labelForUser(t.user_id, user.id) })),
    sharedWith: all('SELECT d.id, d.name, d.color FROM case_departments x JOIN departments d ON d.id = x.department_id WHERE x.case_id = ? ORDER BY d.sort_order, d.name', c.id),
    can: { edit: mayEdit, delete: mayEdit && hasPerm(user, 'cases.delete'), share: mayEdit && hasPerm(user, 'cases.share'), verdict: mayEdit && hasPerm(user, 'cases.verdict'), confidential: hasPerm(user, 'cases.confidential') },
  };
}

function caseFields(b, partial, user, cur = null) {
  const o = {};
  if (!partial || b.title !== undefined) o.title = str(b.title, 'Titel', { min: 3, max: 160 });
  if (b.priority !== undefined) o.priority = oneOf(b.priority, PRIORITIES, 'Priorität');
  if (b.incidentAt !== undefined) o.incident_at = DATETIME(b.incidentAt, 'Tatzeit');
  if (b.location !== undefined) o.location = str(b.location, 'Tatort', { max: 200, required: false });
  if (b.summary !== undefined) o.summary = str(b.summary, 'Sachverhalt', { max: 8000, required: false });
  if (b.narrative !== undefined) o.narrative = str(b.narrative, 'Tatablauf', { max: 20000, required: false });
  if (b.outcome !== undefined) o.outcome = str(b.outcome, 'Ergebnis', { max: 8000, required: false });
  if (b.leadUserId !== undefined) {
    const id = b.leadUserId == null || b.leadUserId === '' ? null : b.leadUserId;
    if (id != null && !get("SELECT 1 x FROM users WHERE id = ? AND status = 'active'", id)) throw bad('Unbekannter Sachbearbeiter.');
    o.lead_user_id = id;
  }
  if (b.confidential !== undefined) { if (!!b.confidential !== !!cur?.confidential && !hasPerm(user, 'cases.confidential')) throw forbidden('Die Vertraulichkeit ändert nur, wer das Recht „cases.confidential“ hat.'); o.confidential = b.confidential ? 1 : 0; }
  return o;
}

function addPerson(caseId, b) {
  const role = oneOf(b.role, ROLES, 'Rolle');
  let citizenId = null, nameText = '';
  if (b.citizenId != null && b.citizenId !== '') {
    const z = get('SELECT id, first_name, last_name FROM citizens WHERE id = ?', b.citizenId);
    if (!z) throw bad('Unbekannter Bürger.');
    citizenId = z.id; nameText = `${z.first_name} ${z.last_name}`;
  } else nameText = str(b.nameText, 'Name', { min: 2, max: 120 });
  return insert('case_persons', { case_id: caseId, citizen_id: citizenId, name_text: nameText, role, note: str(b.note, 'Notiz', { max: 500, required: false }), created_at: now() });
}
function addVehicle(caseId, b) {
  const plate = str(b.plate, 'Kennzeichen', { min: 2, max: 12 }).toUpperCase();
  const reg = get('SELECT id FROM citizen_vehicles WHERE plate = ? COLLATE NOCASE', plate);
  return insert('case_vehicles', { case_id: caseId, citizen_vehicle_id: reg?.id ?? null, plate, description: str(b.description, 'Beschreibung', { max: 300, required: false }), role: oneOf(b.role ?? 'involved', VEHICLE_ROLES, 'Rolle') });
}
function addCharge(caseId, b, user) {
  let cat = null;
  if (b.catalogId != null && b.catalogId !== '') { cat = get('SELECT * FROM charge_catalog WHERE id = ?', b.catalogId); if (!cat) throw bad('Unbekannter Katalogeintrag.'); }
  const personId = b.personId == null || b.personId === '' ? null : b.personId;
  if (personId != null && !get('SELECT 1 x FROM case_persons WHERE id = ? AND case_id = ?', personId, caseId)) throw bad('Die Person gehört nicht zu dieser Akte.');
  return insert('case_charges', {
    case_id: caseId, person_id: personId, catalog_id: cat?.id ?? null, title: b.title ? str(b.title, 'Tatvorwurf', { min: 2, max: 160 }) : (cat?.title ?? (() => { throw bad('Tatvorwurf ist erforderlich.'); })()),
    statute: b.statute !== undefined ? str(b.statute, 'Norm', { max: 60, required: false }) : (cat?.code ?? ''), count: posInt(b.count, 'Anzahl', 999, 1) || 1,
    fine_cents: b.fineCents !== undefined ? posInt(b.fineCents, 'Bußgeld (Cent)', 10_000_000_000) : (cat?.fine_cents ?? 0), jail_months: b.jailMonths !== undefined ? posInt(b.jailMonths, 'Haft (Monate)', 2400) : (cat?.jail_months ?? 0),
    note: str(b.note, 'Notiz', { max: 500, required: false }), created_by: user.id, created_at: now(),
  });
}

export default {
  name: 'casefiles',
  permissions: [
    ['cases.view', 'Akten: Akten der eigenen/freigegebenen Behörden und staatsweite Akten ansehen'],
    ['cases.create', 'Akten: neue Akten anlegen'],
    ['cases.edit', 'Akten: Akten der eigenen Behörde bearbeiten (Personen, Vorwürfe, Beweise, Verlauf)'],
    ['cases.delete', 'Akten: Akten löschen'],
    ['cases.share', 'Akten: Akten für andere Behörden freigeben oder staatsweit sichtbar machen'],
    ['cases.verdict', 'Akten: Tatvorwürfe als verurteilt/freigesprochen festsetzen und Ergebnis eintragen (z. B. DOJ)'],
    ['cases.confidential', 'Akten: vertrauliche Akten sehen und Vertraulichkeit setzen'],
    ['cases.catalog', 'Akten: Straftaten- und Bußgeldkatalog pflegen'],
  ],
  init() {
    if (!get('SELECT 1 x FROM charge_catalog LIMIT 1')) for (const [code, title, type, fine, jail] of DEFAULT_CATALOG) run('INSERT INTO charge_catalog (code,title,type_key,description,fine_cents,jail_months) VALUES (?,?,?,?,?,?)', code, title, type, '', fine, jail);
  },
  routes(r) {
    r.get('/api/cases/options', { perm: 'cases.view' }, (ctx) => ({
      types: Object.keys(CASE_TYPES).map(typeDto), statuses: Object.keys(CASE_STATUSES).map(statusDto),
      priorities: Object.entries(PRIORITIES).map(([key, label]) => ({ key, label })), roles: Object.entries(ROLES).map(([key, label]) => ({ key, label })),
      evidenceKinds: Object.entries(EVIDENCE_KINDS).map(([key, label]) => ({ key, label })), favors: Object.entries(FAVORS).map(([key, label]) => ({ key, label })),
      chargeStatuses: Object.entries(CHARGE_STATUS).map(([key, label]) => ({ key, label })), vehicleRoles: Object.entries(VEHICLE_ROLES).map(([key, label]) => ({ key, label })),
      departments: all('SELECT id, name, color FROM departments ORDER BY sort_order, name'), myDepartmentId: defaultDept(ctx.user), seesAll: seesAllDepartments(ctx.user),
      catalog: all('SELECT * FROM charge_catalog WHERE is_active = 1 ORDER BY type_key, code, title').map((x) => ({ id: x.id, code: x.code, title: x.title, type: x.type_key, fineCents: x.fine_cents, jailMonths: x.jail_months })),
      can: Object.fromEntries(['create', 'edit', 'delete', 'share', 'verdict', 'confidential', 'catalog'].map((k) => [k, hasPerm(ctx.user, `cases.${k}`)])),
      members: all("SELECT id FROM users WHERE status = 'active' ORDER BY display_name LIMIT 500").filter((u) => { const x = get('SELECT department_id d FROM users WHERE id = ?', u.id)?.d ?? null; return canSeeDept(ctx.user, x); }).map((u) => ({ id: u.id, label: labelForUser(u.id, ctx.user.id) })),
    }));

    r.get('/api/cases', { perm: 'cases.view' }, (ctx) => {
      const v = caseVisible(ctx.user, 'c'), where = [v.sql], p = [...v.params], { type, status, q, dept, mine, citizen, plate, open } = ctx.query;
      if (CASE_TYPES[type]) { where.push('c.type_key = ?'); p.push(type); }
      if (CASE_STATUSES[status]) { where.push('c.status = ?'); p.push(status); }
      if (open === '1') { where.push(`c.status NOT IN (${CLOSED_STATUSES.map(() => '?').join(',')})`); p.push(...CLOSED_STATUSES); }
      if (dept) { where.push('c.department_id = ?'); p.push(Number(dept)); }
      if (mine === '1') { where.push('(c.lead_user_id = ? OR c.created_by = ?)'); p.push(ctx.user.id, ctx.user.id); }
      if (citizen) { where.push('EXISTS (SELECT 1 FROM case_persons x WHERE x.case_id = c.id AND x.citizen_id = ?)'); p.push(Number(citizen)); }
      if (plate) { where.push('EXISTS (SELECT 1 FROM case_vehicles x WHERE x.case_id = c.id AND x.plate = ? COLLATE NOCASE)'); p.push(String(plate)); }
      if (q) {
        const like = `%${String(q).trim().replace(/[%_]/g, '')}%`;
        where.push(`(c.case_number LIKE ? OR c.title LIKE ? OR c.summary LIKE ? OR c.location LIKE ? OR EXISTS (SELECT 1 FROM case_persons x LEFT JOIN citizens z ON z.id = x.citizen_id WHERE x.case_id = c.id AND (x.name_text LIKE ? OR z.last_name LIKE ? OR z.first_name LIKE ? OR z.citizen_number LIKE ?))
          OR EXISTS (SELECT 1 FROM case_vehicles x WHERE x.case_id = c.id AND x.plate LIKE ?))`);
        p.push(like, like, like, like, like, like, like, like, like);
      }
      const rows = all(`SELECT c.* FROM cases c WHERE ${where.join(' AND ')} ORDER BY c.updated_at DESC LIMIT 200`, ...p);
      const counts = Object.fromEntries(all(`SELECT c.type_key k, COUNT(*) n FROM cases c WHERE ${v.sql} GROUP BY c.type_key`, ...v.params).map((x) => [x.k, x.n]));
      return { cases: rows.map((c) => briefDto(c, ctx.user)), counts };
    });

    r.get('/api/cases/:id', { perm: 'cases.view' }, (ctx) => ({ case: detail(loadCase(ctx.user, ctx.params.id), ctx.user) }));

    r.post('/api/cases', { perm: 'cases.create' }, (ctx) => {
      const b = ctx.body, type = oneOf(b.type, Object.fromEntries(Object.keys(CASE_TYPES).map((k) => [k, 1])), 'Aktenart');
      const f = caseFields(b, false, ctx.user);
      const deptId = clampDept(ctx.user, b.departmentId === undefined ? defaultDept(ctx.user) : (b.departmentId === '' ? null : b.departmentId));
      const scope = b.scope === 'state' ? 'state' : 'department';
      if (scope === 'state' && !hasPerm(ctx.user, 'cases.share')) throw forbidden('Staatsweite Akten legt nur an, wer Akten freigeben darf (cases.share).');
      const t = now();
      const id = tx(() => {
        const cid = insert('cases', { case_number: nextCaseNumber(type), type_key: type, status: 'open', ...f, department_id: deptId, scope, lead_user_id: f.lead_user_id ?? ctx.user.id, created_by: ctx.user.id, created_at: t, updated_at: t });
        logEvent(cid, ctx.user.id, 'system', 'Akte angelegt');
        for (const p of Array.isArray(b.persons) ? b.persons.slice(0, 50) : []) addPerson(cid, p);
        for (const v of Array.isArray(b.vehicles) ? b.vehicles.slice(0, 30) : []) addVehicle(cid, v);
        return cid;
      });
      const c = get('SELECT * FROM cases WHERE id = ?', id);
      audit(ctx, { action: 'case.created', module: 'casefiles', targetType: 'case', targetId: id, targetLabel: `${c.case_number} · ${c.title}` });
      ctx.status = 201;
      return { case: detail(c, ctx.user) };
    });

    r.patch('/api/cases/:id', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), b = ctx.body, f = caseFields(b, true, ctx.user, c), lines = [];
      if (b.status !== undefined) {
        const st = oneOf(b.status, CASE_STATUSES, 'Status');
        if (['decided'].includes(st) && !hasPerm(ctx.user, 'cases.verdict')) throw forbidden('„Entschieden“ setzt nur, wer das Recht „cases.verdict“ hat.');
        if (st !== c.status) { f.status = st; f.closed_at = CLOSED_STATUSES.includes(st) ? now() : null; lines.push(`Status: ${CASE_STATUSES[c.status]?.label} → ${CASE_STATUSES[st].label}`); }
      }
      if (f.outcome !== undefined && f.outcome !== c.outcome && !hasPerm(ctx.user, 'cases.verdict')) throw forbidden('Das Ergebnis trägt nur ein, wer das Recht „cases.verdict“ hat.');
      if (f.priority && f.priority !== c.priority) lines.push(`Priorität: ${PRIORITIES[f.priority]}`);
      if (f.lead_user_id !== undefined && f.lead_user_id !== c.lead_user_id) lines.push(`Sachbearbeiter: ${f.lead_user_id ? labelForUser(f.lead_user_id) : '–'}`);
      if (b.departmentId !== undefined) {
        if (!seesAllDepartments(ctx.user)) throw forbidden('Die führende Behörde ändern nur Mitglieder mit dem Recht „Alle Behörden“.');
        f.department_id = b.departmentId === '' || b.departmentId == null ? null : (get('SELECT id FROM departments WHERE id = ?', b.departmentId)?.id ?? (() => { throw bad('Unbekannte Behörde.'); })());
        lines.push('Führende Behörde geändert');
      }
      tx(() => { update('cases', c.id, { ...f, updated_at: now() }); for (const l of lines) logEvent(c.id, ctx.user.id, 'status', l); });
      const n = get('SELECT * FROM cases WHERE id = ?', c.id);
      audit(ctx, { action: 'case.updated', module: 'casefiles', targetType: 'case', targetId: c.id, targetLabel: `${n.case_number} · ${n.title}`, after: { fields: Object.keys(f) } });
      return { case: detail(n, ctx.user) };
    });

    r.delete('/api/cases/:id', { perm: 'cases.delete' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id);
      run('DELETE FROM cases WHERE id = ?', c.id);
      audit(ctx, { action: 'case.deleted', module: 'casefiles', targetType: 'case', targetId: c.id, targetLabel: `${c.case_number} · ${c.title}` });
      return { ok: true };
    });

    // Freigabe (andere Behörden / staatsweit) und Team
    r.put('/api/cases/:id/share', { perm: 'cases.share' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), ids = intList(ctx.body.departmentIds, 'Behörden').filter((x) => get('SELECT 1 x FROM departments WHERE id = ?', x) && x !== c.department_id), scope = ctx.body.scope === 'state' ? 'state' : 'department';
      tx(() => { run('DELETE FROM case_departments WHERE case_id = ?', c.id); for (const d of ids) run('INSERT INTO case_departments (case_id, department_id) VALUES (?, ?)', c.id, d); run('UPDATE cases SET scope = ?, updated_at = ? WHERE id = ?', scope, now(), c.id); logEvent(c.id, ctx.user.id, 'system', scope === 'state' ? 'Akte staatsweit sichtbar' : `Freigabe für ${ids.length} weitere Behörde(n)`); });
      audit(ctx, { action: 'case.shared', module: 'casefiles', targetType: 'case', targetId: c.id, targetLabel: `${c.case_number} · ${c.title}`, after: { scope, departmentIds: ids } });
      return { case: detail(get('SELECT * FROM cases WHERE id = ?', c.id), ctx.user) };
    });
    r.put('/api/cases/:id/team', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), ids = intList(ctx.body.userIds, 'Team').filter((x) => get("SELECT 1 x FROM users WHERE id = ? AND status = 'active'", x));
      tx(() => { run('DELETE FROM case_team WHERE case_id = ?', c.id); for (const u of ids) run('INSERT INTO case_team (case_id, user_id) VALUES (?, ?)', c.id, u); touch(c.id); logEvent(c.id, ctx.user.id, 'system', `Team: ${ids.length} Mitglied(er)`); });
      notify(ids.filter((x) => x !== ctx.user.id).map((id) => ({ type: 'user', id })), { key: `case:${c.id}:team:${now()}`, title: `Du bist im Team der Akte ${c.case_number}`, body: c.title });
      return { case: detail(get('SELECT * FROM cases WHERE id = ?', c.id), ctx.user) };
    });

    // Personen
    r.post('/api/cases/:id/persons', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), pid = addPerson(c.id, ctx.body), p = get('SELECT * FROM case_persons WHERE id = ?', pid);
      touch(c.id); logEvent(c.id, ctx.user.id, 'system', `Person hinzugefügt: ${personDto(p).name} (${ROLES[p.role]})`);
      ctx.status = 201; return { case: detail(c, ctx.user) };
    });
    r.delete('/api/cases/:id/persons/:pid', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), p = get('SELECT * FROM case_persons WHERE id = ? AND case_id = ?', Number(ctx.params.pid), c.id);
      if (!p) throw notFound('Person nicht gefunden.');
      run('DELETE FROM case_persons WHERE id = ?', p.id); touch(c.id); logEvent(c.id, ctx.user.id, 'system', `Person entfernt: ${personDto(p).name}`);
      return { case: detail(c, ctx.user) };
    });

    // Tatvorwürfe
    r.post('/api/cases/:id/charges', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), cid = addCharge(c.id, ctx.body, ctx.user), ch = get('SELECT * FROM case_charges WHERE id = ?', cid);
      touch(c.id); logEvent(c.id, ctx.user.id, 'system', `Tatvorwurf: ${ch.title}${ch.count > 1 ? ` (${ch.count}×)` : ''}`);
      ctx.status = 201; return { case: detail(c, ctx.user) };
    });
    r.patch('/api/cases/:id/charges/:cid', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), ch = get('SELECT * FROM case_charges WHERE id = ? AND case_id = ?', Number(ctx.params.cid), c.id);
      if (!ch) throw notFound('Tatvorwurf nicht gefunden.');
      const b = ctx.body, o = {};
      if (b.status !== undefined) {
        oneOf(b.status, CHARGE_STATUS, 'Status');
        if (['convicted', 'acquitted'].includes(b.status) && !hasPerm(ctx.user, 'cases.verdict')) throw forbidden('Urteile (verurteilt/freigesprochen) trägt nur ein, wer das Recht „cases.verdict“ hat.');
        o.status = b.status;
      }
      if (b.count !== undefined) o.count = posInt(b.count, 'Anzahl', 999, 1) || 1;
      if (b.fineCents !== undefined) o.fine_cents = posInt(b.fineCents, 'Bußgeld (Cent)', 10_000_000_000);
      if (b.jailMonths !== undefined) o.jail_months = posInt(b.jailMonths, 'Haft (Monate)', 2400);
      if (b.note !== undefined) o.note = str(b.note, 'Notiz', { max: 500, required: false });
      if (b.statute !== undefined) o.statute = str(b.statute, 'Norm', { max: 60, required: false });
      update('case_charges', ch.id, o); touch(c.id);
      if (o.status && o.status !== ch.status) logEvent(c.id, ctx.user.id, 'decision', `${ch.title}: ${CHARGE_STATUS[o.status]}`);
      return { case: detail(c, ctx.user) };
    });
    r.delete('/api/cases/:id/charges/:cid', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), ch = get('SELECT * FROM case_charges WHERE id = ? AND case_id = ?', Number(ctx.params.cid), c.id);
      if (!ch) throw notFound('Tatvorwurf nicht gefunden.');
      run('DELETE FROM case_charges WHERE id = ?', ch.id); touch(c.id); logEvent(c.id, ctx.user.id, 'system', `Tatvorwurf entfernt: ${ch.title}`);
      return { case: detail(c, ctx.user) };
    });

    // Beweise
    const evidenceFields = (b, partial) => {
      const o = {};
      if (!partial || b.kind !== undefined) o.kind = oneOf(b.kind, EVIDENCE_KINDS, 'Art');
      if (!partial || b.title !== undefined) o.title = str(b.title, 'Bezeichnung', { min: 2, max: 160 });
      if (b.description !== undefined) o.description = str(b.description, 'Beschreibung', { max: 4000, required: false });
      if (b.location !== undefined) o.location = str(b.location, 'Lagerort', { max: 120, required: false });
      if (b.favors !== undefined) o.favors = oneOf(b.favors, FAVORS, 'Wirkung');
      if (b.collectedAt !== undefined) o.collected_at = DATETIME(b.collectedAt, 'Gesichert am');
      if (b.linkUrl !== undefined) { o.link_url = str(b.linkUrl, 'Link', { max: 500, required: false }); if (o.link_url && !/^https:\/\//i.test(o.link_url)) throw bad('Link: nur https-Adressen sind erlaubt.'); }
      return o;
    };
    r.post('/api/cases/:id/evidence', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), f = evidenceFields(ctx.body, false), n = get('SELECT COUNT(*) n FROM case_evidence WHERE case_id = ?', c.id).n + 1;
      const id = insert('case_evidence', { case_id: c.id, tag: `${c.case_number}/E${String(n).padStart(2, '0')}`, collected_by: ctx.user.id, collected_at: now(), ...f, created_at: now() });
      touch(c.id); logEvent(c.id, ctx.user.id, 'system', `Beweis gesichert: ${f.title}`);
      ctx.status = 201; return { case: detail(c, ctx.user), evidenceId: id };
    });
    r.patch('/api/cases/:id/evidence/:eid', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), e = get('SELECT * FROM case_evidence WHERE id = ? AND case_id = ?', Number(ctx.params.eid), c.id);
      if (!e) throw notFound('Beweis nicht gefunden.');
      update('case_evidence', e.id, evidenceFields(ctx.body, true)); touch(c.id);
      return { case: detail(c, ctx.user) };
    });
    r.delete('/api/cases/:id/evidence/:eid', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), e = get('SELECT * FROM case_evidence WHERE id = ? AND case_id = ?', Number(ctx.params.eid), c.id);
      if (!e) throw notFound('Beweis nicht gefunden.');
      run('DELETE FROM case_evidence WHERE id = ?', e.id); touch(c.id); logEvent(c.id, ctx.user.id, 'system', `Beweis entfernt: ${e.title}`);
      return { case: detail(c, ctx.user) };
    });

    // Fahrzeuge (Kennzeichen → Bürgerregister)
    r.post('/api/cases/:id/vehicles', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), vid = addVehicle(c.id, ctx.body), v = get('SELECT * FROM case_vehicles WHERE id = ?', vid);
      touch(c.id); logEvent(c.id, ctx.user.id, 'system', `Fahrzeug verknüpft: ${v.plate}`);
      ctx.status = 201; return { case: detail(c, ctx.user) };
    });
    r.delete('/api/cases/:id/vehicles/:vid', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), v = get('SELECT * FROM case_vehicles WHERE id = ? AND case_id = ?', Number(ctx.params.vid), c.id);
      if (!v) throw notFound('Fahrzeug nicht gefunden.');
      run('DELETE FROM case_vehicles WHERE id = ?', v.id); touch(c.id); logEvent(c.id, ctx.user.id, 'system', `Fahrzeug entfernt: ${v.plate}`);
      return { case: detail(c, ctx.user) };
    });

    // Verlauf
    r.post('/api/cases/:id/events', { perm: 'cases.edit' }, (ctx) => {
      const c = loadForEdit(ctx.user, ctx.params.id), text = str(ctx.body.text, 'Eintrag', { min: 2, max: 4000 });
      logEvent(c.id, ctx.user.id, 'note', text); touch(c.id);
      ctx.status = 201; return { case: detail(c, ctx.user) };
    });

    // Straftaten- und Bußgeldkatalog
    r.get('/api/cases/catalog/all', { perm: 'cases.view' }, () => ({ catalog: all('SELECT * FROM charge_catalog ORDER BY type_key, code, title').map((x) => ({ id: x.id, code: x.code, title: x.title, type: x.type_key, typeLabel: CASE_TYPES[x.type_key]?.label, description: x.description, fineCents: x.fine_cents, jailMonths: x.jail_months, isActive: !!x.is_active })) }));
    const catalogFields = (b, partial) => {
      const o = {};
      if (!partial || b.title !== undefined) o.title = str(b.title, 'Bezeichnung', { min: 2, max: 160 });
      if (b.code !== undefined) o.code = str(b.code, 'Kürzel', { max: 20, required: false });
      if (!partial || b.type !== undefined) o.type_key = oneOf(b.type, CASE_TYPES, 'Aktenart');
      if (b.description !== undefined) o.description = str(b.description, 'Beschreibung', { max: 1000, required: false });
      if (b.fineCents !== undefined) o.fine_cents = posInt(b.fineCents, 'Bußgeld (Cent)', 10_000_000_000);
      if (b.jailMonths !== undefined) o.jail_months = posInt(b.jailMonths, 'Haft (Monate)', 2400);
      if (b.isActive !== undefined) o.is_active = b.isActive ? 1 : 0;
      return o;
    };
    r.post('/api/cases/catalog', { perm: 'cases.catalog' }, (ctx) => {
      const f = catalogFields(ctx.body, false);
      if (get('SELECT 1 x FROM charge_catalog WHERE title = ? COLLATE NOCASE', f.title)) throw conflict('Diesen Katalogeintrag gibt es schon.');
      const id = insert('charge_catalog', f);
      audit(ctx, { action: 'case.catalog_added', module: 'casefiles', targetType: 'catalog', targetId: id, targetLabel: f.title });
      ctx.status = 201; return { id };
    });
    r.patch('/api/cases/catalog/:id', { perm: 'cases.catalog' }, (ctx) => {
      const x = get('SELECT * FROM charge_catalog WHERE id = ?', Number(ctx.params.id)); if (!x) throw notFound('Katalogeintrag nicht gefunden.');
      const f = catalogFields(ctx.body, true);
      if (f.title && get('SELECT 1 x FROM charge_catalog WHERE title = ? COLLATE NOCASE AND id != ?', f.title, x.id)) throw conflict('Diesen Katalogeintrag gibt es schon.');
      update('charge_catalog', x.id, f); audit(ctx, { action: 'case.catalog_updated', module: 'casefiles', targetType: 'catalog', targetId: x.id, targetLabel: f.title ?? x.title });
      return { ok: true };
    });
    r.delete('/api/cases/catalog/:id', { perm: 'cases.catalog' }, (ctx) => {
      const x = get('SELECT * FROM charge_catalog WHERE id = ?', Number(ctx.params.id)); if (!x) throw notFound('Katalogeintrag nicht gefunden.');
      run('DELETE FROM charge_catalog WHERE id = ?', x.id); audit(ctx, { action: 'case.catalog_removed', module: 'casefiles', targetType: 'catalog', targetId: x.id, targetLabel: x.title });
      return { ok: true };
    });
  },
};
