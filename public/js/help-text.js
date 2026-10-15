import { h } from './ui/dom.js';
import { icon } from './ui/icons.js';

/** Hilfetext → DOM (nie als HTML eingefügt). Format: Absätze durch Leerzeile · „1. …“ Schritte · „- …“ Aufzählung · „Tipp:/Achtung:/Hinweis:“ Kasten · **fett**. */
export function inline(text) {
  const out = [];
  String(text).split(/(\*\*[^*]+\*\*)/).forEach((part) => { if (/^\*\*[^*]+\*\*$/.test(part)) out.push(h('strong', null, part.slice(2, -2))); else if (part) out.push(part); });
  return out;
}

const CALL = { Tipp: ['help-note tip', 'star'], Achtung: ['help-note warn', 'alert'], Hinweis: ['help-note', 'info'] };

export function renderText(text) {
  const root = h('div', { class: 'help-body' });
  for (const para of String(text).split(/\n{2,}/)) {
    const m = /^(Tipp|Achtung|Hinweis):\s*([\s\S]*)$/.exec(para.trim());
    if (m) { root.append(h('div', { class: CALL[m[1]][0] }, icon(CALL[m[1]][1]), h('div', null, h('strong', null, `${m[1]}: `), inline(m[2].replace(/\n/g, ' '))))); continue; }
    let kind = null, buf = [];
    const flush = () => {
      if (!buf.length) return;
      if (kind === 'ol') root.append(h('ol', { class: 'help-steps' }, buf.map((l) => h('li', null, inline(l.replace(/^\d+\.\s+/, ''))))));
      else if (kind === 'ul') root.append(h('ul', { class: 'help-list' }, buf.map((l) => h('li', null, inline(l.replace(/^-\s+/, ''))))));
      else root.append(h('p', null, inline(buf.join(' '))));
      buf = [];
    };
    for (const l of para.split('\n')) {
      const k = /^\d+\.\s/.test(l) ? 'ol' : /^-\s/.test(l) ? 'ul' : 'p';
      if (k !== kind) { flush(); kind = k; }
      buf.push(l);
    }
    flush();
  }
  return root;
}
