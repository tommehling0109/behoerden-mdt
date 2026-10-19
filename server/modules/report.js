import { all, get } from '../core/db.js';
import { bad } from '../core/http.js';
import { getConfig } from '../core/config.js';
import { buildPdf } from '../core/pdf.js';
import { usedSpace } from '../core/stock.js';
import { memberLabel } from '../core/identity.js';

/**
 * Wochen- und Monatsbericht: die wichtigsten Zahlen eines Zeitraums, jeweils im Vergleich zum Zeitraum davor – auf Knopfdruck, als Ansicht in der Statistik-App
 * und als PDF. Wie in der Statistik erscheint jeder Abschnitt nur, wenn der Benutzer das Ansichtsrecht des Bereichs hat (stats.view ist die Grundvoraussetzung);
 * es gibt nur Zahlen und Personalnummern, keine Namen. Zeiträume: Woche = Montag bis Sonntag, Monat = Kalendermonat (UTC-Datum).
 */
const has = (u, p) => u.isAdmin || u.perms.has(p);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const de = (day) => day.split('-').reverse().join('.');

/** Zeitraum: kind 'week' | 'month', offset 0 = laufend, -1 = davor … (von einschließlich, bis ausschließlich) */
export function periodOf(kind, offset, today = new Date()) {
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (kind === 'week') {
    const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86_400_000 + offset * 7 * 86_400_000), to = new Date(monday.getTime() + 7 * 86_400_000);
    const kw = (() => { const d = new Date(monday.getTime() + 3 * 86_400_000), y = d.getUTCFullYear(), j = new Date(Date.UTC(y, 0, 4)); return { y, n: 1 + Math.round(((d - j) / 86_400_000 - 3 + ((j.getUTCDay() + 6) % 7)) / 7) }; })();
    return { kind, offset, from: iso(monday), to: iso(to), label: `KW ${kw.n}/${kw.y}`, range: `${de(iso(monday))} – ${de(iso(new Date(to.getTime() - 86_400_000)))}` };
  }
  const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + offset, 1)), next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  return { kind, offset, from: iso(first), to: iso(next), label: `${MONTHS[first.getUTCMonth()]} ${first.getUTCFullYear()}`, range: `${de(iso(first))} – ${de(iso(new Date(next.getTime() - 86_400_000)))}` };
}

