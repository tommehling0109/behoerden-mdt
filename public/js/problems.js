import { h, mount, timeAgo } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { api } from './api.js';
import { subscribe } from './realtime.js';

/**
 * Problemleiste (Desktop, rechts unter dem Schwarzen Brett): akute Probleme aus den Bereichen, auf die man Zugriff hat (Fahrzeuge, Börse,
 * Rechtsfälle, Lager, Kredit, Deckel, Tickets, Benutzer). Die Leiste pulsiert dezent rot, ist ausklappbar und erscheint nur, wenn es Probleme
 * gibt. Probleme lassen sich nicht wegklicken – sie verschwinden, sobald sie behoben sind. Nur für Mitarbeiter.
 */
const KEY = 'mdt.problems.collapsed';
const read = () => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } }; // Standard: zugeklappt
const write = (v) => { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* egal */ } };

export function createProblems({ onOpen }) {
  let list = [], collapsed = read(), timer;
  const el = h('aside', { class: 'problems', 'aria-label': 'Probleme', hidden: true });

  function draw() {
    el.hidden = !list.length;
    if (!list.length) return mount(el);
    el.classList.toggle('collapsed', collapsed);
    const crit = list.filter((p) => p.severity === 'critical').length;
    const groups = [...new Map(list.map((p) => [p.area, p.areaLabel])).entries()];
    mount(el,
      h('button', { class: 'pb-head', type: 'button', title: collapsed ? 'Aufklappen' : 'Zuklappen', onclick: () => { collapsed = !collapsed; write(collapsed); draw(); } },
        icon('alert'), h('span', { class: 'pb-title' }, list.length === 1 ? '1 Problem' : `${list.length} Probleme`), crit > 0 && h('span', { class: 'pb-crit' }, `${crit} kritisch`), icon(collapsed ? 'chevronD' : 'chevronU')),
      !collapsed && h('div', { class: 'pb-list' }, groups.map(([area, label]) => h('div', { class: 'pb-group' },
        h('div', { class: 'pb-gtitle' }, label),
        list.filter((p) => p.area === area).map((p) => h('button', { type: 'button', class: `pb-item ${p.severity}`, onclick: () => onOpen?.(p.target) },
          h('span', { class: 'pb-ic' }, icon(p.icon)), h('span', { class: 'pb-txt' }, h('span', { class: 'pb-t' }, p.title), h('span', { class: 'pb-d' }, p.detail)), p.since && h('span', { class: 'pb-age' }, timeAgo(p.since))))))));
  }
  async function load() { try { list = (await api.get('/api/problems')).problems; } catch { return; } draw(); }

  load();
  timer = setInterval(load, 60_000); // zeitabhängige Probleme (z. B. „wartet seit 1 Std.“) ohne Ereignis erfassen
  const off = subscribe(['vehicles', 'market', 'legal', 'warehouse', 'credit', 'tab', 'tickets', 'users', 'system'], load, { wait: 600 });
  return { el, destroy: () => { off(); clearInterval(timer); } };
}
