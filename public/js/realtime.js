// Echtzeit-Client (Server-Sent Events) – EIN System für Hauptpanel und Partner-Portal.
//
//  • Der Server meldet nur „etwas hat sich geändert“; die Ansichten laden über die normalen API-Endpunkte nach
//    (der Backend-Zustand bleibt die einzige Wahrheit, es gibt keinen veralteten Client-Cache).
//  • Ereignisse tragen fortlaufende IDs → Duplikate werden verworfen, nach einem Verbindungsabbruch liefert der
//    Server verpasste Ereignisse nach (Last-Event-ID) oder verlangt einen vollständigen Neuabgleich („resync“).
const subs = new Set();          // { topics:Set, fn, wait, timer }
const notifSubs = new Set();
const statusSubs = new Set();

let source = null;
let kind = null;
let lastId = 0;
let connected = false;
let everConnected = false;
let retryTimer = null;

const url = () => (kind === 'partner' ? '/api/p/events' : '/api/events');

function setConnected(v) {
  if (connected === v) return;
  connected = v;
  statusSubs.forEach((f) => f(v));
}
export const isConnected = () => connected;
export const onStatus = (fn) => { statusSubs.add(fn); fn(connected); return () => statusSubs.delete(fn); };
export const onNotification = (fn) => { notifSubs.add(fn); return () => notifSubs.delete(fn); };

/** Ansicht für Themen abonnieren ('*' = alles). Zusammenfassen schneller Folgen (Standard 200 ms). Gibt eine Abmelde-Funktion zurück. */
export function subscribe(topics, fn, { wait = 200 } = {}) {
  const s = { topics: new Set(Array.isArray(topics) ? topics : [topics]), fn, wait, timer: null };
  subs.add(s);
  return () => { clearTimeout(s.timer); subs.delete(s); };
}

function fire(s) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { try { Promise.resolve(s.fn()).catch((e) => console.warn('[live]', e)); } catch (e) { console.warn('[live]', e); } }, s.wait);
}
const dispatchChange = (topic) => { for (const s of subs) if (s.topics.has('*') || s.topics.has(topic)) fire(s); };
const resyncAll = () => { for (const s of subs) fire(s); };

const accept = (e) => {
  const id = Number(e.lastEventId);
  if (id && id <= lastId) return false; // schon verarbeitet (Reconnect-Replay) → nie doppelt
  if (id) lastId = id;
  return true;
};

export function connect(k) {
  kind = k;
  open();
  // Zurück im Tab / Netz wieder da: sofort prüfen, ob die Verbindung steht
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !connected) reopen(); });
  window.addEventListener('online', () => reopen());
}

function reopen() {
  clearTimeout(retryTimer);
  if (source) source.close();
  open();
}

function open() {
  if (!kind) return;
  // Bei manuellem Neuaufbau den letzten Stand mitgeben, damit verpasste Ereignisse nachgeliefert werden
  source = new EventSource(lastId ? `${url()}?since=${lastId}` : url());
  source.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    accept(e);
    const wasDown = everConnected;
    everConnected = true;
    setConnected(true);
    // Neue Verbindung ohne Nachlieferung nach einer Unterbrechung ⇒ sicherheitshalber alles neu laden
    if (wasDown && d.resumed === false) resyncAll();
  });
  source.addEventListener('change', (e) => { if (accept(e)) dispatchChange(JSON.parse(e.data).topic); });
  source.addEventListener('notification', (e) => {
    if (!accept(e)) return;
    const d = JSON.parse(e.data);
    notifSubs.forEach((f) => f({ ...d, eventId: Number(e.lastEventId) }));
  });
  source.addEventListener('reset', () => { lastId = 0; resyncAll(); notifSubs.forEach((f) => f({ kind: 'reset' })); });
  source.onopen = () => setConnected(true);
  source.onerror = () => {
    setConnected(false);
    // EventSource verbindet selbst neu; ist die Verbindung endgültig geschlossen (z. B. Proxy/Server-Neustart), bauen wir sie neu auf
    if (source.readyState === EventSource.CLOSED) { clearTimeout(retryTimer); retryTimer = setTimeout(reopen, 2500); }
  };
}

export function disconnect() {
  clearTimeout(retryTimer);
  source?.close();
  source = null; kind = null; lastId = 0; connected = false; everConnected = false;
  for (const s of subs) clearTimeout(s.timer);
  subs.clear(); notifSubs.clear();
  statusSubs.forEach((f) => f(false));
}
