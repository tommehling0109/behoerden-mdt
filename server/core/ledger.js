import { all, get, run, now } from './db.js';
import { getConfig } from './config.js';

/**
 * Geldbewegungs-Journal (Vormerkung für das spätere Finanzsystem).
 * Jedes angenommene Börsen-Geschäft erzeugt einen Eintrag „erwartet“ (expected):
 *   direction 'in'  = wir erhalten Geld (Verkauf an einen Partner)
 *   direction 'out' = wir zahlen Geld (Ankauf von einem Partner)
 * Wird das Geschäft abgeschlossen („Als bezahlt abschließen“), wechselt der Eintrag auf „verbucht“ (settled);
 * wird es storniert, auf „storniert“ (cancelled). Einträge werden nie gelöscht – so bleibt jede Bewegung nachvollziehbar und auswertbar.
 */
export function expectDealPayment(dealId) {
  const d = get('SELECT * FROM market_deals WHERE id = ?', dealId);
  if (!d) return;
  run("UPDATE finance_ledger SET status = 'cancelled', cancelled_at = ? WHERE deal_id = ? AND status = 'expected'", now(), dealId);
  run(`INSERT INTO finance_ledger (entry_type,direction,amount,currency,status,deal_id,partner_id,item_id,quantity,unit_price,warehouse_id,note,created_at)
       VALUES ('deal',?,?,?,'expected',?,?,?,?,?,?,?,?)`,
  d.direction === 'sell' ? 'in' : 'out', d.quantity * d.unit_price, getConfig('market.currency') ?? '$', dealId, d.partner_id, d.item_id, d.quantity, d.unit_price, d.warehouse_id ?? null,
  `${d.direction === 'sell' ? 'Verkauf' : 'Ankauf'} ${d.deal_number ?? ''}`.trim(), now());
}
export const settleDeal = (dealId) => run("UPDATE finance_ledger SET status = 'settled', settled_at = ? WHERE deal_id = ? AND status = 'expected'", now(), dealId);
export const voidDeal = (dealId) => run("UPDATE finance_ledger SET status = 'cancelled', cancelled_at = ? WHERE deal_id = ? AND status = 'expected'", now(), dealId);

/** Deckel-Abrechnung → Finanzvorgang (erwartete Ausgabe auf das Konto der Firma) – wird bei der Bestätigung angelegt. */
export function expectTabStatement(s) {
  run(`INSERT INTO finance_ledger (entry_type,direction,amount,currency,status,quantity,note,ref_type,ref_id,company_id,created_at)
       VALUES ('tab','out',?,?,'expected',1,?,'tab_statement',?,?,?)`, (s.approved_cents ?? s.submitted_cents) / 100, getConfig('market.currency') ?? '$',
  `Deckel ${s.statement_number} · ${s.company_name} · Konto ${s.company_account}`, s.id, s.company_id, now());
}
export const settleTabStatement = (statementId) => run("UPDATE finance_ledger SET status = 'settled', settled_at = ? WHERE ref_type = 'tab_statement' AND ref_id = ? AND status = 'expected'", now(), statementId);
export const cancelTabStatement = (statementId) => run("UPDATE finance_ledger SET status = 'cancelled', cancelled_at = ? WHERE ref_type = 'tab_statement' AND ref_id = ? AND status = 'expected'", now(), statementId);

/** Kredit: Auszahlung (Ausgang, sofort verbucht) und je Rate eine erwartete Einnahme. */
export function creditPayout(loan) {
  run(`INSERT INTO finance_ledger (entry_type,direction,amount,currency,status,partner_id,quantity,note,ref_type,ref_id,created_at,settled_at)
       VALUES ('credit_payout','out',?,?,'settled',?,1,?,'loan',?,?,?)`, loan.principal_cents / 100, getConfig('market.currency') ?? '$', loan.partner_id, `Kreditauszahlung ${loan.loan_number}`, loan.id, now(), now());
}
export const creditExpectInstallment = (loan, inst) => run(`INSERT INTO finance_ledger (entry_type,direction,amount,currency,status,partner_id,quantity,note,ref_type,ref_id,created_at)
  VALUES ('credit_installment','in',?,?,'expected',?,1,?,'credit_installment',?,?)`, inst.amount_cents / 100, getConfig('market.currency') ?? '$', loan.partner_id, `Rate ${inst.seq} · ${loan.loan_number} (davon Zinsen ${(inst.interest_cents / 100).toFixed(2)})`, inst.id, now());
export const creditSettleInstallment = (instId) => run("UPDATE finance_ledger SET status = 'settled', settled_at = ? WHERE ref_type = 'credit_installment' AND ref_id = ? AND status = 'expected'", now(), instId);
export const creditCancelInstallments = (loanId) => run("UPDATE finance_ledger SET status = 'cancelled', cancelled_at = ? WHERE ref_type = 'credit_installment' AND status = 'expected' AND ref_id IN (SELECT id FROM credit_installments WHERE loan_id = ? AND status = 'open')", now(), loanId);

export const ledgerEntries = ({ status, direction, type, from, to, q, limit = 200 } = {}) => {
  const where = [], p = [];
  if (['expected', 'settled', 'cancelled'].includes(status)) { where.push('l.status = ?'); p.push(status); }
  if (['in', 'out'].includes(direction)) { where.push('l.direction = ?'); p.push(direction); }
  if (type) { where.push('l.entry_type = ?'); p.push(type); }
  if (from) { where.push('l.created_at >= ?'); p.push(`${from}T00:00:00`); }
  if (to) { where.push('l.created_at <= ?'); p.push(`${to}T23:59:59.999Z`); }
  if (q) { where.push('(d.deal_number LIKE ? OR pa.partner_number LIKE ? OR pa.name LIKE ? OR i.name LIKE ? OR tc.name LIKE ? OR te.statement_number LIKE ? OR l.note LIKE ?)'); p.push(...Array(7).fill(`%${q}%`)); }
  return all(`SELECT l.*, d.deal_number, pa.partner_number, pa.name partner_name, i.name item_name, i.unit item_unit, w.name warehouse_name, tc.company_number, tc.name company_name, te.statement_number tab_entry_number
    FROM finance_ledger l LEFT JOIN market_deals d ON d.id = l.deal_id LEFT JOIN partners pa ON pa.id = l.partner_id
    LEFT JOIN tab_companies tc ON tc.id = l.company_id LEFT JOIN tab_statements te ON l.ref_type = 'tab_statement' AND te.id = l.ref_id
    LEFT JOIN market_items i ON i.id = l.item_id LEFT JOIN warehouses w ON w.id = l.warehouse_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC LIMIT ?`, ...p, Math.min(Math.max(limit, 1), 1000));
};
const r2 = (n) => Math.round(n * 100) / 100;
export const ledgerSummary = () => {
  const rows = all('SELECT direction, status, COUNT(*) n, COALESCE(SUM(amount),0) total FROM finance_ledger GROUP BY direction, status');
  const sum = (dir, st) => rows.find((r) => r.direction === dir && r.status === st)?.total ?? 0;
  return {
    currency: getConfig('market.currency') ?? '$',
    expectedIn: r2(sum('in', 'expected')), expectedOut: r2(sum('out', 'expected')), settledIn: r2(sum('in', 'settled')), settledOut: r2(sum('out', 'settled')),
    balanceSettled: r2(sum('in', 'settled') - sum('out', 'settled')), balanceExpected: r2(sum('in', 'expected') - sum('out', 'expected')),
    entries: rows.reduce((a, r) => a + r.n, 0),
  };
};
