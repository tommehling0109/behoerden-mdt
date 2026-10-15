// Benachrichtigungen – gleiche Logik für Mitarbeiter und Partner-Portal, ausschließlich INNERHALB des virtuellen Systems
// (keine Browser-/Betriebssystem-Benachrichtigungen): jedes Ereignis → Glocken-Liste + Zähler + System-Hinweis (Pop-up) + Ton.
import { api } from './api.js';
import { onNotification } from './realtime.js';
import { toast } from './ui/kit.js';

const listeners = new Set();
let base = '/api';
let scope = 'user:0';
let openTarget = () => {};
const data = { list: [], unread: 0 };

export const getNotifications = () => data;
export const onNotifChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((f) => f(data));

// ── Einstellungen (pro Browser/Gerät, bleiben bei Updates erhalten): Ton, Lautstärke, Tonauswahl, Pop-up-Hinweise ──
const SKEY = 'mdt.set.v1';
const DEFAULTS = { sound: true, popup: true, volume: 60, tone: 'chime', icons: 'default' }; // icons: default (wie vom Admin eingestellt) | on | off
export const TONES = [['chime', 'Zweiklang (Standard)'], ['bell', 'Glocke'], ['pop', 'Pop'], ['ding', 'Dreiklang'], ['soft', 'Sanft']];
const readSettings = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch { return { ...DEFAULTS }; } };
export const getSetting = (k) => readSettings()[k];
export function setSetting(k, v) { try { localStorage.setItem(SKEY, JSON.stringify({ ...readSettings(), [k]: v })); } catch { /* egal */ } window.dispatchEvent(new Event('mdt:settings')); }
export const getPref = (k) => !!getSetting(k);
export const setPref = (k, v) => setSetting(k, !!v);

// ── Ton: dezente Klänge (WebAudio, keine Datei nötig) ──
let audio = null;
function unlockAudio() {
  try { audio ??= new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch { /* kein Audio */ }
}
// [Frequenz, Start, Dauer, Wellenform]
const NOTES = {
  chime: [[880, 0, 0.28, 'sine'], [1318.5, 0.11, 0.28, 'sine']],
  bell: [[1046.5, 0, 0.9, 'triangle'], [2093, 0, 0.5, 'sine']],
  pop: [[640, 0, 0.12, 'sine'], [420, 0.05, 0.14, 'sine']],
  ding: [[784, 0, 0.22, 'sine'], [988, 0.12, 0.22, 'sine'], [1318.5, 0.24, 0.34, 'sine']],
  soft: [[523.25, 0, 0.7, 'sine'], [659.25, 0.1, 0.7, 'sine']],
  // Neuigkeiten (Changelog / Schwarzes Brett): aufsteigende Fanfare, bewusst anders als alle Nachrichtentöne
  announce: [[659.25, 0, 0.2, 'triangle'], [783.99, 0.17, 0.2, 'triangle'], [1046.5, 0.34, 0.3, 'triangle'], [1318.5, 0.56, 0.7, 'sine']],
};
/** Ton für das Pflicht-Fenster mit Neuigkeiten (folgt „Ton bei neuer Benachrichtigung“ und der Lautstärke, nutzt aber einen eigenen Klang). */
export const playAnnounce = (force = false) => playSound(force, { tone: 'announce' });
/** force: auch bei ausgeschaltetem Ton (Vorhören). Optional eigene Töne/Lautstärke zum Vorhören. */
export function playSound(force = false, { tone, volume } = {}) {
  if (!force && !getSetting('sound')) return;
  try {
    unlockAudio();
    if (!audio || audio.state !== 'running') return;
    const vol = Math.max(0, Math.min(100, Number(volume ?? getSetting('volume'))));
    if (vol === 0) return;
    const peak = 0.12 * (vol / 100) ** 1.5;
    const t = audio.currentTime;
    (NOTES[tone ?? getSetting('tone')] ?? NOTES.chime).forEach(([f, d, len, wave]) => {
      const o = audio.createOscillator(); const g = audio.createGain();
      o.type = wave; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(peak, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + len);
      o.connect(g); g.connect(audio.destination); o.start(t + d); o.stop(t + d + len + 0.02);
    });
  } catch { /* egal */ }
}

/** Pro Ereignis spielt nur EIN Tab den Ton (sonst mehrfach) – Ereignis-ID wird per localStorage „beansprucht“. */
function claim(eventId) {
  const key = `mdt:claim:${scope}`;
  try {
    const cur = Number(localStorage.getItem(key) || 0);
    if (cur >= eventId) return false;
    localStorage.setItem(key, String(eventId));
    return true;
  } catch { return true; }
}

async function refresh() {
  try {
    const r = await api.get(`${base}/notifications`);
    data.list = r.notifications; data.unread = r.unread; emit();
  } catch { /* offline */ }
}

export async function markRead(ids) {
  try { await api.post(`${base}/notifications/read`, ids ? { ids } : {}); } catch { /* egal */ }
}

/** Benachrichtigungen löschen (ids = Auswahl, ohne = alle). */
export async function removeNotifs(ids) {
  const all = !ids;
  data.list = all ? [] : data.list.filter((n) => !ids.includes(n.id));
  data.unread = data.list.filter((n) => !n.read).length; emit();
  try { await api.post(`${base}/notifications/delete`, all ? {} : { ids }); } catch { refresh(); }
}

function handle(ev) {
  if (ev.kind === 'reset' || ev.kind === 'read') return refresh();
  if (ev.kind !== 'new') return;
  // 1) Liste + Zähler
  if (!data.list.some((x) => x.id === ev.id)) {
    data.list = [{ id: ev.id, key: ev.key, title: ev.title, body: ev.body, target: ev.target, createdAt: ev.createdAt, read: false }, ...data.list].slice(0, 60);
    data.unread += 1;
    emit();
  }
  // 2) System-Hinweis (Pop-up oben rechts im virtuellen Desktop) – Klick öffnet den Datensatz
  if (getSetting('popup')) toast(ev.body, 'info', { title: ev.title, onClick: () => { markRead([ev.id]); openTarget(ev.target); }, duration: 7000 });
  // 3) Ton
  if (claim(ev.eventId)) playSound();
}

/** kind: 'staff' | 'partner'; open(target) öffnet den betroffenen Datensatz. */
export function initNotifier({ kind, id, open }) {
  base = kind === 'partner' ? '/api/p' : '/api';
  scope = `${kind}:${id ?? 0}`;
  openTarget = open ?? (() => {});
  data.list = []; data.unread = 0;
  onNotification(handle);
  refresh();
  // Der Ton braucht eine Nutzergeste → bei der ersten Interaktion freischalten
  const once = () => { document.removeEventListener('pointerdown', once); unlockAudio(); };
  document.addEventListener('pointerdown', once);
}
export const reloadNotifications = refresh;
