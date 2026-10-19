import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, createRouter, parseCookies, readJson, sendJson, forbidden } from './core/http.js';
import { COOKIE, userFromToken } from './core/auth.js';
import { registerPermissions, syncPermissions, can } from './core/permissions.js';
import { PARTNER_COOKIE, partnerFromToken } from './core/partner-auth.js';
import { syncLookups } from './core/lookups.js';
import { registerConfig, getConfig } from './core/config.js';
import { memberTradeOn, memberPartner } from './core/member-trade.js';
import { migrate, DB_PATH } from './core/db.js';
import { setReinit } from './core/reset.js';
import { APP_VERSION } from './core/version.js';
import { dirname } from 'node:path';

import systemModule, { brandingFile, DISABLEABLE_APPS } from './modules/system.js';
import authModule from './modules/auth.js';
import usersModule from './modules/users.js';
import rolesModule from './modules/roles.js';
import orgModule from './modules/org.js';
import auditModule from './modules/audit.js';
import dashboardModule from './modules/dashboard.js';
import realtimeModule from './modules/realtime.js';
import chatModule from './modules/chat.js';
import vehiclesModule from './modules/vehicles.js';
import mapModule from './modules/map.js';
import warehouseModule from './modules/warehouses.js';
import financeModule from './modules/finance.js';
import tabModule from './modules/tab.js';
import creditModule from './modules/credit.js';
import profileModule from './modules/profile.js';
import statsModule from './modules/stats.js';
import personnelModule from './modules/personnel.js';
import ticketsModule from './modules/tickets.js';
import lookupsModule from './modules/lookups.js';
import partnersModule from './modules/partners.js';
import marketModule from './modules/market.js';
import hackModule from './modules/hack.js';
import boardModule from './modules/board.js';
import changelogModule from './modules/changelog.js';
import legalModule, { codexFrameSource } from './modules/legal.js';
import helpModule from './modules/help.js';
import scheduleModule from './modules/schedule.js';
import watchlistModule from './modules/watchlist.js';
import activityModule from './modules/activity.js';
import onboardingModule from './modules/onboarding.js';
import reportModule from './modules/report.js';
import extrafilesModule from './modules/extrafiles.js';
import levelsModule from './modules/levels.js';
import problemsModule from './modules/problems.js';
import presenceModule from './modules/presence.js';
import citizensModule from './modules/citizens.js';
import casefilesModule from './modules/casefiles.js';
import contactsModule from './modules/contacts.js';

/** Modulliste – spätere Phasen hängen hier weitere Module an (vehicles, storage, purchasing, chat, …). */
const MODULES = [systemModule, authModule, usersModule, rolesModule, orgModule, auditModule, dashboardModule, lookupsModule, chatModule, vehiclesModule, mapModule, warehouseModule, financeModule, profileModule, statsModule, personnelModule, ticketsModule, boardModule, changelogModule, legalModule, citizensModule, casefilesModule, extrafilesModule, problemsModule, presenceModule, contactsModule, helpModule, scheduleModule, watchlistModule, activityModule, onboardingModule, reportModule, realtimeModule];

