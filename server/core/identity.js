import { get } from './db.js';

/**
 * Behörden-MDT: Mitglieder erscheinen mit Klarnamen und – falls vergeben – Dienstnummer, z. B. „Max Mustermann (1042)“.
 * Die Bezeichnung wird serverseitig gebildet, damit alle Module (Chat, Audit, Akten, Aufgaben …) einheitlich aussehen.
 * Bewerber ohne Dienstnummer erscheinen mit ihrem Namen, Gelöschte als „Gelöschtes Mitglied“.
 */
export const formatMember = (name, number) => (name && number ? `${name} (${number})` : name || number || null);

/** Anzeigename eines Benutzers (aus der Datenbank, falls die Zeile ihn nicht enthält). */
export const nameOfUser = (u) => u?.display_name ?? (u?.id != null ? get('SELECT display_name FROM users WHERE id = ?', u.id)?.display_name : null) ?? null;

export const memberLabel = (u) => formatMember(nameOfUser(u), u.member_number) || (u.status === 'pending' ? `Antrag #${u.id}` : `Mitglied #${u.id}`);

/** Bezeichnung für Dritte; viewerId === userId ⇒ „Du“. Gelöschte Mitglieder bleiben als „Gelöschtes Mitglied“ stehen. */
export function labelForUser(userId, viewerId = null) {
  if (userId == null) return null;
  if (userId === viewerId) return 'Du';
  const u = get('SELECT id, display_name, member_number, status FROM users WHERE id = ?', userId);
  return u ? memberLabel(u) : 'Gelöschtes Mitglied';
}

/** Vorher/Nachher-Werte im Audit-Log werden unverändert protokolliert (Klarnamen sind hier gewollt). */
export const stripNames = (v) => v;
