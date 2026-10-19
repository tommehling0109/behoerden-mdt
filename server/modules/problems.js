import { all, get, now } from '../core/db.js';
import { getConfig } from '../core/config.js';
import { lookupEntries } from '../core/lookups.js';
import { levelFor } from './warehouses.js';
import { usedSpace } from '../core/stock.js';
import { overdueTaskProblems } from './schedule.js';
import { mayAccessCase } from './legalcases.js';
import { inactiveProblems } from './activity.js';

/**
 * Problemleiste (Desktop, rechts unter dem Schwarzen Brett): akute Probleme aus allen Bereichen. Die Liste wird bei jeder Abfrage frisch aus
 * den Daten berechnet (keine eigene Tabelle) – ist das Problem behoben, verschwindet es von selbst. Jeder bekommt nur Probleme aus Bereichen,
 * auf die er Zugriff hat (gleiche Rechte wie in der jeweiligen App). Externe Partner sehen die Leiste nie. Probleme lassen sich nicht wegklicken.
 */
const has = (u, p) => u.isAdmin || u.perms.has(p);
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const num = (k, d) => { const v = Number(getConfig(k)); return Number.isFinite(v) && v >= 0 ? v : d; };
const ago = (iso) => { const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); return m < 60 ? `seit ${m} Min.` : m < 1440 ? `seit ${Math.round(m / 60)} Std.` : `seit ${Math.round(m / 1440)} Tag${Math.round(m / 1440) === 1 ? '' : 'en'}`; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Lager: ab der Warnschwelle (Standard 75 %) ein Problem, ab der kritischen Schwelle (Standard 90 %) ein kritisches Problem – nur Lager mit festgelegter Kapazität. */
function fillProblems(user) {
  const warn = num('problems.warehouse_warn_percent', 75), crit = Math.max(warn, num('problems.warehouse_critical_percent', 90)), out = [];
  if (!(warn > 0)) return out;
  for (const w of all('SELECT * FROM warehouses WHERE is_active = 1 AND capacity IS NOT NULL AND capacity > 0')) {
    if (!levelFor(user, w)) continue;
    const used = usedSpace(w.id), exact = (used / w.capacity) * 100, pct = Math.round(exact);
    if (exact < warn) continue;
    const critical = exact >= crit;
    out.push({ id: `wh:${w.id}:fill:${critical ? 'crit' : 'warn'}`, severity: critical ? 'critical' : 'warn', title: `${w.warehouse_number} · Lager ${critical ? 'fast voll' : 'füllt sich'} (${pct} %)`,
      detail: `${w.name} · ${used.toLocaleString('de-DE')} / ${w.capacity.toLocaleString('de-DE')} Slots belegt`, since: get('SELECT MAX(created_at) t FROM warehouse_events WHERE warehouse_id = ?', w.id)?.t ?? w.updated_at, target: { app: 'warehouse' } });
  }
  return out;
}

