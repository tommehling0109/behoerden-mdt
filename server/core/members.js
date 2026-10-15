import { all, get, run, tx } from './db.js';
import { getConfig } from './config.js';

const SEQ = 'member_number';

/** Nächste Nummer = max(Zähler, Startnummer). Der Zähler steigt nur – gelöschte/gesperrte Nummern werden nie wiederverwendet. */
function peekSeq() {
  const start = Number(getConfig('members.number_start')) || 1;
  const row = get('SELECT next_value FROM sequences WHERE name = ?', SEQ);
  return Math.max(row?.next_value ?? start, start);
}

export const nextMemberNumberPreview = () => `${getConfig('members.number_prefix') ?? ''}${peekSeq()}`;

/**
 * Vergibt (einmalig) die nächste Mitgliedsnummer. Läuft in einer IMMEDIATE-Transaktion, zusätzlich sichert der
 * UNIQUE-Index auf users.member_number die Eindeutigkeit auf Datenbankebene ab. Bereits vergebene Nummern ändern sich nie.
 */
export function assignMemberNumber(userId) {
  return tx(() => {
    const u = get('SELECT member_number FROM users WHERE id = ?', userId);
    if (!u) return null;
    if (u.member_number) return u.member_number;
    const prefix = getConfig('members.number_prefix') ?? '';
    const n = peekSeq();
    run(`INSERT INTO sequences (name,next_value) VALUES (?,?)
         ON CONFLICT(name) DO UPDATE SET next_value = excluded.next_value`, SEQ, n + 1);
    const number = `${prefix}${n}`;
    run('UPDATE users SET member_number = ? WHERE id = ?', number, userId);
    return number;
  });
}

/** Aktive Benutzer ohne Nummer (z. B. aus früheren Versionen) nachträglich in Anlegereihenfolge nummerieren. */
export function backfillMemberNumbers() {
  const rows = all(`SELECT id FROM users WHERE member_number IS NULL AND status = 'active' ORDER BY created_at, id`);
  for (const r of rows) assignMemberNumber(r.id);
  return rows.length;
}
