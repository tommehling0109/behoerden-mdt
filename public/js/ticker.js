import { h } from './ui/dom.js';
import { api } from './api.js';
import { subscribe } from './realtime.js';

/**
 * Ticker (Laufband) zwischen Kopfleiste und Desktop: zeigt nacheinander alle laufenden Ankündigungen des Schwarzen Bretts,
 * jeweils in der Farbe der Ankündigung. Läuft bei jedem, bis er auf dem Brett abgeschaltet wird oder sein Enddatum erreicht ist.
 */
const COLOR = { info: ['Info', '#3b6fe0'], important: ['Wichtig', '#d97706'], urgent: ['Dringend', '#dc2626'], success: ['Neuigkeit', '#059669'] };
const SPEED = 95; // Pixel pro Sekunde

export function createTicker({ partner = false } = {}) {
  const tag = h('span', { class: 'tk-tag' }), track = h('div', { class: 'tk-track' }), view = h('div', { class: 'tk-view' }, track);
  const el = h('div', { class: 'ticker', hidden: true, role: 'marquee', 'aria-label': 'Laufband' }, tag, view);
  let items = [], run = 0, anim = null, expiry = null, next = 0;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('no-anim');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loop(my) {
    while (run === my && items.length) {
      const it = items[next++ % items.length], [label, color] = COLOR[it.level] ?? COLOR.info;
      el.style.setProperty('--c', color); tag.textContent = label; track.textContent = it.text;
      if (still()) { track.style.transform = 'none'; track.style.position = 'static'; await sleep(7000); continue; }
      track.style.position = 'absolute';
      const cw = view.clientWidth, tw = track.scrollWidth;
      anim = track.animate([{ transform: `translateX(${cw}px)` }, { transform: `translateX(${-tw}px)` }], { duration: ((cw + tw) / SPEED) * 1000, easing: 'linear' });
      try { await anim.finished; } catch { /* abgebrochen */ }
    }
  }
  function restart() {
    run++; anim?.cancel(); anim = null; clearTimeout(expiry);
    el.hidden = !items.length;
    if (!items.length) return;
    loop(run);
    const ends = items.map((i) => i.until && Date.parse(i.until)).filter(Boolean);
    if (ends.length) expiry = setTimeout(load, Math.min(Math.max(Math.min(...ends) - Date.now() + 500, 1000), 2 ** 31 - 1)); // Ablauf: Ticker verschwindet von selbst
  }
  async function load() {
    try { const r = await api.get(partner ? '/api/p/ticker' : '/api/ticker'); const same = JSON.stringify(r.items) === JSON.stringify(items); items = r.items; if (!same) restart(); } catch { /* offline */ }
  }
  el.addEventListener('mouseenter', () => anim?.pause()); el.addEventListener('mouseleave', () => anim?.play());
  load();
  const off = subscribe(['ticker'], load, { wait: 150 });
  const poll = setInterval(load, 120_000); // Sicherheitsnetz
  return { el, destroy: () => { off(); clearInterval(poll); clearTimeout(expiry); run++; } };
}
