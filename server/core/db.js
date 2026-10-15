import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_MIGRATIONS } from './schema.js';

export const DB_PATH = process.env.MDT_DB || join(process.env.MDT_DATA_DIR || fileURLToPath(new URL('../../data', import.meta.url)), 'mdt.db');

mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

export function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < SCHEMA_MIGRATIONS.length; v++) {
    tx(() => {
      db.exec(SCHEMA_MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export const all = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
export const get = (sql, ...p) => {
  const r = db.prepare(sql).get(...p);
  return r ? { ...r } : null;
};
export const run = (sql, ...p) => db.prepare(sql).run(...p);

let depth = 0;
let pending = [];
/** Führt fn nach erfolgreichem Commit aus (bzw. sofort, wenn keine Transaktion läuft). Bei Rollback wird verworfen. */
export function onCommit(fn) {
  if (depth > 0) pending.push(fn); else fn();
}
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  let out;
  try {
    out = fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    pending = [];
    throw e;
  } finally {
    depth--;
  }
  const fns = pending;
  pending = [];
  for (const f of fns) { try { f(); } catch (e) { console.error('[onCommit]', e); } }
  return out;
}

export const now = () => new Date().toISOString();
