import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { fmtDate, fmtDateTime } from '../ui/dom.js';
import { fmtC } from './tab.js';

export { fmtC };
export const FREQ = { weekly: 'wöchentlich', monthly: 'monatlich' };
export const loanBadge = (l) => h('span', { class: 'badge', style: { '--c': l.statusColor } }, l.statusLabel);
export const dueIn = (date) => {
  const d = Math.round((new Date(`${date}T12:00:00`) - new Date(new Date().toDateString() + ' 12:00:00')) / 86400000);
  return d === 0 ? 'heute' : d === 1 ? 'morgen' : d > 1 ? `in ${d} Tagen` : d === -1 ? 'seit gestern' : `seit ${-d} Tagen`;
};

/** Transparente Konditionen: was wird geliehen, was kostet es, was ist insgesamt zurückzuzahlen. */
export function termsBox(l) {
  const row = (k, v, strong) => h('div', { class: 'tb-row' }, h('span', { class: 'k' }, k), strong ? h('b', null, v) : h('span', null, v));
  return h('div', { class: 'terms-box' },
    h('div', { class: 'tb-col' },
      row('Kreditsumme', fmtC(l.principalCents), true),
      row('Laufzeit', `${l.termCount} ${l.frequency === 'weekly' ? (l.termCount === 1 ? 'Woche' : 'Wochen') : (l.termCount === 1 ? 'Monat' : 'Monate')} · ${l.termCount} ${FREQ[l.frequency]}e ${l.termCount === 1 ? 'Rate' : 'Raten'}`),
      row('Zinssatz', l.interest.text)),
    h('div', { class: 'tb-col' },
      row('Zinsen gesamt', l.interest.set ? fmtC(l.interestCents) : 'noch offen', true),
      row('Gesamtrückzahlung', l.interest.set ? fmtC(l.totalCents) : `ab ${fmtC(l.principalCents)}`, true),
      row(`Rate (${FREQ[l.frequency]})`, l.interest.set ? fmtC(l.installmentCents) : `ca. ${fmtC(Math.round(l.principalCents / l.termCount))} + Zinsen`)),
    l.payTo && h('div', { class: 'tb-pay' }, icon('dollar'), h('div', null, h('span', { class: 'k' }, 'Zahlung an'), h('div', { class: 'tb-payto' }, l.payTo))));
}

/** Tilgungsplan; actions(inst) liefert Buttons je offener Rate. */
export function scheduleTable(list, actions) {
  return h('div', { class: 'table-wrap' }, h('div', { class: 'table-scroll' }, h('table', { class: 'table', style: { minWidth: '560px' } },
    h('thead', null, h('tr', null, ['Rate', 'Fällig bis', 'Betrag', 'Davon Zinsen', 'Status', ''].map((t) => h('th', null, t)))),
    h('tbody', null, list.map((i) => h('tr', { class: i.overdue ? 'row-overdue' : '' },
      h('td', null, `${i.seq}`), h('td', null, h('b', null, fmtDate(i.dueDate)), i.status === 'open' && h('div', { class: i.overdue ? 'due-over' : 'muted', style: { fontSize: '11.5px' } }, dueIn(i.dueDate))),
      h('td', null, fmtC(i.amountCents), i.paidCents > 0 && i.status === 'open' && h('div', { class: 'muted', style: { fontSize: '11.5px' } }, `bereits ${fmtC(i.paidCents)}`)), h('td', { class: 'muted' }, fmtC(i.interestCents)),
      h('td', null, i.status === 'paid' ? h('span', { class: 'badge b-ok' }, `Bezahlt${i.paidAt ? ' ' + fmtDate(i.paidAt) : ''}`) : i.status === 'cancelled' ? h('span', { class: 'badge b-mute no-dot' }, 'Entfällt') : i.overdue ? h('span', { class: 'badge b-err' }, 'Überfällig') : h('span', { class: 'badge b-warn' }, 'Offen'),
        i.reportedAt && i.status === 'open' && h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '3px' } }, `Zahlung gemeldet ${fmtDateTime(i.reportedAt)}`)),
      h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } }, i.status === 'open' && actions?.(i))))))));
}

const KIND = { request: 'hat den Kredit angefragt', counter: 'hat einen Gegenvorschlag gemacht', accept: 'hat angenommen', reject: 'hat abgelehnt', withdraw: 'hat zurückgezogen', cancel: 'hat storniert', message: 'Nachricht', note: 'Interne Notiz', disburse: 'Auszahlung', payment: 'Zahlung', report: 'Zahlung gemeldet', default: 'Ausfall' };
const ICON = { request: 'dollar', counter: 'refresh', accept: 'check', reject: 'x', withdraw: 'x', cancel: 'x', message: 'chat', note: 'lock', disburse: 'dollar', payment: 'check', report: 'alert', default: 'alert' };
export function timeline(events) {
  return h('div', { class: 'timeline' }, events.map((e) => h('div', { class: `tl-item ${e.internal ? 'internal' : ''} ${e.actorType}` }, h('div', { class: 'tl-dot' }, icon(ICON[e.kind] ?? 'activity')),
    h('div', { class: 'tl-body' }, h('div', { class: 'tl-head' }, h('b', null, e.actor), ' ', KIND[e.kind] ?? e.kind, h('span', { class: 'muted', style: { marginLeft: '8px', fontSize: '12px' } }, fmtDateTime(e.createdAt))),
      e.snapshot && ['request', 'counter', 'accept'].includes(e.kind) && h('div', { class: 'tl-offer' }, `${fmtC(e.snapshot.principalCents)} · ${e.snapshot.termCount} ${FREQ[e.snapshot.frequency]}e Raten${e.snapshot.interestSet ? ` · ${e.snapshot.rate} · Zinsen ${fmtC(e.snapshot.interestCents)} · gesamt ${fmtC(e.snapshot.totalCents)}` : ' · Zinsen offen'}`),
      e.text && h('div', { class: 'tl-text' }, e.text)))));
}
