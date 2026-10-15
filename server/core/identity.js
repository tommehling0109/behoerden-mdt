import { get } from './db.js';

/**
 * Anonymität interner Mitglieder: Namen (Anzeigename, Benutzername) sieht NUR das Mitglied selbst.
 * Alle anderen sehen ausschließlich die Personalnummer (Mitgliedsnummer). Bewerber ohne Nummer erscheinen als „Antrag #…“.
 * Die Schwärzung passiert serverseitig – die API liefert fremde Namen nie aus.
 */
export const memberLabel = (u) => u.member_number || (u.status === 'pending' ? `Antrag #${u.id}` : `Mitglied #${u.id}`);

/** Bezeichnung für Dritte; viewerId === userId ⇒ „Du“. Gelöschte Mitglieder bleiben anonym. */
export function labelForUser(userId, viewerId = null) {
  if (userId == null) return null;
  if (userId === viewerId) return 'Du';
  const u = get('SELECT id, member_number, status FROM users WHERE id = ?', userId);
  return u ? memberLabel(u) : 'Gelöschtes Mitglied';
}

const NAME_KEYS = new Set(['displayName', 'display_name', 'username', 'supervisor']);
/** Entfernt Namensfelder aus protokollierten Vorher/Nachher-Werten. */
export function stripNames(v) {
  if (Array.isArray(v)) return v.map(stripNames);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !NAME_KEYS.has(k)).map(([k, x]) => [k, stripNames(x)]));
  return v;
}
