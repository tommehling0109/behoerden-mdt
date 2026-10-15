import { bad, str } from './http.js';

/** Gemeinsame Regeln für persönliche Angaben (Mitglieder-Personalakte und externe Zugänge). */
export const formatPhone = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(v ?? '').trim(); };

/** Prüft die vorhandenen Felder von `b` und liefert { spalte: wert } (nur Felder, die übergeben wurden). */
export function personalFields(b) {
  const out = {};
  if (b.firstName !== undefined) out.first_name = str(b.firstName, 'Vorname', { max: 40, required: false });
  if (b.lastName !== undefined) out.last_name = str(b.lastName, 'Nachname', { max: 40, required: false });
  if (b.street !== undefined) out.street = str(b.street, 'Straße', { max: 80, required: false });
  if (b.postalCode !== undefined) { const p = String(b.postalCode ?? '').trim(); if (p && !/^[A-Za-z0-9 -]{1,12}$/.test(p)) throw bad('Postal Code: nur Buchstaben, Ziffern und Bindestrich.'); out.postal_code = p; }
  if (b.phone !== undefined) { const ph = formatPhone(b.phone); if (ph && !/^\(\d{3}\) \d{3}-\d{4}$/.test(ph)) throw bad('Telefonnummer: Format (555) 123-4567.'); out.phone = ph; }
  if (b.umail !== undefined) {
    const l = String(b.umail ?? '').trim().toLowerCase().replace(/@umail\.com$/, '');
    if (l && !/^[a-z0-9._-]{2,40}$/.test(l)) throw bad('UMail: nur Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich (die Endung @umail.com ist fest).');
    out.umail_local = l;
  }
  if (b.accountNumber !== undefined) { const a = String(b.accountNumber ?? '').trim().toUpperCase(); if (a && !/^[A-Z0-9-]{3,20}$/.test(a)) throw bad('Kontonummer: 3–20 Zeichen (Buchstaben/Ziffern), z. B. LS28180705.'); out.account_number = a; }
  return out;
}

/** Dokumentarten der Personalakte / von Lieferanten: Schlüssel → [Spalte Mitglieder, Beschriftung] */
export const USER_DOCS = { id: ['doc_id_ext', 'Ausweis'], license: ['doc_license_ext', 'Führerschein'], weapon: ['doc_weapon_ext', 'Waffenschein'], clearance: ['doc_clearance_ext', 'Führungszeugnis'] };
