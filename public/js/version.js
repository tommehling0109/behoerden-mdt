import { h } from './ui/dom.js';

/**
 * Selbstheilung nach Updates:
 *  - syncVersion: Hat sich die Programmversion seit dem letzten Besuch geändert, wird veralteter lokaler Zustand
 *    (Sperrstatus, „gesehen“-Markierungen, Zwischenspeicher dieser App) verworfen – altes Browser-Zeug stört dann nicht mehr.
 *  - watchVersion: Läuft die Seite während eines Updates weiter, erkennt sie die neue Version und lädt sich neu
 *    (sobald nichts mehr getippt wird), statt mit alten Skripten weiterzulaufen.
 *  - resetLocal (/reset): Notausgang – löscht alle lokalen Daten dieser App und meldet ab.
 */
const KEY = 'mdt:app-version';
const get = (s, k) => { try { return s.getItem(k); } catch { return null; } };

export function wipeLocal() {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('mdt:')) localStorage.removeItem(k); } catch { /* ohne Speicher */ }
  try { sessionStorage.clear(); } catch { /* egal */ }
}

export function syncVersion(version) {
  if (!version) return;
  const stored = get(localStorage, KEY);
  if (stored && stored !== version) wipeLocal();
  try { localStorage.setItem(KEY, version); } catch { /* egal */ }
}

let watching = false;
export function watchVersion(current) {
  if (!current || watching) return;
  watching = true;
  let shown = false;
  const check = async () => {
    if (shown || document.visibilityState === 'hidden') return;
    let v;
    try { v = (await (await fetch('/api/version', { cache: 'no-store', headers: { 'X-Requested-With': 'mdt' } })).json()).version; } catch { return; }
    if (!v || v === current) return;
    shown = true;
    let left = 8;
    const text = h('span', null);
    const banner = h('div', { class: 'update-banner', role: 'status' }, h('b', null, 'Neue Version verfügbar.'), text, h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => reload() }, 'Jetzt neu laden'));
    const reload = () => { try { localStorage.setItem(KEY, v); } catch { /* egal */ } location.reload(); };
    document.body.append(banner);
    const tick = setInterval(() => {
      // nicht mitten in der Eingabe neu laden: offener Dialog oder Eingabefeld im Fokus → warten
      const busy = document.querySelector('.modal-root') || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
      if (busy) { text.textContent = ' Wird neu geladen, sobald du fertig bist.'; left = 8; return; }
      text.textContent = ` Seite lädt in ${left} s neu …`;
      if (left-- <= 0) { clearInterval(tick); reload(); }
    }, 1000);
  };
  setInterval(check, 20_000);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); }); // aus dem Zurück-/Vorwärts-Cache wiederhergestellte Seite: frisch laden
}

/** Zwischenspeicher dieser App leeren (Browser-Cache-API, lokale mdt:-Daten) und die Seite mit neuer Adresse laden – bleibt angemeldet. */
export async function hardRefresh() {
  wipeLocal();
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* keine Cache-API */ }
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch { /* kein SW */ }
  location.replace(`/?neu=${Date.now()}`);
}

export async function resetLocal() {
  document.body.textContent = 'Lokale Daten werden zurückgesetzt …';
  wipeLocal();
  try { localStorage.clear(); } catch { /* egal */ }
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* keine Cache-API */ }
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch { /* kein SW */ }
  for (const url of ['/api/auth/logout', '/api/p/logout']) { try { await fetch(url, { method: 'POST', headers: { 'X-Requested-With': 'mdt', 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* egal */ } }
  location.replace('/');
}
