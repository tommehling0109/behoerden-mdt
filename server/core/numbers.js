import { get, run } from './db.js';
import { getConfig } from './config.js';

/**
 * Fortlaufende, nie wiederverwendete Nummern (z. B. MDT-100001). Muss innerhalb einer Transaktion laufen.
 * Der Zähler steigt nur; Präfix/Startnummer sind konfigurierbar und ändern vergebene Nummern nie.
 */
export function allocateNumber(seq, prefixKey, startKey) {
  const start = Number(getConfig(startKey)) || 1;
  const prefix = getConfig(prefixKey) ?? '';
  const row = get('SELECT next_value FROM sequences WHERE name = ?', seq);
  const n = Math.max(row?.next_value ?? start, start);
  run('INSERT INTO sequences (name,next_value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET next_value = excluded.next_value', seq, n + 1);
  return `${prefix}${n}`;
}
