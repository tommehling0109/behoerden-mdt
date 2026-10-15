import { h } from './dom.js';

/**
 * Kleine Diagramme ohne Bibliothek (reines HTML/CSS): Säulen, gruppierte Säulen und waagerechte Balken.
 * Alle Werte stehen zusätzlich als Tooltip (title) an den Elementen.
 */
const maxOf = (vals) => Math.max(1, ...vals.map((v) => Math.abs(v)));

/** Säulen: rows = [{ label, value, title? }] */
export function columns(rows, { color = 'var(--accent)', height = 110, fmt = (v) => String(v) } = {}) {
  const max = maxOf(rows.map((r) => r.value));
  return h('div', { class: 'chart-cols', style: { '--ch': `${height}px` } }, rows.map((r) => h('div', { class: 'cc', title: r.title ?? `${r.label}: ${fmt(r.value)}` },
    h('div', { class: 'cc-bar-wrap' }, h('div', { class: 'cc-bar', style: { height: `${Math.max(r.value > 0 ? 3 : 0, (r.value / max) * 100)}%`, background: color } })),
    h('div', { class: 'cc-l' }, r.label))));
}

/** Gruppierte Säulen mit zwei Reihen: rows = [{ label, a, b }] */
export function pairColumns(rows, { aColor = '#34d399', bColor = '#f87171', aLabel = 'Einnahmen', bLabel = 'Ausgaben', height = 130, fmt = (v) => String(v) } = {}) {
  const max = maxOf(rows.flatMap((r) => [r.a, r.b]));
  const legend = h('div', { class: 'chart-legend' }, h('span', null, h('i', { style: { background: aColor } }), aLabel), h('span', null, h('i', { style: { background: bColor } }), bLabel));
  return h('div', null, h('div', { class: 'chart-cols', style: { '--ch': `${height}px` } }, rows.map((r) => h('div', { class: 'cc wide', title: `${r.label}\n${aLabel}: ${fmt(r.a)}\n${bLabel}: ${fmt(r.b)}` },
    h('div', { class: 'cc-bar-wrap pair' },
      h('div', { class: 'cc-bar', style: { height: `${Math.max(r.a > 0 ? 3 : 0, (r.a / max) * 100)}%`, background: aColor } }),
      h('div', { class: 'cc-bar', style: { height: `${Math.max(r.b > 0 ? 3 : 0, (r.b / max) * 100)}%`, background: bColor } })),
    h('div', { class: 'cc-l' }, r.label)))), legend);
}

/** Waagerechte Balken: rows = [{ label, value, color? , text? }] */
export function hbars(rows, { color = 'var(--accent)', fmt = (v) => String(v) } = {}) {
  const max = maxOf(rows.map((r) => r.value));
  return h('div', { class: 'chart-h' }, rows.map((r) => h('div', { class: 'ch-row', title: `${r.label}: ${r.text ?? fmt(r.value)}` },
    h('div', { class: 'ch-l' }, r.label),
    h('div', { class: 'ch-track' }, h('div', { class: 'ch-fill', style: { width: `${Math.max(r.value > 0 ? 2 : 0, (r.value / max) * 100)}%`, background: r.color ?? color } })),
    h('div', { class: 'ch-v' }, r.text ?? fmt(r.value)))));
}
