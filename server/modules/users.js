import { all, get, run, tx, now } from '../core/db.js';
import { bad, conflict, forbidden, notFound, str, intList, strList } from '../core/http.js';
import { hashPassword, checkPassword, destroyUserSessions } from '../core/auth.js';
import { loadAccess, permissionExists } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { assignMemberNumber } from '../core/members.js';
import { memberLabel } from '../core/identity.js';
import { purgeUserFiles } from '../core/purge.js';

const SUPERADMIN_ROLE = { id: -1, name: 'Superadmin', color: '#f59e0b', isSystem: true };
const MEMBER_NO_RE = /^[A-Za-z0-9-]{2,20}$/;

const STATUSES = ['pending', 'active', 'blocked', 'rejected'];
const USERNAME_RE = /^[\p{L}\p{N}._-]+$/u;

const ORG_JOIN = `SELECT u.*, r.name rank_name, r.color rank_color, d.name dept_name, d.color dept_color,
  s.member_number supervisor_number
  FROM users u LEFT JOIN ranks r ON r.id=u.rank_id LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN users s ON s.id=u.supervisor_id`;

/**
 * Anonymität mit Hierarchie: Den echten Namen sieht man bei sich selbst, als Superadmin sowie bei Mitgliedern, die in der Hierarchie UNTER einem stehen
 * (übergeordneter Rang oder Vorgesetzten-Kette). Alle anderen sehen nur die Personalnummer.
 */
const viewerOf = (u) => (u && typeof u === 'object' ? { id: u.id, isSuperadmin: !!u.isSuperadmin, rankId: u.rank?.id ?? null } : { id: u ?? null });
function mayUnmask(viewer, u) {
  if (!viewer?.id) return false;
  if (u.id === viewer.id || viewer.isSuperadmin) return true;
  if (viewer.rankId && u.rank_id) {
    let cur = get('SELECT parent_rank_id p FROM ranks WHERE id = ?', u.rank_id)?.p;
    for (let g = 0; cur && g < 30; g++) { if (cur === viewer.rankId) return true; cur = get('SELECT parent_rank_id p FROM ranks WHERE id = ?', cur)?.p; }
  }
  let s = u.supervisor_id;
  for (let g = 0; s && g < 30; g++) { if (s === viewer.id) return true; s = get('SELECT supervisor_id s FROM users WHERE id = ?', s)?.s; }
  return false;
}
const listDto = (u, viewerIn = null) => { const viewer = viewerOf(viewerIn), see = mayUnmask(viewer, u), viewerId = viewer.id; return {
  id: u.id, isSelf: u.id === viewerId, isSuperadmin: !!u.is_superadmin, nameVisible: see,
  username: see || u.status === 'pending' ? u.username : null,
  displayName: see ? u.display_name : memberLabel(u),
  status: u.status, statusReason: u.status_reason, avatarUrl: u.avatar_ext ? `/api/avatars/${u.id}?v=${u.avatar_version}` : null,
  createdAt: u.created_at, lastLoginAt: u.last_login_at, memberNumber: u.member_number,
  rank: u.rank_id ? { id: u.rank_id, name: u.rank_name, color: u.rank_color } : null,
  department: u.department_id ? { id: u.department_id, name: u.dept_name, color: u.dept_color } : null,
  supervisor: u.supervisor_id ? { id: u.supervisor_id, displayName: u.supervisor_id === viewerId ? 'Du' : (u.supervisor_number || `Mitglied #${u.supervisor_id}`), memberNumber: u.supervisor_number } : null,
}; };

function detail(id, viewerId = null) {
  const u = get(`${ORG_JOIN} WHERE u.id = ?`, id);
  if (!u) return null;
  const acc = loadAccess(id);
  return {
    ...listDto(u, viewerId), roles: u.is_superadmin ? [SUPERADMIN_ROLE, ...acc.roles] : acc.roles, isAdmin: acc.isAdmin,
    directPermissions: all('SELECT permission_key k FROM user_permissions WHERE user_id = ?', id).map((r) => r.k),
    effectivePermissions: [...acc.perms],
  };
}

