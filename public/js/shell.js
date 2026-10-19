import { everySecond, timeParts, dateLong } from './clock.js';
import { partnerScope, unseenCount } from './seen.js';
import { h, mount, timeAgo } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { avatar, userAvatar, skeletons, empty, toast, button, toggle, levelBadge } from './ui/kit.js';
import { state, canAny, can, applyConfig } from './state.js';
import { NAV, allItems, defaultDockLayout, resolveDock } from './modules.js';
import { openAccountDialog } from './views/account.js';
import { openSettingsDialog } from './views/settings.js';
import { openLevelDialog } from './views/partner/level.js';
import { createBoard } from './board.js';
import { createChangelog } from './changelog.js';
import { checkUpdatesAck } from './updates-ack.js';
import { createProblems } from './problems.js';
import { createOnline, startPresence } from './presence.js';
import { createTicker } from './ticker.js';
import { maybeStartTour, helpIds } from './tour.js';
import { api } from './api.js';
import { connect, disconnect, subscribe, onStatus } from './realtime.js';
import { initLock, clearLockState } from './lockscreen.js';
import { initNotifier, getNotifications, onNotifChange, markRead, removeNotifs, getPref, setPref, getSetting } from './notifier.js';

const screen = () => document.getElementById('screen');
const compact = () => window.matchMedia('(max-width: 700px)').matches;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

export const brandMark = () => h('div', { class: 'brand-mark' }, h('div', { class: 'logo-phoenix' }));
export function brandBlock() {
  return h('div', { class: 'brand' }, brandMark(),
    h('div', { class: 'brand-text' },
      h('div', { class: 'brand-name' }, state.config['system.name'] || 'MDT'),
      h('div', { class: 'brand-sub' }, state.config['system.subtitle'] || '')));
}

/** Ruft `fn` jetzt und dann periodisch auf, solange `el` im DOM hängt. */
function liveUpdate(el, fn, ms = 10_000) {
  fn();
  const iv = setInterval(() => { if (!el.isConnected) clearInterval(iv); else fn(); }, ms);
}

// ── Fenster-Verwaltung ────────────────────────────────
const wins = new Map();
let ui = null;
let areaObserver = null;

function closeAllWindows() {
  for (const w of wins.values()) { w.cleanup?.(); w.offs?.forEach((f) => f()); }
  disconnect(); // Live-Verbindung und alle Abonnements beenden
  wins.clear();
  areaObserver?.disconnect();
  areaObserver = null;
  ui = null;
}

/** Bildschirme ohne Desktop (Anmeldung, Einrichtung, Wartend). */
export function showLock(content) {
  closeAllWindows();
  const lcTime = h('div', { class: 'lc-time' }), lcDate = h('div', { class: 'lc-date' });
  const clock = h('div', { class: 'lock-clock' }, lcTime, lcDate);
  everySecond(clock, () => { const t = timeParts(); lcTime.textContent = `${t.hm}:${t.s}`; lcDate.textContent = dateLong(); });
  mount(screen(), h('div', { class: 'wallpaper' }), h('div', { class: 'lock' }, content), clock);
}

/** Öffnet (oder fokussiert) ein Modul-Fenster – auch aus Ansichten heraus nutzbar. */
export const openApp = (id) => ui?.open(id);

/** Öffnet das Ziel einer Benachrichtigung (z. B. ein Geschäft) – gleiche Logik für Panel und Partner-Portal. */
export async function openTarget(target) {
  if (!target || !ui) return;
  window.focus?.();
  if (target.app === 'level') return openLevelDialog(); // Partner: Level-Fenster
  if (target.app === 'chat' && target.channelId) { try { sessionStorage.setItem('mdt:chat:channel', String(target.channelId)); } catch { /* egal */ } }
  if (target.app === 'tab' && target.statementId) { try { sessionStorage.setItem('mdt:tab:open', String(target.statementId)); } catch { /* egal */ } }
  if (target.partnerTicket) { const m = await import('./views/tickets.js'); return m.openPartnerTickets({ open: target.partnerTicket }); }
  if (target.app === 'tickets' && target.ticketId) { try { sessionStorage.setItem('mdt:tickets:open', String(target.ticketId)); } catch { /* egal */ } }
  if (target.app === 'credit' && target.loanId) { try { sessionStorage.setItem('mdt:credit:open', String(target.loanId)); } catch { /* egal */ } }
  if (target.app === 'schedule' && (target.eventId || target.taskId)) { try { sessionStorage.setItem('mdt:schedule:open', JSON.stringify({ eventId: target.eventId, taskId: target.taskId })); } catch { /* egal */ } }
  if (target.app) ui.open(target.app);
  if (target.app === 'schedule' && (target.eventId || target.taskId)) window.dispatchEvent(new Event('mdt:schedule-open'));
  if (target.app === 'credit' && target.loanId) window.dispatchEvent(new Event('mdt:credit-open'));
  if (target.app === 'tab' && target.statementId) window.dispatchEvent(new Event('mdt:tab-open'));
  if (target.app === 'tickets' && target.ticketId) window.dispatchEvent(new Event('mdt:tickets-open'));
  if (target.app === 'chat' && target.channelId) window.dispatchEvent(new Event('mdt:chat-open'));
  if (target.app === 'trade' && target.dealId) { // Mitglied als Handelspartner: Geschäft über die Partner-Schnittstelle öffnen
    const { openDealModal } = await import('./views/market-shared.js');
    openDealModal({ side: 'partner', base: '/api/p/market', id: target.dealId });
  }
  if (target.app === 'market' && target.dealId) {
    const { openDealModal } = await import('./views/market-shared.js');
    openDealModal({ side: partnerMode ? 'partner' : 'staff', base: partnerMode ? '/api/p/market' : '/api/market', id: target.dealId });
  }
}

