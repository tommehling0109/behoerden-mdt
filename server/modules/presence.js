import { formatMember } from '../core/identity.js';
import { all } from '../core/db.js';
import { getConfig } from '../core/config.js';
import { levelBrief } from '../core/levels.js';
import { publish } from '../core/realtime.js';
import { touchActivity } from './activity.js';

/**
 * Online-Liste: welche Mitglieder haben das Panel gerade geöffnet? Jede geöffnete Seite meldet sich regelmäßig (Herzschlag) und sagt, ob der
 * Sperrbildschirm aktiv ist. „Aktiv“ = mindestens eine Seite entsperrt, „Gesperrt“ = alle offenen Seiten im Sperrbildschirm. Wer keine Seite
 * offen hat (kein Herzschlag), steht nicht in der Liste. Nur im Arbeitsspeicher (nichts wird gespeichert); sichtbar nur für Mitglieder, und
 * nur als Dienstnummer mit Rang – nie mit Namen.
 */
const TTL = 80_000; // Herzschläge alle ~25 s, so lange gilt eine Seite als offen
const tabs = new Map(); // 'u:<Mitglied-ID>' bzw. 'p:<Partner-ID>' → Map(tabId → { locked, at })
let lastSig = '';

const stateOf = (userId, t = Date.now()) => {
  const m = tabs.get(userId); if (!m) return null;
  let any = false, active = false;
  for (const [id, x] of m) { if (t - x.at > TTL) { m.delete(id); continue; } any = true; if (!x.locked) active = true; }
  if (!m.size) { tabs.delete(userId); return null; }
  return any ? (active ? 'active' : 'locked') : null;
};
const snapshot = () => { const t = Date.now(), out = []; for (const id of [...tabs.keys()]) { const s = stateOf(id, t); if (s) out.push([id, s]); } return out.sort((a, b) => String(a[0]).localeCompare(String(b[0]))); };
const announceIfChanged = () => { const sig = JSON.stringify(snapshot()); if (sig !== lastSig) { lastSig = sig; publish({ topic: 'presence', kind: 'changed', staff: 1 }); } };

export function listOnline(viewerId) {
  const snap = new Map(snapshot());
  if (!snap.size) return [];
  const ids = (prefix) => [...snap.keys()].filter((k) => k.startsWith(prefix)).map((k) => Number(k.slice(2)));
  const out = [], uids = ids('u:'), pids = ids('p:');
  if (uids.length) for (const u of all(`SELECT u.id, u.display_name, u.member_number, r.name rank_name, r.color rank_color FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.status = 'active' AND u.id IN (${uids.map(() => '?').join(',')})`, ...uids))
    out.push({ kind: 'member', id: u.id, label: formatMember(u.display_name, u.member_number) || `Mitglied #${u.id}`, rank: u.rank_name ? { name: u.rank_name, color: u.rank_color } : null, state: snap.get(`u:${u.id}`), isMe: u.id === viewerId });
  // Externe Partner: nur die Zugangsnummer (kein Name) und ihr Level – sichtbar nur für Mitglieder (diese Liste gibt es nur mit Mitglieder-Sitzung)
  if (pids.length) for (const p of all(`SELECT id, partner_number FROM partners WHERE status = 'active' AND user_id IS NULL AND id IN (${pids.map(() => '?').join(',')})`, ...pids))
    out.push({ kind: 'partner', id: p.id, label: p.partner_number || `Partner #${p.id}`, rank: null, level: levelBrief(p.id), state: snap.get(`p:${p.id}`), isMe: false });
  return out.sort((a, b) => (a.state === b.state ? 0 : a.state === 'active' ? -1 : 1) || (a.kind === b.kind ? 0 : a.kind === 'member' ? -1 : 1) || a.label.localeCompare(b.label, 'de', { numeric: true }));
}
const beat = (key, tabId, locked) => { const m = tabs.get(key) ?? new Map(); tabs.set(key, m); m.set(tabId, { locked: !!locked, at: Date.now() }); announceIfChanged(); };
const leave = (key, tabId) => { const m = tabs.get(key); if (m) { m.delete(String(tabId ?? '')); if (!m.size) tabs.delete(key); } announceIfChanged(); };
const validTab = (v) => { const t = String(v ?? '').slice(0, 40); return /^[A-Za-z0-9_-]{6,40}$/.test(t) ? t : null; };

export default {
  name: 'presence',
  config: [
    { key: 'presence.enabled', group: 'Online-Liste', label: 'Online-Liste anzeigen', help: 'Zeigt Mitgliedern rechts auf dem Desktop, wer gerade im Panel online ist (nur Dienstnummer und Rang; gesperrte Bildschirme grau). Ausgeschaltet werden auch keine Herzschläge mehr gesendet.', type: 'bool', default: true, public: true },
  ],
  init() {
    // Abgelaufene Seiten bemerken (ohne dass jemand etwas sendet) und die Liste live aktualisieren
    setInterval(() => { try { announceIfChanged(); } catch { /* egal */ } }, 15_000).unref();
  },
  routes(r) {
    r.post('/api/presence', (ctx) => {
      if (!ctx.body.locked) touchActivity(ctx.user.id); // entsperrtes Panel = aktiv (auch wenn die Online-Liste aus ist)
      if (!getConfig('presence.enabled')) return { ok: true };
      const tabId = validTab(ctx.body.tabId); if (!tabId) return { ok: false };
      beat(`u:${ctx.user.id}`, tabId, ctx.body.locked);
      return { ok: true };
    });
    r.post('/api/presence/leave', (ctx) => { leave(`u:${ctx.user.id}`, ctx.body.tabId); return { ok: true }; });
    // Externe Partner melden sich ebenfalls (nur Herzschlag – die Liste sehen ausschließlich Mitglieder)
    r.post('/api/p/presence', { auth: 'partner' }, (ctx) => {
      if (!getConfig('presence.enabled')) return { ok: true };
      const tabId = validTab(ctx.body.tabId); if (!tabId) return { ok: false };
      beat(`p:${ctx.partner.id}`, tabId, ctx.body.locked);
      return { ok: true };
    });
    r.post('/api/p/presence/leave', { auth: 'partner' }, (ctx) => { leave(`p:${ctx.partner.id}`, ctx.body.tabId); return { ok: true }; });
    r.get('/api/presence', (ctx) => ({ enabled: !!getConfig('presence.enabled'), members: getConfig('presence.enabled') ? listOnline(ctx.user.id) : [] }));
  },
};
