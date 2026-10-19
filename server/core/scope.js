import { all } from './db.js';
import { forbidden, notFound } from './http.js';

/**
 * Behörden-Trennung: Jede Behörde (= Abteilung) führt ihre eigenen Fahrzeuge, Lager und Mitglieder.
 * Ein Mitglied sieht und bearbeitet nur Datensätze der eigenen Behörde sowie der Behörden, auf die es zusätzlich freigeschaltet ist
 * (Tabelle user_departments). Datensätze ohne Behörde („behördenübergreifend“) sind für alle sichtbar.
 * Alle Behörden sehen: Superadmin, Administrator-Rollen und das Recht „departments.all“.
 */
export const seesAllDepartments = (u) => !!(u && (u.isSuperadmin || u.isAdmin || u.perms?.has('departments.all')));

/** Behörden-IDs, auf die das Mitglied Zugriff hat (eigene + zusätzlich freigeschaltete). */
export function deptIdsOf(u) {
  const ids = new Set();
  if (u?.department?.id) ids.add(u.department.id);
  if (u?.id) for (const r of all('SELECT department_id d FROM user_departments WHERE user_id = ?', u.id)) ids.add(r.d);
  return [...ids];
}

/** Darf das Mitglied Datensätze dieser Behörde sehen? (null = behördenübergreifend → ja) */
export const canSeeDept = (u, deptId) => deptId == null || seesAllDepartments(u) || deptIdsOf(u).includes(deptId);

/** 404 statt 403, damit die Existenz fremder Datensätze nicht verraten wird. */
export function requireDept(u, deptId, msg = 'Nicht gefunden.') {
  if (!canSeeDept(u, deptId)) throw notFound(msg);
}

/** SQL-Filter für Listen: `col IS NULL OR col IN (…)`; für „alle Behörden“ ein leerer Filter. */
export function deptWhere(u, col) {
  if (seesAllDepartments(u)) return { sql: '1 = 1', params: [] };
  const ids = deptIdsOf(u);
  return ids.length ? { sql: `(${col} IS NULL OR ${col} IN (${ids.map(() => '?').join(',')}))`, params: ids } : { sql: `${col} IS NULL`, params: [] };
}

/** Behörden, denen das Mitglied Datensätze zuordnen darf. */
export function assignableDepts(u) {
  const rows = all('SELECT id, name, color FROM departments ORDER BY sort_order, name');
  if (seesAllDepartments(u)) return rows;
  const ids = new Set(deptIdsOf(u));
  return rows.filter((d) => ids.has(d.id));
}

export const defaultDept = (u) => u?.department?.id ?? null;

/** Prüft die gewünschte Behörde eines neuen/geänderten Datensatzes; ohne Angabe gilt die eigene Behörde. */
export function clampDept(u, requested) {
  if (requested == null) return seesAllDepartments(u) ? null : (defaultDept(u) ?? null);
  if (!canSeeDept(u, requested)) throw forbidden('Für diese Behörde darfst du keine Einträge anlegen oder ändern.');
  return requested;
}