const optId = (v, table, label) => {
  if (v == null || v === '') return null;
  if (!Number.isInteger(v) || !get(`SELECT 1 x FROM ${table} WHERE id = ?`, v)) throw bad(`${label}: unbekannter Eintrag.`);
  return v;
};

/** Ein Rang bringt ggf. eigene Rechte mit – Nicht-Admins dürfen nur Ränge vergeben, deren Rechte sie selbst besitzen. */
function assertCanAssignRank(actor, rankId) {
  if (rankId == null || actor.isAdmin) return;
  for (const { k } of all('SELECT permission_key k FROM rank_permissions WHERE rank_id = ?', rankId)) {
    if (!actor.perms.has(k)) throw forbidden(`Dieser Rang enthält das Recht „${k}“, das du selbst nicht besitzt.`);
  }
}

function assertSupervisor(userId, supervisorId) {
  if (supervisorId == null) return;
  if (supervisorId === userId) throw bad('Ein Mitglied kann nicht sein eigener Vorgesetzter sein.');
  let cur = supervisorId;
  const seen = new Set();
  while (cur != null && !seen.has(cur)) {
    if (cur === userId) throw bad('Die Vorgesetzten-Kette darf keine Schleife enthalten.');
    seen.add(cur);
    cur = get('SELECT supervisor_id s FROM users WHERE id = ?', cur)?.s ?? null;
  }
}

/** Wie viele aktive Administratoren gibt es außer diesem Benutzer? (Schutz vor Aussperrung) */
const otherActiveAdmins = (id) => get(
  `SELECT COUNT(DISTINCT u.id) c FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
   WHERE r.is_admin=1 AND u.status='active' AND u.id != ?`, id).c;

const isActiveAdmin = (id) => {
  const u = get('SELECT status FROM users WHERE id = ?', id);
  return u?.status === 'active' && loadAccess(id).isAdmin;
};

/** Nur Administratoren dürfen Admin-Rollen vergeben; Nicht-Admins nur Rechte, die sie selbst besitzen. */
function assertCanAssign(actor, roleIds, permKeys) {
  for (const rid of roleIds) {
    const role = get('SELECT is_admin FROM roles WHERE id = ?', rid);
    if (!role) throw bad('Unbekannte Rolle.');
    if (role.is_admin && !actor.isAdmin) throw forbidden('Administrator-Rollen dürfen nur von Administratoren vergeben werden.');
  }
  for (const k of permKeys) {
    if (!permissionExists(k)) throw bad(`Unbekanntes Recht: ${k}`);
    if (!actor.isAdmin && !actor.perms.has(k)) throw forbidden(`Du kannst das Recht „${k}“ nicht vergeben, da du es selbst nicht besitzt.`);
  }
}

function setRoles(userId, roleIds) {
  run('DELETE FROM user_roles WHERE user_id = ?', userId);
  for (const rid of roleIds) run('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)', userId, rid);
}
function setDirectPerms(userId, keys) {
  run('DELETE FROM user_permissions WHERE user_id = ?', userId);
  for (const k of keys) run('INSERT INTO user_permissions (user_id,permission_key) VALUES (?,?)', userId, k);
}
const snapshot = (id) => {
  const d = detail(id, null);
  return { // bewusst ohne Namen (Anonymität): Protokolle zeigen nur Nummern
    status: d.status, roles: d.roles.map((r) => r.name), permissions: d.directPermissions,
    memberNumber: d.memberNumber, rank: d.rank?.name ?? null, department: d.department?.name ?? null, supervisor: d.supervisor?.memberNumber ?? null,
  };
};

