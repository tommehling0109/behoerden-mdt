import { all, get, run, tx, now, DB_PATH } from '../core/db.js';
import { bad, forbidden, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { getConfig } from '../core/config.js';
import { labelForUser, memberLabel } from '../core/identity.js';
import { registerLookup, lookupEntries, lookupEntry, isActiveEntry } from '../core/lookups.js';
import { notify } from '../core/notifications.js';
import { sniffImage } from '../core/images.js';
import { sees as contactSees } from './contacts.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Rechtsfälle: Aktensystem für Justiz und Kanzlei (Teil der Legal-App).
 * Akte = Aktenzeichen (automatisch), Titel, Rechtsgebiet, Maßnahme, Gericht, Status, Sachverhalt, Vorwürfe, drohende Folgen, Strategie,
 * dazu Beteiligte (Mandant, Gegenseite, weitere), Beweise (für/gegen), Verlauf, Termine, Kosten und Dokumente (Links oder Dateien).
 * Rechte: legal.cases.view / edit / delete / billing (Kosten) / confidential (vertrauliche Akten).
 */
const AREAS = [['civil', 'Zivilrecht', '#5b8def'], ['criminal', 'Strafrecht', '#ef4444'], ['labor', 'Arbeitsrecht', '#f59e0b'], ['administrative', 'Verwaltungsrecht', '#64748b'],
  ['family', 'Familienrecht', '#ec4899'], ['traffic', 'Verkehrsrecht', '#06b6d4'], ['weapons', 'Waffenrecht', '#b45309'], ['business', 'Wirtschaftsrecht', '#10b981'],
  ['corporate', 'Unternehmensrecht', '#14b8a6'], ['tenancy', 'Mietrecht', '#8b5cf6'], ['realestate', 'Immobilienrecht', '#a16207'], ['contract', 'Vertragsrecht', '#3b82f6'], ['other', 'Sonstiges', '#94a3b8']];
const STATUSES = [['open', 'Offen', '#5b8def'], ['in_progress', 'In Bearbeitung', '#f59e0b'], ['waiting_court', 'Wartet auf Gericht', '#a78bfa'], ['waiting_client', 'Wartet auf Mandant', '#06b6d4'],
  ['hearing', 'Verhandlung', '#ec4899'], ['closed', 'Abgeschlossen', '#10b981'], ['archived', 'Archiviert', '#64748b']];
const CLOSED_KEYS = ['closed', 'archived'];
const MEASURES = [['advice', 'Beratung'], ['defense', 'Verteidigung'], ['lawsuit', 'Klage'], ['response', 'Klageerwiderung'], ['objection', 'Einspruch'], ['appeal', 'Berufung'],
  ['motion', 'Antrag'], ['contract_review', 'Vertragsprüfung'], ['settlement', 'Vergleich / Verhandlung'], ['file_access', 'Akteneinsicht'], ['other', 'Sonstiges']];
registerLookup({ key: 'legal.area', module: 'Legal', label: 'Rechtsgebiete', description: 'Zivilrecht, Strafrecht, Arbeitsrecht … – frei erweiterbar.',
  fixed: AREAS.map(([key, label, color]) => ({ key, label, color })), usage: (id) => get('SELECT COUNT(*) c FROM legal_cases WHERE area_id = ?', id).c });
registerLookup({ key: 'legal.case_status', module: 'Legal', label: 'Status von Rechtsfällen', description: 'Beschriftung und Farbe der Aktenstatus. „Abgeschlossen“ und „Archiviert“ beenden eine Akte.',
  fixed: STATUSES.map(([key, label, color]) => ({ key, label, color })), usage: (id) => get('SELECT COUNT(*) c FROM legal_cases WHERE status_id = ?', id).c });
registerLookup({ key: 'legal.measure', module: 'Legal', label: 'Art der Maßnahme', description: 'Beratung, Verteidigung, Klage, Einspruch … – frei erweiterbar.',
  fixed: MEASURES.map(([key, label]) => ({ key, label })), usage: (id) => get('SELECT COUNT(*) c FROM legal_cases WHERE measure_id = ?', id).c });

const PRIORITIES = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', urgent: 'Dringend' };
const SIDES = { client: 'Mandant', opponent: 'Gegenseite', involved: 'Beteiligte Person' };
const EVIDENCE_SIDES = { for: 'Entlastend / spricht für uns', against: 'Belastend / spricht gegen den Mandanten', neutral: 'Neutral' };
const APPT_KINDS = { hearing: 'Verhandlung', deadline: 'Frist', meeting: 'Besprechung', hearing_prep: 'Vorbereitung', other: 'Sonstiges' };
const COST_KINDS = { fee: 'Honorar', court: 'Gerichtskosten', expense: 'Auslagen', other: 'Sonstiges' };
const COST_STATUS = { open: 'Offen (noch abzurechnen)', billed: 'Abgerechnet', paid: 'Bezahlt', waived: 'Nicht abzurechnen' };
const BILLING = { billable: 'Wird abgerechnet', pro_bono: 'Pro Bono (kostenlos)', internal: 'Intern / ohne Abrechnung' };
const EVENT_KINDS = { note: 'Notiz', court: 'Gericht', contact: 'Kontakt', document: 'Dokument', deadline: 'Frist', decision: 'Entscheidung', system: 'System' };

const dir = () => join(dirname(DB_PATH), 'legal-files');
const fileOf = (d) => join(dir(), `${d.id}.${d.ext}`);

// ── Zugriff ──
const has = (user, p) => user.perms.has(p) || user.isAdmin;
const inTeam = (user, c) => c.lead_user_id === user.id || c.created_by === user.id || !!get('SELECT 1 x FROM legal_case_team WHERE case_id = ? AND user_id = ?', c.id, user.id);
export const mayAccessCase = (user, c) => mayAccess(user, c);
const mayAccess = (user, c) => has(user, 'legal.cases.view') && (!c.confidential || has(user, 'legal.cases.confidential') || inTeam(user, c));
function loadCase(user, id, { edit = false } = {}) {
  const c = get('SELECT * FROM legal_cases WHERE id = ?', Number(id));
  if (!c || !mayAccess(user, c)) throw notFound('Akte nicht gefunden.');
  if (edit && !has(user, 'legal.cases.edit')) throw forbidden('Für das Bearbeiten von Akten fehlt dir das Recht „legal.cases.edit“.');
  return c;
}

// ── Eingabe-Hilfen ──
const oneOf = (v, map, label) => { if (!Object.hasOwn(map, v)) throw bad(`${label}: ungültiger Wert.`); return v; };
const iso = (v, label, { required = true } = {}) => {
  if (v == null || v === '') { if (required) throw bad(`${label}: Datum erforderlich.`); return null; }
  const d = new Date(v); if (Number.isNaN(d.getTime())) throw bad(`${label}: ungültiges Datum.`); return d.toISOString();
};
const cents = (v, label) => { if (v == null || v === '') return 0; if (!Number.isInteger(v) || v < 0 || v > 100_000_000_000) throw bad(`${label}: ganze Zahl (Cent) von 0 bis 1 Mrd. erforderlich.`); return v; };
const lookupId = (list, v, label) => { if (v == null || v === '') return null; if (!Number.isInteger(v) || !isActiveEntry(list, v)) throw bad(`${label}: unbekannter Eintrag.`); return v; };
const text = (v, label, max, required = false) => str(v ?? '', label, { max, required, min: required ? 2 : 0 }) ?? '';
const lk = (id) => { const e = id ? lookupEntry(id) : null; return e ? { id: e.id, key: e.key, label: e.label, color: e.color } : null; };
const memberOf = (user, id) => (id ? { id, label: labelForUser(id, user.id) } : null);

/** Aktenzeichen: Präfix + Jahr + laufende Nummer (je Jahr neu), z. B. R-2026-0001. */
function nextCaseNumber() {
  const y = new Date().getFullYear(), name = `legal_case_${y}`;
  const n = get('SELECT next_value v FROM sequences WHERE name = ?', name)?.v ?? 1;
  run('INSERT INTO sequences (name,next_value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET next_value = excluded.next_value', name, n + 1);
  return `${getConfig('legal.case_prefix') ?? 'R-'}${y}-${String(n).padStart(4, '0')}`;
}
export function logEvent(caseId, userId, kind, textValue, at = null) {
  run('INSERT INTO legal_case_events (case_id,occurred_at,kind,text,created_by,created_at) VALUES (?,?,?,?,?,?)', caseId, at ?? now(), kind, textValue, userId, now());
}
const touch = (id) => run('UPDATE legal_cases SET updated_at = ? WHERE id = ?', now(), id);

// ── Beteiligte: angemeldete Personen/Firmen oder Kontaktbuch ──
function partyDto(p, user) {
  const base = { id: p.id, side: p.side, sideLabel: SIDES[p.side], kind: p.kind, refId: p.ref_id, role: p.role, note: p.note };
  if (p.kind === 'user') { const u = get('SELECT id, member_number, status FROM users WHERE id = ?', p.ref_id); return { ...base, name: u ? (u.id === user.id ? `${memberLabel(u)} (du)` : memberLabel(u)) : 'Gelöschtes Mitglied', sub: 'Mitglied' }; }
  if (p.kind === 'partner') { const x = get('SELECT partner_number, name FROM partners WHERE id = ?', p.ref_id); return { ...base, name: x ? `${x.partner_number ?? ''} · ${x.name}`.replace(/^ · /, '') : 'Gelöschter Zugang', sub: 'Externer Zugang' }; }
  if (p.kind === 'company') { const x = get('SELECT company_number, name FROM tab_companies WHERE id = ?', p.ref_id); return { ...base, name: x ? `${x.company_number ?? ''} · ${x.name}`.replace(/^ · /, '') : 'Gelöschte Firma', sub: 'Firma (Deckel)' }; }
  if (p.kind === 'contact_person') {
    const x = get('SELECT * FROM contact_people WHERE id = ?', p.ref_id);
    if (!x) return { ...base, name: 'Gelöschter Kontakt', sub: 'Kontaktbuch' };
    if (!contactSees(user, 'person', x)) return { ...base, name: 'Gesperrter Kontakt', sub: 'Kontaktbuch', hidden: true };
    return { ...base, name: `${x.first_name} ${x.last_name}`.trim(), sub: ['Person', x.position].filter(Boolean).join(' · ') };
  }
  const x = get('SELECT * FROM contact_orgs WHERE id = ?', p.ref_id);
  if (!x) return { ...base, name: 'Gelöschte Institution', sub: 'Kontaktbuch' };
  if (!contactSees(user, 'org', x)) return { ...base, name: 'Gesperrter Kontakt', sub: 'Kontaktbuch', hidden: true };
  return { ...base, name: x.name, sub: 'Institution' };
}
const PARTY_KINDS = ['user', 'partner', 'company', 'contact_person', 'contact_org'];
function assertPartyExists(kind, id) {
  const table = { user: 'users', partner: 'partners', company: 'tab_companies', contact_person: 'contact_people', contact_org: 'contact_orgs' }[kind];
  if (!table || !Number.isInteger(id) || !get(`SELECT 1 x FROM ${table} WHERE id = ?`, id)) throw bad('Unbekannte Person oder Firma.');
}
/** Suche über alle auswählbaren Beteiligten (Mitglieder, Externe Zugänge, Firmen, Kontaktbuch). */
function searchParties(user, q) {
  const like = `%${String(q ?? '').trim().toLowerCase().replace(/[%_]/g, '')}%`, out = [];
  for (const u of all("SELECT id, member_number, status FROM users WHERE status = 'active' AND lower(COALESCE(member_number,'')) LIKE ? ORDER BY member_number LIMIT 8", like)) out.push({ kind: 'user', refId: u.id, name: memberLabel(u), sub: 'Mitglied' });
  for (const p of all("SELECT id, partner_number, name FROM partners WHERE lower(name || ' ' || COALESCE(partner_number,'')) LIKE ? ORDER BY name LIMIT 8", like)) out.push({ kind: 'partner', refId: p.id, name: `${p.partner_number ?? ''} · ${p.name}`.replace(/^ · /, ''), sub: 'Externer Zugang' });
  for (const c of all("SELECT id, company_number, name FROM tab_companies WHERE lower(name || ' ' || COALESCE(company_number,'')) LIKE ? ORDER BY name LIMIT 8", like)) out.push({ kind: 'company', refId: c.id, name: `${c.company_number ?? ''} · ${c.name}`.replace(/^ · /, ''), sub: 'Firma (Deckel)' });
  for (const p of all("SELECT * FROM contact_people WHERE lower(first_name || ' ' || last_name) LIKE ? ORDER BY last_name LIMIT 10", like)) if (contactSees(user, 'person', p)) out.push({ kind: 'contact_person', refId: p.id, name: `${p.first_name} ${p.last_name}`.trim(), sub: ['Kontaktbuch', p.position].filter(Boolean).join(' · ') });
  for (const o of all('SELECT * FROM contact_orgs WHERE lower(name) LIKE ? ORDER BY name LIMIT 8', like)) if (contactSees(user, 'org', o)) out.push({ kind: 'contact_org', refId: o.id, name: o.name, sub: 'Kontaktbuch · Institution' });
  return out;
}
/** Interessenkonflikt-Hinweis: dieselbe Person/Firma steht in einer anderen Akte auf der Gegenseite (oder umgekehrt als Mandant). */
function conflictsOf(user, c, parties) {
  const out = [];
  for (const p of parties) {
    if (p.side === 'involved') continue;
    const other = p.side === 'client' ? 'opponent' : 'client';
    for (const x of all('SELECT cs.* FROM legal_case_parties q JOIN legal_cases cs ON cs.id = q.case_id WHERE q.kind = ? AND q.ref_id = ? AND q.side = ? AND q.case_id != ?', p.kind, p.refId, other, c.id)) {
      if (mayAccess(user, x)) out.push({ caseId: x.id, number: x.case_number, title: x.title, party: p.name, thisSide: SIDES[p.side], otherSide: SIDES[other] });
    }
  }
  return out;
}

// ── DTOs ──
const apptNext = (id) => get("SELECT starts_at, title FROM legal_case_appointments WHERE case_id = ? AND done = 0 AND starts_at >= ? ORDER BY starts_at LIMIT 1", id, now());
function listDto(c, user) {
  const parties = all('SELECT * FROM legal_case_parties WHERE case_id = ? ORDER BY id', c.id).map((p) => partyDto(p, user));
  const nxt = apptNext(c.id), status = lk(c.status_id);
  return {
    id: c.id, number: c.case_number, title: c.title, status, area: lk(c.area_id), measure: lk(c.measure_id), priority: c.priority, priorityLabel: PRIORITIES[c.priority],
    court: c.court, confidential: !!c.confidential, closed: !!status && CLOSED_KEYS.includes(status.key),
    clients: parties.filter((p) => p.side === 'client').map((p) => p.name), opponents: parties.filter((p) => p.side === 'opponent').map((p) => p.name),
    lead: memberOf(user, c.lead_user_id), nextAppointment: nxt ? { at: nxt.starts_at, title: nxt.title } : null, openedAt: c.opened_at, updatedAt: c.updated_at, tags: c.tags,
  };
}
function detailDto(c, user) {
  const parties = all('SELECT * FROM legal_case_parties WHERE case_id = ? ORDER BY id', c.id).map((p) => partyDto(p, user));
  const billing = has(user, 'legal.cases.billing');
  const costs = billing ? all('SELECT * FROM legal_case_costs WHERE case_id = ? ORDER BY id DESC', c.id).map((x) => ({ id: x.id, kind: x.kind, kindLabel: COST_KINDS[x.kind], description: x.description, amountCents: x.amount_cents, status: x.status, statusLabel: COST_STATUS[x.status], billedAt: x.billed_at, createdAt: x.created_at })) : undefined;
  const sum = (st) => (costs ?? []).filter((x) => x.status === st).reduce((a, x) => a + x.amountCents, 0);
  return {
    ...listDto(c, user),
    summary: c.summary, facts: c.facts, charges: c.charges, strategy: c.strategy, powerOfAttorney: !!c.power_of_attorney, billingMode: c.billing_mode, billingLabel: BILLING[c.billing_mode],
    exposure: { fineCents: c.exposure_fine_cents, jailDays: c.exposure_jail_days, damageCents: c.exposure_damage_cents, note: c.exposure_note },
    closedAt: c.closed_at, createdAt: c.created_at, createdBy: memberOf(user, c.created_by),
    team: all('SELECT user_id FROM legal_case_team WHERE case_id = ?', c.id).map((t) => memberOf(user, t.user_id)),
    parties, conflicts: conflictsOf(user, c, parties),
    evidence: all('SELECT * FROM legal_case_evidence WHERE case_id = ? ORDER BY id', c.id).map((e) => ({ id: e.id, side: e.side, sideLabel: EVIDENCE_SIDES[e.side], title: e.title, description: e.description, createdAt: e.created_at, by: memberOf(user, e.created_by) })),
    events: all('SELECT * FROM legal_case_events WHERE case_id = ? ORDER BY occurred_at DESC, id DESC', c.id).map((e) => ({ id: e.id, at: e.occurred_at, kind: e.kind, kindLabel: EVENT_KINDS[e.kind], text: e.text, by: memberOf(user, e.created_by) })),
    appointments: all('SELECT * FROM legal_case_appointments WHERE case_id = ? ORDER BY starts_at', c.id).map((a) => ({ id: a.id, title: a.title, kind: a.kind, kindLabel: APPT_KINDS[a.kind], startsAt: a.starts_at, location: a.location, note: a.note, done: !!a.done })),
    docs: all('SELECT * FROM legal_case_docs WHERE case_id = ? ORDER BY id DESC', c.id).map((d) => ({ id: d.id, title: d.title, description: d.description, kind: d.kind, url: d.kind === 'link' ? d.url : null, ext: d.ext, size: d.size, createdAt: d.created_at, by: memberOf(user, d.created_by) })),
    related: all('SELECT cs.* FROM legal_case_links l JOIN legal_cases cs ON cs.id = l.related_id WHERE l.case_id = ?', c.id).filter((x) => mayAccess(user, x)).map((x) => ({ id: x.id, number: x.case_number, title: x.title })),
    costs, costSummary: billing ? { open: sum('open'), billed: sum('billed'), paid: sum('paid'), waived: sum('waived') } : undefined,
  };
}

function caseFields(b, partial) {
  const out = {};
  const need = (k) => !partial || b[k] !== undefined;
  if (need('title')) out.title = str(b.title, 'Titel', { min: 3, max: 120 });
  if (need('statusId') && (b.statusId !== undefined || !partial)) out.status_id = lookupId('legal.case_status', b.statusId, 'Status');
  if (b.areaId !== undefined) out.area_id = lookupId('legal.area', b.areaId, 'Rechtsgebiet');
  if (b.measureId !== undefined) out.measure_id = lookupId('legal.measure', b.measureId, 'Art der Maßnahme');
  if (b.priority !== undefined) out.priority = oneOf(b.priority, PRIORITIES, 'Priorität');
  if (b.court !== undefined) out.court = text(b.court, 'Gericht', 120);
  if (b.summary !== undefined) out.summary = text(b.summary, 'Kurzbeschreibung', 1000);
  if (b.facts !== undefined) out.facts = text(b.facts, 'Sachverhalt', 10000);
  if (b.charges !== undefined) out.charges = text(b.charges, 'Vorgeworfene Taten', 4000);
  if (b.strategy !== undefined) out.strategy = text(b.strategy, 'Strategie / Hinweise', 10000);
  if (b.tags !== undefined) out.tags = text(b.tags, 'Schlagwörter', 200);
  if (b.powerOfAttorney !== undefined) out.power_of_attorney = b.powerOfAttorney ? 1 : 0;
  if (b.confidential !== undefined) out.confidential = b.confidential ? 1 : 0;
  if (b.billingMode !== undefined) out.billing_mode = oneOf(b.billingMode, BILLING, 'Abrechnung');
  if (b.leadUserId !== undefined) { const l = b.leadUserId; if (l != null && l !== '' && (!Number.isInteger(l) || !get("SELECT 1 x FROM users WHERE id = ? AND status = 'active'", l))) throw bad('Verantwortliche Person: unbekanntes Mitglied.'); out.lead_user_id = l === '' ? null : l; }
  if (b.exposure !== undefined) {
    const e = b.exposure ?? {};
    if (e.fineCents !== undefined) out.exposure_fine_cents = cents(e.fineCents, 'Geldstrafe');
    if (e.damageCents !== undefined) out.exposure_damage_cents = cents(e.damageCents, 'Wirtschaftlicher Schaden');
    if (e.jailDays !== undefined) { const d = e.jailDays === '' || e.jailDays == null ? 0 : e.jailDays; if (!Number.isInteger(d) || d < 0 || d > 100000) throw bad('Haft: ganze Zahl in Tagen.'); out.exposure_jail_days = d; }
    if (e.note !== undefined) out.exposure_note = text(e.note, 'Hinweis zu den Folgen', 1000);
  }
  return out;
}
const setTeam = (caseId, ids) => {
  if (!Array.isArray(ids)) throw bad('Ungültige Teamliste.');
  run('DELETE FROM legal_case_team WHERE case_id = ?', caseId);
  for (const id of new Set(ids)) { if (!Number.isInteger(id) || !get("SELECT 1 x FROM users WHERE id = ? AND status = 'active'", id)) throw bad('Team: unbekanntes Mitglied.'); run('INSERT INTO legal_case_team (case_id,user_id) VALUES (?,?)', caseId, id); }
};

// ── Dateien (Dokumente zur Akte) ──
const DOC_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
};
const INLINE = new Set(['pdf', 'png', 'jpg', 'webp']);
/** Dateityp wird an Endung UND Dateikopf geprüft (nie nur am Namen). */
export function checkFile(filename, buf) {
  const ext = String(filename ?? '').toLowerCase().split('.').pop();
  if (!DOC_TYPES[ext]) throw bad(`Dateityp nicht erlaubt. Erlaubt: ${Object.keys(DOC_TYPES).join(', ')}.`);
  const sig = (hex) => buf.subarray(0, hex.length / 2).toString('hex') === hex;
  let ok = false;
  if (ext === 'pdf') ok = buf.subarray(0, 5).toString() === '%PDF-';
  else if (['png', 'jpg', 'webp'].includes(ext)) ok = sniffImage(buf) === ext;
  else if (['docx', 'xlsx', 'pptx', 'odt'].includes(ext)) ok = sig('504b0304');
  else if (['doc', 'xls', 'ppt'].includes(ext)) ok = sig('d0cf11e0a1b11ae1');
  else ok = !buf.includes(0); // txt, csv
  if (!ok) throw bad('Der Dateiinhalt passt nicht zum Dateityp.');
  return ext;
}
const safeName = (s) => String(s).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 80) || 'datei';