const SOURCES = [
  { area: 'vehicles', label: 'Fahrzeuge', icon: 'car', perm: 'vehicles.view', list: () => {
    const cond = Object.fromEntries(lookupEntries('vehicles.condition').map((e) => [e.key, e.label])), out = [], t = today();
    for (const v of all("SELECT id, vehicle_number, plate, name, condition_key, inspection_due, updated_at FROM vehicles WHERE is_active = 1 AND (condition_key IN ('damaged','broken') OR (inspection_due IS NOT NULL AND inspection_due < ?))", t)) {
      const who = [v.plate, v.name].filter(Boolean).join(' · ') || v.vehicle_number;
      if (['damaged', 'broken'].includes(v.condition_key)) out.push({ id: `vehicle:${v.id}:cond`, severity: v.condition_key === 'broken' ? 'critical' : 'warn', title: `${who} · ${cond[v.condition_key] ?? v.condition_key}`, detail: 'Fahrzeug ist nicht einsatzbereit', since: v.updated_at, target: { app: 'vehicles' } });
      if (v.inspection_due && v.inspection_due < t) out.push({ id: `vehicle:${v.id}:insp`, severity: 'warn', title: `${who} · Prüfung überfällig`, detail: `Fällig war ${v.inspection_due.split('-').reverse().join('.')}`, since: `${v.inspection_due}T00:00:00.000Z`, target: { app: 'vehicles' } });
    }
    return out;
  } },
  { area: 'market', label: 'Börse', icon: 'tag', perm: 'market.view', list: () => all(`SELECT d.id, d.deal_number, d.status, d.updated_at, d.assignee_id, p.partner_number, p.name pname, p.user_id puser, CASE WHEN i.is_other = 1 AND d.other_name IS NOT NULL THEN 'Sonstiges: ' || d.other_name ELSE i.name END item
      FROM market_deals d JOIN partners p ON p.id = d.partner_id JOIN market_items i ON i.id = d.item_id WHERE d.status IN ('submitted','negotiating') AND d.turn = 'staff' AND d.updated_at < ? ORDER BY d.updated_at`, hoursAgo(num('problems.market_hours', 1)))
    .map((d) => ({ id: `deal:${d.id}`, severity: 'warn', title: `Geschäft ${d.deal_number} wartet auf uns`, detail: `${d.partner_number} · ${d.item} · ${ago(d.updated_at)}${d.assignee_id ? '' : ' · nicht zugewiesen'}`, since: d.updated_at, target: { app: 'market', dealId: d.id } })) },
  { area: 'legal', label: 'Rechtsfälle', icon: 'scale', perm: 'legal.cases.view', list: (user) => {
    const closed = new Set(lookupEntries('legal.case_status').filter((e) => ['closed', 'archived'].includes(e.key)).map((e) => e.id)), out = [], lookahead = num('problems.legal_hours', 24), n = now();
    const ok = (c) => c && !closed.has(c.status_id) && mayAccessCase(user, c);
    for (const a of all('SELECT a.id, a.title, a.kind, a.starts_at, a.case_id FROM legal_case_appointments a WHERE a.done = 0 AND a.starts_at < ? ORDER BY a.starts_at', new Date(Date.now() + lookahead * 3600_000).toISOString())) {
      const c = get('SELECT * FROM legal_cases WHERE id = ?', a.case_id); if (!ok(c)) continue;
      const late = a.starts_at < n;
      out.push({ id: `legal:appt:${a.id}`, severity: late ? 'critical' : 'warn', title: `${c.case_number} · ${a.kind === 'deadline' ? 'Frist' : 'Termin'}: ${a.title}`, detail: late ? `Überfällig ${ago(a.starts_at)}` : `Steht an: ${new Date(a.starts_at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`, since: a.starts_at, target: { app: 'legal' } });
    }
    for (const c of all('SELECT * FROM legal_cases WHERE lead_user_id IS NULL')) if (ok(c)) out.push({ id: `legal:lead:${c.id}`, severity: 'warn', title: `${c.case_number} · ${c.title}`, detail: 'Offene Akte ohne verantwortliche Person', since: c.created_at, target: { app: 'legal' } });
    return out;
  } },
  { area: 'warehouse', label: 'Lager', icon: 'storage', perm: 'warehouse.view', list: (user) => [...fillProblems(user), ...all("SELECT * FROM warehouses WHERE is_active = 1 AND rent_enabled = 1 AND rent_due_date IS NOT NULL AND (rent_paid_date IS NULL OR rent_paid_date < rent_due_date)")
    .filter((w) => levelFor(user, w)).map((w) => ({ id: `wh:${w.id}:rent`, severity: 'warn', title: `${w.warehouse_number} · Lagerkosten fällig`, detail: `${w.name}${w.rent_cents ? ` · ${(w.rent_cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2 })} ${getConfig('market.currency') ?? '$'}` : ''} · noch nicht als bezahlt bestätigt`, since: `${w.rent_due_date}T00:00:00.000Z`, target: { app: 'warehouse' } }))] },
  { area: 'activity', label: 'Mitglieder', icon: 'users', perm: 'activity.view', list: () => inactiveProblems() },
  { area: 'schedule', label: 'Aufträge', icon: 'flag', perm: 'schedule.view', list: (user) => overdueTaskProblems(user) },
  { area: 'credit', label: 'Kredit', icon: 'bank', perm: 'credit.view', list: () => [
    ...all("SELECT i.id, i.seq, i.due_date, l.id loan_id, l.loan_number, p.partner_number FROM credit_installments i JOIN credit_loans l ON l.id = i.loan_id JOIN partners p ON p.id = l.partner_id WHERE l.status = 'active' AND i.status = 'open' AND i.due_date < ? ORDER BY i.due_date", today())
      .map((r) => ({ id: `inst:${r.id}`, severity: 'critical', title: `${r.loan_number} · Rate ${r.seq} überfällig`, detail: `${r.partner_number} · fällig war ${r.due_date.split('-').reverse().join('.')}`, since: `${r.due_date}T00:00:00.000Z`, target: { app: 'credit', loanId: r.loan_id } })),
    ...all("SELECT l.id, l.loan_number, l.updated_at, p.partner_number FROM credit_loans l JOIN partners p ON p.id = l.partner_id WHERE l.status IN ('requested','negotiating') AND l.turn = 'staff' ORDER BY l.updated_at")
      .map((l) => ({ id: `loan:${l.id}`, severity: 'warn', title: `${l.loan_number} · Kreditanfrage wartet auf uns`, detail: `${l.partner_number} · ${ago(l.updated_at)}`, since: l.updated_at, target: { app: 'credit', loanId: l.id } })),
  ] },
  { area: 'tab', label: 'Deckel', icon: 'dollar', perm: 'tab.view', list: () => all("SELECT s.id, s.statement_number, s.submitted_at, s.updated_at, c.name FROM tab_statements s JOIN tab_companies c ON c.id = s.company_id WHERE s.status IN ('submitted','review') AND COALESCE(s.submitted_at, s.updated_at) < ? ORDER BY s.submitted_at", hoursAgo(num('problems.statement_hours', 24)))
    .map((s) => ({ id: `stmt:${s.id}`, severity: 'warn', title: `Abrechnung ${s.statement_number} wartet auf Prüfung`, detail: `${s.name} · ${ago(s.submitted_at ?? s.updated_at)}`, since: s.submitted_at ?? s.updated_at, target: { app: 'tab', statementId: s.id } })) },
  { area: 'tickets', label: 'Tickets', icon: 'bug', perm: 'tickets.manage', list: () => all("SELECT id, ticket_number, title, created_at FROM tickets WHERE status = 'open' AND priority = 'high' ORDER BY created_at")
    .map((t) => ({ id: `ticket:${t.id}`, severity: 'warn', title: `${t.ticket_number} · ${t.title}`, detail: `Dringendes Ticket · ${ago(t.created_at)}`, since: t.created_at, target: { app: 'tickets', ticketId: t.id } })) },
  { area: 'users', label: 'Benutzer', icon: 'userPlus', perm: 'users.approve', list: () => {
    const p = all("SELECT created_at FROM users WHERE status = 'pending' ORDER BY created_at");
    return p.length ? [{ id: 'users:pending', severity: 'warn', title: p.length === 1 ? '1 Zugangsantrag wartet auf Freischaltung' : `${p.length} Zugangsanträge warten auf Freischaltung`, detail: ago(p[0].created_at), since: p[0].created_at, target: { app: 'users' } }] : [];
  } },
];