const SECTIONS = {
  market: { perm: 'market.view', build: (p) => {
    const dealsIn = "(SELECT COALESCE(SUM(l.quantity * l.unit_price),0) FROM market_deal_lines l WHERE l.deal_id = d.id)";
    return {
      newDeals: get('SELECT COUNT(*) n FROM market_deals WHERE created_at >= ? AND created_at < ?', p.from, p.to).n,
      completed: get("SELECT COUNT(*) n FROM market_deals WHERE status = 'completed' AND COALESCE(closed_at, updated_at) >= ? AND COALESCE(closed_at, updated_at) < ?", p.from, p.to).n,
      volume: r2(get(`SELECT COALESCE(SUM(${dealsIn}),0) v FROM market_deals d WHERE d.status = 'completed' AND COALESCE(d.closed_at, d.updated_at) >= ? AND COALESCE(d.closed_at, d.updated_at) < ?`, p.from, p.to).v),
      volumeBuy: r2(get(`SELECT COALESCE(SUM(${dealsIn}),0) v FROM market_deals d WHERE d.status = 'completed' AND d.direction = 'buy' AND COALESCE(d.closed_at, d.updated_at) >= ? AND COALESCE(d.closed_at, d.updated_at) < ?`, p.from, p.to).v),
      volumeSell: r2(get(`SELECT COALESCE(SUM(${dealsIn}),0) v FROM market_deals d WHERE d.status = 'completed' AND d.direction = 'sell' AND COALESCE(d.closed_at, d.updated_at) >= ? AND COALESCE(d.closed_at, d.updated_at) < ?`, p.from, p.to).v),
      lost: get("SELECT COUNT(*) n FROM market_deals WHERE status IN ('cancelled','withdrawn','rejected') AND COALESCE(closed_at, updated_at) >= ? AND COALESCE(closed_at, updated_at) < ?", p.from, p.to).n,
      topItems: all("SELECT i.name label, i.unit, SUM(l.quantity) qty, ROUND(SUM(l.quantity * l.unit_price), 2) volume FROM market_deal_lines l JOIN market_deals d ON d.id = l.deal_id JOIN market_items i ON i.id = l.item_id WHERE d.status = 'completed' AND COALESCE(d.closed_at, d.updated_at) >= ? AND COALESCE(d.closed_at, d.updated_at) < ? GROUP BY l.item_id ORDER BY volume DESC LIMIT 5", p.from, p.to),
      topPartners: all(`SELECT pa.partner_number label, COUNT(*) deals, ROUND(SUM(${dealsIn}), 2) volume FROM market_deals d JOIN partners pa ON pa.id = d.partner_id WHERE d.status = 'completed' AND COALESCE(d.closed_at, d.updated_at) >= ? AND COALESCE(d.closed_at, d.updated_at) < ? GROUP BY d.partner_id ORDER BY volume DESC LIMIT 5`, p.from, p.to),
    };
  } },
  finance: { perm: 'finance.view', build: (p) => {
    const sum = (dir) => r2(get("SELECT COALESCE(SUM(amount),0) v FROM finance_ledger WHERE status = 'settled' AND direction = ? AND COALESCE(settled_at, created_at) >= ? AND COALESCE(settled_at, created_at) < ?", dir, p.from, p.to).v);
    const income = sum('in'), expense = sum('out');
    return { income, expense, balance: r2(income - expense) };
  } },
  warehouse: { perm: 'warehouse.view', build: (p) => {
    const flow = (kinds) => get(`SELECT COALESCE(SUM(ABS(delta)),0) v FROM warehouse_events WHERE kind IN (${kinds.map(() => '?').join(',')}) AND created_at >= ? AND created_at < ?`, ...kinds, p.from, p.to).v;
    const fill = all('SELECT id, capacity FROM warehouses WHERE is_active = 1 AND capacity IS NOT NULL AND capacity > 0').map((w) => (usedSpace(w.id) / w.capacity) * 100);
    const warn = Number(getConfig('problems.warehouse_warn_percent')) || 75;
    return { inflow: flow(['in', 'deal']), outflow: flow(['out', 'deal_out']), nearFull: fill.filter((x) => x >= warn).length, warehouses: fill.length, now: true };
  } },
  credit: { perm: 'credit.view', build: (p) => ({
    newLoans: get('SELECT COUNT(*) n FROM credit_loans WHERE created_at >= ? AND created_at < ?', p.from, p.to).n,
    paidCents: get("SELECT COALESCE(SUM(paid_cents),0) c FROM credit_installments WHERE paid_at >= ? AND paid_at < ?", p.from, p.to).c,
    overdueNow: get("SELECT COUNT(*) n FROM credit_installments i JOIN credit_loans l ON l.id = i.loan_id WHERE l.status = 'active' AND i.status = 'open' AND i.due_date < ?", iso(new Date())).n,
  }) },
  users: { perm: 'users.view', build: (p) => ({
    newMembers: get('SELECT COUNT(*) n FROM users WHERE created_at >= ? AND created_at < ?', p.from, p.to).n,
    members: get("SELECT COUNT(*) n FROM users WHERE status = 'active'").n,
  }) },
  activity: { perm: 'activity.view', build: (p) => ({
    activeMembers: get('SELECT COUNT(DISTINCT user_id) n FROM user_activity WHERE day >= ? AND day < ?', p.from, p.to).n,
    members: get("SELECT COUNT(*) n FROM users WHERE status = 'active'").n,
    top: all("SELECT u.id, u.member_number, u.status, COUNT(*) days FROM user_activity a JOIN users u ON u.id = a.user_id WHERE a.day >= ? AND a.day < ? AND u.status = 'active' GROUP BY a.user_id ORDER BY days DESC, u.member_number LIMIT 5", p.from, p.to).map((r) => ({ label: memberLabel(r), days: r.days })),
    absentNow: get('SELECT COUNT(DISTINCT user_id) n FROM user_absences WHERE from_date <= ? AND to_date >= ?', iso(new Date()), iso(new Date())).n,
  }) },
  schedule: { perm: 'schedule.view', build: (p) => ({
    tasksDone: get("SELECT COUNT(*) n FROM cal_tasks WHERE done_at >= ? AND done_at < ?", p.from, p.to).n,
    tasksCreated: get('SELECT COUNT(*) n FROM cal_tasks WHERE created_at >= ? AND created_at < ?', p.from, p.to).n,
    events: get("SELECT COUNT(*) n FROM cal_events WHERE status != 'cancelled' AND starts_at >= ? AND starts_at < ?", p.from, p.to).n,
    overdueNow: get("SELECT COUNT(*) n FROM cal_tasks WHERE status NOT IN ('done','cancelled') AND due_at IS NOT NULL AND due_at < ?", new Date().toISOString()).n,
  }) },
  onboarding: { perm: 'onboarding.check', build: (p) => ({
    started: get('SELECT COUNT(*) n FROM user_onboarding WHERE started_at >= ? AND started_at < ?', p.from, p.to).n,
    completed: get('SELECT COUNT(*) n FROM user_onboarding WHERE completed_at >= ? AND completed_at < ?', p.from, p.to).n,
    running: get('SELECT COUNT(*) n FROM user_onboarding WHERE completed_at IS NULL').n,
  }) },
};

