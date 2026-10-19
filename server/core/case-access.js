import { all, get } from './db.js';
import { seesAllDepartments, deptIdsOf } from './scope.js';

/** Aktenarten (Kürzel = Aktenzeichen-Präfix). */
export const CASE_TYPES = {
  misdemeanor: { label: 'Ordnungswidrigkeit', prefix: 'OWI', color: '#f59e0b' },
  criminal: { label: 'Straftat', prefix: 'ST', color: '#ef4444' },
  traffic: { label: 'Verkehrsvorfall', prefix: 'VK', color: '#06b6d4' },
  administrative: { label: 'Verwaltungsrecht', prefix: 'VW', color: '#64748b' },
  civil: { label: 'Zivilrecht', prefix: 'ZV', color: '#5b8def' },
  investigation: { label: 'Ermittlungsverfahren', prefix: 'EV', color: '#a855f7' },
};
export const CASE_STATUSES = {
  open: { label: 'Offen', color: '#5b8def' },
  investigating: { label: 'In Ermittlung', color: '#f59e0b' },
  proceeding: { label: 'Im Verfahren', color: '#a78bfa' },
  decided: { label: 'Entschieden', color: '#10b981' },
  closed: { label: 'Abgeschlossen', color: '#64748b' },
  dropped: { label: 'Eingestellt', color: '#94a3b8' },
};
export const CLOSED_STATUSES = ['decided', 'closed', 'dropped'];

const has = (user, p) => !!(user.isAdmin || user.isSuperadmin || user.perms.has(p));
export const hasPerm = has;

const teamSql = (alias) => `EXISTS (SELECT 1 FROM case_team t WHERE t.case_id = ${alias}.id AND t.user_id = ?)`;

/**
 * Sichtbarkeit von Akten: eigene Behörde, mit der Behörde geteilte Akten, staatsweite Akten und Akten, in denen man selbst im Team steht.
 * Vertrauliche Akten sieht nur, wer das Recht „cases.confidential“ hat oder zum Team (Ersteller, Sachbearbeiter, Team) gehört.
 */
export function caseVisible(user, alias = 'c') {
  const parts = [], params = [];
  if (!seesAllDepartments(user)) {
    const ids = deptIdsOf(user), inList = ids.map(() => '?').join(',');
    const own = [`${alias}.department_id IS NULL`, `${alias}.scope = 'state'`];
    if (ids.length) { own.push(`${alias}.department_id IN (${inList})`); params.push(...ids); own.push(`EXISTS (SELECT 1 FROM case_departments cd WHERE cd.case_id = ${alias}.id AND cd.department_id IN (${inList}))`); params.push(...ids); }
    own.push(`${alias}.created_by = ?`, `${alias}.lead_user_id = ?`, teamSql(alias)); params.push(user.id, user.id, user.id);
    parts.push(`(${own.join(' OR ')})`);
  }
  if (!has(user, 'cases.confidential')) { parts.push(`(${alias}.confidential = 0 OR ${alias}.created_by = ? OR ${alias}.lead_user_id = ? OR ${teamSql(alias)})`); params.push(user.id, user.id, user.id); }
  return { sql: parts.length ? parts.join(' AND ') : '1 = 1', params };
}

/** Darf der Benutzer diese Akte sehen? (Prüfung über dieselbe SQL-Regel, damit Liste und Detail nie auseinanderlaufen.) */
export function canSeeCase(user, caseId) {
  if (!has(user, 'cases.view')) return false;
  const v = caseVisible(user, 'c');
  return !!get(`SELECT 1 x FROM cases c WHERE c.id = ? AND ${v.sql}`, caseId, ...v.params);
}

/** Sichtbare Akten, in denen ein Bürger vorkommt (für das Bürgerregister). */
export function casesOfCitizen(user, citizenId) {
  if (!has(user, 'cases.view')) return [];
  const v = caseVisible(user, 'c');
  return all(`SELECT DISTINCT c.id, c.case_number, c.type_key, c.title, c.status, c.incident_at, c.department_id, p.role
    FROM case_persons p JOIN cases c ON c.id = p.case_id WHERE p.citizen_id = ? AND ${v.sql} ORDER BY c.created_at DESC LIMIT 100`, citizenId, ...v.params);
}
export function casesOfPlate(user, plate) {
  if (!has(user, 'cases.view')) return [];
  const v = caseVisible(user, 'c');
  return all(`SELECT DISTINCT c.id, c.case_number, c.type_key, c.title, c.status, c.incident_at, c.department_id
    FROM case_vehicles cv JOIN cases c ON c.id = cv.case_id WHERE cv.plate = ? COLLATE NOCASE AND ${v.sql} ORDER BY c.created_at DESC LIMIT 50`, plate, ...v.params);
}