export function problemsFor(user) {
  const out = [];
  for (const s of SOURCES) {
    if (!has(user, s.perm)) continue;
    try { for (const p of s.list(user)) out.push({ ...p, area: s.area, areaLabel: s.label, icon: s.icon }); } catch { /* eine defekte Quelle darf die Leiste nicht lahmlegen */ }
  }
  out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1) || String(a.since).localeCompare(String(b.since)));
  return out;
}

export default {
  name: 'problems',
  config: [
    { key: 'problems.market_hours', group: 'Probleme', label: 'Börse: Geschäft beim Team gilt als Problem nach (Stunden)', help: 'Ein Geschäft, das so lange auf eine Antwort des Teams wartet, erscheint in der Problemleiste.', type: 'number', default: 1, min: 0, max: 720 },
    { key: 'problems.legal_hours', group: 'Probleme', label: 'Rechtsfälle: Fristen/Termine zeigen ab (Stunden vorher)', help: 'Anstehende Fristen und Termine erscheinen so viele Stunden vorher; überfällige immer.', type: 'number', default: 24, min: 0, max: 720 },
    { key: 'problems.warehouse_warn_percent', group: 'Probleme', label: 'Lager: Problem ab Füllstand (%)', help: 'Ein Lager mit festgelegter Kapazität erscheint als Problem, sobald es so voll ist. 0 = Lagerfüllstand nie melden.', type: 'number', default: 75, min: 0, max: 100 },
    { key: 'problems.warehouse_critical_percent', group: 'Probleme', label: 'Lager: kritisches Problem ab Füllstand (%)', help: 'Ab diesem Füllstand wird das Problem kritisch (rot, blinkt). Mindestens so hoch wie die Schwelle für das normale Problem.', type: 'number', default: 90, min: 1, max: 100 },
    { key: 'problems.statement_hours', group: 'Probleme', label: 'Deckel: Abrechnung wartet auf Prüfung nach (Stunden)', type: 'number', default: 24, min: 0, max: 720 },
  ],
  routes(r) {
    // Jedes aktive Mitglied; es kommen nur Probleme aus Bereichen mit Zugriff. Externe Partner haben keine Mitglieder-Sitzung und sehen nichts.
    r.get('/api/problems', (ctx) => { const problems = problemsFor(ctx.user); return { problems, total: problems.length, critical: problems.filter((p) => p.severity === 'critical').length }; });
  },
};
