import { api, onUnauthenticated } from './api.js';
import { state, applyConfig, previewConfig } from './state.js';
import { showApp, showLock, openApp } from './shell.js';
import { showLogin, showRegister, showSetup, showPending } from './views/auth.js';
import { showPartnerLogin, showInvalidLink } from './views/partner/login.js';
import { showCompanyPortal } from './views/company-portal.js';
import { PARTNER_NAV } from './modules.js';
import { toast } from './ui/kit.js';
import { h } from './ui/dom.js';
import { syncVersion, watchVersion, resetLocal, hardRefresh } from './version.js';
import { startNeutral } from './neutral.js';
import { initHalloween } from './halloween.js';

// Externer Zugang: /p/<link-token> – eigene Anmeldung per Code, nur freigeschaltete Apps
const partnerToken = (() => { const m = location.pathname.match(/^\/p\/([^/]+)\/?$/); return m ? decodeURIComponent(m[1]) : null; })();

// Firmenportal (Deckel-Abrechnung): /deckel/firma/<link-token> – ohne Anmeldung, nur die eigenen Abrechnungen
const companyToken = (() => { const m = location.pathname.match(/^\/deckel\/firma\/([^/]+)\/?$/); return m ? decodeURIComponent(m[1]) : null; })();
async function startCompany() {
  const b = await boot();
  if (!b) return;
  applyConfig(b.config);
  showCompanyPortal({ token: companyToken });
}

async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* egal */ }
  state.user = null;
  await start();
}

function route(user) {
  state.user = user;
  if (user.status === 'active') return showApp(logout);
  if (user.status === 'pending') {
    return showPending({
      user, onLogout: logout,
      onRefresh: async () => {
        const { user: fresh } = await api.get('/api/auth/me');
        if (fresh.status === 'active') { toast('Dein Zugang wurde freigeschaltet.'); route(fresh); } else toast('Noch nicht freigeschaltet.', 'warn');
      },
    });
  }
  return logout();
}

