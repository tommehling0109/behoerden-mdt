import { all, get, run, tx, now } from '../core/db.js';
import { levelBrief, awardForLoan } from '../core/levels.js';
import { bad, conflict, forbidden, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { getConfig } from '../core/config.js';
import { allocateNumber } from '../core/numbers.js';
import { labelForUser } from '../core/identity.js';
import { registerPartnerApp } from '../core/partner-apps.js';
import { notify, staffWith } from '../core/notifications.js';
import { creditPayout, creditExpectInstallment, creditSettleInstallment, creditCancelInstallments } from '../core/ledger.js';
import { calcLoan, splitInstallments, dueDates, rateText, RATE_PERIODS } from '../core/credit-calc.js';
import { registerWidget } from './dashboard.js';
import { purgeLoan } from '../core/purge.js';

/**
 * Kreditsystem (wie bei einer Bank): Externe Partner-Zugänge mit der App „Kredit“ beantragen Summe, Laufzeit (Anzahl Raten) und
 * Ratenrhythmus (wöchentlich/monatlich). Das Team nimmt an oder macht einen Gegenvorschlag und legt Zinsen (keine / Zinssatz pro Tag, Woche
 * oder Monat) sowie das Zahlungsziel („Wohin zahlen?“) fest – wie in der Börse wechselt der Zug hin und her.
 * Nach Annahme bestätigt das Team die Auszahlung; daraus entsteht der Tilgungsplan mit Fälligkeiten. Zahlungen werden erfasst,
 * am Ende gilt der Kredit als abbezahlt und bleibt im Verlauf. Alle Geldbewegungen stehen im Finanz-Journal.
 */
registerPartnerApp({ id: 'credit', label: 'Kredit', icon: 'dollar', description: 'Kredite anfragen, Konditionen einsehen und Raten verfolgen' });

const STATUS = {
  requested: { label: 'Angefragt', color: '#60a5fa' }, negotiating: { label: 'In Verhandlung', color: '#fbbf24' }, accepted: { label: 'Angenommen – Auszahlung offen', color: '#34d399' },
  active: { label: 'Läuft', color: '#38bdf8' }, completed: { label: 'Abbezahlt', color: '#22c55e' }, rejected: { label: 'Abgelehnt', color: '#f87171' },
  withdrawn: { label: 'Zurückgezogen', color: '#94a3b8' }, cancelled: { label: 'Storniert', color: '#94a3b8' }, defaulted: { label: 'Ausgefallen', color: '#ef4444' },
};
const OPEN = ['requested', 'negotiating'];
const FINAL = ['completed', 'rejected', 'withdrawn', 'cancelled', 'defaulted'];
const FREQS = { weekly: 'Wöchentlich', monthly: 'Monatlich' };
const CENTS_MAX = 100_000_000_00;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const cur = () => getConfig('market.currency') ?? '$';
const fmtC = (c) => `${(c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur()}`;

const cents = (v, name) => { if (!Number.isInteger(v) || v < 1 || v > CENTS_MAX) throw bad(`${name}: gültiger Betrag erforderlich.`); return v; };

// ── Berechnung & DTOs ──
const termsOf = (l) => ({ principal: l.principal_cents, count: l.term_count, frequency: l.frequency, type: l.interest_set ? l.interest_type : 'none', rateBp: l.rate_bp, ratePeriod: l.rate_period });
const SQL = 'SELECT l.*, p.partner_number, p.name partner_name FROM credit_loans l JOIN partners p ON p.id = l.partner_id';

function snapshot(l) {
  const t = termsOf(l), c = calcLoan(t);
  return JSON.stringify({ principalCents: t.principal, termCount: t.count, frequency: t.frequency, interestSet: !!l.interest_set, rate: rateText(t.type, t.rateBp, t.ratePeriod), interestCents: c.interest, totalCents: c.total, installmentCents: c.installment, payTo: l.pay_to });
}
const insts = (loanId) => all('SELECT * FROM credit_installments WHERE loan_id = ? ORDER BY seq', loanId);

function loanDto(l, { partnerView = false, detail = false } = {}) {
  const t = termsOf(l), c = calcLoan(t);
  const today = localDate();
  const rows = ['active', 'completed', 'defaulted'].includes(l.status) ? insts(l.id) : [];
  const open = rows.filter((r) => r.status === 'open');
  const next = open[0];
  const out = {
    id: l.id, number: l.loan_number, status: l.status, statusLabel: STATUS[l.status].label, statusColor: STATUS[l.status].color, turn: l.turn, proposedBy: l.proposed_by,
    principalCents: l.principal_cents, termCount: l.term_count, frequency: l.frequency, frequencyLabel: FREQS[l.frequency], note: l.note,
    interest: { set: !!l.interest_set, type: t.type, rateBp: l.rate_bp, ratePeriod: l.rate_period, text: l.interest_set ? rateText(t.type, l.rate_bp, l.rate_period) : 'wird vom Team festgelegt' },
    interestCents: c.interest, totalCents: c.total, installmentCents: c.installment, durationDays: c.days, payTo: l.pay_to,
    startDate: l.start_date, endDate: rows.length ? rows.at(-1).due_date : null, closedAt: l.closed_at, createdAt: l.created_at, updatedAt: l.updated_at,
    paidCents: rows.reduce((a, r) => a + r.paid_cents, 0), remainingCents: open.reduce((a, r) => a + (r.amount_cents - r.paid_cents), 0),
    nextDue: next ? { date: next.due_date, amountCents: next.amount_cents - next.paid_cents, overdue: next.due_date < today } : null,
    overdueCount: open.filter((r) => r.due_date < today).length, installmentsPaid: rows.filter((r) => r.status === 'paid').length,
    partner: partnerView ? undefined : { id: l.partner_id, number: l.partner_number, name: l.partner_name, level: levelBrief(l.partner_id) },
  };
  if (detail) {
    out.installments = rows.map((r) => ({ id: r.id, seq: r.seq, dueDate: r.due_date, amountCents: r.amount_cents, principalCents: r.principal_cents, interestCents: r.interest_cents, paidCents: r.paid_cents, status: r.status, paidAt: r.paid_at, reportedAt: r.reported_at, overdue: r.status === 'open' && r.due_date < today, note: partnerView ? '' : r.note }));
  }
  return out;
}
const loadLoan = (id) => get(`${SQL} WHERE l.id = ?`, id);
const eventsOf = (loanId, partnerView, viewerId) => all(`SELECT * FROM credit_events WHERE loan_id = ? ${partnerView ? 'AND internal = 0' : ''} ORDER BY id`, loanId).map((e) => ({
  id: e.id, kind: e.kind, actorType: e.actor_type, actor: partnerView ? (e.actor_type === 'partner' ? 'Du' : e.actor_type === 'system' ? 'System' : 'Team') : (e.actor_type === 'staff' ? (labelForUser(e.actor_id, viewerId) ?? 'Mitglied') : e.actor_type === 'system' ? 'System' : 'Partner'),
  text: e.text, snapshot: e.snapshot ? JSON.parse(e.snapshot) : null, internal: !!e.internal, createdAt: e.created_at,
}));
const addEvent = (loanId, actor, kind, text, { snap = null, internal = false } = {}) => Number(run('INSERT INTO credit_events (loan_id,actor_type,actor_id,kind,text,snapshot,internal,created_at) VALUES (?,?,?,?,?,?,?,?)', loanId, actor.type, actor.id ?? null, kind, text ?? null, snap, internal ? 1 : 0, now()).lastInsertRowid);
const touch = (id, fields = {}) => { const cols = Object.keys(fields); run(`UPDATE credit_loans SET ${[...cols.map((c) => `${c} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`, ...cols.map((c) => fields[c]), now(), id); };

// ── Regeln ──
const limits = () => ({
  min: Math.round((getConfig('credit.min_amount') ?? 100) * 100), max: Math.round((getConfig('credit.max_amount') ?? 1_000_000) * 100),
  maxTerm: { weekly: getConfig('credit.max_term_weekly') ?? 104, monthly: getConfig('credit.max_term_monthly') ?? 36 },
  maxOpenRequests: getConfig('credit.max_open_requests') ?? 3,
});
function validateTerms({ principal, count, frequency }) {
  const L = limits();
  if (!FREQS[frequency]) throw bad('Ratenrhythmus: wöchentlich oder monatlich.');
  if (principal < L.min || principal > L.max) throw bad(`Die Kreditsumme muss zwischen ${fmtC(L.min)} und ${fmtC(L.max)} liegen.`);
  if (!Number.isInteger(count) || count < 1 || count > L.maxTerm[frequency]) throw bad(`Die Laufzeit muss zwischen 1 und ${L.maxTerm[frequency]} Raten (${frequency === 'weekly' ? 'Wochen' : 'Monate'}) liegen.`);
}
const outstandingPrincipal = (partnerId, exceptLoanId = 0) => {
  const accepted = get("SELECT COALESCE(SUM(principal_cents),0) s FROM credit_loans WHERE partner_id = ? AND status = 'accepted' AND id != ?", partnerId, exceptLoanId).s;
  const active = get("SELECT COALESCE(SUM(i.principal_cents),0) s FROM credit_installments i JOIN credit_loans l ON l.id = i.loan_id WHERE l.partner_id = ? AND l.status = 'active' AND i.status = 'open' AND l.id != ?", partnerId, exceptLoanId).s;
  return accepted + active;
};
function checkLimit(partnerId, principal, exceptLoanId = 0) {
  const lim = get('SELECT credit_limit_cents l FROM partners WHERE id = ?', partnerId)?.l;
  if (lim != null && outstandingPrincipal(partnerId, exceptLoanId) + principal > lim) throw conflict(`Der Kreditrahmen von ${fmtC(lim)} wäre überschritten (bereits offen: ${fmtC(outstandingPrincipal(partnerId, exceptLoanId))}).`);
}

function termsFromBody(b, l) {
  const t = { principal: l.principal_cents, count: l.term_count, frequency: l.frequency };
  if (b.principalCents !== undefined) t.principal = cents(b.principalCents, 'Kreditsumme');
  if (b.termCount !== undefined) t.count = b.termCount;
  if (b.frequency !== undefined) t.frequency = b.frequency;
  validateTerms(t);
  return t;
}
function interestFromBody(b) {
  const type = b.interestType;
  if (!['none', 'flat'].includes(type)) throw bad('Zinsen: „zinsfrei“ oder „Zinssatz“ wählen.');
  if (type === 'none') return { interest_type: 'none', rate_bp: 0, interest_set: 1 };
  const pct = Number(b.ratePercent);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 1000) throw bad('Zinssatz: Zahl größer 0 (in Prozent) erforderlich.');
  if (!RATE_PERIODS[b.ratePeriod]) throw bad('Zinszeitraum: Tag, Woche oder Monat.');
  return { interest_type: 'flat', rate_bp: Math.round(pct * 100), rate_period: b.ratePeriod, interest_set: 1 };
}

function applyAction(loanId, actor, action, b) {
  return tx(() => {
    const l = get('SELECT * FROM credit_loans WHERE id = ?', loanId);
    if (!l) throw notFound('Kredit nicht gefunden.');
    const side = actor.type, other = side === 'staff' ? 'partner' : 'staff';
    const needOpen = () => { if (!OPEN.includes(l.status)) throw conflict('Der Kredit befindet sich nicht mehr in der Verhandlung.'); };
    const needTurn = () => { if (l.turn !== side) throw conflict(side === 'partner' ? 'Du bist gerade nicht am Zug. Bitte warte auf eine Antwort.' : 'Die Gegenseite ist am Zug.'); };
    const text = str(b.text, 'Text', { max: 1000, required: false });
    const staffOnly = () => { if (side !== 'staff') throw forbidden(); };
    let evId = null, evText = text;
    const ev = (kind, t = text, o = {}) => { evId = addEvent(loanId, actor, kind, t, o); return evId; };
    const fresh = () => get('SELECT * FROM credit_loans WHERE id = ?', loanId);

    switch (action) {
      case 'accept': {
        needOpen(); needTurn();
        const f = {};
        if (side === 'staff') {
          const payTo = str(b.payTo ?? l.pay_to, 'Zahlungsziel', { min: 3, max: 300 });
          f.pay_to = payTo;
          if (!l.interest_set) Object.assign(f, { interest_type: 'none', rate_bp: 0, interest_set: 1 }); // Annahme einer Anfrage ohne Zinsangabe = zinsfrei
        }
        checkLimit(l.partner_id, l.principal_cents, loanId);
        touch(loanId, { ...f, status: 'accepted', turn: null });
        ev('accept', text, { snap: snapshot({ ...l, ...f }) });
        break;
      }
      case 'counter': {
        needOpen(); needTurn();
        const t = termsFromBody(b, l);
        const f = { principal_cents: t.principal, term_count: t.count, frequency: t.frequency, status: 'negotiating', turn: other, proposed_by: side };
        if (side === 'staff') {
          Object.assign(f, interestFromBody(b));
          f.pay_to = str(b.payTo ?? l.pay_to, 'Zahlungsziel', { min: 3, max: 300 });
        }
        checkLimit(l.partner_id, t.principal, loanId);
        touch(loanId, f);
        ev('counter', text, { snap: snapshot({ ...l, ...f }) });
        break;
      }
      case 'reject': needOpen(); if (side === 'partner') needTurn(); touch(loanId, { status: 'rejected', turn: null, closed_at: now() }); ev('reject'); break;
      case 'withdraw': if (side !== 'partner') throw forbidden(); needOpen(); touch(loanId, { status: 'withdrawn', turn: null, closed_at: now() }); ev('withdraw'); break;
      case 'message': {
        if (FINAL.includes(l.status)) throw conflict('Der Kredit ist beendet.');
        if (!text) throw bad('Bitte gib eine Nachricht ein.');
        const internal = side === 'staff' && b.internal === true;
        ev(internal ? 'note' : 'message', text, { internal }); touch(loanId); break;
      }
      case 'cancel': staffOnly(); if (l.status !== 'accepted') throw conflict('Stornieren geht nur vor der Auszahlung.'); touch(loanId, { status: 'cancelled', closed_at: now() }); ev('cancel'); break;
      case 'disburse': {
        staffOnly();
        if (l.status !== 'accepted') throw conflict('Die Auszahlung ist nur für angenommene Kredite möglich.');
        const start = b.date || localDate();
        if (!DATE_RE.test(start)) throw bad('Ungültiges Auszahlungsdatum.');
        const t = termsOf(l), c = calcLoan(t);
        const split = splitInstallments({ principal: t.principal, interest: c.interest, count: t.count });
        const dates = dueDates(start, t.count, t.frequency);
        touch(loanId, { status: 'active', start_date: start, disbursed_at: now() });
        const loan = fresh();
        creditPayout(loan);
        split.forEach((s, i) => {
          const r = run('INSERT INTO credit_installments (loan_id,seq,due_date,principal_cents,interest_cents,amount_cents) VALUES (?,?,?,?,?,?)', loanId, i + 1, dates[i], s.principal, s.interest, s.amount);
          creditExpectInstallment(loan, { id: Number(r.lastInsertRowid), seq: i + 1, amount_cents: s.amount, interest_cents: s.interest });
        });
        ev('disburse', `Auszahlung von ${fmtC(l.principal_cents)} bestätigt (${start}). ${t.count} Raten, erste Fälligkeit ${dates[0]}, letzte ${dates.at(-1)}.${text ? ' ' + text : ''}`, { snap: snapshot(l) });
        break;
      }
      case 'payment': {
        staffOnly();
        if (l.status !== 'active') throw conflict('Zahlungen lassen sich nur bei laufenden Krediten erfassen.');
        const inst = get('SELECT * FROM credit_installments WHERE id = ? AND loan_id = ?', b.installmentId, loanId);
        if (!inst || inst.status !== 'open') throw bad('Unbekannte oder bereits bezahlte Rate.');
        const rest = inst.amount_cents - inst.paid_cents;
        const amount = b.amountCents === undefined ? rest : cents(b.amountCents, 'Betrag');
        if (amount > rest) throw bad(`Der Betrag übersteigt die offene Rate (${fmtC(rest)}).`);
        const date = b.date || localDate();
        if (!DATE_RE.test(date)) throw bad('Ungültiges Zahlungsdatum.');
        const paid = inst.paid_cents + amount, full = paid >= inst.amount_cents;
        run('UPDATE credit_installments SET paid_cents = ?, status = ?, paid_at = ?, note = ? WHERE id = ?', paid, full ? 'paid' : 'open', full ? new Date(`${date}T12:00:00`).toISOString() : inst.paid_at, str(b.note, 'Notiz', { max: 200, required: false }), inst.id);
        if (full) creditSettleInstallment(inst.id);
        const left = get("SELECT COUNT(*) c FROM credit_installments WHERE loan_id = ? AND status = 'open'", loanId).c;
        if (!left) { touch(loanId, { status: 'completed', closed_at: now() }); awardForLoan(loanId); } else touch(loanId);
        ev('payment', `Zahlung über ${fmtC(amount)} zu Rate ${inst.seq} am ${date} erfasst${full ? ' – Rate bezahlt' : ` (noch offen: ${fmtC(inst.amount_cents - paid)})`}${!left ? '. Der Kredit ist vollständig abbezahlt.' : ''}`);
        evText = !left ? 'completed' : null;
        break;
      }
      case 'report': {
        if (side !== 'partner') throw forbidden();
        if (l.status !== 'active') throw conflict('Nur bei laufenden Krediten möglich.');
        const inst = get('SELECT * FROM credit_installments WHERE id = ? AND loan_id = ?', b.installmentId, loanId);
        if (!inst || inst.status !== 'open') throw bad('Unbekannte oder bereits bezahlte Rate.');
        run('UPDATE credit_installments SET reported_at = ? WHERE id = ?', now(), inst.id);
        ev('report', `Zahlung zu Rate ${inst.seq} (${fmtC(inst.amount_cents - inst.paid_cents)}) als gezahlt gemeldet – bitte prüfen`); touch(loanId); break;
      }
      case 'default': {
        staffOnly();
        if (l.status !== 'active') throw conflict('Nur laufende Kredite können als ausgefallen markiert werden.');
        creditCancelInstallments(loanId);
        touch(loanId, { status: 'defaulted', closed_at: now() });
        ev('default', text || 'Kredit als ausgefallen markiert – offene Raten werden nicht mehr erwartet.');
        break;
      }
      default: throw bad('Unbekannte Aktion.');
    }
    fanout(loanId, actor, action, evId);
    return { action, completed: evText === 'completed' };
  });
}

function fanout(loanId, actor, action, evId) {
  if (evId == null) return;
  const l = loadLoan(loanId);
  const title = `${l.loan_number} · Kredit ${fmtC(l.principal_cents)}`;
  const key = `credit:${loanId}:ev:${evId}`;
  const target = { app: 'credit', loanId };
  const c = calcLoan(termsOf(l));
  const body = {
    accept: 'Angenommen', counter: `Gegenvorschlag: ${fmtC(l.principal_cents)} · ${l.term_count} ${l.frequency === 'weekly' ? 'wöchentliche' : 'monatliche'} Raten à ${fmtC(c.installment)}${l.interest_set ? ' · ' + rateText(l.interest_type, l.rate_bp, l.rate_period) : ''}`,
    reject: 'Abgelehnt', withdraw: 'Zurückgezogen', cancel: 'Storniert', message: 'Neue Nachricht', disburse: 'Auszahlung bestätigt – dein Tilgungsplan steht bereit',
    payment: 'Zahlung erfasst', report: 'Ratenzahlung gemeldet', default: 'Kredit als ausgefallen markiert',
  }[action];
  if (!body) return;
  if (actor.type === 'staff') {
    if (action === 'message' && get('SELECT internal FROM credit_events WHERE id = ?', evId)?.internal) return;
    notify([{ type: 'partner', id: l.partner_id }], { key, title, body, target });
  } else {
    notify(staffWith(action === 'report' ? 'credit.payments' : 'credit.manage'), { key, title: `${l.partner_number} · ${title}`, body, target });
  }
}

// ── Erinnerungen (fällig in Kürze / überfällig) ──
export function runCreditReminders() {
  const today = localDate();
  const soon = localDate(new Date(Date.now() + (getConfig('credit.reminder_days') ?? 3) * 86400000));
  const rows = all(`SELECT i.*, l.partner_id, l.loan_number, l.id loan_id FROM credit_installments i JOIN credit_loans l ON l.id = i.loan_id WHERE l.status = 'active' AND i.status = 'open' AND i.due_date <= ?`, soon);
  for (const r of rows) {
    const rest = r.amount_cents - r.paid_cents;
    const target = { app: 'credit', loanId: r.loan_id };
    if (r.due_date < today) {
      if (r.reminded & 2) continue;
      run('UPDATE credit_installments SET reminded = reminded | 2 WHERE id = ?', r.id);
      notify([{ type: 'partner', id: r.partner_id }], { key: `credit:inst:${r.id}:overdue`, title: `${r.loan_number} · Rate überfällig`, body: `Rate ${r.seq} (${fmtC(rest)}) war am ${r.due_date} fällig.`, target });
      notify(staffWith('credit.payments'), { key: `credit:inst:${r.id}:overdue-staff`, title: `${r.loan_number} · Rate überfällig`, body: `Rate ${r.seq} (${fmtC(rest)}), fällig ${r.due_date}.`, target });
    } else if (!(r.reminded & 1)) {
      run('UPDATE credit_installments SET reminded = reminded | 1 WHERE id = ?', r.id);
      notify([{ type: 'partner', id: r.partner_id }], { key: `credit:inst:${r.id}:soon`, title: `${r.loan_number} · Rate bald fällig`, body: `Rate ${r.seq}: ${fmtC(rest)} bis ${r.due_date}.`, target });
    }
  }
}

function summary() {
  const by = Object.fromEntries(all('SELECT status, COUNT(*) c FROM credit_loans GROUP BY status').map((r) => [r.status, r.c]));
  const today = localDate();
  const open = all("SELECT i.*, l.loan_number, p.partner_number FROM credit_installments i JOIN credit_loans l ON l.id = i.loan_id JOIN partners p ON p.id = l.partner_id WHERE l.status = 'active' AND i.status = 'open' ORDER BY i.due_date LIMIT 400");
  const overdue = open.filter((i) => i.due_date < today);
  return {
    currency: cur(), awaitingStaff: get("SELECT COUNT(*) c FROM credit_loans WHERE status IN ('requested','negotiating') AND turn = 'staff'").c, awaitingPartner: get("SELECT COUNT(*) c FROM credit_loans WHERE status IN ('requested','negotiating') AND turn = 'partner'").c,
    toDisburse: by.accepted ?? 0, active: by.active ?? 0, completed: by.completed ?? 0, defaulted: by.defaulted ?? 0,
    outstandingCents: get("SELECT COALESCE(SUM(i.principal_cents),0) s FROM credit_installments i JOIN credit_loans l ON l.id = i.loan_id WHERE l.status = 'active' AND i.status = 'open'").s,
    expectedInterestCents: get("SELECT COALESCE(SUM(i.interest_cents),0) s FROM credit_installments i JOIN credit_loans l ON l.id = i.loan_id WHERE l.status = 'active' AND i.status = 'open'").s,
    receivedCents: get("SELECT COALESCE(SUM(paid_cents),0) s FROM credit_installments").s,
    overdueCount: overdue.length, overdueCents: overdue.reduce((a, i) => a + i.amount_cents - i.paid_cents, 0),
    upcoming: open.filter((i) => i.due_date >= today).slice(0, 6).map((i) => ({ loanId: i.loan_id, loan: i.loan_number, partner: i.partner_number, seq: i.seq, dueDate: i.due_date, amountCents: i.amount_cents - i.paid_cents })),
    overdue: overdue.slice(0, 6).map((i) => ({ loanId: i.loan_id, loan: i.loan_number, partner: i.partner_number, seq: i.seq, dueDate: i.due_date, amountCents: i.amount_cents - i.paid_cents })),
  };
}
registerWidget({ id: 'credit-overview', title: 'Kredite', size: 'small', permission: 'credit.view', data: () => summary() });

const STAFF_ACTIONS = { accept: 'credit.manage', counter: 'credit.manage', reject: 'credit.manage', cancel: 'credit.manage', message: 'credit.manage', disburse: 'credit.manage', payment: 'credit.payments', default: 'credit.payments' };
const PARTNER_ACTIONS = ['accept', 'counter', 'reject', 'withdraw', 'message', 'report'];

export default {
  name: 'credit',
  permissions: [
    ['credit.view', 'Kredit: Kredite, Anfragen und Kreditnehmer ansehen'],
    ['credit.manage', 'Kredit: Anfragen annehmen, Gegenvorschläge machen, Zinsen festlegen, auszahlen'],
    ['credit.payments', 'Kredit: Ratenzahlungen erfassen, Ausfälle melden'],
    ['credit.limits', 'Kredit: Kreditrahmen der Kreditnehmer festlegen'],
    ['credit.delete', 'Kredit: Kredite endgültig löschen (jeder Status)'],
  ],
  config: [
    { key: 'credit.number_prefix', group: 'Kredit', label: 'Präfix der Kreditnummer', type: 'string', default: 'MDT-K-', max: 12 },
    { key: 'credit.number_start', group: 'Kredit', label: 'Startnummer der Kredite', type: 'number', default: 1001, min: 1, max: 99999999 },
    { key: 'credit.min_amount', group: 'Kredit', label: 'Kleinste Kreditsumme', type: 'number', default: 100, min: 1, max: 1_000_000_000 },
    { key: 'credit.max_amount', group: 'Kredit', label: 'Größte Kreditsumme', type: 'number', default: 1_000_000, min: 1, max: 1_000_000_000 },
    { key: 'credit.max_term_weekly', group: 'Kredit', label: 'Längste Laufzeit (wöchentlich, in Wochen)', type: 'number', default: 104, min: 1, max: 520 },
    { key: 'credit.max_term_monthly', group: 'Kredit', label: 'Längste Laufzeit (monatlich, in Monaten)', type: 'number', default: 36, min: 1, max: 120 },
    { key: 'credit.max_open_requests', group: 'Kredit', label: 'Gleichzeitig offene Anfragen je Kreditnehmer', type: 'number', default: 3, min: 1, max: 20 },
    { key: 'credit.default_interest_type', group: 'Kredit', label: 'Vorschlag Zinsen', type: 'select', default: 'flat', options: [{ value: 'none', label: 'Zinsfrei' }, { value: 'flat', label: 'Zinssatz' }] },
    { key: 'credit.default_rate_percent', group: 'Kredit', label: 'Vorschlag Zinssatz (%)', type: 'number', default: 2, min: 0, max: 1000 },
    { key: 'credit.default_rate_period', group: 'Kredit', label: 'Vorschlag Zins-Zeitraum', type: 'select', default: 'week', options: [{ value: 'day', label: 'pro Tag' }, { value: 'week', label: 'pro Woche' }, { value: 'month', label: 'pro Monat' }] },
    { key: 'credit.default_pay_to', group: 'Kredit', label: 'Vorschlag Zahlungsziel („Wohin zahlen?“)', help: 'Wird dem Team beim Annehmen/Gegenvorschlag vorausgefüllt (z. B. Kontonummer oder Übergabeort).', type: 'string', default: 'Bitte beim Team erfragen', max: 300 },
    { key: 'credit.reminder_days', group: 'Kredit', label: 'Erinnerung an fällige Raten (Tage vorher)', type: 'number', default: 3, min: 0, max: 30 },
  ],
  init() {
    setTimeout(() => { try { runCreditReminders(); } catch { /* DB evtl. schon geschlossen */ } }, 5000).unref();
    setInterval(() => { try { runCreditReminders(); } catch { /* egal */ } }, 3_600_000).unref();
  },
  routes(r) {
    // ══ Mitarbeiter ══
    r.get('/api/credit/options', { perm: 'credit.view' }, (ctx) => ({
      currency: cur(), limits: limits(), canManage: ctx.user.perms.has('credit.manage'), canPayments: ctx.user.perms.has('credit.payments'), canLimits: ctx.user.perms.has('credit.limits'),
      defaults: { interestType: getConfig('credit.default_interest_type'), ratePercent: getConfig('credit.default_rate_percent'), ratePeriod: getConfig('credit.default_rate_period'), payTo: getConfig('credit.default_pay_to') },
      statuses: Object.entries(STATUS).map(([key, v]) => ({ key, ...v })),
    }));
    r.get('/api/credit/summary', { perm: 'credit.view' }, () => ({ summary: summary() }));
    r.get('/api/credit/loans', { perm: 'credit.view' }, (ctx) => {
      const where = [], p = [];
      const { status, group, partner, q } = ctx.query;
      if (group === 'staff') { where.push("l.status IN ('requested','negotiating') AND l.turn = 'staff'"); }
      else if (group === 'open') where.push("l.status IN ('requested','negotiating')");
      else if (group === 'running') where.push("l.status IN ('accepted','active')");
      else if (group === 'done') where.push("l.status IN ('completed','rejected','withdrawn','cancelled','defaulted')");
      else if (group === 'overdue') where.push("l.status = 'active' AND EXISTS (SELECT 1 FROM credit_installments i WHERE i.loan_id = l.id AND i.status = 'open' AND i.due_date < ?)"), p.push(localDate());
      if (STATUS[status]) { where.push('l.status = ?'); p.push(status); }
      if (partner) { where.push('l.partner_id = ?'); p.push(Number(partner)); }
      if (q) { where.push('(p.name LIKE ? OR p.partner_number LIKE ? OR l.loan_number LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      return { loans: all(`${SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.updated_at DESC LIMIT 300`, ...p).map((l) => loanDto(l)) };
    });
    r.get('/api/credit/loans/:id', { perm: 'credit.view' }, (ctx) => {
      const l = loadLoan(Number(ctx.params.id));
      if (!l) throw notFound('Kredit nicht gefunden.');
      return { loan: loanDto(l, { detail: true }), events: eventsOf(l.id, false, ctx.user.id) };
    });
    r.post('/api/credit/loans/:id/:action', { perm: 'credit.view' }, (ctx) => {
      const id = Number(ctx.params.id), action = ctx.params.action;
      const need = STAFF_ACTIONS[action];
      if (!need) throw bad('Unbekannte Aktion.');
      if (!ctx.user.perms.has(need)) throw forbidden(`Dafür fehlt dir das Recht „${need}“.`);
      const before = loadLoan(id);
      if (!before) throw notFound('Kredit nicht gefunden.');
      applyAction(id, { type: 'staff', id: ctx.user.id }, action, ctx.body);
      const l = loadLoan(id);
      audit(ctx, { action: `credit.${action}`, module: 'credit', targetType: 'loan', targetId: id, targetLabel: `${l.loan_number} · ${l.partner_number}`, before: { status: before.status, principal: fmtC(before.principal_cents) }, after: { status: l.status, principal: fmtC(l.principal_cents) } });
      return { loan: loanDto(l, { detail: true }), events: eventsOf(id, false, ctx.user.id) };
    });
    r.delete('/api/credit/loans/:id', { perm: 'credit.delete' }, (ctx) => {
      const id = Number(ctx.params.id);
      const l = loadLoan(id);
      if (!l) throw notFound('Kredit nicht gefunden.');
      audit(ctx, { action: 'credit.deleted', module: 'credit', targetType: 'loan', targetId: id, targetLabel: `${l.loan_number} · ${l.partner_number}`, before: { status: l.status, principal: fmtC(l.principal_cents) } }); // vor dem Löschen, damit der Kreditnehmer live informiert wird
      tx(() => purgeLoan(id));
      return { ok: true };
    });
    r.get('/api/credit/borrowers', { perm: 'credit.view' }, () => ({
      borrowers: all("SELECT id, partner_number, name, status, apps, credit_limit_cents FROM partners ORDER BY partner_number").filter((p) => { try { return JSON.parse(p.apps).includes('credit'); } catch { return false; } }).map((p) => ({
        id: p.id, number: p.partner_number, name: p.name, level: levelBrief(p.id), active: p.status === 'active', limitCents: p.credit_limit_cents, outstandingCents: outstandingPrincipal(p.id),
        activeLoans: get("SELECT COUNT(*) c FROM credit_loans WHERE partner_id = ? AND status = 'active'", p.id).c, completedLoans: get("SELECT COUNT(*) c FROM credit_loans WHERE partner_id = ? AND status = 'completed'", p.id).c,
        defaulted: get("SELECT COUNT(*) c FROM credit_loans WHERE partner_id = ? AND status = 'defaulted'", p.id).c,
      })),
    }));
    r.patch('/api/credit/borrowers/:id', { perm: 'credit.limits' }, (ctx) => {
      const id = Number(ctx.params.id);
      const p = get('SELECT id, partner_number, name FROM partners WHERE id = ?', id);
      if (!p) throw notFound('Partner nicht gefunden.');
      const v = ctx.body.limitCents == null || ctx.body.limitCents === '' ? null : cents(ctx.body.limitCents, 'Kreditrahmen');
      run('UPDATE partners SET credit_limit_cents = ? WHERE id = ?', v, id);
      audit(ctx, { action: 'credit.limit_set', module: 'credit', targetType: 'partner', targetId: id, targetLabel: `${p.partner_number} · ${p.name}`, after: { limit: v == null ? 'kein Limit' : fmtC(v) } });
      return { ok: true };
    });

    // ══ Kreditnehmer (Partner-Portal) ══
    const P = { auth: 'partner', partnerApp: 'credit' };
    const mine = (ctx, id) => { const l = get('SELECT partner_id FROM credit_loans WHERE id = ?', id); if (!l || l.partner_id !== ctx.partner.id) throw notFound('Kredit nicht gefunden.'); };
    r.get('/api/p/credit/config', P, (ctx) => {
      const lim = get('SELECT credit_limit_cents l FROM partners WHERE id = ?', ctx.partner.id)?.l;
      const used = outstandingPrincipal(ctx.partner.id);
      return { currency: cur(), limits: limits(), limitCents: lim, outstandingCents: used, availableCents: lim == null ? null : Math.max(0, lim - used) };
    });
    r.get('/api/p/credit/loans', P, (ctx) => ({ loans: all(`${SQL} WHERE l.partner_id = ? ORDER BY l.updated_at DESC`, ctx.partner.id).map((l) => loanDto(l, { partnerView: true })) }));
    r.get('/api/p/credit/loans/:id', P, (ctx) => {
      const id = Number(ctx.params.id); mine(ctx, id);
      return { loan: loanDto(loadLoan(id), { partnerView: true, detail: true }), events: eventsOf(id, true) };
    });
    r.post('/api/p/credit/requests', P, (ctx) => {
      const b = ctx.body;
      const t = { principal: cents(b.principalCents, 'Kreditsumme'), count: b.termCount, frequency: b.frequency };
      validateTerms(t);
      const L = limits();
      if (get("SELECT COUNT(*) c FROM credit_loans WHERE partner_id = ? AND status IN ('requested','negotiating','accepted')", ctx.partner.id).c >= L.maxOpenRequests) throw conflict(`Du hast bereits ${L.maxOpenRequests} offene Kreditanfragen. Bitte warte auf eine Antwort.`);
      checkLimit(ctx.partner.id, t.principal);
      const note = str(b.note, 'Verwendungszweck', { max: 500, required: false });
      const id = tx(() => {
        const ts = now();
        const res = run(`INSERT INTO credit_loans (loan_number,partner_id,status,turn,proposed_by,principal_cents,term_count,frequency,note,created_at,updated_at) VALUES (?,?,'requested','staff','partner',?,?,?,?,?,?)`,
          allocateNumber('credit_loan', 'credit.number_prefix', 'credit.number_start'), ctx.partner.id, t.principal, t.count, t.frequency, note, ts, ts);
        const lid = Number(res.lastInsertRowid);
        const evId = addEvent(lid, { type: 'partner', id: ctx.partner.id }, 'request', note, { snap: snapshot(get('SELECT * FROM credit_loans WHERE id = ?', lid)) });
        const l = loadLoan(lid);
        notify(staffWith('credit.manage'), { key: `credit:${lid}:ev:${evId}`, title: `${l.partner_number} · neue Kreditanfrage`, body: `${fmtC(l.principal_cents)} · ${l.term_count} ${l.frequency === 'weekly' ? 'wöchentliche' : 'monatliche'} Raten`, target: { app: 'credit', loanId: lid } });
        return lid;
      });
      const l = loadLoan(id);
      audit(ctx, { action: 'credit.requested', module: 'credit', targetType: 'loan', targetId: id, targetLabel: `${l.loan_number} · ${l.partner_number}`, after: { principal: fmtC(l.principal_cents), terms: l.term_count } });
      ctx.status = 201;
      return { loan: loanDto(l, { partnerView: true }) };
    });
    r.post('/api/p/credit/loans/:id/:action', P, (ctx) => {
      const id = Number(ctx.params.id); mine(ctx, id);
      if (!PARTNER_ACTIONS.includes(ctx.params.action)) throw forbidden();
      const before = loadLoan(id);
      applyAction(id, { type: 'partner', id: ctx.partner.id }, ctx.params.action, { ...ctx.body, internal: false });
      const l = loadLoan(id);
      audit(ctx, { action: `credit.${ctx.params.action}`, module: 'credit', targetType: 'loan', targetId: id, targetLabel: `${l.loan_number} · ${l.partner_number}`, before: { status: before.status, principal: fmtC(before.principal_cents) }, after: { status: l.status, principal: fmtC(l.principal_cents) } });
      return { loan: loanDto(l, { partnerView: true, detail: true }), events: eventsOf(id, true) };
    });
  },
};