const counters = { scheduleOpen: 0, pendingUsers: 0, marketAwaiting: 0, chatUnread: 0, marketNew: 0, creditAwaiting: 0, creditNew: 0 };
let baseTitle = null;
let partnerMode = false;
async function refreshCounters() {
  if (partnerMode) {
    try { counters.marketNew = unseenCount(partnerScope(), (await api.get('/api/p/market/deals')).deals); } catch { /* App nicht freigeschaltet */ }
    try { counters.chatUnread = (await api.get('/api/p/chat/unread')).unread ?? 0; } catch { /* App nicht freigeschaltet */ }
    try { counters.creditNew = unseenCount(`${partnerScope()}:credit`, (await api.get('/api/p/credit/loans')).loans.map((l) => ({ id: l.id, updatedAt: l.updatedAt, status: l.status, statusLabel: l.statusLabel }))); } catch { /* App nicht freigeschaltet */ }
    // Tab-Titel: ungesehene Änderungen auf einen Blick
    baseTitle ??= document.title.replace(/^\(\d+\)\s*/, '');
    const n = counters.marketNew + counters.chatUnread + counters.creditNew;
    document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
    return;
  }
  if (can('users.approve') || can('users.view')) {
    try { counters.pendingUsers = (await api.get('/api/users?status=pending')).counts.pending ?? 0; } catch { /* ignorieren */ }
  }
  if (can('schedule.view')) {
    try { counters.scheduleOpen = (await api.get('/api/schedule/summary')).openTasks ?? 0; } catch { /* ignorieren */ }
  }
  if (can('chat.view')) {
    try { counters.chatUnread = (await api.get('/api/chat/unread')).unread ?? 0; } catch { /* ignorieren */ }
  }
  if (can('credit.view')) {
    try { counters.creditAwaiting = (await api.get('/api/credit/summary')).summary.awaitingStaff ?? 0; } catch { /* ignorieren */ }
  }
  if (can('market.view')) {
    try { counters.marketAwaiting = (await api.get('/api/market/summary')).awaitingStaff ?? 0; } catch { /* ignorieren */ }
  }
}

/**
 * Desktop-Oberfläche. opts: { nav, allow(item), footerRole, partner } – für Mitarbeiter Standard, für externe Partner angepasst.
 */