/** Diagnose (Klick auf „Build …“): zeigt Programmstand und die Rechte des angemeldeten Kontos – hilft, wenn Funktionen „fehlen“. */
const KEY_PERMS = ['users.create', 'users.personnel_view', 'users.personnel_edit', 'partners.manage', 'partners.documents', 'partners.delete', 'tickets.manage', 'finance.view', 'stats.view'];
async function showDiagnose(b) {
  const u = state.user;
  const rows = [['Build (Commit)', b.commit ?? 'unbekannt'], ['Programmversion', b.version ?? '–'], ['Angemeldet', u ? (u.memberNumber ?? u.displayName) : 'nein'],
    ['Superadmin', u ? (u.isSuperadmin ? 'ja' : 'nein') : '–'], ['Administrator-Rolle', u ? (u.isAdmin ? 'ja' : 'nein') : '–'], ['Rechte gesamt', u ? String(u.permissions?.length ?? 0) : '–'],
    ...KEY_PERMS.map((k) => [k, u ? (u.permissions?.includes(k) ? 'ja' : 'FEHLT') : '–'])];
  const { openModal, button } = await import('./ui/kit.js');
  const m = openModal({ title: 'Diagnose', body: h('div', null, h('p', { class: 'muted' }, 'Wenn Funktionen fehlen: Steht bei einem Recht „FEHLT“, muss es deinem Konto (Rolle oder Direkte Rechte) zugewiesen werden.'),
    h('dl', { class: 'details-dl' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', { class: 'mono' }, v)]))), footer: [button('Zwischenspeicher leeren & neu laden', { icon: 'refresh', onClick: () => hardRefresh() }), button('Schließen', { onClick: () => m.close() })] });
}

async function boot() {
  try {
    const b = await api.get('/api/bootstrap');
    if (b.neutral) { document.documentElement.classList.add('neutral'); startNeutral(b.mask); } // Subdomain für Externe: neutral, ohne Logo/Namen
    document.getElementById('build-tag')?.remove();
    if (b.neutral) { syncVersion(b.version); watchVersion(b.version); return b; }
    const tag = h('div', { id: 'build-tag', class: 'build-tag', title: 'Installierter Programmstand – klicken für Diagnose', onclick: () => showDiagnose(b) }, `Build ${b.commit ?? '?'}`);
    const screenEl = document.getElementById('screen');
    // Die Pille lebt im Hintergrund-Layer des Bildschirms (unter Fenstern und Dock) und wird nach jedem Neuaufbau des Bildschirms wieder eingesetzt
    const place = () => { if (tag.parentNode !== screenEl) screenEl.append(tag); };
    place(); new MutationObserver(place).observe(screenEl, { childList: true });
    // Einstellbar unter Konfiguration → Darstellung („Build-Anzeige einblenden“)
    const sync = () => { tag.hidden = (state.config?.['ui.show_build'] ?? b.config?.['ui.show_build']) === false; };
    sync(); window.addEventListener('mdt:config', sync); setInterval(sync, 2000);
    syncVersion(b.version); watchVersion(b.version); // veralteten lokalen Zustand nach Updates verwerfen / laufende Seite erneuern
    return b;
  } catch (e) {
    showLock(h('div', { class: 'lock-card' }, h('h2', null, 'Server nicht erreichbar'), h('p', { class: 'lead' }, e.message)));
    return null;
  }
}

async function start() {
  const b = await boot();
  if (!b) return;
  applyConfig(b.config);
  const onAuthed = async (user, firstRun) => {
    try { applyConfig((await api.get('/api/bootstrap')).config); } catch { /* alte Konfiguration behalten */ }
    route(user);
    if (firstRun) openApp('config');
  };

  if (b.neutral) return showLock(h('div', { class: 'lock-card' }, h('h2', null, state.config['system.name'] || ''), h('p', { class: 'lead' }, 'Bitte öffne den persönlichen Link, den du erhalten hast.')));
  if (b.setupRequired) return showSetup({ onAuthed });
  try {
    const { user } = await api.get('/api/auth/me');
    return route(user);
  } catch { /* nicht angemeldet */ }
  const goLogin = () => showLogin({ onAuthed, goRegister });
  const goRegister = () => showRegister({ onAuthed, goLogin });
  goLogin();
}

async function partnerLogout() {
  try { await api.post('/api/p/logout'); } catch { /* egal */ }
  state.user = null;
  await startPartner();
}

async function startPartner() {
  const b = await boot();
  if (!b) return;
  applyConfig(b.config);
  let session;
  try { session = await api.get(`/api/p/${encodeURIComponent(partnerToken)}/session`); } catch { return showInvalidLink(); }
  const enter = (partner) => {
    state.user = { id: 0, username: '', displayName: partner.number ?? partner.name, status: 'active', roles: [], permissions: [], isAdmin: false, memberNumber: null, rank: null, department: null, isPartner: true, level: partner.level ?? null };
    const allowed = new Set(partner.apps);
    if (!(state.config['system.disabled_apps'] ?? []).includes('help')) allowed.add('help'); // Hilfe: für jeden Zugang (zeigt nur Kapitel zu den freigeschalteten Apps)
    showApp(partnerLogout, { nav: PARTNER_NAV, allow: (i) => allowed.has(i.id), footerRole: 'Externer Zugang', partner: true });
    if (!partner.apps.length) toast('Für diesen Zugang sind noch keine Apps freigeschaltet.', 'warn');
  };
  if (session.authenticated) return enter(session.partner);
  showPartnerLogin({ token: partnerToken, onAuthed: enter });
}

onUnauthenticated((code) => {
  if (!state.user) return;
  if (partnerToken && code === 'unauthenticated_partner') { state.user = null; toast('Deine Sitzung ist abgelaufen oder der Zugang wurde geändert.', 'warn'); startPartner(); }
  else if (!partnerToken && code === 'unauthenticated') { state.user = null; toast('Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.', 'warn'); start(); }
});
if (location.pathname === '/reset') resetLocal(); // Notausgang: lokale Daten dieser App löschen und abmelden
else (companyToken ? startCompany : partnerToken ? startPartner : start)();

initHalloween(); // Halloween-Dekoration (wenn vom Superadmin eingeschaltet)
// Konfigurationsänderungen (z. B. Akzentfarbe) sofort sichtbar machen
window.addEventListener('mdt:config', (e) => previewConfig(e.detail));
