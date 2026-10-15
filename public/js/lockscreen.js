// Sperrbildschirm: nach Inaktivität (Timeout aus der Konfiguration) oder manuell. Entsperren = Passwort (Mitarbeiter) bzw. Code (Partner).
// Die Sitzung bleibt bestehen; der Bildschirm ist bis zur erneuten Bestätigung verdeckt. Gesperrter Zustand überlebt einen Reload.
import { h, mount } from './ui/dom.js';
import { everySecond, timeParts, dateLong } from './clock.js';
import { icon } from './ui/icons.js';
import { state } from './state.js';

const LOCKED_KEY = 'mdt:locked';
const ACTIVITY_KEY = 'mdt:activity';
let cleanup = null;

const read = (store, k) => { try { return store.getItem(k); } catch { return null; } };
const write = (store, k, v) => { try { store.setItem(k, v); } catch { /* egal */ } };

/**
 * who: { name, label } – Anzeige; verify(secret) → Promise (wirft bei falschem Passwort/Code); secretLabel: 'Passwort' | 'Zugangscode'.
 * Gibt { lock, destroy, isLocked } zurück.
 */
export function initLock({ who, secretLabel, verify, onLogout, scope }) {
  cleanup?.();
  let locked = false;
  let overlay = null;
  let last = Date.now();
  const sharedKey = `${ACTIVITY_KEY}:${scope}`;
  const lockKey = `${LOCKED_KEY}:${scope}`;

  const touch = () => {
    last = Date.now();
    // Aktivität in einem anderen Tab zählt mit (gedrosselt), damit nicht ein ruhiger Tab alles sperrt
    if (last - Number(read(localStorage, sharedKey) || 0) > 5000) write(localStorage, sharedKey, String(last));
  };

  function lock(fromOtherTab = false) {
    if (locked) return;
    locked = true;
    write(sessionStorage, lockKey, '1');
    if (!fromOtherTab) write(localStorage, `mdt:lockbroadcast:${scope}`, String(Date.now())); // andere Tabs sperren mit
    document.getElementById('screen').classList.add('is-locked');
    draw();
  }

  function draw() {
    // Nur die Personalnummer (MDT-…) – nie ein Name (Anonymität)
    const id = who.label ?? 'Mitglied';
    const lsTime = h('div', { class: 'ls-time' }), lsDate = h('div', { class: 'ls-date' });
    const clock = h('div', { class: 'ls-clock' }, lsTime, lsDate);
    const tick = () => { const t = timeParts(); lsTime.textContent = `${t.hm}:${t.s}`; lsDate.textContent = dateLong(new Date(), true); };
    everySecond(clock, tick);

    const err = h('div', { class: 'ls-error' });
    const input = h('input', { class: 'ls-input', type: 'password', autocomplete: 'current-password', placeholder: secretLabel, 'aria-label': secretLabel });
    const submit = h('button', { class: 'ls-btn', type: 'submit' }, 'Entsperren');
    const form = h('form', { class: 'ls-form', novalidate: true }, input, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try { await verify(input.value); unlock(); }
      catch (ex) { err.textContent = ex.message; input.select(); input.classList.remove('shake'); void input.offsetWidth; input.classList.add('shake'); }
      finally { submit.disabled = false; }
    });
    overlay = h('div', { class: 'lock-overlay ls', role: 'dialog', 'aria-label': 'Bildschirm gesperrt' },
      h('div', { class: 'ls-inner' },
        h('div', { class: 'ls-logo' }, h('div', { class: 'logo-phoenix' })),
        clock,
        h('div', { class: 'ls-id' }, icon('lock'), h('span', null, id)),
        form, err,
        h('div', { class: 'ls-out' }, 'Nicht ', h('b', null, id), '? ', h('button', { class: 'ls-link', type: 'button', onclick: onLogout }, 'Abmelden'))));
    document.getElementById('screen').append(overlay);
    input.focus();
  }

  function unlock() {
    locked = false;
    try { sessionStorage.removeItem(lockKey); } catch { /* egal */ }
    document.getElementById('screen').classList.remove('is-locked');
    overlay?.remove(); overlay = null;
    touch();
  }

  // Aktivität erkennen
  const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  const onAct = () => { if (!locked) touch(); };
  evs.forEach((e) => document.addEventListener(e, onAct, { passive: true }));
  let moveAt = 0;
  const onMove = () => { const n = Date.now(); if (n - moveAt > 2000) { moveAt = n; onAct(); } };
  document.addEventListener('mousemove', onMove, { passive: true });

  // Inaktivität prüfen (Timeout wird bei jedem Durchlauf frisch aus der Konfiguration gelesen → Änderungen wirken sofort)
  const timer = setInterval(() => {
    const minutes = Number(state.config['security.lock_timeout_minutes']) || 0;
    if (locked || minutes <= 0) return;
    const idleSince = Math.max(last, Number(read(localStorage, sharedKey) || 0));
    if (Date.now() - idleSince >= minutes * 60_000) lock();
  }, 5_000);

  const onStorage = (e) => { if (e.key === `mdt:lockbroadcast:${scope}` && e.newValue) lock(true); };
  window.addEventListener('storage', onStorage);

  touch();
  if (read(sessionStorage, lockKey) === '1') lock(true); // nach Reload weiterhin gesperrt

  cleanup = () => {
    clearInterval(timer);
    evs.forEach((e) => document.removeEventListener(e, onAct));
    document.removeEventListener('mousemove', onMove);
    window.removeEventListener('storage', onStorage);
    overlay?.remove();
    document.getElementById('screen')?.classList.remove('is-locked');
    cleanup = null;
  };
  return { lock: () => lock(), destroy: () => cleanup?.(), isLocked: () => locked };
}

export const clearLockState = () => {
  try { Object.keys(sessionStorage).filter((k) => k.startsWith(LOCKED_KEY)).forEach((k) => sessionStorage.removeItem(k)); } catch { /* egal */ }
};
