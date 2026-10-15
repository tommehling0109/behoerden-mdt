import { all, get, run, now } from '../core/db.js';
import { HttpError, bad, str, conflict } from '../core/http.js';
import {
  hashPassword, verifyPassword, verifyDummy, checkPassword, createSession, destroySession,
  publicUser, rateLimit, clearAttempts, loadUser, COOKIE, sessionHash,
} from '../core/auth.js';
import { getConfig } from '../core/config.js';
import { audit } from '../core/audit.js';
import { notify, staffWith } from '../core/notifications.js';
import { sessionCookie, setupRequired } from './system.js';

const USERNAME_RE = /^[\p{L}\p{N}._-]+$/u;

export default {
  name: 'auth',
  routes(r) {
    r.post('/api/auth/login', { auth: false }, (ctx) => {
      if (setupRequired()) throw new HttpError(409, 'Das System muss zuerst eingerichtet werden.', 'setup_required');
      const username = str(ctx.body.username, 'Benutzername', { max: 64 });
      const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
      const key = `${ctx.ip}|${username.toLowerCase()}`;
      if (!rateLimit(key)) throw new HttpError(429, 'Zu viele Versuche. Bitte warte einige Minuten.', 'rate_limited');

      const row = get('SELECT * FROM users WHERE username = ?', username);
      const ok = row ? verifyPassword(password, row.password_hash) : (verifyDummy(), false);
      if (!row || !ok) {
        audit({ ip: ctx.ip, actorName: 'Unbekannt' }, { action: 'auth.login_failed', module: 'auth', targetType: 'user' });
        throw new HttpError(401, 'Benutzername oder Passwort falsch.', 'invalid_credentials');
      }
      if (row.status === 'blocked') throw new HttpError(403, `Dein Zugang wurde gesperrt.${row.status_reason ? ' Grund: ' + row.status_reason : ''}`, 'blocked');
      if (row.status === 'rejected') throw new HttpError(403, `Dein Zugangsantrag wurde abgelehnt.${row.status_reason ? ' Grund: ' + row.status_reason : ''}`, 'rejected');

      clearAttempts(key);
      run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), row.id);
      const s = createSession(row.id, { ip: ctx.ip, ua: ctx.req.headers['user-agent'], hours: getConfig('auth.session_hours') });
      ctx.headers['Set-Cookie'] = sessionCookie(ctx, s.token, s.expires);
      const fresh = loadUser(row.id);
      audit({ user: fresh, ip: ctx.ip }, { action: 'auth.login', module: 'auth', targetType: 'user', targetId: row.id, targetLabel: row.member_number ?? `Mitglied #${row.id}` });
      return { user: publicUser(fresh) };
    });

    r.post('/api/auth/logout', { auth: false }, (ctx) => {
      if (ctx.token) destroySession(ctx.token);
      ctx.headers['Set-Cookie'] = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
      return { ok: true };
    });

    // Eigener Zugang – erlaubt auch Status „pending“, damit die Warte-Ansicht funktioniert
    r.get('/api/auth/me', { auth: 'session' }, (ctx) => ({ user: publicUser(ctx.user) }));

    // Selbstregistrierung → immer Status „pending“, keine Rollen, keine Rechte
    r.post('/api/auth/register', { auth: false }, (ctx) => {
      if (!getConfig('auth.registration_enabled')) throw new HttpError(403, 'Die Registrierung ist derzeit deaktiviert.', 'registration_disabled');
      if (setupRequired()) throw new HttpError(409, 'Das System muss zuerst eingerichtet werden.', 'setup_required');
      if (!rateLimit(`reg|${ctx.ip}`, 5, 60 * 60_000)) throw new HttpError(429, 'Zu viele Registrierungen von dieser Adresse.', 'rate_limited');
      const username = str(ctx.body.username, 'Benutzername', { min: 3, max: 32 });
      if (!USERNAME_RE.test(username)) throw bad('Benutzername darf nur Buchstaben, Zahlen sowie . _ - enthalten.');
      const displayName = str(ctx.body.displayName, 'Anzeigename', { min: 2, max: 60 });
      const pwErr = checkPassword(ctx.body.password);
      if (pwErr) throw bad(pwErr);
      if (get('SELECT 1 x FROM users WHERE username = ?', username)) throw conflict('Dieser Benutzername ist bereits vergeben.');
      const t = now();
      const res = run('INSERT INTO users (username,display_name,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        username, displayName, hashPassword(ctx.body.password), 'pending', t, t);
      audit({ ip: ctx.ip, actorName: 'Antrag' }, { action: 'user.registered', module: 'users', targetType: 'user', targetId: res.lastInsertRowid, targetLabel: `Antrag #${res.lastInsertRowid}` });
      notify(staffWith('users.approve'), { key: `user:${res.lastInsertRowid}:registered`, title: 'Neuer Zugangsantrag', body: `Antrag #${res.lastInsertRowid} (@${username}) wartet auf Freischaltung.`, target: { app: 'users' } });
      const s = createSession(Number(res.lastInsertRowid), { ip: ctx.ip, ua: ctx.req.headers['user-agent'], hours: getConfig('auth.session_hours') });
      ctx.headers['Set-Cookie'] = sessionCookie(ctx, s.token, s.expires);
      ctx.status = 201;
      return { user: publicUser(loadUser(Number(res.lastInsertRowid))) };
    });

    // Sperrbildschirm: Passwort erneut bestätigen (Sitzung bleibt bestehen)
    r.post('/api/auth/unlock', (ctx) => {
      if (!rateLimit(`unlock|${ctx.user.id}`, 8, 10 * 60_000)) throw new HttpError(429, 'Zu viele Versuche. Bitte warte einige Minuten.', 'rate_limited');
      const row = get('SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
      if (!verifyPassword(String(ctx.body.password ?? ''), row.password_hash)) throw new HttpError(401, 'Das Passwort ist nicht korrekt.', 'invalid_credentials');
      return { ok: true };
    });

    // Eigene Sitzungen einsehen und alle anderen abmelden
    r.get('/api/auth/sessions', { auth: 'session' }, (ctx) => {
      const mine = sessionHash(ctx.token);
      return { sessions: all('SELECT token_hash, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC', ctx.user.id)
        .map((s) => ({ id: s.token_hash.slice(0, 12), current: s.token_hash === mine, createdAt: s.created_at, expiresAt: s.expires_at, ip: s.ip, userAgent: s.user_agent })) };
    });
    r.post('/api/auth/sessions/revoke-others', { auth: 'session' }, (ctx) => {
      const res = run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', ctx.user.id, sessionHash(ctx.token));
      audit(ctx, { action: 'auth.sessions_revoked', module: 'auth', targetType: 'user', targetId: ctx.user.id, targetLabel: ctx.user.memberNumber ?? 'Mitglied' });
      return { revoked: Number(res.changes) };
    });

    r.post('/api/auth/password', { auth: 'session' }, (ctx) => {
      const row = get('SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
      if (!verifyPassword(String(ctx.body.current ?? ''), row.password_hash)) throw bad('Das aktuelle Passwort ist falsch.');
      const err = checkPassword(ctx.body.next);
      if (err) throw bad(err);
      run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(ctx.body.next), now(), ctx.user.id);
      audit(ctx, { action: 'user.password_changed', module: 'users', targetType: 'user', targetId: ctx.user.id, targetLabel: ctx.user.memberNumber ?? 'Mitglied' });
      return { ok: true };
    });
  },
};
