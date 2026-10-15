import { h } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { button } from './ui/kit.js';
import { api } from './api.js';
import { state } from './state.js';

/**
 * Erste-Schritte-Tour: hebt nacheinander wichtige Stellen des Desktops hervor (Dock, Startmenü, Glocke, rechte Spalte, Sperre, Hilfe) und erklärt sie kurz.
 * Läuft beim ersten Anmelden automatisch (abschaltbar in der Konfiguration), ist überspringbar und in der Hilfe jederzeit wiederholbar.
 * Schritte, deren Element nicht existiert (z. B. keine rechte Spalte für Partner), entfallen.
 */
const base = () => (state.user?.isPartner ? '/api/p/help' : '/api/help');

const STEPS = [
  { title: 'Willkommen!', text: 'Eine kurze Tour zeigt dir, wo du was findest. Du kannst sie jederzeit überspringen und in der Hilfe wiederholen.' },
  { sel: '.dock-row', title: 'Das Dock', text: 'Hier liegen deine Apps. Ein Klick öffnet die App in einem Fenster – du kannst mehrere gleichzeitig offen haben, sie verschieben und in der Größe ändern.' },
  { sel: '.panel-left', title: 'Das Startmenü', text: 'Das Startmenü listet alle deine Apps nach Bereichen. Hier findest du auch Einstellungen und Abmelden.' },
  { sel: '[aria-label="Benachrichtigungen"]', title: 'Benachrichtigungen', text: 'Neue Hinweise erscheinen an der Glocke – ein Klick darauf öffnet direkt die passende App.' },
  { sel: '.right-col', title: 'Brett, Probleme, Online', text: 'Rechts siehst du das Schwarze Brett, akute Probleme aus deinen Bereichen und wer gerade online ist.', when: () => !state.user?.isPartner },
  { sel: '[aria-label="Bildschirm sperren"]', title: 'Bildschirm sperren', text: 'Wenn du kurz weg bist, sperrst du hier deinen Bildschirm. Nach einiger Zeit ohne Eingabe passiert das auch automatisch.' },
  { sel: '[aria-label="Hilfe"]', title: 'Hilfe gibt es überall', text: 'Mit dem Fragezeichen hier – und in der Titelleiste jedes Fensters – öffnest du die passende Anleitung. Sie zeigt nur, was du auch nutzen darfst.' },
];

let running = false;

export function startTour({ force = false } = {}) {
  if (running) return;
  const steps = STEPS.filter((s) => (!s.when || s.when()) && (!s.sel || (() => { const e = document.querySelector(s.sel); return e && e.offsetParent !== null && !e.hidden; })()));
  if (!steps.length) return;
  running = true;
  let i = 0;
  const screen = document.getElementById('screen');
  const spot = h('div', { class: 'tour-spot' });
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tour' });
  const root = h('div', { class: 'tour-root' }, spot, card);
  const finish = (done) => {
    document.removeEventListener('keydown', onKey); window.removeEventListener('resize', draw); root.remove(); running = false;
    if (done && !force) api.post(`${base()}/tour`, { done: true }).catch(() => {});
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(true); } else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); } else if (e.key === 'ArrowLeft') go(-1); };
  const go = (d) => { if (i + d >= steps.length) return finish(true); i = Math.max(0, i + d); draw(); };
  function draw() {
    const s = steps[i], el = s.sel ? document.querySelector(s.sel) : null, r = el?.getBoundingClientRect();
    const pad = 6, vw = window.innerWidth, vh = window.innerHeight;
    if (r) Object.assign(spot.style, { display: 'block', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    else Object.assign(spot.style, { display: 'block', left: `${vw / 2}px`, top: `${vh / 2}px`, width: '0px', height: '0px' });
    card.replaceChildren(
      h('div', { class: 'tour-step' }, `${i + 1} / ${steps.length}`), h('h3', null, s.title), h('p', null, s.text),
      h('div', { class: 'tour-btns' }, button('Überspringen', { variant: 'ghost', size: 'sm', onClick: () => finish(true) }),
        h('span', { style: { flex: 1 } }), i > 0 && button('Zurück', { size: 'sm', onClick: () => go(-1) }),
        button(i === steps.length - 1 ? 'Fertig' : 'Weiter', { variant: 'primary', size: 'sm', icon: i === steps.length - 1 ? 'check' : 'chevronR', onClick: () => go(1) })));
    // Karte neben das Element setzen (unterhalb, sonst oberhalb, sonst mittig)
    const cw = Math.min(340, vw - 24); card.style.width = `${cw}px`;
    requestAnimationFrame(() => {
      const ch = card.offsetHeight;
      let x = r ? r.left + r.width / 2 - cw / 2 : (vw - cw) / 2, y = r ? r.bottom + 16 : (vh - ch) / 2;
      if (r && y + ch > vh - 12) y = Math.max(12, r.top - ch - 16);
      if (r && r.top - ch - 16 < 12 && y + ch > vh - 12) { y = Math.max(12, (vh - ch) / 2); x = r.right + 16 + cw < vw ? r.right + 16 : r.left - cw - 16; }
      card.style.left = `${Math.max(12, Math.min(vw - cw - 12, x))}px`; card.style.top = `${Math.max(12, y)}px`;
    });
    card.querySelector('.btn-primary')?.focus();
  }
  document.addEventListener('keydown', onKey, true); window.addEventListener('resize', draw);
  screen.append(root); draw();
}

/** Automatisch beim ersten Anmelden – wartet, bis nichts anderes im Vordergrund ist (Dialoge, Sperrbildschirm). */
export async function maybeStartTour(isBlocked) {
  try {
    if (state.config['help.tour'] === false) return;
    if (!state.user?.isPartner && (state.config['system.disabled_apps'] ?? []).includes('help')) return;
    const { tourDone } = await api.get(base());
    if (tourDone) return;
    let tries = 0;
    const attempt = () => {
      if (running) return;
      if ((document.querySelector('.modal-root') || isBlocked?.()) && tries++ < 20) return setTimeout(attempt, 3000);
      startTour();
    };
    setTimeout(attempt, 1800);
  } catch { /* egal */ }
}

/** Gibt es ein Kapitel zu dieser App? (für den „?“-Knopf in den Fenstern) */
let idsPromise = null;
export const helpIds = (refresh = false) => (idsPromise && !refresh ? idsPromise : (idsPromise = api.get(base()).then((d) => new Set(d.articles.map((a) => a.id))).catch(() => new Set())));
