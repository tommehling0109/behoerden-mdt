import { deptWhere } from '../core/scope.js';
import { all, get } from '../core/db.js';
import { getConfig } from '../core/config.js';

const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
/** Letzte n Tage lückenlos (älteste zuerst); fehlende Tage = 0 */
const perDay = (rows, n) => Array.from({ length: n }, (_, i) => { const d = day(n - 1 - i); return { day: d, n: rows.find((r) => r.d === d)?.n ?? 0 }; });
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * Statistik: Kennzahlen aus allen Bereichen. Die App selbst braucht „stats.view“; jeder Abschnitt erscheint zusätzlich nur,
 * wenn der Benutzer auch das Recht auf den jeweiligen Bereich hat (z. B. Kredit-Zahlen nur mit „credit.view“) – so verrät die Statistik nichts,
 * was die Fachanwendung nicht ohnehin zeigen würde. Es werden ausschließlich aggregierte Zahlen geliefert, nie Namen.
 */
const SECTIONS = {
  users: { perm: ['users.view'], build: () => ({
    byStatus: all('SELECT status key, COUNT(*) n FROM users GROUP BY status'),
    byRank: all("SELECT COALESCE(r.name, 'Ohne Rang') label, COALESCE(r.color, '#94a3b8') color, COUNT(*) n FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.status = 'active' GROUP BY u.rank_id ORDER BY n DESC"),
    byDepartment: all("SELECT COALESCE(d.name, 'Ohne Abteilung') label, COALESCE(d.color, '#94a3b8') color, COUNT(*) n FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.status = 'active' GROUP BY u.department_id ORDER BY n DESC"),
    newLast30: get('SELECT COUNT(*) n FROM users WHERE created_at >= ?', day(30)).n,
  }) },
  market: { perm: ['market.view'], build: () => ({
    dealsByStatus: all('SELECT d.status key, COUNT(*) n, ROUND(COALESCE(SUM((SELECT SUM(l.quantity * l.unit_price) FROM market_deal_lines l WHERE l.deal_id = d.id)),0), 2) volume FROM market_deals d GROUP BY d.status'),
    completedVolume: get("SELECT ROUND(COALESCE(SUM(l.quantity * l.unit_price),0), 2) v FROM market_deal_lines l JOIN market_deals d ON d.id = l.deal_id WHERE d.status = 'completed'").v,
    topItems: all("SELECT i.name label, SUM(l.quantity) qty, ROUND(SUM(l.quantity * l.unit_price), 2) volume FROM market_deal_lines l JOIN market_deals d ON d.id = l.deal_id JOIN market_items i ON i.id = l.item_id WHERE d.status = 'completed' GROUP BY l.item_id ORDER BY volume DESC LIMIT 5"),
    activePartners: get('SELECT COUNT(DISTINCT partner_id) n FROM market_deals WHERE created_at >= ?', day(30)).n,
    perDay: perDay(all('SELECT substr(created_at,1,10) d, COUNT(*) n FROM market_deals WHERE created_at >= ? GROUP BY d', day(13)), 14),
  }) },
  credit: { perm: ['credit.view'], build: () => ({
    loansByStatus: all('SELECT status key, COUNT(*) n, COALESCE(SUM(principal_cents),0) cents FROM credit_loans GROUP BY status'),
    outstandingCents: get("SELECT COALESCE(SUM(i.amount_cents - i.paid_cents),0) c FROM credit_installments i JOIN credit_loans l ON l.id = i.loan_id WHERE i.status = 'open' AND l.status = 'active'").c,
    overdue: get("SELECT COUNT(*) n FROM credit_installments i JOIN credit_loans l ON l.id = i.loan_id WHERE i.status = 'open' AND l.status = 'active' AND i.due_date < ?", day(0)).n,
    paidInterestCents: get("SELECT COALESCE(SUM(interest_cents),0) c FROM credit_installments WHERE status = 'paid'").c,
  }) },
  tab: { perm: ['tab.view', 'tab.statements'], build: () => ({
    byStatus: all('SELECT status key, COUNT(*) n, COALESCE(SUM(COALESCE(approved_cents, submitted_cents)),0) cents FROM tab_statements GROUP BY status'),
    topCompanies: all("SELECT c.name label, COALESCE(SUM(COALESCE(s.approved_cents, s.submitted_cents)),0) cents FROM tab_statements s JOIN tab_companies c ON c.id = s.company_id WHERE s.status = 'paid' GROUP BY s.company_id ORDER BY cents DESC LIMIT 5"),
    companies: get("SELECT COUNT(*) n FROM tab_companies WHERE status = 'active'").n,
  }) },
  warehouse: { perm: ['warehouse.view'], build: (u) => { const dw = deptWhere(u, 'w.department_id'); return ({
    warehouses: get(`SELECT COUNT(*) n FROM warehouses w WHERE w.is_active = 1 AND ${dw.sql}`, ...dw.params).n,
    totalUnits: get(`SELECT COALESCE(SUM(s.quantity),0) n FROM warehouse_stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE ${dw.sql}`, ...dw.params).n,
    valueRef: get(`SELECT ROUND(COALESCE(SUM(s.quantity * COALESCE(i.reference_price,0)),0), 2) v FROM warehouse_stock s JOIN market_items i ON i.id = s.item_id JOIN warehouses w ON w.id = s.warehouse_id WHERE ${dw.sql}`, ...dw.params).v,
    topItems: all(`SELECT i.name label, i.unit, SUM(s.quantity) qty FROM warehouse_stock s JOIN market_items i ON i.id = s.item_id JOIN warehouses w ON w.id = s.warehouse_id WHERE ${dw.sql} GROUP BY s.item_id HAVING qty > 0 ORDER BY qty DESC LIMIT 6`, ...dw.params),
    byWarehouse: all(`SELECT w.name label, COALESCE(SUM(s.quantity),0) qty FROM warehouses w LEFT JOIN warehouse_stock s ON s.warehouse_id = w.id WHERE w.is_active = 1 AND ${dw.sql} GROUP BY w.id ORDER BY qty DESC LIMIT 6`, ...dw.params),
  }); } },
  vehicles: { perm: ['vehicles.view'], build: (u) => { const dw = deptWhere(u, 'department_id'); return ({
    total: get(`SELECT COUNT(*) n FROM vehicles WHERE ${dw.sql}`, ...dw.params).n,
    byCondition: all(`SELECT condition_key key, COUNT(*) n FROM vehicles WHERE ${dw.sql} GROUP BY condition_key`, ...dw.params),
    inspectionDue: get(`SELECT COUNT(*) n FROM vehicles WHERE inspection_due IS NOT NULL AND inspection_due <= ? AND ${dw.sql}`, day(-30), ...dw.params).n,
  }); } },
  chat: { perm: ['chat.view'], build: () => ({
    perDay: perDay(all('SELECT substr(created_at,1,10) d, COUNT(*) n FROM chat_messages WHERE deleted_at IS NULL AND created_at >= ? GROUP BY d', day(13)), 14),
    total: get('SELECT COUNT(*) n FROM chat_messages WHERE deleted_at IS NULL').n,
  }) },
  finance: { perm: ['finance.view'], build: () => {
    const m = all("SELECT substr(COALESCE(settled_at, created_at),1,7) m, direction, COALESCE(SUM(amount),0) total FROM finance_ledger WHERE status = 'settled' GROUP BY m, direction ORDER BY m DESC LIMIT 12").reverse();
    const keys = [...new Set(m.map((x) => x.m))].slice(-6);
    return { monthly: keys.map((k) => ({ month: k, in: r2(m.find((x) => x.m === k && x.direction === 'in')?.total ?? 0), out: r2(m.find((x) => x.m === k && x.direction === 'out')?.total ?? 0) })) };
  } },
  activity: { perm: ['audit.view'], build: () => ({
    perDay: perDay(all('SELECT substr(ts,1,10) d, COUNT(*) n FROM audit_log WHERE ts >= ? GROUP BY d', day(13)), 14),
    byModule: all('SELECT module label, COUNT(*) n FROM audit_log WHERE ts >= ? GROUP BY module ORDER BY n DESC LIMIT 8', day(30)),
  }) },
};

export default {
  name: 'stats',
  permissions: [['stats.view', 'Statistik: Kennzahlen und Diagramme ansehen (je Bereich zusätzlich das jeweilige Ansichtsrecht nötig)']],
  routes(r) {
    r.get('/api/stats', { perm: 'stats.view' }, (ctx) => {
      const sections = {};
      for (const [key, s] of Object.entries(SECTIONS)) if (s.perm.some((p) => ctx.user.perms.has(p))) sections[key] = s.build(ctx.user);
      return { currency: getConfig('market.currency') ?? '$', generatedAt: new Date().toISOString(), sections };
    });
  },
};
