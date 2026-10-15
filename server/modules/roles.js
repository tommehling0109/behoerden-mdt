import { all, get, run, tx, now } from '../core/db.js';
import { bad, conflict, forbidden, notFound, str, strList } from '../core/http.js';
import { permissionExists } from '../core/permissions.js';
import { audit } from '../core/audit.js';

const dto = (r) => ({
  id: r.id, name: r.name, description: r.description, color: r.color, isAdmin: !!r.is_admin, isSystem: !!r.is_system,
  sortOrder: r.sort_order, memberCount: r.member_count ?? 0,
  permissions: r.is_admin ? null : all('SELECT permission_key k FROM role_permissions WHERE role_id = ?', r.id).map((x) => x.k),
});
const loadRole = (id) => {
  const r = get(`SELECT r.*, (SELECT COUNT(*) FROM user_roles WHERE role_id=r.id) member_count FROM roles r WHERE r.id = ?`, id);
  return r ? dto(r) : null;
};
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function setPerms(roleId, keys) {
  run('DELETE FROM role_permissions WHERE role_id = ?', roleId);
  for (const k of keys) run('INSERT INTO role_permissions (role_id,permission_key) VALUES (?,?)', roleId, k);
}
function checkGrantable(actor, keys, existing = []) {
  const old = new Set(existing);
  for (const k of keys) {
    if (!permissionExists(k)) throw bad(`Unbekanntes Recht: ${k}`);
    if (!actor.isAdmin && !old.has(k) && !actor.perms.has(k)) throw forbidden(`Du kannst das Recht „${k}“ nicht vergeben, da du es selbst nicht besitzt.`);
  }
}

export default {
  name: 'roles',
  permissions: [
    ['roles.view', 'Rollen ansehen'],
    ['roles.manage', 'Rollen erstellen, bearbeiten und löschen'],
  ],
  routes(r) {
    r.get('/api/roles', { perm: ['roles.view', 'users.view'] }, () => ({
      roles: all(`SELECT r.*, (SELECT COUNT(*) FROM user_roles WHERE role_id=r.id) member_count FROM roles r ORDER BY sort_order, name`).map(dto),
    }));

    r.post('/api/roles', { perm: 'roles.manage' }, (ctx) => {
      const b = ctx.body;
      const name = str(b.name, 'Name', { min: 2, max: 40 });
      const description = str(b.description, 'Beschreibung', { max: 200, required: false });
      const color = b.color && COLOR_RE.test(b.color) ? b.color : '#5b8def';
      const perms = strList(b.permissions, 'Rechte');
      checkGrantable(ctx.user, perms);
      if (get('SELECT 1 x FROM roles WHERE name = ?', name)) throw conflict('Eine Rolle mit diesem Namen existiert bereits.');
      const id = tx(() => {
        const max = get('SELECT COALESCE(MAX(sort_order),0) m FROM roles').m;
        const res = run('INSERT INTO roles (name,description,color,is_admin,is_system,sort_order,created_at) VALUES (?,?,?,0,0,?,?)', name, description, color, max + 1, now());
        setPerms(Number(res.lastInsertRowid), perms);
        return Number(res.lastInsertRowid);
      });
      audit(ctx, { action: 'role.created', module: 'roles', targetType: 'role', targetId: id, targetLabel: name, after: { name, description, permissions: perms } });
      ctx.status = 201;
      return { role: loadRole(id) };
    });

    r.patch('/api/roles/:id', { perm: 'roles.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = loadRole(id);
      if (!cur) throw notFound('Rolle nicht gefunden.');
      if (cur.isAdmin && !ctx.user.isAdmin) throw forbidden('Administrator-Rollen dürfen nur von Administratoren bearbeitet werden.');
      const b = ctx.body;
      tx(() => {
        if (b.name !== undefined) {
          const name = str(b.name, 'Name', { min: 2, max: 40 });
          const dup = get('SELECT id FROM roles WHERE name = ? AND id != ?', name, id);
          if (dup) throw conflict('Eine Rolle mit diesem Namen existiert bereits.');
          run('UPDATE roles SET name = ? WHERE id = ?', name, id);
        }
        if (b.description !== undefined) run('UPDATE roles SET description = ? WHERE id = ?', str(b.description, 'Beschreibung', { max: 200, required: false }), id);
        if (b.color !== undefined) {
          if (!COLOR_RE.test(b.color)) throw bad('Ungültige Farbe.');
          run('UPDATE roles SET color = ? WHERE id = ?', b.color, id);
        }
        if (b.permissions !== undefined) {
          if (cur.isAdmin) throw bad('Die Rechte einer Administrator-Rolle sind immer vollständig und nicht änderbar.');
          const keys = strList(b.permissions, 'Rechte');
          checkGrantable(ctx.user, keys, cur.permissions);
          setPerms(id, keys);
        }
      });
      const after = loadRole(id);
      audit(ctx, { action: 'role.updated', module: 'roles', targetType: 'role', targetId: id, targetLabel: after.name,
        before: { name: cur.name, description: cur.description, color: cur.color, permissions: cur.permissions },
        after: { name: after.name, description: after.description, color: after.color, permissions: after.permissions } });
      return { role: after };
    });

    r.delete('/api/roles/:id', { perm: 'roles.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = loadRole(id);
      if (!cur) throw notFound('Rolle nicht gefunden.');
      if (cur.isSystem) throw forbidden('Systemrollen können nicht gelöscht werden.');
      if (cur.memberCount > 0) throw conflict(`Die Rolle ist noch ${cur.memberCount} Benutzer(n) zugewiesen. Entferne sie zuerst dort.`);
      run('DELETE FROM roles WHERE id = ?', id);
      audit(ctx, { action: 'role.deleted', module: 'roles', targetType: 'role', targetId: id, targetLabel: cur.name, before: { name: cur.name, permissions: cur.permissions } });
      return { ok: true };
    });
  },
};
