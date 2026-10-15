import { all, get, run, now } from './db.js';
import { getConfig } from './config.js';
import { bad, conflict } from './http.js';

/**
 * Lagerbestand + automatischer Preisvorschlag.
 * Der Vorschlag entsteht aus der Preisspanne (min/max) eines Items und – je nach Einstellung „warehouse.price_strategy“ – aus dem Bestand:
 *   stock = je voller die Lager gegenüber dem Zielbestand, desto näher am Mindestpreis (leer ⇒ Höchstpreis); ohne Zielbestand: Mitte
 *   min / mid / max = fester Wert innerhalb der Spanne
 */
export const totalStock = (itemId) => get('SELECT COALESCE(SUM(quantity),0) q FROM warehouse_stock WHERE item_id = ?', itemId).q;

/**
 * Lager wie das Inventar des Servers: Kapazität in Slots. Ein Item belegt `space` Slots pro Stapel, ein Stapel fasst höchstens `stack_size` Stück
 * (z. B. 1 Slot / 5 Stück, 2 Slots / 2 Stück, 3 Slots / 1 Stück). Belegt = Anzahl Stapel (aufgerundet) × Slots pro Stapel.
 */
export const slotsFor = (item, quantity) => (quantity > 0 ? Math.ceil(quantity / Math.max(1, item.stack_size ?? 1)) * item.space : 0);

export function usedSpace(warehouseId) {
  return get('SELECT COALESCE(SUM(((s.quantity + i.stack_size - 1) / i.stack_size) * i.space),0) u FROM warehouse_stock s JOIN market_items i ON i.id = s.item_id WHERE s.warehouse_id = ? AND s.quantity > 0', warehouseId).u;
}

export function quote(itemId, quantity = 1) {
  const i = get('SELECT min_price, max_price, target_stock FROM market_items WHERE id = ?', itemId);
  if (!i || i.min_price == null || i.max_price == null) return null;
  const { min_price: lo, max_price: hi } = i;
  const mode = getConfig('warehouse.price_strategy');
  let price;
  if (mode === 'min') price = lo;
  else if (mode === 'max') price = hi;
  else if (mode === 'stock' && i.target_stock > 0) {
    const fill = Math.min(1, Math.max(0, (totalStock(itemId) + Math.max(0, quantity) / 2) / i.target_stock));
    price = hi - (hi - lo) * fill;
  } else price = (lo + hi) / 2;
  const unitPrice = Math.round(price);
  return { unitPrice, total: unitPrice * quantity };
}

/** Bucht Bestand (delta > 0 Einlagern, < 0 Auslagern). Läuft in der Transaktion des Aufrufers. Prüft Kapazität und Mindestbestand 0. */
export function bookStock({ warehouseId, itemId, delta, kind, userId = null, note = '', dealId = null }) {
  const wh = get('SELECT id, capacity FROM warehouses WHERE id = ?', warehouseId);
  const item = get('SELECT id, space, stack_size, name, unit FROM market_items WHERE id = ?', itemId);
  if (!wh || !item) throw bad('Unbekanntes Lager oder Item.');
  if (!Number.isInteger(delta) || delta === 0) throw bad('Menge: ganze Zahl ungleich 0 erforderlich.');
  const cur = get('SELECT quantity FROM warehouse_stock WHERE warehouse_id = ? AND item_id = ?', warehouseId, itemId)?.quantity ?? 0;
  const after = cur + delta;
  if (after < 0) throw conflict(`Nicht genug Bestand: ${cur.toLocaleString('de-DE')} ${item.unit} vorhanden.`);
  const need = slotsFor(item, after) - slotsFor(item, cur); // zusätzliche Slots (angefangene Stapel werden zuerst aufgefüllt)
  if (delta > 0 && wh.capacity != null && need > 0 && usedSpace(warehouseId) + need > wh.capacity) {
    const free = Math.max(0, wh.capacity - usedSpace(warehouseId));
    throw conflict(`Nicht genug Platz im Lager: noch ${free.toLocaleString('de-DE')} von ${wh.capacity.toLocaleString('de-DE')} Slots frei (benötigt: ${need.toLocaleString('de-DE')}).`);
  }
  run(`INSERT INTO warehouse_stock (warehouse_id,item_id,quantity) VALUES (?,?,?) ON CONFLICT(warehouse_id,item_id) DO UPDATE SET quantity = excluded.quantity`, warehouseId, itemId, after);
  run('INSERT INTO warehouse_events (warehouse_id,item_id,user_id,kind,delta,quantity_after,note,deal_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)', warehouseId, itemId, userId, kind, delta, after, note, dealId, now());
  return after;
}

export const stockOfItem = (itemId) => all('SELECT w.id, w.name, s.quantity FROM warehouse_stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE s.item_id = ? AND s.quantity > 0 ORDER BY s.quantity DESC', itemId);
