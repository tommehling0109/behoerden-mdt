import { all, get, run, tx, now, db, DB_PATH } from '../core/db.js';
import { APP_VERSION, APP_COMMIT } from '../core/version.js';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HttpError, bad, str, conflict, notFound, forbidden } from '../core/http.js';
import { getConfig, publicConfig, describeConfig, validateConfigValue, setConfig, configEditPerm } from '../core/config.js';
import { hashPassword, checkPassword, createSession, COOKIE, publicUser, loadUser, verifyPassword } from '../core/auth.js';
import { listPermissions } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { assignMemberNumber } from '../core/members.js';
import { factoryReset } from '../core/reset.js';
import { seedRanks } from '../core/seed-ranks.js';
import { updateState, checkForUpdate, startUpdateChecks } from '../core/updates.js';

// ── Branding: eigenes Logo / Hintergrundbild (nur PNG, JPEG, WebP – kein SVG, wegen Skript-Risiko) ──
const brandDir = () => join(dirname(DB_PATH), 'branding');
const BRAND = { logo: { max: 2 * 1024 * 1024 }, wallpaper: { max: 8 * 1024 * 1024 } };
const EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
function sniffImage(b) {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
const brandFiles = (kind) => { try { return readdirSync(brandDir()).filter((f) => f.startsWith(kind + '.')); } catch { return []; } };
/** Liefert { body, mime } des hochgeladenen Branding-Bildes oder null. */
export function brandingFile(kind) {
  const f = BRAND[kind] && brandFiles(kind)[0];
  if (!f) return null;
  return { body: readFileSync(join(brandDir(), f)), mime: EXT[f.split('.').pop()] ?? 'application/octet-stream' };
}

export const setupRequired = () => get('SELECT COUNT(*) c FROM users').c === 0;

export function sessionCookie(ctx, token, expires) {
  const maxAge = Math.max(0, Math.floor((new Date(expires) - Date.now()) / 1000));
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${ctx.secure ? '; Secure' : ''}`;
}

/** Apps, die sich für alle abschalten lassen → Beginn ihrer API-Pfade (Verwaltungs-Apps und die Konfiguration bleiben immer verfügbar). */
export const DISABLEABLE_APPS = {
  dashboard: ['dashboard'], market: ['market'], map: ['map'], warehouse: ['warehouse', 'warehouses'], vehicles: ['vehicles'], finance: ['finance'], stats: ['stats'], credit: ['credit'],
  tab: ['tab'], tickets: ['tickets'], legal: ['legal'], contacts: ['contacts'], chat: ['chat'], help: ['help'],
};
export default {
  name: 'system',
  permissions: [
    ['config.view', 'Systemkonfiguration ansehen'],
    ['config.edit', 'Systemkonfiguration ändern'],
    ['admin.access', 'Administrationsbereich öffnen'],
    ['permissions.manage', 'Eigene Rechte anlegen, ändern und löschen'],
    ['system.backup', 'Datensicherungen erstellen und einsehen'],
    ['system.apps', 'Apps für alle Benutzer aktivieren oder deaktivieren (Superadmin)'],
  ],
  config: [
    // Für alle deaktivierte Apps (IDs). Verwaltet über Konfiguration → Apps; die Verwaltungs-Apps (Konfiguration, Benutzer, Rollen …) lassen sich nicht abschalten.
    { key: 'system.disabled_apps', group: 'Apps', label: 'Deaktivierte Apps', type: 'json', default: [], hidden: true, public: true, perm: 'system.apps',
      validate: (v) => Array.isArray(v) && v.length <= 30 && new Set(v).size === v.length && v.every((x) => typeof x === 'string' && Object.hasOwn(DISABLEABLE_APPS, x)) },
    { key: 'system.name', group: 'Allgemein', label: 'Systemname', help: 'Wird im Header, Login und Browser-Tab angezeigt.', type: 'string', default: 'MDT', max: 40, public: true },
    { key: 'system.subtitle', group: 'Allgemein', label: 'Untertitel', help: 'Zweite Zeile unter dem Systemnamen.', type: 'string', default: 'Mobile Data Terminal', max: 60, public: true },
    { key: 'ui.accent', group: 'Darstellung', label: 'Akzentfarbe', help: 'Hauptfarbe für Buttons, Markierungen und Glow-Effekte.', type: 'color', default: '#5b82b8', public: true },
    { key: 'ui.accent2', group: 'Darstellung', label: 'Zweite Farbe', help: 'Farbverlauf des Hintergrunds und Akzente (Leuchten).', type: 'color', default: '#8da2bd', public: true },
    { key: 'ui.theme', group: 'Darstellung', label: 'Designvorlage', help: 'Grundfarbwelt der Oberfläche (Flächen, Rahmen, Hintergrund).', type: 'select', default: 'anthracite', public: true,
      options: [{ value: 'anthracite', label: 'Anthrazit' }, { value: 'black', label: 'Schwarz (OLED)' }, { value: 'midnight', label: 'Mitternacht (Violett)' }, { value: 'ocean', label: 'Ozean (Blau)' }] },
    { key: 'ui.wallpaper_style', group: 'Darstellung', label: 'Hintergrund-Stil', help: 'Gilt, solange kein eigenes Hintergrundbild hochgeladen ist.', type: 'select', default: 'lines', public: true,
      options: [{ value: 'lines', label: 'Verlauf mit Linien & Funkeln' }, { value: 'gradient', label: 'Nur Verlauf' }, { value: 'solid', label: 'Einfarbig' }] },
    { key: 'ui.radius', group: 'Darstellung', label: 'Eckenradius', help: 'Wie rund Fenster, Karten und Buttons sind.', type: 'select', default: 'normal', public: true,
      options: [{ value: 'sharp', label: 'Eckig' }, { value: 'normal', label: 'Normal' }, { value: 'round', label: 'Sehr rund' }] },
    { key: 'ui.density', group: 'Darstellung', label: 'Darstellungsgröße', help: 'Skaliert den Inhalt in den Fenstern.', type: 'select', default: 'normal', public: true,
      options: [{ value: 'compact', label: 'Kompakt' }, { value: 'normal', label: 'Normal' }, { value: 'comfortable', label: 'Groß' }] },
    { key: 'ui.dock_size', group: 'Darstellung', label: 'Größe der Dock-Symbole (px)', type: 'number', default: 52, min: 36, max: 72, public: true },
    { key: 'ui.glass', group: 'Darstellung', label: 'Transparenz-Effekte', help: 'Milchglas-Optik für obere Leiste, Dock und Menüs.', type: 'bool', default: true, public: true },
    { key: 'ui.animations', group: 'Darstellung', label: 'Animationen', help: 'Dezente Übergänge beim Öffnen, Hover und Wechseln.', type: 'bool', default: true, public: true },
    { key: 'ui.show_widget', group: 'Darstellung', label: 'Uhr-Widget auf dem Desktop', type: 'bool', default: true, public: true },
    { key: 'ui.show_build', group: 'Darstellung', label: 'Build-Anzeige (unten rechts) einblenden', help: 'Zeigt den installierten Programmstand als kleine Pille an (Klick = Diagnose).', type: 'bool', default: true, public: true },
    { key: 'system.update_check', group: 'Updates', label: 'Automatisch auf Updates prüfen', help: 'Fragt alle 6 Stunden bei GitHub nach einer neueren Version und informiert Superadmin und Administratoren.', type: 'bool', default: true },
    { key: 'system.update_repo', group: 'Updates', label: 'GitHub-Repository', help: 'Format: besitzer/name', type: 'string', default: 'tommehling0109/mdt-template', max: 100 },
    { key: 'ui.show_watermark', group: 'Darstellung', label: 'Logo-Wasserzeichen im Hintergrund', type: 'bool', default: true, public: true },
    { key: 'security.lock_timeout_minutes', group: 'Zugang', label: 'Sperrbildschirm nach Inaktivität (Minuten)', help: 'Nach dieser Zeit ohne Eingabe wird der Bildschirm gesperrt; Entsperren per Passwort bzw. Code. 0 = aus.', type: 'number', default: 10, min: 0, max: 1440, public: true },
    { key: 'ui.halloween', group: 'Darstellung', label: 'Halloween-Design', help: 'Schaltet das Halloween-Design für ALLE ein: Orange/Violett, „Happy Halloween“-Schriftzug, Kürbisse, Lichterkette, Mond, Nebel, Fledermäuse und Geist im Hintergrund. Nur der Superadmin kann es ein- und ausschalten.', type: 'bool', default: false, public: true, perm: 'system.apps' },
    { key: 'ui.desktop_icons', group: 'Darstellung', label: 'Desktop-Symbole anzeigen', help: 'Voreinstellung für alle: zeigt die Apps zusätzlich als Symbole auf dem Desktop (das Dock unten bleibt immer sichtbar). Jeder kann das für sich unter Einstellungen (Zahnrad) ändern.', type: 'bool', default: false, public: true },
    { key: 'ui.desktop_icons_partner', group: 'Darstellung', label: 'Desktop-Symbole für externe Zugänge', help: 'Voreinstellung nur für externe Zugänge: wie bei allen (siehe oben), immer anzeigen oder ausblenden. Jeder Zugang kann das für sich unter Einstellungen (Zahnrad) ändern.', type: 'select', default: 'same', options: [{ value: 'same', label: 'Wie die Voreinstellung für alle' }, { value: 'on', label: 'Anzeigen' }, { value: 'off', label: 'Ausblenden' }], public: true },
    { key: 'branding.logo_version', group: 'Darstellung', label: 'Logo-Version', type: 'number', default: 0, min: 0, max: 9e15, hidden: true, public: true },
    { key: 'branding.wallpaper_version', group: 'Darstellung', label: 'Hintergrund-Version', type: 'number', default: 0, min: 0, max: 9e15, hidden: true, public: true },
    { key: 'auth.registration_enabled', group: 'Zugang', label: 'Registrierung erlauben', help: 'Neue Benutzer können sich selbst registrieren und warten auf Freischaltung.', type: 'bool', default: true, public: true },
    { key: 'auth.session_hours', group: 'Zugang', label: 'Sitzungsdauer (Stunden)', type: 'number', default: 12, min: 1, max: 720 },
  ],
  /** Selbstheilung bei jedem Start: Gibt es Benutzer, aber keinen Superadmin (z. B. Altbestand), wird der älteste aktive Administrator zum Superadmin. */
  init() {
    startUpdateChecks();
    if (get('SELECT 1 x FROM users WHERE is_superadmin = 1')) return;
    const first = get("SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE r.is_admin = 1 AND u.status = 'active' ORDER BY u.id LIMIT 1")
      ?? get("SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
    if (first) run('UPDATE users SET is_superadmin = 1 WHERE id = ?', first.id);
  },
  routes(r) {
    // Öffentlich: Konfiguration für Login/Setup-Bildschirm
    r.get('/api/bootstrap', { auth: false }, (ctx) => {
      if (ctx.coopHost) { // Subdomain für Externe: nichts, was auf das System hinweist
        const mask = String(getConfig('coop.mask') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        return { setupRequired: false, neutral: true, mask, version: APP_VERSION, commit: null,
          config: { ...publicConfig(), 'system.name': getConfig('coop.title'), 'system.subtitle': '', 'branding.logo_version': 0, 'branding.wallpaper_version': 0, 'ui.show_watermark': false, 'ui.show_build': false } };
      }
      return { setupRequired: setupRequired(), config: publicConfig(), version: APP_VERSION, commit: APP_COMMIT };
    });
    r.get('/api/admin/update', { perm: 'config.view' }, () => ({ installed: APP_COMMIT, ...updateState }));
    r.post('/api/admin/update/check', { perm: 'config.view' }, async () => ({ installed: APP_COMMIT, ...(await checkForUpdate({ force: true })) }));
    r.get('/api/version', { auth: false }, () => ({ version: APP_VERSION, commit: APP_COMMIT }));

    // Erst-Einrichtung: legt Administrator-Rolle + ersten Benutzer an. Nur solange kein Benutzer existiert.
    r.post('/api/setup', { auth: false }, (ctx) => {
      const b = ctx.body;
      const username = str(b.username, 'Benutzername', { min: 3, max: 32 });
      if (!/^[\p{L}\p{N}._-]+$/u.test(username)) throw bad('Benutzername enthält ungültige Zeichen.');
      const displayName = str(b.displayName, 'Anzeigename', { min: 2, max: 60 });
      const pwErr = checkPassword(b.password);
      if (pwErr) throw bad(pwErr);
      const systemName = str(b.systemName, 'Systemname', { min: 1, max: 40 });

      const result = tx(() => {
        if (!setupRequired()) throw conflict('Das System ist bereits eingerichtet.');
        const t = now();
        const user = run('INSERT INTO users (username,display_name,password_hash,status,is_superadmin,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
          username, displayName, hashPassword(b.password), 'active', t, t);
        setConfig('system.name', systemName, user.lastInsertRowid);
        assignMemberNumber(Number(user.lastInsertRowid));
        seedRanks();
        return { userId: Number(user.lastInsertRowid) };
      });
      const u = loadUser(result.userId);
      audit({ user: u, ip: ctx.ip }, { action: 'system.setup', module: 'system', targetType: 'user', targetId: u.id, targetLabel: u.memberNumber ?? 'Mitglied' });
      const s = createSession(u.id, { ip: ctx.ip, ua: ctx.req.headers['user-agent'], hours: getConfig('auth.session_hours') });
      ctx.headers['Set-Cookie'] = sessionCookie(ctx, s.token, s.expires);
      ctx.status = 201;
      return { user: publicUser(u) };
    });

    // Logo / Hintergrundbild hochladen (Base64 im JSON-Body, serverseitig geprüft) oder auf Standard zurücksetzen
    r.post('/api/admin/branding/:kind', { perm: 'config.edit', bodyLimit: 12 * 1024 * 1024 }, (ctx) => {
      const kind = ctx.params.kind;
      if (!BRAND[kind]) throw notFound('Unbekannte Einstellung.');
      if (typeof ctx.body.data !== 'string') throw bad('Keine Bilddaten übergeben.');
      const buf = Buffer.from(ctx.body.data.replace(/^data:[^,]*,/, ''), 'base64');
      if (!buf.length) throw bad('Die Datei ist leer.');
      if (buf.length > BRAND[kind].max) throw bad(`Die Datei ist zu groß (maximal ${BRAND[kind].max / 1024 / 1024} MB).`);
      const ext = sniffImage(buf);
      if (!ext) throw bad('Nur PNG-, JPEG- oder WebP-Bilder sind erlaubt.');
      mkdirSync(brandDir(), { recursive: true });
      for (const f of brandFiles(kind)) unlinkSync(join(brandDir(), f));
      writeFileSync(join(brandDir(), `${kind}.${ext}`), buf);
      const version = Date.now();
      setConfig(`branding.${kind}_version`, version, ctx.user.id);
      audit(ctx, { action: 'branding.updated', module: 'system', targetType: 'branding', targetId: kind, targetLabel: kind === 'logo' ? 'Logo' : 'Hintergrundbild', after: { bytes: buf.length, type: ext } });
      return { version };
    });
    r.delete('/api/admin/branding/:kind', { perm: 'config.edit' }, (ctx) => {
      const kind = ctx.params.kind;
      if (!BRAND[kind]) throw notFound('Unbekannte Einstellung.');
      for (const f of brandFiles(kind)) unlinkSync(join(brandDir(), f));
      setConfig(`branding.${kind}_version`, 0, ctx.user.id);
      audit(ctx, { action: 'branding.reset', module: 'system', targetType: 'branding', targetId: kind, targetLabel: kind === 'logo' ? 'Logo' : 'Hintergrundbild' });
      return { version: 0 };
    });

    r.get('/api/config', { perm: ['config.view', 'hack.manage', 'legal.manage'] }, (ctx) => ({ settings: describeConfig(ctx.user) }));

    // Änderungen: je Einstellung das passende Recht (Standard config.edit; Exekutive-Zugang: hack.manage)
    r.put('/api/config', { perm: ['config.edit', 'hack.manage', 'system.apps', 'legal.manage'] }, (ctx) => {
      const changes = ctx.body.values;
      if (!changes || typeof changes !== 'object') throw bad('Keine Werte übergeben.');
      const applied = tx(() => {
        const out = [];
        for (const [key, raw] of Object.entries(changes)) {
          if (!ctx.user.perms.has(configEditPerm(key))) throw forbidden(`Für „${key}“ fehlt dir das Recht „${configEditPerm(key)}“.`);
          const value = validateConfigValue(key, raw);
          const before = getConfig(key);
          if (JSON.stringify(before) === JSON.stringify(value)) continue;
          setConfig(key, value, ctx.user.id);
          audit(ctx, { action: 'config.changed', module: 'system', targetType: 'setting', targetId: key, targetLabel: key, before, after: value });
          out.push(key);
        }
        return out;
      });
      return { changed: applied, settings: describeConfig(ctx.user) };
    });

    r.get('/api/permissions', { perm: ['roles.view', 'users.view', 'org.view', 'permissions.manage'] }, () => ({ permissions: listPermissions() }));

    // Eigene Rechte (z. B. für künftige Module oder Sonderfälle). Rechte aus dem Code sind nicht veränderbar.
    const KEY_RE = /^[a-z][a-z0-9_]{1,30}(\.[a-z0-9_]{1,30}){1,3}$/;
    r.post('/api/permissions', { perm: 'permissions.manage' }, (ctx) => {
      const key = str(ctx.body.key, 'Schlüssel', { min: 3, max: 80 });
      if (!KEY_RE.test(key)) throw bad('Der Schlüssel muss aus Kleinbuchstaben bestehen und mit Punkten gegliedert sein, z. B. „legal.view“.');
      const description = str(ctx.body.description, 'Beschreibung', { max: 200, required: false });
      if (get('SELECT 1 x FROM permissions WHERE key = ?', key)) throw conflict('Dieses Recht existiert bereits.');
      run('INSERT INTO permissions (key,module,description,is_custom) VALUES (?,?,?,1)', key, key.split('.')[0], description);
      audit(ctx, { action: 'permission.created', module: 'system', targetType: 'permission', targetId: key, targetLabel: key, after: { key, description } });
      ctx.status = 201;
      return { permission: get('SELECT key,module,description,is_custom FROM permissions WHERE key = ?', key) };
    });
    r.patch('/api/permissions/:key', { perm: 'permissions.manage' }, (ctx) => {
      const cur = get('SELECT * FROM permissions WHERE key = ?', ctx.params.key);
      if (!cur) throw notFound('Recht nicht gefunden.');
      if (!cur.is_custom) throw forbidden('Rechte aus dem System sind nicht änderbar.');
      const description = str(ctx.body.description, 'Beschreibung', { max: 200, required: false });
      run('UPDATE permissions SET description = ? WHERE key = ?', description, cur.key);
      audit(ctx, { action: 'permission.updated', module: 'system', targetType: 'permission', targetId: cur.key, targetLabel: cur.key, before: { description: cur.description }, after: { description } });
      return { permission: get('SELECT key,module,description,is_custom FROM permissions WHERE key = ?', cur.key) };
    });
    r.delete('/api/permissions/:key', { perm: 'permissions.manage' }, (ctx) => {
      const cur = get('SELECT * FROM permissions WHERE key = ?', ctx.params.key);
      if (!cur) throw notFound('Recht nicht gefunden.');
      if (!cur.is_custom) throw forbidden('Rechte aus dem System können nicht gelöscht werden.');
      run('DELETE FROM permissions WHERE key = ?', cur.key);
      audit(ctx, { action: 'permission.deleted', module: 'system', targetType: 'permission', targetId: cur.key, targetLabel: cur.key, before: cur });
      return { ok: true };
    });

    // Datensicherung: konsistente Kopie der Datenbank (VACUUM INTO) im Ordner data/backups, die letzten 15 bleiben erhalten
    const backupDir = () => join(dirname(DB_PATH), 'backups');
    const listBackups = () => {
      try {
        return readdirSync(backupDir()).filter((f) => /^mdt-\d{8}-\d{6}\.db$/.test(f)).sort().reverse()
          .map((f) => ({ name: f, size: statSync(join(backupDir(), f)).size, createdAt: statSync(join(backupDir(), f)).mtime.toISOString() }));
      } catch { return []; }
    };
    const makeBackup = () => {
      mkdirSync(backupDir(), { recursive: true });
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const name = `mdt-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.db`;
      const file = join(backupDir(), name);
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      for (const old of listBackups().slice(15)) { try { unlinkSync(join(backupDir(), old.name)); } catch { /* egal */ } }
      return name;
    };
    r.get('/api/admin/backups', { perm: 'system.backup' }, () => ({ backups: listBackups(), directory: backupDir() }));

    /**
     * Panel auf null setzen (nur Superadmin): vorher wird automatisch eine Datensicherung angelegt. Verlangt das Passwort und den exakten Bestätigungstext.
     * Programm, Schema, Datensicherungen und Kartenkacheln bleiben; alle Daten und hochgeladenen Dateien sind weg; der Setup-Bildschirm kehrt zurück.
     */
    r.post('/api/admin/reset', (ctx) => {
      if (!ctx.user.isSuperadmin) throw forbidden('Nur Superadmins dürfen das Panel zurücksetzen.');
      if (ctx.body.confirm !== 'ALLES LÖSCHEN') throw bad('Bitte gib zur Bestätigung exakt „ALLES LÖSCHEN“ ein.');
      const row = get('SELECT password_hash h FROM users WHERE id = ?', ctx.user.id);
      if (typeof ctx.body.password !== 'string' || !row || !verifyPassword(ctx.body.password, row.h)) throw forbidden('Das Passwort ist nicht korrekt.');
      const backup = makeBackup();
      const res = factoryReset();
      audit({ ip: ctx.ip, actorName: 'Superadmin' }, { action: 'system.factory_reset', module: 'system', targetType: 'system', targetLabel: `Zurückgesetzt (Sicherung: ${backup})` });
      return { ok: true, backup, tables: res.tables };
    });
    r.post('/api/admin/backups', { perm: 'system.backup' }, (ctx) => {
      const name = makeBackup();
      audit(ctx, { action: 'system.backup_created', module: 'system', targetType: 'backup', targetLabel: name });
      ctx.status = 201;
      return { backup: listBackups().find((b) => b.name === name), backups: listBackups() };
    });
  },
};
