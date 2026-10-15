import { h, mount, fmtDateTime } from '../ui/dom.js';
import { card, skeletons, empty } from '../ui/kit.js';
import { api } from '../api.js';
import { columns, pairColumns, hbars } from '../ui/charts.js';

const DEAL = { submitted: 'Eingereicht', countered: 'Gegenangebot', accepted: 'Angenommen', delivery: 'Übergabe', completed: 'Abgeschlossen', rejected: 'Abgelehnt', cancelled: 'Storniert', withdrawn: 'Zurückgezogen' };
const LOAN = { requested: 'Angefragt', negotiating: 'Verhandlung', accepted: 'Angenommen', active: 'Laufend', completed: 'Abgeschlossen', rejected: 'Abgelehnt', withdrawn: 'Zurückgezogen', cancelled: 'Storniert', defaulted: 'Ausgefallen' };
const TAB = { submitted: 'Eingereicht', review: 'In Prüfung', confirmed: 'Bestätigt', payment_pending: 'Zahlung offen', paid: 'Bezahlt', rejected: 'Abgelehnt' };
const USER = { pending: 'Ausstehend', active: 'Aktiv', blocked: 'Gesperrt', rejected: 'Abgelehnt' };
const MODULE = { users: 'Benutzer', roles: 'Rollen', org: 'Organisation', market: 'Börse', partners: 'Externe Zugänge', chat: 'Chat', vehicles: 'Fahrzeuge', map: 'Karte', warehouse: 'Lager', finance: 'Finanzen', credit: 'Kredit', tab: 'Deckel', system: 'System', lookups: 'Kategorien', account: 'Konto' };
const dayLabel = (d) => d.slice(8, 10) + '.' + d.slice(5, 7) + '.';
const monthLabel = (m) => `${['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'][Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

/** Statistik: aggregierte Kennzahlen je Bereich. Nur Abschnitte, für die der Benutzer das jeweilige Ansichtsrecht hat, werden geliefert. */
export default async function render(container, ctx) {
  mount(container, skeletons(3, 140));
  async function load() {
    const d = await api.get('/api/stats');
    if (!ctx.isCurrent()) return;
    const s = d.sections;
    const money = (n) => `${Number(n ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${d.currency}`;
    const cents = (c) => money(c / 100);
    const num = (n) => Number(n ?? 0).toLocaleString('de-DE');
    const tile = (v, label, tone) => h('div', { class: `tile ${tone ? 't-' + tone : ''}` }, h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, v), h('div', { class: 'tile-label' }, label)));
    const cards = [];
    if (s.finance) cards.push(card('Finanzen – Verlauf (verbucht)', s.finance.monthly.length ? pairColumns(s.finance.monthly.map((m) => ({ label: monthLabel(m.month + '-01'), a: m.in, b: m.out })), { fmt: money }) : empty('Noch keine Bewegungen', null, 'dollar'), { icon: 'dollar' }));
    if (s.market) cards.push(card('Börse', h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(cents(s.market.completedVolume * 100), 'Abgeschlossenes Volumen', 'ok'), tile(num(s.market.activePartners), 'Aktive Partner (30 Tage)', 'info')),
      h('div', null, h('div', { class: 'sub-title' }, 'Geschäfte nach Status'), s.market.dealsByStatus.length ? hbars(s.market.dealsByStatus.map((x) => ({ label: DEAL[x.key] ?? x.key, value: x.n }))) : empty('Noch keine Geschäfte', null, 'tag')),
      s.market.topItems.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Top-Artikel (Volumen)'), hbars(s.market.topItems.map((x) => ({ label: x.name ?? x.label, value: x.volume, text: money(x.volume) })), { color: '#34d399' })),
      h('div', null, h('div', { class: 'sub-title' }, 'Neue Geschäfte (14 Tage)'), columns(s.market.perDay.map((x) => ({ label: dayLabel(x.day), value: x.n }))))), { icon: 'tag' }));
    if (s.credit) cards.push(card('Kredit', h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(cents(s.credit.outstandingCents), 'Offene Raten (laufende Kredite)', 'warn'), tile(num(s.credit.overdue), 'Überfällige Raten', s.credit.overdue ? 'err' : 'ok'), tile(cents(s.credit.paidInterestCents), 'Gezahlte Zinsen', 'info')),
      h('div', null, h('div', { class: 'sub-title' }, 'Kredite nach Status (Anzahl)'), s.credit.loansByStatus.length ? hbars(s.credit.loansByStatus.map((x) => ({ label: LOAN[x.key] ?? x.key, value: x.n, text: `${x.n} · ${cents(x.cents)}` }))) : empty('Noch keine Kredite', null, 'bank'))), { icon: 'bank' }));
    if (s.tab) cards.push(card('Deckel', h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(num(s.tab.companies), 'Aktive Firmen', 'info')),
      h('div', null, h('div', { class: 'sub-title' }, 'Abrechnungen nach Status'), s.tab.byStatus.length ? hbars(s.tab.byStatus.map((x) => ({ label: TAB[x.key] ?? x.key, value: x.n, text: `${x.n} · ${cents(x.cents)}` }))) : empty('Noch keine Abrechnungen', null, 'dollar')),
      s.tab.topCompanies.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Bezahlt – Top-Firmen'), hbars(s.tab.topCompanies.map((x) => ({ label: x.label, value: x.cents, text: cents(x.cents) })), { color: '#34d399' }))), { icon: 'dollar' }));
    if (s.warehouse) cards.push(card('Lager', h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(num(s.warehouse.warehouses), 'Aktive Lager', 'info'), tile(num(s.warehouse.totalUnits), 'Einheiten im Bestand'), tile(money(s.warehouse.valueRef), 'Bestandswert (Referenzpreis)', 'ok')),
      s.warehouse.byWarehouse.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Bestand je Lager'), hbars(s.warehouse.byWarehouse.map((x) => ({ label: x.label, value: x.qty, text: num(x.qty) })))),
      s.warehouse.topItems.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Größte Bestände'), hbars(s.warehouse.topItems.map((x) => ({ label: x.label, value: x.qty, text: `${num(x.qty)} ${x.unit}` })), { color: '#a78bfa' }))), { icon: 'storage' }));
    if (s.vehicles) cards.push(card('Fahrzeuge', h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(num(s.vehicles.total), 'Fahrzeuge'), tile(num(s.vehicles.inspectionDue), 'Prüfung in ≤ 30 Tagen', s.vehicles.inspectionDue ? 'warn' : 'ok')),
      s.vehicles.byCondition.length ? hbars(s.vehicles.byCondition.map((x) => ({ label: x.key, value: x.n }))) : empty('Noch keine Fahrzeuge', null, 'car')), { icon: 'car' }));
    if (s.users) cards.push(card('Mitglieder', h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(num(s.users.newLast30), 'Neu (30 Tage)', 'info'), ...s.users.byStatus.map((x) => tile(num(x.n), USER[x.key] ?? x.key, x.key === 'pending' && x.n ? 'warn' : ''))),
      s.users.byRank.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Aktive nach Rang'), hbars(s.users.byRank.map((x) => ({ label: x.label, value: x.n, color: x.color })))),
      s.users.byDepartment.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Aktive nach Abteilung'), hbars(s.users.byDepartment.map((x) => ({ label: x.label, value: x.n, color: x.color }))))), { icon: 'users' }));
    if (s.chat) cards.push(card('Chat', h('div', { class: 'stack-v' }, h('div', { class: 'tile-row' }, tile(num(s.chat.total), 'Nachrichten gesamt')), h('div', null, h('div', { class: 'sub-title' }, 'Nachrichten pro Tag (14 Tage)'), columns(s.chat.perDay.map((x) => ({ label: dayLabel(x.day), value: x.n })), { color: '#22d3ee' }))), { icon: 'chat' }));
    if (s.activity) cards.push(card('Aktivität im System', h('div', { class: 'stack-v' }, h('div', null, h('div', { class: 'sub-title' }, 'Protokollierte Aktionen pro Tag (14 Tage)'), columns(s.activity.perDay.map((x) => ({ label: dayLabel(x.day), value: x.n })), { color: '#f59e0b' })),
      s.activity.byModule.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Nach Bereich (30 Tage)'), hbars(s.activity.byModule.map((x) => ({ label: MODULE[x.label] ?? x.label, value: x.n })), { color: '#f59e0b' }))), { icon: 'activity' }));
    mount(container, cards.length ? h('div', { class: 'stack-v' }, h('div', { class: 'muted', style: { fontSize: '12px' } }, `Stand ${fmtDateTime(d.generatedAt)} · es werden nur Bereiche gezeigt, für die du ein Ansichtsrecht hast`), h('div', { class: 'stat-grid' }, cards))
      : empty('Keine Statistik verfügbar', 'Für die Auswertung brauchst du zusätzlich das Ansichtsrecht des jeweiligen Bereichs (z. B. Börse, Kredit, Deckel).', 'chart'));
  }
  ctx.live(['market', 'credit', 'tab', 'finance', 'users', 'warehouse', 'vehicles', 'chat'], load, { wait: 1500 });
  try { await load(); } catch (e) { mount(container, empty('Fehler beim Laden', e.message, 'alert')); }
}