// ── Erinnerungen an Termine ──
export function runLegalReminders(at = new Date()) {
  const hours = Number(getConfig('legal.appointment_reminder_hours')); if (!(hours > 0)) return 0;
  const until = new Date(at.getTime() + hours * 3600_000).toISOString(), from = at.toISOString();
  let sent = 0;
  for (const a of all('SELECT a.*, c.case_number, c.title ctitle, c.lead_user_id, c.created_by FROM legal_case_appointments a JOIN legal_cases c ON c.id = a.case_id WHERE a.done = 0 AND a.reminded = 0 AND a.starts_at >= ? AND a.starts_at <= ?', from, until)) {
    run('UPDATE legal_case_appointments SET reminded = 1 WHERE id = ?', a.id);
    const ids = new Set([a.lead_user_id, ...all('SELECT user_id FROM legal_case_team WHERE case_id = ?', a.case_id).map((t) => t.user_id)].filter(Boolean));
    if (!ids.size && a.created_by) ids.add(a.created_by);
    const when = new Date(a.starts_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
    sent += notify([...ids].map((id) => ({ type: 'user', id })), { key: `legal:appt:${a.id}`, title: `${a.case_number} · ${APPT_KINDS[a.kind] ?? 'Termin'} ansteht`, body: `${a.title} – ${when}${a.location ? ` (${a.location})` : ''}`, target: { app: 'legal' } });
  }
  return sent;
}

export default {
  name: 'legalcases',
  permissions: [
    ['legal.cases.view', 'Rechtsfälle: Akten ansehen'],
    ['legal.cases.edit', 'Rechtsfälle: Akten anlegen und bearbeiten (Beteiligte, Beweise, Verlauf, Termine, Dokumente)'],
    ['legal.cases.billing', 'Rechtsfälle: Kosten und Abrechnung sehen und bearbeiten'],
    ['legal.cases.confidential', 'Rechtsfälle: vertrauliche Akten sehen'],
    ['legal.cases.delete', 'Rechtsfälle: Akten löschen'],
  ],
  config: [
    { key: 'legal.case_prefix', group: 'Legal', label: 'Präfix des Aktenzeichens', help: 'Aktenzeichen: Präfix + Jahr + laufende Nummer, z. B. R-2026-0001.', type: 'string', default: 'R-', max: 12 },
    { key: 'legal.appointment_reminder_hours', group: 'Legal', label: 'Terminerinnerung (Stunden vorher)', help: 'Verantwortliche und Team werden so viele Stunden vor einem Termin erinnert. 0 = keine Erinnerung.', type: 'number', default: 24, min: 0, max: 720 },
  ],
  init() {
    setTimeout(() => { try { runLegalReminders(); } catch { /* DB evtl. schon geschlossen */ } }, 9000).unref();
    setInterval(() => { try { runLegalReminders(); } catch { /* egal */ } }, 10 * 60_000).unref();
  },
  routes(r) {
    const V = { perm: 'legal.cases.view' };

    r.get('/api/legal/cases/options', V, (ctx) => ({
      statuses: lookupEntries('legal.case_status', { onlyActive: true }), areas: lookupEntries('legal.area', { onlyActive: true }), measures: lookupEntries('legal.measure', { onlyActive: true }),
      priorities: Object.entries(PRIORITIES).map(([value, label]) => ({ value, label })), billingModes: Object.entries(BILLING).map(([value, label]) => ({ value, label })),
      sides: SIDES, evidenceSides: EVIDENCE_SIDES, apptKinds: APPT_KINDS, costKinds: COST_KINDS, costStatuses: COST_STATUS, eventKinds: EVENT_KINDS, closedKeys: CLOSED_KEYS,
      members: all("SELECT id, member_number, status FROM users WHERE status = 'active' ORDER BY member_number, id").map((u) => ({ id: u.id, label: u.id === ctx.user.id ? `${memberLabel(u)} (du)` : memberLabel(u) })),
      me: ctx.user.id, canEdit: has(ctx.user, 'legal.cases.edit'), canBilling: has(ctx.user, 'legal.cases.billing'), canDelete: has(ctx.user, 'legal.cases.delete'), canConfidential: has(ctx.user, 'legal.cases.confidential'),
      currency: getConfig('market.currency') ?? '$',
    }));

    r.get('/api/legal/cases/parties/search', V, (ctx) => ({ results: searchParties(ctx.user, ctx.query.q) }));

    r.get('/api/legal/cases', V, (ctx) => {
      const q = String(ctx.query.q ?? '').trim().toLowerCase();
      let rows = all('SELECT * FROM legal_cases ORDER BY updated_at DESC, id DESC').filter((c) => mayAccess(ctx.user, c));
      let list = rows.map((c) => listDto(c, ctx.user));
      const counts = {}; for (const x of list) { const k = x.status?.key ?? '-'; counts[k] = (counts[k] ?? 0) + 1; }
      if (ctx.query.status) list = list.filter((x) => String(x.status?.id) === ctx.query.status);
      if (ctx.query.open === '1') list = list.filter((x) => !x.closed);
      if (ctx.query.area) list = list.filter((x) => String(x.area?.id) === ctx.query.area);
      const byId = new Map(rows.map((c) => [c.id, c]));
      if (ctx.query.mine === '1') list = list.filter((x) => inTeam(ctx.user, byId.get(x.id)));
      if (q) list = list.filter((x) => `${x.number} ${x.title} ${x.court} ${x.tags} ${x.clients.join(' ')} ${x.opponents.join(' ')}`.toLowerCase().includes(q));
      const ids = new Set(rows.map((c) => c.id));
      const upcoming = all('SELECT a.*, c.case_number, c.title ctitle FROM legal_case_appointments a JOIN legal_cases c ON c.id = a.case_id WHERE a.done = 0 AND a.starts_at >= ? ORDER BY a.starts_at LIMIT 40', now()).filter((a) => ids.has(a.case_id)).slice(0, 6)
        .map((a) => ({ id: a.id, caseId: a.case_id, number: a.case_number, caseTitle: a.ctitle, title: a.title, kindLabel: APPT_KINDS[a.kind], startsAt: a.starts_at, location: a.location }));
      return { cases: list, total: list.length, counts, upcoming };
    });

    r.post('/api/legal/cases', { perm: 'legal.cases.edit' }, (ctx) => {
      const f = caseFields({ statusId: lookupEntries('legal.case_status').find((e) => e.key === 'open')?.id, ...ctx.body }, false);
      const t = now();
      const id = tx(() => {
        const cols = { case_number: nextCaseNumber(), priority: 'normal', ...f, opened_at: t, created_by: ctx.user.id, created_at: t, updated_at: t };
        const res = run(`INSERT INTO legal_cases (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`, ...Object.values(cols));
        const cid = Number(res.lastInsertRowid);
        if (ctx.body.team !== undefined) setTeam(cid, ctx.body.team);
        logEvent(cid, ctx.user.id, 'system', 'Akte angelegt.');
        return cid;
      });
      const c = get('SELECT * FROM legal_cases WHERE id = ?', id);
      if (c.lead_user_id && c.lead_user_id !== ctx.user.id) notify([{ type: 'user', id: c.lead_user_id }], { key: `legal:case:${id}:lead`, title: `${c.case_number} · Akte zugewiesen`, body: c.title, target: { app: 'legal' } });
      audit(ctx, { action: 'legal.case_created', module: 'legal', targetType: 'legal_case', targetId: id, targetLabel: `${c.case_number} · ${c.title}` });
      ctx.status = 201;
      return { case: detailDto(c, ctx.user) };
    });

    r.get('/api/legal/cases/:id', V, (ctx) => ({ case: detailDto(loadCase(ctx.user, ctx.params.id), ctx.user) }));

    r.patch('/api/legal/cases/:id', { perm: 'legal.cases.edit' }, (ctx) => {
      const c = loadCase(ctx.user, ctx.params.id, { edit: true }), f = caseFields(ctx.body, true), cols = Object.keys(f);
      tx(() => {
        if (cols.length) run(`UPDATE legal_cases SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((k) => f[k]), now(), c.id);
        if (ctx.body.team !== undefined) setTeam(c.id, ctx.body.team);
        if (f.status_id !== undefined && f.status_id !== c.status_id) {
          const s = lk(f.status_id);
          run('UPDATE legal_cases SET closed_at = ? WHERE id = ?', s && CLOSED_KEYS.includes(s.key) ? now() : null, c.id);
          logEvent(c.id, ctx.user.id, 'system', `Status geändert: ${lk(c.status_id)?.label ?? '–'} → ${s?.label ?? '–'}`);
        }
        if (f.lead_user_id !== undefined && f.lead_user_id !== c.lead_user_id) logEvent(c.id, ctx.user.id, 'system', f.lead_user_id ? `Verantwortlich: ${labelForUser(f.lead_user_id)}` : 'Verantwortliche Person entfernt.');
      });
      if (f.lead_user_id && f.lead_user_id !== c.lead_user_id && f.lead_user_id !== ctx.user.id) notify([{ type: 'user', id: f.lead_user_id }], { key: `legal:case:${c.id}:lead:${Date.now()}`, title: `${c.case_number} · Akte zugewiesen`, body: c.title, target: { app: 'legal' } });
      audit(ctx, { action: 'legal.case_updated', module: 'legal', targetType: 'legal_case', targetId: c.id, targetLabel: `${c.case_number} · ${f.title ?? c.title}`, after: { fields: cols } });
      return { case: detailDto(get('SELECT * FROM legal_cases WHERE id = ?', c.id), ctx.user) };
    });

    r.delete('/api/legal/cases/:id', { perm: 'legal.cases.delete' }, (ctx) => {
      const c = loadCase(ctx.user, ctx.params.id);
      for (const d of all("SELECT id, ext FROM legal_case_docs WHERE case_id = ? AND kind = 'file'", c.id)) { try { unlinkSync(fileOf(d)); } catch { /* egal */ } }
      run('DELETE FROM legal_cases WHERE id = ?', c.id); // Beteiligte, Beweise, Verlauf, Termine, Kosten, Dokumente folgen per Cascade
      audit(ctx, { action: 'legal.case_deleted', module: 'legal', targetType: 'legal_case', targetId: c.id, targetLabel: `${c.case_number} · ${c.title}` });
      return { ok: true };
    });

    // ── Beteiligte ──
    r.post('/api/legal/cases/:id/parties', { perm: 'legal.cases.edit' }, (ctx) => {
      const c = loadCase(ctx.user, ctx.params.id, { edit: true }), b = ctx.body;
      const side = oneOf(b.side, SIDES, 'Seite'), role = text(b.role, 'Rolle', 80), note = text(b.note, 'Notiz', 500);
      let kind = b.kind, refId = b.refId;
      if (kind === 'new_person' || kind === 'new_org') { // noch nicht angelegt: Eintrag im Kontaktbuch erstellen
        const n = b.create ?? {}, t = now();
        if (kind === 'new_person') {
          const first = text(n.firstName, 'Vorname', 60), last = text(n.lastName, 'Nachname', 60, true);
          const res = run('INSERT INTO contact_people (first_name,last_name,address,notes,position,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', first, last, text(n.address, 'Adresse', 200), text(n.notes, 'Notizen', 1000), text(n.position, 'Stellung', 80), ctx.user.id, t, t);
          refId = Number(res.lastInsertRowid); kind = 'contact_person';
          for (const [k, v] of [['phone', n.phone], ['email', n.email]]) { const val = text(v, 'Kontaktdaten', 120); if (val) run('INSERT INTO contact_channels (owner_type,owner_id,kind,label,value,sort) VALUES (?,?,?,?,?,?)', 'person', refId, k, '', val, 0); }
        } else {
          const res = run('INSERT INTO contact_orgs (name,address,notes,description,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', text(n.name, 'Name', 120, true), text(n.address, 'Adresse', 200), text(n.notes, 'Notizen', 1000), '', ctx.user.id, t, t);
          refId = Number(res.lastInsertRowid); kind = 'contact_org';
          for (const [k, v] of [['phone', n.phone], ['email', n.email]]) { const val = text(v, 'Kontaktdaten', 120); if (val) run('INSERT INTO contact_channels (owner_type,owner_id,kind,label,value,sort) VALUES (?,?,?,?,?,?)', 'org', refId, k, '', val, 0); }
        }
        audit(ctx, { action: kind === 'contact_person' ? 'contacts.person_created' : 'contacts.org_created', module: 'contacts', targetType: kind === 'contact_person' ? 'contact_person' : 'contact_org', targetId: refId, targetLabel: `${c.case_number} (aus Akte angelegt)` });
      } else { if (!PARTY_KINDS.includes(kind)) throw bad('Ungültige Art der Person.'); assertPartyExists(kind, refId); }
      if (get('SELECT 1 x FROM legal_case_parties WHERE case_id = ? AND kind = ? AND ref_id = ? AND side = ?', c.id, kind, refId, side)) throw bad('Diese Person ist auf dieser Seite bereits eingetragen.');
      const pid = Number(run('INSERT INTO legal_case_parties (case_id,side,kind,ref_id,role,note,created_at) VALUES (?,?,?,?,?,?,?)', c.id, side, kind, refId, role, note, now()).lastInsertRowid);
      const dto = partyDto(get('SELECT * FROM legal_case_parties WHERE id = ?', pid), ctx.user);
      logEvent(c.id, ctx.user.id, 'system', `${SIDES[side]} hinzugefügt: ${dto.name}`); touch(c.id);
      audit(ctx, { action: 'legal.party_added', module: 'legal', targetType: 'legal_case', targetId: c.id, targetLabel: `${c.case_number} · ${SIDES[side]}` });
      ctx.status = 201;
      return { party: dto, conflicts: conflictsOf(ctx.user, c, all('SELECT * FROM legal_case_parties WHERE case_id = ?', c.id).map((p) => partyDto(p, ctx.user))) };
    });
    r.patch('/api/legal/cases/:id/parties/:pid', { perm: 'legal.cases.edit' }, (ctx) => {
      const c = loadCase(ctx.user, ctx.params.id, { edit: true }), p = get('SELECT * FROM legal_case_parties WHERE id = ? AND case_id = ?', Number(ctx.params.pid), c.id);
      if (!p) throw notFound('Eintrag nicht gefunden.');
      const b = ctx.body, side = b.side !== undefined ? oneOf(b.side, SIDES, 'Seite') : p.side;
      run('UPDATE legal_case_parties SET side = ?, role = ?, note = ? WHERE id = ?', side, b.role !== undefined ? text(b.role, 'Rolle', 80) : p.role, b.note !== undefined ? text(b.note, 'Notiz', 500) : p.note, p.id); touch(c.id);
      return { party: partyDto(get('SELECT * FROM legal_case_parties WHERE id = ?', p.id), ctx.user) };
    });
    r.delete('/api/legal/cases/:id/parties/:pid', { perm: 'legal.cases.edit' }, (ctx) => {
      const c = loadCase(ctx.user, ctx.params.id, { edit: true }), p = get('SELECT * FROM legal_case_parties WHERE id = ? AND case_id = ?', Number(ctx.params.pid), c.id);
      if (!p) throw notFound('Eintrag nicht gefunden.');
      logEvent(c.id, ctx.user.id, 'system', `${SIDES[p.side]} entfernt: ${partyDto(p, ctx.user).name}`);
      run('DELETE FROM legal_case_parties WHERE id = ?', p.id); touch(c.id);
      return { ok: true };
    });

    // ── Einfache Unterlisten (Beweise, Verlauf, Termine, Kosten) ──
    const child = (path, table, { perm = 'legal.cases.edit', spec, dto, label, log }) => {
      const P = (ctx, edit) => { const c = loadCase(ctx.user, ctx.params.id, { edit: false }); if (!has(ctx.user, perm)) throw forbidden(`Dafür fehlt dir das Recht „${perm}“.`); return c; };
      const take = (b, partial) => { const o = {}; for (const [col, [key, fn, required, def]] of Object.entries(spec)) { if (b[key] !== undefined) o[col] = fn(b[key]); else if (!partial && def) o[col] = def(); else if (!partial && required) o[col] = fn(undefined); } return o; };
      r.post(`/api/legal/cases/:id/${path}`, { perm }, (ctx) => {
        const c = P(ctx), v = take(ctx.body, false), cols = { case_id: c.id, ...v, created_by: ctx.user.id, created_at: now() }, keys = Object.keys(cols);
        const rid = Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...Object.values(cols)).lastInsertRowid);
        const row = get(`SELECT * FROM ${table} WHERE id = ?`, rid); log?.(c, row, ctx, 'added'); touch(c.id);
        audit(ctx, { action: `legal.${path}_added`, module: 'legal', targetType: 'legal_case', targetId: c.id, targetLabel: `${c.case_number} · ${label}` });
        ctx.status = 201; return { item: dto(row) };
      });
      r.patch(`/api/legal/cases/:id/${path}/:rid`, { perm }, (ctx) => {
        const c = P(ctx), row = get(`SELECT * FROM ${table} WHERE id = ? AND case_id = ?`, Number(ctx.params.rid), c.id); if (!row) throw notFound('Eintrag nicht gefunden.');
        const v = take(ctx.body, true), keys = Object.keys(v);
        if (keys.length) run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => v[k]), row.id);
        const after = get(`SELECT * FROM ${table} WHERE id = ?`, row.id); log?.(c, after, ctx, 'updated', row); touch(c.id); return { item: dto(after) };
      });
      r.delete(`/api/legal/cases/:id/${path}/:rid`, { perm }, (ctx) => {
        const c = P(ctx), row = get(`SELECT * FROM ${table} WHERE id = ? AND case_id = ?`, Number(ctx.params.rid), c.id); if (!row) throw notFound('Eintrag nicht gefunden.');
        run(`DELETE FROM ${table} WHERE id = ?`, row.id); log?.(c, row, ctx, 'removed'); touch(c.id); return { ok: true };
      });
    };
    child('evidence', 'legal_case_evidence', { label: 'Beweis', spec: { side: ['side', (v) => oneOf(v, EVIDENCE_SIDES, 'Zuordnung'), true], title: ['title', (v) => str(v, 'Bezeichnung', { min: 2, max: 120 }), true], description: ['description', (v) => text(v, 'Beschreibung', 2000)] },
      dto: (e) => ({ id: e.id, side: e.side, sideLabel: EVIDENCE_SIDES[e.side], title: e.title, description: e.description, createdAt: e.created_at }),
      log: (c, e, ctx, what) => { if (what === 'added') logEvent(c.id, ctx.user.id, 'system', `Beweis hinzugefügt (${e.side === 'against' ? 'belastend' : e.side === 'for' ? 'entlastend' : 'neutral'}): ${e.title}`); } });
    child('events', 'legal_case_events', { label: 'Verlauf', spec: { kind: ['kind', (v) => oneOf(v, EVENT_KINDS, 'Art'), false, () => 'note'], text: ['text', (v) => str(v, 'Text', { min: 2, max: 2000 }), true], occurred_at: ['at', (v) => iso(v, 'Zeitpunkt'), false, () => now()] },
      dto: (e) => ({ id: e.id, at: e.occurred_at, kind: e.kind, kindLabel: EVENT_KINDS[e.kind], text: e.text }) });
    child('appointments', 'legal_case_appointments', { label: 'Termin', spec: { title: ['title', (v) => str(v, 'Titel', { min: 2, max: 120 }), true], kind: ['kind', (v) => oneOf(v, APPT_KINDS, 'Art'), true], starts_at: ['startsAt', (v) => iso(v, 'Beginn'), true], location: ['location', (v) => text(v, 'Ort', 120)], note: ['note', (v) => text(v, 'Notiz', 1000)], done: ['done', (v) => (v ? 1 : 0)] },
      dto: (a) => ({ id: a.id, title: a.title, kind: a.kind, kindLabel: APPT_KINDS[a.kind], startsAt: a.starts_at, location: a.location, note: a.note, done: !!a.done }),
      log: (c, a, ctx, what, before) => { if (what === 'added') logEvent(c.id, ctx.user.id, 'system', `Termin eingetragen: ${a.title} (${new Date(a.starts_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })})`); if (what === 'updated' && before && !before.done && a.done) logEvent(c.id, ctx.user.id, 'system', `Termin erledigt: ${a.title}`); } });
    child('costs', 'legal_case_costs', { perm: 'legal.cases.billing', label: 'Kosten', spec: { kind: ['kind', (v) => oneOf(v, COST_KINDS, 'Art'), true], description: ['description', (v) => str(v, 'Beschreibung', { min: 2, max: 200 }), true], amount_cents: ['amountCents', (v) => cents(v, 'Betrag'), true], status: ['status', (v) => oneOf(v, COST_STATUS, 'Status'), false, () => 'open'] },
      dto: (x) => ({ id: x.id, kind: x.kind, kindLabel: COST_KINDS[x.kind], description: x.description, amountCents: x.amount_cents, status: x.status, statusLabel: COST_STATUS[x.status], billedAt: x.billed_at }),
      log: (c, x, ctx, what, before) => { if (what === 'updated' && before && before.status !== x.status && ['billed', 'paid'].includes(x.status)) run('UPDATE legal_case_costs SET billed_at = COALESCE(billed_at, ?) WHERE id = ?', now(), x.id); } });

    // ── Dokumente: Link (z. B. Google Drive) oder Datei ──
    r.post('/api/legal/cases/:id/docs', { perm: 'legal.cases.edit', bodyLimit: 12 * 1024 * 1024 }, (ctx) => {
      const c = loadCase(ctx.user, ctx.params.id, { edit: true }), b = ctx.body;
      const title = str(b.title, 'Titel', { min: 2, max: 120 }), description = text(b.description, 'Beschreibung', 500);
      let kind, url = null, ext = null, size = 0, buf = null;
      if (b.url) {
        let u; try { u = new URL(String(b.url).trim()); } catch { throw bad('Bitte einen gültigen Link angeben.'); }
        if (u.protocol !== 'https:') throw bad('Es sind nur https-Links erlaubt.');
        kind = 'link'; url = u.toString().slice(0, 600);
      } else {
        if (typeof b.data !== 'string') throw bad('Bitte einen Link oder eine Datei angeben.');
        buf = Buffer.from(b.data.replace(/^data:[^,]*,/, ''), 'base64');
        if (!buf.length) throw bad('Die Datei ist leer.'); if (buf.length > 8 * 1024 * 1024) throw bad('Die Datei ist zu groß (maximal 8 MB).');
        ext = checkFile(b.filename, buf); kind = 'file'; size = buf.length;
      }
      if (get('SELECT COUNT(*) c FROM legal_case_docs WHERE case_id = ?', c.id).c >= 100) throw bad('Es sind höchstens 100 Dokumente je Akte möglich.');
      const id = Number(run('INSERT INTO legal_case_docs (case_id,title,description,kind,url,ext,size,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)', c.id, title, description, kind, url, ext, size, ctx.user.id, now()).lastInsertRowid);
      if (buf) { mkdirSync(dir(), { recursive: true }); writeFileSync(join(dir(), `${id}.${ext}`), buf); }
      logEvent(c.id, ctx.user.id, 'document', `Dokument angehängt: ${title}`); touch(c.id);
      audit(ctx, { action: 'legal.doc_attached', module: 'legal', targetType: 'legal_case', targetId: c.id, targetLabel: `${c.case_number} · ${title}` });
      ctx.status = 201;
      const d = get('SELECT * FROM legal_case_docs WHERE id = ?', id);
      return { doc: { id: d.id, title: d.title, description: d.description, kind: d.kind, url: d.url, ext: d.ext, size: d.size, createdAt: d.created_at } };
    });
    const loadDoc = (ctx) => { const c = loadCase(ctx.user, ctx.params.id); const d = get('SELECT * FROM legal_case_docs WHERE id = ? AND case_id = ?', Number(ctx.params.did), c.id); if (!d) throw notFound('Dokument nicht gefunden.'); return { c, d }; };
    r.get('/api/legal/cases/:id/docs/:did/file', V, (ctx) => {
      const { d } = loadDoc(ctx); if (d.kind !== 'file' || !existsSync(fileOf(d))) throw notFound('Datei nicht gefunden.');
      ctx.raw = { contentType: DOC_TYPES[d.ext] ?? 'application/octet-stream', body: readFileSync(fileOf(d)), inline: INLINE.has(d.ext), filename: `${safeName(d.title)}.${d.ext}`, cache: 'no-store' };
    });
    r.patch('/api/legal/cases/:id/docs/:did', { perm: 'legal.cases.edit' }, (ctx) => {
      const { c, d } = loadDoc(ctx); if (!has(ctx.user, 'legal.cases.edit')) throw forbidden();
      run('UPDATE legal_case_docs SET title = ?, description = ? WHERE id = ?', ctx.body.title !== undefined ? str(ctx.body.title, 'Titel', { min: 2, max: 120 }) : d.title, ctx.body.description !== undefined ? text(ctx.body.description, 'Beschreibung', 500) : d.description, d.id); touch(c.id);
      return { ok: true };
    });
    r.delete('/api/legal/cases/:id/docs/:did', { perm: 'legal.cases.edit' }, (ctx) => {
      const { c, d } = loadDoc(ctx);
      if (d.kind === 'file') { try { unlinkSync(fileOf(d)); } catch { /* egal */ } }
      run('DELETE FROM legal_case_docs WHERE id = ?', d.id); logEvent(c.id, ctx.user.id, 'document', `Dokument entfernt: ${d.title}`); touch(c.id);
      return { ok: true };
    });

    // ── Verknüpfte Akten ──
    r.post('/api/legal/cases/:id/related', { perm: 'legal.cases.edit' }, (ctx) => {
      const c = loadCase(ctx.user, ctx.params.id, { edit: true }), o = loadCase(ctx.user, ctx.body.relatedId);
      if (o.id === c.id) throw bad('Eine Akte kann nicht mit sich selbst verknüpft werden.');
      run('INSERT OR IGNORE INTO legal_case_links (case_id,related_id) VALUES (?,?)', c.id, o.id); run('INSERT OR IGNORE INTO legal_case_links (case_id,related_id) VALUES (?,?)', o.id, c.id);
      logEvent(c.id, ctx.user.id, 'system', `Akte verknüpft: ${o.case_number}`); touch(c.id);
      return { related: { id: o.id, number: o.case_number, title: o.title } };
    });
    r.delete('/api/legal/cases/:id/related/:rid', { perm: 'legal.cases.edit' }, (ctx) => {
      const c = loadCase(ctx.user, ctx.params.id, { edit: true }), rid = Number(ctx.params.rid);
      run('DELETE FROM legal_case_links WHERE (case_id = ? AND related_id = ?) OR (case_id = ? AND related_id = ?)', c.id, rid, rid, c.id);
      return { ok: true };
    });
  },
};
