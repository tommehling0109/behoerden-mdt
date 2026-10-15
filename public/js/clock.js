// Live-Uhr: tickt sekundengenau (an der vollen Sekunde ausgerichtet) und holt nach Tab-Wechsel/Standby sofort auf.
export const timeParts = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return { hm: `${p(d.getHours())}:${p(d.getMinutes())}`, s: p(d.getSeconds()) };
};
export const dateLong = (d = new Date(), year = false) => d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', ...(year ? { year: 'numeric' } : {}) });

/** Ruft fn sofort und danach jede volle Sekunde auf, solange el im DOM hängt. */
export function everySecond(el, fn) {
  fn();
  let t;
  const loop = () => {
    if (!el.isConnected) { document.removeEventListener('visibilitychange', onVis); return; }
    fn();
    t = setTimeout(loop, 1000 - (Date.now() % 1000) + 8);
  };
  const onVis = () => { if (document.visibilityState === 'visible' && el.isConnected) fn(); };
  document.addEventListener('visibilitychange', onVis);
  t = setTimeout(loop, 1000 - (Date.now() % 1000) + 8);
  return () => clearTimeout(t);
}
