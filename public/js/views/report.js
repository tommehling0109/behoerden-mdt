import { h, mount, fmtDateTime } from '../ui/dom.js';
import { button, card, tabs, empty, skeletons } from '../ui/kit.js';
import { api } from '../api.js';
import { hbars } from '../ui/charts.js';

/**
 * Wochen-/Monatsbericht (Reiter in der Statistik-App): Kennzahlen eines Zeitraums im Vergleich zum Zeitraum davor, mit PDF-Export.
 * Abschnitte erscheinen nur, wenn der Benutzer das Ansichtsrecht des Bereichs hat.
 */
export default async function renderReport(container, ctx) {
  let kind = 'week', offset = 0;
  const head = h('div', { class: 'row', style: { gap: '8px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' } }), body = h('div');
  mount(container, head, body);

  const load = async () => {
    mount(body, skeletons(3, 120));
    const rep = await api.get(`/api/report?period=${kind}&offset=${offset}`);
    if (!ctx.isCurrent()) return;
    drawHead(rep); drawBody(rep);
  };
  const go = (fn) => { fn(); load().catch((e) => mount(body, empty('Fehler beim Laden', e.message, 'alert'))); };

  function drawHead(rep) {
    mount(head,
      tabs([{ id: 'week', label: 'Woche' }, { id: 'month', label: 'Monat' }], kind, (id) => go(() => { kind = id; offset = 0; })),
      button('', { icon: 'chevronL', title: 'Früherer Zeitraum', onClick: () => go(() => { offset -= 1; }) }),
      h('div', { style: { minWidth: '190px', textAlign: 'center' } }, h('div', { style: { fontWeight: 700 } }, rep.period.label), h('div', { class: 'muted', style: { fontSize: '12px' } }, rep.period.range)),
      button('', { icon: 'chevronR', title: 'Späterer Zeitraum', disabled: offset >= 0, onClick: () => go(() => { offset += 1; }) }),
      offset < 0 && button('Aktuell', { size: 'sm', onClick: () => go(() => { offset = 0; }) }),
      h('span', { class: 'grow' }),
      button('PDF', { icon: 'download', onClick: () => window.open(`/api/report/export.pdf?period=${kind}&offset=${offset}`, '_blank', 'noopener') }));
  }

  function drawBody(rep) {
    const S = rep.sections, cur = rep.currency;
    const nf = (n) => Number(n ?? 0).toLocaleString('de-DE', { maximumFractionDigits: 2 }), money = (n) => `${nf(n)} ${cur}`;
    const chip = (c, p, invert) => {
      if (!p && !c) return h('span', { class: 'rep-chip' }, '–');
      if (!p) return h('span', { class: 'rep-chip up' }, 'neu');
      const pct = Math.round(((c - p) / Math.abs(p)) * 100), good = invert ? pct <= 0 : pct >= 0;
      return h('span', { class: `rep-chip ${pct === 0 ? '' : good ? 'up' : 'down'}`, title: `Vorher: ${nf(p)}` }, `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)} %`);
    };
    const kpi = (label, c, p, { fmt = nf, invert = false, now = false } = {}) => h('div', { class: 'tile' }, h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, fmt(c)), h('div', { class: 'tile-label' }, label), !now && h('div', { class: 'rep-vs' }, chip(c, p, invert), h('span', { class: 'muted' }, ` ggü. ${rep.prev.label}`))));
    const cards = [];
    if (S.market) { const c = S.market.cur, p = S.market.prev;
      cards.push(card('Börse', h('div', { class: 'stack-v' },
        h('div', { class: 'tile-row' }, kpi('Umsatz (abgeschlossen)', c.volume, p.volume, { fmt: money }), kpi('Abgeschlossene Geschäfte', c.completed, p.completed), kpi('Neue Geschäfte', c.newDeals, p.newDeals), kpi('Nicht zustande gekommen', c.lost, p.lost, { invert: true })),
        h('div', { class: 'tile-row' }, kpi('Ankauf von Partnern', c.volumeBuy, p.volumeBuy, { fmt: money }), kpi('Verkauf an Partner', c.volumeSell, p.volumeSell, { fmt: money })),
        c.topItems.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Top-Items (Umsatz)'), hbars(c.topItems.map((x) => ({ label: x.label, value: x.volume, text: `${nf(x.qty)} ${x.unit} · ${money(x.volume)}` })))),
        c.topPartners.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Top-Partner (Umsatz)'), hbars(c.topPartners.map((x) => ({ label: x.label, value: x.volume, text: `${x.deals} Geschäft(e) · ${money(x.volume)}` })), { color: '#a78bfa' }))), { icon: 'tag' })); }
    if (S.finance) { const c = S.finance.cur, p = S.finance.prev;
      cards.push(card('Finanzen (verbucht)', h('div', { class: 'tile-row' }, kpi('Einnahmen', c.income, p.income, { fmt: money }), kpi('Ausgaben', c.expense, p.expense, { fmt: money, invert: true }), kpi('Saldo', c.balance, p.balance, { fmt: money })), { icon: 'wallet' })); }
    if (S.warehouse) { const c = S.warehouse.cur, p = S.warehouse.prev;
      cards.push(card('Lager', h('div', { class: 'tile-row' }, kpi('Eingelagert', c.inflow, p.inflow), kpi('Ausgelagert', c.outflow, p.outflow), kpi(`Lager über Warnschwelle (von ${c.warehouses})`, c.nearFull, 0, { now: true })), { icon: 'storage' })); }
    if (S.schedule) { const c = S.schedule.cur, p = S.schedule.prev;
      cards.push(card('Termine & Aufträge', h('div', { class: 'tile-row' }, kpi('Erledigte Aufträge', c.tasksDone, p.tasksDone), kpi('Vergebene Aufträge', c.tasksCreated, p.tasksCreated), kpi('Termine', c.events, p.events), kpi('Überfällig (aktuell)', c.overdueNow, 0, { now: true })), { icon: 'calendar' })); }
    if (S.activity) { const c = S.activity.cur, p = S.activity.prev;
      cards.push(card('Aktivität', h('div', { class: 'stack-v' }, h('div', { class: 'tile-row' }, kpi(`Aktive Mitglieder (von ${c.members})`, c.activeMembers, p.activeMembers), kpi('Aktuell abgemeldet', c.absentNow, 0, { now: true })),
        c.top.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Aktivste Mitglieder (aktive Tage)'), hbars(c.top.map((x) => ({ label: x.label, value: x.days, text: `${x.days} Tag${x.days === 1 ? '' : 'e'}` })), { color: '#34d399' }))), { icon: 'activity' })); }
    if (S.credit) { const c = S.credit.cur, p = S.credit.prev;
      cards.push(card('Kredit', h('div', { class: 'tile-row' }, kpi('Neue Anfragen', c.newLoans, p.newLoans), kpi('Eingegangene Raten', c.paidCents / 100, p.paidCents / 100, { fmt: money }), kpi('Überfällige Raten (aktuell)', c.overdueNow, 0, { now: true })), { icon: 'bank' })); }
    if (S.users) { const c = S.users.cur, p = S.users.prev;
      cards.push(card('Mitglieder', h('div', { class: 'tile-row' }, kpi('Neue Zugänge', c.newMembers, p.newMembers), kpi('Aktive Mitglieder gesamt', c.members, 0, { now: true }), S.onboarding && kpi('In Einarbeitung (aktuell)', S.onboarding.cur.running, 0, { now: true })), { icon: 'users' })); }
    mount(body, cards.length ? h('div', { class: 'stack-v' }, h('div', { class: 'muted', style: { fontSize: '12px' } }, `Stand ${fmtDateTime(rep.generatedAt)} · Vergleich mit ${rep.prev.label} · nur Bereiche, für die du das Ansichtsrecht hast`), cards)
      : empty('Kein Bericht verfügbar', 'Für den Bericht brauchst du zusätzlich das Ansichtsrecht des jeweiligen Bereichs (z. B. Börse, Finanzen).', 'chart'));
  }
  try { await load(); } catch (e) { mount(body, empty('Fehler beim Laden', e.message, 'alert')); }
}
