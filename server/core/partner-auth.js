import { randomBytes, createHash, randomInt } from 'node:crypto';
import { get, run, now, tx } from './db.js';
import { allocateNumber } from './numbers.js';

/** Sitzungen für externe Partner (getrennt von Benutzer-Sitzungen, eigenes Cookie). */
export const PARTNER_COOKIE = 'mdt_partner';
const sha = (t) => createHash('sha256').update(t).digest('hex');

export const newLinkToken = () => randomBytes(24).toString('base64url');
export const randomCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const CODE_RE = /^[A-Za-z0-9]{6,12}$/;

export function createPartnerSession(partnerId, { ip, ua, hours }) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + hours * 3600_000).toISOString();
  run('INSERT INTO partner_sessions (token_hash,partner_id,created_at,expires_at,ip,user_agent) VALUES (?,?,?,?,?,?)',
    sha(token), partnerId, now(), expires, ip ?? null, (ua ?? '').slice(0, 200));
  return { token, expires };
}
export const destroyPartnerSession = (token) => run('DELETE FROM partner_sessions WHERE token_hash = ?', sha(token));
export const destroyPartnerSessions = (partnerId) => run('DELETE FROM partner_sessions WHERE partner_id = ?', partnerId);

/** Partner ohne Nummer (z. B. direkt in die Datenbank geschrieben) erhalten sie beim ersten Zugriff. */
function ensureNumber(id) {
  tx(() => {
    if (!get('SELECT partner_number FROM partners WHERE id = ?', id)?.partner_number) {
      run('UPDATE partners SET partner_number = ? WHERE id = ?', allocateNumber('partner_number', 'partners.number_prefix', 'partners.number_start'), id);
    }
  });
}

export const loadPartner = (id) => {
  let p = get('SELECT * FROM partners WHERE id = ?', id);
  if (!p) return null;
  if (!p.partner_number) { ensureNumber(id); p = get('SELECT * FROM partners WHERE id = ?', id); }
  let apps = [];
  try { apps = JSON.parse(p.apps); } catch { /* leer */ }
  return { id: p.id, name: p.name, number: p.partner_number, status: p.status, apps: new Set(apps) };
};

/** Partner zu einem Session-Token – nur wenn Zugang aktiv und Sitzung gültig. */
export function partnerFromToken(token) {
  if (!token) return null;
  const s = get('SELECT partner_id, expires_at FROM partner_sessions WHERE token_hash = ?', sha(token));
  if (!s) return null;
  if (s.expires_at < now()) { destroyPartnerSession(token); return null; }
  const p = loadPartner(s.partner_id);
  return p && p.status === 'active' ? p : null;
}
