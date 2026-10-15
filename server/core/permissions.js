import { all, get, run, tx } from './db.js';

/** Registry: Module melden ihre Permissions an, sie werden beim Start in die DB synchronisiert. */
const registry = new Map();
export function registerPermissions(module, list) {
  for (const [key, description] of list) registry.set(key, { key, module, description });
}

export function syncPermissions() {
  tx(() => {
    for (const p of registry.values()) {
      run(
        `INSERT INTO permissions (key,module,description,is_custom) VALUES (?,?,?,0)
         ON CONFLICT(key) DO UPDATE SET module=excluded.module, description=excluded.description`,
        p.key, p.module, p.description,
      );
    }
    for (const row of all('SELECT key FROM permissions WHERE is_custom = 0')) {
      if (!registry.has(row.key)) run('DELETE FROM permissions WHERE key = ?', row.key);
    }
  });
}

export const listPermissions = () => all('SELECT key,module,description,is_custom FROM permissions ORDER BY module,key');
export const permissionExists = (k) => !!get('SELECT 1 x FROM permissions WHERE key = ?', k);

/** Effektive Rechte: Rollen (Union) + direkt zugewiesene Rechte. Admin-Rolle = alles. */
export function loadAccess(userId) {
  const roles = all(
    `SELECT r.id,r.name,r.color,r.is_admin FROM roles r JOIN user_roles ur ON ur.role_id=r.id
     WHERE ur.user_id=? ORDER BY r.sort_order,r.name`, userId,
  );
  const isSuperadmin = !!get('SELECT is_superadmin s FROM users WHERE id = ?', userId)?.s;
  const isAdmin = isSuperadmin || roles.some((r) => r.is_admin);
  let perms;
  // Superadmin/Administrator: IMMER alle Rechte – aus der Datenbank (inkl. eigener Rechte) UND aus dem Code-Registry, damit auch ein frisch hinzugekommenes Recht sofort gilt
  if (isAdmin) perms = new Set([...all('SELECT key FROM permissions').map((r) => r.key), ...registry.keys()]);
  else {
    perms = new Set(all(
      `SELECT DISTINCT rp.permission_key k FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=?
       UNION SELECT permission_key FROM user_permissions WHERE user_id=?
       UNION SELECT rp.permission_key FROM rank_permissions rp JOIN users u ON u.rank_id=rp.rank_id WHERE u.id=?`, userId, userId, userId,
    ).map((r) => r.k));
  }
  return { roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.color, isAdmin: !!r.is_admin })), isAdmin, isSuperadmin, perms };
}

export const can = (user, perm) => !!user && user.status === 'active' && user.perms.has(perm);
export const canAny = (user, list) => list.some((p) => can(user, p));
