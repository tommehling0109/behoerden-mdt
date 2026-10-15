import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { get, run, now } from './db.js';
import { loadAccess } from './permissions.js';

export const COOKIE = 'mdt_session';

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(h, 'base64');
  const got = scryptSync(pw, Buffer.from(s, 'base64'), expected.length);
  return timingSafeEqual(got, expected);
}
// Dummy-Hash, damit die Login-Dauer nicht verrät, ob ein Benutzer existiert
const DUMMY = hashPassword('dummy-password-for-timing');
export const verifyDummy = () => verifyPassword('x', DUMMY);

const sha = (t) => createHash('sha256').update(t).digest('hex');
export const sessionHash = sha;

export function createSession(userId, { ip, ua, hours }) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + hours * 3600_000).toISOString();
  run('INSERT INTO sessions (token_hash,user_id,created_at,expires_at,ip,user_agent) VALUES (?,?,?,?,?,?)',
    sha(token), userId, now(), expires, ip ?? null, (ua ?? '').slice(0, 200));
  return { token, expires };
}
export const destroySession = (token) => run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
export const destroyUserSessions = (userId) => run('DELETE FROM sessions WHERE user_id = ?', userId);

/** Lädt den Benutzer zu einem Session-Token (inkl. Rechte) – oder null. */
export function userFromToken(token) {
  if (!token) return null;
  const s = get('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', sha(token));
  if (!s) return null;
  if (s.expires_at < now()) { destroySession(token); return null; }
  return loadUser(s.user_id);
}

export function loadUser(id) {
  const u = get(`SELECT u.id,u.username,u.display_name,u.status,u.status_reason,u.member_number,
    u.avatar_ext, u.avatar_version, r.id rank_id, r.name rank_name, r.color rank_color, d.id dept_id, d.name dept_name, d.color dept_color
    FROM users u LEFT JOIN ranks r ON r.id=u.rank_id LEFT JOIN departments d ON d.id=u.department_id WHERE u.id = ?`, id);
  if (!u) return null;
  const acc = loadAccess(id);
  return {
    id: u.id, username: u.username, displayName: u.display_name, status: u.status, statusReason: u.status_reason, memberNumber: u.member_number,
    rank: u.rank_id ? { id: u.rank_id, name: u.rank_name, color: u.rank_color } : null,
    department: u.dept_id ? { id: u.dept_id, name: u.dept_name, color: u.dept_color } : null,
    roles: acc.roles, isAdmin: acc.isAdmin, isSuperadmin: acc.isSuperadmin, perms: acc.perms, avatarUrl: u.avatar_ext ? `/api/avatars/${u.id}?v=${u.avatar_version}` : null,
  };
}
export const publicUser = (u) => ({
  id: u.id, username: u.username, displayName: u.displayName, status: u.status, statusReason: u.statusReason,
  memberNumber: u.memberNumber, rank: u.rank, department: u.department,
  roles: u.roles, isAdmin: u.isAdmin, isSuperadmin: !!u.isSuperadmin, permissions: [...u.perms], avatarUrl: u.avatarUrl ?? null,
});

// Brute-Force-Bremse (im Speicher, pro IP+Benutzername)
const attempts = new Map();
export function rateLimit(key, max = 8, windowMs = 10 * 60_000) {
  const t = Date.now();
  const a = (attempts.get(key) ?? []).filter((x) => t - x < windowMs);
  if (a.length >= max) return false;
  a.push(t);
  attempts.set(key, a);
  return true;
}
export const clearAttempts = (key) => attempts.delete(key);
setInterval(() => attempts.clear(), 3600_000).unref();

export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Das Passwort muss mindestens 8 Zeichen haben.';
  if (pw.length > 200) return 'Das Passwort ist zu lang.';
  return null;
}
