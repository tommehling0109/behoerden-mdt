// Neutrale Oberfläche für die Subdomain der Externen: blendet konfigurierte Begriffe (z. B. „MDT-“, „Firmenname“) überall in der Anzeige aus.
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
export function startNeutral(masks = []) {
  const res = masks.filter(Boolean).map((m) => new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  if (!res.length) return;
  const clean = (t) => res.reduce((s, r) => s.replace(r, ''), t);
  const fix = (n) => {
    if (n.nodeType === 3) { const c = clean(n.nodeValue); if (c !== n.nodeValue) n.nodeValue = c; return; }
    if (n.nodeType !== 1 || n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
    for (const a of ATTRS) { const v = n.getAttribute(a); if (v) { const c = clean(v); if (c !== v) n.setAttribute(a, c); } }
    for (const c of n.childNodes) fix(c);
  };
  const run = () => fix(document.documentElement);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(fix);
      else if (m.type === 'characterData') fix(m.target);
      else if (m.type === 'attributes') fix(m.target);
    }
    const t = clean(document.title); if (t !== document.title) document.title = t;
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  run();
}