export function buildReport(user, kind, offset) {
  const cur = periodOf(kind, offset), prev = periodOf(kind, offset - 1), sections = {};
  for (const [key, s] of Object.entries(SECTIONS)) if (has(user, s.perm)) sections[key] = { cur: s.build(cur), prev: s.build(prev) };
  return { currency: getConfig('market.currency') ?? '$', period: { ...cur, isCurrent: offset === 0 }, prev: { label: prev.label, range: prev.range }, generatedAt: new Date().toISOString(), sections };
}

function parse(q) {
  const kind = q.period === 'month' ? 'month' : 'week', offset = q.offset == null || q.offset === '' ? 0 : Number(q.offset);
  if (!Number.isInteger(offset) || offset > 0 || offset < -120) throw bad('Ungültiger Zeitraum.');
  return { kind, offset };
}

const nf = (n) => Number(n ?? 0).toLocaleString('de-DE', { maximumFractionDigits: 2 });
const delta = (c, p) => (p ? `${c >= p ? '+' : '−'}${Math.round((Math.abs(c - p) / p) * 100)} %` : c ? 'neu' : '–');
function toBlocks(rep) {
  const cur = rep.currency, out = [], line = (label, c, p, money) => `${label}: **${money ? `${nf(c)} ${cur}` : nf(c)}** (Vorperiode ${money ? `${nf(p)} ${cur}` : nf(p)}, ${delta(c, p)})`;
  const S = rep.sections;
  out.push({ t: 'p', text: `Zeitraum: ${rep.period.range} · Vergleich mit ${rep.prev.label} (${rep.prev.range})` });
  if (S.market) {
    const { cur: c, prev: p } = S.market;
    out.push({ t: 'h1', text: 'Börse' }, { t: 'li', text: line('Abgeschlossene Geschäfte', c.completed, p.completed) }, { t: 'li', text: line('Umsatz (abgeschlossen)', c.volume, p.volume, true) },
      { t: 'li', text: line('Ankauf (von Partnern)', c.volumeBuy, p.volumeBuy, true) }, { t: 'li', text: line('Verkauf (an Partner)', c.volumeSell, p.volumeSell, true) },
      { t: 'li', text: line('Neue Geschäfte', c.newDeals, p.newDeals) }, { t: 'li', text: line('Nicht zustande gekommen (abgelehnt/storniert/zurückgezogen)', c.lost, p.lost) });
    if (c.topItems.length) out.push({ t: 'h2', text: 'Top-Items' }, ...c.topItems.map((x) => ({ t: 'li', text: `${x.label}: ${nf(x.qty)} ${x.unit} · ${nf(x.volume)} ${cur}` })));
    if (c.topPartners.length) out.push({ t: 'h2', text: 'Top-Partner' }, ...c.topPartners.map((x) => ({ t: 'li', text: `${x.label}: ${x.deals} Geschäft(e) · ${nf(x.volume)} ${cur}` })));
  }
  if (S.finance) { const { cur: c, prev: p } = S.finance; out.push({ t: 'h1', text: 'Finanzen' }, { t: 'li', text: line('Einnahmen (verbucht)', c.income, p.income, true) }, { t: 'li', text: line('Ausgaben (verbucht)', c.expense, p.expense, true) }, { t: 'li', text: line('Saldo', c.balance, p.balance, true) }); }
  if (S.warehouse) { const { cur: c, prev: p } = S.warehouse; out.push({ t: 'h1', text: 'Lager' }, { t: 'li', text: line('Eingelagert', c.inflow, p.inflow) }, { t: 'li', text: line('Ausgelagert', c.outflow, p.outflow) }, { t: 'li', text: `Lager über der Warnschwelle (aktuell): ${c.nearFull} von ${c.warehouses}` }); }
  if (S.credit) { const { cur: c, prev: p } = S.credit; out.push({ t: 'h1', text: 'Kredit' }, { t: 'li', text: line('Neue Kreditanfragen', c.newLoans, p.newLoans) }, { t: 'li', text: line('Eingegangene Raten', c.paidCents / 100, p.paidCents / 100, true) }, { t: 'li', text: `Überfällige Raten (aktuell): ${c.overdueNow}` }); }
  if (S.schedule) { const { cur: c, prev: p } = S.schedule; out.push({ t: 'h1', text: 'Termine & Aufträge' }, { t: 'li', text: line('Erledigte Aufträge', c.tasksDone, p.tasksDone) }, { t: 'li', text: line('Vergebene Aufträge', c.tasksCreated, p.tasksCreated) }, { t: 'li', text: line('Termine', c.events, p.events) }, { t: 'li', text: `Überfällige Aufträge (aktuell): ${c.overdueNow}` }); }
  if (S.activity) { const { cur: c, prev: p } = S.activity; out.push({ t: 'h1', text: 'Aktivität' }, { t: 'li', text: line('Aktive Mitglieder', c.activeMembers, p.activeMembers) + ` von ${c.members}` }, { t: 'li', text: `Aktuell abgemeldet: ${c.absentNow}` });
    if (c.top.length) out.push({ t: 'h2', text: 'Aktivste Mitglieder (aktive Tage)' }, ...c.top.map((x) => ({ t: 'li', text: `${x.label}: ${x.days} Tag${x.days === 1 ? '' : 'e'}` }))); }
  if (S.users) { const { cur: c, prev: p } = S.users; out.push({ t: 'h1', text: 'Mitglieder' }, { t: 'li', text: line('Neue Zugänge', c.newMembers, p.newMembers) }, { t: 'li', text: `Aktive Mitglieder insgesamt: ${c.members}` }); }
  if (S.onboarding) { const { cur: c } = S.onboarding; out.push({ t: 'h1', text: 'Einarbeitung' }, { t: 'li', text: `Gestartet: ${c.started} · Abgeschlossen: ${c.completed} · Laufend (aktuell): ${c.running}` }); }
  return out;
}

export default {
  name: 'report',
  routes(r) {
    r.get('/api/report', { perm: 'stats.view' }, (ctx) => { const { kind, offset } = parse(ctx.query); return buildReport(ctx.user, kind, offset); });
    r.get('/api/report/export.pdf', { perm: 'stats.view' }, (ctx) => {
      const { kind, offset } = parse(ctx.query), rep = buildReport(ctx.user, kind, offset), name = getConfig('system.name') || 'MDT';
      const pdf = buildPdf({ title: `${name} – ${kind === 'week' ? 'Wochenbericht' : 'Monatsbericht'}`, subtitle: `${rep.period.label} · ${rep.period.range}`, blocks: toBlocks(rep) });
      ctx.raw = { contentType: 'application/pdf', filename: `${kind === 'week' ? 'Wochenbericht' : 'Monatsbericht'}-${rep.period.from}.pdf`, body: pdf };
    });
  },
};