/** Hinter nginx o. ä.: TRUST_PROXY=1 ⇒ Client-IP und Protokoll aus X-Forwarded-* übernehmen (sonst ignorieren – nicht fälschbar). */
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const clientIp = (req) => (TRUST_PROXY ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress;
/** Angefragte Hostnamen (hinter dem Proxy zuerst X-Forwarded-Host, sonst Host), kleingeschrieben und ohne Port. */
export const hostsOf = (req) => [TRUST_PROXY ? req.headers['x-forwarded-host'] : null, req.headers.host].filter(Boolean).map((h) => String(h).split(',')[0].trim().toLowerCase().replace(/:\d+$/, ''));
/** Läuft die Anfrage über die eigene Subdomain des Exekutive-Zugangs (Einstellung hack.host)? */
export const isCoopHost = (req) => { const h = String(getConfig('coop.host') ?? '').trim().toLowerCase(); return !!h && hostsOf(req).includes(h); };
export const isHackHost = (req) => { const h = String(getConfig('hack.host') ?? '').trim().toLowerCase(); return !!h && hostsOf(req).includes(h); };
const isSecure = (req) => !!req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Frames: Google Docs, dazu genau die eine Herkunft, die für den Codex hinterlegt ist (z. B. eigenes Zipline), sonst nichts. */
const csp = () => `default-src 'self'; img-src 'self' data: blob: https:; frame-src https://docs.google.com${codexFrameSource() ? ` ${codexFrameSource()}` : ''}; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
const securityHeaders = () => ({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': csp(),
});

export function buildApp() {
  migrate();
  const router = createRouter();
  for (const m of MODULES) {
    registerPermissions(m.name, m.permissions ?? []);
    registerConfig(m.config ?? []);
    m.routes?.(router);
  }
  syncPermissions();
  syncLookups();
  for (const m of MODULES) m.init?.();
  setReinit(() => { syncPermissions(); syncLookups(); for (const m of MODULES) m.init?.(); }); // nach einem Werksreset wie bei der Erstinstallation

  async function handleApi(req, res, url) {
    const { route, params, pathMatched } = router.match(req.method, url.pathname);
    if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Methode nicht erlaubt.' : 'Endpunkt nicht gefunden.');

    // CSRF-Schutz: Schreibzugriffe nur mit Custom-Header (löst Preflight aus) + SameSite=Strict-Cookie
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'mdt') throw forbidden('Ungültige Anfrage.');

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE];
    const user = userFromToken(token);
    const partnerToken = cookies[PARTNER_COOKIE];
    let partner = partnerFromToken(partnerToken);
    // Mitglieder handeln in der Börse wie Partner (wenn eingeschaltet und erlaubt): die Partner-Schnittstelle der Börse arbeitet dann mit ihrem verdeckten Partner-Eintrag
    if (!partner && user && user.status === 'active' && url.pathname.startsWith('/api/p/market/') && memberTradeOn(user)) partner = memberPartner(user);
    const ctx = {
      req, res, params, user, token, partner, partnerToken,
      actorName: partner ? `Partner ${partner.number ?? ''}`.trim() : undefined,
      ip: clientIp(req),
      hackHost: isHackHost(req),
      coopHost: isCoopHost(req),
      secure: isSecure(req),
      query: Object.fromEntries(url.searchParams),
      body: req.method === 'GET' ? {} : await readJson(req, route.opts.bodyLimit),
      status: 200, headers: {},
    };

    // Vom Administrator für alle deaktivierte Apps: auch die Schnittstelle ist dicht (nur Mitarbeiter-Routen, Partner-Routen beginnen mit /api/p/)
    const apiHead = url.pathname.split('/')[2];
    if (apiHead) {
      const off = getConfig('system.disabled_apps');
      if (Array.isArray(off) && off.some((id) => DISABLEABLE_APPS[id]?.includes(apiHead))) throw forbidden('Diese App wurde vom Administrator deaktiviert.');
    }
    const { auth = true, perm, partnerApp } = route.opts;
    if (auth === 'partner') {
      if (!partner) throw new HttpError(401, 'Nicht angemeldet.', 'unauthenticated_partner');
      if (partnerApp && !partner.apps.has(partnerApp)) throw forbidden('Diese App ist für deinen Zugang nicht freigeschaltet.');
    } else if (auth !== false) {
      if (!user) throw new HttpError(401, 'Nicht angemeldet.', 'unauthenticated');
      if (auth === true && user.status !== 'active') throw new HttpError(403, 'Dein Zugang ist nicht freigeschaltet.', 'not_active');
    }
    if (perm) {
      const list = Array.isArray(perm) ? perm : [perm];
      if (!list.some((p) => can(user, p))) throw forbidden();
    }
    const data = await route.handler(ctx);
    if (ctx.handled) return; // Handler hat die Antwort selbst geschrieben (SSE-Stream)
    if (ctx.raw) {
      res.writeHead(200, { 'Content-Type': ctx.raw.contentType, ...(ctx.raw.inline ? {} : { 'Content-Disposition': `attachment; filename="${ctx.raw.filename}"` }), 'Cache-Control': ctx.raw.cache ?? 'no-store' });
      return res.end(ctx.raw.body);
    }
    sendJson(res, ctx.status, data ?? { ok: true }, ctx.headers);
  }

  /** Selbst gehostete Kartenkacheln aus data/maptiles (…/{z}/{x}/{y}.png) – Pfad wird streng geprüft. */
  async function serveMapTile(res, pathname) {
    const m = /^\/maptiles\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.(png|jpg|jpeg|webp)$/.exec(pathname);
    if (!m) { res.writeHead(404); return res.end('Not found'); }
    try {
      const file = join(dirname(DB_PATH), 'maptiles', m[1], m[2], `${m[3]}.${m[4]}`);
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[`.${m[4] === 'jpeg' ? 'jpg' : m[4]}`] ?? 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(body);
    } catch { res.writeHead(404); res.end('Not found'); }
  }

  function serveBranding(res, kind) {
    const f = brandingFile(kind);
    if (!f) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(f.body);
  }

  /**
   * Cache-Schutz: Jede Programmdatei wird mit der aktuellen Versionskennung ausgeliefert – Skripte/Styles in index.html und ALLE Importe zwischen den Skripten
   * bekommen `?v=<Version>` angehängt. Nach einem Update sind es dadurch neue Adressen, die kein Browser-, Proxy- oder CDN-Cache kennt (und alte Adressen bleiben `no-store`).
   */
  const V = encodeURIComponent(APP_VERSION);
  const JS_IMPORT = [/(\bfrom\s*)(['"])(\.{1,2}\/[^'"?]+?\.js)\2/g, /(\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"?]+?\.js)\2/g, /(\bimport\s+)(['"])(\.{1,2}\/[^'"?]+?\.js)\2/g];
  const versionJs = (src) => JS_IMPORT.reduce((s, re) => s.replace(re, (_m, a, q, p) => `${a}${q}${p}?v=${V}${q}`), src);
  const versionHtml = (src) => src.replace(/(\b(?:src|href)=")(\/(?:js|css|hack)\/[^"?]+)"/g, (_m, a, p) => `${a}${p}?v=${V}"`);
  const versioned = new Map(); // Datei → { mtime, text }
  async function readVersioned(file, ext) {
    const mtime = (await stat(file)).mtimeMs, hit = versioned.get(file);
    if (hit && hit.mtime === mtime) return hit.text;
    const raw = (await readFile(file, 'utf8')), text = ext === '.js' ? versionJs(raw) : versionHtml(raw);
    versioned.set(file, { mtime, text });
    return text;
  }

  async function serveStatic(req, res, url) {
    if (url.pathname.startsWith('/maptiles/')) return serveMapTile(res, url.pathname);
    if (url.pathname === '/branding/logo') return serveBranding(res, 'logo');
    if (url.pathname === '/branding/wallpaper') return serveBranding(res, 'wallpaper');
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    if (/^\/x\/[^/]+\/?$/.test(url.pathname)) rel = 'hack/index.html'; // Exekutive-Link: eigene, neutrale Seite ohne Systemkennzeichnung
    if (!rel || rel.endsWith(sep)) rel = join(rel, 'index.html');
    let file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    try {
      if (!(await stat(file)).isFile()) throw new Error();
    } catch {
      // Dateien mit Endung → 404, sonst SPA-Fallback
      if (extname(rel)) { res.writeHead(404); return res.end('Not found'); }
      file = join(PUBLIC_DIR, 'index.html');
    }
    const ext = extname(file);
    let body = ext === '.js' || ext === '.html' ? await readVersioned(file, ext) : await readFile(file);
    if (ext === '.html' && file.endsWith('index.html') && isCoopHost(req)) body = body.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(String(getConfig('coop.title') ?? ''))}</title>`).replace(/<link rel="icon"[^>]*>/, () => '<link rel="icon" href="data:,">').replace('<body>', () => '<body class="neutral">');
    // Einmal je neuer Version beim Aufruf der Seite: den HTTP-Cache dieses Browsers für die Seite leeren lassen (Clear-Site-Data) – so verschwinden auch ältere, falsch zwischengespeicherte Dateien
    const extra = {};
    if (ext === '.html' && req.method === 'GET') {
      if (parseCookies(req.headers.cookie)['mdt_v'] !== APP_VERSION) { extra['Clear-Site-Data'] = '"cache"'; extra['Set-Cookie'] = `mdt_v=${APP_VERSION}; Path=/; Max-Age=31536000; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`; }
    }
    res.writeHead(200, { ...extra, 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'Surrogate-Control': 'no-store', 'CDN-Cache-Control': 'no-store' }); // auch Proxys/CDNs dürfen Programmdateien nie zwischenspeichern
    res.end(body);
  }

  return createServer(async (req, res) => {
    for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
    if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('ok'); }
      else if (isCoopHost(req)) {
        // Subdomain für externe Partner/Firmen: nur deren Portale, keine Anmeldung der Mitarbeiter, keine Logos/Branding/Karten
        const p = url.pathname;
        if (p.startsWith('/api/')) { if (/^\/api\/(p|c)\//.test(p) || p === '/api/bootstrap' || p === '/api/version') await handleApi(req, res, url); else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"Nicht gefunden."}'); } }
        else if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/reset' || /^\/p\/[^/]+\/?$/.test(p) || /^\/deckel\/firma\/[^/]+\/?$/.test(p) || /^\/(js|css|vendor)\//.test(p) || p === '/img/wallpaper-lines.svg')) await serveStatic(req, res, url);
        else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }
      }
      else if (isHackHost(req) && !url.pathname.startsWith('/api/h/') && !url.pathname.startsWith('/hack/')) {
        // Eigene Subdomain des Exekutive-Zugangs: nur die neutrale Terminal-Seite, nichts vom eigentlichen System
        if (req.method === 'GET' && url.pathname === '/') { url.pathname = '/x/-'; await serveStatic(req, res, url); } else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }
      }
      else if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
      else { res.writeHead(405); res.end(); }
    } catch (e) {
      if (e instanceof HttpError) {
        if (!res.headersSent) sendJson(res, e.status, { error: e.message, code: e.code, details: e.details });
      } else {
        console.error('[Fehler]', req.method, req.url, e);
        if (!res.headersSent) sendJson(res, 500, { error: 'Interner Serverfehler.', code: 'internal' });
      }
    }
  });
}
