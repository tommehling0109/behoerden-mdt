// Datenbank-Sicherung auf der Kommandozeile (z. B. per systemd-Timer):  npm run backup
// Erstellt data/backups/mdt-YYYYMMDD-HHMMSS.db (konsistente Kopie, auch bei laufendem Server) und behält die letzten 30.
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { db, DB_PATH, migrate } from '../server/core/db.js';

migrate();
const dir = join(dirname(DB_PATH), 'backups');
mkdirSync(dir, { recursive: true });
const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const name = `mdt-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`;
db.exec(`VACUUM INTO '${join(dir, name).replace(/'/g, "''")}'`);
const files = readdirSync(dir).filter((f) => /^mdt-\d{8}-\d{6}\.db$/.test(f)).sort().reverse();
for (const old of files.slice(30)) unlinkSync(join(dir, old));
console.log(`Backup erstellt: ${join(dir, name)} (${Math.min(files.length, 30)} Sicherungen vorhanden)`);
