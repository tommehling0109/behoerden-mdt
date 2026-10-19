import { h, mount } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { api } from './api.js';
import { levelBadge } from './ui/kit.js';
import { state } from './state.js';
import { subscribe } from './realtime.js';

/**
 * Online-Liste: meldet diese Seite regelmäßig als „online“ (und ob der Sperrbildschirm aktiv ist) und zeigt rechts auf dem Desktop, welche
 * Mitglieder gerade online sind – nur Dienstnummer und Rang. Gesperrte Bildschirme erscheinen grau mit „Sperrbildschirm“. Nur Mitarbeiter.
 */
const tabId = Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
let beat = null;

/** Herzschlag: alle 25 s sowie sofort, wenn sich der Sperrzustand ändert; beim Schließen der Seite wird abgemeldet. */
export function startPresence(isLocked, onBeat, { partner = false } = {}) {
  const base = partner ? '/api/p/presence' : '/api/presence';
  if (beat) return;
  let lastLocked = null;
  const send = () => { if (state.config['presence.enabled'] === false && partner) return; lastLocked = !!isLocked(); return api.post(base, { tabId, locked: lastLocked }).then(() => onBeat?.()).catch(() => { /* Server kurz weg – nächster Schlag */ }); };
  const tick = setInterval(send, 25_000);
  const watch = setInterval(() => { if (!!isLocked() !== lastLocked) send(); }, 2_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') send(); });
  window.addEventListener('pagehide', () => { try { fetch(`${base}/leave`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mdt' }, body: JSON.stringify({ tabId }) }); } catch { /* egal */ } });
  beat = { tick, watch };
  send();
}

const KEY = 'mdt.online.collapsed';
const read = () => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } }; // Standard: zugeklappt
const write = (v) => { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* egal */ } };

export function createOnline() {
  let members = [], enabled = true, collapsed = read();
  const el = h('aside', { class: 'online', 'aria-label': 'Online', hidden: true });

  function draw() {
    el.hidden = !enabled || state.config['presence.enabled'] === false;
    if (el.hidden) return mount(el);
    el.classList.toggle('collapsed', collapsed);
    // Die eigene Seite ist immer online: auch wenn die Liste vom Server noch den ersten Herzschlag abwartet, steht man selbst („Du“) darin
    const u = state.user ?? {};
    const list = members.some((m) => m.isMe) || !u.id ? members : [{ id: u.id, label: u.memberNumber || `Mitglied #${u.id}`, rank: u.rank ?? null, state: 'active', isMe: true }, ...members];
    const active = list.filter((m) => m.state === 'active').length, locked = list.length - active;
    mount(el,
      h('button', { class: 'ol-head', type: 'button', title: collapsed ? 'Aufklappen' : 'Zuklappen', onclick: () => { collapsed = !collapsed; write(collapsed); draw(); } },
        icon('users'), h('span', { class: 'ol-title' }, 'Online'), h('span', { class: 'ol-count' }, active), locked > 0 && h('span', { class: 'ol-locked-count', title: 'Sperrbildschirm' }, `+${locked}`), icon(collapsed ? 'chevronD' : 'chevronU')),
      !collapsed && h('div', { class: 'ol-list' }, list.length ? list.map((m) => h('div', { class: `ol-row ${m.state}` },
        h('span', { class: 'ol-dot' }), h('span', { class: 'ol-no' }, m.label, m.isMe && h('span', { class: 'ol-me' }, ' (Du)')), m.kind === 'partner' && h('span', { class: 'ol-ext', title: 'Externer Zugang' }, 'Extern'), m.kind === 'partner' && levelBadge(m.level),
        m.rank && h('span', { class: 'ol-rank', style: { color: m.rank.color ?? 'inherit' } }, m.rank.name), m.state === 'locked' && h('span', { class: 'ol-state' }, 'Sperrbildschirm'))) : h('div', { class: 'ol-empty' }, 'Niemand online.')));
  }
  async function load() { try { const r = await api.get('/api/presence'); enabled = r.enabled; members = r.members; draw(); } catch { /* egal */ } }

  load();
  const timer = setInterval(load, 20_000); // Rückfall, falls ein Ereignis ausbleibt
  const off = subscribe(['presence', 'system'], load, { wait: 300 });
  window.addEventListener('mdt:config-applied', draw);
  return { el, refresh: load, destroy: () => { off(); clearInterval(timer); } };
}
