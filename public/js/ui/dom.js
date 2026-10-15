/** Minimaler DOM-Helfer. Text wird immer als Text eingefügt (nie als HTML) → XSS-sicher. */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) (p.startsWith('--') ? el.style.setProperty(p, x) : (el.style[p] = x));
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && k !== 'list' && typeof v !== 'object') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
export const mount = (el, ...children) => append(clear(el), children);

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const dtf = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });
export const fmtDateTime = (iso) => (iso ? dtf.format(new Date(iso)) : '–');
export const fmtDate = (iso) => (iso ? df.format(new Date(iso)) : '–');
export function timeAgo(iso) {
  if (!iso) return '–';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'gerade eben';
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} Min.`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `vor ${hrs} Std.`;
  const d = Math.round(hrs / 24);
  return d < 8 ? `vor ${d} Tg.` : fmtDate(iso);
}
