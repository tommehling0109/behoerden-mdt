import { get, run, now } from './db.js';
import { getConfig } from './config.js';
import { hashPassword } from './auth.js';
import { randomBytes } from 'node:crypto';

/**
 * Mitglieder als Handelspartner: Ist „market.member_trade“ eingeschaltet und hat ein Mitglied das Recht „market.trade“, nutzt es die Börse
 * wie ein externer Partner (Angebote, Gesuche, eigene Geschäfte). Dafür gibt es je Mitglied einen verdeckten Partner-Eintrag
 * (partners.user_id): ohne Link und Zugangscode, nur für die Börse, nicht in den Partnerlisten. Benachrichtigungen gehen an das Mitglied.
 */
export const memberTradeOn = (user) => !!user && !!getConfig('market.member_trade') && (user.isAdmin || user.perms.has('market.trade'));

/** Verdeckter Partner-Eintrag des Mitglieds (wird bei Bedarf angelegt) im Format von partnerFromToken. */
export function memberPartner(user) {
  let p = get('SELECT * FROM partners WHERE user_id = ?', user.id);
  if (!p) {
    const t = now(), number = user.memberNumber || `M-${user.id}`;
    const id = Number(run("INSERT INTO partners (partner_number,name,note,link_token,code_hash,status,apps,partner_type,user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      number, `Mitglied ${number}`, 'Handelt als Mitglied in der Börse', randomBytes(24).toString('base64url'), hashPassword(randomBytes(24).toString('base64url')), 'active', '["market"]', 'customer', user.id, t, t).lastInsertRowid);
    p = get('SELECT * FROM partners WHERE id = ?', id);
  }
  return { id: p.id, name: p.name, number: p.partner_number, status: p.status, apps: new Set(['market']), isMember: true };
}
