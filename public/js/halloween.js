import { state } from './state.js';

/**
 * Halloween-Design (Konfiguration → Darstellung, nur Superadmin): Dekoration im Hintergrund des Desktops und des Anmeldebildschirms –
 * „Happy Halloween“-Schriftzug, Kürbisse, Lichterkette, Mond, Nebel, Fledermäuse, Spinnennetze und ein Geist. Farben (Orange/Violett) setzt
 * state.js über die Klasse „halloween“ auf <html>. Rein dekorativ (keine Klicks), Bewegung nur bei eingeschalteten Animationen.
 */
const pumpkin = (cls, scale = 1) => `
<svg class="hw-pumpkin ${cls}" viewBox="0 0 120 110" style="--s:${scale}" aria-hidden="true">
  <defs><radialGradient id="pg${cls}" cx="50%" cy="40%" r="65%"><stop offset="0" stop-color="#ffa43a"/><stop offset="0.6" stop-color="#f0690f"/><stop offset="1" stop-color="#b8420a"/></radialGradient></defs>
  <path d="M60 22c-6-10-3-16 4-20" stroke="#4a6b2a" stroke-width="7" fill="none" stroke-linecap="round"/>
  <ellipse cx="35" cy="66" rx="30" ry="38" fill="url(#pg${cls})"/><ellipse cx="85" cy="66" rx="30" ry="38" fill="url(#pg${cls})"/>
  <ellipse cx="60" cy="66" rx="30" ry="41" fill="url(#pg${cls})"/>
  <path d="M60 28c-6 22-6 56 0 80M38 33c-12 22-12 52 0 70M82 33c12 22 12 52 0 70" stroke="#b8420a" stroke-opacity=".45" stroke-width="2.5" fill="none"/>
  <g class="hw-face" fill="#ffe27a"><path d="M36 58l14 8-18 4z"/><path d="M84 58l-14 8 18 4z"/><path d="M60 72l6 10h-12z"/><path d="M34 86q26 22 52 0l-6-3-8 8-6-7-6 7-8-8z"/></g>
</svg>`;
const bat = (cls) => `<svg class="hw-bat ${cls}" viewBox="0 0 64 32" aria-hidden="true"><path d="M32 10c-4-6-12-8-24-6 6 3 8 8 8 14 4-3 8-2 10 4 2-3 4-4 6-4s4 1 6 4c2-6 6-7 10-4 0-6 2-11 8-14-12-2-20 0-24 6z" fill="#0d0714"/><circle cx="29" cy="12" r="1.3" fill="#ffb347"/><circle cx="35" cy="12" r="1.3" fill="#ffb347"/></svg>`;
const web = (cls) => `<svg class="hw-web ${cls}" viewBox="0 0 120 120" aria-hidden="true"><g stroke="#d9d2e4" stroke-opacity=".38" stroke-width="1" fill="none"><path d="M0 0L120 0M0 0L0 120M0 0L100 100M0 0L120 50M0 0L50 120"/><path d="M30 0Q26 26 0 30M60 0Q50 50 0 60M90 0Q74 74 0 90M120 0Q98 98 0 120"/></g></svg>`;
const ghost = `<svg class="hw-ghost" viewBox="0 0 80 100" aria-hidden="true"><path d="M8 94V40C8 18 22 4 40 4s32 14 32 36v54l-9-8-8 8-7-8-7 8-8-8-8 8-7-8z" fill="#f3eefb" fill-opacity=".86"/><ellipse cx="29" cy="40" rx="6" ry="9" fill="#1a0f26"/><ellipse cx="51" cy="40" rx="6" ry="9" fill="#1a0f26"/><ellipse cx="40" cy="62" rx="7" ry="9" fill="#1a0f26"/></svg>`;

function build() {
  const root = document.createElement('div');
  root.className = 'hw-deco'; root.setAttribute('aria-hidden', 'true');
  // Lichterkette: Draht + Glühbirnen entlang einer Kurve (alle 5 Farben, versetzt flackernd)
  const N = 22, colors = ['#ff8a1f', '#a45bff', '#7dff6a', '#ff5a3c', '#ffd34d'];
  let bulbs = '', wire = 'M0 2';
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 100, y = 3 + 2.4 * Math.abs(Math.sin((i / (N - 1)) * Math.PI * 5));
    wire += ` L${x.toFixed(2)} ${y.toFixed(2)}`;
    bulbs += `<i class="hw-bulb" style="left:${x.toFixed(2)}%;top:${(y * 4.6).toFixed(1)}px;--c:${colors[i % colors.length]};animation-delay:${((i * 0.37) % 2.6).toFixed(2)}s"></i>`;
  }
  root.innerHTML = `
    <div class="hw-fog hw-fog-a"></div><div class="hw-fog hw-fog-b"></div>
    <div class="hw-moon"></div>
    ${web('hw-web-l')}${web('hw-web-r')}
    <div class="hw-lights"><svg class="hw-wire" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><path d="${wire}" stroke="#3a2d48" stroke-width="1.4" fill="none" vector-effect="non-scaling-stroke"/></svg>${bulbs}</div>
    <div class="hw-title">Happy Halloween</div>
    ${pumpkin('hw-p1', 1.15)}${pumpkin('hw-p2', 0.8)}${pumpkin('hw-p3', 0.95)}${pumpkin('hw-p4', 1.3)}
    ${ghost}
    ${bat('hw-bat1')}${bat('hw-bat2')}${bat('hw-bat3')}${bat('hw-bat4')}`;
  return root;
}

let queued = false;
/** Hängt die Dekoration an jeden Hintergrund (Desktop, Anmeldung, Sperrbildschirm) oder entfernt sie – je nach Einstellung. */
export function syncHalloween() {
  const on = !!state.config?.['ui.halloween'];
  for (const wp of document.querySelectorAll('.wallpaper')) {
    const has = wp.querySelector(':scope > .hw-deco');
    if (on && !has) wp.append(build()); else if (!on && has) has.remove();
  }
}
const queue = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; syncHalloween(); }); };
export function initHalloween() {
  window.addEventListener('mdt:config-applied', queue);
  new MutationObserver((muts) => { if (state.config?.['ui.halloween'] && muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.classList?.contains('wallpaper') || n.querySelector?.('.wallpaper'))))) queue(); })
    .observe(document.body, { childList: true, subtree: true });
  queue();
}
