import { all, get, run, DB_PATH } from './db.js';
import { unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Endgültiges Löschen samt allem Zugehörigen (nur für berechtigte Mitglieder / Superadmin).
 * Jede Funktion läuft in der Transaktion des Aufrufers und räumt Finanz-Journal und Dateien mit auf.
 */
const data = (...p) => join(dirname(DB_PATH), ...p);
const rm = (file) => { try { unlinkSync(file); } catch { /* war nicht da */ } };

export function purgeLoan(id) {
  run("DELETE FROM finance_ledger WHERE (ref_type = 'credit_installment' AND ref_id IN (SELECT id FROM credit_installments WHERE loan_id = ?)) OR (ref_type = 'loan' AND ref_id = ?)", id, id);
  run('DELETE FROM credit_loans WHERE id = ?', id); // Raten und Verlauf folgen per Cascade
}
export function purgeDeal(id) {
  run('DELETE FROM finance_ledger WHERE deal_id = ?', id);
  run('DELETE FROM market_deals WHERE id = ?', id);
}
/** Artikel samt aller Geschäfte, Gesuche, Bestände und Verläufe (nur Superadmin). */
export function purgeItem(id) {
  for (const d of all('SELECT DISTINCT deal_id id FROM market_deal_lines WHERE item_id = ?', id)) purgeDeal(d.id);
  run('DELETE FROM market_wanted WHERE item_id = ?', id);
  run('DELETE FROM warehouse_stock WHERE item_id = ?', id);
  run('DELETE FROM warehouse_events WHERE item_id = ?', id);
  run('DELETE FROM market_items WHERE id = ?', id);
}
export function purgeStatement(id) {
  const s = get('SELECT invoice_file_ext e FROM tab_statements WHERE id = ?', id);
  if (s?.e) rm(data('tab-invoices', `${id}.${s.e}`));
  run('DELETE FROM tab_statements WHERE id = ?', id);
}
export function purgeCompany(id) {
  for (const s of all('SELECT id FROM tab_statements WHERE company_id = ?', id)) purgeStatement(s.id);
  run("DELETE FROM finance_ledger WHERE company_id = ? OR (ref_type = 'tab_statement' AND ref_id IN (SELECT id FROM tab_statements WHERE company_id = ?))", id, id);
  run('DELETE FROM tab_entries WHERE company_id = ?', id); // (alte Buchungen aus früheren Versionen)
  run('DELETE FROM tab_companies WHERE id = ?', id);
}
/** Dateien eines Mitglieds (Profilbild, Personalakte-Dokumente) entfernen. */
/** Weitere Dateien eines Mitglieds oder externen Zugangs (Datensätze und Dateien). */
export function purgeExtraFiles(type, id) {
  for (const f of all('SELECT id, ext FROM extra_files WHERE owner_type = ? AND owner_id = ?', type, id)) rm(data('extra-files', `${f.id}.${f.ext}`));
  run('DELETE FROM extra_files WHERE owner_type = ? AND owner_id = ?', type, id);
}
export function purgeUserFiles(id) {
  purgeExtraFiles('user', id);
  for (const e of ['png', 'jpg', 'webp']) rm(data('avatars', `${id}.${e}`));
  for (const k of ['id', 'license', 'weapon', 'clearance']) for (const e of ['pdf', 'png', 'jpg', 'webp']) rm(data('user-docs', `${id}-${k}.${e}`));
}
export function purgePartner(id) {
  for (const l of all('SELECT id FROM credit_loans WHERE partner_id = ?', id)) purgeLoan(l.id);
  for (const d of all('SELECT id FROM market_deals WHERE partner_id = ?', id)) purgeDeal(d.id);
  run('DELETE FROM finance_ledger WHERE partner_id = ?', id);
  run("DELETE FROM notifications WHERE recipient_type = 'partner' AND recipient_id = ?", id);
  for (const k of ['id', 'license', 'weapon', 'clearance']) for (const e of ['pdf', 'png', 'jpg', 'webp']) rm(data('partner-docs', `${id}-${k}.${e}`));
  purgeExtraFiles('partner', id);
  run('DELETE FROM partners WHERE id = ?', id); // Zugangs-Sitzungen, Chats und Lesemarken folgen per Cascade
}
