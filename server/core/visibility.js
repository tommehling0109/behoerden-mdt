import { get } from './db.js';

/**
 * Welche Artikel sieht ein externer Partner in der Börse? Beides muss erlauben (UND):
 *  - Artikel (market_items.partner_access): 'all' = alle Partner, 'selected' = nur Partner aus market_item_partners, 'none' = kein Partner
 *  - Partner (partners.items_mode): 'all' = alle freigegebenen Artikel, 'selected' = nur Artikel aus partner_items
 * „Sonstiges“ (market_items.is_other) ist nie ein normaler Artikel; der Partner darf ihn nur mit partners.allow_other als Freitext nutzen.
 */
export function partnerItemWhere(partnerId, { activeOnly = true } = {}) {
  return {
    sql: `${activeOnly ? 'i.is_active = 1 AND ' : ''}i.is_other = 0
      AND (i.partner_access = 'all' OR (i.partner_access = 'selected' AND EXISTS (SELECT 1 FROM market_item_partners mp WHERE mp.item_id = i.id AND mp.partner_id = ?)))
      AND ((SELECT items_mode FROM partners WHERE id = ?) = 'all' OR EXISTS (SELECT 1 FROM partner_items pi WHERE pi.item_id = i.id AND pi.partner_id = ?))`,
    params: [partnerId, partnerId, partnerId],
  };
}
export function partnerSeesItem(partnerId, itemId, opts) {
  const w = partnerItemWhere(partnerId, opts);
  return !!get(`SELECT 1 x FROM market_items i WHERE i.id = ? AND ${w.sql}`, itemId, ...w.params);
}
export const otherItem = () => get('SELECT id, name, unit FROM market_items WHERE is_other = 1');
