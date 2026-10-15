import { all, get, run, now } from '../core/db.js';
import { bad, conflict, notFound, forbidden, str } from '../core/http.js';
import { getConfig } from '../core/config.js';
import { audit } from '../core/audit.js';
import { ledgerEntries, ledgerSummary } from '../core/ledger.js';
import { registerWidget } from './dashboard.js';

registerWidget({ id: 'finance-flow', title: 'Geldfluss', size: 'small', permission: 'finance.view', data: () => ledgerSummary() });

const TYPES = { deal: 'Börse', tab: 'Deckel', credit_payout: 'Kreditauszahlung', credit_installment: 'Kreditrate', manual: 'Manuelle Buchung' };
const r2 = (n) => Math.round(n * 100) / 100;
const dto = (l) => ({
  id: l.id, direction: l.direction, amount: l.amount, currency: l.currency, status: l.status, dealNumber: l.deal_number, dealId: l.deal_id,
  partner: l.partner_number ? { number: l.partner_number, name: l.partner_name } : null, entryType: l.entry_type, typeLabel: TYPES[l.entry_type] ?? l.entry_type,
  company: l.company_name ? { number: l.company_number, name: l.company_name } : null, entryNumber: l.tab_entry_number ?? null, item: l.item_name, unit: l.item_unit, quantity: l.quantity, unitPrice: l.unit_price,
  warehouse: l.warehouse_name, note: l.note, createdAt: l.created_at, settledAt: l.settled_at, cancelledAt: l.cancelled_at,
});
const filters = (q) => ({ status: q.status, direction: q.direction, type: q.type, q: q.q, from: /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from : null, to: /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to : null });
const csvCell = (v) => { const s = String(v ?? ''); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/**
 * Finanzen: Journal aller Geldbewegungen (Börse, Deckel, Kredit, manuelle Buchungen) mit Filtern, Auswertung je Monat/Art,
 * manuellen Buchungen, CSV-Export und – mit eigenem Recht – endgültigem Löschen einzelner Einträge.
 * Die Beträge entstehen in den Fachmodulen (nie doppelt erfasst); hier wird nur ausgewertet und ergänzt.
 */
export default {
  name: 'finance',
  permissions: [
    ['finance.view', 'Finanzen: Geldbewegungen (Journal) und Auswertungen ansehen'],
    ['finance.manual', 'Finanzen: manuelle Buchungen anlegen, verbuchen und stornieren'],
    ['finance.export', 'Finanzen: Journal als CSV exportieren'],
    ['finance.delete', 'Finanzen: Journal-Einträge endgültig löschen'],
  ],
  routes(r) {
    r.get('/api/finance/options', { perm: 'finance.view' }, (ctx) => ({
      currency: getConfig('market.currency') ?? '$', types: Object.entries(TYPES).map(([key, label]) => ({ key, label })),
      canManual: ctx.user.perms.has('finance.manual'), canExport: ctx.user.perms.has('finance.export'), canDelete: ctx.user.perms.has('finance.delete'),
    }));
    r.get('/api/finance/summary', { perm: 'finance.view' }, () => ({ summary: ledgerSummary() }));

    /** Auswertung: je Monat (verbucht, letzte N Monate) und je Art */
    r.get('/api/finance/report', { perm: 'finance.view' }, (ctx) => {
      const months = Math.min(Math.max(parseInt(ctx.query.months) || 6, 1), 24);
      const rows = all("SELECT substr(COALESCE(settled_at, created_at), 1, 7) m, direction, COALESCE(SUM(amount),0) total FROM finance_ledger WHERE status = 'settled' GROUP BY m, direction ORDER BY m DESC LIMIT ?", months * 2).reverse();
      const keys = [...new Set(rows.map((x) => x.m))].slice(-months);
      const monthly = keys.map((m) => ({ month: m, in: r2(rows.find((x) => x.m === m && x.direction === 'in')?.total ?? 0), out: r2(rows.find((x) => x.m === m && x.direction === 'out')?.total ?? 0) }));
      const byType = all("SELECT entry_type t, direction, status, COUNT(*) n, COALESCE(SUM(amount),0) total FROM finance_ledger WHERE status != 'cancelled' GROUP BY entry_type, direction, status")
        .map((x) => ({ type: x.t, label: TYPES[x.t] ?? x.t, direction: x.direction, status: x.status, count: x.n, total: r2(x.total) }));
      return { currency: getConfig('market.currency') ?? '$', monthly, byType };
    });

    r.get('/api/finance/ledger', { perm: 'finance.view' }, (ctx) => ({ entries: ledgerEntries({ ...filters(ctx.query), limit: parseInt(ctx.query.limit) || 200 }).map(dto) }));

    r.get('/api/finance/export.csv', { perm: 'finance.export' }, (ctx) => {
      const rows = ledgerEntries({ ...filters(ctx.query), limit: 1000 }).map(dto);
      const head = ['Nr.', 'Datum', 'Art', 'Richtung', 'Betrag', 'Währung', 'Status', 'Gegenseite', 'Verwendung', 'Verbucht am'];
      const lines = [head.join(';'), ...rows.map((l) => [l.id, l.createdAt.slice(0, 10), l.typeLabel, l.direction === 'in' ? 'Einnahme' : 'Ausgabe', String(l.amount).replace('.', ','), l.currency,
        { expected: 'erwartet', settled: 'verbucht', cancelled: 'storniert' }[l.status], l.partner?.number ?? l.company?.number ?? '', l.note, l.settledAt?.slice(0, 10) ?? ''].map(csvCell).join(';'))];
      audit(ctx, { action: 'finance.exported', module: 'finance', targetType: 'finance', targetLabel: `${rows.length} Einträge` });
      ctx.raw = { contentType: 'text/csv; charset=utf-8', body: Buffer.from('﻿' + lines.join('\r\n'), 'utf8'), filename: `finanzen-${now().slice(0, 10)}.csv` };
    });

    // ── Manuelle Buchungen ──
    r.post('/api/finance/entries', { perm: 'finance.manual' }, (ctx) => {
      const b = ctx.body;
      if (!['in', 'out'].includes(b.direction)) throw bad('Richtung: Einnahme oder Ausgabe.');
      const amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw bad('Bitte einen gültigen Betrag größer 0 eingeben.');
      const note = str(b.description, 'Verwendungszweck', { min: 2, max: 200 });
      const status = b.status === 'expected' ? 'expected' : 'settled';
      const date = b.date ? String(b.date) : now().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) throw bad('Ungültiges Datum.');
      const ts = date === now().slice(0, 10) ? now() : `${date}T12:00:00.000Z`;
      const res = run(`INSERT INTO finance_ledger (entry_type,direction,amount,currency,status,quantity,note,created_at,settled_at) VALUES ('manual',?,?,?,?,1,?,?,?)`,
        b.direction, r2(amount), getConfig('market.currency') ?? '$', status, note, ts, status === 'settled' ? ts : null);
      const id = Number(res.lastInsertRowid);
      audit(ctx, { action: 'finance.entry_created', module: 'finance', targetType: 'finance', targetId: id, targetLabel: `${b.direction === 'in' ? '+' : '−'}${r2(amount)} · ${note}`, after: { status } });
      ctx.status = 201;
      return { ok: true, id };
    });
    const manual = (id) => {
      const l = get('SELECT * FROM finance_ledger WHERE id = ?', id);
      if (!l) throw notFound('Eintrag nicht gefunden.');
      if (l.entry_type !== 'manual') throw conflict('Nur manuelle Buchungen lassen sich hier ändern – alle anderen entstehen im jeweiligen Fachmodul (Börse, Deckel, Kredit).');
      return l;
    };
    r.post('/api/finance/entries/:id/settle', { perm: 'finance.manual' }, (ctx) => {
      const l = manual(Number(ctx.params.id));
      if (l.status !== 'expected') throw conflict('Nur erwartete Buchungen lassen sich verbuchen.');
      run("UPDATE finance_ledger SET status = 'settled', settled_at = ? WHERE id = ?", now(), l.id);
      audit(ctx, { action: 'finance.entry_settled', module: 'finance', targetType: 'finance', targetId: l.id, targetLabel: l.note });
      return { ok: true };
    });
    r.post('/api/finance/entries/:id/cancel', { perm: 'finance.manual' }, (ctx) => {
      const l = manual(Number(ctx.params.id));
      if (l.status === 'cancelled') throw conflict('Bereits storniert.');
      run("UPDATE finance_ledger SET status = 'cancelled', cancelled_at = ? WHERE id = ?", now(), l.id);
      audit(ctx, { action: 'finance.entry_cancelled', module: 'finance', targetType: 'finance', targetId: l.id, targetLabel: l.note });
      return { ok: true };
    });

    /** Endgültig löschen: einzelne Journal-Einträge (jede Art). Die zugehörigen Fachdaten (Geschäft, Abrechnung …) bleiben unverändert. */
    r.delete('/api/finance/entries/:id', { perm: 'finance.delete' }, (ctx) => {
      const id = Number(ctx.params.id);
      const l = get('SELECT * FROM finance_ledger WHERE id = ?', id);
      if (!l) throw notFound('Eintrag nicht gefunden.');
      if (l.entry_type !== 'manual' && !ctx.user.isSuperadmin) throw forbidden('Eingebundene Einträge (Börse, Deckel, Kredit) kann nur ein Superadmin aus dem Journal löschen.');
      run('DELETE FROM finance_ledger WHERE id = ?', id);
      audit(ctx, { action: 'finance.entry_deleted', module: 'finance', targetType: 'finance', targetId: id, targetLabel: l.note, before: { type: l.entry_type, direction: l.direction, amount: l.amount, status: l.status } });
      return { ok: true };
    });
  },
};