export default {
  name: 'users',
  permissions: [
    ['users.view', 'Benutzer ansehen'],
    ['users.create', 'Benutzer anlegen'],
    ['users.edit', 'Benutzer bearbeiten (Rang, Abteilung, Vorgesetzter, Rollen, direkte Rechte)'],
    ['users.password_reset', 'Passwörter anderer Mitglieder zurücksetzen'],
    ['users.delete', 'Benutzer löschen'],
    ['users.approve', 'Benutzer freischalten, ablehnen, sperren'],
  ],
  routes(r) {
    r.get('/api/users', { perm: 'users.view' }, (ctx) => {
      const { status, q } = ctx.query;
      const where = [];
      const p = [];
      if (status && STATUSES.includes(status)) { where.push('u.status = ?'); p.push(status); }
      // Suche nur nach Personalnummer (bzw. Login von Bewerbern) – Namen lassen sich so nicht erraten
      if (q) { where.push("(u.member_number LIKE ? OR (u.status = 'pending' AND u.username LIKE ?))"); p.push(`%${q}%`, `%${q}%`); }
      const rows = all(`${ORG_JOIN} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.created_at DESC`, ...p);
      const roles = all('SELECT ur.user_id, r.id, r.name, r.color FROM user_roles ur JOIN roles r ON r.id=ur.role_id ORDER BY r.sort_order,r.name');
      const counts = Object.fromEntries(all('SELECT status, COUNT(*) c FROM users GROUP BY status').map((x) => [x.status, x.c]));
      return {
        counts,
        users: rows.map((u) => ({ ...listDto(u, ctx.user), roles: [...(u.is_superadmin ? [SUPERADMIN_ROLE] : []), ...roles.filter((x) => x.user_id === u.id).map(({ id, name, color }) => ({ id, name, color }))] })),
      };
    });

    r.get('/api/users/:id', { perm: 'users.view' }, (ctx) => {
      const d = detail(Number(ctx.params.id), ctx.user);
      if (!d) throw notFound('Benutzer nicht gefunden.');
      return { user: d };
    });

    r.post('/api/users', { perm: 'users.create' }, (ctx) => {
      const b = ctx.body;
      const username = str(b.username, 'Benutzername', { min: 3, max: 32 });
      if (!USERNAME_RE.test(username)) throw bad('Benutzername darf nur Buchstaben, Zahlen sowie . _ - enthalten.');
      const displayName = str(b.displayName, 'Anzeigename', { min: 2, max: 60 });
      const pwErr = checkPassword(b.password);
      if (pwErr) throw bad(pwErr);
      const roleIds = intList(b.roleIds, 'Rollen');
      const status = b.status === 'pending' ? 'pending' : 'active';
      assertCanAssign(ctx.user, roleIds, []);
      const rankId = optId(b.rankId, 'ranks', 'Rang');
      const departmentId = optId(b.departmentId, 'departments', 'Abteilung');
      assertCanAssignRank(ctx.user, rankId);
      if (get('SELECT 1 x FROM users WHERE username = ?', username)) throw conflict('Dieser Benutzername ist bereits vergeben.');
      let memberNo = null;
      if (b.memberNumber != null && String(b.memberNumber).trim() !== '') {
        if (!ctx.user.isSuperadmin) throw forbidden('Personalnummern vergibt nur der Superadmin.');
        memberNo = String(b.memberNumber).trim().toUpperCase();
        if (!MEMBER_NO_RE.test(memberNo)) throw bad('Personalnummer: 2–20 Zeichen (Buchstaben, Ziffern, Bindestrich).');
        if (get('SELECT 1 x FROM users WHERE member_number = ?', memberNo)) throw conflict('Diese Personalnummer ist bereits vergeben.');
      }
      const id = tx(() => {
        const t = now();
        const res = run('INSERT INTO users (username,display_name,password_hash,status,rank_id,department_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
          username, displayName, hashPassword(b.password), status, rankId, departmentId, t, t);
        const uid = Number(res.lastInsertRowid);
        setRoles(uid, roleIds);
        if (memberNo) run('UPDATE users SET member_number = ? WHERE id = ?', memberNo, uid);
        if (status === 'active') assignMemberNumber(uid);
        return uid;
      });
      audit(ctx, { action: 'user.created', module: 'users', targetType: 'user', targetId: id, targetLabel: memberLabel(get('SELECT id, member_number, status FROM users WHERE id = ?', id)), after: snapshot(id) });
      ctx.status = 201;
      return { user: detail(id, ctx.user) };
    });

    r.patch('/api/users/:id', { perm: 'users.edit' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get('SELECT * FROM users WHERE id = ?', id);
      if (!cur) throw notFound('Benutzer nicht gefunden.');
      const b = ctx.body;
      const before = snapshot(id);
      const target = loadAccess(id);
      if (target.isAdmin && !ctx.user.isAdmin) throw forbidden('Administratoren dürfen nur von Administratoren bearbeitet werden.');
      if (target.isSuperadmin && !ctx.user.isSuperadmin) throw forbidden('Superadmins dürfen nur von Superadmins bearbeitet werden.');

      tx(() => {
        if (b.isSuperadmin !== undefined) throw forbidden('Die Rolle „Superadmin“ entsteht bei der Einrichtung des Systems und kann weder vergeben noch entzogen werden.');
        if (b.memberNumber !== undefined) {
          if (!ctx.user.isSuperadmin) throw forbidden('Personalnummern ändert nur der Superadmin.');
          const mn = String(b.memberNumber ?? '').trim().toUpperCase();
          if (!MEMBER_NO_RE.test(mn)) throw bad('Personalnummer: 2–20 Zeichen (Buchstaben, Ziffern, Bindestrich).');
          if (get('SELECT 1 x FROM users WHERE member_number = ? AND id != ?', mn, id)) throw conflict('Diese Personalnummer ist bereits vergeben.');
          run('UPDATE users SET member_number = ?, updated_at = ? WHERE id = ?', mn, now(), id);
        }
        if (b.displayName !== undefined) {
          if (id !== ctx.user.id) throw forbidden('Namen anderer Mitglieder sind nicht einsehbar und werden hier nicht geändert.');
          run('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', str(b.displayName, 'Anzeigename', { min: 2, max: 60 }), now(), id);
        }
        if (b.roleIds !== undefined) {
          const roleIds = intList(b.roleIds, 'Rollen');
          const keepsAdmin = roleIds.some((rid) => get('SELECT is_admin FROM roles WHERE id = ?', rid)?.is_admin);
          if (isActiveAdmin(id) && !keepsAdmin && otherActiveAdmins(id) === 0) throw conflict('Der letzte aktive Administrator kann seine Administrator-Rolle nicht verlieren.');
          const oldIds = new Set(all('SELECT role_id FROM user_roles WHERE user_id = ?', id).map((x) => x.role_id));
          assertCanAssign(ctx.user, roleIds.filter((x) => !oldIds.has(x)), []);
          setRoles(id, roleIds);
        }
        if (b.permissions !== undefined) {
          const keys = strList(b.permissions, 'Rechte');
          const old = new Set(all('SELECT permission_key k FROM user_permissions WHERE user_id = ?', id).map((x) => x.k));
          assertCanAssign(ctx.user, [], keys.filter((k) => !old.has(k)));
          setDirectPerms(id, keys);
        }
        if (b.rankId !== undefined) {
          const rankId = optId(b.rankId, 'ranks', 'Rang');
          if (rankId !== cur.rank_id) assertCanAssignRank(ctx.user, rankId);
          run('UPDATE users SET rank_id = ?, updated_at = ? WHERE id = ?', rankId, now(), id);
        }
        if (b.departmentId !== undefined) run('UPDATE users SET department_id = ?, updated_at = ? WHERE id = ?', optId(b.departmentId, 'departments', 'Abteilung'), now(), id);
        if (b.supervisorId !== undefined) {
          const sid = optId(b.supervisorId, 'users', 'Vorgesetzter');
          assertSupervisor(id, sid);
          run('UPDATE users SET supervisor_id = ?, updated_at = ? WHERE id = ?', sid, now(), id);
        }
      });
      audit(ctx, { action: 'user.updated', module: 'users', targetType: 'user', targetId: id, targetLabel: memberLabel(cur), before, after: snapshot(id) });
      return { user: detail(id, ctx.user) };
    });

    // Statuswechsel: Freischalten / Ablehnen / Sperren / Entsperren
    r.post('/api/users/:id/status', { perm: 'users.approve' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get('SELECT * FROM users WHERE id = ?', id);
      if (!cur) throw notFound('Benutzer nicht gefunden.');
      const status = ctx.body.status;
      if (!STATUSES.includes(status)) throw bad('Ungültiger Status.');
      const reason = str(ctx.body.reason, 'Begründung', { max: 300, required: false });
      if (id === ctx.user.id) throw forbidden('Du kannst deinen eigenen Status nicht ändern.');
      if (loadAccess(id).isAdmin && !ctx.user.isAdmin) throw forbidden('Administratoren dürfen nur von Administratoren verwaltet werden.');
      if (cur.is_superadmin && !ctx.user.isSuperadmin) throw forbidden('Superadmins dürfen nur von Superadmins verwaltet werden.');
      if (status !== 'active' && isActiveAdmin(id) && otherActiveAdmins(id) === 0) throw conflict('Der letzte aktive Administrator kann nicht gesperrt werden.');
      const roleIds = ctx.body.roleIds !== undefined ? intList(ctx.body.roleIds, 'Rollen') : null;

      const before = snapshot(id);
      tx(() => {
        run('UPDATE users SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?', status, reason || null, now(), id);
        if (roleIds) { assertCanAssign(ctx.user, roleIds, []); setRoles(id, roleIds); }
        if (status === 'active') assignMemberNumber(id); // erste Freischaltung ⇒ Mitglied ⇒ Nummer (bleibt danach dauerhaft)
      });
      if (status === 'blocked' || status === 'rejected') destroyUserSessions(id);
      const action = { active: cur.status === 'pending' ? 'user.approved' : 'user.unblocked', blocked: 'user.blocked', rejected: 'user.rejected', pending: 'user.reset_pending' }[status];
      audit(ctx, { action, module: 'users', targetType: 'user', targetId: id, targetLabel: memberLabel(cur), before, after: { ...snapshot(id), reason: reason || undefined } });
      return { user: detail(id, ctx.user) };
    });

    r.post('/api/users/:id/password', { perm: 'users.password_reset' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get('SELECT id, member_number, status FROM users WHERE id = ?', id);
      if (!cur) throw notFound('Benutzer nicht gefunden.');
      if (loadAccess(id).isAdmin && !ctx.user.isAdmin) throw forbidden('Administratoren dürfen nur von Administratoren verwaltet werden.');
      if (get('SELECT is_superadmin s FROM users WHERE id = ?', id)?.s && !ctx.user.isSuperadmin) throw forbidden('Superadmins dürfen nur von Superadmins verwaltet werden.');
      const err = checkPassword(ctx.body.password);
      if (err) throw bad(err);
      run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(ctx.body.password), now(), id);
      if (id !== ctx.user.id) destroyUserSessions(id);
      audit(ctx, { action: 'user.password_reset', module: 'users', targetType: 'user', targetId: id, targetLabel: memberLabel(cur) });
      return { ok: true };
    });

    r.delete('/api/users/:id', { perm: 'users.delete' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get('SELECT * FROM users WHERE id = ?', id);
      if (!cur) throw notFound('Benutzer nicht gefunden.');
      if (id === ctx.user.id) throw forbidden('Du kannst dich nicht selbst löschen.');
      if (loadAccess(id).isAdmin && !ctx.user.isAdmin) throw forbidden('Administratoren dürfen nur von Administratoren gelöscht werden.');
      if (cur.is_superadmin && !ctx.user.isSuperadmin) throw forbidden('Superadmins dürfen nur von Superadmins gelöscht werden.');
      if (cur.is_superadmin && get('SELECT COUNT(*) c FROM users WHERE is_superadmin = 1').c <= 1) throw conflict('Der letzte Superadmin kann nicht gelöscht werden.');
      if (isActiveAdmin(id) && otherActiveAdmins(id) === 0) throw conflict('Der letzte aktive Administrator kann nicht gelöscht werden.');
      const before = snapshot(id);
      run('DELETE FROM users WHERE id = ?', id);
      purgeUserFiles(id);
      audit(ctx, { action: 'user.deleted', module: 'users', targetType: 'user', targetId: id, targetLabel: memberLabel(cur), before });
      return { ok: true };
    });
  },
};

