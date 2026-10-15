import { db, DB_PATH } from './db.js';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Werksreset: leert ALLE Daten (Benutzer, Rollen, Börse, Kredite, Deckel, Chat, Fahrzeuge, Lager, Einstellungen, Audit-Log …) und
 * löscht hochgeladene Dateien – das Programm selbst, das Datenbankschema, die Datensicherungen und die Kartenkacheln bleiben erhalten.
 * Danach wird das System wie bei der Erstinstallation neu aufgebaut (Rechte, Auswahllisten, Standarddaten der Module);
 * die Einrichtung (Setup-Bildschirm) erscheint wieder.
 */
let reinit = () => {};
/** app.js hinterlegt hier, wie das System nach dem Leeren neu aufgebaut wird (Rechte, Auswahllisten, Modul-init). */
export const setReinit = (fn) => { reinit = fn; };

/** Ordner mit hochgeladenen Dateien (Backups und Kartenkacheln bleiben bewusst unberührt). */
const FILE_DIRS = ['avatars', 'partner-docs', 'user-docs', 'tab-invoices', 'tickets', 'branding', 'vehicles'];

export function factoryReset() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  db.exec('PRAGMA foreign_keys = OFF'); // Reihenfolge der Tabellen egal – es wird ohnehin alles geleert
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const t of tables) db.exec(`DELETE FROM "${t.replace(/"/g, '""')}"`);
      try { db.exec('DELETE FROM sqlite_sequence'); } catch { /* keine AUTOINCREMENT-Tabellen */ }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
  for (const d of FILE_DIRS) { try { rmSync(join(dirname(DB_PATH), d), { recursive: true, force: true }); } catch { /* egal */ } }
  try { db.exec('VACUUM'); } catch { /* nicht kritisch */ }
  reinit();
  return { tables: tables.length };
}