export function showApp(onLogout, opts = {}) {
  closeAllWindows();
  partnerMode = !!opts.partner;
  const nav = opts.nav ?? NAV;
  const appOff = (i) => (state.config['system.disabled_apps'] ?? []).includes(i.id); // vom Administrator für alle deaktiviert
  const allowed = opts.allow ?? ((i) => (!i.perm || canAny(i.perm)) && !appOff(i) && (!i.cfg || !!state.config[i.cfg]));
  let z = 10;
  let activeId = null;
  let opened = 0;

  const visibleSections = () => nav.map((s) => ({ ...s, items: s.items.filter(allowed) })).filter((s) => s.items.length);
  const findItem = (id) => allItems(nav).find((i) => i.id === id);

  const area = h('div', { class: 'desktop-area' });
  const iconsEl = h('div', { class: 'desktop-icons' });
  const dock = h('div', { class: 'dock', role: 'toolbar', 'aria-label': 'Apps' });
  const dockPop = h('div', { class: 'dock-pop', role: 'menu', hidden: true }); // Auswahl einer Dock-Gruppe (Ordner)
  let openGroup = null;
  const startMenu = h('div', { class: 'start-menu', hidden: true });
  const startBtn = h('button', { class: 'panel-btn start-btn', type: 'button', title: 'Menü', 'aria-label': 'App-Menü', 'aria-haspopup': 'true' }, h('div', { class: 'logo-phoenix' }));
  let panelAvatar = null, levelSlot = null;
  // Partner: eigenes Level in der Kopfleiste aktuell halten (XP-Vergabe, Aktivierung, Anpassung durch das Team)
  const refreshLevel = async () => { if (!levelSlot) return; try { const me = await api.get('/api/p/me'); state.user.level = me.partner.level ?? null; mount(levelSlot, levelBadge(state.user.level)); drawGreet(); } catch { /* egal */ } };
  const clock = h('span', { class: 'panel-clock' });
  everySecond(clock, () => { const t = timeParts(); clock.textContent = `${t.hm}:${t.s}`; });

  // Gruß unten links: „Hallo, Name“ mit Rang, Abteilung und Rollen (Partner: Hallo + Level)
  const greet = h('div', { class: 'desk-greet', 'aria-hidden': 'true' });
  const drawGreet = () => {
    const u = state.user ?? {};
    if (opts.partner) mount(greet, h('div', { class: 'dg-hello' }, 'Hallo'), u.level ? h('div', { class: 'dg-line' }, levelBadge(u.level), ` ${u.level.name}`) : h('div', { class: 'dg-line dg-dim' }, u.displayName ?? ''));
    else {
      const ro = (u.roles ?? []).map((r) => r.name);
      mount(greet, h('div', { class: 'dg-hello' }, `Hallo, ${u.displayName ?? ''}`),
        (u.rank || u.department) && h('div', { class: 'dg-line' }, [u.rank && h('span', { style: { color: u.rank.color ?? 'inherit', fontWeight: 600 } }, u.rank.name), u.rank && u.department && h('span', { style: { opacity: 0.6 } }, ' · '), u.department && h('span', { style: { color: u.department.color ?? 'inherit', fontWeight: 600 } }, u.department.name)]),
        ro.length > 0 && h('div', { class: 'dg-line dg-dim' }, `${ro.length === 1 ? 'Rolle' : 'Rollen'}: ${ro.slice(0, 3).join(', ')}${ro.length > 3 ? ` +${ro.length - 3}` : ''}`));
    }
    fitGreet();
  };
  const fitGreet = () => { const room = Math.floor((window.innerWidth - (document.querySelector('.dock')?.offsetWidth ?? 0)) / 2) - 36; greet.style.maxWidth = `${Math.min(320, Math.max(0, room))}px`; greet.hidden = room < 130 || !greet.childNodes.length; };
  const widget = h('div', { class: 'desk-widget', 'aria-hidden': 'true' });
  const dwHm = h('span', null), dwS = h('span', { class: 'dw-sec' }), dwDate = h('div', { class: 'dw-date' }), dwName = h('div', { class: 'dw-name' });
  mount(widget, h('div', { class: 'dw-time' }, dwHm, dwS), dwDate, dwName, h('div', { class: 'dw-note' }, 'Fiktives System – nur für den Unity Life Roleplay Server'));
  everySecond(widget, () => { const t = timeParts(); dwHm.textContent = t.hm; dwS.textContent = `:${t.s}`; dwDate.textContent = dateLong(); dwName.textContent = state.config['system.name'] || 'MDT'; });

  // ── Live-Status + Benachrichtigungen (Glocke) ──
  const pulse = h('span', { class: 'pulse' });
  const liveDot = h('span', { class: 'panel-btn', title: 'Live verbunden' }, pulse);
  onStatus((v) => { pulse.classList.toggle('off', !v); liveDot.title = v ? 'Live verbunden – Änderungen erscheinen sofort' : 'Verbindung unterbrochen – verbinde automatisch neu …'; });
  let lockCtl = null;
  const reportBtn = h('button', { class: 'panel-btn', type: 'button', title: opts.partner ? 'Fehler melden / Meine Tickets' : 'Fehler melden / Ticket eröffnen', 'aria-label': 'Fehler melden', onclick: () => import('./views/tickets.js').then((m) => (opts.partner ? m.openPartnerTickets() : m.openReportDialog({ app: document.querySelector('.win.active .wt')?.textContent ?? '' }))) }, icon('bug'));
  const helpOn = () => { const it = findItem('help'); return !!it && allowed(it); };
  const helpBtn = h('button', { class: 'panel-btn', type: 'button', hidden: !helpOn(), title: 'Hilfe & Anleitung', 'aria-label': 'Hilfe', onclick: () => openHelp() }, icon('help'));
  const lockBtn = h('button', { class: 'panel-btn', type: 'button', title: 'Bildschirm sperren', 'aria-label': 'Bildschirm sperren', onclick: () => lockCtl?.lock() }, icon('lockClosed'));
  const settingsBtn = h('button', { class: 'panel-btn', type: 'button', title: 'Einstellungen (Ton, Lautstärke, Hinweise)', 'aria-label': 'Einstellungen', onclick: () => openSettingsDialog() }, icon('settings'));
  const iconResetBtn = h('button', { class: 'panel-btn', type: 'button', hidden: true, title: 'Desktop-Symbole zurücksetzen (eigene Positionen verwerfen)', 'aria-label': 'Desktop-Symbole zurücksetzen', onclick: () => resetIcons() }, icon('refresh'));
  const bellBadge = h('span', { class: 'bell-badge', hidden: true });
  const bell = h('button', { class: 'panel-btn', type: 'button', title: 'Benachrichtigungen', 'aria-label': 'Benachrichtigungen', 'aria-haspopup': 'true' }, icon('bell'), bellBadge);
  const npanel = h('div', { class: 'notif-panel', hidden: true, role: 'dialog', 'aria-label': 'Benachrichtigungen' });
  const closeNotif = () => { npanel.hidden = true; bell.classList.remove('open'); };
  function drawBell() {
    const { list, unread } = getNotifications();
    bellBadge.hidden = unread === 0;
    bellBadge.textContent = unread > 99 ? '99+' : String(unread);
    if (npanel.hidden) return;
    const soundT = toggle('Ton bei neuer Benachrichtigung', getPref('sound'), (v) => setPref('sound', v));
    const popT = toggle('Hinweise als Pop-up im System', getPref('popup'), (v) => setPref('popup', v));
    mount(npanel,
      h('div', { class: 'np-head' }, h('h3', null, 'Benachrichtigungen', unread > 0 && h('span', { class: 'count hot', style: { marginLeft: '8px' } }, unread)),
        h('span', { class: 'np-head-btns' }, button('Alle gelesen', { size: 'sm', variant: 'ghost', disabled: unread === 0, onClick: () => markRead(null) }), button('Alle löschen', { size: 'sm', variant: 'ghost', icon: 'trash', disabled: !list.length, onClick: () => removeNotifs() }))),
      h('div', { class: 'np-list' }, list.length ? list.map((n) => h('div', { class: `np-item ${n.read ? '' : 'unread'}`, role: 'button', tabindex: 0,
        onclick: () => { markRead([n.id]); closeNotif(); openTarget(n.target); } },
      h('span', { class: 'np-dot' }), h('div', { style: { minWidth: 0, flex: 1 } }, h('div', { class: 'np-t' }, n.title), n.body && h('div', { class: 'np-b' }, n.body), h('div', { class: 'np-time' }, timeAgo(n.createdAt))),
      h('button', { class: 'np-x', type: 'button', title: 'Benachrichtigung löschen', 'aria-label': 'Benachrichtigung löschen', onclick: (e) => { e.stopPropagation(); removeNotifs([n.id]); } }, icon('x'))))
        : h('div', { class: 'np-empty' }, 'Noch keine Benachrichtigungen.')),
      h('div', { class: 'np-foot' }, popT, soundT, button('Weitere Einstellungen …', { size: 'sm', variant: 'ghost', icon: 'settings', onClick: () => { closeNotif(); openSettingsDialog(); } })));
  }
  bell.addEventListener('click', (e) => { e.stopPropagation(); if (!npanel.hidden) return closeNotif(); startMenu.hidden = true; startBtn.classList.remove('open'); npanel.hidden = false; bell.classList.add('open'); drawBell(); });
  document.addEventListener('pointerdown', (e) => { if (!npanel.hidden && !npanel.contains(e.target) && !bell.contains(e.target)) closeNotif(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !npanel.hidden) closeNotif(); });
  onNotifChange(drawBell);

  const panel = h('div', { class: 'panel' },
    h('div', { class: 'panel-left' }, startBtn),
    h('div', { class: 'panel-center' }, clock),
    h('div', { class: 'panel-right' },
      liveDot, bell, helpBtn, reportBtn, iconResetBtn, settingsBtn, lockBtn,
      h('button', { class: 'panel-btn panel-user', type: 'button', title: opts.partner ? state.user.displayName : 'Konto & Sicherheit', onclick: opts.partner ? () => openLevelDialog() : () => openAccountDialog() },
        opts.partner ? icon('users') : (panelAvatar = userAvatar(state.user, 'sm')), h('span', null, state.user.displayName), opts.partner && (levelSlot = h('span', { class: 'panel-level' }, levelBadge(state.user.level)))),
      h('button', { class: 'panel-btn', type: 'button', title: 'Abmelden', 'aria-label': 'Abmelden', onclick: () => { clearLockState(); lockCtl?.destroy(); onLogout(); } }, icon('logout'))));
  const ticker = createTicker({ partner: !!opts.partner }); // Laufband zwischen Kopfleiste und Desktop
  const desktop = h('div', { class: 'desktop' }, panel, ticker.el, area, h('div', { class: 'dock-row' }, dockPop, dock));
  const board = !opts.partner && can('board.view') ? createBoard() : null; // Schwarzes Brett: nur für Mitarbeiter
  mount(screen(), h('div', { class: 'wallpaper' }), widget, greet, desktop, startMenu, npanel);
  drawGreet(); window.addEventListener('resize', fitGreet); if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitGreet).observe(dock);
  const changelog = !opts.partner && can('changelog.view') ? createChangelog() : null; // Changelog links, nur für Mitarbeiter
  if (changelog) area.append(changelog.el);
  // Rechte Spalte: Schwarzes Brett, darunter die Problemleiste (nur Mitarbeiter; erscheint nur bei Problemen)
  const problems = opts.partner ? null : createProblems({ onOpen: (t) => openTarget(t) });
  const online = opts.partner ? null : createOnline(); // Online-Liste: wer ist gerade im Panel (nur Mitarbeiter)
  if (board || problems || online) { const rightCol = h('div', { class: 'right-col' }, board?.el, problems?.el, online?.el); area.append(rightCol); } // im Desktop-Bereich: Fenster liegen darüber, die Fensterleisten bleiben bedienbar
  // Desktop-Symbole: Voreinstellung des Administrators, jeder Benutzer kann sie in seinen Einstellungen für sich an-/ausschalten
  const iconsWanted = () => { const u = getSetting('icons'); if (u === 'on') return true; if (u === 'off') return false; const pc = opts.partner ? state.config['ui.desktop_icons_partner'] : null; return pc === 'on' ? true : pc === 'off' ? false : !!state.config['ui.desktop_icons']; };
  const syncIcons = () => { const want = iconsWanted(); if (want && !iconsEl.isConnected) { area.append(iconsEl); renderIcons(); } else if (!want && iconsEl.isConnected) iconsEl.remove(); iconResetBtn.hidden = !iconsEl.isConnected || compact(); };
  if (iconsWanted()) area.append(iconsEl);
  iconResetBtn.hidden = !iconsEl.isConnected || compact();
  // Zurücksetzen: alle selbst verschobenen Symbole kehren auf ihre automatischen Plätze zurück
  function resetIcons() { try { localStorage.removeItem(POS_KEY); } catch { /* egal */ } renderIcons(); toast('Desktop-Symbole zurückgesetzt.'); }

  // ── Desktop-Icons (frei verschiebbar, Position wird pro Benutzer im Browser gemerkt) ──
  const POS_KEY = `mdt.iconpos.v1.${state.user?.id ?? 0}`;
  const loadPos = () => { try { return JSON.parse(localStorage.getItem(POS_KEY)) || {}; } catch { return {}; } };
  const savePos = (p) => { try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* egal */ } };
  const GRID = { w: 96, h: 102, pad: 10 };
  const dockH = () => document.querySelector('.dock-row')?.offsetHeight ?? 0; // der Desktop reicht bis zum unteren Rand; Symbole bleiben oberhalb der Leiste
  // Anordnung der Symbole: selbst platzierte bleiben stehen – es sei denn, eine aufgeklappte Tafel (Schwarzes Brett/Changelog) läge darüber, dann
  // werden sie nur für die Anzeige auf den nächsten freien Platz geschoben (die gemerkte Position bleibt, klappt die Tafel zu, sind sie wieder dort).
  // Symbole ohne eigene Position füllen die übrigen freien Plätze – nie unter Tafeln und nie auf anderen Symbolen.
  const panelRects = () => { const a = area.getBoundingClientRect(); return [board?.el, changelog?.el, problems?.el, online?.el].filter((e) => e && !e.hidden && e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return { l: r.left - a.left - 8, t: r.top - a.top - 8, r: r.right - a.left + 8, b: r.bottom - a.top + 8 }; }); };
  const iconBox = (x, y) => ({ l: x - 2, t: y - 2, r: x + 94, b: y + 96 });
  const overlap = (p, q) => p.l < q.r && p.r > q.l && p.t < q.b && p.b > q.t;
  function layoutIcons(items, pos) {
    const rects = panelRects(), out = {}, used = [];
    const rows = Math.max(1, Math.floor((area.clientHeight - dockH() - 24) / GRID.h) || 1), cols = Math.max(1, Math.floor((area.clientWidth - GRID.pad) / GRID.w)), cells = [];
    for (let col = 0; col < cols; col++) for (let row = 0; row < rows; row++) cells.push({ x: GRID.pad + col * GRID.w, y: 12 + row * GRID.h });
    const free = (c) => { const b = iconBox(c.x, c.y); return !rects.some((q) => overlap(b, q)) && !used.some((u) => overlap(b, u)); };
    for (const it of items) { const p = pos[it.id]; if (p && !rects.some((q) => overlap(iconBox(p.x, p.y), q))) { out[it.id] = p; used.push(iconBox(p.x, p.y)); } } // 1) selbst platziert, frei
    for (const it of items) { // 2) selbst platziert, aber unter einer Tafel → nächster freier Platz
      const p = pos[it.id]; if (!p || out[it.id]) continue;
      const best = cells.filter(free).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0] ?? p;
      out[it.id] = best; used.push(iconBox(best.x, best.y));
    }
    for (const it of items) { if (pos[it.id]) continue; const c = cells.find(free) ?? { x: GRID.pad, y: 12 }; out[it.id] = c; used.push(iconBox(c.x, c.y)); } // 3) ohne eigene Position
    return out;
  }
  function placeIcon(b, p) {
    b.style.left = `${p.x}px`; b.style.top = `${p.y}px`;
  }
  let iconDrag = false, iconPending = false;
  function enableDrag(b, id) {
    b.addEventListener('pointerdown', (e) => {
      if (compact() || e.button !== 0) return;
      const sx = e.clientX, sy = e.clientY, ox = b.offsetLeft, oy = b.offsetTop; let moved = false, raf = 0, tx = 0, ty = 0;
      try { b.setPointerCapture(e.pointerId); } catch { /* egal */ } // sofort einfangen: auch schnelle Wischbewegungen verlieren das Symbol nicht
      const mv = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        if (!moved) { moved = true; iconDrag = true; b.classList.add('dragging'); }
        const maxX = iconsEl.clientWidth - b.offsetWidth, maxY = iconsEl.clientHeight - dockH() - b.offsetHeight;
        tx = Math.max(0, Math.min(maxX, ox + dx)) - ox; ty = Math.max(0, Math.min(maxY, oy + dy)) - oy; // per Transform bewegt, am Ende festgeschrieben
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; b.style.transform = `translate3d(${tx}px, ${ty}px, 0)`; });
      };
      const up = () => {
        b.removeEventListener('pointermove', mv); b.removeEventListener('pointerup', up); b.removeEventListener('pointercancel', up);
        if (!moved) return;
        if (raf) cancelAnimationFrame(raf);
        b._dragged = true; setTimeout(() => { b._dragged = false; }, 0);
        const snap = (v) => Math.round(v / 8) * 8;
        const x = snap(ox + tx), y = snap(oy + ty);
        // ohne Übergang an die Zielstelle setzen (Transform → left/top), danach die Animation wieder erlauben
        b.style.transition = 'none'; b.style.transform = ''; b.style.left = `${x}px`; b.style.top = `${y}px`; b.classList.remove('dragging'); void b.offsetWidth; b.style.transition = '';
        const pos = loadPos(); pos[id] = { x, y }; savePos(pos);
        iconDrag = false; if (iconPending) { iconPending = false; renderIcons(); } else relayoutIcons();
      };
      b.addEventListener('pointermove', mv); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    });
  }
  /** Ordnet vorhandene Symbole neu (sanft, ohne Neuaufbau) – z. B. wenn eine Tafel auf- oder zuklappt oder ein Symbol verschoben wurde. */
  function relayoutIcons() {
    if (iconDrag) { iconPending = true; return; }
    const items = visibleSections().flatMap((s) => s.items);
    if (compact() || iconsEl.children.length !== items.length) return renderIcons();
    const lay = layoutIcons(items, loadPos());
    for (const b of iconsEl.children) { const p = lay[b.dataset.id]; if (p) placeIcon(b, p); else return renderIcons(); }
  }
  function renderIcons() {
    if (iconDrag) { iconPending = true; return; } // nie mitten im Ziehen neu aufbauen (das Symbol unter dem Zeiger würde ersetzt)
    iconsEl.classList.toggle('free', !compact());
    const pos = loadPos();
    const items = visibleSections().flatMap((s) => s.items), lay = compact() ? {} : layoutIcons(items, pos);
    mount(iconsEl, items.map((i) => {
      const n = i.badge ? counters[i.badge] : 0;
      const b = h('button', { class: 'desk-icon', type: 'button', 'data-id': i.id, title: i.subtitle ?? i.label },
        h('div', { class: 'di-img' }, icon(i.icon), n > 0 && h('span', { class: 'badge-dot' }, n)), h('span', { class: 'di-label' }, i.label));
      if (!compact()) { placeIcon(b, lay[i.id]); enableDrag(b, i.id); }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (b._dragged) return;
        if (compact() || e.detail !== 1) { open(i.id); return; }
        iconsEl.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
      });
      return b;
    }));
    renderTasks();
  }
  area.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('.desk-icon')) iconsEl.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel')); });
  // Auf- und Zuklappen der Tafeln (und Inhaltsänderungen) ordnen die Symbole ohne eigene Position neu an
  if (typeof ResizeObserver !== 'undefined') { let t; const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => { if (iconsEl.isConnected) relayoutIcons(); }, 80); }); [board?.el, changelog?.el, problems?.el, online?.el, area].forEach((e) => e && ro.observe(e)); }
  window.addEventListener('mdt:settings', syncIcons);
  window.addEventListener('mdt:config-applied', () => { // Apps wurden (de)aktiviert: offene Fenster schließen, Dock, Startmenü und Symbole aktualisieren
    helpBtn.hidden = !helpOn();
    if (opts.partner) return syncIcons();
    for (const id of [...wins.keys()]) { const it = findItem(id); if (it && !allowed(it)) close(id); }
    renderTasks(); if (!startMenu.hidden) renderStart(); syncIcons(); if (iconsEl.isConnected) renderIcons();
  });

  // ── Startmenü ──
  const closeStart = () => { startMenu.hidden = true; startBtn.classList.remove('open'); };
  function renderStart() {
    const u = state.user;
    mount(startMenu,
      h('div', { class: 'start-head' }, brandBlock()),
      h('div', { class: 'start-list' }, visibleSections().map((s) => [
        h('div', { class: 'start-section' }, s.section),
        s.items.map((i) => {
          const n = i.badge ? counters[i.badge] : 0;
          const b = h('button', { class: 'start-item', type: 'button' },
            h('div', { class: 'si-img' }, icon(i.icon)), h('div', null, h('div', null, i.label), h('div', { class: 'si-sub' }, i.subtitle)), n > 0 && h('span', { class: 'nav-badge' }, n));
          b.addEventListener('click', () => { closeStart(); open(i.id); });
          return b;
        }),
      ])),
      h('div', { class: 'start-foot' }, avatar(u.displayName),
        h('div', { class: 'uc-text' }, h('div', { class: 'uc-name' }, u.displayName), h('div', { class: 'uc-role' }, opts.footerRole ?? ([u.memberNumber, u.rank?.name].filter(Boolean).join(' · ') || u.roles.map((r) => r.name).join(', ') || 'Keine Rolle'))),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Einstellungen', onclick: () => { closeStart(); openSettingsDialog(); } }, icon('bell')),
        !opts.partner && h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Konto & Sicherheit', onclick: () => { closeStart(); openAccountDialog(); } }, icon('settings')),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Bildschirm sperren', onclick: () => { closeStart(); lockCtl?.lock(); } }, icon('lockClosed')),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { closeStart(); clearLockState(); lockCtl?.destroy(); onLogout(); } }, icon('logout'), 'Abmelden')));
  }
  startBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!startMenu.hidden) return closeStart();
    renderStart(); startMenu.hidden = false; startBtn.classList.add('open');
  });
  document.addEventListener('pointerdown', (e) => { if (!startMenu.hidden && !startMenu.contains(e.target) && !startBtn.contains(e.target)) closeStart(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !startMenu.hidden) closeStart(); });

  // ── Dock ──
  /** Einträge im Dock: einzelne Apps oder Gruppen („Ordner“) in der vom Administrator eingestellten Reihenfolge; eine Gruppe mit nur einer sichtbaren App zeigt direkt diese App. */
  function dockEntries() {
    const vis = visibleSections().flatMap((sec) => sec.items);
    if (opts.partner) return vis.map((app) => ({ app }));
    const saved = state.config['ui.dock_layout']; // vom Administrator eingestellt (Konfiguration → Dock) – sonst Standard
    return resolveDock(Array.isArray(saved) && saved.length ? saved : defaultDockLayout(), vis);
  }
  const badgeOf = (i) => (i.badge ? counters[i.badge] : 0);
  /** Klick auf eine App im Dock: öffnen, zurückholen, in den Vordergrund oder minimieren. */
  function activate(id) {
    const w = wins.get(id);
    if (!w) open(id);
    else if (w.min) { restore(id); focus(id); }
    else if (activeId === id) minimize(id);
    else focus(id);
  }
  function closePop() { if (openGroup === null) return; openGroup = null; dockPop.hidden = true; dock.querySelector('.dock-folder.open')?.classList.remove('open'); }
  function drawPop() {
    const e = openGroup && dockEntries().find((x) => x.group?.id === openGroup), btn = e && dock.querySelector(`[data-group="${openGroup}"]`);
    if (!e || !btn) return closePop();
    mount(dockPop, h('div', { class: 'dp-title' }, e.group.label), h('div', { class: 'dp-grid' }, e.items.map((i) => {
      const w = wins.get(i.id), n = badgeOf(i);
      const b = h('button', { class: ['dp-item', w && 'running', w && !w.min && activeId === i.id && 'active', w?.min && 'minimized'].filter(Boolean).join(' '), type: 'button', role: 'menuitem', title: i.label },
        h('div', { class: 'dock-img' }, icon(i.icon)), h('span', { class: 'dp-l' }, i.label), n > 0 && h('span', { class: 'badge-dot' }, n));
      b.addEventListener('click', () => { const was = wins.has(i.id) && !wins.get(i.id).min && activeId === i.id; closePop(); if (was) focus(i.id); else activate(i.id); }); // aus der Auswahl heraus nie „minimieren“
      return b;
    })));
    btn.classList.add('open'); dockPop.hidden = false;
    const row = dockPop.parentElement.getBoundingClientRect(), r = btn.getBoundingClientRect(), half = dockPop.offsetWidth / 2;
    dockPop.style.left = `${Math.max(half + 8, Math.min(row.width - half - 8, r.left + r.width / 2 - row.left))}px`;
  }
  document.addEventListener('pointerdown', (e) => { if (openGroup !== null && !dockPop.contains(e.target) && !e.target.closest?.('.dock-folder')) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openGroup !== null) closePop(); });

  function renderTasks() {
    mount(dock, dockEntries().map((e) => {
      if (e.group) { // Ordner: zeigt bis zu vier Mini-Symbole; Zähler/Laufzeit-Marker fassen die enthaltenen Apps zusammen
        const ws = e.items.map((i) => wins.get(i.id)).filter(Boolean), n = e.items.reduce((a, i) => a + badgeOf(i), 0);
        const cls = ['dock-item', 'dock-folder', ws.length && 'running', ws.some((w) => !w.min && activeId === w.id) && 'active', e.group.id === openGroup && 'open'].filter(Boolean).join(' ');
        const b = h('button', { class: cls, type: 'button', 'data-label': e.group.label, 'data-group': e.group.id, 'aria-label': e.group.label, 'aria-haspopup': 'menu' },
          h('div', { class: 'dock-img dock-folder-img' }, e.items.slice(0, 4).map((i) => h('span', { class: 'dock-mini' }, icon(i.icon)))), n > 0 && h('span', { class: 'badge-dot' }, n));
        b.addEventListener('click', () => { if (openGroup === e.group.id) return closePop(); startMenu.hidden = true; startBtn.classList.remove('open'); openGroup = e.group.id; drawPop(); });
        return b;
      }
      const i = e.app, w = wins.get(i.id), n = badgeOf(i);
      const cls = ['dock-item', w && 'running', w && !w.min && activeId === i.id && 'active', w?.min && 'minimized'].filter(Boolean).join(' ');
      const b = h('button', { class: cls, type: 'button', 'data-label': i.label, 'aria-label': i.label },
        h('div', { class: 'dock-img' }, icon(i.icon)), n > 0 && h('span', { class: 'badge-dot' }, n));
      b.addEventListener('click', () => { closePop(); activate(i.id); });
      return b;
    }));
    if (openGroup !== null) drawPop();
  }

  // ── Fenster ──
  function focus(id) {
    const w = wins.get(id);
    if (!w || w.min) return;
    activeId = id;
    w.el.style.zIndex = ++z;
    for (const o of wins.values()) o.el.classList.toggle('active', o === w);
    renderTasks();
  }
  function focusTop() {
    const top = [...wins.values()].filter((w) => !w.min).sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex))[0];
    activeId = null;
    for (const o of wins.values()) o.el.classList.remove('active');
    if (top) focus(top.id); else renderTasks();
  }
  // Animationen über die Web-Animations-API: sie ändern nichts an den CSS-Klassen und lösen daher nie die Öffnen-Animation erneut aus
  const motion = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function minimize(id) {
    const w = wins.get(id); if (!w || w.min) return; w.min = true; focusTop();
    if (!motion() || !w.el.animate) return w.el.classList.add('min');
    w.anim?.cancel(); const anim = w.anim = w.el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(26px) scale(0.94)' }], { duration: 170, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'forwards' });
    const done = () => { if (w.anim !== anim) return; w.anim = null; if (w.min) w.el.classList.add('min'); anim.cancel(); };
    anim.onfinish = done; setTimeout(done, 230); // Rückfall, falls das Bild gerade nicht gezeichnet wird (Tab im Hintergrund)
  }
  function restore(id) { const w = wins.get(id); if (!w) return; w.anim?.cancel(); w.anim = null; w.min = false; w.el.classList.remove('min'); fit(w); }
  function toggleMax(id) {
    const w = wins.get(id); if (!w) return; w.max = !w.max; w.el.classList.toggle('max', w.max); updateMaxIcon(w); if (!w.max) fit(w);
    if (motion() && w.el.animate) w.el.animate([{ opacity: 0.86, transform: 'scale(0.985)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
  }
  function updateMaxIcon(w) { mount(w.maxBtn, icon(w.max ? 'restore' : 'maximize')); w.maxBtn.title = w.max ? 'Verkleinern' : 'Maximieren'; }
  function close(id) {
    const w = wins.get(id);
    if (!w) return;
    w.cleanup?.(); w.offs?.forEach((f) => f()); w.closed = true; wins.delete(id);
    w.el.classList.add('closing');
    setTimeout(() => w.el.remove(), 140);
    focusTop();
  }

  /** Hält ein Fenster vollständig im sichtbaren Desktop-Bereich (z. B. nach Zoom oder Fenstergrößen-Änderung). */
  function fit(w) {
    if (w.max || w.min || compact()) return;
    const a = area.getBoundingClientRect();
    if (!a.width || !a.height) return;
    const width = Math.min(w.el.offsetWidth, a.width), height = Math.min(w.el.offsetHeight, a.height);
    w.el.style.width = `${width}px`;
    w.el.style.height = `${height}px`;
    w.el.style.left = `${clamp(w.el.offsetLeft, 0, Math.max(0, a.width - width))}px`;
    w.el.style.top = `${clamp(w.el.offsetTop, 0, Math.max(0, a.height - height))}px`;
  }

  function startDrag(w, e) {
    if (e.target.closest('.win-btn') || w.max || compact() || e.button !== 0) return;
    const bar = e.currentTarget;
    const a = area.getBoundingClientRect();
    const r = w.el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top, L0 = w.el.offsetLeft, T0 = w.el.offsetTop;
    let started = false, raf = 0, nx = L0, ny = T0;
    bar.setPointerCapture(e.pointerId);
    // Beim Ziehen wird das Fenster per Transform (GPU) bewegt und erst beim Loslassen auf left/top festgeschrieben: kein Neuberechnen des Inhalts, keine Sprünge
    const paint = () => { raf = 0; w.el.style.transform = `translate3d(${nx - L0}px, ${ny - T0}px, 0)`; };
    const move = (ev) => {
      // Titelleiste bleibt immer erreichbar: mindestens 120 px des Fensters bleiben sichtbar
      const x = clamp(ev.clientX - dx - a.left, 120 - r.width, a.width - 120), y = clamp(ev.clientY - dy - a.top, 0, a.height - 44);
      if (!started) { if (Math.hypot(x - L0, y - T0) < 3) return; started = true; w.el.classList.add('dragging'); document.documentElement.classList.add('is-dragging'); }
      nx = x; ny = y; if (!raf) raf = requestAnimationFrame(paint);
    };
    const up = () => {
      bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up);
      if (raf) cancelAnimationFrame(raf);
      if (started) { w.el.style.left = `${nx}px`; w.el.style.top = `${ny}px`; w.el.style.transform = ''; w.el.classList.remove('dragging'); document.documentElement.classList.remove('is-dragging'); }
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  }

  /** Größe ändern an allen vier Kanten und Ecken (dir: n, s, e, w, ne, nw, se, sw). */
  function startResize(w, dir, e) {
    if (w.max || compact() || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    const a = area.getBoundingClientRect();
    const L0 = w.el.offsetLeft, T0 = w.el.offsetTop, W0 = w.el.offsetWidth, H0 = w.el.offsetHeight;
    const minW = Math.min(360, a.width), minH = Math.min(240, a.height);
    const sx = e.clientX, sy = e.clientY;
    handle.setPointerCapture(e.pointerId);
    let raf = 0, last = null; w.el.classList.add('resizing'); document.documentElement.classList.add('is-dragging');
    const move = (ev) => { last = ev; if (!raf) raf = requestAnimationFrame(() => { raf = 0; step(last); }); };
    const step = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      let L = L0, T = T0, W = W0, H = H0;
      if (dir.includes('e')) W = clamp(W0 + dx, minW, a.width - L0);
      if (dir.includes('s')) H = clamp(H0 + dy, minH, a.height - T0);
      if (dir.includes('w')) { W = clamp(W0 - dx, minW, L0 + W0); L = L0 + W0 - W; }
      if (dir.includes('n')) { H = clamp(H0 - dy, minH, T0 + H0); T = T0 + H0 - H; }
      Object.assign(w.el.style, { left: `${L}px`, top: `${T}px`, width: `${W}px`, height: `${H}px` });
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); if (raf) { cancelAnimationFrame(raf); step(last); } w.el.classList.remove('resizing'); document.documentElement.classList.remove('is-dragging'); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  function open(id) {
    const item = findItem(id);
    if (!item || !allowed(item)) return;
    const existing = wins.get(id);
    if (existing) { restore(id); focus(id); return; }

    const a = area.getBoundingClientRect();
    const usableH = a.height - dockH(); // neue Fenster öffnen oberhalb der Leiste (verschieben darf man sie bis ganz nach unten)
    const width = Math.min(item.win?.w ?? 960, Math.round(a.width * 0.94)), height = Math.min(item.win?.h ?? 620, Math.round(usableH * 0.92));
    const n = opened++ % 6;
    const w = { id, item, min: false, max: false, token: 0, closed: false, cleanup: null };
    const actions = h('div', { class: 'header-actions' });
    const subtitle = h('div', { class: 'subtitle' }, item.subtitle ?? '');
    const content = h('main', { class: 'win-content' }, h('div', { class: 'view' }, skeletons(3, 90)));
    w.maxBtn = h('button', { class: 'win-btn max', type: 'button', 'aria-label': 'Maximieren' }, icon('maximize'));
    const helpId = `${opts.partner ? 'p' : 'm'}-${item.id}`;
    const winHelp = item.id === 'help' ? null : h('button', { class: 'win-btn', type: 'button', hidden: true, title: 'Hilfe zu dieser App', 'aria-label': 'Hilfe zu dieser App', onclick: () => openHelp(helpId) }, icon('help'));
    if (winHelp && helpOn()) helpIds().then((ids) => { winHelp.hidden = !ids.has(helpId); });
    const titlebar = h('div', { class: 'win-title' }, icon(item.icon), h('div', { class: 'wt' }, item.label),
      h('div', { class: 'win-btns' },
        winHelp,
        h('button', { class: 'win-btn', type: 'button', title: 'Minimieren', 'aria-label': 'Minimieren', onclick: () => minimize(id) }, icon('minimize')),
        w.maxBtn,
        h('button', { class: 'win-btn close', type: 'button', title: 'Schließen', 'aria-label': 'Schließen', onclick: () => close(id) }, icon('x'))));
    w.maxBtn.addEventListener('click', () => toggleMax(id));
    titlebar.addEventListener('pointerdown', (e) => startDrag(w, e));
    titlebar.addEventListener('dblclick', (e) => { if (!e.target.closest('.win-btn') && !compact()) toggleMax(id); });

    w.el = h('section', { class: 'win', role: 'dialog', 'aria-label': item.label, onscroll: (e) => { e.currentTarget.scrollTop = 0; e.currentTarget.scrollLeft = 0; },
      style: { width: `${width}px`, height: `${height}px`, left: `${clamp((a.width > 1000 ? 120 : 40) + n * 30, 0, Math.max(0, a.width - width))}px`, top: `${clamp(24 + n * 30, 0, Math.max(0, usableH - height))}px` } },
    titlebar, h('div', { class: 'win-bar' }, subtitle, actions), content);
    for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const hd = h('div', { class: `win-resize ${dir}` });
      hd.addEventListener('pointerdown', (e) => startResize(w, dir, e));
      w.el.append(hd);
    }
    w.el.addEventListener('pointerdown', () => { if (activeId !== id) focus(id); }, true);
    wins.set(id, w);
    area.append(w.el);
    updateMaxIcon(w);
    focus(id);
    load(w, content, actions);
  }

  /** Öffnet die Hilfe-App, auf Wunsch direkt bei einem Kapitel (Kontext-Hilfe). */
  function openHelp(articleId) {
    if (!helpOn()) return;
    state.helpTarget = articleId ?? null; open('help');
    window.dispatchEvent(new CustomEvent('mdt:help', { detail: { id: articleId ?? null } }));
  }

  async function load(w, content, actions) {
    const my = ++w.token;
    const stale = () => w.closed || my !== w.token;
    try {
      const mod = await w.item.view();
      if (stale()) return;
      const container = h('div', { class: 'view' });
      mount(content, container);
      const ctx = {
        setActions: (...n) => mount(actions, ...n),
        refreshCounters: async () => { await refreshCounters(); renderIcons(); },
        isCurrent: () => !stale(),
        openApp: (id) => open(id),
        /** Ansicht bei Änderungen der genannten Themen live neu laden (Abo endet automatisch mit dem Fenster). */
        live: (topics, fn, o) => { const off = subscribe(topics, fn, o); (w.offs ??= []).push(off); return off; },
      };
      const cleanup = await mod.default(container, ctx);
      if (stale()) cleanup?.(); else w.cleanup = cleanup ?? null;
    } catch (e) {
      if (stale()) return;
      console.error(e);
      mount(content, h('div', { class: 'view' }, empty('Diese Ansicht konnte nicht geladen werden', e.message, 'alert')));
      toast(e.message, 'err');
    }
  }

  ui = { open };
  areaObserver = new ResizeObserver(() => wins.forEach(fit)); // Fenster passen sich an, wenn der Platz kleiner wird (Browser-Zoom, Größenänderung)
  areaObserver.observe(area);
  renderIcons(); requestAnimationFrame(() => renderIcons()); window.addEventListener("resize", () => renderIcons());
  renderTasks();
  if (!opts.partner && (can('changelog.view') || can('board.view'))) { // neue/geänderte Updates: Pflicht-Hinweis beim Anmelden, Neuladen, bei neuen Einträgen und beim Zurückkehren auf die Seite
    setTimeout(checkUpdatesAck, 600);
    subscribe(['changelog', 'board'], () => checkUpdatesAck(), { wait: 400 });
    let last = 0; document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > 30_000) { last = Date.now(); checkUpdatesAck(); } });
  }
  refreshCounters().then(renderIcons);
  // ── Echtzeit: eine Verbindung für Panel und Partner-Portal ──
  connect(opts.partner ? 'partner' : 'staff');
  initNotifier({ kind: opts.partner ? 'partner' : 'staff', id: opts.partner ? state.user.displayName : state.user.id, open: openTarget });
  if (!opts.partner) subscribe(['profile'], async () => { // eigenes Profilbild geändert/entfernt (auch durch einen Admin) → Kopfzeile sofort aktualisieren
    try { const { user } = await api.get('/api/auth/me'); state.user.avatarUrl = user.avatarUrl; const fresh = userAvatar(user, 'sm'); panelAvatar?.replaceWith(fresh); panelAvatar = fresh; } catch { /* egal */ }
  });
  subscribe(opts.partner ? ['market', 'chat', 'credit'] : ['users', 'market', 'chat', 'credit', 'schedule'], async () => { await refreshCounters(); renderIcons(); if (opts.partner) refreshLevel(); }); // Zähler/Abzeichen live
  if (opts.partner) subscribe(['notification', 'partners'], refreshLevel);
  if (!opts.partner) subscribe(['users', 'roles', 'org'], async () => { try { const { user } = await api.get('/api/auth/me'); Object.assign(state.user, { displayName: user.displayName, rank: user.rank, department: user.department, roles: user.roles }); drawGreet(); } catch { /* egal */ } }, { wait: 300 }); // Rang/Abteilung/Rollen im Gruß aktuell halten
  subscribe(['system', 'dashboard'], async () => { applyConfig((await api.get('/api/bootstrap')).config); }); // Farben/Logo/Namen live für alle
  if (opts.partner) subscribe(['partners'], () => api.get('/api/p/me')); // Zugang geändert/deaktiviert → sofort abgemeldet (401-Handler)
  // Sperrbildschirm (Timeout kommt aus der Konfiguration; Entsperren per Passwort bzw. Code)
  lockCtl = initLock({
    scope: opts.partner ? `partner:${state.user.displayName}` : `user:${state.user.id}`,
    who: opts.partner ? { name: state.user.displayName, label: state.user.displayName } : { name: state.user.displayName, label: state.user.memberNumber ?? state.user.displayName },
    secretLabel: opts.partner ? 'Zugangscode' : 'Passwort',
    verify: (secret) => (opts.partner ? api.post('/api/p/unlock', { code: secret }) : api.post('/api/auth/unlock', { password: secret })),
    onLogout: () => { clearLockState(); lockCtl?.destroy(); onLogout(); },
  });
  startPresence(() => lockCtl?.isLocked(), opts.partner ? undefined : () => online?.refresh(), { partner: !!opts.partner }); // Online-Liste: diese Seite als online (aktiv/gesperrt) melden – Mitglieder und externe Partner
  if (helpOn()) { maybeStartTour(() => lockCtl?.isLocked()); subscribe(['help'], () => helpIds(true)); } // Erste-Schritte-Tour beim ersten Anmelden
  if (opts.start) open(opts.start); // nichts öffnet sich von allein – der Benutzer startet seine Apps selbst
}
