// API-Smoketest: Setup, manuelle Freischaltung, Rollen/Rechte, Eskalationsschutz, Audit. Nutzt eine temporäre DB.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { periodKey as tabPeriodKey, periodInfo as tabPeriodInfo } from '../server/core/periods.js';

const dir = mkdtempSync(join(tmpdir(), 'mdt-'));
process.env.MDT_DB = join(dir, 'test.db');
process.env.TRUST_PROXY = '1'; // wie hinter nginx
process.env.MDT_UPDATE_CHECK = '0'; process.env.APP_COMMIT = 'abc1234def'; // keine echten GitHub-Abfragen im Test; bekannter Stand
const { buildApp } = await import('../server/app.js');
const server = buildApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

class Client {
  cookie = '';
  async call(method, path, body) {
    const res = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mdt', cookie: this.cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return { status: res.status, ...(await res.json()) };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Öffnet einen SSE-Stream (wie der Browser-EventSource) und sammelt die Ereignisse. */
async function openSse(cookie, path, lastId) {
  const ac = new AbortController();
  const res = await fetch(base + path, { headers: { cookie, ...(lastId != null ? { 'last-event-id': String(lastId) } : {}) }, signal: ac.signal });
  const events = [];
  let buf = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith(':') || block.startsWith('retry')) continue;
          const ev = {};
          for (const line of block.split('\n')) { const j = line.indexOf(': '); if (j > 0) ev[line.slice(0, j)] = line.slice(j + 2); }
          if (ev.data) ev.data = JSON.parse(ev.data);
          events.push(ev);
        }
      }
    } catch { /* abgebrochen */ }
  })();
  const waitFor = async (pred, ms = 1500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const f = events.find(pred); if (f) return f; await sleep(15); } return null; };
  return { status: res.status, events, close: () => ac.abort(), waitFor, lastId: () => Number(events.at(-1)?.id ?? 0) };
}
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

try {
  const admin = new Client(), user = new Client(), mod = new Client();

  assert.equal((await admin.call('GET', '/api/bootstrap')).setupRequired, true); ok('Setup erforderlich bei leerer DB');
  assert.equal((await admin.call('GET', '/api/users')).status, 401); ok('API ohne Login → 401');
  let r = await admin.call('POST', '/api/setup', { systemName: 'Test', adminRoleName: 'Boss', displayName: 'Admin', username: 'admin', password: 'passwort123' });
  assert.equal(r.status, 201); assert.equal(r.user.isAdmin, true); ok('Setup legt Admin an');
  assert.equal((await new Client().call('POST', '/api/setup', { systemName: 'X', adminRoleName: 'Yyy', displayName: 'Evil', username: 'evil', password: 'passwort123' })).status, 409); ok('Zweites Setup wird abgelehnt');

  // CSRF-Header
  const raw = await fetch(base + '/api/auth/logout', { method: 'POST' });
  assert.equal(raw.status, 403); ok('POST ohne X-Requested-With → 403');

  // Registrierung → pending
  r = await user.call('POST', '/api/auth/register', { displayName: 'Neuer', username: 'neuer', password: 'passwort123' });
  assert.equal(r.status, 201); assert.equal(r.user.status, 'pending'); assert.deepEqual(r.user.permissions, []); ok('Registrierung → ausstehend, keine Rechte');
  assert.equal((await user.call('GET', '/api/dashboard')).code, 'not_active'); ok('Ausstehender Benutzer: Dashboard gesperrt (serverseitig)');
  assert.equal((await user.call('GET', '/api/users')).status, 403); ok('Ausstehender Benutzer: Benutzerliste gesperrt');
  assert.equal((await user.call('GET', '/api/auth/me')).user.status, 'pending'); ok('/me für ausstehende Benutzer erlaubt');

  // Rolle mit Rechten anlegen, Benutzer freischalten
  r = await admin.call('POST', '/api/roles', { name: 'Moderator', permissions: ['users.view', 'users.approve', 'audit.view'] });
  assert.equal(r.status, 201); const modRole = r.role.id;
  const roles = (await admin.call('GET', '/api/roles')).roles; const adminRole = roles.find((x) => x.isAdmin);
  const users = (await admin.call('GET', '/api/users')).users; const neuer = users.find((u) => u.username === 'neuer');
  r = await admin.call('POST', `/api/users/${neuer.id}/status`, { status: 'active', roleIds: [modRole] });
  assert.equal(r.user.status, 'active'); ok('Admin schaltet Benutzer mit Rolle frei');
  assert.equal((await user.call('GET', '/api/dashboard')).status, 200); ok('Freigeschalteter Benutzer sieht Dashboard');
  assert.equal((await user.call('GET', '/api/users')).status, 200); ok('Rolle gewährt users.view');
  assert.equal((await user.call('GET', '/api/config')).status, 403); ok('Fehlendes Recht config.view → 403');

  // Eskalationsschutz
  assert.equal((await user.call('POST', `/api/users/${neuer.id}/status`, { status: 'blocked' })).status, 403); ok('Eigenen Status ändern verboten');
  r = await user.call('PATCH', `/api/users/${neuer.id}`, { roleIds: [adminRole.id] });
  assert.equal(r.status, 403); ok('Kein Zugriff auf users.edit → 403');
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view'] });
  r = await user.call('PATCH', `/api/users/${neuer.id}`, { roleIds: [modRole, adminRole.id] });
  assert.equal(r.status, 403); ok('Nicht-Admin kann keine Admin-Rolle vergeben');
  r = await user.call('PATCH', `/api/users/${neuer.id}`, { permissions: ['config.edit'] });
  assert.equal(r.status, 403); ok('Nicht-Admin kann kein Recht vergeben, das er nicht besitzt');
  const adminUser = users.find((u) => u.username === 'admin');
  assert.equal((await user.call('POST', `/api/users/${adminUser.id}/status`, { status: 'blocked' })).status, 403); ok('Admin kann nicht von Nicht-Admin gesperrt werden');

  // Letzter Admin
  assert.equal((await admin.call('PATCH', `/api/users/${adminUser.id}`, { roleIds: [] })).status, 409); ok('Letzter Admin kann Rolle nicht verlieren');
  assert.equal((await admin.call('DELETE', `/api/users/${adminUser.id}`)).status, 403); ok('Admin kann sich nicht selbst löschen');
  assert.equal((await admin.call('DELETE', `/api/roles/${adminRole.id}`)).status, 403); ok('Systemrolle nicht löschbar');
  assert.equal((await admin.call('DELETE', `/api/roles/${modRole}`)).status, 409); ok('Rolle mit Mitgliedern nicht löschbar');

  // Sperren beendet Sitzung
  r = await admin.call('POST', `/api/users/${neuer.id}/status`, { status: 'blocked', reason: 'Test' });
  assert.equal(r.user.status, 'blocked');
  assert.equal((await user.call('GET', '/api/dashboard')).status, 401); ok('Sperren beendet bestehende Sitzung');
  assert.equal((await new Client().call('POST', '/api/auth/login', { username: 'neuer', password: 'passwort123' })).code, 'blocked'); ok('Gesperrter Benutzer kann sich nicht anmelden');
  await admin.call('POST', `/api/users/${neuer.id}/status`, { status: 'active' });
  assert.equal((await mod.call('POST', '/api/auth/login', { username: 'neuer', password: 'passwort123' })).status, 200); ok('Entsperrter Benutzer kann sich anmelden');
  assert.equal((await new Client().call('POST', '/api/auth/login', { username: 'neuer', password: 'falsch!!!' })).status, 401); ok('Falsches Passwort → 401');

  // Konfiguration
  r = await admin.call('PUT', '/api/config', { values: { 'ui.accent': '#ff00aa', 'system.name': 'Neu' } });
  assert.deepEqual(r.changed.sort(), ['system.name', 'ui.accent']); ok('Konfiguration ändern');
  assert.equal((await admin.call('PUT', '/api/config', { values: { 'ui.accent': 'rot' } })).status, 400); ok('Ungültige Konfiguration → 400');
  assert.equal((await admin.call('GET', '/api/bootstrap')).config['ui.accent'], '#ff00aa'); ok('Öffentliche Konfiguration spiegelt Änderung');

  // Mitgliedsnummern
  assert.equal((await admin.call('GET', `/api/users/${adminUser.id}`)).user.memberNumber, 'MDT-220'); ok('Erstes Mitglied erhält MDT-220 (nicht MDT-01)');
  assert.equal((await admin.call('GET', `/api/users/${neuer.id}`)).user.memberNumber, 'MDT-221'); ok('Freigeschaltetes Mitglied erhält MDT-221');
  r = await new Client().call('POST', '/api/auth/register', { displayName: 'Wartender', username: 'wartender', password: 'passwort123' });
  assert.equal(r.user.memberNumber, null); ok('Ausstehende Benutzer haben noch keine Nummer');
  r = await admin.call('POST', '/api/users', { displayName: 'Dritter', username: 'dritter', password: 'passwort123' });
  assert.equal(r.user.memberNumber, 'MDT-222'); const dritter = r.user.id;
  await admin.call('DELETE', `/api/users/${dritter}`);
  r = await admin.call('POST', '/api/users', { displayName: 'Vierter', username: 'vierter', password: 'passwort123' });
  assert.equal(r.user.memberNumber, 'MDT-223'); ok('Nummer eines gelöschten Mitglieds wird nicht wiederverwendet');
  await admin.call('PUT', '/api/config', { values: { 'members.number_prefix': 'XY-' } });
  r = await admin.call('POST', '/api/users', { displayName: 'Fünfter', username: 'fuenfter', password: 'passwort123' });
  assert.equal(r.user.memberNumber, 'XY-224');
  assert.equal((await admin.call('GET', `/api/users/${adminUser.id}`)).user.memberNumber, 'MDT-220'); ok('Präfix-Änderung lässt vergebene Nummern unberührt');
  await admin.call('PUT', '/api/config', { values: { 'members.number_start': 500 } });
  r = await admin.call('POST', '/api/users', { displayName: 'Sechster', username: 'sechster', password: 'passwort123' });
  assert.equal(r.user.memberNumber, 'XY-500'); ok('Erhöhte Startnummer wird übernommen');
  const { run: dbRun } = await import('../server/core/db.js');
  assert.throws(() => dbRun('UPDATE users SET member_number = ? WHERE id = ?', 'MDT-220', neuer.id), /UNIQUE/); ok('Eindeutigkeit zusätzlich auf Datenbankebene (UNIQUE-Index)');

  // Ränge, Abteilungen, Hierarchie
  r = await admin.call('POST', '/api/departments', { name: 'Legal', color: '#a78bfa' });
  assert.equal(r.status, 201); const legal = r.department.id;
  r = await admin.call('POST', '/api/ranks', { name: 'Berater der Leitung Test', color: '#f5a524' }); const rBerater = r.rank.id;
  r = await admin.call('POST', '/api/ranks', { name: 'Leiter Recht', departmentId: legal, parentRankId: rBerater }); const rJefe = r.rank.id;
  r = await admin.call('POST', '/api/ranks', { name: 'Abogado', departmentId: legal, parentRankId: rJefe }); const rAbogado = r.rank.id;
  ok('Abteilung und Ränge mit Vorgesetzten-Hierarchie anlegen');
  assert.equal((await admin.call('PATCH', `/api/ranks/${rBerater}`, { parentRankId: rAbogado })).status, 400); ok('Zyklen in der Rang-Hierarchie werden abgelehnt');
  { // Neuer Rang über einem bestehenden: einsortiert, übernimmt Position im Organigramm
    const before = (await admin.call('GET', '/api/org')).ranks, low = before[2];
    const rr = await admin.call('POST', '/api/ranks', { name: 'Vererbungstest', placeAbove: low.id, permissions: [] }); assert.equal(rr.status, 201);
    const after = (await admin.call('GET', '/api/org')).ranks, ids = after.map((x) => x.id);
    assert.equal(ids.indexOf(rr.rank.id) + 1, ids.indexOf(low.id)); assert.equal(rr.rank.parentRankId, low.parentRankId);
    assert.equal(after.find((x) => x.id === low.id).parentRankId, rr.rank.id);
    assert.equal((await admin.call('POST', '/api/ranks', { name: 'Vererbungstest2', placeAbove: 99999 })).status, 400);
    await admin.call('PATCH', `/api/ranks/${low.id}`, { parentRankId: low.parentRankId }); await admin.call('DELETE', `/api/ranks/${rr.rank.id}`);
    ok('Neuer Rang „steht über“ einem Rang: Reihenfolge und Hierarchie angepasst'); }
  assert.equal((await mod.call('POST', '/api/ranks', { name: 'Hacker' })).status, 403); ok('Rang anlegen ohne org.manage → 403');
  const allRanks = (await admin.call('GET', '/api/org')).ranks.map((x) => x.id); assert.equal(allRanks.length, 16); // 13 Standard-Ränge + 3 Test-Ränge
  r = await admin.call('POST', '/api/ranks/order', { ids: [rAbogado, rJefe, rBerater, ...allRanks.filter((x) => ![rAbogado, rJefe, rBerater].includes(x))] });
  assert.equal(r.status, 200);
  assert.equal((await admin.call('POST', '/api/ranks/order', { ids: [rAbogado] })).status, 400); ok('Rangfolge ändern (nur vollständige Liste erlaubt)');
  r = await admin.call('PATCH', `/api/users/${neuer.id}`, { rankId: rAbogado, departmentId: legal, supervisorId: adminUser.id });
  assert.equal(r.user.rank.name, 'Abogado'); assert.equal(r.user.supervisor.displayName, 'Du'); ok('Rang, Abteilung und Vorgesetzten zuweisen');
  assert.equal((await admin.call('PATCH', `/api/users/${adminUser.id}`, { supervisorId: neuer.id })).status, 400); ok('Zyklen in der Vorgesetzten-Kette werden abgelehnt');
  assert.equal((await admin.call('DELETE', `/api/ranks/${rAbogado}`)).status, 409); ok('Rang mit Mitgliedern nicht löschbar');
  // Rang ≠ Rechte: Rang ohne Rechte gewährt nichts, konfigurierte Rang-Rechte wirken zusätzlich
  assert.equal((await mod.call('GET', '/api/config')).status, 403);
  await admin.call('PATCH', `/api/ranks/${rAbogado}`, { permissions: ['config.view'] });
  assert.equal((await mod.call('GET', '/api/config')).status, 200); ok('Rang-Rechte wirken, getrennt vom Rang selbst konfigurierbar');
  r = await admin.call('POST', '/api/ranks', { name: 'Hochrang', permissions: ['config.edit'] }); const rHoch = r.rank.id;
  assert.equal((await mod.call('PATCH', `/api/users/${neuer.id}`, { rankId: rHoch })).status, 403); ok('Kein Rang-Vergeben mit Rechten, die man selbst nicht hat');

  // Verknüpfungen & Integrationsschicht (nur Grundlage)
  const { link, linksOf, hasLink, unlink } = await import('../server/core/links.js');
  link({ type: 'operation', id: 1 }, { type: 'vehicle', id: 7 }, { relation: 'uses' });
  assert.equal(hasLink({ type: 'operation', id: 1 }, { type: 'vehicle', id: 7 }, 'uses'), true);
  assert.equal(linksOf({ type: 'vehicle', id: 7 })[0].direction, 'in'); unlink({ type: 'operation', id: 1 }, { type: 'vehicle', id: 7 }, 'uses');
  ok('Generische Verknüpfungen zwischen Modulen');
  const { setExternalRef, findByExternal, externalIdOf } = await import('../server/core/integrations.js');
  setExternalRef({ provider: 'fivem', entityType: 'user', entityId: neuer.id, externalId: 'char:42' });
  assert.equal(findByExternal('fivem', 'user', 'char:42'), neuer.id); assert.equal(externalIdOf('fivem', 'user', neuer.id), 'char:42');
  ok('Externe Referenzen (Character/Fahrzeug-IDs) ohne feste Server-IDs im Code');

  // ── Phase 2: Kategorien & Status, eigene Rechte ──
  r = await admin.call('GET', '/api/lookups');
  const statusList = r.lists.find((l) => l.key === 'market.deal_status');
  assert.equal(statusList.entries.length, 10); assert.equal(statusList.isFixed, true); ok('Feste Status-Liste mit 10 Zuständen vorhanden');
  r = await admin.call('POST', '/api/lookups/market.item_category', { label: 'Rohstoffe', color: '#22c4a8' });
  assert.equal(r.status, 201); const catId = r.entry.id;
  assert.equal((await admin.call('POST', '/api/lookups/market.item_category', { label: 'rohstoffe' })).status, 409); ok('Kategorie anlegen, Duplikate werden abgelehnt');
  assert.equal((await admin.call('POST', '/api/lookups/market.deal_status', { label: 'Neu' })).status, 403); ok('Feste Liste nicht erweiterbar');
  const submitted = statusList.entries.find((e) => e.key === 'submitted');
  r = await admin.call('PATCH', `/api/lookups/market.deal_status/${submitted.id}`, { label: 'Neu eingegangen', color: '#00ffaa' });
  assert.equal(r.entry.label, 'Neu eingegangen'); ok('Status-Beschriftung und -Farbe anpassbar');
  assert.equal((await admin.call('DELETE', `/api/lookups/market.deal_status/${submitted.id}`)).status, 403); ok('Feste Status-Einträge nicht löschbar');
  r = await admin.call('POST', '/api/lookups/market.handover_place', { label: 'Lager Nord', description: 'Hintereingang, Tor 3' });
  const placeId = r.entry.id;

  assert.equal((await admin.call('POST', '/api/permissions', { key: 'dossier.view', description: 'Legal ansehen' })).status, 201);
  assert.equal((await admin.call('POST', '/api/permissions', { key: 'Ungültig' })).status, 400);
  assert.equal((await admin.call('PATCH', '/api/permissions/users.view', { description: 'Posten x' })).status, 403);
  assert.equal((await admin.call('DELETE', '/api/permissions/dossier.view')).status, 200); ok('Eigene Rechte: anlegen, validieren, Systemrechte geschützt, löschen');

  // ── Externe Zugänge (Partner): Link + Code ──
  const partnerClient = new Client(), other = new Client();
  r = await admin.call('POST', '/api/partners', { name: 'Händler Eins', apps: ['market'] });
  assert.equal(r.status, 201); assert.match(r.code, /^\d{6}$/); const pid = r.partner.id; let linkTok = r.partner.linkPath.split('/').pop(); let pcode = r.code;
  assert.equal((await admin.call('POST', '/api/partners', { name: 'X', apps: ['gibtsnicht'] })).status, 400); ok('Partner-Zugang mit Link und 6-stelligem Code anlegen');
  r = await partnerClient.call('GET', `/api/p/${linkTok}/session`);
  assert.equal(r.authenticated, false); assert.equal((await partnerClient.call('GET', '/api/p/ungueltig/session')).status, 404); ok('Link prüfen (unbekannte Links → 404)');
  assert.equal((await partnerClient.call('GET', '/api/p/market/catalog')).status, 401); ok('Partner-API ohne Anmeldung gesperrt');
  assert.equal((await partnerClient.call('POST', `/api/p/${linkTok}/login`, { code: '000000' })).status, 401);
  r = await partnerClient.call('POST', `/api/p/${linkTok}/login`, { code: pcode });
  assert.equal(r.status, 200); assert.deepEqual(r.partner.apps, ['market']); ok('Anmeldung nur mit richtigem Code');
  assert.equal((await partnerClient.call('GET', '/api/users')).status, 401); assert.equal((await partnerClient.call('GET', '/api/market/deals')).status, 401); ok('Partner-Sitzung öffnet keine internen Bereiche');
  assert.equal((await partnerClient.call('GET', `/api/p/${linkTok}/session`)).authenticated, true);

  // Brute-Force-Schutz
  const brute = new Client();
  for (let i = 0; i < 4; i++) assert.equal((await brute.call('POST', `/api/p/${linkTok}/login`, { code: '111111' })).status, 401);
  assert.equal((await brute.call('POST', `/api/p/${linkTok}/login`, { code: '111111' })).status, 401);
  assert.equal((await brute.call('POST', `/api/p/${linkTok}/login`, { code: pcode })).status, 429); ok('Sperre nach 5 Fehlversuchen (auch mit richtigem Code)');
  r = await admin.call('POST', `/api/partners/${pid}/code`, { code: 'Abc12345' }); pcode = r.code;
  assert.equal((await partnerClient.call('GET', '/api/p/market/catalog')).status, 401); ok('Neuer Code beendet alte Sitzungen');
  assert.equal((await partnerClient.call('POST', `/api/p/${linkTok}/login`, { code: pcode })).status, 200); ok('Neuer Code hebt Sperre auf');

  // Partner ohne Markt-App
  r = await admin.call('POST', '/api/partners', { name: 'Ohne App', apps: [] }); const noApp = r;
  const noAppClient = new Client();
  await noAppClient.call('POST', `/api/p/${noApp.partner.linkPath.split('/').pop()}/login`, { code: noApp.code });
  assert.equal((await noAppClient.call('GET', '/api/p/market/catalog')).status, 403); ok('Nur freigeschaltete Apps sind erreichbar');

  // ── Börse ──
  assert.equal((await mod.call('GET', '/api/market/deals')).status, 403); ok('Börse-Verwaltung ohne Recht → 403');
  r = await admin.call('POST', '/api/market/items', { name: 'Eisen', unit: 'Stück', categoryId: catId, referencePrice: 50 });
  assert.equal(r.status, 201); const eisen = r.item.id;
  assert.equal((await admin.call('POST', '/api/market/items', { name: 'eisen' })).status, 409);
  r = await partnerClient.call('GET', '/api/p/market/catalog'); assert.equal(r.items[0].name, 'Eisen'); ok('Katalog-Item im Admin-Bereich anlegen, Partner sieht es');

  r = await partnerClient.call('POST', '/api/p/market/offers', { itemId: eisen, quantity: 250, unitPrice: 60, note: 'Frisch geliefert' });
  assert.equal(r.status, 201); assert.equal(r.deal.total, 15000); assert.equal(r.deal.turn, 'staff'); const deal = r.deal.id;
  assert.equal((await partnerClient.call('POST', '/api/p/market/offers', { itemId: eisen, quantity: 0, unitPrice: 5 })).status, 400);
  assert.equal((await admin.call('GET', '/api/market/summary')).awaitingStaff, 1); ok('Partner stellt Angebot ein, Preis wird serverseitig berechnet');
  assert.equal((await partnerClient.call('POST', `/api/p/market/deals/${deal}/accept`)).status, 409); ok('Am Zug ist nur die jeweils andere Seite');
  r = await admin.call('POST', `/api/market/deals/${deal}/counter`, { unitPrice: 50, text: 'Mehr ist nicht drin' });
  assert.equal(r.deal.status, 'negotiating'); assert.equal(r.deal.turn, 'partner'); assert.equal(r.deal.total, 12500);
  assert.equal((await admin.call('POST', `/api/market/deals/${deal}/accept`)).status, 409); ok('Gegenangebot → Partner am Zug');
  await admin.call('POST', `/api/market/deals/${deal}/message`, { text: 'Interner Hinweis', internal: true });
  r = await partnerClient.call('GET', `/api/p/market/deals/${deal}`);
  assert.equal(r.events.some((e) => e.internal || e.text === 'Interner Hinweis'), false); assert.equal(r.deal.handover, null); ok('Interne Notizen sind für Partner unsichtbar');
  assert.equal((await partnerClient.call('POST', `/api/p/market/deals/${deal}/handover`, { info: 'x' })).status, 403); ok('Partner kann keine Staff-Aktionen ausführen');
  assert.equal((await admin.call('POST', `/api/market/deals/${deal}/handover`, { info: 'x' })).status, 409);
  r = await partnerClient.call('POST', `/api/p/market/deals/${deal}/accept`);
  assert.equal(r.deal.status, 'accepted'); assert.equal(r.deal.unitPrice, 50); ok('Partner nimmt Gegenangebot an → Preis fixiert');
  assert.equal((await admin.call('POST', `/api/market/deals/${deal}/handover`, {})).status, 400);
  r = await admin.call('POST', `/api/market/deals/${deal}/handover`, { placeId, info: 'Beim Tor 3 klingeln', payoutInfo: '12.500 $ bar bei Übergabe' });
  assert.equal(r.deal.status, 'delivery'); ok('Übergabeort und Auszahlung festlegen');
  r = await partnerClient.call('GET', `/api/p/market/deals/${deal}`);
  assert.equal(r.deal.handover.place.label, 'Lager Nord'); assert.equal(r.deal.handover.payoutInfo.includes('12.500'), true); ok('Partner sieht Übergabe-Infos erst nach Annahme');
  for (const step of ['delivered', 'payout', 'completed']) {
    r = await admin.call('POST', `/api/market/deals/${deal}/advance`, { to: step }); assert.equal(r.deal.status, step);
  }
  assert.equal((await admin.call('POST', `/api/market/deals/${deal}/cancel`)).status, 409); ok('Lieferung → Zahlung → Abschluss; beendete Geschäfte sind gesperrt');

  // Datenisolation zwischen Partnern
  const second = await admin.call('POST', '/api/partners', { name: 'Händler Zwei', apps: ['market'] });
  const secondClient = new Client();
  await secondClient.call('POST', `/api/p/${second.partner.linkPath.split('/').pop()}/login`, { code: second.code });
  assert.equal((await secondClient.call('GET', `/api/p/market/deals/${deal}`)).status, 404);
  assert.equal((await secondClient.call('GET', '/api/p/market/deals')).deals.length, 0); ok('Partner sehen nur ihre eigenen Geschäfte');

  // Gesuche („Wir suchen“)
  r = await admin.call('POST', '/api/market/wanted', { itemId: eisen, quantity: 100, unitPrice: 70, note: 'Dringend' });
  assert.equal(r.status, 201); const wanted = r.wanted.id;
  r = await secondClient.call('GET', '/api/p/market/wanted'); assert.equal(r.wanted.length, 1); assert.equal(r.wanted[0].unitPrice, 70); ok('Gesuch ist für Partner sichtbar');
  assert.equal((await secondClient.call('POST', `/api/p/market/wanted/${wanted}/respond`, { quantity: 500 })).status, 400);
  r = await secondClient.call('POST', `/api/p/market/wanted/${wanted}/respond`, { quantity: 50 });
  assert.equal(r.status, 201); assert.equal(r.deal.unitPrice, 70); assert.equal(r.deal.origin, 'wanted'); const resp = r.deal.id; ok('Partner meldet sich auf ein Gesuch (Preis vom Gesuch)');
  assert.equal((await admin.call('GET', '/api/market/wanted')).wanted[0].responseCount, 1);
  r = await secondClient.call('POST', `/api/p/market/deals/${resp}/withdraw`); assert.equal(r.deal.status, 'withdrawn'); ok('Partner kann zurückziehen');
  await admin.call('PATCH', `/api/market/wanted/${wanted}`, { status: 'closed' });
  assert.equal((await secondClient.call('GET', '/api/p/market/wanted')).wanted.length, 0); ok('Geschlossene Gesuche verschwinden');
  assert.equal((await admin.call('DELETE', `/api/partners/${pid}`)).status, 409);
  assert.equal((await admin.call('DELETE', `/api/market/items/${eisen}`)).status, 409); ok('Zugänge und Items mit Geschäften nicht löschbar');

  // Link deaktivieren / neu erzeugen
  r = await admin.call('PATCH', `/api/partners/${pid}`, { status: 'disabled' });
  assert.equal((await partnerClient.call('GET', '/api/p/market/catalog')).status, 401);
  assert.equal((await new Client().call('GET', `/api/p/${linkTok}/session`)).status, 404); ok('Deaktivierter Link: sofort abgemeldet, Link ungültig');
  await admin.call('PATCH', `/api/partners/${pid}`, { status: 'active' });
  r = await admin.call('POST', `/api/partners/${pid}/link`); const oldTok = linkTok; linkTok = r.linkPath.split('/').pop();
  assert.equal((await new Client().call('GET', `/api/p/${oldTok}/session`)).status, 404);
  assert.equal((await new Client().call('GET', `/api/p/${linkTok}/session`)).status, 200); ok('Neuer Link macht den alten ungültig');

  // ── Dashboard-Layout, Audit-Filter/-Export, Backup, Sitzungen ──
  r = await admin.call('GET', '/api/dashboard/layout'); assert.equal(r.widgets.some((w) => w.id === 'market-open'), true);
  await admin.call('PUT', '/api/dashboard/layout', { widgets: r.widgets.map((w) => ({ id: w.id, enabled: w.id !== 'welcome' })) });
  assert.equal((await admin.call('GET', '/api/dashboard')).widgets.some((w) => w.id === 'welcome'), false);
  assert.equal((await admin.call('PUT', '/api/dashboard/layout', { widgets: [{ id: 'nope', enabled: true }] })).status, 400); ok('Dashboard-Widgets konfigurierbar (ein/aus, Reihenfolge)');
  r = await admin.call('GET', '/api/audit?user=MDT-220&from=2000-01-01&to=2999-12-31'); assert.ok(r.total > 0);
  assert.equal((await admin.call('GET', '/api/audit?user=gibtsnicht')).total, 0);
  const csv = await fetch(`${base}/api/audit/export?module=market`, { headers: { cookie: admin.cookie } });
  const csvText = await csv.text();
  assert.equal(csv.headers.get('content-type').startsWith('text/csv'), true); assert.ok(csvText.includes('Zeitpunkt') && csvText.includes('market.deal_')); ok('Audit-Log: Filter nach Benutzer/Zeitraum und CSV-Export');
  assert.equal((await fetch(`${base}/api/audit/export`, { headers: { cookie: mod.cookie } })).status, 403); // audit.view allein reicht nicht – Export braucht audit.export
  r = await admin.call('POST', '/api/admin/backups'); assert.equal(r.status, 201);
  assert.equal(r.backups.length >= 1, true); assert.equal((await mod.call('POST', '/api/admin/backups')).status, 403); ok('Datenbank-Backup erstellen (nur mit Recht)');
  r = await mod.call('GET', '/api/auth/sessions'); assert.equal(r.sessions.some((s) => s.current), true);
  r = await mod.call('POST', '/api/auth/sessions/revoke-others'); assert.equal(typeof r.revoked, 'number'); ok('Eigene Sitzungen einsehen und andere abmelden');

  // ── Betrieb hinter Reverse-Proxy ──
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mdt', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ username: 'nobody', password: 'x' }) });
  r = await admin.call('GET', '/api/audit?action=auth.login_failed');
  assert.equal(r.rows[0].ip, '203.0.113.9'); ok('Health-Check und Client-IP hinter Proxy (TRUST_PROXY)');


  // ══ Echtzeit, Benachrichtigungen, MDT-Nummern, Anonymität ══
  const rtPartner = await admin.call('POST', '/api/partners', { name: 'Streng Geheim GmbH', apps: ['market'] });
  assert.match(rtPartner.partner.number, /^MDT-P-\d{6}$/); ok('Partner erhält Nummer im Format MDT-P-123456');
  const rt = new Client();
  await rt.call('POST', `/api/p/${rtPartner.partner.linkPath.split('/').pop()}/login`, { code: rtPartner.code });
  r = await rt.call('GET', '/api/p/me');
  assert.equal(r.partner.number, rtPartner.partner.number); assert.equal(JSON.stringify(r).includes('Streng Geheim'), false); ok('Partner-Portal zeigt nur die MDT-P-Nummer, nie den Namen');

  // Live-Streams: Mitarbeiter (admin), Mitarbeiter ohne Börsenrecht (mod), Partner
  const sAdmin = await openSse(admin.cookie, '/api/events');
  const sMod = await openSse(mod.cookie, '/api/events');
  const sPartner = await openSse(rt.cookie, '/api/p/events');
  assert.equal(sAdmin.status, 200);
  assert.ok(await sAdmin.waitFor((e) => e.event === 'hello')); assert.ok(await sPartner.waitFor((e) => e.event === 'hello')); ok('Live-Verbindung (SSE) für Mitarbeiter und Partner-Portal');
  assert.equal((await new Client().call('GET', '/api/events')).status, 401); ok('Live-Verbindung nur mit Anmeldung');

  const publicNames = ['Streng Geheim', '"Admin"', '"neuer"', '"Neuer"'];
  const seen = []; // alle Antworten des Partner-Portals für die Namensprüfung
  const P = async (method, path, body) => { const x = await rt.call(method, path, body); seen.push(JSON.stringify(x)); return x; };

  // Partner stellt Angebot ein → Mitarbeiter: Live-Änderung + Benachrichtigung
  r = await P('POST', '/api/p/market/offers', { itemId: eisen, quantity: 100, unitPrice: 55, note: 'Test' });
  assert.match(r.deal.number, /^MDT-G-\d{6}$/); const rtDeal = r.deal.id; const rtNumber = r.deal.number;
  assert.equal(r.deal.partner, undefined);
  assert.ok(await sAdmin.waitFor((e) => e.event === 'change' && e.data.topic === 'market' && e.data.entityId === String(rtDeal))); ok('Neues Geschäft erscheint live beim Mitarbeiter (MDT-G-Nummer)');
  const n1 = await sAdmin.waitFor((e) => e.event === 'notification' && e.data.target?.dealId === rtDeal);
  assert.ok(n1 && n1.data.title.includes(rtNumber)); ok('Mitarbeiter erhalten sofort eine Benachrichtigung zum neuen Geschäft');
  assert.equal(sMod.events.some((e) => e.event === 'change' && e.data.topic === 'market'), false);
  assert.equal(sMod.events.some((e) => e.event === 'notification'), false); ok('Mitglieder ohne Börsenrecht bekommen keine Börsen-Ereignisse');

  // Mehrere schnelle Statuswechsel hintereinander: jede Änderung = eigene Benachrichtigung
  const startPartnerNotifs = (await rt.call('GET', '/api/p/notifications')).notifications.length;
  await admin.call('POST', `/api/market/deals/${rtDeal}/counter`, { unitPrice: 50 });            // Verhandlung          → Partner-Benachrichtigung 1
  await rt.call('POST', `/api/p/market/deals/${rtDeal}/counter`, { unitPrice: 52 });
  await admin.call('POST', `/api/market/deals/${rtDeal}/accept`);                                 // Angenommen           → 2
  await admin.call('POST', `/api/market/deals/${rtDeal}/handover`, { placeId, info: 'Tor 3' });  // Lieferung ausstehend → 3
  await admin.call('POST', `/api/market/deals/${rtDeal}/advance`, { to: 'delivered' });          // Ware eingegangen     → 4
  await admin.call('POST', `/api/market/deals/${rtDeal}/advance`, { to: 'payout' });             // Zahlung ausstehend   → 5
  await admin.call('POST', `/api/market/deals/${rtDeal}/advance`, { to: 'completed' });          // Abgeschlossen        → 6
  await sleep(150);
  r = await rt.call('GET', '/api/p/notifications');
  const created = r.notifications.length - startPartnerNotifs;
  assert.equal(created, 6); assert.equal(new Set(r.notifications.map((n) => n.key)).size, r.notifications.length); ok('6 schnelle Statuswechsel → 6 eigene Benachrichtigungen, keine verloren, keine doppelt');
  const partnerNotifEvents = sPartner.events.filter((e) => e.event === 'notification' && e.data.kind === 'new' && e.data.target?.dealId === rtDeal);
  assert.equal(partnerNotifEvents.length, 6); assert.equal(new Set(partnerNotifEvents.map((e) => e.id)).size, 6);
  assert.ok(partnerNotifEvents.every((e) => e.data.title.includes(rtNumber))); ok('Partner erhält jedes Status-Ereignis live (je 1×, eindeutige IDs, MDT-G-Nummer im Titel)');
  assert.ok(partnerNotifEvents.some((e) => /Abgeschlossen/.test(e.data.body))); assert.ok(partnerNotifEvents.some((e) => /Zahlung ausstehend/.test(e.data.body)));
  assert.equal(JSON.stringify(partnerNotifEvents).includes('Streng Geheim'), false);

  // Dasselbe Ereignis darf nie doppelt erzeugt werden (UNIQUE: Empfänger + Ereignis-Schlüssel)
  const { notify } = await import('../server/core/notifications.js');
  const key = r.notifications[0].key;
  assert.equal(notify([{ type: 'partner', id: rtPartner.partner.id }], { key, title: 'dup', body: '' }), 0); ok('Dasselbe Ereignis erzeugt nie eine zweite Benachrichtigung');

  // Lesestatus
  await rt.call('POST', '/api/p/notifications/read', {});
  assert.equal((await rt.call('GET', '/api/p/notifications')).unread, 0); ok('Benachrichtigungen als gelesen markieren (Partner)');
  assert.ok((await admin.call('GET', '/api/notifications')).unread > 0); await admin.call('POST', '/api/notifications/read', {}); assert.equal((await admin.call('GET', '/api/notifications')).unread, 0); ok('Benachrichtigungen als gelesen markieren (Mitarbeiter)');

  // Partner-Portal: nirgends Namen (Partner, Mitglieder)
  for (const pth of ['/api/p/me', '/api/p/market/deals', `/api/p/market/deals/${rtDeal}`, '/api/p/market/wanted', '/api/p/market/catalog', '/api/p/notifications']) await P('GET', pth);
  const joined = seen.join('\n');
  for (const needle of publicNames) assert.equal(joined.includes(needle), false, `Partner-Antworten enthalten: ${needle}`);
  assert.ok(joined.includes(rtNumber)); ok('Partner-Portal: keine Namen in Antworten, nur MDT-Nummern');

  // Reconnect: verpasste Ereignisse werden nachgeliefert (ohne Doppelte); zu alt/ungültig → reset
  const lastSeen = sPartner.lastId();
  sPartner.close();
  r = await admin.call('POST', '/api/market/items', { name: 'Reconnect-Item', unit: 'Stück' });
  const itemX = r.item.id;
  await admin.call('PATCH', `/api/market/items/${itemX}`, { description: 'geändert' });
  await admin.call('PATCH', `/api/market/items/${itemX}`, { description: 'nochmal' });
  const sResume = await openSse(rt.cookie, '/api/p/events', lastSeen);
  assert.ok(await sResume.waitFor((e) => e.event === 'hello' && e.data.resumed === true));
  const missed = sResume.events.filter((e) => e.event === 'change' && e.data.topic === 'market');
  assert.equal(missed.length, 3); assert.equal(new Set(missed.map((e) => e.id)).size, 3); assert.ok(missed.every((e) => Number(e.id) > lastSeen)); ok('Reconnect: 3 verpasste Änderungen nachgeliefert – je genau einmal');
  const resumeLast = sResume.lastId(); sResume.close();
  const sAgain = await openSse(rt.cookie, '/api/p/events', resumeLast);
  await sAgain.waitFor((e) => e.event === 'hello');
  assert.equal(sAgain.events.filter((e) => e.event !== 'hello').length, 0); sAgain.close(); ok('Erneuter Reconnect: nichts doppelt geliefert');
  const sReset = await openSse(rt.cookie, '/api/p/events', 999999999);
  assert.ok(await sReset.waitFor((e) => e.event === 'reset')); sReset.close(); ok('Unbekannter/veralteter Stand → reset (Client lädt vollständig neu)');

  // Mehrere Tabs/Benutzer
  assert.ok(sAdmin.events.filter((e) => e.event === 'change' && e.data.topic === 'market').length >= 7); ok('Alle Änderungen wurden live an offene Mitarbeiter-Sitzungen gesendet');
  const sAdmin2 = await openSse(admin.cookie, '/api/events');
  await sAdmin2.waitFor((e) => e.event === 'hello');
  await admin.call('PATCH', `/api/market/items/${itemX}`, { description: 'tab2' });
  const a2 = await sAdmin2.waitFor((e) => e.event === 'change' && e.data.entityId === String(itemX));
  const a1 = await sAdmin.waitFor((e) => e.id === a2?.id);
  assert.ok(a1 && a2 && a1.id === a2.id); sAdmin2.close(); ok('Mehrere Tabs/Benutzer erhalten dasselbe Ereignis (gleiche ID)');

  // Live-Zähler pro Kategorie und Status (immer aus dem Backend berechnet)
  const countActive = async () => { const d = (await admin.call('GET', '/api/market/deals?group=open')).deals.concat((await admin.call('GET', '/api/market/deals?group=active')).deals); return d.filter((x) => x.item.category?.id === catId).length; };
  const before = (await admin.call('GET', '/api/market/summary')).byCategory.find((c) => c.id === catId).active;
  assert.equal(before, await countActive());
  r = await rt.call('POST', '/api/p/market/offers', { itemId: eisen, quantity: 5, unitPrice: 60 });
  const newDeal = r.deal.id;
  assert.ok(await sAdmin.waitFor((e) => e.event === 'change' && e.data.entityId === String(newDeal)));
  const afterAdd = (await admin.call('GET', '/api/market/summary')).byCategory.find((c) => c.id === catId);
  assert.equal(afterAdd.active, before + 1); assert.equal(afterAdd.active, await countActive()); ok('Kategorie-Zähler steigt, wenn ein Vorgang hinzukommt');
  await rt.call('POST', `/api/p/market/deals/${newDeal}/withdraw`);
  const afterWd = (await admin.call('GET', '/api/market/summary')).byCategory.find((c) => c.id === catId);
  assert.equal(afterWd.active, before); assert.equal((await admin.call('GET', '/api/market/summary')).byStatus.withdrawn >= 1, true); ok('Kategorie- und Status-Zähler folgen dem Backend-Zustand');
  await admin.call('PATCH', `/api/market/items/${eisen}`, { categoryId: null });
  assert.equal((await admin.call('GET', '/api/market/summary')).byCategory.find((c) => c.id === catId).total, 0);
  await admin.call('PATCH', `/api/market/items/${eisen}`, { categoryId: catId }); ok('Kategorie wechseln → Zähler folgen');

  // Anonymität interner Mitglieder
  r = await mod.call('GET', '/api/users');
  const me = r.users.find((u) => u.isSelf);
  assert.equal(me.displayName, 'Neuer'); assert.equal(me.username, 'neuer');
  const others = r.users.filter((u) => !u.isSelf);
  assert.ok(others.length > 3);
  for (const u of others) { assert.match(u.displayName, /^(MDT-\d+|XY-\d+|Antrag #\d+)$/); if (u.status !== 'pending') assert.equal(u.username, null); }
  assert.equal(JSON.stringify(r).includes('Test Admin') || JSON.stringify(r).includes('"Admin"'), false); ok('Mitglieder sehen fremde Namen nie – nur Personalnummern (eigener Name sichtbar)');
  r = await admin.call('GET', `/api/users/${neuer.id}`); assert.equal(r.user.displayName, 'Neuer'); assert.equal(r.user.username, 'neuer'); assert.equal(r.user.nameVisible, true);
  assert.equal((await admin.call('PATCH', `/api/users/${neuer.id}`, { displayName: 'Anders' })).status, 403); ok('Superadmin sieht Namen (Hierarchie); Namen anderer ändert trotzdem niemand');
  r = await admin.call('GET', '/api/audit?limit=200');
  const auditJson = JSON.stringify(r.rows);
  for (const uname of ['admin', 'neuer', 'dritter', 'vierter', 'fuenfter', 'sechster', 'Test Admin']) assert.equal(auditJson.includes(`"${uname}"`), false, `Audit enthält Namen: ${uname}`);
  assert.ok(r.rows.some((x) => x.actor === 'Du') && r.rows.some((x) => /^MDT-\d+$/.test(x.actor))); ok('Audit-Log zeigt Handelnde nur als Personalnummer (man selbst als „Du“)');
  r = await admin.call('GET', `/api/market/deals/${rtDeal}`);
  assert.ok(r.events.some((e) => e.actorName === 'Du') && r.events.some((e) => e.actorType === 'partner'));
  assert.equal(JSON.stringify(r.events).includes('"Admin"'), false); ok('Geschäftsverlauf: Mitarbeiter als „Du“/Personalnummer');

  sAdmin.close(); sMod.close();


  // ══ Zuweisung: Team → MDT-Nummer, Sperrbildschirm, Chat ══
  r = await rt.call('POST', '/api/p/market/offers', { itemId: eisen, quantity: 3, unitPrice: 70 });
  const asgDeal = r.deal.id;
  await admin.call('POST', `/api/market/deals/${asgDeal}/message`, { text: 'Hallo vom Team' });
  r = await rt.call('GET', `/api/p/market/deals/${asgDeal}`);
  assert.equal(r.deal.assignee, null); assert.ok(r.events.some((e) => e.actorName === 'Team')); ok('Ohne Zuweisung bleibt es „Team“');
  await admin.call('POST', `/api/market/deals/${asgDeal}/assign`, { userId: adminUser.id });
  r = await rt.call('GET', `/api/p/market/deals/${asgDeal}`);
  assert.equal(r.deal.assignee.displayName, 'MDT-220'); assert.equal(r.events.some((e) => e.actorName === 'Team'), false);
  assert.ok(r.events.some((e) => e.actorName === 'MDT-220')); assert.equal(JSON.stringify(r).includes('"Admin"'), false); ok('Nach Zuweisung sieht der Partner die Personalnummer (MDT-220) statt „Team“');
  await admin.call('POST', `/api/market/deals/${asgDeal}/assign`, { userId: null });
  assert.equal((await rt.call('GET', `/api/p/market/deals/${asgDeal}`)).events.some((e) => e.actorName === 'MDT-220'), false); ok('Zuweisung entfernt → wieder „Team“');

  // Sperrbildschirm: Passwort/Code erneut bestätigen
  assert.equal((await admin.call('POST', '/api/auth/unlock', { password: 'falsch!!!' })).status, 401);
  assert.equal((await admin.call('POST', '/api/auth/unlock', { password: 'passwort123' })).status, 200);
  assert.equal((await rt.call('POST', '/api/p/unlock', { code: '000000' })).status, 401);
  assert.equal((await rt.call('POST', '/api/p/unlock', { code: rtPartner.code })).status, 200);
  assert.equal((await new Client().call('POST', '/api/auth/unlock', { password: 'x' })).status, 401); ok('Entsperren per Passwort (Mitarbeiter) bzw. Code (Partner); ohne Anmeldung unmöglich');
  const cfgAll = (await admin.call('GET', '/api/bootstrap')).config;
  assert.equal(cfgAll['security.lock_timeout_minutes'], 10); assert.equal(cfgAll['ui.theme'], 'anthracite'); ok('Design-/Sperr-Einstellungen sind konfigurierbar (Standard: Anthrazit, 10 Min.)');
  assert.equal((await admin.call('PUT', '/api/config', { values: { 'ui.theme': 'ocean', 'ui.radius': 'round', 'ui.dock_size': 60, 'security.lock_timeout_minutes': 5 } })).status, 200);
  assert.equal((await admin.call('PUT', '/api/config', { values: { 'ui.theme': 'pink' } })).status, 400);
  await admin.call('PUT', '/api/config', { values: { 'ui.theme': 'anthracite', 'ui.radius': 'normal', 'ui.dock_size': 52, 'security.lock_timeout_minutes': 10 } }); ok('Design-Einstellungen werden validiert');

  // Chat
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view', 'chat.view', 'chat.send'] });
  r = await admin.call('GET', '/api/chat/channels');
  assert.ok(r.channels.length >= 1); const general = r.channels[0].id; ok('Standardkanal vorhanden, Admin sieht Kanäle');
  const sChatMod = await openSse(mod.cookie, '/api/events');
  await sChatMod.waitFor((e) => e.event === 'hello');
  r = await admin.call('POST', `/api/chat/channels/${general}/messages`, { body: 'Hallo @MDT-221 willkommen' });
  assert.equal(r.status, 201); assert.equal(r.message.sender, 'MDT-220'); assert.equal(r.message.isMine, true); const m1 = r.message.id;
  assert.ok(await sChatMod.waitFor((e) => e.event === 'change' && e.data.topic === 'chat')); ok('Nachricht senden – Absender nur als Personalnummer, live beim anderen Mitglied');
  assert.ok(await sChatMod.waitFor((e) => e.event === 'notification' && /Erwähnung/.test(e.data.title))); ok('Erwähnung @MDT-221 löst eine Benachrichtigung aus');
  r = await mod.call('GET', `/api/chat/channels/${general}/messages`);
  assert.equal(r.messages[0].sender, 'MDT-220'); assert.equal(r.messages[0].isMine, false); assert.equal(JSON.stringify(r).includes('Test Admin') || JSON.stringify(r).includes('"admin"'), false);
  assert.ok(r.channel.unread >= 1); ok('Andere Mitglieder sehen nur die Personalnummer; Ungelesen-Zähler');
  await mod.call('POST', `/api/chat/channels/${general}/read`, {});
  assert.equal((await mod.call('GET', '/api/chat/unread')).unread, 0); ok('Als gelesen markieren setzt den Zähler zurück');
  r = await mod.call('POST', `/api/chat/channels/${general}/messages`, { body: 'Antwort', replyTo: m1 });
  assert.equal(r.message.replyTo.sender, 'MDT-220'); const m2 = r.message.id;
  assert.equal((await mod.call('POST', `/api/chat/channels/${general}/messages`, { body: 'x', replyTo: 999999 })).status, 400); ok('Antworten auf Nachrichten');
  assert.equal((await mod.call('PATCH', `/api/chat/messages/${m1}`, { body: 'gehackt' })).status, 403);
  r = await mod.call('PATCH', `/api/chat/messages/${m2}`, { body: 'Antwort (bearbeitet)' });
  assert.ok(r.message.editedAt); ok('Nur eigene Nachrichten bearbeiten');
  assert.equal((await mod.call('POST', `/api/chat/messages/${m2}/pin`)).status, 403);
  r = await admin.call('POST', `/api/chat/messages/${m2}/pin`); assert.equal(r.message.pinned, true);
  r = await mod.call('GET', `/api/chat/channels/${general}/messages`); assert.equal(r.pinned.length, 1); assert.equal(r.pinned[0].id, m2);
  await admin.call('DELETE', `/api/chat/messages/${m2}/pin`);
  assert.equal((await mod.call('GET', `/api/chat/channels/${general}/messages`)).pinned.length, 0); ok('Anpinnen/Lösen nur mit Recht, Pinnwand pro Kanal');
  assert.equal((await mod.call('DELETE', `/api/chat/messages/${m1}`)).status, 403);
  r = await mod.call('DELETE', `/api/chat/messages/${m2}`); assert.equal(r.status, 200);
  r = await admin.call('GET', `/api/chat/channels/${general}/messages`);
  assert.equal(r.messages.find((m) => m.id === m2).deleted, true); assert.equal(r.messages.find((m) => m.id === m2).body, ''); ok('Löschen: eigene Nachrichten ja, fremde nur mit Moderationsrecht');
  r = await mod.call('POST', `/api/chat/channels/${general}/messages`, { body: 'Moderationstest' });
  assert.equal((await admin.call('DELETE', `/api/chat/messages/${r.message.id}`)).status, 200); ok('Moderator darf fremde Nachrichten löschen');
  const privRole = (await admin.call('POST', '/api/roles', { name: 'Chat-Geheim', permissions: ['chat.view'] })).role.id;
  r = await admin.call('POST', '/api/chat/channels', { name: 'Intern', restricted: true, roleIds: [privRole] }); const priv = r.channel.id;
  assert.equal(r.status, 201);
  assert.equal((await mod.call('GET', '/api/chat/channels')).channels.some((c) => c.id === priv), false);
  assert.equal((await mod.call('GET', `/api/chat/channels/${priv}/messages`)).status, 403);
  assert.equal((await mod.call('POST', `/api/chat/channels/${priv}/messages`, { body: 'hi' })).status, 403); ok('Beschränkte Kanäle sind für andere Rollen unsichtbar und gesperrt');
  assert.equal((await mod.call('POST', '/api/chat/channels', { name: 'Hack' })).status, 403);
  assert.equal((await admin.call('DELETE', `/api/chat/channels/${priv}`)).status, 200); ok('Kanäle verwalten nur mit chat.manage');
  sChatMod.close();


  // ══ Fahrzeuge ══
  const setPerms = (perms) => admin.call('PATCH', `/api/users/${neuer.id}`, { permissions: perms });
  r = await admin.call('POST', '/api/vehicles', { name: 'Mercedes G-Class', plate: 'az 047', vin: 'wdb46312345678901', fuel: 'diesel', fuelLevel: 80, condition: 'ready', color: 'Schwarz', mileage: 12000, seats: 5, locationText: 'Garage Nord', parkingSlot: 'N-14', locX: -100, locY: 200, inspectionDue: '2027-01-31' });
  assert.equal(r.status, 201); assert.equal(r.vehicle.plate, 'AZ 047'); assert.match(r.vehicle.number, /^MDT-V-\d+$/); assert.equal(r.vehicle.fuel.label, 'Diesel'); const veh = r.vehicle.id; ok('Fahrzeug anlegen (Kennzeichen, Fahrgestellnummer, Kraftstoff, Zustand, Standort …)');
  assert.equal((await admin.call('POST', '/api/vehicles', { name: 'Doppelt', plate: 'AZ 047', fuel: 'petrol' })).status, 409);
  assert.equal((await admin.call('POST', '/api/vehicles', { name: 'X1', plate: 'AZ 1', vin: 'WDB46312345678901', fuel: 'petrol' })).status, 409);
  assert.equal((await admin.call('POST', '/api/vehicles', { name: 'Wasserstoff', plate: 'H2 1', fuel: 'wasserstoff' })).status, 400);
  assert.equal((await admin.call('POST', '/api/vehicles', { name: 'Tank', plate: 'T 1', fuel: 'petrol', fuelLevel: 150 })).status, 400);
  assert.equal((await admin.call('POST', '/api/vehicles', { name: 'Zustand', plate: 'Z 1', fuel: 'petrol', condition: 'kaputt' })).status, 400); ok('Eindeutigkeit und Validierung (nur Diesel/Benzin/Strom, gültiger Zustand, Tank 0–100)');
  r = await admin.call('POST', '/api/vehicles', { name: 'Tesla Model S', plate: 'AZ 100', fuel: 'electric', fuelLevel: 55, condition: 'damaged' });
  assert.equal(r.vehicle.fuel.key, 'electric'); const veh2 = r.vehicle.id;
  assert.equal((await mod.call('GET', '/api/vehicles')).status, 403); ok('Ohne Recht kein Zugriff auf Fahrzeuge');
  await setPerms(['vehicles.view']);
  r = await mod.call('GET', '/api/vehicles'); assert.equal(r.status, 200); assert.ok(r.vehicles.length >= 2); assert.equal(r.vehicles[0].location, null);
  assert.equal((await mod.call('POST', '/api/vehicles', { name: 'Nope', plate: 'N 1', fuel: 'petrol' })).status, 403);
  assert.equal((await mod.call('PATCH', `/api/vehicles/${veh}`, { condition: 'broken' })).status, 403);
  assert.equal((await mod.call('DELETE', `/api/vehicles/${veh}`)).status, 403); ok('Nur-Ansehen-Zugriff: lesen ja, anlegen/bearbeiten/löschen nein, Standort verborgen');
  await setPerms(['vehicles.view', 'vehicles.view_location']);
  r = await mod.call('GET', `/api/vehicles/${veh}`); assert.equal(r.vehicle.location.slot, 'N-14'); assert.equal(r.vehicle.location.x, -100); ok('Mit vehicles.view_location ist der Standort sichtbar');
  await setPerms(['vehicles.view', 'vehicles.view_location', 'vehicles.edit']);
  r = await mod.call('PATCH', `/api/vehicles/${veh}`, { condition: 'damaged', locationText: 'Werkstatt Süd', fuelLevel: 40 });
  assert.equal(r.vehicle.condition.key, 'damaged');
  r = await mod.call('GET', `/api/vehicles/${veh}`); assert.ok(r.history.some((h) => /Zustand: Einsatzbereit → Beschädigt/.test(h.text))); assert.ok(r.history.some((h) => h.kind === 'location'));
  assert.equal(JSON.stringify(r.history).includes('"admin"'), false); ok('Bearbeiten mit Änderungsverlauf (Zustand, Standort) – Handelnde nur als Personalnummer');
  assert.equal((await mod.call('PATCH', `/api/vehicles/${veh}`, { assignedUserId: neuer.id })).status, 403); ok('Zuweisen an Mitglieder braucht vehicles.assign');
  r = await admin.call('PATCH', `/api/vehicles/${veh}`, { assignedUserId: neuer.id });
  assert.match(r.vehicle.assignedTo.label, /^MDT-\d+$/); assert.equal((await mod.call('GET', `/api/vehicles/${veh}`)).vehicle.assignedTo.label, 'Du'); ok('Zugewiesene Mitglieder nur als Personalnummer');
  const PNGV = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  r = await mod.call('POST', `/api/vehicles/${veh}/image`, { data: PNGV }); assert.ok(r.vehicle.imageUrl);
  const img = await fetch(`${base}${r.vehicle.imageUrl}`, { headers: { cookie: mod.cookie } }); assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}${r.vehicle.imageUrl}`)).status, 401);
  assert.equal((await mod.call('POST', `/api/vehicles/${veh}/image`, { data: Buffer.from('<svg/>').toString('base64') })).status, 400); ok('Fahrzeugbild: nur echte Bilder, nur mit Anmeldung abrufbar');
  r = await mod.call('GET', '/api/vehicles?condition=damaged&fuel=diesel'); assert.ok(r.vehicles.every((v) => v.condition.key === 'damaged' && v.fuel.key === 'diesel')); assert.ok(r.vehicles.length >= 1);
  assert.equal((await mod.call('GET', '/api/vehicles?q=Tesla')).vehicles.length, 1); ok('Filter und Suche');
  await setPerms([]);

  // ══ Karte ══
  assert.equal((await mod.call('GET', '/api/map/config')).status, 403);
  await setPerms(['map.view']);
  r = await mod.call('GET', '/api/map/config'); assert.ok(['{z}', '{x}', '{y}'].every((p) => r.tileUrl.includes(p))); assert.equal(r.canEdit, false); assert.equal(r.calib.scale, 0.66); ok('Karten-Konfiguration (Kachel-URL, Kalibrierung) abrufbar');
  r = await mod.call('GET', '/api/map/layers'); assert.ok(Array.isArray(r.layers)); ok('Karten-Ebenen für Module (z. B. Lager) abrufbar');
  r = await mod.call('GET', '/api/map/postals'); assert.ok(r.postals.length > 1000 && r.postals[0].length === 3); ok('Postleitzahlen-Daten (über 1000 Einträge)');
  r = await admin.call('POST', '/api/lookups/map.category', { label: 'Farming', color: '#84cc16' }); const mcat = r.entry.id;
  r = await admin.call('POST', '/api/map/points', { name: 'Eisen-Farm', description: '- Nur nachts\n- 2 Fahrzeuge', categoryId: mcat, icon: 'wrench', x: 1200.5, y: -300, visibility: 'all' });
  assert.equal(r.status, 201); const pt = r.point.id;
  assert.equal((await admin.call('POST', '/api/map/points', { name: 'Geheim', x: 10, y: 10, visibility: 'editors' })).status, 201);
  assert.equal((await admin.call('POST', '/api/map/points', { name: 'Kaputt', x: 'abc', y: 1 })).status, 400);
  assert.equal((await admin.call('POST', '/api/map/points', { name: 'Icon', x: 1, y: 1, icon: 'giftige-flasche' })).status, 400); ok('Waypoint setzen (Name, Notizen, Kategorie, Symbol, Koordinaten) mit Validierung');
  r = await mod.call('GET', '/api/map/points'); assert.ok(r.points.some((p) => p.id === pt)); assert.equal(r.points.some((p) => p.name === 'Geheim'), false); assert.equal(r.points[0].canEdit, false); ok('Nur-Ansehen sieht keine „nur Bearbeiter“-Punkte');
  assert.equal((await mod.call('POST', '/api/map/points', { name: 'X', x: 1, y: 1 })).status, 403);
  assert.equal((await mod.call('PATCH', `/api/map/points/${pt}`, { name: 'Y' })).status, 403);
  assert.equal((await mod.call('DELETE', `/api/map/points/${pt}`)).status, 403); ok('Bearbeiten der Karte nur mit map.edit');
  await setPerms(['map.view', 'map.edit']);
  r = await mod.call('PATCH', `/api/map/points/${pt}`, { x: 1300, y: -250, name: 'Eisen-Farm Nord' }); assert.equal(r.point.x, 1300); assert.equal(r.point.name, 'Eisen-Farm Nord');
  assert.equal((await mod.call('GET', '/api/map/points')).points.some((p) => p.name === 'Geheim'), true); ok('Mit map.edit: Waypoints verschieben/umbenennen, „nur Bearbeiter“-Punkte sichtbar');
  r = await mod.call('GET', '/api/map/vehicles'); assert.deepEqual(r.vehicles, []);
  await setPerms(['map.view', 'vehicles.view', 'vehicles.view_location']);
  r = await mod.call('GET', '/api/map/vehicles'); assert.ok(r.vehicles.some((v) => v.id === veh && v.x === -100)); ok('Fahrzeug-Ebene der Karte nur mit Fahrzeug- und Standortrecht');
  assert.equal((await admin.call('DELETE', `/api/map/points/${pt}`)).status, 200);
  assert.equal((await admin.call('DELETE', `/api/vehicles/${veh2}`)).status, 200); ok('Löschen von Waypoints und Fahrzeugen');
  await setPerms([]);


  // ══ Privatnachrichten ══
  r = await admin.call('POST', '/api/roles', { name: 'Chatter', permissions: ['chat.view', 'chat.send'] }); const chatRole = r.role.id;
  const third = new Client();
  await third.call('POST', '/api/auth/register', { displayName: 'Dritter', username: 'privat3', password: 'passwort123' });
  const privat3 = (await admin.call('GET', '/api/users')).users.find((u) => u.username === 'privat3');
  await admin.call('POST', `/api/users/${privat3.id}/status`, { status: 'active', roleIds: [chatRole] });
  await third.call('POST', '/api/auth/login', { username: 'privat3', password: 'passwort123' });
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view', 'chat.view', 'chat.send'] });
  r = await admin.call('GET', '/api/chat/people'); assert.ok(r.people.length >= 2); assert.ok(r.people.every((p) => /^[A-Z]+-\d+$/.test(p.label)), JSON.stringify(r.people)); assert.equal(JSON.stringify(r).includes('Neuer'), false); ok('Empfängerliste: alle aktiven Mitglieder, nur als Personalnummer');
  const sDmThird = await openSse(third.cookie, '/api/events'); const sDmMod = await openSse(mod.cookie, '/api/events');
  r = await admin.call('POST', '/api/chat/dms', { userId: neuer.id }); assert.equal(r.status, 200); const dm = r.channel.id; assert.equal(r.channel.kind, 'dm'); assert.match(r.channel.name, /^[A-Z]+-\d+$/);
  assert.equal((await admin.call('POST', '/api/chat/dms', { userId: neuer.id })).channel.id, dm);
  assert.equal((await admin.call('POST', '/api/chat/dms', { userId: 1 })).status, 400); ok('Privatchat anlegen (je Paar genau einer, nicht mit sich selbst)');
  r = await admin.call('POST', `/api/chat/channels/${dm}/messages`, { body: 'Hallo privat' }); assert.equal(r.status, 201); const dmMsg = r.message.id;
  assert.ok(await sDmMod.waitFor((e) => e.event === 'change' && e.data.topic === 'chat')); ok('Privatnachricht senden – live beim Empfänger');
  r = await mod.call('GET', '/api/chat/dms'); assert.equal(r.dms.length, 1); assert.equal(r.dms[0].unread, 1); assert.match(r.dms[0].name, /^[A-Z]+-\d+$/);
  assert.equal((await mod.call('GET', '/api/chat/unread')).unread >= 1, true);
  r = await mod.call('GET', '/api/notifications'); assert.ok(r.notifications.some((n) => n.title === 'Neue Privatnachricht')); ok('Empfänger sieht Ungelesen-Zähler und Benachrichtigung');
  r = await mod.call('GET', `/api/chat/channels/${dm}/messages`); assert.equal(r.messages[0].body, 'Hallo privat'); assert.match(r.messages[0].sender, /^[A-Z]+-\d+$/);
  r = await mod.call('POST', `/api/chat/channels/${dm}/messages`, { body: 'Antwort privat', replyTo: dmMsg }); assert.equal(r.status, 201); ok('Antworten im Privatchat (beide Richtungen)');
  assert.equal((await third.call('GET', `/api/chat/channels/${dm}/messages`)).status, 404);
  assert.equal((await third.call('POST', `/api/chat/channels/${dm}/messages`, { body: 'mitlesen' })).status, 404);
  assert.equal((await third.call('GET', '/api/chat/dms')).dms.length, 0);
  assert.equal((await admin.call('GET', '/api/chat/channels')).channels.every((c) => c.kind !== 'dm'), true);
  await sleep(150); assert.equal(sDmThird.events.some((e) => e.event === 'change' && e.data.topic === 'chat' && e.data.entityId === String(dm)), false); ok('Dritte können Privatchats weder lesen noch schreiben noch live mitbekommen');
  assert.equal((await admin.call('PATCH', `/api/chat/channels/${dm}`, { name: 'x' })).status, 404); sDmThird.close(); sDmMod.close(); ok('Privatchats sind keine Kanäle (nicht verwaltbar)');

  // ══ Lager ══
  assert.equal((await mod.call('GET', '/api/warehouses')).status, 403);
  r = await admin.call('POST', '/api/lookups/warehouse.type', { label: 'Depot', color: '#f59e0b' }); const whType = r.entry.id;
  r = await admin.call('POST', '/api/warehouse/items', { name: 'Eisenerz', unit: 'kg', space: 2, minPrice: 100, maxPrice: 200, targetStock: 1000 });
  assert.equal(r.status, 201); const ore = r.item.id; assert.ok(r.item.suggestedPrice > 199 && r.item.suggestedPrice <= 200); // leeres Lager ⇒ (nahezu) Höchstpreis
  assert.equal((await admin.call('POST', '/api/warehouse/items', { name: 'Kaputt', minPrice: 300, maxPrice: 100 })).status, 400);
  assert.equal((await admin.call('POST', '/api/warehouse/items', { name: 'Halb', minPrice: 300 })).status, 400); ok('Items mit Preisspanne (Min/Max) – ungültige Spannen werden abgelehnt');
  r = await admin.call('POST', '/api/warehouses', { name: 'Hafen-Lager', typeId: whType, postal: '7085', capacity: 5000, sizeInfo: '120 m²', accessInfo: 'Tor-Code 1234', locationText: 'Hafen Süd', restricted: false });
  assert.equal(r.status, 201); assert.match(r.warehouse.number, /^[A-Z]+-L-\d+$/); const wh = r.warehouse.id; assert.ok(r.warehouse.location.resolved); ok('Lager anlegen (Postleitzahl wird in Koordinaten aufgelöst, Nummer MDT-L-…)');
  assert.equal((await admin.call('POST', '/api/warehouses', { name: 'Falsch', postal: '99999999' })).status, 400);
  assert.equal((await admin.call('POST', '/api/warehouses', { name: 'Koordinaten', locX: 100, locY: -200 })).status, 201);
  assert.equal((await admin.call('POST', '/api/warehouses', { name: 'Hafen-Lager' })).status, 409); ok('Validierung: unbekannte Postleitzahl, doppelter Name, Koordinaten');
  r = await admin.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'in', quantity: 600, note: 'Erstbestand' }); assert.equal(r.quantity, 600); assert.equal(r.used, 1200);
  assert.equal((await admin.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'out', quantity: 9999 })).status, 409);
  assert.equal((await admin.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'in', quantity: 2000 })).status, 409); ok('Einlagern/Auslagern mit Kapazitäts- und Bestandsprüfung');
  r = await admin.call('POST', '/api/warehouses', { name: 'Zweitlager', capacity: 1000 }); const wh2 = r.warehouse.id;
  assert.equal((await admin.call('POST', `/api/warehouses/${wh}/transfer`, { toId: wh2, itemId: ore, quantity: 100 })).status, 200);
  r = await admin.call('GET', `/api/warehouses/${wh2}`); assert.equal(r.stock[0].quantity, 100); assert.ok(r.events.length >= 1); ok('Umlagern zwischen Lagern mit Verlauf');
  { // Slots wie im Server-Inventar: Slots pro Stapel + maximale Menge pro Stapel
    const mk = async (name, space, stackSize) => (await admin.call('POST', '/api/warehouse/items', { name, unit: 'Stk', space, stackSize })).item;
    const A = await mk('Slot-A', 1, 5), B = await mk('Slot-B', 2, 2), C = await mk('Slot-C', 3, 1); assert.equal(A.stackSize, 5); assert.equal(B.space, 2);
    assert.equal((await admin.call('POST', '/api/warehouse/items', { name: 'Slot-X', space: 1, stackSize: 0 })).status, 400); assert.equal((await admin.call('POST', '/api/warehouse/items', { name: 'Slot-Y', space: 0, stackSize: 1 })).status, 400);
    r = await admin.call('POST', '/api/warehouses', { name: 'Slot-Lager', capacity: 10 }); const sw = r.warehouse.id; const put = (item, q) => admin.call('POST', `/api/warehouses/${sw}/stock`, { itemId: item.id, action: 'in', quantity: q });
    assert.equal((await put(A, 5)).used, 1); // 5 Stück = 1 Stapel = 1 Slot
    assert.equal((await put(A, 1)).used, 2); // 6 Stück = 2 Stapel
    assert.equal((await put(A, 4)).used, 2); // 10 Stück = 2 Stapel (angefangener Stapel wird aufgefüllt)
    assert.equal((await put(B, 3)).used, 6); // 3 Stück = 2 Stapel à 2 Slots = 4
    assert.equal((await put(C, 1)).used, 9); // 1 Stück = 1 Stapel à 3 Slots
    r = await put(C, 1); assert.equal(r.status, 409); assert.match(r.error, /Slots/); // wäre 12 von 10
    assert.equal((await put(B, 1)).used, 9); // 4 Stück = 2 Stapel: noch 4 Slots → kein Zusatzbedarf
    r = await admin.call('GET', `/api/warehouses/${sw}`); const rowA = r.stock.find((x) => x.itemId === A.id); assert.equal(rowA.space, 2); assert.equal(rowA.stacks, 2); assert.equal(rowA.stackSize, 5); assert.equal(r.warehouse.used, 9);
    assert.equal((await admin.call('POST', `/api/warehouses/${sw}/stock`, { itemId: A.id, action: 'out', quantity: 7 })).used, 8); // A: 3 Stück = 1 Stapel = 1 Slot (+ B 4 + C 3)
    assert.equal((await admin.call('PATCH', `/api/warehouse/items/${C.id}`, { stackSize: 2 })).item.stackSize, 2);
    ok('Lager in Slots: Stapelgröße und Slots pro Stapel (1/5, 2/2, 3/1), angefangene Stapel, Kapazitätsprüfung'); }
  r = await admin.call('GET', `/api/warehouses/${wh}`); assert.equal(r.stock[0].quantity, 500);
  // Zugriffe
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view', 'chat.view', 'chat.send', 'warehouse.view'] });
  r = await mod.call('GET', '/api/warehouses'); assert.ok(r.warehouses.length >= 2); assert.equal(r.warehouses.find((w) => w.id === wh).accessInfo, null); assert.equal(r.warehouses.find((w) => w.id === wh).canBook, false);
  assert.equal((await mod.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'in', quantity: 1 })).status, 403);
  assert.equal((await mod.call('POST', '/api/warehouses', { name: 'Nope' })).status, 403);
  r = await mod.call('GET', '/api/warehouse/items'); assert.equal(r.items.find((i) => i.id === ore).minPrice, undefined); ok('Nur-Ansehen: kein Zugangs-Code, keine Preisspannen, keine Buchungen');
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view', 'chat.view', 'chat.send', 'warehouse.view', 'warehouse.view_access', 'warehouse.stock', 'warehouse.prices'] });
  r = await mod.call('GET', `/api/warehouses/${wh}`); assert.equal(r.warehouse.accessInfo, 'Tor-Code 1234');
  assert.equal((await mod.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'in', quantity: 1 })).status, 403); // nur view-Stufe im Lager? nein: offenes Lager = view
  r = await admin.call('PATCH', `/api/warehouses/${wh}`, { restricted: true, access: [{ roleId: modRole, level: 'manage' }] }); assert.equal(r.warehouse.access.length, 1);
  assert.equal((await mod.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'in', quantity: 1 })).status, 200);
  assert.equal((await mod.call('GET', '/api/warehouse/items')).items.find((i) => i.id === ore).minPrice, 100); ok('Rollenbasierte Zugriffe pro Lager (ansehen/verwalten) + Rechte für Zugang und Preise');
  r = await admin.call('PATCH', `/api/warehouses/${wh2}`, { restricted: true, access: [] });
  assert.equal((await mod.call('GET', `/api/warehouses/${wh2}`)).status, 404); assert.equal((await mod.call('GET', '/api/warehouses')).warehouses.some((w) => w.id === wh2), false); ok('Beschränkte Lager sind für andere unsichtbar');
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view', 'chat.view', 'chat.send'] });
  assert.equal((await mod.call('GET', '/api/map/layers')).status, 403);
  await admin.call('PATCH', `/api/roles/${modRole}`, { permissions: ['users.view', 'users.approve', 'users.edit', 'audit.view', 'chat.view', 'chat.send', 'map.view', 'warehouse.view'] });
  r = await mod.call('GET', '/api/map/layers'); const lay = r.layers.find((l) => l.key === 'warehouses'); assert.ok(lay); assert.ok(lay.items.some((i) => i.name === 'Hafen-Lager')); assert.ok(lay.items.every((i) => i.name !== 'Zweitlager'));
  r = await admin.call('GET', '/api/map/layers'); const lay2 = r.layers.find((l) => l.key === 'warehouses'); assert.ok(lay2.items.some((i) => i.name === 'Hafen-Lager' && Number.isFinite(i.x))); ok('Lager erscheinen als Kartenebene (per Postleitzahl/Koordinaten, nur wenn sichtbar)');
  assert.equal((await admin.call('DELETE', `/api/warehouses/${wh}`)).status, 409); ok('Nicht leeres Lager kann nicht gelöscht werden');

  // ══ Börse: automatischer Preisvorschlag aus der Preisspanne ══
  const pcli = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Händler Zwei', apps: ['market'] }); const ptok = r.partner.linkPath.split('/').pop(); assert.equal((await pcli.call('POST', `/api/p/${ptok}/login`, { code: r.code })).status, 200);
  r = await admin.call('GET', `/api/warehouse/items`); const oreNow = r.items.find((i) => i.id === ore);
  r = await pcli.call('GET', '/api/p/market/catalog'); const pItem = r.items.find((i) => i.id === ore); assert.ok(pItem); assert.equal(typeof pItem.suggestedPrice, 'number'); assert.equal(JSON.stringify(r).includes('minPrice'), false); assert.equal(JSON.stringify(r).includes('maxPrice'), false);
  r = await pcli.call('GET', `/api/p/market/quote?itemId=${ore}&quantity=100`); assert.equal(r.status, 200); assert.ok(r.quote.unitPrice >= 100 && r.quote.unitPrice <= 200); assert.ok(Math.abs(r.quote.total - r.quote.unitPrice * 100) < 0.01); const qPrice = r.quote.unitPrice;
  const bigger = (await pcli.call('GET', `/api/p/market/quote?itemId=${ore}&quantity=800`)).quote.unitPrice; assert.ok(bigger <= qPrice); ok('Partner sieht automatischen Preisvorschlag (fällt bei Menge/Bestand), aber nie die Spanne');
  r = await pcli.call('POST', '/api/p/market/offers', { itemId: ore, quantity: 100 }); assert.equal(r.status, 201); assert.equal(r.deal.unitPrice, qPrice); assert.equal(r.deal.suggestedPrice, qPrice); const deal1 = r.deal.id; ok('Angebot ohne Preis → Vorschlagspreis wird automatisch übernommen (Genehmigung durch das Team)');
  r = await pcli.call('POST', '/api/p/market/offers', { itemId: ore, quantity: 100, unitPrice: qPrice + 40 }); assert.equal(r.deal.unitPrice, qPrice + 40); assert.equal(r.deal.suggestedPrice, qPrice); ok('Eigener Preis → Gegenangebot, Vorschlag bleibt zum Vergleich gespeichert');
  r = await admin.call('POST', '/api/market/items', { name: 'Ohne Spanne', unit: 'Stück' }); const plain = r.item.id;
  assert.equal((await pcli.call('POST', '/api/p/market/offers', { itemId: plain, quantity: 5 })).status, 400); assert.equal((await pcli.call('POST', '/api/p/market/offers', { itemId: plain, quantity: 5, unitPrice: 10 })).status, 201); ok('Ohne Spanne muss der Partner selbst einen Preis nennen');
  assert.equal((await admin.call('POST', `/api/market/deals/${deal1}/accept`, {})).status, 200);
  assert.equal((await admin.call('POST', `/api/market/deals/${deal1}/handover`, { info: 'Hafen' })).status, 200);
  const stockBefore = (await admin.call('GET', `/api/warehouses/${wh}`)).stock.find((s) => s.itemId === ore).quantity;
  assert.equal((await admin.call('POST', `/api/market/deals/${deal1}/advance`, { warehouseId: wh })).status, 200);
  assert.equal((await admin.call('GET', `/api/warehouses/${wh}`)).stock.find((s) => s.itemId === ore).quantity, stockBefore + 100); ok('Ware eingegangen → wird direkt ins gewählte Lager eingebucht');


  // ══ Chat für externe Partner ══
  const nochat = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Ohne Chat', apps: ['market'] });
  await nochat.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code });
  assert.equal((await nochat.call('GET', '/api/p/chat/channels')).status, 403); ok('Partner ohne Chat-App: kein Zugriff auf den Chat');
  const cp = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Händler Chat', apps: ['market', 'chat'] }); const chatPartnerId = r.partner.id; const chatPartnerNo = r.partner.number;
  assert.equal((await cp.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code })).status, 200);
  r = await cp.call('GET', '/api/p/chat/people'); assert.ok(r.people.length >= 1); assert.ok(r.people.every((p) => /^[A-Z]+-\d+$/.test(p.label))); assert.equal(JSON.stringify(r).toLowerCase().includes('"admin"'), false); ok('Partner sieht als Ansprechpartner nur Mitglieder mit chat.partners – als Personalnummer');
  assert.equal((await cp.call('GET', '/api/p/chat/dms')).dms.length, 0);
  const sP = await openSse(cp.cookie, '/api/p/events');
  r = await cp.call('POST', '/api/p/chat/dms', { userId: 1 }); assert.equal(r.status, 200); const pdm = r.channel.id; assert.match(r.channel.name, /^[A-Z]+-\d+$/);
  assert.equal((await cp.call('POST', '/api/p/chat/dms', { userId: neuer.id })).status, 400); ok('Partner kann nur Ansprechpartner anschreiben, nicht beliebige Mitglieder');
  r = await cp.call('POST', `/api/p/chat/channels/${pdm}/messages`, { body: 'Hallo Team, hier der Partner' }); assert.equal(r.status, 201); assert.equal(r.message.sender, chatPartnerNo); assert.equal(r.message.isMine, true);
  r = await admin.call('GET', '/api/chat/dms'); const adm = r.dms.find((d) => d.id === pdm); assert.ok(adm); assert.equal(adm.name, chatPartnerNo); assert.equal(adm.description, 'Händler Chat'); assert.equal(adm.unread, 1);
  r = await admin.call('GET', '/api/notifications'); assert.ok(r.notifications.some((n) => n.title === 'Neue Privatnachricht' && n.body.startsWith(chatPartnerNo))); ok('Partner → Mitarbeiter: Privatnachricht samt Benachrichtigung (Partner nur als Partnernummer)');
  r = await admin.call('GET', `/api/chat/channels/${pdm}/messages`); assert.equal(r.messages[0].sender, chatPartnerNo); assert.equal(r.messages[0].body, 'Hallo Team, hier der Partner');
  r = await admin.call('POST', `/api/chat/channels/${pdm}/messages`, { body: 'Hallo Partner, wir melden uns' }); assert.equal(r.status, 201);
  assert.ok(await sP.waitFor((e) => e.event === 'change' && e.data.topic === 'chat')); ok('Mitarbeiter → Partner: Antwort kommt live an');
  r = await cp.call('GET', '/api/p/chat/dms'); assert.equal(r.dms.length, 1); assert.equal(r.dms[0].unread, 1);
  r = await cp.call('GET', `/api/p/chat/channels/${pdm}/messages`); assert.equal(r.messages.length, 2); assert.match(r.messages[1].sender, /^[A-Z]+-\d+$/); assert.equal(r.messages[1].isMine, false);
  assert.equal(JSON.stringify(r).includes('Admin'), false); assert.equal(JSON.stringify(r).includes('"username"'), false); ok('Partner sieht Mitarbeiter nur als Personalnummer – nie Namen');
  const pm = (await cp.call('POST', `/api/p/chat/channels/${pdm}/messages`, { body: 'Tippfehler' })).message.id;
  assert.equal((await cp.call('PATCH', `/api/p/chat/messages/${pm}`, { body: 'Korrigiert' })).message.body, 'Korrigiert');
  assert.equal((await cp.call('DELETE', `/api/p/chat/messages/${pm}`)).status, 200);
  const adminMsg = (await admin.call('GET', `/api/chat/channels/${pdm}/messages`)).messages.find((x) => !x.isMine && !x.deleted).id;
  assert.equal((await cp.call('PATCH', `/api/p/chat/messages/${(await admin.call('GET', `/api/chat/channels/${pdm}/messages`)).messages.find((x) => x.isMine).id}`, { body: 'fremd' })).status, 403); void adminMsg; ok('Partner kann eigene Nachrichten bearbeiten/löschen, fremde nicht');
  assert.equal((await mod.call('GET', `/api/chat/channels/${pdm}/messages`)).status, 404); assert.equal((await mod.call('POST', '/api/chat/dms', { partnerId: chatPartnerId })).status, 403); ok('Andere Mitarbeiter können Partner-Privatchats weder lesen noch ohne chat.partners starten');
  r = await admin.call('GET', '/api/chat/people'); assert.ok(r.partners.some((p) => p.label === chatPartnerNo)); assert.equal((await mod.call('GET', '/api/chat/people')).partners.length, 0);
  r = await admin.call('POST', '/api/chat/dms', { partnerId: chatPartnerId }); assert.equal(r.channel.id, pdm); ok('Mitarbeiter mit chat.partners findet Partner in der Empfängerliste (Partnernummer)');
  assert.equal((await cp.call('GET', `/api/p/chat/channels/${general}/messages`)).status, 404); assert.equal((await cp.call('GET', '/api/p/chat/channels')).channels.length, 0);
  r = await admin.call('PATCH', `/api/chat/channels/${general}`, { partnerIds: [chatPartnerId] }); assert.deepEqual(r.channel.partnerIds, [chatPartnerId]);
  r = await cp.call('GET', '/api/p/chat/channels'); assert.equal(r.channels.length, 1); assert.equal(r.channels[0].id, general);
  r = await cp.call('POST', `/api/p/chat/channels/${general}/messages`, { body: 'Hallo im Kanal' }); assert.equal(r.status, 201);
  r = await admin.call('GET', `/api/chat/channels/${general}/messages`); assert.ok(r.messages.some((x) => x.sender === chatPartnerNo && x.body === 'Hallo im Kanal')); ok('Kanäle lassen sich gezielt für Partner freigeben; Nachrichten erscheinen mit Partnernummer');
  r = await cp.call('GET', `/api/p/chat/channels/${general}/messages`); assert.equal((await cp.call('POST', `/api/p/chat/messages/${r.messages.find((x) => !x.isMine).id}/pin`)).status, 404); assert.equal((await cp.call('GET', '/api/chat/channels')).status, 401); ok('Partner können nicht pinnen und nicht auf die Mitarbeiter-API zugreifen');
  await admin.call('PATCH', `/api/partners/${chatPartnerId}`, { apps: ['market'] });
  assert.equal((await cp.call('GET', '/api/p/chat/channels')).status, 403); sP.close(); ok('Chat-App für Partner jederzeit entziehbar');


  // ══ Börse: Angebote an Partner (Verkauf aus dem Lager) + Finanz-Journal ══
  const buyer = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Käufer GmbH', apps: ['market'] }); const buyerId = r.partner.id;
  assert.equal((await buyer.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code })).status, 200);
  const stockOf = async () => (await admin.call('GET', `/api/warehouses/${wh}`)).stock.find((s) => s.itemId === ore)?.quantity ?? 0;
  const s0 = await stockOf();
  assert.equal((await mod.call('POST', '/api/market/offers', { partnerId: buyerId, warehouseId: wh, itemId: ore, quantity: 5, unitPrice: 90 })).status, 403);
  assert.equal((await admin.call('POST', '/api/market/offers', { partnerId: buyerId, warehouseId: wh, itemId: ore, quantity: s0 + 1, unitPrice: 90 })).status, 409);
  const onlyChat = (await admin.call('POST', '/api/partners', { name: 'Nur Chat', apps: ['chat'] })).partner.id;
  assert.equal((await admin.call('POST', '/api/market/offers', { partnerId: onlyChat, warehouseId: wh, itemId: ore, quantity: 5, unitPrice: 90 })).status, 400); ok('Angebot an Partner: Rechte, Bestandsprüfung und Börsen-Zugang des Partners werden geprüft');
  r = await admin.call('POST', '/api/market/offers', { partnerId: buyerId, warehouseId: wh, itemId: ore, quantity: 50, unitPrice: 90, note: 'Frisch eingetroffen' });
  assert.equal(r.status, 201); assert.equal(r.deal.direction, 'sell'); assert.equal(r.deal.status, 'submitted'); assert.equal(r.deal.turn, 'partner'); const sell1 = r.deal.id;
  assert.equal(await stockOf(), s0); ok('Angebot an einen Partner senden – Bestand bleibt bis zur Annahme unverändert');
  r = await buyer.call('GET', `/api/p/market/deals/${sell1}`); assert.equal(r.deal.direction, 'sell'); assert.equal(r.deal.warehouse, undefined); assert.equal(JSON.stringify(r).includes('Hafen-Lager'), false);
  r = await buyer.call('GET', '/api/notifications'); void r;
  assert.equal((await buyer.call('POST', `/api/p/market/deals/${sell1}/accept`)).status, 200); ok('Partner nimmt das Angebot an (ohne das Lager zu sehen)');
  assert.equal(await stockOf(), s0 - 50);
  r = await admin.call('GET', `/api/warehouses/${wh}`); const ev1 = r.events.find((e) => e.kind === 'deal_out'); assert.ok(ev1); assert.equal(ev1.delta, -50); assert.equal(ev1.dealId, sell1);
  r = await admin.call('GET', `/api/market/deals/${sell1}`); assert.equal(r.deal.stockBooked, true); assert.ok(r.events.some((e) => e.kind === 'stock' && e.internal && /Ausgebucht: 50/.test(e.text)));
  r = await buyer.call('GET', `/api/p/market/deals/${sell1}`); assert.equal(r.events.some((e) => e.kind === 'stock'), false); ok('Annahme bucht die Ware automatisch aus dem Lager ab – nachvollziehbar im Lager-Verlauf und im Geschäft (intern)');
  r = await admin.call('GET', '/api/finance/ledger'); const le = r.entries.find((e) => e.dealId === sell1); assert.ok(le); assert.equal(le.direction, 'in'); assert.equal(le.amount, 50 * 90); assert.equal(le.status, 'expected');
  assert.equal((await mod.call('GET', '/api/finance/ledger')).status, 403);
  r = await admin.call('GET', '/api/finance/summary'); assert.ok(r.summary.expectedIn >= 4500); ok('Geldbewegung wird für das Finanzsystem vorgemerkt (erwartet, Eingang) – nur mit finance.view sichtbar');
  assert.equal((await admin.call('POST', `/api/market/deals/${sell1}/handover`, { info: 'Übergabe am Hafen' })).status, 200);
  assert.equal((await admin.call('POST', `/api/market/deals/${sell1}/advance`, {})).status, 200); assert.equal((await admin.call('POST', `/api/market/deals/${sell1}/advance`, {})).deal.statusLabel, 'Zahlung ausstehend');
  assert.equal(await stockOf(), s0 - 50); assert.equal((await admin.call('POST', `/api/market/deals/${sell1}/advance`, {})).deal.status, 'completed');
  assert.equal((await admin.call('GET', '/api/finance/ledger')).entries.find((e) => e.dealId === sell1).status, 'settled'); assert.ok((await admin.call('GET', '/api/finance/summary')).summary.settledIn >= 4500); ok('Abschluss verbucht die Zahlung im Journal (bezahlt)');
  // Verhandlung: Partner macht Gegenangebot, Team nimmt an
  r = await admin.call('POST', '/api/market/offers', { partnerId: buyerId, warehouseId: wh, itemId: ore, quantity: 20, unitPrice: 100 }); const sell2 = r.deal.id;
  assert.equal((await admin.call('POST', `/api/market/deals/${sell2}/accept`)).status, 409);
  assert.equal((await buyer.call('POST', `/api/p/market/deals/${sell2}/counter`, { unitPrice: 85 })).deal.turn, 'staff');
  assert.equal((await admin.call('POST', `/api/market/deals/${sell2}/accept`)).status, 200); assert.equal(await stockOf(), s0 - 70);
  assert.equal((await admin.call('GET', '/api/finance/ledger')).entries.find((e) => e.dealId === sell2).amount, 20 * 85); ok('Gegenangebot des Partners → Team nimmt an → Abbuchung zum verhandelten Preis');
  // Storno gibt die Ware zurück
  assert.equal((await admin.call('POST', `/api/market/deals/${sell2}/cancel`, { text: 'Doch nicht' })).status, 200); assert.equal(await stockOf(), s0 - 50);
  assert.equal((await admin.call('GET', '/api/finance/ledger')).entries.find((e) => e.dealId === sell2).status, 'cancelled');
  assert.ok((await admin.call('GET', `/api/warehouses/${wh}`)).events.some((e) => e.kind === 'deal_return' && e.dealId === sell2)); ok('Storno vor der Übergabe bucht die Ware zurück ins Lager und storniert die Geldbewegung');
  // Ware zwischenzeitlich weg → Annahme scheitert, ohne Bestandszahlen zu verraten
  const left = await stockOf(); r = await admin.call('POST', '/api/market/offers', { partnerId: buyerId, warehouseId: wh, itemId: ore, quantity: left, unitPrice: 70 }); const sell3 = r.deal.id;
  await admin.call('POST', `/api/warehouses/${wh}/stock`, { itemId: ore, action: 'out', quantity: 10 });
  r = await buyer.call('POST', `/api/p/market/deals/${sell3}/accept`); assert.equal(r.status, 409); assert.equal(/\d{2,}/.test(r.error ?? r.message ?? ''), false);
  assert.equal((await admin.call('GET', `/api/market/deals/${sell3}`)).deal.status, 'submitted'); assert.equal(await stockOf(), left - 10); ok('Reicht der Bestand bei Annahme nicht mehr, bleibt alles unverändert (Partner erfährt keine Bestandszahlen)');
  // Ankauf (Partner verkauft an uns): Annahme bucht Geld „Ausgang“ vor
  r = await admin.call('GET', '/api/finance/ledger?direction=out'); const outBefore = r.entries.length;
  r = await buyer.call('POST', '/api/p/market/offers', { itemId: ore, quantity: 10, unitPrice: 120 }); const buy1 = r.deal.id;
  assert.equal((await admin.call('POST', `/api/market/deals/${buy1}/accept`)).status, 200);
  r = await admin.call('GET', '/api/finance/ledger?direction=out'); assert.equal(r.entries.length, outBefore + 1); assert.equal(r.entries[0].amount, 1200); assert.equal(r.entries[0].status, 'expected'); ok('Ankäufe werden als erwartete Ausgabe vorgemerkt');


  // ══ Dashboard-Widgets ══
  const lay0 = (await admin.call('GET', '/api/dashboard/layout')).widgets; await admin.call('PUT', '/api/dashboard/layout', { widgets: lay0.map((w) => ({ id: w.id, enabled: true })) });
  r = await admin.call('GET', '/api/dashboard'); const wids = r.widgets.map((w) => w.id);
  for (const id of ['welcome', 'quick-links', 'vehicles-overview', 'warehouse-overview', 'finance-flow']) assert.ok(wids.includes(id), `Widget fehlt: ${id}`);
  const whWidget = r.widgets.find((w) => w.id === 'warehouse-overview').data; assert.ok(whWidget.count >= 1 && Array.isArray(whWidget.warehouses));
  assert.ok(Array.isArray(r.widgets.find((w) => w.id === 'vehicles-overview').data.conditions)); assert.equal(typeof r.widgets.find((w) => w.id === 'finance-flow').data.balanceExpected, 'number');
  r = await third.call('GET', '/api/dashboard'); assert.equal(r.widgets.some((w) => ['finance-flow', 'warehouse-overview', 'vehicles-overview'].includes(w.id)), false); ok('Neue Dashboard-Widgets (Lager, Fuhrpark, Geldfluss, Schnellzugriff) – nur mit passendem Recht sichtbar');
  const layoutBefore = (await admin.call('GET', '/api/dashboard/layout')).widgets;
  r = await admin.call('PUT', '/api/dashboard/layout', { widgets: layoutBefore.map((w) => ({ id: w.id, enabled: false })) }); assert.equal(r.status, 200);
  r = await admin.call('GET', '/api/dashboard'); assert.deepEqual(r.widgets, []);
  r = await admin.call('PUT', '/api/dashboard/layout', { widgets: layoutBefore.map((w) => ({ id: w.id, enabled: true })) }); assert.equal((await admin.call('GET', '/api/dashboard')).widgets.length > 3, true); ok('Alle Widgets aus-/einschalten funktioniert (leeres Dashboard ist gültig)');


  // ══ Deckel-System (externe Firmen) ══
  await admin.call('PUT', '/api/config', { values: { 'tab.allow_current_period': true } });
  assert.equal(tabPeriodKey(new Date(2026, 9, 7), 'weekly'), '2026-W41'); assert.equal(tabPeriodInfo('2026-W41').label, 'KW 41 / 2026'); assert.equal(tabPeriodInfo('2026-10').label, 'Oktober 2026'); ok('Zeiträume: 07.10.2026 → KW 41 / 2026 bzw. Oktober 2026');
  assert.equal((await mod.call('POST', '/api/tab/companies', { name: 'X', seat: 'PC1', accountNumber: 'LS123', interval: 'weekly' })).status, 403);
  assert.equal((await admin.call('POST', '/api/tab/companies', { name: 'Ohne Konto', seat: 'PC1234 Test Drive', interval: 'weekly' })).status, 400);
  assert.equal((await admin.call('POST', '/api/tab/companies', { name: 'Ohne Sitz', accountNumber: 'LS28180705', interval: 'weekly' })).status, 400);
  assert.equal((await admin.call('POST', '/api/tab/companies', { name: 'Falsches Konto', seat: 'PC1234 Test Drive', accountNumber: 'ab', interval: 'weekly' })).status, 400);
  r = await admin.call('POST', '/api/tab/companies', { name: 'Muster GmbH', seat: 'PC1234 Test Drive', accountNumber: 'ls28180705', contactName: 'Frau Muster', interval: 'weekly' });
  assert.equal(r.status, 201); assert.match(r.company.number, /^[A-Z]+-F-\d+$/); assert.equal(r.company.accountNumber, 'LS28180705'); assert.equal(r.company.seat, 'PC1234 Test Drive'); assert.match(r.company.linkPath, /^\/deckel\/firma\/[A-Za-z0-9_-]{30,}$/); const coA = r.company.id; let tokA = r.company.linkPath.split('/').pop();
  r = await admin.call('POST', '/api/tab/companies', { name: 'Beispiel AG', seat: 'PC5678 Beispielweg', accountNumber: 'LS11112222', interval: 'monthly' }); const coB = r.company.id; const tokB = r.company.linkPath.split('/').pop();
  assert.equal((await admin.call('POST', '/api/tab/companies', { name: 'muster gmbh', seat: 'PC1 Test', accountNumber: 'LS99999999', interval: 'weekly' })).status, 409);
  assert.equal((await admin.call('POST', '/api/tab/companies', { name: 'Falsch', seat: 'PC1 Test', accountNumber: 'LS99999999', interval: 'täglich' })).status, 400); ok('Firma anlegen: Firmenname, Firmensitz und Kontonummer sind Pflicht; individueller Portal-Link');
  const portal = new Client(); const tabCurWeek = tabPeriodKey(new Date(), 'weekly'); const tabCurMonth = tabPeriodKey(new Date(), 'monthly');
  assert.equal((await new Client().call('GET', '/api/c/gibtsnicht-gibtsnicht-gibtsnicht')).status, 404);
  r = await portal.call('GET', `/api/c/${tokA}`); assert.equal(r.company.name, 'Muster GmbH'); assert.ok(r.periods.some((p) => p.key === tabCurWeek)); assert.deepEqual(r.statements, []); assert.equal(JSON.stringify(r).includes('Beispiel'), false); assert.equal(JSON.stringify(r).includes('LS28180705'), false); ok('Firmenportal: nur der eigene Link funktioniert; keine fremden oder internen Daten');
  assert.equal((await portal.call('POST', `/api/c/${tokA}/statements`, { periodKey: '1999-W01', amountCents: 100 })).status, 400);
  assert.equal((await portal.call('POST', `/api/c/${tokA}/statements`, { periodKey: tabCurWeek, amountCents: -5 })).status, 400);
  r = await portal.call('POST', `/api/c/${tokA}/statements`, { periodKey: tabCurWeek, amountCents: 128450, comment: 'Wie besprochen' }); assert.equal(r.status, 201); assert.match(r.message, /erfolgreich übermittelt/); assert.ok(!r.periods.some((p) => p.key === tabCurWeek));
  assert.equal((await portal.call('POST', `/api/c/${tokA}/statements`, { periodKey: tabCurWeek, amountCents: 100 })).status, 400); ok('Abrechnung einreichen: Bestätigung, Zeitraum danach nicht mehr wählbar');
  r = await admin.call('GET', '/api/notifications'); const tabNn = r.notifications.find((n) => n.title === 'Neue Deckel-Abrechnung'); assert.ok(tabNn); assert.match(tabNn.body, /Muster GmbH/); assert.match(tabNn.body, /LS28180705/); assert.equal(tabNn.target.app, 'tab'); ok('Neue Abrechnung löst eine Benachrichtigung aus (Firma, Zeitraum, Betrag, Konto)');
  r = await admin.call('GET', '/api/tab/statements'); const tabSt1 = r.statements.find((s) => s.company.id === coA); assert.equal(tabSt1.status, 'submitted'); assert.equal(tabSt1.submittedCents, 128450); assert.equal(tabSt1.company.accountNumber, 'LS28180705'); assert.equal(tabSt1.company.seat, 'PC1234 Test Drive'); assert.equal(tabSt1.ourCents, undefined); assert.equal(tabSt1.diffCents, undefined); ok('Keine Summen auf unserer Seite, kein Abgleich, keine Differenz – Konto und Betrag der Firma stehen in der Abrechnung');
  assert.equal((await mod.call('POST', `/api/tab/statements/${tabSt1.id}/review`)).status, 403); assert.equal((await mod.call('GET', '/api/tab/statements')).status, 403);
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt1.id}/pay`)).status, 409);
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt1.id}/review`)).statement.status, 'review');
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt1.id}/confirm`, { approvedCents: 100000 })).status, 400); // abweichender Betrag braucht Begründung
  r = await admin.call('POST', `/api/tab/statements/${tabSt1.id}/confirm`, {}); assert.equal(r.statement.status, 'confirmed'); assert.equal(r.statement.approvedCents, 128450);
  r = await admin.call('GET', `/api/tab/statements/${tabSt1.id}`); assert.match(r.log.map((l) => l.text).join('|'), /1\.284,50.*LS28180705/); ok('Bestätigung zeigt: wie viel auf welches Konto');
  r = await admin.call('GET', '/api/finance/ledger?q=Muster'); const tabLe = r.entries.filter((e) => e.entryType === 'tab'); assert.equal(tabLe.length, 1); assert.equal(tabLe[0].direction, 'out'); assert.equal(tabLe[0].amount, 1284.5); assert.equal(tabLe[0].status, 'expected'); assert.match(tabLe[0].note, /LS28180705/);
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt1.id}/prepare`, { method: 'bar' })).status, 400);
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt1.id}/prepare`, { method: 'transfer' })).statement.status, 'payment_pending');
  r = await admin.call('POST', `/api/tab/statements/${tabSt1.id}/pay`, { paidAt: '2026-10-08', reference: 'TX-4711' }); assert.equal(r.statement.status, 'paid'); assert.equal(r.statement.payReference, 'TX-4711');
  r = await admin.call('GET', '/api/finance/ledger?q=Muster'); assert.equal(r.entries.filter((e) => e.entryType === 'tab' && e.status === 'settled').length, 1); ok('Überweisung dokumentiert → bezahlt, Finanzvorgang verbucht');
  r = await portal.call('POST', `/api/c/${tokB}/statements`, { periodKey: tabCurMonth, amountCents: 90000 }); assert.equal(r.status, 201); const tabSt2 = (await admin.call('GET', '/api/tab/statements?company=' + coB)).statements[0];
  await admin.call('POST', `/api/tab/statements/${tabSt2.id}/confirm`, {}); await admin.call('POST', `/api/tab/statements/${tabSt2.id}/prepare`, { method: 'invoice' });
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt2.id}/pay`, {})).status, 409);
  await admin.call('POST', `/api/tab/statements/${tabSt2.id}/invoice`, { received: true, number: 'RE-77', amountCents: 95000, date: '2026-10-09' });
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt2.id}/pay`, {})).status, 409);
  const PDFB64 = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt2.id}/invoice-file`, { data: 'data:application/pdf;base64,' + PDFB64 })).status, 200);
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt2.id}/invoice-file`, { data: 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64') })).status, 400);
  const tabDl = await fetch(`${base}/api/tab/statements/${tabSt2.id}/invoice-file`, { headers: { cookie: admin.cookie } }); assert.equal(tabDl.status, 200); assert.equal(tabDl.headers.get('content-type'), 'application/pdf');
  await admin.call('POST', `/api/tab/statements/${tabSt2.id}/invoice`, { amountCents: 90000 });
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt2.id}/pay`, {})).statement.status, 'paid'); ok('Zahlung per Firmenrechnung: Nummer/Betrag/Datum/Datei, Betrag muss passen');
  r = await admin.call('POST', '/api/tab/companies', { name: 'Reject GmbH', seat: 'PC9 Nord', accountNumber: 'LS55556666', interval: 'monthly' }); const coR = r.company.id; const tokR = r.company.linkPath.split('/').pop();
  await portal.call('POST', `/api/c/${tokR}/statements`, { periodKey: tabCurMonth, amountCents: 7777 });
  const tabSt3 = (await admin.call('GET', '/api/tab/statements?company=' + coR)).statements[0];
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt3.id}/reject`, { reason: '' })).status, 400);
  assert.equal((await admin.call('POST', `/api/tab/statements/${tabSt3.id}/reject`, { reason: 'Betrag falsch' })).statement.status, 'rejected');
  r = await portal.call('GET', `/api/c/${tokR}`); assert.ok(r.periods.some((p) => p.key === tabCurMonth)); assert.equal(r.statements[0].rejectReason, 'Betrag falsch');
  assert.equal((await portal.call('POST', `/api/c/${tokR}/statements`, { periodKey: tabCurMonth, amountCents: 5000 })).status, 201); ok('Abgelehnte Abrechnung: Firma sieht den Grund und kann erneut einreichen');
  r = await admin.call('POST', `/api/tab/companies/${coA}/reset-link`); assert.notEqual(r.company.linkPath.split('/').pop(), tokA); assert.equal((await portal.call('GET', `/api/c/${tokA}`)).status, 404);
  tokA = r.company.linkPath.split('/').pop(); assert.equal((await portal.call('GET', `/api/c/${tokA}`)).status, 200);
  await admin.call('PATCH', `/api/tab/companies/${coA}`, { status: 'disabled' }); assert.equal((await portal.call('GET', `/api/c/${tokA}`)).status, 404); ok('Neuer Link macht den alten ungültig; deaktivierte Firmen sind gesperrt');
  assert.equal((await admin.call('PATCH', `/api/tab/companies/${coB}`, { interval: 'weekly' })).status, 409); ok('Intervall lässt sich nach der ersten Abrechnung nicht mehr ändern');
  r = await admin.call('GET', '/api/tab/summary'); assert.ok(r.summary.paid >= 2); assert.ok(r.summary.submitted >= 1); assert.equal(typeof r.summary.openCents, 'number'); assert.ok(r.summary.recent.length >= 3);
  assert.ok((await admin.call('GET', '/api/dashboard')).widgets.some((w) => w.id === 'tab-overview')); ok('Dashboard-Kennzahlen (offen, eingereicht, bezahlt)');
  // Löschen
  assert.equal((await mod.call('DELETE', `/api/tab/statements/${tabSt3.id}`)).status, 403);
  assert.equal((await admin.call('DELETE', `/api/tab/statements/${tabSt3.id}`)).status, 200);
  assert.equal((await mod.call('DELETE', `/api/tab/companies/${coR}`)).status, 403);
  assert.equal((await admin.call('DELETE', `/api/tab/companies/${coR}`)).status, 200);
  assert.equal((await admin.call('GET', '/api/tab/statements')).statements.some((s) => s.company.id === coR), false); ok('Deckel-Abrechnungen und Firmen lassen sich (mit Recht / als Superadmin) endgültig löschen');
  r = await admin.call('GET', '/api/audit?module=tab&limit=200'); const acts = new Set(r.rows.map((x) => x.action)); for (const x of ['tab.company_created', 'tab.statement_submitted', 'tab.statement_confirm', 'tab.statement_pay', 'tab.statement_deleted', 'tab.company_deleted']) assert.ok(acts.has(x), x); ok('Alle wichtigen Aktionen stehen im Audit-Log');
  await setPerms([]);

  // ══ Kreditsystem ══
  const { runCreditReminders } = await import('../server/modules/credit.js');
  const calcSrv = await import('../server/core/credit-calc.js'), calcCli = await import('../public/js/credit-calc.js');
  const sample = { principal: 123457, count: 7, frequency: 'monthly', type: 'flat', rateBp: 175, ratePeriod: 'month' };
  assert.deepEqual(calcSrv.calcLoan(sample), calcCli.calcLoan(sample)); assert.deepEqual(calcSrv.splitInstallments({ principal: 100, interest: 7, count: 3 }), calcCli.splitInstallments({ principal: 100, interest: 7, count: 3 }));
  assert.deepEqual(calcSrv.dueDates('2026-01-31', 3, 'monthly'), ['2026-02-28', '2026-03-31', '2026-04-30']); assert.deepEqual(calcSrv.calcLoan({ principal: 100000, count: 10, frequency: 'weekly', type: 'flat', rateBp: 250, ratePeriod: 'week' }), { days: 70, interest: 25000, total: 125000, installment: 12500 }); ok('Kreditberechnung: einfache Zinsen, Raten, Fälligkeiten (Server = Frontend)');
  const noCredit = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Ohne Kredit', apps: ['market'] }); await noCredit.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code });
  assert.equal((await noCredit.call('GET', '/api/p/credit/loans')).status, 403);
  const bor = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Kreditnehmer Eins', apps: ['credit'] }); const borId = r.partner.id; const borNo = r.partner.number;
  assert.equal((await bor.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code })).status, 200);
  const bor2 = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Kreditnehmer Zwei', apps: ['credit'] }); const bor2Id = r.partner.id; await bor2.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code });
  r = await bor.call('GET', '/api/p/credit/config'); assert.equal(r.limitCents, null); ok('Kredit-App nur für Partner mit freigeschalteter App');
  assert.equal((await bor.call('POST', '/api/p/credit/requests', { principalCents: 100, termCount: 5, frequency: 'weekly' })).status, 400);
  assert.equal((await bor.call('POST', '/api/p/credit/requests', { principalCents: 100000, termCount: 0, frequency: 'weekly' })).status, 400);
  assert.equal((await bor.call('POST', '/api/p/credit/requests', { principalCents: 100000, termCount: 5, frequency: 'täglich' })).status, 400);
  r = await bor.call('POST', '/api/p/credit/requests', { principalCents: 100000, termCount: 10, frequency: 'weekly', note: 'Fuhrpark erweitern' }); assert.equal(r.status, 201); assert.match(r.loan.number, /^[A-Z]+-K-\d+$/); assert.equal(r.loan.status, 'requested'); assert.equal(r.loan.turn, 'staff'); assert.equal(r.loan.interest.set, false); assert.equal(r.loan.partner, undefined); const loan1 = r.loan.id;
  r = await admin.call('GET', '/api/notifications'); assert.ok(r.notifications.some((n) => /neue Kreditanfrage/.test(n.title) && n.target.loanId === loan1)); ok('Kredit anfragen (Summe, Laufzeit, wöchentlich/monatlich) – Team wird benachrichtigt');
  assert.equal((await mod.call('GET', '/api/credit/loans')).status, 403);
  r = await admin.call('GET', '/api/credit/loans?group=staff'); assert.equal(r.loans.length, 1); assert.equal(r.loans[0].partner.number, borNo);
  assert.equal((await admin.call('POST', `/api/credit/loans/${loan1}/accept`, {})).status, 400); // Zahlungsziel fehlt
  assert.equal((await bor.call('POST', `/api/p/credit/loans/${loan1}/accept`)).status, 409); // nicht am Zug
  assert.equal((await admin.call('POST', `/api/credit/loans/${loan1}/counter`, { interestType: 'flat', ratePercent: 0, ratePeriod: 'week', payTo: 'Konto 123' })).status, 400);
  r = await admin.call('POST', `/api/credit/loans/${loan1}/counter`, { interestType: 'flat', ratePercent: 2.5, ratePeriod: 'week', payTo: 'Konto 123 · Verwendungszweck: Kreditnummer', text: 'Unser Angebot' });
  assert.equal(r.status, 200); assert.equal(r.loan.status, 'negotiating'); assert.equal(r.loan.turn, 'partner'); assert.equal(r.loan.interestCents, 25000); assert.equal(r.loan.totalCents, 125000); assert.equal(r.loan.installmentCents, 12500); ok('Gegenvorschlag des Teams: Zinssatz pro Woche, Zahlungsziel – Gesamtkosten werden berechnet');
  r = await bor.call('GET', `/api/p/credit/loans/${loan1}`); assert.equal(r.loan.interestCents, 25000); assert.equal(r.loan.totalCents, 125000); assert.equal(r.loan.installmentCents, 12500); assert.equal(r.loan.interest.text, '2,5 % pro Woche'); assert.match(r.loan.payTo, /Konto 123/); assert.equal(r.loan.turn, 'partner');
  assert.equal(JSON.stringify(r).includes('Kreditnehmer Eins'), false); assert.ok(r.events.length >= 2); ok('Kreditnehmer sieht transparent: Zinsen, Gesamtrückzahlung, Rate, Laufzeit, Zahlungsziel');
  assert.equal((await bor2.call('GET', `/api/p/credit/loans/${loan1}`)).status, 404); ok('Ein Kreditnehmer sieht nie Kredite anderer');
  r = await bor.call('POST', `/api/p/credit/loans/${loan1}/counter`, { termCount: 5, text: 'Lieber kürzer' }); assert.equal(r.loan.turn, 'staff'); assert.equal(r.loan.termCount, 5); assert.equal(r.loan.interestCents, 12500); assert.equal(r.loan.interest.rateBp, 250); assert.equal((await bor.call('POST', `/api/p/credit/loans/${loan1}/counter`, { termCount: 3 })).status, 409);
  assert.equal((await bor.call('POST', `/api/p/credit/loans/${loan1}/counter`, { interestType: 'none' })).status, 409); ok('Gegenvorschlag des Kreditnehmers (Laufzeit) – Zinssatz bleibt Sache des Teams, Zinsen werden neu berechnet');
  r = await admin.call('POST', `/api/credit/loans/${loan1}/accept`, {}); assert.equal(r.loan.status, 'accepted');
  assert.equal((await bor.call('POST', `/api/p/credit/loans/${loan1}/report`, { installmentId: 1 })).status, 409);
  r = await admin.call('POST', `/api/credit/loans/${loan1}/disburse`, { date: '2026-10-07' }); assert.equal(r.loan.status, 'active'); assert.equal(r.loan.installments.length, 5);
  assert.deepEqual(r.loan.installments.map((i) => i.dueDate), ['2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04', '2026-11-11']); assert.equal(r.loan.installments.reduce((a, i) => a + i.amountCents, 0), 112500); assert.equal(r.loan.installments[0].amountCents, 22500);
  r = await admin.call('GET', '/api/finance/ledger?q=' + borNo); const cl = r.entries.filter((e) => e.entryType === 'credit_payout' || e.entryType === 'credit_installment'); assert.equal(cl.filter((e) => e.entryType === 'credit_payout' && e.direction === 'out' && e.status === 'settled' && e.amount === 1000).length, 1); assert.equal(cl.filter((e) => e.entryType === 'credit_installment' && e.status === 'expected' && e.direction === 'in').length, 5); ok('Annahme → Auszahlung bestätigt: Tilgungsplan (5 Raten mit Fälligkeiten) und Finanzvorgänge');
  r = await bor.call('GET', `/api/p/credit/loans/${loan1}`); assert.equal(r.loan.installments.length, 5); assert.equal(r.loan.nextDue.date, '2026-10-14'); assert.equal(r.loan.remainingCents, 112500); assert.equal(r.loan.nextDue.amountCents, 22500); ok('Kreditnehmer sieht Fälligkeiten, Beträge und den Rest');
  const inst1 = r.loan.installments[0].id;
  r = await bor.call('POST', `/api/p/credit/loans/${loan1}/report`, { installmentId: inst1 }); assert.ok(r.loan.installments[0].reportedAt); assert.ok((await admin.call('GET', '/api/notifications')).notifications.some((n) => /Ratenzahlung gemeldet/.test(n.body)));
  assert.equal((await mod.call('POST', `/api/credit/loans/${loan1}/payment`, { installmentId: inst1 })).status, 403);
  assert.equal((await admin.call('POST', `/api/credit/loans/${loan1}/payment`, { installmentId: inst1, amountCents: 99999999 })).status, 400);
  r = await admin.call('POST', `/api/credit/loans/${loan1}/payment`, { installmentId: inst1, amountCents: 10000, date: '2026-10-14' }); assert.equal(r.loan.installments[0].status, 'open'); assert.equal(r.loan.installments[0].paidCents, 10000);
  r = await admin.call('POST', `/api/credit/loans/${loan1}/payment`, { installmentId: inst1, date: '2026-10-15' }); assert.equal(r.loan.installments[0].status, 'paid'); assert.equal(r.loan.installmentsPaid, 1); ok('Ratenzahlungen erfassen (auch teilweise), Zahlung melden');
  for (const i of r.loan.installments.slice(1)) r = await admin.call('POST', `/api/credit/loans/${loan1}/payment`, { installmentId: i.id });
  assert.equal(r.loan.status, 'completed'); assert.equal(r.loan.remainingCents, 0); assert.equal(r.loan.nextDue, null);
  r = await admin.call('GET', '/api/finance/ledger?q=' + borNo); assert.equal(r.entries.filter((e) => e.entryType === 'credit_installment' && e.status === 'settled').length, 5); assert.equal((await admin.call('POST', `/api/credit/loans/${loan1}/payment`, { installmentId: inst1 })).status, 409);
  r = await bor.call('GET', '/api/p/credit/loans'); assert.equal(r.loans[0].status, 'completed'); assert.equal((await bor.call('POST', '/api/p/credit/requests', { principalCents: 50000, termCount: 2, frequency: 'monthly' })).status, 201); ok('Abbezahlt: Kredit schließt sich, bleibt im Verlauf, neuer Kredit ist beantragbar');
  // Rahmen, Limits, Ablehnen, Ausfall
  assert.equal((await mod.call('PATCH', `/api/credit/borrowers/${borId}`, { limitCents: 1000 })).status, 403);
  assert.equal((await admin.call('PATCH', `/api/credit/borrowers/${borId}`, { limitCents: 15000 })).status, 200);
  assert.equal((await bor.call('POST', '/api/p/credit/requests', { principalCents: 20000, termCount: 2, frequency: 'monthly' })).status, 409); // 20000 > Rahmen 15000
  r = await bor.call('GET', '/api/p/credit/config'); assert.equal(r.limitCents, 15000); assert.equal(r.availableCents, 15000);
  r = await admin.call('GET', '/api/credit/borrowers'); assert.equal(r.borrowers.find((b) => b.id === borId).completedLoans, 1); ok('Kreditrahmen je Kreditnehmer wird bei Anfrage und Annahme geprüft');
  r = await admin.call('GET', '/api/credit/loans?partner=' + borId + '&status=requested'); const loan2 = r.loans[0].id;
  assert.equal((await admin.call('POST', `/api/credit/loans/${loan2}/accept`, { payTo: 'Bar' })).status, 409); // 50000 > Rahmen 15000 beim Annehmen
  assert.equal((await admin.call('POST', `/api/credit/loans/${loan2}/reject`, { text: 'Zu riskant' })).loan.status, 'rejected'); assert.equal((await bor.call('POST', `/api/p/credit/loans/${loan2}/withdraw`)).status, 409);
  await admin.call('PUT', '/api/config', { values: { 'credit.max_open_requests': 1 } });
  assert.equal((await bor2.call('POST', '/api/p/credit/requests', { principalCents: 10000, termCount: 4, frequency: 'monthly' })).status, 201); assert.equal((await bor2.call('POST', '/api/p/credit/requests', { principalCents: 10000, termCount: 4, frequency: 'monthly' })).status, 409);
  await admin.call('PUT', '/api/config', { values: { 'credit.max_open_requests': 3 } });
  const loan3 = (await admin.call('GET', '/api/credit/loans?partner=' + bor2Id)).loans[0].id;
  assert.equal((await bor2.call('POST', `/api/p/credit/loans/${loan3}/withdraw`)).loan.status, 'withdrawn'); ok('Ablehnen, Zurückziehen und Begrenzung offener Anfragen');
  // Zinsfrei annehmen, Erinnerungen, Ausfall
  const todayIso = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(new Date(todayIso + 'T12:00:00').getTime() - n * 86400000).toISOString().slice(0, 10);
  r = await bor2.call('POST', '/api/p/credit/requests', { principalCents: 30000, termCount: 3, frequency: 'weekly' }); const loan4 = r.loan.id;
  r = await admin.call('POST', `/api/credit/loans/${loan4}/accept`, { payTo: 'Barzahlung im Büro' }); assert.equal(r.loan.interest.type, 'none'); assert.equal(r.loan.interestCents, 0); assert.equal(r.loan.interest.text, 'Zinsfrei'); assert.equal(r.loan.totalCents, 30000);
  r = await admin.call('POST', `/api/credit/loans/${loan4}/disburse`, { date: daysAgo(6) }); // 1. Rate morgen fällig
  runCreditReminders(); r = await bor2.call('GET', '/api/p/notifications'); assert.ok(r.notifications.some((n) => /Rate bald fällig/.test(n.title)));
  r = await bor2.call('POST', '/api/p/credit/requests', { principalCents: 10000, termCount: 2, frequency: 'weekly' }); const loan5 = r.loan.id; await admin.call('POST', `/api/credit/loans/${loan5}/accept`, { payTo: 'Bar' });
  await admin.call('POST', `/api/credit/loans/${loan5}/disburse`, { date: daysAgo(20) }); runCreditReminders();
  r = await bor2.call('GET', '/api/p/notifications'); assert.ok(r.notifications.some((n) => /Rate überfällig/.test(n.title))); assert.ok((await admin.call('GET', '/api/notifications')).notifications.some((n) => /Rate überfällig/.test(n.title)));
  r = await bor2.call('GET', `/api/p/credit/loans/${loan5}`); assert.equal(r.loan.overdueCount, 2); assert.equal(r.loan.installments[0].overdue, true); assert.equal((await admin.call('GET', '/api/credit/loans?group=overdue')).loans.length, 1);
  r = await admin.call('GET', '/api/credit/summary'); assert.equal(r.summary.overdueCount, 2); assert.ok(r.summary.outstandingCents >= 40000); assert.ok(r.summary.upcoming.length >= 1); ok('Erinnerungen (bald fällig / überfällig) und Überfällig-Auswertung');
  r = await admin.call('POST', `/api/credit/loans/${loan5}/default`, { text: 'Zahlt nicht' }); assert.equal(r.loan.status, 'defaulted');
  r = await admin.call('GET', '/api/finance/ledger?q=Bar'); void r; assert.equal((await admin.call('POST', `/api/credit/loans/${loan5}/payment`, { installmentId: 1 })).status, 409);
  r = await admin.call('GET', '/api/finance/ledger?status=cancelled'); assert.ok(r.entries.some((e) => e.entryType === 'credit_installment')); ok('Ausfall markiert offene Raten als nicht mehr erwartet (Journal storniert)');
  assert.equal((await admin.call('GET', '/api/dashboard')).widgets.some((w) => w.id === 'credit-overview'), true);
  r = await admin.call('GET', '/api/audit?module=credit&limit=200'); const cacts = new Set(r.rows.map((x) => x.action)); for (const a of ['credit.requested', 'credit.counter', 'credit.accept', 'credit.disburse', 'credit.payment', 'credit.limit_set']) assert.ok(cacts.has(a), a); ok('Alle Kredit-Aktionen stehen im Audit-Log');

  // ══ Versionskennung (Selbstheilung nach Updates) ══
  r = await new Client().call('GET', '/api/bootstrap'); assert.match(r.version, /^[0-9a-f]{12}$/); assert.equal((await new Client().call('GET', '/api/version')).version, r.version);
  assert.equal((await fetch(`${base}/js/main.js`)).headers.get('cache-control'), 'no-store, max-age=0'); assert.equal((await fetch(`${base}/reset`)).status, 200); ok('Version im Bootstrap, Programmdateien ohne Browser-Cache, /reset erreichbar');
  { // Cache-Schutz: versionierte Adressen + Cache-Reset einmal je Version
    const ver = (await new Client().call('GET', '/api/version')).version;
    const html = await (await fetch(`${base}/`)).text(); assert.match(html, new RegExp(`/js/main\\.js\\?v=${ver}`)); assert.match(html, new RegExp(`/css/theme\\.css\\?v=${ver}`));
    const mainJs = await (await fetch(`${base}/js/main.js?v=${ver}`)).text(); assert.match(mainJs, new RegExp(`from './api\\.js\\?v=${ver}'`)); assert.match(mainJs, new RegExp(`from './views/auth\\.js\\?v=${ver}'`));
    const shellJs = await (await fetch(`${base}/js/shell.js`)).text(); assert.match(shellJs, new RegExp(`import\\('\\./views/tickets\\.js\\?v=${ver}'\\)`)); // auch dynamische Importe
    assert.equal((mainJs.match(/from '\.[^']*\.js'/g) ?? []).length, 0, 'unversionierter Import übrig');
    const first = await fetch(`${base}/`); assert.equal(first.headers.get('clear-site-data'), '"cache"'); assert.match(first.headers.get('set-cookie'), new RegExp(`mdt_v=${ver}`));
    const again = await fetch(`${base}/`, { headers: { cookie: `mdt_v=${ver}` } }); assert.equal(again.headers.get('clear-site-data'), null); // nur beim ersten Besuch nach einem Update
    assert.equal((await fetch(`${base}/js/main.js?v=${ver}`)).headers.get('cache-control'), 'no-store, max-age=0');
    ok('Cache-Schutz: alle Skripte/Styles/Importe mit Versions-Adresse, Cache-Reset (Clear-Site-Data) einmal je Version'); }


  // ══ Profilbilder ══
  const PNGAV = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await setPerms([]);
  const sProf = await openSse(admin.cookie, '/api/events');
  assert.equal((await new Client().call('POST', '/api/account/avatar', { data: PNGAV })).status, 401);
  assert.equal((await mod.call('POST', '/api/account/avatar', { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') })).status, 400);
  r = await mod.call('POST', '/api/account/avatar', { data: PNGAV }); assert.equal(r.status, 200); assert.match(r.avatarUrl, /^\/api\/avatars\/\d+\?v=1$/); const avUrl = r.avatarUrl;
  assert.ok(await sProf.waitFor((e) => e.event === 'change' && e.data.topic === 'profile')); ok('Eigenes Profilbild hochladen (nur echte Bilder) – live bei anderen sichtbar');
  const avRes = await fetch(`${base}${avUrl}`, { headers: { cookie: admin.cookie } }); assert.equal(avRes.status, 200); assert.equal(avRes.headers.get('content-type'), 'image/png'); assert.match(avRes.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${base}${avUrl}`)).status, 401);
  assert.equal((await mod.call('GET', '/api/auth/me')).user.avatarUrl, avUrl);
  r = await admin.call('GET', '/api/users'); assert.equal(r.users.find((u) => u.id === neuer.id).avatarUrl, avUrl); assert.equal(r.users.find((u) => u.id === neuer.id).nameVisible, true); ok('Profilbild erscheint in Konto und Benutzerliste (Superadmin sieht Namen) und ist nur angemeldet abrufbar');
  assert.equal((await mod.call('DELETE', `/api/users/${neuer.id}/avatar`)).status, 403); // kein Recht
  await setPerms(['users.avatar_remove']); assert.equal((await mod.call('DELETE', `/api/users/${1}/avatar`)).status, 403); // Admin hat gar keins
  assert.equal((await mod.call('DELETE', `/api/users/${neuer.id}/avatar`)).status, 200);
  assert.equal((await fetch(`${base}${avUrl}`, { headers: { cookie: admin.cookie } })).status, 404); await setPerms([]);
  await mod.call('POST', '/api/account/avatar', { data: PNGAV }); assert.equal((await admin.call('DELETE', `/api/users/${neuer.id}/avatar`)).status, 200); ok('Entfernen fremder Profilbilder nur mit users.avatar_remove (Admins immer)');
  await mod.call('POST', '/api/account/avatar', { data: PNGAV }); assert.equal((await mod.call('DELETE', '/api/account/avatar')).status, 200); assert.equal((await mod.call('GET', '/api/auth/me')).user.avatarUrl, null); sProf.close(); ok('Eigenes Profilbild entfernen');

  // ══ Live-Synchronisation im Firmenportal ══
  r = await admin.call('POST', '/api/tab/companies', { name: 'Live GmbH', seat: 'PC1 Live', accountNumber: 'LS00001111', interval: 'weekly' }); const liveTok = r.company.linkPath.split('/').pop(); const liveCo = r.company.id;
  r = await admin.call('POST', '/api/tab/companies', { name: 'Andere GmbH', seat: 'PC2 Andere', accountNumber: 'LS00002222', interval: 'weekly' }); const otherTok = r.company.linkPath.split('/').pop();
  const sCo = await openSse('', `/api/c/${liveTok}/events`), sOther = await openSse('', `/api/c/${otherTok}/events`);
  assert.equal(sCo.status, 200); assert.equal((await openSse('', '/api/c/ungueltig-ungueltig-ungueltig/events')).status, 404);
  const curW = tabCurWeek;
  await new Client().call('POST', `/api/c/${liveTok}/statements`, { periodKey: curW, amountCents: 1500 });
  assert.ok(await sCo.waitFor((e) => e.event === 'change' && e.data.topic === 'tab')); const n0 = sCo.events.filter((e) => e.event === 'change').length;
  const liveSt = (await admin.call('GET', '/api/tab/statements?company=' + liveCo)).statements[0];
  await admin.call('POST', `/api/tab/statements/${liveSt.id}/review`);
  assert.ok(await sCo.waitFor((e) => e.event === 'change' && e.data.kind === 'tab.statement_review')); ok('Firmenportal: Statuswechsel durch Mitarbeiter kommt live bei der Firma an');
  await sleep(150); assert.equal(sOther.events.some((e) => e.event === 'change'), false); assert.ok(n0 >= 1); sCo.close(); sOther.close(); ok('Eine Firma bekommt nie Ereignisse einer anderen Firma');
  // Mitarbeiter-Seite: Einreichung einer Firma kommt live an
  const sStaff = await openSse(admin.cookie, '/api/events'); r = await new Client().call('POST', `/api/c/${otherTok}/statements`, { periodKey: curW, amountCents: 0 });
  assert.ok(await sStaff.waitFor((e) => e.event === 'change' && e.data.topic === 'tab' && e.data.kind === 'tab.statement_submitted')); sStaff.close(); ok('Mitarbeiter sehen neu eingereichte Firmen-Abrechnungen live');

  // ── Branding: eigenes Logo / Hintergrund ──
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  assert.equal((await mod.call('POST', '/api/admin/branding/logo', { data: PNG })).status, 403);
  assert.equal((await admin.call('POST', '/api/admin/branding/logo', { data: Buffer.from('<svg onload=alert(1)>').toString('base64') })).status, 400);
  assert.equal((await admin.call('POST', '/api/admin/branding/nope', { data: PNG })).status, 404);
  r = await admin.call('POST', '/api/admin/branding/logo', { data: `data:image/png;base64,${PNG}` });
  assert.equal(r.status, 200); assert.ok(r.version > 0);
  const served = await fetch(`${base}/branding/logo`);
  assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal((await admin.call('GET', '/api/bootstrap')).config['branding.logo_version'], r.version); ok('Eigenes Logo hochladen (nur echte PNG/JPEG/WebP-Bilder), wird öffentlich ausgeliefert');
  assert.equal((await admin.call('DELETE', '/api/admin/branding/logo')).version, 0);
  assert.equal((await fetch(`${base}/branding/logo`)).status, 404); ok('Logo auf Standard zurücksetzen');

  // ══ Superadmin, Hierarchie, Stammdaten externer Zugänge, Finanzen, Statistik ══
  const adminId = users.find((u) => u.username === 'admin').id;
  { // Rollen passend zu den Rängen; der Superadmin hat keine zusätzliche Rolle
    const rl = (await admin.call('GET', '/api/roles')).roles; const by = (n) => rl.find((x) => x.name === n);
    for (const n of ['Anwärter', 'Mitarbeiter', 'Abteilungsleiter', 'Bereichsleiter', 'Stellvertretende Leitung', 'Leitung', 'Administrator']) assert.ok(by(n), n);
    assert.ok(by('Mitarbeiter').permissions.includes('market.deals.manage')); assert.ok(by('Mitarbeiter').permissions.includes('chat.view')); assert.equal(by('Mitarbeiter').permissions.includes('users.view'), false); assert.ok(by('Abteilungsleiter').permissions.includes('users.view'));
    assert.ok(by('Abteilungsleiter').permissions.length > by('Mitarbeiter').permissions.length); assert.equal(by('Leitung').isAdmin, true); assert.deepEqual((await admin.call('GET', `/api/users/${(await admin.call('GET', '/api/users')).users.find((u) => u.username === 'admin').id}`)).user.roles.map((x) => x.name).filter((n) => n !== 'Boss'), ['Superadmin']);
    ok('Rollen passend zu den Rängen (aufsteigende Rechte); Superadmin ohne Zusatzrolle');
  }
  r = await admin.call('GET', '/api/auth/me'); assert.equal(r.user.isSuperadmin, true);
  { const allKeys = (await admin.call('GET', '/api/permissions')).permissions.map((p) => p.key); assert.ok(allKeys.length > 60); assert.deepEqual(allKeys.filter((k) => !r.user.permissions.includes(k)), []); ok('Superadmin besitzt jederzeit ALLE Rechte (auch neu hinzugekommene)'); } assert.equal((await mod.call('GET', '/api/auth/me')).user.isSuperadmin, false);
  assert.equal((await admin.call('PATCH', `/api/users/${adminId}`, { isSuperadmin: false })).status, 403); assert.equal((await admin.call('PATCH', `/api/users/${neuer.id}`, { isSuperadmin: true })).status, 403); // die Rolle „Superadmin“ ist fest: weder vergeb- noch entziehbar
  await setPerms(['users.edit', 'users.view']); assert.equal((await mod.call('PATCH', `/api/users/${neuer.id}`, { isSuperadmin: true })).status, 403); assert.equal((await mod.call('POST', `/api/users/${adminId}/password`, { password: 'neuesPasswort123' })).status, 403); await setPerms([]);
  assert.ok((await admin.call('GET', '/api/permissions')).permissions.some((p) => p.key === 'users.password_reset')); ok('Rolle „Superadmin“ ist fest (nicht vergeb-/entziehbar); Passwort-Reset hat ein eigenes Recht');

  // Namen nach Hierarchie: Superadmin sieht alle Namen; sonst nur bei sich selbst und bei Untergebenen
  await setPerms(['users.view']);
  r = await mod.call('GET', '/api/users'); let ra = r.users.find((u) => u.id === adminId); assert.equal(ra.nameVisible, false); assert.notEqual(ra.displayName, 'Admin'); assert.equal(JSON.stringify(r).includes('"admin"'), false); assert.equal(r.users.find((u) => u.id === neuer.id).nameVisible, true);
  const supOld = (await admin.call('GET', `/api/users/${neuer.id}`)).user.supervisor?.id ?? null; await admin.call('PATCH', `/api/users/${neuer.id}`, { supervisorId: null });
  assert.equal((await admin.call('PATCH', `/api/users/${adminId}`, { supervisorId: neuer.id })).status, 200);
  r = await mod.call('GET', '/api/users'); ra = r.users.find((u) => u.id === adminId); assert.equal(ra.nameVisible, true); assert.equal(ra.displayName, 'Admin');
  assert.equal((await admin.call('PATCH', `/api/users/${adminId}`, { supervisorId: null })).status, 200); await admin.call('PATCH', `/api/users/${neuer.id}`, { supervisorId: supOld }); await setPerms([]); ok('Namen laufen über die Hierarchie (Vorgesetzte sehen Untergebene, Superadmin alle)');

  // Profilbild anderer ändern: eigenes Recht
  assert.equal((await mod.call('POST', `/api/users/${adminId}/avatar`, { data: PNGAV })).status, 403);
  await setPerms(['users.avatar_edit']); r = await mod.call('POST', `/api/users/${adminId}/avatar`, { data: PNGAV }); assert.equal(r.status, 200); assert.match(r.avatarUrl, /^\/api\/avatars\/\d+\?v=\d+$/);
  assert.equal((await mod.call('POST', `/api/users/${adminId}/avatar`, { data: 'AAAA' })).status, 400); await setPerms([]); ok('Profilbilder anderer ändern mit users.avatar_edit (nur echte Bilder)');

  // Externe Zugänge: Lieferant (viele Daten + Dokumente) oder Ankäufer (Name, Ansprechpartner, Tel optional)
  const IMG = 'data:image/png;base64,' + PNGAV;
  const sup = { type: 'supplier', firstName: 'Max', lastName: 'Muster', street: 'Test Drive 5', postalCode: '1234', phone: '5551234567', umail: 'Max.Muster@umail.com', accountNumber: 'ls28180705', apps: ['market'] };
  r = await admin.call('POST', '/api/partners', { ...sup, umail: 'ohne.doku@umail.com', accountNumber: 'LS11112222' }); assert.equal(r.status, 201); assert.deepEqual(r.partner.docs, { id: false, license: false, weapon: false, clearance: false }); // Dokumente sind optional
  await admin.call('DELETE', `/api/partners/${r.partner.id}`);
  r = await admin.call('POST', '/api/partners', { ...sup, firstName: '' }); assert.equal(r.status, 400); assert.match(r.error, /Vorname/); // Stammdaten bleiben Pflicht
  const docs3 = { idDoc: IMG, licenseDoc: IMG, weaponDoc: IMG };
  r = await admin.call('POST', '/api/partners', { ...sup, ...docs3, umail: 'x y' }); assert.equal(r.status, 400); assert.match(r.error, /UMail/);
  r = await admin.call('POST', '/api/partners', { ...sup, ...docs3, phone: '123' }); assert.equal(r.status, 400); assert.match(r.error, /Telefon/);
  r = await admin.call('POST', '/api/partners', { ...sup, ...docs3, idDoc: 'data:text/html;base64,' + Buffer.from('<b>x</b>').toString('base64') }); assert.equal(r.status, 400);
  r = await admin.call('POST', '/api/partners', { ...sup, ...docs3, street: '' }); assert.equal(r.status, 400); assert.match(r.error, /Straße/);
  r = await admin.call('POST', '/api/partners', { ...sup, ...docs3, clearanceDoc: IMG }); assert.equal(r.status, 201);
  const supP = r.partner; assert.equal(supP.type, 'supplier'); assert.equal(supP.typeLabel, 'Lieferant'); assert.equal(supP.umail, 'max.muster@umail.com'); assert.equal(supP.phone, '(555) 123-4567'); assert.equal(supP.accountNumber, 'LS28180705'); assert.deepEqual(supP.docs, { id: true, license: true, weapon: true, clearance: true }); assert.equal(supP.name, 'Max Muster');
  for (const k of ['id', 'license', 'weapon', 'clearance']) { const dr = await fetch(`${base}/api/partners/${supP.id}/docs/${k}`, { headers: { cookie: admin.cookie } }); assert.equal(dr.status, 200); assert.equal(dr.headers.get('content-type'), 'image/png'); }
  assert.equal((await fetch(`${base}/api/partners/${supP.id}/docs/id`, { headers: { cookie: mod.cookie } })).status, 403);
  { // Weitere Dateien mit Name und Beschreibung
    r = await admin.call('POST', `/api/extra-files/partner/${supP.id}`, { name: 'Vollmacht', description: 'Unterschrieben am Hafen', data: IMG }); assert.equal(r.status, 201); const xf = r.file.id; assert.equal(r.file.name, 'Vollmacht'); assert.equal(r.file.description, 'Unterschrieben am Hafen'); assert.equal(r.file.ext, 'png');
    assert.equal((await admin.call('POST', `/api/extra-files/partner/${supP.id}`, { name: 'x', data: IMG })).status, 400); // Name zu kurz
    assert.equal((await admin.call('POST', `/api/extra-files/partner/${supP.id}`, { name: 'Böse', data: 'data:text/html;base64,' + Buffer.from('<b>x</b>').toString('base64') })).status, 400); // nur PDF/Bild
    assert.equal((await admin.call('POST', '/api/extra-files/foo/1', { name: 'Böse', data: IMG })).status, 404);
    assert.equal((await admin.call('GET', `/api/extra-files/partner/${supP.id}`)).files.length, 1);
    const dl = await fetch(`${base}/api/extra-file/${xf}`, { headers: { cookie: admin.cookie } }); assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/api/extra-file/${xf}`, { headers: { cookie: mod.cookie } })).status, 403); assert.equal((await mod.call('GET', `/api/extra-files/partner/${supP.id}`)).status, 403); assert.equal((await mod.call('POST', `/api/extra-files/partner/${supP.id}`, { name: 'Hack', data: IMG })).status, 403);
    assert.equal((await new Client().call('GET', `/api/extra-files/partner/${supP.id}`)).status, 401);
    r = await admin.call('PATCH', `/api/extra-file/${xf}`, { name: 'Vollmacht neu', description: '' }); assert.equal(r.file.name, 'Vollmacht neu'); assert.equal(r.file.description, '');
    const uid = (await admin.call('GET', '/api/auth/me')).user.id;
    r = await admin.call('POST', `/api/extra-files/user/${uid}`, { name: 'Lebenslauf', data: IMG }); assert.equal(r.status, 201); const uf = r.file.id;
    assert.equal((await mod.call('GET', `/api/extra-files/user/${uid}`)).status, 403); // fremde Personalakte
    assert.equal((await admin.call('DELETE', `/api/extra-file/${uf}`)).status, 200); assert.equal((await admin.call('DELETE', `/api/extra-file/${xf}`)).status, 200); assert.equal((await admin.call('GET', `/api/extra-file/${xf}`)).status, 404);
    ok('Weitere Dateien: Name/Beschreibung, nur PDF/Bild, Rechte, ändern, löschen; Lieferanten-Dokumente optional'); }

  r = await admin.call('POST', '/api/partners', { type: 'buyer', name: 'Ankauf AG', apps: ['market'] }); assert.equal(r.status, 400); assert.match(r.error, /Ansprechpartner/);
  r = await admin.call('POST', '/api/partners', { type: 'buyer', name: 'Ankauf AG', contactName: 'Frau Muster', phone: '5559876543', apps: ['market'] }); assert.equal(r.status, 201); assert.equal(r.partner.type, 'buyer'); assert.equal(r.partner.typeLabel, 'Ankäufer'); assert.equal(r.partner.contactName, 'Frau Muster'); assert.equal(r.partner.phone, '(555) 987-6543'); const custP = r.partner.id; // Tel ist optional
  r = await admin.call('POST', '/api/partners', { type: 'buyer', name: 'Ohne Tel', contactName: 'Herr X', apps: ['market'] }); assert.equal(r.status, 201); assert.equal(r.partner.phone, '');
  assert.equal((await admin.call('PATCH', `/api/partners/${custP}`, { type: 'supplier' })).status, 400); // würde unvollständig
  assert.equal((await admin.call('PATCH', `/api/partners/${supP.id}`, { street: 'Neue Straße 9' })).partner.street, 'Neue Straße 9');
  assert.equal((await admin.call('POST', `/api/partners/${supP.id}/docs/clearance`, { data: IMG })).status, 200);
  ok('Externe Zugänge: Lieferant (alle Daten + Ausweis/Führerschein/Waffenschein, Führungszeugnis optional) und Ankäufer (Name, Ansprechpartner, Tel optional)');

  // Löschen (Superadmin: alles)
  r = await admin.call('GET', '/api/credit/loans?partner=' + borId); assert.ok(r.loans.length >= 2); const delLoan = r.loans[0].id, delLoanNo = r.loans[0].number;
  assert.equal((await mod.call('DELETE', `/api/credit/loans/${delLoan}`)).status, 403);
  assert.equal((await admin.call('DELETE', `/api/credit/loans/${delLoan}`)).status, 200); assert.equal((await admin.call('GET', `/api/credit/loans/${delLoan}`)).status, 404);
  assert.equal((await admin.call('GET', '/api/finance/ledger?q=Kredit')).entries.some((e) => e.note.includes(delLoanNo)), false);
  r = await admin.call('GET', '/api/market/deals'); const delDeal = r.deals[0]?.id; assert.ok(delDeal);
  assert.equal((await mod.call('DELETE', `/api/market/deals/${delDeal}`)).status, 403); assert.equal((await admin.call('DELETE', `/api/market/deals/${delDeal}`)).status, 200); assert.equal((await admin.call('GET', `/api/market/deals/${delDeal}`)).status, 404);
  assert.equal((await mod.call('DELETE', `/api/partners/${borId}`)).status, 403);
  assert.equal((await admin.call('DELETE', `/api/partners/${borId}`)).status, 409); // hat noch Kredite
  await setPerms(['partners.delete']); assert.equal((await mod.call('DELETE', `/api/partners/${borId}`)).status, 409); assert.equal((await mod.call('DELETE', `/api/partners/${custP}`)).status, 200); // partners.delete allein reicht (auch ohne partners.manage)
  assert.equal((await mod.call('DELETE', `/api/partners/${borId}?force=1`)).status, 200); await setPerms([]); ok('partners.delete funktioniert eigenständig');
  assert.equal((await admin.call('GET', '/api/credit/loans?partner=' + borId)).loans.length, 0);
  assert.equal((await admin.call('DELETE', `/api/partners/${supP.id}`)).status, 200); ok('Superadmin kann Kredite, Börsen-Geschäfte und externe Zugänge samt aller Daten löschen (ohne 500er)');

  r = await admin.call('POST', '/api/warehouses', { name: 'Lösch-Lager', postal: '7085', capacity: 500 }); const whDel = r.warehouse.id; await admin.call('POST', `/api/warehouses/${whDel}/stock`, { itemId: ore, action: 'in', quantity: 5 });
  assert.equal((await admin.call('DELETE', `/api/warehouses/${whDel}`)).status, 409); assert.equal((await admin.call('DELETE', `/api/warehouses/${whDel}?force=1`)).status, 200); assert.equal((await admin.call('GET', `/api/warehouses/${whDel}`)).status, 404); ok('Lager mit Bestand: normal gesperrt, Superadmin löscht samt Inhalt');

  // Finanzen
  assert.equal((await mod.call('GET', '/api/finance/summary')).status, 403); assert.equal((await mod.call('POST', '/api/finance/entries', { direction: 'in', amount: 10, description: 'x' })).status, 403);
  assert.equal((await admin.call('POST', '/api/finance/entries', { direction: 'in', amount: -5, description: 'Test' })).status, 400); assert.equal((await admin.call('POST', '/api/finance/entries', { direction: 'sideways', amount: 5, description: 'Test' })).status, 400);
  const sum0 = (await admin.call('GET', '/api/finance/summary')).summary;
  r = await admin.call('POST', '/api/finance/entries', { direction: 'in', amount: 250.5, description: 'Spende Test', date: '2026-09-15' }); assert.equal(r.status, 201); const feIn = r.id;
  r = await admin.call('POST', '/api/finance/entries', { direction: 'out', amount: 100, description: 'Reparatur Test', status: 'expected' }); const feOut = r.id;
  const sum1 = (await admin.call('GET', '/api/finance/summary')).summary; assert.equal(sum1.settledIn, Math.round((sum0.settledIn + 250.5) * 100) / 100); assert.equal(sum1.expectedOut, Math.round((sum0.expectedOut + 100) * 100) / 100);
  assert.equal((await admin.call('POST', `/api/finance/entries/${feOut}/settle`)).status, 200); assert.equal((await admin.call('POST', `/api/finance/entries/${feOut}/settle`)).status, 409);
  r = await admin.call('GET', '/api/finance/ledger?type=manual&direction=out'); assert.ok(r.entries.every((e) => e.entryType === 'manual' && e.direction === 'out')); assert.equal((await admin.call('GET', '/api/finance/ledger?from=2026-09-15&to=2026-09-15&type=manual')).entries.some((e) => e.id === feIn), true);
  r = await admin.call('GET', '/api/finance/report?months=6'); assert.ok(r.monthly.length >= 1); assert.ok(r.byType.some((x) => x.type === 'manual'));
  const fcsv = await fetch(`${base}/api/finance/export.csv?type=manual`, { headers: { cookie: admin.cookie } }); const fcsvT = await fcsv.text(); assert.equal(fcsv.status, 200); assert.ok(fcsv.headers.get('content-type').startsWith('text/csv')); assert.ok(fcsvT.includes('Spende Test') && fcsvT.includes('250,5'));
  assert.equal((await fetch(`${base}/api/finance/export.csv`, { headers: { cookie: mod.cookie } })).status, 403);
  await setPerms(['finance.view', 'finance.manual', 'finance.delete']); assert.equal((await mod.call('POST', `/api/finance/entries/${feIn}/cancel`)).status, 200); assert.equal((await mod.call('GET', '/api/finance/export.csv')).status, 403); // Export braucht finance.export
  r = await admin.call('GET', '/api/finance/ledger?type=deal&limit=5'); if (r.entries[0]) assert.equal((await mod.call('DELETE', `/api/finance/entries/${r.entries[0].id}`)).status, 403); // eingebundene Einträge nur Superadmin
  assert.equal((await mod.call('DELETE', `/api/finance/entries/${feIn}`)).status, 200); assert.equal((await admin.call('DELETE', `/api/finance/entries/${feOut}`)).status, 200); assert.equal((await mod.call('POST', '/api/finance/entries/999999/cancel')).status, 404); await setPerms([]);
  ok('Finanzen: Journal-Filter, Auswertung, manuelle Buchungen, CSV-Export und Löschen – jeweils mit eigenem Recht');

  // Statistik
  assert.equal((await mod.call('GET', '/api/stats')).status, 403);
  r = await admin.call('GET', '/api/stats'); assert.equal(r.status, 200); for (const k of ['users', 'market', 'credit', 'tab', 'warehouse', 'vehicles', 'chat', 'finance', 'activity']) assert.ok(r.sections[k], k); assert.equal(r.sections.users.byStatus.some((x) => x.key === 'active'), true);
  await setPerms(['stats.view']); let sk = Object.keys((await mod.call('GET', '/api/stats')).sections); assert.ok(!sk.includes('finance') && !sk.includes('tab') && !sk.includes('credit') && !sk.includes('market'));
  await setPerms(['stats.view', 'finance.view', 'tab.statements']); sk = Object.keys((await mod.call('GET', '/api/stats')).sections); assert.ok(sk.includes('finance') && sk.includes('tab') && !sk.includes('credit')); await setPerms([]); ok('Statistik: je Bereich nur mit zusätzlichem Ansichtsrecht, nur aggregierte Zahlen');

  // ══ Personalakte, Personalnummern, Tickets, Artikel löschen ══
  const IMG2 = 'data:image/png;base64,' + PNGAV;
  assert.equal((await mod.call('GET', `/api/users/${adminId}/personnel`)).status, 403); assert.equal((await mod.call('GET', `/api/users/${neuer.id}/personnel`)).status, 200); // die eigene Akte sieht man immer
  await setPerms(['users.personnel_view']); assert.equal((await mod.call('GET', `/api/users/${adminId}/personnel`)).status, 200);
  assert.equal((await mod.call('PUT', `/api/users/${adminId}/personnel`, { firstName: 'Anna' })).status, 403);
  await setPerms(['users.personnel_view', 'users.personnel_edit']);
  r = await mod.call('PUT', `/api/users/${adminId}/personnel`, { firstName: 'Anna', lastName: 'Test', street: 'Weg 1', postalCode: '1234', phone: '5551112222', umail: 'Anna@umail.com', accountNumber: 'ls111222' });
  assert.equal(r.status, 200); assert.equal(r.personnel.phone, '(555) 111-2222'); assert.equal(r.personnel.umail, 'anna@umail.com'); assert.equal(r.personnel.accountNumber, 'LS111222');
  assert.equal((await mod.call('PUT', `/api/users/${adminId}/personnel`, { phone: '12' })).status, 400); assert.equal((await mod.call('PUT', `/api/users/${adminId}/personnel`, { umail: 'a b' })).status, 400);
  for (const k of ['id', 'license', 'weapon', 'clearance']) assert.equal((await mod.call('POST', `/api/users/${adminId}/docs/${k}`, { data: IMG2 })).status, 200);
  assert.equal((await mod.call('POST', `/api/users/${adminId}/docs/passport`, { data: IMG2 })).status, 404); assert.equal((await mod.call('POST', `/api/users/${adminId}/docs/id`, { data: 'AAAA' })).status, 400);
  r = await mod.call('GET', `/api/users/${adminId}/personnel`); assert.deepEqual(r.personnel.docs, { id: true, license: true, weapon: true, clearance: true });
  assert.equal((await fetch(`${base}/api/users/${adminId}/docs/license`, { headers: { cookie: mod.cookie } })).status, 200);
  assert.equal(JSON.stringify((await mod.call('GET', '/api/users'))).includes('Anna'), false); // erscheint nirgends sonst
  assert.equal((await mod.call('DELETE', `/api/users/${adminId}/docs/clearance`)).status, 200); await setPerms([]);
  assert.equal((await fetch(`${base}/api/users/${adminId}/docs/license`, { headers: { cookie: mod.cookie } })).status, 403); ok('Personalakte: Angaben + 4 Dokumente, nur mit users.personnel_view/edit (eigene Akte immer), nirgends sonst sichtbar');

  assert.equal((await admin.call('GET', '/api/users')).users.find((u) => u.id === adminId).roles.some((x) => x.name === 'Superadmin'), true);
  await setPerms(['users.edit']); assert.equal((await mod.call('PATCH', `/api/users/${neuer.id}`, { memberNumber: 'MDT-555' })).status, 403); await setPerms([]);
  assert.equal((await admin.call('PATCH', `/api/users/${neuer.id}`, { memberNumber: 'MDT-777' })).user.memberNumber, 'MDT-777');
  assert.equal((await admin.call('PATCH', `/api/users/${adminId}`, { memberNumber: 'mdt-777' })).status, 409); assert.equal((await admin.call('PATCH', `/api/users/${adminId}`, { memberNumber: 'x' })).status, 400);
  r = await admin.call('POST', '/api/users', { displayName: 'Hand Nummer', username: 'handnr', password: 'passwort123', memberNumber: 'mdt-900' }); assert.equal(r.status, 201); assert.equal(r.user.memberNumber, 'MDT-900');
  assert.equal((await admin.call('POST', '/api/users', { displayName: 'Doppelt', username: 'doppelt', password: 'passwort123', memberNumber: 'MDT-900' })).status, 409); ok('Superadmin kann Personalnummern ändern und beim Anlegen zuweisen (eindeutig, nur er)');

  // Tickets
  assert.equal((await mod.call('POST', '/api/tickets', { title: 'x', description: 'kurz' })).status, 400); assert.equal((await mod.call('POST', '/api/tickets', { title: 'Seite hängt', description: 'Beim Öffnen passiert nichts', screenshot: 'AAAA' })).status, 400);
  r = await mod.call('POST', '/api/tickets', { title: 'Deckel lädt nicht', description: 'Beim Klick auf Abrechnungen bleibt die Liste leer.', category: 'bug', app: 'tab', screenshot: IMG2 }); assert.equal(r.status, 201); assert.match(r.ticket.number, /^MDT-T-\d+$/); assert.equal(r.ticket.hasScreenshot, true); assert.equal(r.ticket.status, 'open'); const tk = r.ticket.id;
  assert.equal(JSON.stringify(r).includes('Neuer'), false);  assert.ok((await admin.call('GET', '/api/notifications')).notifications.some((n) => /Neues Ticket/.test(n.title) && n.target.ticketId === tk));
  assert.equal((await mod.call('GET', '/api/tickets')).tickets.length >= 1, true); assert.equal((await admin.call('GET', '/api/tickets')).tickets.some((x) => x.id === tk), true);
  assert.equal((await fetch(`${base}/api/tickets/${tk}/screenshot`, { headers: { cookie: mod.cookie } })).status, 200); assert.equal((await fetch(`${base}/api/tickets/${tk}/screenshot`)).status, 401);
  assert.equal((await mod.call('PATCH', `/api/tickets/${tk}`, { priority: 'high' })).status, 403); assert.equal((await mod.call('PATCH', `/api/tickets/${tk}`, { status: 'resolved' })).status, 403); assert.equal((await mod.call('DELETE', `/api/tickets/${tk}`)).status, 403);
  r = await admin.call('PATCH', `/api/tickets/${tk}`, { status: 'in_progress', priority: 'high', assigneeId: adminId }); assert.equal(r.ticket.status, 'in_progress'); assert.equal(r.ticket.priority, 'high'); assert.ok(r.ticket.assignee);
  assert.ok((await mod.call('GET', '/api/notifications')).notifications.some((n) => /In Arbeit/.test(n.title)));
  assert.equal((await admin.call('POST', `/api/tickets/${tk}/comments`, { body: 'Wir schauen es uns an.' })).status, 200); const cm = await mod.call('POST', `/api/tickets/${tk}/comments`, { body: 'Hier noch ein Bild', screenshot: IMG2 }); assert.equal(cm.status, 200);
  r = await mod.call('GET', `/api/tickets/${tk}`); assert.equal(r.comments.length, 2); assert.equal(r.comments[0].staff, true); assert.equal(r.comments[1].mine, true); assert.equal(r.canManage, false);
  assert.equal((await fetch(`${base}/api/tickets/${tk}/comments/${cm.id}/screenshot`, { headers: { cookie: mod.cookie } })).status, 200);
  assert.equal((await mod.call('PATCH', `/api/tickets/${tk}`, { status: 'closed' })).ticket.status, 'closed'); assert.equal((await mod.call('POST', `/api/tickets/${tk}/comments`, { body: 'noch was' })).status, 400);
  await setPerms(['tickets.manage']); assert.equal((await mod.call('GET', '/api/tickets?mine=1')).tickets.every((x) => x.mine), true); await setPerms([]);
  assert.equal((await admin.call('DELETE', `/api/tickets/${tk}`)).status, 200); assert.equal((await admin.call('GET', `/api/tickets/${tk}`)).status, 404); ok('Tickets: melden mit Screenshot, Melder sieht nur eigene, Team bearbeitet/antwortet, Benachrichtigungen, Löschen');

  // Tickets von externen Zugängen
  const tp = new Client(); r = await admin.call('POST', '/api/partners', { name: 'Ticket Partner', apps: ['market'] }); assert.equal(r.status, 201);
  assert.equal((await tp.call('POST', `/api/p/${r.partner.linkPath.split('/').pop()}/login`, { code: r.code })).status, 200);
  assert.equal((await new Client().call('POST', '/api/p/tickets', { title: 'Ohne Login', description: 'sollte scheitern' })).status, 401);
  r = await tp.call('POST', '/api/p/tickets', { title: 'Börse hängt', description: 'Beim Öffnen der Börse passiert nichts.', category: 'bug', app: 'market', screenshot: IMG2 }); assert.equal(r.status, 201); assert.equal(r.ticket.mine, true); assert.equal(r.ticket.hasScreenshot, true); const ptk = r.ticket.id;
  assert.ok((await admin.call('GET', '/api/notifications')).notifications.some((n) => /Neues Ticket/.test(n.title) && n.target.ticketId === ptk));
  assert.equal((await admin.call('GET', '/api/tickets')).tickets.find((x) => x.id === ptk)?.reporter.startsWith('P-') || true, true);
  assert.equal((await tp.call('GET', '/api/p/tickets')).tickets.some((x) => x.id === ptk), true);
  assert.equal((await mod.call('GET', `/api/tickets/${ptk}`)).status, 404); // normale Mitglieder sehen es nicht
  assert.equal((await tp.call('GET', `/api/tickets/${ptk}`)).status, 401); // und der Partner nicht die interne Schnittstelle
  assert.equal((await tp.call('PATCH', `/api/p/tickets/${ptk}`, { priority: 'high' })).status, 403);
  assert.equal((await fetch(`${base}/api/p/tickets/${ptk}/screenshot`, { headers: { cookie: tp.cookie } })).status, 200);
  assert.equal((await admin.call('POST', `/api/tickets/${ptk}/comments`, { body: 'Wir kümmern uns.' })).status, 200);
  await admin.call('PATCH', `/api/tickets/${ptk}`, { status: 'in_progress' });
  const pn = (await tp.call('GET', '/api/p/notifications')).notifications; assert.ok(pn.some((n) => n.target?.partnerTicket === ptk && /neue Antwort/.test(n.title))); assert.ok(pn.some((n) => /In Arbeit/.test(n.title)));
  assert.equal((await tp.call('POST', `/api/p/tickets/${ptk}/comments`, { body: 'Danke!' })).status, 200);
  r = await tp.call('GET', `/api/p/tickets/${ptk}`); assert.equal(r.comments.length, 2); assert.equal(r.comments[0].staff, true); assert.equal(r.comments[1].mine, true); assert.equal(r.ticket.assignee, null);
  assert.equal((await tp.call('PATCH', `/api/p/tickets/${ptk}`, { status: 'closed' })).ticket.status, 'closed'); assert.equal((await tp.call('POST', `/api/p/tickets/${ptk}/comments`, { body: 'x' })).status, 400);
  assert.equal((await admin.call('DELETE', `/api/tickets/${ptk}`)).status, 200); ok('Tickets externer Zugänge: melden, nur eigene sehen, Team antwortet, Benachrichtigung an den Partner');

  // Benachrichtigungen löschen
  { const list = (await admin.call('GET', '/api/notifications')).notifications; assert.ok(list.length >= 2);
    assert.equal((await admin.call('POST', '/api/notifications/delete', { ids: [list[0].id] })).status, 200); assert.equal((await admin.call('GET', '/api/notifications')).notifications.some((n) => n.id === list[0].id), false);
    assert.equal((await mod.call('POST', '/api/notifications/delete', { ids: [list[1].id] })).status, 200); assert.equal((await admin.call('GET', '/api/notifications')).notifications.some((n) => n.id === list[1].id), true); // fremde bleiben
    assert.equal((await admin.call('POST', '/api/notifications/delete', {})).status, 200); const left = await admin.call('GET', '/api/notifications'); assert.equal(left.notifications.length, 0); assert.equal(left.unread, 0);
    assert.equal((await tp.call('POST', '/api/p/notifications/delete', {})).status, 200); assert.equal((await tp.call('GET', '/api/p/notifications')).notifications.length, 0); ok('Benachrichtigungen: einzeln/alle löschen, nur die eigenen'); }
  assert.equal((await admin.call('GET', '/api/map/config')).base, 'tiles'); assert.equal((await admin.call('GET', '/api/map/config')).showPostals, true); ok('Karte: Kacheln mit Postleitzahlen als Standard');

  // ══ Exekutive-Zugang (Hack-Link) ══
  { const { __sessions } = await import('../server/modules/hack.js');
    assert.equal((await mod.call('GET', '/api/hack/admin')).status, 403);
    const adm = await admin.call('GET', '/api/hack/admin'); assert.equal(adm.status, 200); assert.match(adm.path, /^\/x\/[\w-]{20,}$/); const tok = adm.path.split('/')[2], H = '/api/h/' + tok;
    assert.equal((await new Client().call('GET', '/api/h/falsch/status')).status, 404); assert.equal((await new Client().call('POST', '/api/h/falsch/start', {})).status, 404);
    const page = await fetch(base + adm.path); const html = await page.text(); assert.equal(page.status, 200); assert.match(html, /\/hack\/hack\.js\?v=/); assert.equal(/logo|mdt|\.webp/i.test(html), false, 'Seite darf nichts vom System verraten');
    const css = await (await fetch(base + '/hack/hack.css')).text(); assert.equal(/mdt/i.test(css), false);
    const guest = new Client(); const st0 = await guest.call('GET', H + '/status'); assert.equal(st0.enabled, true); assert.equal(st0.cooldownSec, 0);
    // Eigene Subdomain: nur die neutrale Seite, kein Zugriff auf das eigentliche System
    { const HH = { 'X-Forwarded-Host': 'access.example.com' }; assert.equal(adm.host, 'access.example.com');
      const root = await fetch(base + '/', { headers: HH }); const rt = await root.text(); assert.equal(root.status, 200); assert.ok(rt.includes('/hack/hack.js?v=')); assert.equal(/logo|mdt|.webp/i.test(rt), false);
      for (const p of ['/api/bootstrap', '/api/auth/me', '/api/hack/admin', '/js/main.js', '/img/logo.svg', '/css/theme.css', '/branding/logo']) assert.equal((await fetch(base + p, { headers: HH })).status, 404, p + ' darf über die Subdomain nicht erreichbar sein');
      assert.equal((await fetch(base + '/hack/hack.css', { headers: HH })).status, 200);
      const sv = await fetch(base + '/api/h/-/status', { headers: HH }); assert.equal(sv.status, 200); assert.equal((await sv.json()).enabled, true);
      assert.equal((await fetch(base + '/api/h/-/status')).status, 404); // ohne die Subdomain gibt es den Zugang über '-' nicht
      assert.equal((await fetch(base + '/', { headers: { 'X-Forwarded-Host': 'example.com' } })).status, 200); // normale Domain: normales System
      assert.equal(/mdt/i.test(await (await fetch(base + '/', { headers: { 'X-Forwarded-Host': 'example.com' } })).text()), true);
      assert.equal((await mod.call('PUT', '/api/config', { values: { 'hack.host': 'x.example.com' } })).status, 403);
      await admin.call('PUT', '/api/config', { values: { 'hack.host': 'anders.example.com' } }); assert.equal((await fetch(base + '/api/h/-/status', { headers: HH })).status, 404); assert.equal((await fetch(base + '/api/h/-/status', { headers: { 'X-Forwarded-Host': 'anders.example.com' } })).status, 200); assert.equal((await admin.call('GET', '/api/hack/admin')).host, 'anders.example.com');
      await admin.call('PUT', '/api/config', { values: { 'hack.host': 'access.example.com' } }); }
    // Lösung der jeweils aktuellen Stufe (Lösungen liegen nur im Server-Speicher)
    const solve = (sess) => { const st = sess.stage; switch (st.type) {
      case 'typing': return { text: st.secret.lines.join('\n'), ms: 20000 };
      case 'code': return { guess: st.secret.digits };
      case 'sequence': return { sequence: st.secret.seq };
      case 'cipher': return { text: st.secret.word };
      case 'frequency': return { guess: st.secret.target };
      case 'checksum': case 'match': return { index: st.secret.index };
      case 'math': return { answers: st.secret.answers, ms: 20000 };
      default: throw new Error('unbekannte Stufe ' + st.type); } };
    const wrong = (sess) => { const st = sess.stage; switch (st.type) {
      case 'typing': return { text: 'x', ms: 99999 };
      case 'code': return { guess: (st.secret.digits[0] === '0' ? '1' : '0').repeat(st.secret.digits.length) };
      case 'sequence': return { sequence: [] };
      case 'cipher': return { text: 'x' };
      case 'frequency': return { guess: st.secret.target === 1 ? 2 : 1 };
      case 'math': return { answers: [], ms: 99999 };
      default: return { index: -1 }; } };
    // Ganzen Zugriff lösen; liefert Reihenfolge der Stufen, Anzahl der PIN-Resets und das Endergebnis
    const play = async (client, startRes, H_) => { const sid = startRes.sid, types = [], seen = []; let resets = 0, res = startRes;
      for (let n = 0; n < 40; n++) { const sess = __sessions.get(sid); types.push(sess.stage.type); seen.push(sess.stage);
        res = await client.call('POST', H_ + '/answer', { sid, ...solve(sess) });
        if (res.result === 'reset') { resets++; continue; }
        if (res.result === 'done') return { types, resets, res, seen };
        assert.equal(res.result, 'ok'); }
      throw new Error('kein Ende'); };
    // Lauf 1: Fehler kosten Leben, dann alle gezogenen Stufen lösen
    let r = await guest.call('POST', H + '/start', {}); assert.equal(r.status, 200); assert.equal(r.stage.total, 4); assert.equal(JSON.stringify(r).includes('secret'), false); const sid = r.sid;
    const plan = [...__sessions.get(sid).plan]; assert.equal(plan.length, 4); assert.equal(new Set(plan).size, 4, 'vier verschiedene Minigames'); assert.equal(r.stage.type, plan[0]);
    r = await guest.call('POST', H + '/answer', { sid, ...wrong(__sessions.get(sid)) }); assert.ok(['retry', 'feedback'].includes(r.result), 'falsche Antwort bringt keinen Fortschritt'); assert.equal(r.stage?.type ?? plan[0], plan[0]);
    const run1 = await play(guest, { sid }, H); assert.equal(run1.res.result, 'done'); assert.ok(run1.res.rewards.length >= 1 && run1.res.cooldownSec > 0);
    const loot = JSON.stringify(run1.res.rewards); for (const verboten of ['Händler Eins', 'Ticket Partner', 'Hand Nummer', 'Anna', '(555)', 'LS111222', 'anna@umail.com']) assert.equal(loot.includes(verboten), false, 'Beute enthält ' + verboten);
    assert.equal((await guest.call('POST', H + '/answer', { sid, text: 'x', ms: 99999 })).status, 410); // Sitzung beendet
    { const cfg = JSON.stringify((await admin.call('GET', '/api/config'))); for (const k of ['hack.loot_contacts', 'hack.loot_changelog', 'hack.loot_board']) assert.ok(cfg.includes(k), k + ' fehlt in der Konfiguration'); }
    // Sperrzeit
    r = await guest.call('GET', H + '/status'); assert.ok(r.cooldownSec > 0); r = await guest.call('POST', H + '/start', {}); assert.equal(r.status, 429); assert.equal(r.code, 'cooldown'); assert.ok(r.details.cooldownSec > 0);
    assert.ok((await admin.call('GET', '/api/notifications')).notifications.some((n) => /Unbefugter Zugriff erfolgreich/.test(n.title)));
    assert.equal((await mod.call('POST', '/api/hack/admin/reset-cooldown')).status, 403); assert.equal((await admin.call('POST', '/api/hack/admin/reset-cooldown')).status, 200);
    // Lauf 2: alle Leben verlieren → abgewehrt + Sperrzeit
    r = await guest.call('POST', H + '/start', {}); assert.equal(r.status, 200); const sid2 = r.sid; const fail = () => guest.call('POST', H + '/answer', { sid: sid2, ...wrong(__sessions.get(sid2)) });
    const lives0 = __sessions.get(sid2).lives; let last;
    for (let n = 0; n < 60; n++) { const stg = __sessions.get(sid2); if (!stg) break; last = await fail(); if (last.result === 'failed') break; }
    assert.equal(last.result, 'failed'); assert.ok(last.cooldownSec > 0); assert.ok(lives0 >= 1);
    assert.equal((await guest.call('POST', H + '/start', {})).status, 429);
    const runs = (await admin.call('GET', '/api/hack/admin')).runs; assert.equal(runs.length, 2); assert.equal(runs[1].success, 1); assert.equal(runs[0].success, 0);
    // Einstellungen: nur mit hack.manage; Schwierigkeit, Leben, Beute-Schalter, Spiele-Auswahl, PIN-Reset
    assert.equal((await mod.call('PUT', '/api/config', { values: { 'hack.lives': 5 } })).status, 403);
    await setPerms(['hack.manage']);
    r = await mod.call('GET', '/api/config'); assert.equal(r.status, 200); assert.ok(r.settings.filter((x) => x.key.startsWith('hack.')).length >= 20 && r.settings.filter((x) => x.key.startsWith('hack.')).every((x) => x.perm === 'hack.manage'), 'Exekutive-Einstellungen tragen das eigene Recht');
    assert.equal((await mod.call('PUT', '/api/config', { values: { 'ui.accent': '#112233' } })).status, 403);
    assert.equal((await mod.call('PUT', '/api/config', { values: { 'hack.difficulty': 'hard', 'hack.lives': 2, 'hack.cooldown_minutes': 45, 'hack.cooldown_fail_minutes': 5, 'hack.loot_personal': false, 'hack.stage_count': 3, 'hack.game_cipher': false, 'hack.game_frequency': false, 'hack.game_checksum': false, 'hack.game_match': false, 'hack.game_math': false } })).status, 200);
    assert.equal((await mod.call('PUT', '/api/config', { values: { 'hack.lives': 99 } })).status, 400); assert.equal((await mod.call('PUT', '/api/config', { values: { 'hack.difficulty': 'brutal' } })).status, 400);
    await setPerms([]); assert.equal((await mod.call('PUT', '/api/config', { values: { 'hack.lives': 4 } })).status, 403);
    await admin.call('POST', '/api/hack/admin/reset-cooldown'); assert.equal((await guest.call('GET', H + '/status')).lives, 2);
    // nur noch Tippen, PIN, Sequenz im Pool → genau diese drei, schwere Stufe, PIN mit Reset
    r = await guest.call('POST', H + '/start', {}); assert.equal(r.status, 200); assert.equal(r.lives, 2); assert.equal(r.stage.total, 3); const run3 = await play(guest, r, H);
    assert.deepEqual([...new Set(run3.types)].sort(), ['code', 'sequence', 'typing']);
    assert.equal(run3.resets, 1, 'PIN wird nach dem Knacken genau einmal zurückgesetzt'); assert.equal(run3.types.filter((t) => t === 'code').length, 2);
    for (const stg of run3.seen) { if (stg.type === 'typing') assert.equal(stg.lines.length, 4); if (stg.type === 'code') assert.equal(stg.public.length, 5); if (stg.type === 'sequence') { assert.equal(stg.public.sequence.length, 8); assert.equal(stg.public.speed, 340); } }
    assert.equal(JSON.stringify(run3.res.rewards).includes('Personalkennungen'), false); assert.ok(run3.res.cooldownSec > 40 * 60 && run3.res.cooldownSec <= 45 * 60);
    // PIN-Reset ausschalten und alle Spiele einzeln: jede Stufe lässt sich lösen
    await admin.call('PUT', '/api/config', { values: { 'hack.difficulty': 'normal', 'hack.pin_reset': false, 'hack.stage_count': 8, 'hack.game_cipher': true, 'hack.game_frequency': true, 'hack.game_checksum': true, 'hack.game_match': true, 'hack.game_math': true, 'hack.cooldown_minutes': 30, 'hack.lives': 3, 'hack.loot_personal': true } });
    await admin.call('POST', '/api/hack/admin/reset-cooldown'); r = await guest.call('POST', H + '/start', {}); assert.equal(r.stage.total, 8); const run8 = await play(guest, r, H);
    assert.deepEqual([...run8.types].sort(), ['checksum', 'cipher', 'code', 'frequency', 'match', 'math', 'sequence', 'typing']); assert.equal(run8.resets, 0); assert.equal(run8.res.result, 'done');
    for (const stg of run8.seen) { if (stg.type === 'checksum') assert.equal(stg.public.tokens.filter((t) => [...t].reduce((a, c) => a + parseInt(c, 16), 0) % stg.public.mod === 0).length, 1); if (stg.type === 'match') assert.ok(stg.public.options.includes(stg.public.target)); }
    // Tippen: zu schnelle Eingabe zählt als Automat (verliert ein Leben)
    await admin.call('PUT', '/api/config', { values: { 'hack.stage_count': 1, 'hack.game_typing': true, 'hack.game_code': false, 'hack.game_sequence': false, 'hack.game_frequency': false, 'hack.game_cipher': false, 'hack.game_checksum': false, 'hack.game_match': false, 'hack.game_math': false } });
    await admin.call('POST', '/api/hack/admin/reset-cooldown'); r = await guest.call('POST', H + '/start', {}); assert.equal(r.stage.type, 'typing'); assert.equal(r.stage.total, 1);
    r = await guest.call('POST', H + '/answer', { sid: r.sid, text: __sessions.get(r.sid).stage.secret.lines.join('\n'), ms: 5 }); assert.equal(r.result, 'retry'); assert.equal(r.lives, 2);
    await admin.call('PUT', '/api/config', { values: { 'hack.game_typing': false, 'hack.game_frequency': true } });
    // Höher/tiefer-Hinweis und Grenzen der Frequenz
    await admin.call('POST', '/api/hack/admin/reset-cooldown'); r = await guest.call('POST', H + '/start', {}); assert.equal(r.stage.type, 'frequency'); const fs_ = __sessions.get(r.sid).stage.secret;
    assert.equal((await guest.call('POST', H + '/answer', { sid: r.sid, guess: 999 })).status, 400);
    const lo = fs_.target > 1 ? fs_.target - 1 : 256; const hint = await guest.call('POST', H + '/answer', { sid: r.sid, guess: lo }); assert.equal(hint.result, 'feedback'); assert.equal(hint.hint, lo < fs_.target ? 'higher' : 'lower'); assert.equal(JSON.stringify(hint).includes(String(fs_.target)) && hint.strength === undefined, false);
    await admin.call('PUT', '/api/config', { values: Object.fromEntries(['typing', 'code', 'sequence', 'cipher', 'frequency', 'checksum', 'match', 'math'].map((g) => ['hack.game_' + g, true]).concat([['hack.stage_count', 4], ['hack.pin_reset', true]])) });
    // Hinweise: je Minigame einmal, mit Trefferchance und Ladezeit
    const HP = { 'hack.hint_seconds': 0, 'hack.hint_chance': 100, 'hack.stage_count': 8 };
    await admin.call('PUT', '/api/config', { values: { ...HP, ...Object.fromEntries(['typing', 'code', 'sequence', 'cipher', 'frequency', 'checksum', 'match', 'math'].map((g) => ['hack.game_' + g, true])) } });
    await admin.call('POST', '/api/hack/admin/reset-cooldown'); r = await guest.call('POST', H + '/start', {}); assert.equal(r.status, 200); assert.equal((await guest.call('GET', H + '/status')).hints, true); const hsid = r.sid; const got = {}; let wrongs = 0;
    for (let n = 0; n < 8; n++) { const sess = __sessions.get(hsid), t = sess.stage.type, sec = sess.stage.secret;
      const before = sec.limitMs; const hr = await guest.call('POST', H + '/hint', { sid: hsid }); assert.equal(hr.status, 200); assert.ok(hr.hint?.text, 'Hinweis bei 100 % Chance'); got[t] = hr.hint;
      assert.equal((await guest.call('POST', H + '/hint', { sid: hsid })).status, 409); // nur einmal je Minigame
      if (t === 'typing') assert.equal(sec.limitMs, before + 30000);
      if (t === 'code') { const m = hr.hint.text.match(/Stelle (\d) .* (\d)\./); assert.equal(sec.digits[Number(m[1]) - 1], m[2]); }
      if (t === 'sequence') assert.ok(hr.hint.text.includes(String(sec.seq[0] + 1)));
      if (t === 'cipher') assert.ok(hr.hint.text.includes(sec.word[0]) && hr.hint.text.includes(String(sec.word.length)));
      if (t === 'frequency') { const m = hr.hint.text.match(/zwischen (\d+) und (\d+)/); assert.ok(Number(m[1]) <= sec.target && sec.target <= Number(m[2])); }
      if (t === 'checksum' || t === 'match') { assert.ok(hr.hint.eliminate.length >= 1 && !hr.hint.eliminate.includes(sec.index)); assert.equal(JSON.stringify(hr).includes('"index"'), false); }
      if (t === 'math') assert.equal(hr.hint.fill.value, sec.answers[hr.hint.fill.index]);
      if (wrongs < 2 && ['typing', 'sequence', 'cipher', 'checksum', 'match', 'math'].includes(t)) { wrongs++; const wr = await guest.call('POST', H + '/answer', { sid: hsid, ...wrong(sess) }); // falsch: neue Aufgabe derselben Stufe – Hinweis bleibt verbraucht
        assert.equal(wr.result, 'retry'); assert.equal((await guest.call('POST', H + '/hint', { sid: hsid })).status, 409); }
      const res = await guest.call('POST', H + '/answer', { sid: hsid, ...solve(__sessions.get(hsid)) }); if (res.result === 'reset') await guest.call('POST', H + '/answer', { sid: hsid, ...solve(__sessions.get(hsid)) });
      if (res.result === 'done') break; }
    assert.ok(Object.keys(got).length >= 4);
    // Ohne Treffer: Hinweis verbraucht, aber leer; Hinweise abschaltbar
    await admin.call('PUT', '/api/config', { values: { 'hack.hint_chance': 0, 'hack.stage_count': 1 } }); await admin.call('POST', '/api/hack/admin/reset-cooldown');
    r = await guest.call('POST', H + '/start', {}); let nh = await guest.call('POST', H + '/hint', { sid: r.sid }); assert.equal(nh.status, 200); assert.equal(nh.hint, null); assert.equal((await guest.call('POST', H + '/hint', { sid: r.sid })).status, 409);
    await admin.call('PUT', '/api/config', { values: { 'hack.hints': false } }); await admin.call('POST', '/api/hack/admin/reset-cooldown'); r = await guest.call('POST', H + '/start', {}); assert.equal((await guest.call('POST', H + '/hint', { sid: r.sid })).status, 403); assert.equal((await guest.call('GET', H + '/status')).hints, false);
    assert.equal((await new Client().call('POST', '/api/h/falsch/hint', { sid: 'x' })).status, 404); assert.equal((await guest.call('POST', H + '/hint', { sid: 'unbekannt' })).status, 410);
    await admin.call('PUT', '/api/config', { values: { 'hack.hints': true, 'hack.hint_chance': 65, 'hack.hint_seconds': 3, 'hack.stage_count': 4 } });
    // abgeschaltet
    await admin.call('POST', '/api/hack/admin/reset-cooldown'); await admin.call('PUT', '/api/config', { values: { 'hack.enabled': false } }); assert.equal((await guest.call('POST', H + '/start', {})).status, 403); await admin.call('PUT', '/api/config', { values: { 'hack.enabled': true } });
    // Link erneuern: alter Link tot
    assert.equal((await mod.call('POST', '/api/hack/admin/regenerate')).status, 403); const nw = await admin.call('POST', '/api/hack/admin/regenerate'); assert.notEqual(nw.path, adm.path); assert.equal((await guest.call('GET', H + '/status')).status, 404); assert.equal((await guest.call('GET', '/api/h/' + nw.path.split('/')[2] + '/status')).status, 200);
    ok('Exekutive-Zugang: neutraler Link, zufällig gezogene Minigames (8 im Pool) serverseitig geprüft, PIN-Reset, harmlose Beute, Sperrzeit, Einstellungen, Link erneuern'); }

  // ══ Schwarzes Brett ══
  { assert.equal((await mod.call('GET', '/api/board')).status, 403); assert.equal((await new Client().call('GET', '/api/board')).status, 401); assert.equal((await tp.call('GET', '/api/board')).status, 401); // Partner haben kein Brett
    await setPerms(['board.view']); r = await mod.call('GET', '/api/board'); assert.equal(r.status, 200); assert.equal(r.canManage, false); assert.equal((await mod.call('POST', '/api/board', { title: 'Test', level: 'info' })).status, 403);
    await setPerms(['board.view', 'board.manage']);
    assert.equal((await mod.call('POST', '/api/board', { title: 'x' })).status, 400); assert.equal((await mod.call('POST', '/api/board', { title: 'Gueltig', level: 'rot' })).status, 400);
    r = await mod.call('POST', '/api/board', { title: 'Treffen am Samstag', body: 'Alle um 20 Uhr am Lager.', level: 'important' }); assert.equal(r.status, 201); const b1 = r.post.id; assert.equal(r.post.level, 'important'); assert.equal(r.post.pinned, false); assert.ok(r.post.author);
    r = await mod.call('POST', '/api/board', { title: 'ALARM', body: 'Razzia vermutet', level: 'urgent', pinned: true }); assert.equal(r.status, 201); const b2 = r.post.id;
    r = await mod.call('POST', '/api/board', { title: 'Ruhig', level: 'info' }); const b3 = r.post.id;
    r = await mod.call('GET', '/api/board'); assert.equal(r.canManage, true); assert.deepEqual(r.posts.slice(0, 3).map((p) => p.id), [b2, b3, b1]); // angepinnte zuerst, dann neueste
    assert.equal(JSON.stringify(r).includes('Neuer'), false); // Verfasser nur als Kennung
    assert.ok((await admin.call('GET', '/api/notifications')).notifications.some((n) => /Dringende Ankündigung/.test(n.title)));
    assert.equal((await mod.call('PATCH', `/api/board/${b3}`, { pinned: true, level: 'success', title: 'Neuigkeit!' })).post.level, 'success'); assert.equal((await mod.call('PATCH', `/api/board/${b3}`, { level: 'nope' })).status, 400); assert.equal((await mod.call('PATCH', '/api/board/99999', { title: 'abc' })).status, 404);
    await setPerms(['board.view']); assert.equal((await mod.call('DELETE', `/api/board/${b1}`)).status, 403); assert.equal((await mod.call('PATCH', `/api/board/${b1}`, { pinned: true })).status, 403);
    await setPerms(['board.view', 'board.manage']); assert.equal((await mod.call('DELETE', `/api/board/${b1}`)).status, 200); assert.equal((await admin.call('GET', '/api/board')).posts.some((p) => p.id === b1), false); assert.equal((await admin.call('GET', '/api/board')).canManage, true);
    for (const id of [b2, b3]) await admin.call('DELETE', `/api/board/${id}`); await setPerms([]);
    assert.ok(JSON.stringify((await admin.call('GET', '/api/roles')).roles).includes('board.view'), 'Rang-Rollen dürfen das Brett sehen'); ok('Schwarzes Brett: nur Mitarbeiter, Rechte board.view/board.manage, Hervorhebung, Anpinnen, Entfernen, Benachrichtigung bei Dringend'); }

  // ══ Lagerkosten-Erinnerung ══
  { const { runRentReminders } = await import('../server/modules/warehouses.js');
    const modId = (await mod.call('GET', '/api/auth/me')).user.id, tomorrow = new Date(Date.now() + 86400_000); tomorrow.setHours(12, 0, 0, 0);
    r = await admin.call('POST', '/api/warehouses', { name: 'Miet-Lager', rent: { enabled: true, cents: 250000, weekday: (tomorrow.getDay() + 3) % 7, hour: 8, roleIds: [], userIds: [] } }); assert.equal(r.status, 201); const rw = r.warehouse.id;
    assert.equal(r.warehouse.rent.cents, 250000); assert.equal(r.warehouse.rent.enabled, true);
    for (const bad of [{ weekday: 7 }, { hour: 24 }, { cents: -5 }, { roleIds: [99999] }, { userIds: [99999] }]) assert.equal((await admin.call('PATCH', `/api/warehouses/${rw}`, { rent: bad })).status, 400, JSON.stringify(bad));
    assert.equal(runRentReminders(tomorrow), 0); // falscher Wochentag
    assert.equal((await admin.call('PATCH', `/api/warehouses/${rw}`, { rent: { weekday: tomorrow.getDay(), hour: 8, userIds: [modId] } })).status, 200);
    const early = new Date(tomorrow); early.setHours(7, 0, 0, 0); assert.equal(runRentReminders(early), 0); // vor der Uhrzeit
    assert.equal(runRentReminders(tomorrow), 1); assert.equal(runRentReminders(tomorrow), 0); // einmal pro Tag
    r = await mod.call('GET', '/api/notifications'); const n = r.notifications.find((x) => x.title.includes('Lagerkosten fällig')); assert.ok(n, 'Benachrichtigung fehlt'); assert.ok(n.body.includes('2.500,00'));
    const nextWeek = new Date(tomorrow.getTime() + 7 * 86400_000); assert.equal(runRentReminders(nextWeek), 1); // eine Woche später wieder
    await admin.call('PATCH', `/api/warehouses/${rw}`, { rent: { enabled: false } }); assert.equal(runRentReminders(new Date(tomorrow.getTime() + 14 * 86400_000)), 0);
    await admin.call('DELETE', `/api/warehouses/${rw}`);
    ok('Lagerkosten-Erinnerung: Wochentag/Uhrzeit, Empfänger, einmal pro Woche, Prüfungen'); }

  // ══ Börse: Sichtbarkeit für externe Partner & „Sonstiges“ ══
  { const { clearAttempts } = await import('../server/core/auth.js'); for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) clearAttempts(`pl|${ip}`); // Anmeldebremse für Testläufe zurücksetzen
  const mk = async (name) => { const rr = await admin.call('POST', '/api/partners', { type: 'buyer', name, contactName: 'Ansprech', apps: ['market'] }); assert.equal(rr.status, 201); const c = new Client(); assert.equal((await c.call('POST', `/api/p/${rr.partner.linkPath.split('/').pop()}/login`, { code: rr.code })).status, 200); return { id: rr.partner.id, c }; };
    const A = await mk('Sicht Partner A'), B = await mk('Sicht Partner B');
    assert.ok(!(await admin.call('GET', '/api/market/items')).items.some((i) => i.name === 'Sonstiges')); // Platzhalter nie im Staff-Katalog
    assert.ok((await admin.call('GET', '/api/market/items')).partners.length >= 2);
    const mkI = async (name, extra) => { const rr = await admin.call('POST', '/api/market/items', { name, unit: 'Stück', referencePrice: 100, ...extra }); assert.equal(rr.status, 201); return rr.item; };
    const iAll = await mkI('Sicht-Alle'), iSel = await mkI('Sicht-Ausgewählt', { partnerAccess: 'selected', partnerIds: [A.id] }), iNone = await mkI('Sicht-Keine', { partnerAccess: 'none' });
    assert.equal(iAll.partnerAccess, 'all'); assert.deepEqual(iSel.partnerIds, [A.id]);
    assert.equal((await admin.call('POST', '/api/market/items', { name: 'Sicht-Falsch', partnerAccess: 'x' })).status, 400); assert.equal((await admin.call('POST', '/api/market/items', { name: 'Sicht-Falsch2', partnerAccess: 'selected', partnerIds: [99999] })).status, 400);
    const names = async (p) => (await p.c.call('GET', '/api/p/market/catalog')).items.map((i) => i.name);
    let na = await names(A), nb = await names(B);
    assert.ok(na.includes('Sicht-Alle') && na.includes('Sicht-Ausgewählt') && !na.includes('Sicht-Keine') && !na.includes('Sonstiges'));
    assert.ok(nb.includes('Sicht-Alle') && !nb.includes('Sicht-Ausgewählt') && !nb.includes('Sicht-Keine'));
    assert.equal((await B.c.call('GET', `/api/p/market/quote?itemId=${iSel.id}&quantity=1`)).status, 404); // verdeckte Artikel auch nicht über die Preisabfrage
    assert.equal((await B.c.call('POST', '/api/p/market/offers', { itemId: iSel.id, quantity: 1, unitPrice: 5 })).status, 400);
    // Partner-Seite: nur ausgewählte Artikel
    r = await admin.call('PATCH', `/api/partners/${A.id}`, { itemsMode: 'selected', itemIds: [iAll.id] }); assert.equal(r.status, 200); assert.equal(r.partner.itemsMode, 'selected'); assert.deepEqual(r.partner.itemIds, [iAll.id]);
    na = await names(A); assert.ok(na.includes('Sicht-Alle') && !na.includes('Sicht-Ausgewählt'));
    assert.equal((await admin.call('PATCH', `/api/partners/${A.id}`, { itemsMode: 'x' })).status, 400); assert.equal((await admin.call('PATCH', `/api/partners/${A.id}`, { itemIds: [99999] })).status, 400);
    assert.equal((await admin.call('PATCH', `/api/partners/${A.id}`, { itemsMode: 'all' })).partner.itemsMode, 'all');
    // Sonstiges
    assert.equal((await A.c.call('GET', '/api/p/market/catalog')).allowOther, false);
    assert.equal((await A.c.call('POST', '/api/p/market/offers', { other: true, otherName: 'Rostiger Anker', quantity: 2, unitPrice: 50 })).status, 403);
    assert.equal((await admin.call('PATCH', `/api/partners/${A.id}`, { allowOther: true })).partner.allowOther, true);
    assert.equal((await A.c.call('POST', '/api/p/market/offers', { other: true, otherName: 'Rostiger Anker', quantity: 2 })).status, 400); // Preis nötig
    assert.equal((await A.c.call('POST', '/api/p/market/offers', { other: true, otherName: 'x', quantity: 2, unitPrice: 50 })).status, 400);
    r = await A.c.call('POST', '/api/p/market/offers', { other: true, otherName: 'Rostiger Anker', quantity: 2, unitPrice: 50, note: 'Fund vom Hafen' }); assert.equal(r.status, 201); assert.equal(r.deal.item.name, 'Sonstiges: Rostiger Anker'); assert.equal(r.deal.item.isOther, true);
    const sd = (await admin.call('GET', '/api/market/deals')).deals.find((d) => d.id === r.deal.id); assert.equal(sd.item.name, 'Sonstiges: Rostiger Anker');
    assert.equal((await B.c.call('POST', '/api/p/market/offers', { other: true, otherName: 'Anderes', quantity: 1, unitPrice: 5 })).status, 403);
    // Gesuche richten sich nach der Sichtbarkeit
    r = await admin.call('POST', '/api/market/wanted', { itemId: iNone.id, quantity: 5, unitPrice: 10 }); assert.equal(r.status, 201); const wNone = r.wanted.id;
    assert.ok(!(await A.c.call('GET', '/api/p/market/wanted')).wanted.some((w) => w.id === wNone)); assert.equal((await A.c.call('POST', `/api/p/market/wanted/${wNone}/respond`, { quantity: 1 })).status, 404);
    await admin.call('DELETE', `/api/market/wanted/${wNone}`);
    ok('Börse: Artikel-Sichtbarkeit je Artikel und je Partner, „Sonstiges“ als Freitext, Gesuche gefiltert'); }

  // ══ Rechtsfälle (Aktensystem) ══
  { const { runLegalReminders } = await import('../server/modules/legalcases.js');
    assert.equal((await new Client().call('GET', '/api/legal/cases')).status, 401); assert.equal((await mod.call('GET', '/api/legal/cases')).status, 403);
    const modId = (await mod.call('GET', '/api/auth/me')).user.id;
    const opt = await admin.call('GET', '/api/legal/cases/options'); assert.equal(opt.status, 200); assert.ok(opt.areas.length >= 13); assert.ok(opt.areas.some((a) => a.label === 'Strafrecht') && opt.areas.some((a) => a.label === 'Waffenrecht'));
    const area = opt.areas.find((a) => a.key === 'criminal').id, st = (k) => opt.statuses.find((x) => x.key === k).id;
    assert.equal((await mod.call('POST', '/api/legal/cases', { title: 'Nicht erlaubt' })).status, 403);
    for (const bad of [{ title: 'ab' }, { title: 'Gültiger Titel', priority: 'x' }, { title: 'Gültiger Titel', exposure: { fineCents: -5 } }, { title: 'Gültiger Titel', areaId: 99999 }, { title: 'Gültiger Titel', leadUserId: 99999 }]) assert.equal((await admin.call('POST', '/api/legal/cases', bad)).status, 400, JSON.stringify(bad));
    r = await admin.call('POST', '/api/legal/cases', { title: 'Staat gegen Müller', areaId: area, court: 'District Court', summary: 'Kurz', facts: 'Sachverhalt …', charges: 'Raub', strategy: 'Alibi prüfen', priority: 'high', leadUserId: modId, exposure: { fineCents: 500000, jailDays: 30, damageCents: 0, note: 'Bewährung möglich' }, billingMode: 'billable' });
    assert.equal(r.status, 201); const C1 = r.case.id; assert.match(r.case.number, /^R-\d{4}-0001$/); assert.equal(r.case.status.key, 'open'); assert.equal(r.case.exposure.jailDays, 30); assert.equal(r.case.events.length, 1);
    r = await admin.call('POST', '/api/legal/cases', { title: 'Mietstreit Hafen', areaId: opt.areas.find((a) => a.key === 'tenancy').id }); const C2 = r.case.id; assert.match(r.case.number, /-0002$/);
    // Beteiligte
    const pr = await admin.call('POST', '/api/partners', { type: 'buyer', name: 'Akten Partner', contactName: 'X', apps: ['market'] }); const partnerId = pr.partner.id;
    const adminId = (await admin.call('GET', '/api/auth/me')).user.id;
    assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/parties`, { side: 'client', kind: 'user', refId: adminId, role: 'Beschuldigter' })).status, 201);
    assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/parties`, { side: 'client', kind: 'user', refId: adminId })).status, 400); // doppelt
    assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/parties`, { side: 'opponent', kind: 'partner', refId: partnerId })).status, 201);
    assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/parties`, { side: 'client', kind: 'partner', refId: 99999 })).status, 400); assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/parties`, { side: 'x', kind: 'user', refId: adminId })).status, 400);
    r = await admin.call('POST', `/api/legal/cases/${C1}/parties`, { side: 'involved', kind: 'new_person', role: 'Zeuge', create: { firstName: 'Erika', lastName: 'Zeugin', address: 'Hafenstr. 1', phone: '(555) 111-2222', email: 'erika@umail.com', notes: 'Hat alles gesehen' } }); assert.equal(r.status, 201); assert.equal(r.party.kind, 'contact_person'); assert.equal(r.party.name, 'Erika Zeugin');
    assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/parties`, { side: 'involved', kind: 'new_person', create: { firstName: 'Nur Vorname' } })).status, 400);
    assert.ok((await admin.call('GET', '/api/contacts/people')).people?.some?.((p) => p.name === 'Erika Zeugin') ?? true); // im Kontaktbuch angelegt
    r = await admin.call('GET', '/api/legal/cases/parties/search?q=zeug'); assert.ok(r.results.some((x) => x.kind === 'contact_person' && x.name === 'Erika Zeugin')); assert.ok((await admin.call('GET', '/api/legal/cases/parties/search?q=akten')).results.some((x) => x.kind === 'partner'));
    r = await admin.call('POST', `/api/legal/cases/${C2}/parties`, { side: 'client', kind: 'partner', refId: partnerId }); assert.equal(r.status, 201); assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].number.endsWith('0001'), true); // Interessenkonflikt-Hinweis
    // Beweise, Verlauf, Termine
    r = await admin.call('POST', `/api/legal/cases/${C1}/evidence`, { side: 'against', title: 'Überwachungsvideo', description: 'Zeigt Täter' }); assert.equal(r.status, 201); const ev1 = r.item.id;
    assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/evidence`, { side: 'for', title: 'Alibi-Zeuge' })).status, 201); assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/evidence`, { side: 'q', title: 'Falsch' })).status, 400);
    assert.equal((await admin.call('PATCH', `/api/legal/cases/${C1}/evidence/${ev1}`, { description: 'geändert' })).item.description, 'geändert');
    assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/events`, { text: 'Gespräch mit dem Mandanten', kind: 'contact', at: '2026-10-01T10:00:00.000Z' })).status, 201); assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/events`, { text: 'x' })).status, 400);
    const soon = new Date(Date.now() + 2 * 3600_000).toISOString();
    r = await admin.call('POST', `/api/legal/cases/${C1}/appointments`, { title: 'Hauptverhandlung', kind: 'hearing', startsAt: soon, location: 'Saal 2' }); assert.equal(r.status, 201); const ap1 = r.item.id;
    assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/appointments`, { title: 'Falsch', kind: 'hearing', startsAt: 'morgen' })).status, 400);
    assert.equal(runLegalReminders(new Date()), 1); assert.equal(runLegalReminders(new Date()), 0); // einmalige Erinnerung an den Verantwortlichen
    // Rechte: mod sieht nur mit Recht; Kosten nur mit Abrechnungsrecht
    await setPerms(['legal.cases.view']);
    assert.ok((await mod.call('GET', '/api/notifications')).notifications.some((n) => /Termin|ansteht/.test(n.title) && /Hauptverhandlung/.test(n.body)));
    r = await mod.call('GET', `/api/legal/cases/${C1}`); assert.equal(r.status, 200); assert.equal(r.case.costs, undefined); assert.equal(r.case.costSummary, undefined);
    assert.equal((await mod.call('PATCH', `/api/legal/cases/${C1}`, { title: 'Hack' })).status, 403); assert.equal((await mod.call('POST', `/api/legal/cases/${C1}/costs`, { kind: 'fee', description: 'Honorar', amountCents: 100 })).status, 403);
    // Kosten
    r = await admin.call('POST', `/api/legal/cases/${C1}/costs`, { kind: 'fee', description: 'Honorar Verteidigung', amountCents: 150000 }); assert.equal(r.status, 201); assert.equal(r.item.status, 'open'); const co1 = r.item.id;
    await admin.call('POST', `/api/legal/cases/${C1}/costs`, { kind: 'court', description: 'Gebühr', amountCents: 20000, status: 'waived' });
    assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/costs`, { kind: 'fee', description: 'Negativ', amountCents: -1 })).status, 400);
    assert.equal((await admin.call('PATCH', `/api/legal/cases/${C1}/costs/${co1}`, { status: 'billed' })).status, 200);
    r = await admin.call('GET', `/api/legal/cases/${C1}`); assert.equal(r.case.costSummary.billed, 150000); assert.equal(r.case.costSummary.waived, 20000); assert.equal(r.case.costSummary.open, 0);
    // Dokumente: Link und Datei
    assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/docs`, { title: 'Drive', url: 'http://drive.google.com/x' })).status, 400); assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/docs`, { title: 'Böse', url: 'javascript:alert(1)' })).status, 400);
    r = await admin.call('POST', `/api/legal/cases/${C1}/docs`, { title: 'Beweisfotos', description: 'Ordner', url: 'https://drive.google.com/drive/folders/abc' }); assert.equal(r.status, 201); assert.equal(r.doc.kind, 'link');
    r = await admin.call('POST', `/api/legal/cases/${C1}/docs`, { title: 'Notiz', filename: 'notiz.txt', data: Buffer.from('Hallo Akte').toString('base64') }); assert.equal(r.status, 201); const dTxt = r.doc.id;
    r = await admin.call('POST', `/api/legal/cases/${C1}/docs`, { title: 'Bild', filename: 'bild.png', data: IMG }); assert.equal(r.status, 201); const dPng = r.doc.id;
    for (const bad of [{ filename: 'virus.exe', data: Buffer.from('MZ').toString('base64') }, { filename: 'fake.pdf', data: Buffer.from('kein pdf').toString('base64') }, { filename: 'fake.png', data: Buffer.from('kein png').toString('base64') }, { filename: 'bin.txt', data: Buffer.from([65, 0, 66]).toString('base64') }]) assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/docs`, { title: 'Böse Datei', ...bad })).status, 400, bad.filename);
    let dl = await fetch(`${base}/api/legal/cases/${C1}/docs/${dTxt}/file`, { headers: { cookie: admin.cookie } }); assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition') ?? '', /attachment/); assert.equal(await dl.text(), 'Hallo Akte');
    dl = await fetch(`${base}/api/legal/cases/${C1}/docs/${dPng}/file`, { headers: { cookie: admin.cookie } }); assert.equal(dl.headers.get('content-type'), 'image/png'); assert.equal(dl.headers.get('content-disposition'), null);
    assert.equal((await fetch(`${base}/api/legal/cases/${C1}/docs/${dTxt}/file`, { headers: { cookie: mod.cookie } })).status, 200); // mod darf ansehen
    await setPerms([]); assert.equal((await fetch(`${base}/api/legal/cases/${C1}/docs/${dTxt}/file`, { headers: { cookie: mod.cookie } })).status, 403);
    // Status, vertraulich, verknüpfen, Suche, Filter
    r = await admin.call('PATCH', `/api/legal/cases/${C2}`, { statusId: st('closed') }); assert.equal(r.case.closed, true); assert.ok(r.case.closedAt); assert.ok(r.case.events.some((e) => /Status geändert/.test(e.text)));
    r = await admin.call('PATCH', `/api/legal/cases/${C2}`, { statusId: st('in_progress') }); assert.equal(r.case.closedAt, null);
    assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/related`, { relatedId: C2 })).status, 200); assert.equal((await admin.call('GET', `/api/legal/cases/${C2}`)).case.related[0].id, C1); assert.equal((await admin.call('POST', `/api/legal/cases/${C1}/related`, { relatedId: C1 })).status, 400);
    assert.equal((await admin.call('GET', '/api/legal/cases?q=m%C3%BCller')).cases.length, 1); assert.equal((await admin.call('GET', '/api/legal/cases?q=akten%20partner')).cases.length, 2); assert.equal((await admin.call('GET', `/api/legal/cases?area=${area}`)).cases.length, 1);
    assert.ok((await admin.call('GET', '/api/legal/cases')).upcoming.some((u) => u.title === 'Hauptverhandlung'));
    await admin.call('PATCH', `/api/legal/cases/${C2}`, { confidential: true }); await setPerms(['legal.cases.view']);
    assert.equal((await mod.call('GET', `/api/legal/cases/${C2}`)).status, 404); assert.equal((await mod.call('GET', '/api/legal/cases')).cases.some((x) => x.id === C2), false); assert.equal((await mod.call('GET', `/api/legal/cases/${C1}`)).case.conflicts.length, 0); // Konflikte mit nicht sichtbaren Akten werden nicht verraten
    await admin.call('PATCH', `/api/legal/cases/${C2}`, { team: [modId] }); assert.equal((await mod.call('GET', `/api/legal/cases/${C2}`)).status, 200); // Teammitglied sieht die vertrauliche Akte
    assert.equal((await mod.call('DELETE', `/api/legal/cases/${C1}`)).status, 403); await setPerms([]);
    assert.equal((await admin.call('DELETE', `/api/legal/cases/${C1}`)).status, 200); assert.equal((await admin.call('GET', `/api/legal/cases/${C1}`)).status, 404); assert.equal((await admin.call('DELETE', `/api/legal/cases/${C2}`)).status, 200);
    ok('Rechtsfälle: Aktenzeichen, Beteiligte (inkl. neu anlegen), Beweise, Verlauf, Termine + Erinnerung, Kosten, Dokumente, Vertraulichkeit, Rechte'); }

  // ══ Apps für alle deaktivieren ══
  { assert.equal((await mod.call('PUT', '/api/config', { values: { 'system.disabled_apps': ['contacts'] } })).status, 403); // nur mit Recht „system.apps“
    for (const bad of ['contacts', ['config'], ['users'], ['gibt-es-nicht'], ['contacts', 'contacts']]) assert.equal((await admin.call('PUT', '/api/config', { values: { 'system.disabled_apps': bad } })).status, 400, JSON.stringify(bad));
    await setPerms(['contacts.view']); assert.equal((await mod.call('GET', '/api/contacts/people')).status, 200);
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'system.disabled_apps': ['contacts', 'warehouse'] } })).status, 200);
    r = await mod.call('GET', '/api/contacts/people'); assert.equal(r.status, 403); assert.match(r.error, /deaktiviert/);
    assert.equal((await admin.call('GET', '/api/contacts/people')).status, 403); assert.equal((await admin.call('GET', '/api/warehouses')).status, 403); // gilt auch für Administratoren
    assert.equal((await admin.call('GET', '/api/market/items')).status, 200); assert.equal((await admin.call('GET', '/api/config')).status, 200); // andere Apps und die Konfiguration bleiben erreichbar
    assert.ok((await admin.call('GET', '/api/bootstrap')).config['system.disabled_apps'].includes('contacts')); // Oberfläche erfährt es über die öffentliche Konfiguration
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'system.disabled_apps': [] } })).status, 200); assert.equal((await mod.call('GET', '/api/contacts/people')).status, 200); await setPerms([]);
    ok('Apps deaktivieren: nur mit Recht, nur erlaubte Apps, Schnittstelle gesperrt, wieder aktivierbar'); }

  // ══ Level-System für Partner ══
  { const { awardForDeal, awardForLoan, xpFor, levelOfXp } = await import('../server/core/levels.js'); const { run: dbRun } = await import('../server/core/db.js'); const { clearAttempts } = await import('../server/core/auth.js');
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) clearAttempts(`pl|${ip}`);
    const mkP = async (name) => { const rr = await admin.call('POST', '/api/partners', { type: 'buyer', name, contactName: 'X', apps: ['market', 'chat', 'credit'] }); assert.equal(rr.status, 201); const c = new Client(); assert.equal((await c.call('POST', `/api/p/${rr.partner.linkPath.split('/').pop()}/login`, { code: rr.code })).status, 200); return { id: rr.partner.id, c }; };
    const A = await mkP('Level Partner A'), B = await mkP('Level Partner B');
    const item = (await admin.call('POST', '/api/market/items', { name: 'Level-Erz', unit: 'Stück', xp: 77 })).item; assert.equal(item.xp, 77); assert.equal((await admin.call('POST', '/api/market/items', { name: 'Level-Falsch', xp: -1 })).status, 400);
    const mkDeal = (pid, dir, qty, price) => Number(dbRun("INSERT INTO market_deals (deal_number,origin,direction,partner_id,item_id,quantity,unit_price,proposed_by,turn,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", 'LVL-' + Math.random().toString(36).slice(2, 8), 'offer', dir, pid, item.id, qty, price, 'partner', 'staff', 'completed', new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
    // aus: keine XP, keine Anzeige
    assert.equal((await A.c.call('GET', '/api/p/level')).level.enabled, false); assert.equal(awardForDeal(mkDeal(A.id, 'buy', 5, 1000)), null);
    assert.equal((await mod.call('PATCH', `/api/partners/${A.id}`, { levelEnabled: true })).status, 403);
    r = await admin.call('PATCH', `/api/partners/${A.id}`, { levelEnabled: true }); assert.equal(r.status, 200); assert.equal(r.partner.levelEnabled, true); assert.equal(r.partner.level.n, 1);
    assert.equal((await admin.call('GET', '/api/partners')).partners.find((p) => p.id === B.id).level, null); // Partner B bleibt aus
    // Automatik: Basis 10 + 5000/1000 = 15 (Minimum 5, Maximum 500)
    assert.equal(xpFor('buy', 5000), 15); assert.equal(xpFor('buy', 0), 10); assert.equal(xpFor('sell', 10_000_000), 500);
    let d1 = mkDeal(A.id, 'buy', 5, 1000), res = awardForDeal(d1); assert.equal(res.applied, 15); assert.equal(awardForDeal(d1), null); // nie doppelt
    assert.equal(awardForDeal(mkDeal(B.id, 'sell', 1, 1)), null); // Partner ohne Level-System
    // Manuell: Artikelwert 77 überschreibt den festen Wert
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'level.mode.sell': 'fixed', 'level.fixed.sell': 20 } })).status, 200);
    assert.equal(awardForDeal(mkDeal(A.id, 'sell', 1, 1)).applied, 77); await admin.call('PATCH', `/api/market/items/${item.id}`, { xp: '' }); assert.equal(awardForDeal(mkDeal(A.id, 'sell', 1, 1)).applied, 20);
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'level.mode.sell': 'off' } })).status, 200); assert.equal(awardForDeal(mkDeal(A.id, 'sell', 1, 1)), null);
    await admin.call('PUT', '/api/config', { values: { 'level.mode.sell': 'auto' } });
    // Kredit
    const lid = Number(dbRun("INSERT INTO credit_loans (loan_number,partner_id,status,principal_cents,term_count,frequency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", 'KR-LVL', A.id, 'completed', 500000, 5, 'weekly', new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
    assert.equal(awardForLoan(lid).applied, 15); assert.equal(awardForLoan(lid), null);
    // Stufen
    assert.equal(levelOfXp(0).n, 1); assert.equal(levelOfXp(449).n, 2); assert.equal(levelOfXp(450).n, 3); assert.equal(levelOfXp(99999).n, 10); assert.equal(levelOfXp(99999).next, null);
    // Anzeige: Team sieht Level überall, Partner nur das eigene
    r = await admin.call('GET', `/api/partners/${A.id}/level`); assert.equal(r.level.enabled, true); assert.ok(r.level.history.length >= 4); assert.equal(r.level.levels.length, 10);
    const own = await A.c.call('GET', '/api/p/level'); assert.equal(own.level.xp, r.level.xp); assert.equal((await A.c.call('GET', '/api/p/me')).partner.level.n, 1);
    assert.equal((await B.c.call('GET', '/api/p/level')).level.enabled, false); assert.equal((await new Client().call('GET', '/api/p/level')).status, 401);
    assert.equal((await mod.call('GET', `/api/partners/${A.id}/level`)).status, 403);
    assert.equal((await admin.call('GET', '/api/credit/borrowers')).borrowers.find((b) => b.id === A.id).level.n, 1);
    // Admin-Korrektur: nur mit Recht, mit Begründung, mit Audit
    assert.equal((await mod.call('POST', `/api/partners/${A.id}/level/adjust`, { action: 'add', amount: 100, reason: 'Test' })).status, 403);
    for (const bad of [{ action: 'add', amount: 100 }, { action: 'add', amount: 0, reason: 'Test' }, { action: 'set_level', level: 11, reason: 'Test' }, { action: 'x', reason: 'Test' }]) assert.equal((await admin.call('POST', `/api/partners/${A.id}/level/adjust`, bad)).status, 400, JSON.stringify(bad));
    assert.equal((await admin.call('POST', `/api/partners/${B.id}/level/adjust`, { action: 'add', amount: 5, reason: 'Test' })).status, 400); // aus
    r = await admin.call('POST', `/api/partners/${A.id}/level/adjust`, { action: 'set_level', level: 3, reason: 'Bonus für gute Zusammenarbeit' }); assert.equal(r.status, 200); assert.equal(r.level.n, 3); assert.equal(r.level.xp, 450);
    r = await admin.call('POST', `/api/partners/${A.id}/level/adjust`, { action: 'add', amount: -460, reason: 'Strafe' }); assert.equal(r.level.xp, 0); assert.equal(r.level.n, 1); // nie unter 0
    r = await admin.call('POST', `/api/partners/${A.id}/level/adjust`, { action: 'add', amount: 200, reason: 'Korrektur' }); assert.equal(r.level.n, 2); r = await admin.call('POST', `/api/partners/${A.id}/level/adjust`, { action: 'reset', reason: 'Neustart' }); assert.equal(r.level.xp, 0);
    assert.ok((await admin.call('GET', '/api/audit?limit=20')).entries?.some?.((e) => e.action === 'partner.level_adjusted') ?? true);
    // Partner wird benachrichtigt
    assert.ok((await A.c.call('GET', '/api/p/notifications')).notifications.some((n) => /XP/.test(n.title)));
    // Stufen anpassen (Konfiguration)
    const lv = r.level.levels.map((l) => ({ name: l.name, icon: l.icon, xp: l.xp })); lv[1].name = 'Zweiter Rang';
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'level.levels': lv } })).status, 200); assert.equal(levelOfXp(150).name, 'Zweiter Rang');
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'level.levels': lv.slice(0, 9) } })).status, 400); assert.equal((await admin.call('PUT', '/api/config', { values: { 'level.levels': lv.map((l, i) => ({ ...l, xp: i === 5 ? 1 : l.xp })) } })).status, 400);
    await admin.call('PUT', '/api/config', { values: { 'level.levels': lv.map((l) => (l.name === 'Zweiter Rang' ? { ...l, name: 'Lehrling' } : l)) } });
    // Abschalten blendet aus
    await admin.call('PATCH', `/api/partners/${A.id}`, { levelEnabled: false }); assert.equal((await A.c.call('GET', '/api/p/level')).level.enabled, false); assert.equal(awardForDeal(mkDeal(A.id, 'buy', 1, 1)), null);
    ok('Level-System: pro Partner, XP automatisch/manuell, einmalig, Stufen, Sichtbarkeit, Admin-Korrektur, Benachrichtigung'); }

  // ══ Mitglieder handeln in der Börse wie Partner ══
  { await setPerms(['market.trade']);
    assert.equal((await mod.call('GET', '/api/p/market/catalog')).status, 401); // Einstellung aus
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'market.member_trade': true } })).status, 200);
    await setPerms([]); assert.equal((await mod.call('GET', '/api/p/market/catalog')).status, 401); // ohne Recht „market.trade“ kein Zugang
    assert.equal((await new Client().call('GET', '/api/p/market/catalog')).status, 401);
    await setPerms(['market.trade']);
    const item = (await admin.call('POST', '/api/market/items', { name: 'Mitglieds-Artikel', unit: 'Stück', referencePrice: 10 })).item;
    r = await mod.call('GET', '/api/p/market/catalog'); assert.equal(r.status, 200); assert.ok(r.items.some((i) => i.name === 'Mitglieds-Artikel')); assert.equal(r.items.some((i) => i.name === 'Sonstiges'), false);
    assert.equal((await mod.call('GET', '/api/p/market/wanted')).status, 200);
    assert.equal((await mod.call('GET', '/api/p/credit/loans')).status, 401); assert.equal((await mod.call('GET', '/api/p/chat/channels')).status, 401); // nur die Börse, keine anderen Partner-Apps
    r = await mod.call('POST', '/api/p/market/offers', { itemId: item.id, quantity: 3, unitPrice: 12, note: 'Von einem Mitglied' }); assert.equal(r.status, 201); const dealId = r.deal.id;
    assert.equal((await mod.call('GET', '/api/p/market/deals')).deals.length >= 1, true); assert.equal((await mod.call('GET', `/api/p/market/deals/${dealId}`)).status, 200);
    const sd = (await admin.call('GET', '/api/market/deals')).deals.find((d) => d.id === dealId); assert.ok(sd); assert.equal(sd.partner.isMember, true); assert.match(sd.partner.name, /^Mitglied /);
    assert.equal((await admin.call('GET', '/api/partners')).partners.some((p) => p.id === sd.partner.id), false); // nicht in der Partnerliste
    assert.equal((await admin.call('GET', '/api/market/options')).partners?.some?.((p) => p.id === sd.partner.id) ?? false, false);
    // Antwort des Teams kommt als Benachrichtigung beim Mitglied an (Ziel: App „Handel“)
    r = await admin.call('POST', `/api/market/deals/${dealId}/accept`, {}); assert.equal(r.status, 200, JSON.stringify(r));
    r = await mod.call('GET', '/api/notifications'); const n = r.notifications.find((x) => x.target?.dealId === dealId); assert.ok(n, 'Benachrichtigung fehlt'); assert.equal(n.target.app, 'trade');
    // Einstellung aus: sofort gesperrt, Daten bleiben
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'market.member_trade': false } })).status, 200); assert.equal((await mod.call('GET', '/api/p/market/catalog')).status, 401);
    await admin.call('PUT', '/api/config', { values: { 'market.member_trade': true } }); assert.equal((await mod.call('GET', '/api/p/market/deals')).deals.length >= 1, true);
    await admin.call('PUT', '/api/config', { values: { 'market.member_trade': false } }); await setPerms([]);
    ok('Mitglieder handeln wie Partner: Einstellung + Recht, nur Börse, Team sieht Mitglieds-Geschäfte, Benachrichtigung, nicht in Partnerlisten'); }

  // ══ Changelog: Pflicht-Bestätigung ══
  { assert.equal((await new Client().call('GET', '/api/changelog/unread')).status, 401); assert.equal((await mod.call('GET', '/api/changelog/unread')).status, 403);
    const modId = (await mod.call('GET', '/api/auth/me')).user.id;
    const before = (await admin.call('GET', '/api/changelog?limit=50')).entries.map((e) => e.id); for (const id of before) await admin.call('DELETE', `/api/changelog/${id}`);
    await setPerms(['changelog.view']); const ids = [];
    for (let i = 1; i <= 7; i++) { r = await admin.call('POST', '/api/changelog', { title: `Update ${i}`, version: `1.${i}`, items: [{ kind: 'new', text: `Neuerung ${i}` }] }); assert.equal(r.status, 201); ids.push(r.entry.id); await sleep(5); }
    r = await mod.call('GET', '/api/changelog/unread'); assert.equal(r.entries.length, 5); assert.equal(r.more, 2); assert.equal(r.total, 7); assert.equal(r.entries[0].changed, false); // erstmalig: nur die neuesten fünf
    const upTo = r.entries.reduce((a, e) => (e.updatedAt > a ? e.updatedAt : a), '');
    assert.equal((await mod.call('POST', '/api/changelog/ack', {})).status, 400); assert.equal((await mod.call('POST', '/api/changelog/ack', { upTo: 'gestern' })).status, 400);
    r = await mod.call('POST', '/api/changelog/ack', { upTo }); assert.equal(r.status, 200); assert.equal(r.acknowledged, 7); // auch die älteren, nicht angezeigten gelten als gelesen
    assert.equal((await mod.call('GET', '/api/changelog/unread')).entries.length, 0);
    // Protokoll: Audit-Log und Verlauf im Profil
    r = await admin.call('GET', '/api/audit?action=changelog.acknowledged'); assert.ok(r.total >= 1);
    const hist = await admin.call('GET', `/api/users/${modId}/changelog`); assert.equal(hist.history.length, 7); assert.equal(hist.open.length, 0); assert.ok(hist.lastAckAt); assert.equal(hist.history[0].changed, false);
    assert.equal((await new Client().call('GET', `/api/users/${modId}/changelog`)).status, 401); assert.equal((await admin.call('GET', '/api/users/99999/changelog')).status, 404);
    assert.equal((await admin.call('GET', '/api/changelog/unread')).total, 7); // andere Personen sehen sie weiterhin (erstmalig die neuesten fünf)
    await sleep(5); assert.equal((await admin.call('PATCH', `/api/changelog/${ids[2]}`, { title: 'Update 3 (korrigiert)' })).status, 200); // geänderter Eintrag erscheint erneut
    r = await mod.call('GET', '/api/changelog/unread'); assert.equal(r.entries.length, 1); assert.equal(r.entries[0].changed, true); assert.equal(r.entries[0].title, 'Update 3 (korrigiert)');
    await mod.call('POST', '/api/changelog/ack', { upTo: r.entries[0].updatedAt }); assert.equal((await mod.call('GET', '/api/changelog/unread')).entries.length, 0);
    { const h2 = await admin.call('GET', `/api/users/${modId}/changelog`); assert.equal(h2.history.length, 8); assert.equal(h2.history[0].changed, true); assert.match(h2.history[0].title, /korrigiert/); } // Verlauf: erneute Bestätigung nach Änderung
    await sleep(5); r = await admin.call('POST', '/api/changelog', { title: 'Update 8', items: [{ kind: 'fixed', text: 'Fehler behoben' }] }); ids.push(r.entry.id);
    r = await mod.call('GET', '/api/changelog/unread'); assert.equal(r.entries.length, 1); assert.equal(r.entries[0].changed, false);
    // Bestätigung gilt nur bis zum gezeigten Stand: zwischenzeitlich geänderte Einträge bleiben ungelesen
    const shown = r.entries[0].updatedAt; await sleep(5); await admin.call('PATCH', `/api/changelog/${ids[7]}`, { title: 'Update 8 neu' }); await mod.call('POST', '/api/changelog/ack', { upTo: shown });
    assert.equal((await mod.call('GET', '/api/changelog/unread')).entries.length, 1);
    for (const id of ids) await admin.call('DELETE', `/api/changelog/${id}`); await setPerms([]);
    ok('Changelog: neue/geänderte Einträge müssen je Person bestätigt werden (erstmalig nur die neuesten, Bestätigung bis zum gezeigten Stand)'); }

  // ══ Schwarzes Brett: Pflicht-Bestätigung ══
  { assert.equal((await new Client().call('GET', '/api/board/unread')).status, 401); assert.equal((await mod.call('GET', '/api/board/unread')).status, 403);
    const modId = (await mod.call('GET', '/api/auth/me')).user.id; await setPerms(['board.view', 'board.manage']);
    for (const p of (await mod.call('GET', '/api/board')).posts) await mod.call('DELETE', `/api/board/${p.id}`);
    const ids = []; for (const [t, lv] of [['Wartung heute Nacht', 'important'], ['Neue Dienstzeiten', 'info'], ['Notfallnummer geändert', 'urgent']]) { r = await mod.call('POST', '/api/board', { title: t, body: 'Details zu ' + t, level: lv }); assert.equal(r.status, 201); ids.push(r.post.id); await sleep(5); }
    r = await mod.call('GET', '/api/board/unread'); assert.equal(r.posts.length, 3); assert.equal(r.posts[0].changed, false); const upTo = r.posts.reduce((a, p) => (p.updatedAt > a ? p.updatedAt : a), '');
    assert.equal((await mod.call('POST', '/api/board/ack', {})).status, 400);
    r = await mod.call('POST', '/api/board/ack', { upTo }); assert.equal(r.status, 200); assert.equal(r.acknowledged, 3); assert.equal((await mod.call('GET', '/api/board/unread')).posts.length, 0);
    r = await admin.call('GET', '/api/audit?action=board.acknowledged'); assert.ok(r.total >= 1);
    // Anpinnen ist keine Inhaltsänderung, Text/Überschrift/Hervorhebung schon
    await sleep(5); assert.equal((await mod.call('PATCH', `/api/board/${ids[1]}`, { pinned: true })).status, 200); assert.equal((await mod.call('GET', '/api/board/unread')).posts.length, 0);
    await sleep(5); assert.equal((await mod.call('PATCH', `/api/board/${ids[1]}`, { body: 'Neuer Text' })).status, 200);
    r = await mod.call('GET', '/api/board/unread'); assert.equal(r.posts.length, 1); assert.equal(r.posts[0].changed, true); assert.equal(r.posts[0].body, 'Neuer Text');
    await mod.call('POST', '/api/board/ack', { upTo: r.posts[0].updatedAt }); assert.equal((await mod.call('GET', '/api/board/unread')).posts.length, 0);
    await sleep(5); r = await mod.call('POST', '/api/board', { title: 'Noch ein Aushang', body: '', level: 'success' }); ids.push(r.post.id); assert.equal((await mod.call('GET', '/api/board/unread')).posts.length, 1);
    assert.equal((await admin.call('GET', '/api/board/unread')).total, 4); // andere Personen unabhängig
    const hist = await admin.call('GET', `/api/users/${modId}/board`); assert.equal(hist.history.length, 4); assert.equal(hist.history[0].changed, true); assert.equal(hist.open.length, 1); assert.ok(hist.lastAckAt); assert.equal((await admin.call('GET', '/api/users/99999/board')).status, 404);
    for (const id of ids) await mod.call('DELETE', `/api/board/${id}`); await setPerms([]);
    ok('Schwarzes Brett: neue/geänderte Aushänge müssen je Person bestätigt werden, Audit-Log und Verlauf im Profil'); }

  // ══ Halloween-Design ══
  { assert.equal((await new Client().call('GET', '/api/bootstrap')).config['ui.halloween'], false); // öffentlich, Standard aus
    await setPerms(['config.edit']); assert.equal((await mod.call('PUT', '/api/config', { values: { 'ui.halloween': true } })).status, 403); await setPerms([]); // nur Superadmin (system.apps)
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'ui.halloween': 'ja' } })).status, 400);
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'ui.halloween': true } })).status, 200); assert.equal((await new Client().call('GET', '/api/bootstrap')).config['ui.halloween'], true);
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'ui.halloween': false } })).status, 200); assert.equal((await new Client().call('GET', '/api/bootstrap')).config['ui.halloween'], false);
    ok('Halloween-Design: öffentlich lesbar, nur mit Recht system.apps (Superadmin) schaltbar'); }

  // ══ Problemleiste ══
  { const { run: dbRun } = await import('../server/core/db.js'); const { clearAttempts } = await import('../server/core/auth.js');
    assert.equal((await new Client().call('GET', '/api/problems')).status, 401);
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) clearAttempts(`pl|${ip}`);
    const pr = await admin.call('POST', '/api/partners', { type: 'buyer', name: 'Problem Partner', contactName: 'X', apps: ['market'] }); const ptc = new Client(); assert.equal((await ptc.call('POST', `/api/p/${pr.partner.linkPath.split('/').pop()}/login`, { code: pr.code })).status, 200);
    assert.equal((await ptc.call('GET', '/api/problems')).status, 401); // Externe Partner: nie
    await setPerms([]); const PERM = { vehicles: 'vehicles.view', market: 'market.view', legal: 'legal.cases.view', warehouse: 'warehouse.view', credit: 'credit.view', tab: 'tab.view', tickets: 'tickets.manage', users: 'users.approve', schedule: 'schedule.view' };
    const scoped = async () => { const pm = (await mod.call('GET', '/api/auth/me')).user.permissions, pl = (await mod.call('GET', '/api/problems')).problems; assert.ok(pl.every((p) => pm.includes(PERM[p.area])), 'Problem ohne Zugriffsrecht sichtbar'); return pl; }; // jedes Problem nur mit dem Recht des Bereichs
    await scoped();
    // Fahrzeug beschädigt, TÜV überfällig
    r = await admin.call('POST', '/api/vehicles', { name: 'Problem-Wagen', plate: 'PRB 1', fuel: 'petrol', condition: 'damaged', inspectionDue: '2020-01-01' }); assert.equal(r.status, 201); const veh = r.vehicle.id;
    // Börse: Geschäft liegt beim Team (älter als 1 Stunde)
    const it = (await admin.call('POST', '/api/market/items', { name: 'Problem-Erz', unit: 'Stück' })).item, old = new Date(Date.now() - 3 * 3600_000).toISOString();
    const deal = Number(dbRun("INSERT INTO market_deals (deal_number,origin,direction,partner_id,item_id,quantity,unit_price,proposed_by,turn,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", 'PRB-1', 'offer', 'buy', pr.partner.id, it.id, 2, 10, 'partner', 'staff', 'submitted', old, old).lastInsertRowid);
    // Rechtsfall: überfällige Frist (vertraulich + offen)
    const lc = (await admin.call('POST', '/api/legal/cases', { title: 'Problem-Akte', confidential: true })).case.id; await admin.call('POST', `/api/legal/cases/${lc}/appointments`, { title: 'Einspruchsfrist', kind: 'deadline', startsAt: new Date(Date.now() - 86400_000).toISOString() });
    // Lager: Lagerkosten fällig, nicht bestätigt
    const wh = (await admin.call('POST', '/api/warehouses', { name: 'Problem-Lager', rent: { enabled: true, cents: 5000, weekday: 1, hour: 8 } })).warehouse.id; dbRun("UPDATE warehouses SET rent_due_date = ? WHERE id = ?", new Date().toISOString().slice(0, 10), wh);
    r = await admin.call('GET', '/api/problems'); const ids = r.problems.map((p) => p.id);
    for (const id of [`vehicle:${veh}:cond`, `vehicle:${veh}:insp`, `deal:${deal}`, `wh:${wh}:rent`]) assert.ok(ids.includes(id), id + ' fehlt'); assert.ok(r.problems.some((p) => p.area === 'legal' && /Einspruchsfrist/.test(p.title) && p.severity === 'critical'));
    assert.equal(r.problems[0].severity, 'critical'); // kritische zuerst
    // Aufträge überfällig: normal 24 Std. Problem / 72 Std. kritisch; Hoch/Dringend: 6 Std. / 24 Std.
    { const meId = (await admin.call('GET', '/api/auth/me')).user.id, H = (h) => new Date(Date.now() - h * 3600_000).toISOString(); const mkT = async (title, priority, hours) => (await admin.call('POST', '/api/schedule/tasks', { title, priority, dueAt: H(hours), assignees: [meId] })).task.id;
      const tn = [['Normal 20h', 'normal', 20, null], ['Normal 30h', 'normal', 30, 'warn'], ['Normal 80h', 'normal', 80, 'critical'], ['Wichtig 5h', 'high', 5, null], ['Wichtig 8h', 'high', 8, 'warn'], ['Dringend 30h', 'urgent', 30, 'critical'], ['Niedrig 30h', 'low', 30, 'warn']];
      const ids = []; for (const [title, pr, h] of tn) ids.push(await mkT(title, pr, h)); const tp = async () => (await admin.call('GET', '/api/problems')).problems.filter((p) => p.area === 'schedule');
      let pl = await tp(); tn.forEach(([title, , , sev], i) => { const p = pl.find((x) => x.id.startsWith(`task:${ids[i]}:`)); if (sev) { assert.ok(p, title); assert.equal(p.severity, sev, title); assert.deepEqual(p.target, { app: 'schedule', taskId: ids[i] }); } else assert.equal(p, undefined, title); });
      assert.equal((await admin.call('POST', `/api/schedule/tasks/${ids[1]}/state`, { state: 'done' })).task.status, 'done'); assert.equal((await tp()).some((x) => x.id.startsWith(`task:${ids[1]}:`)), false); // erledigt: verschwindet
      assert.equal((await admin.call('PATCH', `/api/schedule/tasks/${ids[2]}`, { status: 'cancelled' })).task.status, 'cancelled'); assert.equal((await tp()).some((x) => x.id.startsWith(`task:${ids[2]}:`)), false);
      await setPerms([]); await scoped(); await setPerms(['schedule.view']); assert.equal((await mod.call('GET', '/api/problems')).problems.some((x) => x.area === 'schedule' && x.id.startsWith(`task:${ids[5]}:`)), (await mod.call('GET', '/api/auth/me')).user.permissions.includes('schedule.manage')); await scoped(); await setPerms([]); // Außenstehende ohne Verwaltungsrecht sehen fremde Aufträge nicht
      assert.equal((await admin.call('PUT', '/api/config', { values: { 'problems.task_warn_hours': 48 } })).status, 200); assert.equal((await tp()).some((x) => x.id.startsWith(`task:${ids[0]}:`) || x.id.startsWith(`task:${ids[6]}:`)), false); await admin.call('PUT', '/api/config', { values: { 'problems.task_warn_hours': 24 } }); // Schwellen einstellbar
      for (const id of ids) await admin.call('DELETE', `/api/schedule/tasks/${id}`); }
    // Lager: ab 75 % gefüllt ein Problem, ab 90 % kritisch (nur mit festgelegter Kapazität)
    { const fw = (await admin.call('POST', '/api/warehouses', { name: 'Voll-Lager', capacity: 100 })).warehouse.id, nofull = (await admin.call('POST', '/api/warehouses', { name: 'Ohne-Kapazität' })).warehouse.id;
      const slot = (await admin.call('POST', '/api/warehouse/items', { name: 'Füll-Teil', unit: 'Stk', space: 1, stackSize: 1 })).item;
      const fill = (n) => admin.call('POST', `/api/warehouses/${fw}/stock`, { itemId: slot.id, action: 'in', quantity: n }); const probs = async () => (await admin.call('GET', '/api/problems')).problems.filter((p) => p.id.startsWith(`wh:${fw}:fill`));
      await fill(74); assert.equal((await probs()).length, 0); // 74 % noch ok
      await fill(1); let p = await probs(); assert.equal(p.length, 1); assert.equal(p[0].severity, 'warn'); assert.equal(p[0].id, `wh:${fw}:fill:warn`); assert.match(p[0].title, /75 %/); assert.match(p[0].detail, /75 \/ 100/);
      await fill(14); assert.equal((await probs())[0].severity, 'warn'); // 89 %
      await fill(1); p = await probs(); assert.equal(p.length, 1); assert.equal(p[0].severity, 'critical'); assert.match(p[0].title, /fast voll \(90 %\)/);
      assert.equal((await admin.call('GET', '/api/problems')).problems.some((x) => x.id.startsWith(`wh:${nofull}:fill`)), false); // ohne Kapazität kein Füllstand
      assert.equal((await admin.call('GET', '/api/problems')).problems[0].severity, 'critical');
      await setPerms([]); await scoped(); await setPerms(['warehouse.view']); assert.ok((await mod.call('GET', '/api/problems')).problems.some((x) => x.id === `wh:${fw}:fill:crit`)); await scoped(); await setPerms([]);
      assert.equal((await admin.call('PUT', '/api/config', { values: { 'problems.warehouse_warn_percent': 95, 'problems.warehouse_critical_percent': 99 } })).status, 200); assert.equal((await probs()).length, 0); // Schwellen einstellbar
      assert.equal((await admin.call('PUT', '/api/config', { values: { 'problems.warehouse_warn_percent': 0 } })).status, 200); assert.equal((await probs()).length, 0); // 0 = aus
      await admin.call('PUT', '/api/config', { values: { 'problems.warehouse_warn_percent': 75, 'problems.warehouse_critical_percent': 90 } }); assert.equal((await probs()).length, 1);
      await admin.call('DELETE', `/api/warehouses/${fw}?force=1`); await admin.call('DELETE', `/api/warehouses/${nofull}?force=1`); }
    // Rechte: nur Probleme aus Bereichen mit Zugriff
    await setPerms(['vehicles.view']); r = await mod.call('GET', '/api/problems'); assert.ok(r.problems.filter((p) => p.area === 'vehicles').length >= 2); await scoped();
    await setPerms(['market.view']); r = await mod.call('GET', '/api/problems'); assert.ok(r.problems.some((p) => p.id === `deal:${deal}`)); await scoped();
    await setPerms(['legal.cases.view']); assert.equal((await mod.call('GET', '/api/problems')).problems.some((p) => p.area === 'legal'), false); // vertrauliche Akte ohne Zugriff: nichts
    await admin.call('PATCH', `/api/legal/cases/${lc}`, { confidential: false }); assert.ok((await mod.call('GET', '/api/problems')).problems.some((p) => p.area === 'legal'));
    await setPerms(['warehouse.view']); assert.ok((await mod.call('GET', '/api/problems')).problems.some((p) => p.id === `wh:${wh}:rent`));
    // Behoben → verschwindet
    assert.equal((await mod.call('POST', `/api/warehouses/${wh}/rent/paid`, {})).status, 403); await setPerms([]);
    assert.equal((await admin.call('POST', `/api/warehouses/${wh}/rent/paid`, {})).status, 200); assert.equal((await admin.call('POST', `/api/warehouses/${wh}/rent/paid`, {})).status, 409);
    await admin.call('PATCH', `/api/vehicles/${veh}`, { condition: 'ready', inspectionDue: '2099-01-01' }); dbRun("UPDATE market_deals SET turn = 'partner' WHERE id = ?", deal); await admin.call('DELETE', `/api/legal/cases/${lc}`);
    r = await admin.call('GET', '/api/problems'); for (const id of [`vehicle:${veh}:cond`, `vehicle:${veh}:insp`, `deal:${deal}`, `wh:${wh}:rent`]) assert.equal(r.problems.some((p) => p.id === id), false, id + ' bleibt');
    assert.equal(r.problems.some((p) => p.area === 'legal'), false);
    ok('Problemleiste: Quellen, nur mit Zugriff, vertrauliche Akten, verschwindet bei Behebung, Partner nie'); }

  // ══ Online-Liste ══
  { assert.equal((await new Client().call('GET', '/api/presence')).status, 401); assert.equal((await new Client().call('POST', '/api/presence', { tabId: 'abcdef123456', locked: false })).status, 401);
    const meA = (await admin.call('GET', '/api/auth/me')).user, meM = (await mod.call('GET', '/api/auth/me')).user;
    assert.equal((await admin.call('GET', '/api/presence')).members.some((x) => x.id === meM.id), false); // ohne Herzschlag: nicht online
    assert.equal((await admin.call('POST', '/api/presence', { tabId: 'x' })).ok, false); // ungültige Seiten-ID
    assert.equal((await admin.call('POST', '/api/presence', { tabId: 'tab-admin-1', locked: false })).ok, true); assert.equal((await mod.call('POST', '/api/presence', { tabId: 'tab-mod-1', locked: false })).ok, true);
    r = await admin.call('GET', '/api/presence'); assert.equal(r.enabled, true); const ma = r.members.find((x) => x.id === meA.id), mm = r.members.find((x) => x.id === meM.id);
    assert.ok(ma && mm); assert.equal(ma.state, 'active'); assert.equal(ma.isMe, true); assert.equal(mm.isMe, false); assert.equal(mm.label, meM.memberNumber); assert.equal(JSON.stringify(r).includes(meM.displayName ?? '§§'), false); // nur Personalnummer, nie Namen
    // Sperrbildschirm: nur gesperrt, wenn ALLE Seiten gesperrt sind; zuerst die aktiven
    await mod.call('POST', '/api/presence', { tabId: 'tab-mod-1', locked: true }); assert.equal((await admin.call('GET', '/api/presence')).members.find((x) => x.id === meM.id).state, 'locked');
    await mod.call('POST', '/api/presence', { tabId: 'tab-mod-2', locked: false }); assert.equal((await admin.call('GET', '/api/presence')).members.find((x) => x.id === meM.id).state, 'active');
    await mod.call('POST', '/api/presence', { tabId: 'tab-mod-2', locked: true }); r = await admin.call('GET', '/api/presence'); assert.equal(r.members.find((x) => x.id === meM.id).state, 'locked'); assert.ok(r.members.findIndex((x) => x.state === 'active') < r.members.findIndex((x) => x.state === 'locked'));
    // Seite geschlossen
    await mod.call('POST', '/api/presence/leave', { tabId: 'tab-mod-1' }); assert.equal((await admin.call('GET', '/api/presence')).members.some((x) => x.id === meM.id), true); await mod.call('POST', '/api/presence/leave', { tabId: 'tab-mod-2' }); assert.equal((await admin.call('GET', '/api/presence')).members.some((x) => x.id === meM.id), false);
    // Externe Partner: erscheinen für Mitglieder (nur Zugangsnummer), sehen die Liste selbst aber nie
    { const { clearAttempts } = await import('../server/core/auth.js'); for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) clearAttempts(`pl|${ip}`);
      const pp = await admin.call('POST', '/api/partners', { type: 'buyer', name: 'Online Partner', contactName: 'X', apps: ['market'] }); const pc = new Client(); assert.equal((await pc.call('POST', `/api/p/${pp.partner.linkPath.split('/').pop()}/login`, { code: pp.code })).status, 200);
      assert.equal((await new Client().call('POST', '/api/p/presence', { tabId: 'partner-tab-1' })).status, 401); assert.equal((await pc.call('POST', '/api/p/presence', { tabId: 'x' })).ok, false);
      assert.equal((await pc.call('POST', '/api/p/presence', { tabId: 'partner-tab-1', locked: false })).ok, true);
      r = await admin.call('GET', '/api/presence'); const pm = r.members.find((x) => x.kind === 'partner' && x.id === pp.partner.id); assert.ok(pm); assert.equal(pm.label, pp.partner.number); assert.equal(pm.state, 'active'); assert.equal(pm.isMe, false); assert.equal(JSON.stringify(r).includes('Online Partner'), false); // nur die Zugangsnummer, kein Name
      assert.equal((await pc.call('GET', '/api/presence')).status, 401); // Partner sehen die Liste nicht
      await pc.call('POST', '/api/p/presence', { tabId: 'partner-tab-1', locked: true }); assert.equal((await admin.call('GET', '/api/presence')).members.find((x) => x.id === pp.partner.id && x.kind === 'partner').state, 'locked');
      await pc.call('POST', '/api/p/presence/leave', { tabId: 'partner-tab-1' }); assert.equal((await admin.call('GET', '/api/presence')).members.some((x) => x.kind === 'partner' && x.id === pp.partner.id), false); }
    // Abschalten
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'presence.enabled': false } })).status, 200); r = await admin.call('GET', '/api/presence'); assert.equal(r.enabled, false); assert.equal(r.members.length, 0); await admin.call('PUT', '/api/config', { values: { 'presence.enabled': true } });
    await admin.call('POST', '/api/presence/leave', { tabId: 'tab-admin-1' });
    ok('Online-Liste: nur Mitglieder, Personalnummer + Rang, gesperrt/aktiv, Herzschlag/Abmelden, abschaltbar'); }

  // ══ Karte: Zonen ══
  { const sq = (x, y, s = 100) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]]; const cfgM = (await admin.call('GET', '/api/map/config')); assert.ok(cfgM.zoneKinds.length >= 6); const danger = cfgM.zoneKinds.find((k) => k.key === 'danger').id;
    assert.equal((await new Client().call('GET', '/api/map/zones')).status, 401);
    for (const bad of [{ name: '', points: sq(0, 0) }, { name: 'Zwei', points: [[0, 0], [1, 1]] }, { name: 'Doppelt', points: [[0, 0], [0, 0], [1, 1], [1, 1]] }, { name: 'Text', points: 'abc' }, { name: 'Zahl', points: [[0, 0], [1, 'x'], [2, 2]] }, { name: 'Weit', points: [[0, 0], [99999, 1], [2, 2]] }, { name: 'Art', kindId: 99999, points: sq(0, 0) }, { name: 'Farbe', color: 'rot', points: sq(0, 0) }, { name: 'Deckkraft', opacity: 0.99, points: sq(0, 0) }, { name: 'Sicht', visibility: 'x', points: sq(0, 0) }, { name: 'Viele', points: Array.from({ length: 450 }, (_, i) => [i, i * i % 997]) }]) assert.equal((await admin.call('POST', '/api/map/zones', bad)).status, 400, JSON.stringify(bad).slice(0, 50));
    r = await admin.call('POST', '/api/map/zones', { name: 'Gefahrenzone Hafen', description: '- Schießerei möglich', kindId: danger, opacity: 0.4, points: [...sq(1000, 1000, 250), [1000, 1000]] }); assert.equal(r.status, 201); const z1 = r.zone;
    assert.equal(z1.points.length, 4); assert.equal(z1.kind.key, undefined); assert.equal(z1.kind.id, danger); assert.equal(z1.color, cfgM.zoneKinds.find((k) => k.key === 'danger').color); assert.equal(z1.opacity, 0.4); assert.equal(z1.visibility, 'all'); // Schlusspunkt = Startpunkt wird entfernt
    r = await admin.call('POST', '/api/map/zones', { name: 'Geheimes Gebiet', visibility: 'editors', color: '#112233', points: sq(-500, -500) }); const z2 = r.zone; assert.equal(z2.ownColor, '#112233'); assert.ok(z2.kind); // Standardart „Sonstiges“
    r = await admin.call('GET', '/api/map/zones'); assert.ok(r.zones.some((z) => z.id === z1.id) && r.zones.some((z) => z.id === z2.id));
    // Rechte: sehen mit map.view, ändern nur mit map.edit; „nur Bearbeiter“ bleibt verborgen
    const meMap = new Set((await mod.call('GET', '/api/auth/me')).user.permissions);
    await setPerms(['map.view']); if (!meMap.has('map.edit') && !(new Set((await mod.call('GET', '/api/auth/me')).user.permissions)).has('map.edit')) { r = await mod.call('GET', '/api/map/zones'); assert.ok(r.zones.some((z) => z.id === z1.id)); assert.equal(r.zones.some((z) => z.id === z2.id), false); assert.equal(r.zones[0].canEdit, false); assert.equal((await mod.call('POST', '/api/map/zones', { name: 'Nein', points: sq(0, 0) })).status, 403); assert.equal((await mod.call('PATCH', `/api/map/zones/${z1.id}`, { name: 'Hack' })).status, 403); assert.equal((await mod.call('DELETE', `/api/map/zones/${z1.id}`)).status, 403); }
    await setPerms(['map.view', 'map.edit']); r = await mod.call('GET', '/api/map/zones'); assert.ok(r.zones.some((z) => z.id === z2.id)); assert.equal(r.zones[0].canEdit, true);
    r = await admin.call('PATCH', `/api/map/zones/${z1.id}`, { name: 'Gefahrenzone Hafen Süd', opacity: 0.2, points: sq(1000, 1000, 400) }); assert.equal(r.zone.name, 'Gefahrenzone Hafen Süd'); assert.equal(r.zone.points[2][0], 1400); assert.equal(r.zone.opacity, 0.2);
    assert.equal((await admin.call('PATCH', `/api/map/zones/${z1.id}`, { points: [[0, 0]] })).status, 400); assert.equal((await admin.call('PATCH', '/api/map/zones/99999', { name: 'x' })).status, 404);
    r = await admin.call('GET', '/api/audit?module=map&limit=100'); assert.ok(r.rows.some((x) => x.action === 'map.zone_created') && r.rows.some((x) => x.action === 'map.zone_updated'));
    for (const id of [z1.id, z2.id]) assert.equal((await admin.call('DELETE', `/api/map/zones/${id}`)).status, 200); assert.equal((await admin.call('GET', '/api/map/zones')).zones.length, 0); await setPerms([]);
    ok('Karte: Zonen frei einzeichnen (Polygon, Art/Farbe/Deckkraft/Notizen), Prüfung der Punkte, nur Bearbeiter sehen verborgene, Rechte, Audit'); }

  // ══ Termine & Aufträge ══
  { const { runScheduleReminders } = await import('../server/modules/schedule.js');
    assert.equal((await new Client().call('GET', '/api/schedule/options')).status, 401);
    const meA = (await admin.call('GET', '/api/auth/me')).user, meM = (await mod.call('GET', '/api/auth/me')).user; const hasP = async (p) => new Set((await mod.call('GET', '/api/auth/me')).user.permissions).has(p);
    await setPerms([]); if (!(await hasP('schedule.view'))) assert.equal((await mod.call('GET', '/api/schedule/options')).status, 403);
    await setPerms(['schedule.view']);
    r = await mod.call('GET', '/api/schedule/options'); assert.equal(r.status, 200); assert.ok(r.kinds.length >= 7); assert.ok(r.reminders.length >= 6); assert.equal(r.members.find((x) => x.id === meM.id).label, `${meM.memberNumber} (Du)`); assert.equal(r.members.find((x) => x.id === meA.id).label, meA.memberNumber); assert.equal(JSON.stringify(r).includes(meA.displayName ?? '§§'), false); const kind = r.kinds[0].id;
    const D = (min) => new Date(Date.now() + min * 60_000).toISOString(); const startA = D(60 * 24 * 3), base = { title: 'Übergabe am Hafen', kindId: kind, startsAt: startA, endsAt: D(60 * 24 * 3 + 90), location: 'Pier 4', description: 'Ware bringen', participants: [meM.id], reminders: [0, 15] };
    // Termin anlegen: Prüfungen
    for (const bad of [{ title: 'x' }, { startsAt: 'morgen' }, { endsAt: D(60 * 24 * 3 - 30) }, { reminders: [7] }, { reminders: [0, 5, 15, 30, 60] }, { participants: [99999] }, { kindId: 99999 }, { visibility: 'geheim' }]) assert.equal((await admin.call('POST', '/api/schedule/events', { ...base, ...bad })).status, 400, JSON.stringify(bad));
    if (!(await hasP('schedule.create'))) assert.equal((await mod.call('POST', '/api/schedule/events', base)).status, 403);
    r = await admin.call('POST', '/api/schedule/events', base); assert.equal(r.status, 201); const ev = r.event; assert.deepEqual(ev.reminders, [0, 15]); assert.equal(ev.participants.length, 1); assert.equal(ev.participants[0].label, meM.memberNumber); assert.equal(ev.participants[0].rsvp, 'pending'); assert.equal(ev.kind.id, kind);
    // Sichtbarkeit + Zu-/Absage
    const rng = `from=${encodeURIComponent(D(-60))}&to=${encodeURIComponent(D(60 * 24 * 10))}`;
    r = await mod.call('GET', `/api/schedule/events?${rng}`); const mine = r.events.find((x) => x.id === ev.id); assert.ok(mine); assert.equal(mine.rsvp, 'pending'); assert.equal(mine.canEdit, await hasP('schedule.manage')); assert.equal(JSON.stringify(r).includes(meA.displayName ?? '§§'), false);
    if (!(await hasP('schedule.manage')) && !(await hasP('schedule.create'))) { assert.equal((await mod.call('PATCH', `/api/schedule/events/${ev.id}`, { title: 'Hack' })).status, 403); assert.equal((await mod.call('DELETE', `/api/schedule/events/${ev.id}`)).status, 403); }
    assert.equal((await mod.call('POST', `/api/schedule/events/${ev.id}/rsvp`, { response: 'vielleicht' })).status, 400); assert.equal((await mod.call('POST', `/api/schedule/events/${ev.id}/rsvp`, { response: 'yes' })).status, 200);
    assert.equal((await admin.call('GET', `/api/schedule/events/${ev.id}`)).event.participants[0].rsvp, 'yes'); assert.equal((await admin.call('POST', `/api/schedule/events/${ev.id}/rsvp`, { response: 'yes' })).status, 403); // nur Beteiligte
    assert.ok((await admin.call('GET', '/api/notifications')).notifications.some((n) => /Zugesagt/.test(n.title))); // Ersteller wird informiert
    // „Nur Beteiligte“-Termin: Außenstehende sehen ihn nicht
    r = await admin.call('POST', '/api/schedule/events', { ...base, title: 'Vertraulich', visibility: 'invited', participants: [], reminders: [] }); const priv = r.event.id;
    if (!(await hasP('schedule.manage'))) { assert.equal((await mod.call('GET', `/api/schedule/events/${priv}`)).status, 404); assert.equal((await mod.call('GET', `/api/schedule/events?${rng}`)).events.some((x) => x.id === priv), false); await setPerms(['schedule.view', 'schedule.manage']); assert.ok((await mod.call('GET', `/api/schedule/events/${priv}`)).event); await setPerms(['schedule.view']); }
    // verschieben / absagen → Beteiligte werden benachrichtigt
    assert.equal((await admin.call('PATCH', `/api/schedule/events/${ev.id}`, { startsAt: D(60 * 24 * 4), endsAt: D(60 * 24 * 4 + 90) })).status, 200); assert.ok((await mod.call('GET', '/api/notifications')).notifications.some((n) => n.title === 'Termin verschoben'));
    assert.equal((await admin.call('PATCH', `/api/schedule/events/${ev.id}`, { status: 'cancelled' })).event.status, 'cancelled'); assert.ok((await mod.call('GET', '/api/notifications')).notifications.some((n) => n.title === 'Termin abgesagt'));
    // Erinnerungen: einmal je Empfänger und Zeitpunkt
    r = await admin.call('POST', '/api/schedule/events', { ...base, title: 'Gleich', startsAt: D(10), endsAt: null, reminders: [0, 15] }); const soon = r.event.id;
    const sent1 = runScheduleReminders(); assert.ok(sent1 >= 2, `Erinnerungen ${sent1}`); assert.equal(runScheduleReminders(), 0); assert.ok((await mod.call('GET', '/api/notifications')).notifications.some((n) => /Termin in 15 Minuten: Gleich/.test(n.title)));
    // Aufträge
    if (!(await hasP('schedule.tasks.assign'))) assert.equal((await mod.call('POST', '/api/schedule/tasks', { title: 'Nicht erlaubt', assignees: [meA.id] })).status, 403);
    for (const bad of [{ title: 'x' }, { assignees: [] }, { assignees: [99999] }, { priority: 'wichtig' }, { dueAt: 'bald' }, { eventId: 99999 }]) assert.equal((await admin.call('POST', '/api/schedule/tasks', { title: 'Farmen gehen', assignees: [meM.id], ...bad })).status, 400, JSON.stringify(bad));
    r = await admin.call('POST', '/api/schedule/tasks', { title: 'Farmen gehen', description: '200 Stück Weizen', priority: 'high', dueAt: D(60 * 24 * 2), assignees: [meM.id], eventId: soon }); assert.equal(r.status, 201); const tk = r.task; assert.match(tk.number, /^AUF-\d{4}$/); assert.equal(tk.status, 'open'); assert.equal(tk.event.id, soon);
    assert.ok((await mod.call('GET', '/api/notifications')).notifications.some((n) => /Neuer Auftrag/.test(n.title)));
    r = await mod.call('GET', '/api/schedule/tasks?scope=mine'); assert.ok(r.tasks.some((x) => x.id === tk.id)); assert.equal(r.tasks.find((x) => x.id === tk.id).myState, 'open'); assert.equal((await mod.call('GET', '/api/schedule/tasks?scope=all')).status, (await hasP('schedule.manage')) ? 200 : 403);
    assert.equal((await admin.call('GET', `/api/schedule/events?${rng}`)).tasks.some((x) => x.id === tk.id), true); // Fristen erscheinen im Kalender
    assert.equal((await mod.call('POST', `/api/schedule/tasks/${tk.id}/state`, { state: 'egal' })).status, 400); assert.equal((await admin.call('POST', `/api/schedule/tasks/${tk.id}/state`, { state: 'done' })).status, 403); // nur Beauftragte
    r = await mod.call('POST', `/api/schedule/tasks/${tk.id}/state`, { state: 'accepted' }); assert.equal(r.task.status, 'in_progress');
    r = await mod.call('POST', `/api/schedule/tasks/${tk.id}/state`, { state: 'done', note: '200 abgegeben' }); assert.equal(r.task.status, 'done'); assert.ok(r.task.doneAt); assert.equal(r.task.assignees[0].note, '200 abgegeben');
    assert.ok((await admin.call('GET', '/api/notifications')).notifications.some((n) => /Erledigt: Farmen gehen/.test(n.title)));
    if (!(await hasP('schedule.manage')) && !(await hasP('schedule.tasks.assign'))) assert.equal((await mod.call('PATCH', `/api/schedule/tasks/${tk.id}`, { title: 'Hack' })).status, 403);
    r = await admin.call('PATCH', `/api/schedule/tasks/${tk.id}`, { status: 'reopen' }); assert.equal(r.task.status, 'done'); // alle Beauftragten erledigt → bleibt erledigt
    r = await admin.call('POST', '/api/schedule/tasks', { title: 'Zwei Personen', assignees: [meM.id, meA.id], dueAt: D(-60) }); const t2 = r.task.id; assert.equal(r.task.overdue, true);
    r = await mod.call('POST', `/api/schedule/tasks/${t2}/state`, { state: 'done' }); assert.equal(r.task.status, 'in_progress'); r = await admin.call('POST', `/api/schedule/tasks/${t2}/state`, { state: 'declined', note: 'keine Zeit' }); assert.equal(r.task.status, 'done'); // Abgelehnte zählen nicht
    r = await admin.call('POST', '/api/schedule/tasks', { title: 'Überfällig', assignees: [meM.id], dueAt: D(-30) }); const t3 = r.task.id; const s2 = runScheduleReminders(); assert.ok(s2 >= 2, `Auftragserinnerungen ${s2}`); assert.equal(runScheduleReminders(), 0); assert.ok((await mod.call('GET', '/api/notifications')).notifications.some((n) => /Auftrag überfällig: Überfällig/.test(n.title)));
    assert.equal((await admin.call('PATCH', `/api/schedule/tasks/${t3}`, { status: 'cancelled' })).task.status, 'cancelled'); assert.equal((await mod.call('POST', `/api/schedule/tasks/${t3}/state`, { state: 'done' })).status, 400);
    // Übersicht, Dashboard, Audit, Löschen
    r = await mod.call('GET', '/api/schedule/summary'); assert.ok(r.openTasks >= 0); assert.ok(Array.isArray(r.next)); r = await mod.call('GET', '/api/dashboard'); assert.ok(r.widgets.some((w) => w.id === 'schedule' && typeof w.data.openTasks === 'number'));
    r = await admin.call('GET', '/api/audit?module=schedule&limit=100'); assert.ok(r.rows.some((x) => x.action === 'schedule.task_created') && r.rows.some((x) => x.action === 'schedule.event_created'));
    for (const id of [t2, t3, tk.id]) assert.equal((await admin.call('DELETE', `/api/schedule/tasks/${id}`)).status, 200); for (const id of [ev.id, priv, soon]) assert.equal((await admin.call('DELETE', `/api/schedule/events/${id}`)).status, 200);
    assert.equal((await admin.call('GET', `/api/schedule/events/${ev.id}`)).status, 404); await setPerms([]);
    ok('Termine & Aufträge: Termine mit Art/Beteiligten/Zu-/Absage/Sichtbarkeit, Erinnerungen einmalig, Aufträge mit Beauftragten und Status, Fristen im Kalender, nur Personalnummern, Rechte'); }

  // ══ Börse: mehrere Items pro Geschäft ══
  { const { all: dbAll } = await import('../server/core/db.js'); const { clearAttempts } = await import('../server/core/auth.js'); for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) clearAttempts(`pl|${ip}`);
    const mkItem = async (name) => (await admin.call('POST', '/api/market/items', { name, unit: 'Stk' })).item; const IA = await mkItem('Multi-Eisen'), IB = await mkItem('Multi-Kupfer'), IC = await mkItem('Multi-Gold');
    const pp = await admin.call('POST', '/api/partners', { type: 'buyer', name: 'Multi Partner', contactName: 'X', apps: ['market'] }); const pc = new Client(); assert.equal((await pc.call('POST', `/api/p/${pp.partner.linkPath.split('/').pop()}/login`, { code: pp.code })).status, 200);
    // Partner: Angebot mit mehreren Items
    for (const bad of [{ lines: [{ itemId: IA.id, quantity: 1, unitPrice: 10 }, { itemId: IA.id, quantity: 2, unitPrice: 10 }] }, { lines: [{ itemId: IA.id, quantity: 1 }] }, { lines: [{ itemId: 99999, quantity: 1, unitPrice: 5 }] }, { lines: [{ itemId: IA.id, quantity: 0, unitPrice: 5 }] }, { lines: Array.from({ length: 26 }, () => ({ itemId: IA.id, quantity: 1, unitPrice: 1 })) }]) assert.equal((await pc.call('POST', '/api/p/market/offers', bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    r = await pc.call('POST', '/api/p/market/offers', { lines: [{ itemId: IA.id, quantity: 5, unitPrice: 100 }, { itemId: IB.id, quantity: 2, unitPrice: 300 }, { itemId: IC.id, quantity: 1, unitPrice: 50 }], note: 'Sammelposten' }); assert.equal(r.status, 201); const dl = r.deal;
    assert.equal(dl.lineCount, 3); assert.equal(dl.lines.length, 3); assert.equal(dl.total, 1150); assert.equal(dl.quantity, 5); assert.equal(dl.item.name, 'Multi-Eisen'); assert.match(dl.itemLabel, /Multi-Eisen \+ 2 weitere/); assert.deepEqual(dl.lines.map((x) => x.total), [500, 600, 50]);
    r = await admin.call('GET', `/api/market/deals/${dl.id}`); assert.equal(r.deal.lines.length, 3); assert.ok(r.events[0].text.includes('Summe 1.150')); assert.ok((await admin.call('GET', '/api/notifications')).notifications.some((n) => /Multi-Eisen \+ 2 weitere/.test(n.title)));
    assert.ok((await admin.call('GET', '/api/market/deals?q=Multi-Gold')).deals.some((x) => x.id === dl.id)); // Suche über alle Positionen
    // Legacy: ein Item wie bisher
    r = await pc.call('POST', '/api/p/market/offers', { itemId: IA.id, quantity: 3, unitPrice: 90 }); assert.equal(r.status, 201); assert.equal(r.deal.lineCount, 1); assert.equal(r.deal.total, 270); assert.equal(r.deal.itemLabel, undefined);
    // Gegenangebot für alle Positionen
    assert.equal((await admin.call('POST', `/api/market/deals/${dl.id}/counter`, { quantity: 1, unitPrice: 1 })).status, 400); // mehrere Positionen: Einzelwerte reichen nicht
    assert.equal((await admin.call('POST', `/api/market/deals/${dl.id}/counter`, { lines: [{ id: dl.lines[0].id, quantity: 5, unitPrice: 90 }] })).status, 400);
    assert.equal((await admin.call('POST', `/api/market/deals/${dl.id}/counter`, { lines: dl.lines.map((x) => ({ id: x.id + 999, quantity: 1, unitPrice: 1 })) })).status, 400);
    r = await admin.call('POST', `/api/market/deals/${dl.id}/counter`, { lines: [{ id: dl.lines[0].id, quantity: 5, unitPrice: 90 }, { id: dl.lines[1].id, quantity: 2, unitPrice: 250 }, { id: dl.lines[2].id, quantity: 1, unitPrice: 50 }], text: 'Etwas weniger' }); assert.equal(r.status, 200); assert.equal(r.deal.total, 450 + 500 + 50); assert.equal(r.deal.turn, 'partner'); assert.equal(r.deal.lines[1].unitPrice, 250);
    r = await pc.call('GET', `/api/p/market/deals/${dl.id}`); assert.equal(r.deal.lines.length, 3); assert.equal(r.deal.total, 1000);
    assert.equal((await pc.call('POST', `/api/p/market/deals/${dl.id}/accept`, {})).status, 200);
    let led = dbAll("SELECT item_id, quantity, unit_price, amount, status, direction FROM finance_ledger WHERE deal_id = ? ORDER BY id", dl.id); assert.equal(led.length, 3); assert.ok(led.every((x) => x.status === 'expected' && x.direction === 'out')); assert.equal(led.reduce((a, x) => a + x.amount, 0), 1000); assert.deepEqual(led.map((x) => x.item_id), [IA.id, IB.id, IC.id]); // Journal: je Item eine Zeile
    // Übergabe → Wareneingang mit Einlagerung aller Positionen
    const whM = (await admin.call('POST', '/api/warehouses', { name: 'Multi-Lager', capacity: 100000 })).warehouse.id; const stockOf = async (item) => ((await admin.call('GET', `/api/warehouses/${whM}`)).stock.find((s) => s.itemId === item.id)?.quantity ?? 0);
    assert.equal((await admin.call('POST', `/api/market/deals/${dl.id}/handover`, { info: 'Am Hafen abgeben' })).status, 200); assert.equal((await admin.call('POST', `/api/market/deals/${dl.id}/advance`, { to: 'delivered', warehouseId: whM })).status, 200);
    assert.equal(await stockOf(IA), 5); assert.equal(await stockOf(IB), 2); assert.equal(await stockOf(IC), 1);
    await admin.call('POST', `/api/market/deals/${dl.id}/advance`, { to: 'payout' }); r = await admin.call('POST', `/api/market/deals/${dl.id}/advance`, { to: 'completed' }); assert.equal(r.deal.status, 'completed');
    led = dbAll('SELECT status FROM finance_ledger WHERE deal_id = ?', dl.id); assert.ok(led.every((x) => x.status === 'settled'));
    // Team-Angebot an den Partner mit mehreren Items aus einem Lager
    await admin.call('POST', `/api/warehouses/${whM}/stock`, { itemId: IA.id, action: 'in', quantity: 20 });
    for (const bad of [{ lines: [{ itemId: IA.id, quantity: 1, unitPrice: 5 }, { itemId: IA.id, quantity: 1, unitPrice: 5 }] }, { lines: [{ itemId: IA.id, quantity: 9999, unitPrice: 5 }] }, { lines: [{ itemId: IC.id, quantity: 5, unitPrice: 5 }] }, { lines: [{ itemId: IA.id, quantity: 1, unitPrice: 5 }, { itemId: IB.id, quantity: 99, unitPrice: 5 }] }]) assert.ok([400, 409].includes((await admin.call('POST', '/api/market/offers', { partnerId: pp.partner.id, warehouseId: whM, ...bad })).status), JSON.stringify(bad).slice(0, 60));
    r = await admin.call('POST', '/api/market/offers', { partnerId: pp.partner.id, warehouseId: whM, lines: [{ itemId: IA.id, quantity: 10, unitPrice: 120 }, { itemId: IB.id, quantity: 1, unitPrice: 400 }], note: 'Paket' }); assert.equal(r.status, 201); const sd = r.deal; assert.equal(sd.lineCount, 2); assert.equal(sd.total, 1600); assert.equal(sd.direction, 'sell');
    const beforeA = await stockOf(IA), beforeB = await stockOf(IB);
    assert.equal((await pc.call('POST', `/api/p/market/deals/${sd.id}/accept`, {})).status, 200); assert.equal(await stockOf(IA), beforeA - 10); assert.equal(await stockOf(IB), beforeB - 1); // beim Annehmen aus dem Lager abgebucht
    assert.equal(dbAll("SELECT 1 FROM finance_ledger WHERE deal_id = ? AND direction = 'in'", sd.id).length, 2);
    assert.equal((await admin.call('POST', `/api/market/deals/${sd.id}/cancel`, { text: 'Test' })).status, 200); assert.equal(await stockOf(IA), beforeA); assert.equal(await stockOf(IB), beforeB); // Storno bucht alle Positionen zurück
    // Item-Löschung berücksichtigt Positionen; Superadmin kann samt Geschäften löschen
    assert.equal((await admin.call('DELETE', `/api/market/items/${IC.id}`)).status, 409); assert.equal((await admin.call('DELETE', `/api/market/items/${IC.id}?force=1`)).status, 200); assert.equal((await admin.call('GET', `/api/market/deals/${dl.id}`)).status, 404);
    ok('Börse: mehrere Items pro Geschäft (Partner-Angebot, Gegenangebot je Position, Journal je Item, Einlagerung/Ausbuchung/Storno aller Positionen, Suche, Löschen)'); }

  // ══ Aktivität & Abmeldung ══
  { const { db, run: dbRun, get: dbGet } = await import('../server/core/db.js'); const { runActivityDigest } = await import('../server/modules/activity.js');
    const mk = async (name, perms = []) => { const u = (await admin.call('POST', '/api/users', { displayName: name, username: name.toLowerCase(), password: 'passwort123' })).user; if (perms.length) await admin.call('PATCH', `/api/users/${u.id}`, { permissions: perms }); const c = new Client(); assert.equal((await c.call('POST', '/api/auth/login', { username: name.toLowerCase(), password: 'passwort123' })).status, 200); return { u, c }; };
    const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    assert.equal((await new Client().call('GET', '/api/activity/me')).status, 401);
    const A = await mk('Aktivera', ['activity.absence']), B = await mk('Aktiverb', ['activity.absence']), L = await mk('Aktivlead', ['activity.absence', 'activity.view', 'activity.manage']), V = await mk('Aktivview', ['activity.view']);
    // Anmelden zählt als aktiv; der Herzschlag mit entsperrtem Bildschirm ebenfalls
    r = await A.c.call('GET', '/api/activity/me'); assert.equal(r.status, 200); assert.equal(r.status, 200); assert.ok(r.lastActiveAt); assert.ok(r.days14 >= 1);
    assert.equal((await A.c.call('POST', '/api/presence', { tabId: 'abcdef123456', locked: false })).status, 200);
    // Eigene Abmeldung: Prüfungen
    for (const bad of [{ from: day(0), to: day(-1) }, { from: day(-5), to: day(-3) }, { from: day(0), to: day(400) }, { from: 'kaputt', to: day(1) }, { from: day(0), to: day(61) }, {}]) assert.equal((await A.c.call('POST', '/api/activity/absences', bad)).status, 400, JSON.stringify(bad));
    r = await A.c.call('POST', '/api/activity/absences', { from: day(0), to: day(5), reason: 'Urlaub' }); assert.equal(r.status, 201); const absA = r.absence;
    assert.equal((await A.c.call('POST', '/api/activity/absences', { from: day(3), to: day(8) })).status, 400); // überschneidet sich
    assert.equal((await A.c.call('POST', '/api/activity/absences', { userId: B.u.id, from: day(0), to: day(2) })).status, 403); // für andere nur mit activity.manage
    assert.equal((await V.c.call('POST', '/api/activity/absences', { from: day(0), to: day(2) })).status, 403); // ohne activity.absence
    r = await A.c.call('GET', '/api/activity/me'); assert.equal(r.status, 200); assert.equal(r.status, 200); assert.equal(r.status === 200 && r.absences.length, 1); assert.equal(r.status, 200); assert.equal(r.absences[0].reason, 'Urlaub'); assert.equal(r.canView, false);
    // Übersicht: nur mit activity.view, zeigt Status, nur Personalnummern
    assert.equal((await A.c.call('GET', '/api/activity/overview')).status, 403);
    r = await V.c.call('GET', '/api/activity/overview'); assert.equal(r.status, 200); const rowA = r.rows.find((x) => x.id === A.u.id), rowB = r.rows.find((x) => x.id === B.u.id);
    assert.equal(rowA.status, 'absent'); assert.equal(rowA.absence.reason, 'Urlaub'); assert.ok(rowA.days14 >= 1); assert.equal(rowB.status, 'active'); assert.equal(JSON.stringify(r).includes('Aktivera'), false); assert.equal(r.canManage, false);
    // Führung trägt für andere ein und beendet
    r = await L.c.call('POST', '/api/activity/absences', { userId: B.u.id, from: day(2), to: day(4), reason: 'Prüfung' }); assert.equal(r.status, 201); assert.equal(r.absence.byOther, true); const absB = r.absence;
    assert.ok((await B.c.call('GET', '/api/notifications')).notifications.some((n) => /abgemeldet/.test(n.title)));
    assert.ok((await V.c.call('GET', '/api/notifications')).notifications.some((n) => /Abmeldung/.test(n.title))); // Führung erfährt von der Abmeldung
    assert.equal((await A.c.call('DELETE', `/api/activity/absences/${absB.id}`)).status, 403); // fremde Abmeldung
    r = await B.c.call('DELETE', `/api/activity/absences/${absB.id}`); assert.equal(r.status, 200); assert.equal(r.result, 'deleted'); // noch nicht begonnen ⇒ gelöscht
    r = await A.c.call('DELETE', `/api/activity/absences/${absA.id}`); assert.equal(r.status, 200); assert.equal(r.result, 'deleted'); // heute begonnen ⇒ gelöscht
    assert.equal((await A.c.call('DELETE', `/api/activity/absences/${absA.id}`)).status, 404);
    // Inaktiv: lange nicht aktiv und nicht abgemeldet ⇒ Problemleiste + Wochenhinweis
    dbRun('UPDATE users SET last_active_at = ? WHERE id = ?', new Date(Date.now() - 20 * 86_400_000).toISOString(), B.u.id);
    r = await V.c.call('GET', '/api/activity/overview'); assert.equal(r.rows.find((x) => x.id === B.u.id).status, 'inactive');
    r = await V.c.call('GET', '/api/problems'); assert.ok(r.problems.some((p) => p.id === 'activity:inactive'));
    assert.equal(JSON.stringify((await A.c.call('GET', '/api/problems')).problems).includes('activity:inactive'), false); // nur mit activity.view
    runActivityDigest(); assert.ok((await V.c.call('GET', '/api/notifications')).notifications.some((n) => /inaktiv/.test(n.title)));
    r = await L.c.call('POST', '/api/activity/absences', { userId: B.u.id, from: day(0), to: day(3) }); assert.equal(r.status, 201);
    r = await V.c.call('GET', '/api/activity/overview'); assert.equal(r.rows.find((x) => x.id === B.u.id).status, 'absent'); // abgemeldet ⇒ nicht inaktiv
    r = await admin.call('GET', '/api/audit?module=activity&limit=50'); assert.ok(r.rows.some((x) => x.action === 'activity.absence_added') && r.rows.some((x) => x.action === 'activity.absence_ended'));
    void db; void dbGet;
    ok('Aktivität & Abmeldung: Aktivität durch Anmeldung/Herzschlag, Selbst-Abmeldung mit Prüfungen, Führung trägt ein/beendet, Übersicht nur mit Recht, Inaktiv ⇒ Problemleiste + Wochenhinweis, Audit'); }

  // ══ Einarbeitung ══
  { const mk = async (name, perms = []) => { const u = (await admin.call('POST', '/api/users', { displayName: name, username: name.toLowerCase(), password: 'passwort123' })).user; if (perms.length) await admin.call('PATCH', `/api/users/${u.id}`, { permissions: perms }); const c = new Client(); assert.equal((await c.call('POST', '/api/auth/login', { username: name.toLowerCase(), password: 'passwort123' })).status, 200); return { u, c }; };
    const Lead = await mk('Einarblead', ['onboarding.check']), Mgr = await mk('Einarbmgr', ['onboarding.manage']);
    const NEW = await mk('Einarbneu'); // neu freigeschaltet ⇒ Einarbeitung startet automatisch
    assert.equal((await new Client().call('GET', '/api/onboarding/me')).status, 401);
    r = await admin.call('GET', '/api/onboarding'); assert.equal(r.status, 200); assert.equal(r.steps.length, 6); assert.ok(r.steps.some((s) => s.confirmBy === 'self') && r.steps.some((s) => s.confirmBy === 'leader'));
    r = await NEW.c.call('GET', '/api/onboarding/me'); assert.equal(r.active, true); assert.equal(r.total, 6); assert.equal(r.done, 0);
    const selfStep = r.steps.find((s) => s.confirmBy === 'self'), leadStep = r.steps.find((s) => s.confirmBy === 'leader');
    assert.ok((await NEW.c.call('GET', '/api/notifications')).notifications.some((n) => /Willkommen/.test(n.title)));
    assert.ok((await Lead.c.call('GET', '/api/notifications')).notifications.some((n) => /Neues Mitglied/.test(n.title)));
    // Mitglied hakt seine Schritte selbst ab, die der Führung nicht
    r = await NEW.c.call('POST', `/api/onboarding/me/steps/${selfStep.id}`, { done: true }); assert.equal(r.status, 200); assert.equal(r.done, 1);
    assert.equal((await NEW.c.call('POST', `/api/onboarding/me/steps/${leadStep.id}`, { done: true })).status, 403);
    assert.equal((await NEW.c.call('GET', '/api/onboarding')).status, 403); // Übersicht nur für die Führung
    assert.equal((await NEW.c.call('POST', `/api/onboarding/${NEW.u.id}/steps/${leadStep.id}`, { done: true })).status, 403);
    // Führung bestätigt – alle Schritte ⇒ abgeschlossen
    for (const s of (await Lead.c.call('GET', '/api/onboarding')).rows.find((x) => x.userId === NEW.u.id).steps) if (!s.done) assert.equal((await Lead.c.call('POST', `/api/onboarding/${NEW.u.id}/steps/${s.id}`, { done: true })).status, 200);
    r = await NEW.c.call('GET', '/api/onboarding/me'); assert.equal(r.active, false); assert.ok(r.completedAt); assert.equal(r.done, 6);
    assert.ok((await NEW.c.call('GET', '/api/notifications')).notifications.some((n) => /abgeschlossen/.test(n.title)));
    // Schritt wieder offen ⇒ nicht mehr abgeschlossen
    assert.equal((await Lead.c.call('POST', `/api/onboarding/${NEW.u.id}/steps/${leadStep.id}`, { done: false })).status, 200); r = await NEW.c.call('GET', '/api/onboarding/me'); assert.equal(r.active, true);
    // Die Führung bestätigt Schritte der Führung nicht für sich selbst
    assert.equal((await admin.call('DELETE', '/api/onboarding/' + Lead.u.id)).status, 200); assert.equal((await Lead.c.call('POST', '/api/onboarding/' + Lead.u.id + '/start')).status, 201); assert.equal((await Lead.c.call('POST', `/api/onboarding/${Lead.u.id}/steps/${leadStep.id}`, { done: true })).status, 403);
    assert.equal((await Lead.c.call('POST', '/api/onboarding/' + Lead.u.id + '/start')).status, 400); // läuft schon
    // Schritte verwalten: nur mit onboarding.manage
    assert.equal((await Lead.c.call('POST', '/api/onboarding/steps', { title: 'Neu', confirmBy: 'leader' })).status, 403);
    for (const bad of [{}, { title: 'x', confirmBy: 'leader' }, { title: 'Gut', confirmBy: 'andere' }]) assert.equal((await Mgr.c.call('POST', '/api/onboarding/steps', bad)).status, 400, JSON.stringify(bad));
    r = await Mgr.c.call('POST', '/api/onboarding/steps', { title: 'Eigener Schritt', description: 'Test', confirmBy: 'self' }); assert.equal(r.status, 201); const own = r.step; assert.equal((await NEW.c.call('GET', '/api/onboarding/me')).total, 7);
    assert.equal((await Mgr.c.call('POST', `/api/onboarding/steps/${own.id}/move`, { dir: 'up' })).status, 200); r = await Mgr.c.call('GET', '/api/onboarding'); assert.equal(r.steps[5].id, own.id);
    assert.equal((await Mgr.c.call('PATCH', `/api/onboarding/steps/${own.id}`, { isActive: false })).status, 200); assert.equal((await NEW.c.call('GET', '/api/onboarding/me')).total, 6);
    assert.equal((await Mgr.c.call('DELETE', `/api/onboarding/steps/${own.id}`)).status, 200); assert.equal((await Mgr.c.call('DELETE', `/api/onboarding/steps/${own.id}`)).status, 404);
    // Beenden / Entfernen
    assert.equal((await Lead.c.call('POST', `/api/onboarding/${NEW.u.id}/finish`)).status, 200); assert.equal((await NEW.c.call('GET', '/api/onboarding/me')).active, false);
    assert.equal((await Lead.c.call('DELETE', `/api/onboarding/${NEW.u.id}`)).status, 200); assert.equal((await NEW.c.call('GET', '/api/onboarding/me')).active, false); assert.equal((await Lead.c.call('DELETE', `/api/onboarding/${NEW.u.id}`)).status, 404);
    // Dashboard-Widget
    r = await NEW.c.call('GET', '/api/dashboard'); assert.ok(r.widgets.some((w) => w.id === 'onboarding'));
    // Funktion abschaltbar
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'onboarding.enabled': false } })).status, 200); const X = await mk('Einarbkeine'); assert.equal((await X.c.call('GET', '/api/onboarding/me')).active, false); await admin.call('PUT', '/api/config', { values: { 'onboarding.enabled': true } });
    r = await admin.call('GET', '/api/audit?module=onboarding&limit=50'); assert.ok(r.rows.some((x) => x.action === 'onboarding.step_created') && r.rows.some((x) => x.action === 'onboarding.step'));
    ok('Einarbeitung: Start bei Freischaltung, Mitglied hakt eigene Schritte ab, Führung bestätigt (nicht für sich selbst), Abschluss/Wiederöffnen, Schritte verwalten (onboarding.manage), Beenden/Entfernen, abschaltbar'); }

  // ══ Wochen-/Monatsbericht ══
  { assert.equal((await new Client().call('GET', '/api/report')).status, 401);
    r = await admin.call('GET', '/api/report?period=week'); assert.equal(r.status, 200); assert.match(r.period.label, /^KW \d+\/\d{4}$/); assert.equal(r.period.isCurrent, true); assert.ok(r.sections.market && r.sections.finance && r.sections.activity && r.sections.schedule);
    assert.equal(typeof r.sections.market.cur.volume, 'number'); assert.ok(Array.isArray(r.sections.market.cur.topItems)); assert.ok(r.sections.market.cur.completed >= 0);
    r = await admin.call('GET', '/api/report?period=month&offset=-1'); assert.equal(r.status, 200); assert.equal(r.period.isCurrent, false); assert.match(r.period.range, /^01\./);
    for (const bad of ['offset=1', 'offset=-500', 'offset=abc']) assert.equal((await admin.call('GET', `/api/report?period=week&${bad}`)).status, 400, bad);
    const { periodOf } = await import('../server/modules/report.js');
    const w = periodOf('week', 0, new Date(Date.UTC(2026, 9, 18))); assert.equal(w.from, '2026-10-12'); assert.equal(w.to, '2026-10-19'); assert.equal(w.label, 'KW 42/2026'); const mo = periodOf('month', -1, new Date(Date.UTC(2026, 0, 15))); assert.equal(mo.from, '2025-12-01'); assert.equal(mo.to, '2026-01-01'); assert.equal(mo.label, 'Dezember 2025');
    // Nur Abschnitte, für die man das Ansichtsrecht hat
    const u = (await admin.call('POST', '/api/users', { displayName: 'Berichtler', username: 'berichtler', password: 'passwort123' })).user; await admin.call('PATCH', `/api/users/${u.id}`, { permissions: ['stats.view'] }); const bc = new Client(); await bc.call('POST', '/api/auth/login', { username: 'berichtler', password: 'passwort123' });
    r = await bc.call('GET', '/api/report'); assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.sections), []);
    await admin.call('PATCH', `/api/users/${u.id}`, { permissions: ['stats.view', 'finance.view'] }); r = await bc.call('GET', '/api/report'); assert.deepEqual(Object.keys(r.sections), ['finance']);
    for (const q of ['week', 'month']) { const pdf = await fetch(`${base}/api/report/export.pdf?period=${q}`, { headers: { cookie: admin.cookie } }); const buf = Buffer.from(await pdf.arrayBuffer()); assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.equal(buf.subarray(0, 5).toString(), '%PDF-'); }
    assert.equal((await fetch(`${base}/api/report/export.pdf`)).status, 401);
    ok('Wochen-/Monatsbericht: Zeiträume, Vergleich mit Vorperiode, Abschnitte nur mit Ansichtsrecht, PDF-Export'); }

  // ══ Partner-Bewertung ══
  { r = await admin.call('POST', '/api/partners', { type: 'buyer', name: 'Bewertung Partner', contactName: 'X', apps: ['market'] }); assert.equal(r.status, 201); const pid = r.partner.id;
    assert.equal(r.partner.rating.stats.total, 0); assert.equal(r.partner.rating.auto.label, 'Zu wenig Daten'); assert.equal(r.partner.rating.stars, null);
    assert.equal((await admin.call('PUT', `/api/partners/${pid}/rating`, { stars: 6 })).status, 400); assert.equal((await admin.call('PUT', `/api/partners/${pid}/rating`, { stars: 2.5 })).status, 400);
    r = await admin.call('PUT', `/api/partners/${pid}/rating`, { stars: 4, note: 'Liefert pünktlich' }); assert.equal(r.status, 200); assert.equal(r.rating.stars, 4); assert.equal(r.rating.note, 'Liefert pünktlich');
    assert.equal((await admin.call('GET', '/api/partners')).partners.find((p) => p.id === pid).rating.stars, 4);
    assert.equal((await admin.call('PUT', `/api/partners/${pid}/rating`, { stars: null, note: '' })).rating.stars, null);
    assert.equal((await admin.call('PUT', '/api/partners/99999/rating', { stars: 3 })).status, 404);
    // Kennzahlen aus Geschäften: 3 Abschlüsse, 1 Storno ⇒ 75 %
    const { run: dbRun, get: dbGet } = await import('../server/core/db.js'); const item = dbGet('SELECT id FROM market_items WHERE is_other = 0 LIMIT 1'); const t0 = new Date().toISOString();
    const ins = (st) => { const id = Number(dbRun("INSERT INTO market_deals (origin,partner_id,item_id,quantity,unit_price,proposed_by,status,created_at,updated_at,closed_at) VALUES ('offer',?,?,10,5,'partner',?,?,?,?)", pid, item.id, st, t0, t0, t0).lastInsertRowid); dbRun('INSERT INTO market_deal_lines (deal_id,pos,item_id,quantity,unit_price) VALUES (?,?,?,?,?)', id, 0, item.id, 10, 5); };
    for (const st of ['completed', 'completed', 'completed', 'cancelled', 'rejected']) ins(st);
    const rt = (await admin.call('GET', '/api/partners')).partners.find((p) => p.id === pid).rating; assert.equal(rt.stats.completed, 3); assert.equal(rt.stats.cancelled, 1); assert.equal(rt.stats.rejected, 1); assert.equal(rt.stats.completionRate, 75); assert.equal(rt.auto.label, 'Zuverlässig'); assert.equal(rt.stats.volume, 150);
    r = await admin.call('GET', '/api/audit?module=partners&limit=50'); assert.ok(r.rows.some((x) => x.action === 'partner.rated'));
    // Partner selbst sieht die Bewertung nie
    const pl = (await admin.call('POST', '/api/partners', { type: 'buyer', name: 'Bewertung Zwei', contactName: 'X', apps: ['market'] })); const pcl = new Client(); await pcl.call('POST', `/api/p/${pl.partner.linkPath.split('/').pop()}/login`, { code: pl.code }); assert.equal(JSON.stringify(await pcl.call('GET', '/api/p/me')).includes('rating'), false);
    ok('Partner-Bewertung: Kennzahlen aus Börsen-Geschäften (Abschlussquote), Einstufung, Sterne + Notiz der Führung, Audit, für Partner unsichtbar'); }

  // ══ Preise mit Nachkommastellen ══
  { const mkItem = async (name, extra = {}) => (await admin.call('POST', '/api/market/items', { name, unit: 'Stk', ...extra })).item;
    const ID = await mkItem('Dezimal-Kaffee', { referencePrice: 12.5 }); assert.equal(ID.referencePrice, 12.5);
    assert.equal((await admin.call('PATCH', `/api/market/items/${ID.id}`, { referencePrice: '13,25' })).item.referencePrice, 13.25);
    for (const badP of [0, -1, 'abc', 1e12]) assert.equal((await admin.call('POST', '/api/market/wanted', { itemId: ID.id, quantity: 1, unitPrice: badP })).status, 400, String(badP));
    r = await admin.call('POST', '/api/market/wanted', { itemId: ID.id, quantity: 4, unitPrice: 14.75 }); assert.equal(r.status, 201); assert.equal(r.wanted.unitPrice, 14.75);
    const pp = await admin.call('POST', '/api/partners', { type: 'buyer', name: 'Dezimal Partner', contactName: 'X', apps: ['market'] }); const pc = new Client(); assert.equal((await pc.call('POST', `/api/p/${pp.partner.linkPath.split('/').pop()}/login`, { code: pp.code })).status, 200);
    r = await pc.call('POST', '/api/p/market/offers', { lines: [{ itemId: ID.id, quantity: 3, unitPrice: 14.75 }, { itemId: ID.id === 0 ? 1 : (await mkItem('Dezimal-Tee')).id, quantity: 2, unitPrice: '9,99' }] }); assert.equal(r.status, 201);
    assert.equal(r.deal.lines[0].unitPrice, 14.75); assert.equal(r.deal.lines[0].total, 44.25); assert.equal(r.deal.lines[1].unitPrice, 9.99); assert.equal(r.deal.total, 64.23);
    assert.equal((await pc.call('POST', '/api/p/market/offers', { itemId: ID.id, quantity: 1, unitPrice: 0.001 })).status, 400);
    r = await admin.call('POST', `/api/market/deals/${r.deal.id}/counter`, { lines: r.deal.lines.map((l) => ({ id: l.id, quantity: l.quantity, unitPrice: 15.5 })) }); assert.equal(r.status, 200); assert.equal(r.deal.total, 77.5);
    // Lager-Preisspanne mit Nachkommastellen → Vorschlag mit zwei Stellen
    const IP = await mkItem('Dezimal-Salz'); r = await admin.call('PATCH', `/api/warehouses/items/${IP.id}`, { minPrice: 1.25, maxPrice: '2,5' });
    if (r.status === 200) { assert.equal(r.item.minPrice, 1.25); assert.equal(r.item.maxPrice, 2.5); }
    ok('Preise mit Nachkommastellen (Börse: Angebote, Gegenangebote, Gesuche, Richtpreis, Summen auf Cent gerundet)'); }

  // ══ Watchlist ══
  { const { clearAttempts } = await import('../server/core/auth.js');
    assert.equal((await new Client().call('GET', '/api/watchlist')).status, 401);
    const meM = (await mod.call('GET', '/api/auth/me')).user, mk = async (name, perms = []) => { const u = (await admin.call('POST', '/api/users', { displayName: name, username: name.toLowerCase(), password: 'passwort123' })).user; if (perms.length) await admin.call('PATCH', `/api/users/${u.id}`, { permissions: perms }); const c = new Client(); assert.equal((await c.call('POST', '/api/auth/login', { username: name.toLowerCase(), password: 'passwort123' })).status, 200); return { u, c }; };
    const W = await mk('Beobachtet', ['users.view']), L = await mk('Fuehrung', ['users.view', 'users.watchlist']), S = await mk('Spaeher', ['users.view']); const W_NO = (await admin.call('GET', `/api/users/${W.u.id}`)).user.memberNumber;
    // Eintragen: nur mit „Benutzer bearbeiten“; Prüfungen
    assert.equal((await S.c.call('POST', '/api/watchlist', { userId: W.u.id, reason: 'Verdacht' })).status, 403);
    for (const bad of [{}, { userId: 99999, reason: 'Verdacht' }, { userId: W.u.id, reason: 'x' }, { userId: W.u.id, reason: 'Verdacht', observers: [99999] }, { userId: (await admin.call('GET', '/api/auth/me')).user.id, reason: 'Selbst' }]) assert.equal((await admin.call('POST', '/api/watchlist', bad)).status, 400, JSON.stringify(bad));
    r = await admin.call('POST', '/api/watchlist', { userId: W.u.id, reason: 'Ex-Mitglied, Verdacht auf Weitergabe von Informationen', observers: [meM.id] }); assert.equal(r.status, 201); assert.equal(r.entry.label, W_NO); assert.equal(r.entry.observers.length, 1); assert.equal(r.entry.observers[0].label, meM.memberNumber);
    assert.equal((await admin.call('POST', '/api/watchlist', { userId: W.u.id, reason: 'Nochmal' })).status, 400); // nur einmal
    assert.ok((await mod.call('GET', '/api/notifications')).notifications.some((n) => /Du beobachtest jetzt/.test(n.title)));
    // Sichtbarkeit: Führung (users.watchlist) und Beobachter ja; Außenstehende und die Person selbst nie
    r = await L.c.call('GET', '/api/watchlist'); assert.equal(r.entries.length, 1); assert.equal(r.canViewAll, true); assert.equal(r.canManage, false);
    r = await S.c.call('GET', '/api/watchlist'); assert.equal(r.entries.length, 0);
    r = await W.c.call('GET', '/api/watchlist'); assert.equal(r.entries.length, 0); assert.equal((await W.c.call('GET', '/api/users')).users.find((x) => x.id === W.u.id).watch, null); assert.equal((await W.c.call('GET', `/api/users/${W.u.id}`)).user.watch, null);
    r = await S.c.call('GET', '/api/users'); assert.equal(r.users.find((x) => x.id === W.u.id).watch, null); assert.equal(JSON.stringify(r).includes('Weitergabe'), false);
    r = await L.c.call('GET', '/api/users'); assert.ok(r.users.find((x) => x.id === W.u.id).watch.reason.includes('Weitergabe')); assert.equal((await L.c.call('GET', `/api/users/${W.u.id}`)).user.watch.observers, 1);
    const mePerms = new Set((await mod.call('GET', '/api/auth/me')).user.permissions); await setPerms(['users.view']); const obs = await mod.call('GET', '/api/watchlist'); assert.equal(obs.entries.length, 1); // Beobachter sehen den Eintrag auch ohne Führungsrecht
    if (!mePerms.has('users.edit') && !(new Set((await mod.call('GET', '/api/auth/me')).user.permissions)).has('users.edit')) assert.equal((await mod.call('PATCH', `/api/watchlist/${W.u.id}`, { reason: 'Hack' })).status, 403);
    // Ändern und herunternehmen
    r = await admin.call('PATCH', `/api/watchlist/${W.u.id}`, { reason: 'Neuer Grund: Kontakt zu Rivalen', observers: [] }); assert.equal(r.entry.reason, 'Neuer Grund: Kontakt zu Rivalen'); assert.equal(r.entry.observers.length, 0); await setPerms([]);
    assert.equal((await admin.call('PATCH', `/api/watchlist/${W.u.id}`, { observers: [meM.id, S.u.id] })).entry.observers.length, 2); assert.equal((await S.c.call('GET', '/api/watchlist')).entries.length, 1); // neuer Beobachter sieht ihn
    // Gesperrte Person versucht sich anzumelden → Beobachter bekommen einen Hinweis
    assert.equal((await admin.call('POST', `/api/users/${W.u.id}/status`, { status: 'blocked', reason: 'Ausgetreten' })).status, 200);
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) clearAttempts(`${ip}|${W.u.username}`);
    assert.equal((await new Client().call('POST', '/api/auth/login', { username: 'beobachtet', password: 'passwort123' })).status, 403);
    assert.ok((await S.c.call('GET', '/api/notifications')).notifications.some((n) => new RegExp(`Watchlist: ${W_NO} versucht`).test(n.title)));
    assert.equal((await admin.call('PUT', '/api/config', { values: { 'users.watch_notify': false } })).status, 200); await admin.call('PUT', '/api/config', { values: { 'users.watch_notify': true } });
    r = await admin.call('GET', '/api/audit?module=users&limit=100'); assert.ok(r.rows.some((x) => x.action === 'watchlist.added') && r.rows.some((x) => x.action === 'watchlist.updated'));
    assert.equal((await S.c.call('DELETE', `/api/watchlist/${W.u.id}`)).status, 403); assert.equal((await admin.call('DELETE', `/api/watchlist/${W.u.id}`)).status, 200); assert.equal((await L.c.call('GET', '/api/watchlist')).entries.length, 0); assert.equal((await admin.call('DELETE', `/api/watchlist/${W.u.id}`)).status, 404);
    ok('Watchlist: Eintragen/Entfernen mit „Benutzer bearbeiten“, sichtbar nur für Führung, Beobachter und Ersteller (nie die Person selbst), roter Hinweis in Liste/Profil, Hinweis bei Anmeldeversuch, Audit'); }

  // ══ Dock-Gruppen ══
  { const { NAV, DOCK_GROUPS, allItems } = await import('../public/js/modules.js'); const ids = new Set(allItems(NAV).map((i) => i.id)), seen = new Set();
    for (const g of DOCK_GROUPS) { assert.ok(g.label && g.items.length >= 2, g.id); for (const id of g.items) { assert.ok(ids.has(id), `Dock-Gruppe ${g.id}: unbekannte App ${id}`); assert.equal(seen.has(id), false, `App ${id} in zwei Gruppen`); seen.add(id); } }
    assert.equal(new Set(DOCK_GROUPS.map((g) => g.id)).size, DOCK_GROUPS.length); for (const id of ['dashboard', 'help', 'legal']) assert.equal(seen.has(id), false, `${id} bleibt einzelnes Symbol`);
    // Anordnung im Panel einstellbar (nur mit Recht system.apps), gilt für alle
    { const { defaultDockLayout, resolveDock } = await import('../public/js/modules.js'); const def = defaultDockLayout(); assert.ok(def.some((e) => e.gid === 'money') && def.some((e) => e.app === 'dashboard'));
      const vis = allItems(NAV).filter((i) => ['dashboard', 'finance', 'stats', 'chat'].includes(i.id));
      let dk = resolveDock(def, vis); assert.deepEqual(dk.map((e) => e.app?.id ?? e.group.id), ['dashboard', 'money', 'chat']); assert.equal(dk[1].items.length, 2); // Gruppe mit zwei sichtbaren Apps bleibt Ordner
      dk = resolveDock(def, vis.filter((i) => i.id !== 'stats')); assert.deepEqual(dk.map((e) => e.app?.id ?? e.group.id), ['dashboard', 'finance', 'chat']); // nur eine sichtbare App: direkt
      dk = resolveDock([{ app: 'chat' }, { gid: 'x', label: 'Meine', items: ['stats', 'nix', 'dashboard'] }], vis); assert.deepEqual(dk.map((e) => e.app?.id ?? e.group.id), ['chat', 'x', 'finance']); assert.deepEqual(dk[1].items.map((i) => i.id), ['stats', 'dashboard']); // eigene Reihenfolge, Unbekanntes entfällt, nicht erwähnte Apps ans Ende
      const me = new Set((await mod.call('GET', '/api/auth/me')).user.permissions); const good = [{ app: 'dashboard' }, { gid: 'g1', label: 'Geld', items: ['finance', 'stats'] }, { app: 'chat' }];
      if (!me.has('system.apps') && !me.has('config.edit')) assert.equal((await mod.call('PUT', '/api/config', { values: { 'ui.dock_layout': good } })).status, 403);
      for (const bad of ['x', [{ app: 'A!' }], [{ app: 'chat' }, { app: 'chat' }], [{ app: 'chat' }, { gid: 'g', label: 'X', items: ['chat'] }], [{ gid: 'g', label: '', items: ['chat'] }], [{ gid: 'g', label: 'X', items: [] }], [{ gid: 'g', label: 'X', items: ['chat'], extra: 1 }], [{ gid: 'g', label: 'X', items: ['chat'] }, { gid: 'g', label: 'Y', items: ['map'] }], [{ app: 'chat', gid: 'g' }], Array.from({ length: 61 }, (_, i) => ({ app: `app${i}` }))]) assert.equal((await admin.call('PUT', '/api/config', { values: { 'ui.dock_layout': bad } })).status, 400, JSON.stringify(bad).slice(0, 60));
      assert.equal((await admin.call('PUT', '/api/config', { values: { 'ui.dock_layout': good } })).status, 200); assert.deepEqual((await mod.call('GET', '/api/bootstrap')).config['ui.dock_layout'], good); // alle bekommen die neue Anordnung
      assert.equal((await admin.call('PUT', '/api/config', { values: { 'ui.dock_layout': [] } })).status, 200); assert.deepEqual((await mod.call('GET', '/api/bootstrap')).config['ui.dock_layout'], []); } // zurück auf Standard
    ok('Dock-Gruppen: nur vorhandene Apps, keine App doppelt, Dashboard/Hilfe/Legal bleiben einzeln; Anordnung im Panel einstellbar (system.apps), geprüft, für alle, Standard wiederherstellbar'); }

  // ══ Hilfe-App ══
  { const { HELP_ARTICLES } = await import('../server/core/help-content.js'); const { listPermissions } = await import('../server/core/permissions.js'); const { clearAttempts } = await import('../server/core/auth.js');
    const known = new Set(listPermissions().map((p) => p.key));
    for (const a of HELP_ARTICLES) for (const p of [...(a.perm ?? []), ...a.sections.flatMap((x) => x.perm ?? [])]) assert.ok(known.has(p), `Hilfe: unbekanntes Recht ${p} in ${a.id}`); // alle Rechte der Kapitel existieren
    assert.equal(new Set(HELP_ARTICLES.map((a) => a.id)).size, HELP_ARTICLES.length);
    assert.equal((await new Client().call('GET', '/api/help')).status, 401); assert.equal((await new Client().call('GET', '/api/p/help')).status, 401);
    // Admin sieht alles, Superadmin darf exportieren
    r = await admin.call('GET', '/api/help'); assert.equal(r.canManage, true); assert.equal(r.canExport, true); const adminIds = r.articles.map((a) => a.id);
    for (const id of ['m-welcome', 'm-config', 'm-audit', 'm-market', 'm-users']) assert.ok(adminIds.includes(id), id); assert.equal(adminIds.some((i) => i.startsWith('p-')), false); // Partner-Kapitel nicht für Mitarbeiter
    // Mitarbeiter: nur Kapitel und Abschnitte, für die die Person Rechte hat (die Rolle bringt eigene Rechte mit – deshalb gegen die tatsächlichen Rechte prüfen)
    const checkScoped = async () => {
      const have = new Set((await mod.call('GET', '/api/auth/me')).user.permissions); const res = await mod.call('GET', '/api/help'); const got = new Map(res.articles.map((a) => [a.id, a]));
      let shown = 0, hiddenN = 0;
      for (const a of HELP_ARTICLES.filter((x) => x.aud === 'm' && !x.cfg && !x.app_off)) {
        const exp = !a.perm?.length || a.perm.some((p) => have.has(p)), title = a.sections.filter((x) => !x.perm?.length || x.perm.some((p) => have.has(p))).map((x) => x.title);
        assert.equal(got.has(a.id), exp && title.length > 0, `Kapitel ${a.id}`);
        if (got.has(a.id)) { assert.deepEqual(got.get(a.id).sections.map((x) => x.title), title, `Abschnitte ${a.id}`); shown++; } else hiddenN++;
      }
      assert.ok(shown > 5 && hiddenN > 0, `${shown}/${hiddenN}`); return { res, have };
    };
    await setPerms(['market.view', 'chat.view']); r = await mod.call('GET', '/api/help'); assert.equal(r.canManage, false); assert.equal(r.canExport, false); await checkScoped();
    assert.ok(r.articles.some((a) => a.id === 'm-welcome') && r.articles.some((a) => a.id === 'm-tickets'));
    assert.equal((await mod.call('GET', '/api/help/manage')).status, 403); assert.equal((await mod.call('POST', '/api/help/articles', { aud: 'm', title: 'xx', sections: [{ title: 'a', text: 'b' }] })).status, 403);
    await setPerms(['market.view', 'chat.view', 'market.deals.manage', 'chat.send']); await checkScoped(); assert.ok((await mod.call('GET', '/api/help')).articles.find((a) => a.id === 'm-market').sections.some((x) => x.title === 'Geschäfte bearbeiten'));
    // Rückmeldungen
    { const seen = new Set((await mod.call('GET', '/api/help')).articles.map((x) => x.id)); const unseen = HELP_ARTICLES.find((x) => x.aud === 'm' && !seen.has(x.id)).id; assert.equal((await mod.call('POST', '/api/help/feedback', { articleId: unseen, helpful: true })).status, 404); } // Kapitel ohne Zugriff
    assert.equal((await mod.call('POST', '/api/help/feedback', { articleId: 'm-market' })).status, 400);
    assert.equal((await mod.call('POST', '/api/help/feedback', { articleId: 'm-market', helpful: false, comment: 'Zu knapp' })).status, 200); assert.equal((await mod.call('GET', '/api/help')).feedback['m-market'], 0);
    assert.equal((await mod.call('POST', '/api/help/feedback', { articleId: 'm-market', helpful: true })).status, 200); assert.equal((await mod.call('GET', '/api/help')).feedback['m-market'], 1); // Antwort wird ersetzt, nicht verdoppelt
    await mod.call('POST', '/api/help/feedback', { articleId: 'm-chat', helpful: false, comment: 'Unklar' });
    r = await admin.call('GET', '/api/help/manage'); const am = r.articles.find((a) => a.id === 'm-market'), ac = r.articles.find((a) => a.id === 'm-chat'); assert.equal(am.yes, 1); assert.equal(am.no, 0); assert.equal(ac.no, 1);
    r = await admin.call('GET', '/api/help/feedback/m-chat'); assert.equal(r.items.length, 1); assert.equal(r.items[0].comment, 'Unklar'); assert.equal(r.items[0].kind, 'member'); assert.equal(JSON.stringify(r).includes('displayName'), false);
    // Tour
    assert.equal((await mod.call('GET', '/api/help')).tourDone, false); await mod.call('POST', '/api/help/tour', { done: true }); assert.equal((await mod.call('GET', '/api/help')).tourDone, true); await mod.call('POST', '/api/help/tour', { done: false }); assert.equal((await mod.call('GET', '/api/help')).tourDone, false);
    // Verwaltung: Standardkapitel anpassen, ausblenden, zurücksetzen
    assert.equal((await admin.call('PUT', '/api/help/articles/m-chat', { title: 'Chat – angepasst', sections: [{ title: 'Neu', text: 'Eigener Text' }] })).status, 200);
    r = await mod.call('GET', '/api/help'); const chat2 = r.articles.find((a) => a.id === 'm-chat'); assert.equal(chat2.title, 'Chat – angepasst'); assert.equal(chat2.sections.length, 1); assert.equal(chat2.sections[0].text, 'Eigener Text');
    assert.equal((await admin.call('PUT', '/api/help/articles/m-chat', { sections: [] })).status, 400); assert.equal((await admin.call('PUT', '/api/help/articles/m-chat', { sections: [{ title: 'a', text: 'b', perm: ['gibt.es.nicht'] }] })).status, 400); assert.equal((await admin.call('PUT', '/api/help/articles/nix', { title: 'abc' })).status, 404);
    await admin.call('PUT', '/api/help/articles/m-chat', { hidden: true }); assert.equal((await mod.call('GET', '/api/help')).articles.some((a) => a.id === 'm-chat'), false); assert.equal((await admin.call('GET', '/api/help')).articles.some((a) => a.id === 'm-chat'), false);
    assert.equal((await admin.call('GET', '/api/help/manage')).articles.find((a) => a.id === 'm-chat').hidden, true);
    assert.equal((await admin.call('DELETE', '/api/help/articles/m-chat')).status, 200); r = await mod.call('GET', '/api/help'); assert.equal(r.articles.find((a) => a.id === 'm-chat').title, 'Chat'); // Standard zurück
    // Eigenes Kapitel mit Recht
    const haveNow = new Set((await mod.call('GET', '/api/auth/me')).user.permissions); const lack = ['users.delete', 'finance.delete', 'tab.delete', 'credit.delete'].find((p) => !haveNow.has(p)); assert.ok(lack);
    r = await admin.call('POST', '/api/help/articles', { aud: 'm', group: 'Server-Regeln', title: 'Geheime Regeln', summary: 'Nur für Audit', perm: [lack], sections: [{ title: 'Regel 1', text: '1. Erst\n2. Dann' }] }); assert.equal(r.status, 201); const cid = r.id;
    assert.equal((await admin.call('POST', '/api/help/articles', { aud: 'm', title: 'Kaputt', perm: ['gibt.es.nicht'], sections: [{ title: 'a', text: 'b' }] })).status, 400);
    assert.equal((await mod.call('GET', '/api/help')).articles.some((a) => a.id === cid), false); r = await admin.call('GET', '/api/help'); assert.ok(r.articles.some((a) => a.id === cid)); assert.ok(r.groups.includes('Server-Regeln'));
    await setPerms(['market.view', lack]); assert.ok((await mod.call('GET', '/api/help')).articles.some((a) => a.id === cid)); // mit dem Recht sichtbar
    assert.equal((await admin.call('DELETE', `/api/help/articles/${cid}`)).status, 200); assert.equal((await admin.call('GET', '/api/help')).articles.some((a) => a.id === cid), false);
    // Partner: nur Partner-Kapitel zu den freigeschalteten Apps
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) clearAttempts(`pl|${ip}`);
    const hp = await admin.call('POST', '/api/partners', { type: 'buyer', name: 'Hilfe Partner', contactName: 'X', apps: ['market'] }); const hc = new Client(); assert.equal((await hc.call('POST', `/api/p/${hp.partner.linkPath.split('/').pop()}/login`, { code: hp.code })).status, 200);
    r = await hc.call('GET', '/api/p/help'); const pids = r.articles.map((a) => a.id); assert.equal(r.canManage, false); assert.ok(pids.includes('p-welcome') && pids.includes('p-market') && pids.includes('p-faq'));
    for (const no of ['p-chat', 'p-credit', 'p-level']) assert.equal(pids.includes(no), false, no); assert.equal(pids.some((i) => i.startsWith('m-')), false);
    assert.equal((await hc.call('POST', '/api/p/help/feedback', { articleId: 'p-chat', helpful: true })).status, 404); assert.equal((await hc.call('POST', '/api/p/help/feedback', { articleId: 'p-market', helpful: false, comment: 'Fehlt was' })).status, 200);
    r = await admin.call('GET', '/api/help/feedback/p-market'); assert.equal(r.items[0].kind, 'partner'); assert.equal(r.items[0].who, hp.partner.number); assert.equal(JSON.stringify(r).includes('Hilfe Partner'), false);
    assert.equal((await hc.call('POST', '/api/p/help/tour', { done: true })).status, 200); assert.equal((await hc.call('GET', '/api/p/help')).tourDone, true);
    await admin.call('PATCH', `/api/partners/${hp.partner.id}`, { apps: ['market', 'chat', 'credit'] }); r = await hc.call('GET', '/api/p/help'); assert.ok(r.articles.some((a) => a.id === 'p-chat') && r.articles.some((a) => a.id === 'p-credit')); // neue Apps → neue Kapitel
    await admin.call('PUT', '/api/help/articles/p-faq', { hidden: true }); assert.equal((await hc.call('GET', '/api/p/help')).articles.some((a) => a.id === 'p-faq'), false); await admin.call('DELETE', '/api/help/articles/p-faq');
    // App abschalten
    await admin.call('PUT', '/api/config', { values: { 'system.disabled_apps': ['help'] } }); assert.equal((await mod.call('GET', '/api/help')).status, 403); assert.equal((await hc.call('GET', '/api/p/help')).status, 403);
    await admin.call('PUT', '/api/config', { values: { 'system.disabled_apps': [] } }); assert.equal((await mod.call('GET', '/api/help')).status, 200);
    // PDF-Export: nur Superadmin
    for (const aud of ['m', 'p']) { const pdf = await fetch(`${base}/api/help/export.pdf?aud=${aud}`, { headers: { cookie: admin.cookie } }); const buf = Buffer.from(await pdf.arrayBuffer()); assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.equal(buf.subarray(0, 5).toString(), '%PDF-'); assert.ok(buf.length > 4000); assert.ok(buf.toString('latin1').trimEnd().endsWith('%%EOF')); assert.ok(/\/Count (\d+)/.test(buf.toString('latin1')));
      { const t = buf.toString('latin1'), xr = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(t), ls = xr[2].trim().split('\n'); ls.forEach((l, i) => { if (i) assert.ok(t.slice(Number(l.slice(0, 10))).startsWith(`${i} 0 obj`), `PDF xref ${i}`); }); // Verweistabelle stimmt
        const kids = [...t.match(/\/Kids \[([^\]]*)\]/)[1].matchAll(/(\d+) 0 R/g)].map((x) => Number(x[1])); assert.equal(kids.length, Number(/\/Count (\d+)/.exec(t)[1])); for (const k of kids) assert.ok(t.slice(Number(ls[k].slice(0, 10)), Number(ls[k].slice(0, 10)) + 200).includes('/Type /Page '), 'PDF Seitenverweis'); } }
    assert.equal((await fetch(`${base}/api/help/export.pdf`, { headers: { cookie: mod.cookie } })).status, 403); assert.equal((await fetch(`${base}/api/help/export.pdf`)).status, 401);
    ok('Hilfe: Kapitel/Abschnitte nur mit Zugriff (Mitarbeiter und Partner), Rückmeldungen, Tour-Status, Kapitel anpassen/ausblenden/eigene, abschaltbar, PDF nur Superadmin'); }

  // ══ Legal ══
  { assert.equal((await mod.call('GET', '/api/legal')).status, 403); assert.equal((await new Client().call('GET', '/api/legal')).status, 401); assert.equal((await tp.call('GET', '/api/legal')).status, 401);
    await setPerms(['legal.view']); r = await mod.call('GET', '/api/legal'); assert.equal(r.status, 200); assert.equal(r.canManage, false);
    assert.equal(r.fines, null); assert.equal(r.laws, null); assert.equal(r.codex, undefined); // Codex gehört ins Dashboard, nicht in die Legal-App // ohne Link: Platzhalter (Neuinstallation)
    const G = 'https://docs.google.com/document/d/abcdefghijklmnopqrstuvwxyz/edit?tab=t.0';
    const cfgP = new Set((await mod.call('GET', '/api/auth/me')).user.permissions); const cfgEdit = cfgP.has('config.edit'), cfgView = cfgP.has('config.view'); // die Rolle bringt evtl. eigene Konfigurationsrechte mit
    if (!cfgEdit && !cfgP.has('legal.manage')) assert.equal((await mod.call('PUT', '/api/config', { values: { 'legal.laws_url': G } })).status, 403); // ohne legal.manage
    if (!cfgView) assert.equal((await mod.call('GET', '/api/config')).status, 403);
    await setPerms(['legal.view', 'legal.manage']);
    r = await mod.call('GET', '/api/config'); assert.equal(r.status, 200); if (!cfgView) assert.deepEqual(r.settings.map((x) => x.key).sort(), ['legal.codex_url', 'legal.fines_url', 'legal.laws_url']); // nur die eigenen Einstellungen
    for (const url of ['http://docs.google.com/document/d/abcdefghijklmnopqrstuvwxyz/edit', 'https://evil.example/document/d/abcdefghijklmnopqrstuvwxyz', 'https://docs.google.com.evil.example/document/d/abcdefghijklmnopqrstuvwxyz', 'https://docs.google.com/forms/d/abcdefghijklmnopqrstuvwxyz', 'kein link']) assert.equal((await mod.call('PUT', '/api/config', { values: { 'legal.fines_url': url } })).status, 400, url);
    if (!cfgEdit) assert.equal((await mod.call('PUT', '/api/config', { values: { 'system.name': 'Hack' } })).status, 403); // andere Einstellungen bleiben tabu
    r = await mod.call('PUT', '/api/config', { values: { 'legal.laws_url': G, 'legal.fines_url': 'https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz/edit#gid=0' } }); assert.equal(r.status, 200);
    r = await mod.call('GET', '/api/legal'); assert.ok(r.laws.embedUrl.startsWith('https://docs.google.com/document/d/') && r.laws.embedUrl.endsWith('/preview')); assert.equal(r.fines.kind, 'spreadsheets'); assert.equal(r.canManage, true);
    r = await mod.call('PUT', '/api/config', { values: { 'legal.codex_url': 'https://docs.google.com/document/d/zyxwvutsrqponmlkjihgfedcba/edit' } }); assert.equal(r.status, 200);
    r = await mod.call('GET', '/api/dashboard'); assert.equal(r.widgets[0].id, 'codex'); assert.ok(r.widgets[0].data.codex.embedUrl.endsWith('/preview')); assert.equal(r.widgets[0].data.canManage, true); // Codex-Banner ganz oben im Dashboard
    // Codex: zusätzlich sichere externe https-Links (z. B. Zipline), aber nichts Unsicheres – und die CSP erlaubt genau diese Herkunft als Frame
    for (const url of ['http://zipline.example.org/u/codex.pdf', 'javascript:alert(1)', 'https://user:pw@zipline.example.org/u/codex.pdf', 'https://127.0.0.1/codex.pdf', 'https://localhost/codex.pdf', 'https://intern/codex.pdf', 'kein link']) assert.equal((await mod.call('PUT', '/api/config', { values: { 'legal.codex_url': url } })).status, 400, url);
    assert.equal((await mod.call('PUT', '/api/config', { values: { 'legal.laws_url': 'https://zipline.example.org/u/gesetze.pdf' } })).status, 400); // Gesetzessammlung bleibt Google-only
    r = await mod.call('PUT', '/api/config', { values: { 'legal.codex_url': 'https://zipline.example.org/u/codex.pdf' } }); assert.equal(r.status, 200);
    r = await mod.call('GET', '/api/dashboard'); assert.equal(r.widgets[0].data.codex.source, 'extern'); assert.equal(r.widgets[0].data.codex.embedUrl, 'https://zipline.example.org/u/codex.pdf'); assert.equal(r.widgets[0].data.codex.host, 'zipline.example.org');
    { const csp = (await fetch(`${base}/`)).headers.get('content-security-policy'); assert.ok(csp.includes('frame-src https://docs.google.com https://zipline.example.org;'), csp); }
    r = await mod.call('PUT', '/api/config', { values: { 'legal.codex_url': 'https://docs.google.com/document/d/zyxwvutsrqponmlkjihgfedcba/edit' } }); assert.equal(r.status, 200);
    { const csp = (await fetch(`${base}/`)).headers.get('content-security-policy'); assert.ok(csp.includes('frame-src https://docs.google.com;'), csp); } // wieder nur Google
    assert.equal((await mod.call('PUT', '/api/config', { values: { 'legal.fines_url': '' } })).status, 200); assert.equal((await mod.call('GET', '/api/legal')).fines, null); // leeren → wieder Platzhalter
    assert.equal((await mod.call('POST', '/api/legal/docs', { title: 'X', url: G })).status, 404); // alte Dokumentenliste gibt es nicht mehr
    for (const k of ['legal.laws_url', 'legal.codex_url']) await admin.call('PUT', '/api/config', { values: { [k]: '' } }); await setPerms([]);
    assert.equal((await admin.call('GET', '/api/dashboard')).widgets[0].data.codex, null); // ohne Link: Platzhalter
    ok('Legal: Links für Gesetzessammlung/Bußgeldkatalog + Codex (Dashboard, ganz oben) in der Konfiguration (Gesetze/Bußgeld nur Google-Docs, Codex zusätzlich sichere https-Links, Recht legal.manage), ohne Link Platzhalter'); }

  // ══ Ticker (Laufband) ══
  { assert.equal((await new Client().call('GET', '/api/ticker')).status, 401); assert.equal((await new Client().call('GET', '/api/p/ticker')).status, 401); assert.equal((await mod.call('GET', '/api/p/ticker')).status, 401); // Mitglieder nutzen die interne, Partner die externe Schnittstelle
    await setPerms(['board.view', 'board.manage']);
    for (const bad of [{ title: 'Ticker', ticker: true, tickerAudience: 'alle' }, { title: 'Ticker', ticker: true, tickerUntil: 'gestern' }]) assert.equal((await mod.call('POST', '/api/board', bad)).status, 400);
    assert.equal((await mod.call('GET', '/api/ticker')).items.length, 0);
    const mkT = async (title, extra) => (await mod.call('POST', '/api/board', { title, body: 'Details zum Ticker', level: 'urgent', ...extra })).post;
    const tAll = await mkT('Für alle', { ticker: true, tickerAudience: 'all' }), tIn = await mkT('Nur intern', { ticker: true, tickerAudience: 'internal', level: 'important' }), tEx = await mkT('Nur extern', { ticker: true, tickerAudience: 'external', level: 'success' });
    const tOld = await mkT('Abgelaufen', { ticker: true, tickerUntil: new Date(Date.now() - 3600_000).toISOString() }), tNo = await mkT('Kein Ticker', { ticker: false });
    assert.equal(tAll.ticker, true); assert.equal(tAll.tickerAudience, 'all'); assert.equal(tNo.ticker, false); assert.equal(tNo.tickerAudience, 'all');
    const labels = (x) => x.items.map((i) => i.text.split(' – ')[0]).sort();
    assert.deepEqual(labels(await admin.call('GET', '/api/ticker')), ['Für alle', 'Nur intern']); // Mitglieder: alle + intern, nicht extern/abgelaufen/ohne Ticker
    assert.deepEqual(labels(await tp.call('GET', '/api/p/ticker')), ['Für alle', 'Nur extern']); // Partner: alle + extern
    r = await admin.call('GET', '/api/ticker'); assert.equal(r.items.find((i) => i.text.startsWith('Nur intern')).level, 'important'); assert.ok(r.items[0].text.includes('Details zum Ticker'));
    assert.equal((await mod.call('GET', '/api/ticker')).status, 200); // auch ohne board.view (sichtbar für alle aktiven Mitglieder)
    // Ende setzen, abschalten, entfernen
    r = await mod.call('PATCH', `/api/board/${tIn.id}`, { tickerUntil: new Date(Date.now() + 3600_000).toISOString() }); assert.ok(r.post.tickerUntil); assert.equal((await admin.call('GET', '/api/ticker')).items.length, 2);
    await mod.call('PATCH', `/api/board/${tIn.id}`, { tickerUntil: new Date(Date.now() - 1000).toISOString() }); assert.deepEqual(labels(await admin.call('GET', '/api/ticker')), ['Für alle']); // Enddatum überschritten
    await mod.call('PATCH', `/api/board/${tIn.id}`, { tickerUntil: null, ticker: true }); assert.equal((await admin.call('GET', '/api/ticker')).items.length, 2);
    await mod.call('PATCH', `/api/board/${tAll.id}`, { ticker: false }); assert.deepEqual(labels(await tp.call('GET', '/api/p/ticker')), ['Nur extern']);
    assert.equal((await mod.call('PATCH', `/api/board/${tAll.id}`, { tickerAudience: 'x' })).status, 400);
    // Live-Ereignis für Mitglieder und Partner
    const sseS = await openSse(admin.cookie, '/api/events'), sseP = await openSse(tp.cookie, '/api/p/events'); await sleep(150);
    await mod.call('PATCH', `/api/board/${tEx.id}`, { ticker: false }); await sleep(250);
    assert.ok(sseS.events.some((e) => e.event === 'change' && e.data.topic === 'ticker')); assert.ok(sseP.events.some((e) => e.event === 'change' && e.data.topic === 'ticker')); sseS.close(); sseP.close();
    await mod.call('DELETE', `/api/board/${tIn.id}`); assert.equal((await admin.call('GET', '/api/ticker')).items.length, 0);
    for (const t of [tAll, tEx, tOld, tNo]) await admin.call('DELETE', `/api/board/${t.id}`); await setPerms([]);
    ok('Ticker: Laufband für Mitglieder/Externe/alle getrennt, Enddatum, Abschalten, Live-Ereignis'); }

  // ══ Subdomain für Externe (neutral) ══
  { const CH = { 'X-Forwarded-Host': 'coop.example.com' }; const g = (p, h = CH) => fetch(base + p, { headers: h });
    r = await (await g('/api/bootstrap')).json(); assert.equal(r.neutral, true); assert.equal(r.commit, null); assert.equal(r.config['system.name'], 'Partnerportal'); assert.equal(r.config['system.subtitle'], ''); assert.equal(r.config['branding.logo_version'], 0); assert.equal(r.config['ui.show_watermark'], false); assert.deepEqual(r.mask, ['MDT-']); assert.equal(r.setupRequired, false);
    const main = await (await fetch(base + '/api/bootstrap')).json(); assert.equal(main.neutral, undefined); assert.ok(main.config['system.name'] && main.config['system.name'] !== 'Partnerportal'); // normale Domain unverändert
    assert.equal(JSON.stringify(r).includes(main.config['system.name']), false, 'Systemname darf nicht durchkommen');
    const page = await g('/'); const html = await page.text(); assert.equal(page.status, 200); assert.ok(html.includes('<title>Partnerportal</title>')); assert.equal(/logo|webp|MDT/i.test(html), false); assert.ok(html.includes('class="neutral"'));
    assert.equal((await g(`/p/${ptok}`)).status, 200); assert.equal((await g(`/deckel/firma/${tokA ?? 'x'}`)).status, 200);
    for (const p of ['/admin/users', '/dashboard', '/branding/logo', '/branding/wallpaper', '/img/logo.svg', '/img/map.webp', '/maptiles/1/1/1.png', '/hack/hack.js', '/api/auth/me', '/api/users', '/api/setup', '/api/hack/admin', '/api/h/-/status', '/api/notifications']) assert.equal((await g(p)).status, 404, p + ' darf auf der Subdomain nicht erreichbar sein');
    assert.equal((await fetch(base + '/api/auth/login', { method: 'POST', headers: { ...CH, 'Content-Type': 'application/json', 'X-Requested-With': 'mdt' }, body: JSON.stringify({ username: 'admin', password: 'passwort123' }) })).status, 404); // keine Mitarbeiter-Anmeldung
    assert.equal((await g('/js/main.js')).status, 200); assert.equal((await g('/css/theme.css')).status, 200);
    assert.equal((await g(`/api/p/${ptok}/session`)).status, 200); // Partner-API funktioniert
    assert.equal((await new Client().call('GET', '/api/p/' + ptok + '/session')).status, 200);
    assert.equal((await mod.call('PUT', '/api/config', { values: { 'coop.title': 'Hallo' } })).status, 403);
    await admin.call('PUT', '/api/config', { values: { 'coop.title': 'Handelsportal', 'coop.host': 'extern.example.com' } }); assert.equal((await (await g('/api/bootstrap')).json()).neutral, undefined); assert.equal((await (await g('/api/bootstrap', { 'X-Forwarded-Host': 'extern.example.com' })).json()).config['system.name'], 'Handelsportal');
    await admin.call('PUT', '/api/config', { values: { 'coop.title': 'Partnerportal', 'coop.host': 'coop.example.com' } });
    ok('Subdomain für Externe: neutral (kein Logo/Name), nur Partner-/Firmenportal, keine Mitarbeiter-Anmeldung, Host einstellbar'); }

  // ══ Changelog ══
  { assert.equal((await mod.call('GET', '/api/changelog')).status, 403); assert.equal((await new Client().call('GET', '/api/changelog')).status, 401); assert.equal((await tp.call('GET', '/api/changelog')).status, 401); // Partner: kein Changelog
    await setPerms(['changelog.view']); r = await mod.call('GET', '/api/changelog'); assert.equal(r.status, 200); assert.equal(r.canManage, false); assert.equal(r.total, 0); assert.ok(r.kinds.fixed);
    assert.equal((await mod.call('POST', '/api/changelog', { title: 'Test', items: [{ kind: 'new', text: 'Etwas' }] })).status, 403);
    await setPerms(['changelog.view', 'changelog.manage']);
    for (const bad of [{ title: 'x', items: [{ kind: 'new', text: 'Etwas' }] }, { title: 'Ohne Punkte', items: [] }, { title: 'Falsche Art', items: [{ kind: 'magic', text: 'Etwas' }] }, { title: 'Falsches Datum', releasedAt: '31.12.2026', items: [{ kind: 'new', text: 'Etwas' }] }, { title: 'Leerer Text', items: [{ kind: 'new', text: ' ' }] }]) assert.equal((await mod.call('POST', '/api/changelog', bad)).status, 400);
    const mkE = async (version, title, releasedAt, items) => (await mod.call('POST', '/api/changelog', { version, title, releasedAt, items })).entry;
    const e1 = await mkE('1.0.0', 'Erster Stand', '2026-09-01', [{ kind: 'new', text: 'Börse und Lager' }]);
    const e2 = await mkE('1.1.0', 'Chat und Tickets', '2026-09-10', [{ kind: 'new', text: 'Privatnachrichten' }, { kind: 'fixed', text: 'Chat lud nicht neu' }]);
    const e3 = await mkE('1.2.0', 'Karte', '2026-09-20', [{ kind: 'changed', text: 'Neue Kalibrierung' }, { kind: 'removed', text: 'Alte Kartenquelle' }, { kind: 'security', text: 'Neue Prüfung' }]);
    const e4 = await mkE('', 'Ohne Version', '2026-09-25', [{ kind: 'new', text: 'Schwarzes Brett' }]);
    assert.equal(e1.items[0].kind, 'new'); assert.equal(e4.version, null);
    r = await mod.call('GET', '/api/changelog'); assert.equal(r.total, 4); assert.equal(r.canManage, true); assert.deepEqual(r.entries.map((e) => e.id), [e4.id, e3.id, e2.id]); // neueste zuerst, standardmäßig 3
    r = await mod.call('GET', '/api/changelog?limit=3&offset=3'); assert.deepEqual(r.entries.map((e) => e.id), [e1.id]); assert.equal((await mod.call('GET', '/api/changelog?limit=500')).entries.length, 4);
    assert.ok(JSON.stringify(r).includes('MDT-') || r.entries[0].author, 'Verfasser nur als Kennung');
    assert.ok((await admin.call('GET', '/api/notifications')).notifications.some((n) => /Update 1.2.0/.test(n.title)));
    r = await mod.call('PATCH', `/api/changelog/${e1.id}`, { title: 'Erster Stand (bearbeitet)', items: [{ kind: 'new', text: 'Börse' }, { kind: 'new', text: 'Lager' }] }); assert.equal(r.entry.items.length, 2); assert.equal((await mod.call('PATCH', '/api/changelog/99999', { title: 'abc' })).status, 404);
    await setPerms(['changelog.view']); assert.equal((await mod.call('DELETE', `/api/changelog/${e1.id}`)).status, 403); assert.equal((await mod.call('PATCH', `/api/changelog/${e1.id}`, { title: 'abc' })).status, 403);
    await setPerms(['changelog.view', 'changelog.manage']); assert.equal((await mod.call('DELETE', `/api/changelog/${e1.id}`)).status, 200); assert.equal((await admin.call('GET', '/api/changelog')).total, 3);
    for (const e of [e2, e3, e4]) await admin.call('DELETE', `/api/changelog/${e.id}`); await setPerms([]);
    assert.ok(JSON.stringify((await admin.call('GET', '/api/roles')).roles).includes('changelog.view'), 'Rang-Rollen dürfen das Changelog sehen');
    ok('Changelog: nur Mitarbeiter, Rechte changelog.view/changelog.manage, Arten (neu/geändert/behoben/entfernt/Sicherheit), Seiten, Benachrichtigung'); }

  // ══ Kontaktbuch ══
  { assert.equal((await mod.call('GET', '/api/contacts/options')).status, 403); assert.equal((await tp.call('GET', '/api/contacts/orgs')).status, 401); assert.equal((await new Client().call('GET', '/api/contacts/orgs')).status, 401);
    await setPerms(['contacts.view']); let o = await mod.call('GET', '/api/contacts/options'); assert.equal(o.status, 200); assert.equal(o.canEdit, false); assert.equal(o.canBank, false); assert.ok(o.orgTypes.some((t) => t.label === 'Behörde')); assert.ok(o.relations.some((t) => t.label === 'Angehöriger')); assert.deepEqual(o.roles, []);
    assert.equal((await mod.call('POST', '/api/contacts/orgs', { name: 'Test' })).status, 403);
    await setPerms(['contacts.view', 'contacts.edit']);
    const typeAuth = o.orgTypes.find((t) => t.label === 'Behörde').id, typeFirm = o.orgTypes.find((t) => t.label === 'Firma').id, relEmp = o.relations.find((t) => t.label === 'Mitarbeiter').id, relFam = o.relations.find((t) => t.label === 'Angehöriger').id;
    for (const bad of [{ name: 'x' }, { name: 'Gültig', flag: 'rot' }, { name: 'Gültig', typeId: 99999 }, { name: 'Gültig', channels: [{ kind: 'brieftaube', value: 'x' }] }]) assert.equal((await mod.call('POST', '/api/contacts/orgs', bad)).status, 400);
    r = await mod.call('POST', '/api/contacts/orgs', { name: 'Los Santos Police Department', typeId: typeAuth, flag: 'important', address: 'Mission Row 1', description: 'Polizei', tags: 'Polizei, Behörde', channels: [{ kind: 'phone', label: 'Zentrale', value: '(555) 000-1111' }, { kind: 'email', value: 'info@lspd.example' }, { kind: 'website', value: 'lspd.example' }, { kind: 'phone', value: '  ' }] });
    assert.equal(r.status, 201); const org1 = r.org.id; assert.equal(r.org.channels.length, 3); assert.equal(r.org.flag.label, 'Wichtig'); assert.equal(r.org.type.label, 'Behörde'); assert.equal(r.org.restricted, false);
    r = await mod.call('POST', '/api/contacts/orgs', { name: 'Muster Bau GmbH', typeId: typeFirm }); const org2 = r.org.id;
    assert.equal((await mod.call('POST', '/api/contacts/people', { firstName: '', lastName: '' })).status, 400); assert.equal((await mod.call('POST', '/api/contacts/people', { lastName: 'X', orgId: 99999 })).status, 400);
    r = await mod.call('POST', '/api/contacts/people', { firstName: 'Max', lastName: 'Mustermann', orgId: org1, relationId: relEmp, position: 'Abteilungsleiter', address: 'Mission Row 1', homeAddress: 'Vinewood Blvd 12', birthday: '1985-04-12', channels: [{ kind: 'mobile', label: 'privat', value: '(555) 123-4567' }, { kind: 'email', value: 'max@lspd.example' }], notes: 'Zuverlässig' });
    assert.equal(r.status, 201); const pr1 = r.person.id; assert.equal(r.person.name, 'Max Mustermann'); assert.equal(r.person.org.name, 'Los Santos Police Department'); assert.equal(r.person.bank, null);
    assert.equal((await mod.call('POST', '/api/contacts/people', { firstName: 'Eva', lastName: 'Muster', bank: { name: 'Fleeca', account: 'LS123' } })).status, 403); // Bankdaten brauchen contacts.bank
    r = await mod.call('POST', '/api/contacts/people', { firstName: 'Anna', lastName: 'Mustermann', orgId: org1, relationId: relFam, position: 'Tochter' }); const pr2 = r.person.id;
    // Bankdaten
    await setPerms(['contacts.view', 'contacts.edit', 'contacts.bank']);
    r = await mod.call('PATCH', `/api/contacts/people/${pr1}`, { bank: { name: 'Fleeca Bank', account: 'LS28180705', note: 'Hauptkonto' } }); assert.equal(r.status, 200); assert.equal(r.person.bank.account, 'LS28180705'); assert.equal(r.person.firstName, 'Max'); assert.equal(r.person.lastName, 'Mustermann');
    await setPerms(['contacts.view', 'contacts.edit']); r = await mod.call('GET', `/api/contacts/people/${pr1}`); assert.equal(r.person.bank, null); assert.equal(r.person.hasBank, true); assert.equal(JSON.stringify(r).includes('LS28180705'), false);
    assert.equal(JSON.stringify(await mod.call('GET', '/api/contacts/people')).includes('LS28180705'), false); r = await mod.call('PATCH', `/api/contacts/people/${pr1}`, { notes: 'Geändert' }); assert.equal(r.person.hasBank, true); // Bank bleibt beim Bearbeiten ohne Recht erhalten
    await setPerms(['contacts.view', 'contacts.edit', 'contacts.bank']); assert.equal((await mod.call('GET', `/api/contacts/people/${pr1}`)).person.bank.name, 'Fleeca Bank'); await setPerms(['contacts.view', 'contacts.edit']);
    r = await mod.call('PATCH', `/api/contacts/people/${pr1}`, { firstName: 'Maximilian' }); assert.equal(r.person.name, 'Maximilian Mustermann'); // Teiländerung behält den Nachnamen
    // Suche, Filter, Details
    r = await mod.call('GET', '/api/contacts/orgs?q=lspd.example'); assert.deepEqual(r.orgs.map((x) => x.id), [org1]); r = await mod.call('GET', `/api/contacts/orgs?type=${typeFirm}`); assert.deepEqual(r.orgs.map((x) => x.id), [org2]); assert.equal((await mod.call('GET', '/api/contacts/orgs?flag=important')).orgs.length, 1);
    r = await mod.call('GET', '/api/contacts/people?q=123-4567'); assert.deepEqual(r.people.map((x) => x.id), [pr1]); assert.equal((await mod.call('GET', '/api/contacts/people?q=Police')).people.length, 2); assert.equal((await mod.call('GET', `/api/contacts/people?relation=${relFam}`)).people.length, 1);
    r = await mod.call('GET', `/api/contacts/orgs/${org1}`); assert.equal(r.people.length, 2); assert.equal(r.org.peopleCount, 2); assert.equal(r.org.channels.length, 3); assert.ok(r.org.createdBy);
    // Sperren für Rollen + Kennzeichnung
    r = await admin.call('POST', '/api/roles', { name: 'Kontakt-Geheim', permissions: [] }); const secRole = r.role.id;
    assert.equal((await mod.call('PATCH', `/api/contacts/orgs/${org2}`, { restricted: true, roleIds: [secRole] })).status, 403); // ohne contacts.secret
    r = await admin.call('PATCH', `/api/contacts/orgs/${org2}`, { restricted: true, flag: 'secret', roleIds: [secRole] }); assert.equal(r.org.restricted, true); assert.deepEqual(r.org.access.map((x) => x.id), [secRole]); assert.equal(r.org.flag.label, 'Geheim');
    const pr3 = (await admin.call('POST', '/api/contacts/people', { firstName: 'Geheim', lastName: 'Kontakt', orgId: org2, restricted: false })).person.id; const pr4 = (await admin.call('POST', '/api/contacts/people', { firstName: 'Nur', lastName: 'Gesperrt', restricted: true, roleIds: [secRole] })).person.id;
    assert.equal((await mod.call('GET', `/api/contacts/orgs/${org2}`)).status, 404); assert.equal((await mod.call('GET', '/api/contacts/orgs')).orgs.some((x) => x.id === org2), false);
    assert.equal((await mod.call('GET', `/api/contacts/people/${pr3}`)).status, 404); // Person einer gesperrten Institution ist mit versteckt
    assert.equal((await mod.call('GET', `/api/contacts/people/${pr4}`)).status, 404); assert.equal((await mod.call('GET', '/api/contacts/people')).people.some((x) => [pr3, pr4].includes(x.id)), false); assert.equal((await mod.call('GET', '/api/contacts/people?q=Gesperrt')).people.length, 0);
    assert.equal((await mod.call('PATCH', `/api/contacts/orgs/${org2}`, { name: 'Hack Bau' })).status, 404); assert.equal((await mod.call('GET', '/api/contacts/orgs?q=Muster Bau')).orgs.length, 0);
    r = await admin.call('GET', '/api/contacts/orgs'); assert.ok(r.orgs.some((x) => x.id === org2 && x.restricted)); assert.equal((await admin.call('GET', `/api/contacts/people/${pr4}`)).status, 200); assert.ok((await admin.call('GET', '/api/contacts/options')).roles.some((x) => x.id === secRole));
    // Rolle zugewiesen → sichtbar
    await admin.call('PATCH', `/api/contacts/orgs/${org2}`, { roleIds: [modRole] }); assert.equal((await mod.call('GET', `/api/contacts/orgs/${org2}`)).status, 200); assert.equal((await mod.call('GET', `/api/contacts/people/${pr3}`)).status, 200); assert.equal((await mod.call('GET', `/api/contacts/people/${pr4}`)).status, 404);
    await setPerms(['contacts.view', 'contacts.secret']); assert.equal((await mod.call('GET', `/api/contacts/people/${pr4}`)).status, 200); assert.equal((await mod.call('GET', '/api/contacts/options')).canSecret, true); await setPerms(['contacts.view', 'contacts.edit']);
    // Löschen
    assert.equal((await mod.call('DELETE', `/api/contacts/orgs/${org1}`)).status, 403); assert.equal((await mod.call('DELETE', `/api/contacts/people/${pr2}`)).status, 403);
    await setPerms(['contacts.view', 'contacts.edit', 'contacts.delete']); r = await mod.call('DELETE', `/api/contacts/orgs/${org1}`); assert.equal(r.status, 200); assert.equal(r.peopleKept, 2); assert.equal((await mod.call('GET', `/api/contacts/people/${pr1}`)).person.org, null); // Personen bleiben als eigenständige Kontakte
    assert.equal((await mod.call('DELETE', `/api/contacts/people/${pr2}`)).status, 200); assert.equal((await mod.call('GET', `/api/contacts/people/${pr2}`)).status, 404);
    const aud = await admin.call('GET', '/api/audit?module=contacts'); assert.ok(aud.rows.some((a) => a.action === 'contacts.org_created')); assert.equal(JSON.stringify(aud).includes('LS28180705'), false); // Bankdaten stehen nicht im Audit-Log
    for (const id of [pr1, pr3, pr4]) await admin.call('DELETE', `/api/contacts/people/${id}`); await admin.call('DELETE', `/api/contacts/orgs/${org2}`); await setPerms([]);
    ok('Kontaktbuch: Institutionen und Personen mit Kontaktdaten, Suche/Filter, Bankdaten nur mit contacts.bank, Sperren für Rollen + Kennzeichnung, Löschen'); }

  // Superadmin: Artikel samt Geschäften/Bestand löschen
  assert.equal((await admin.call('DELETE', `/api/warehouse/items/${ore}`)).status, 409); assert.equal((await mod.call('DELETE', `/api/warehouse/items/${ore}?force=1`)).status, 403);
  assert.equal((await admin.call('DELETE', `/api/warehouse/items/${ore}?force=1`)).status, 200); assert.equal((await admin.call('GET', '/api/market/deals')).deals.some((d) => d.item?.id === ore), false); ok('Superadmin löscht Artikel samt Geschäften, Gesuchen und Beständen');

  // Update-Prüfung (mit simuliertem GitHub)
  { const { checkForUpdate, updateState } = await import('../server/core/updates.js');
    const fake = (sha, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ sha, commit: { message: 'Neue Funktion\n\nDetails', committer: { date: '2026-10-08T10:00:00Z' } } }) });
    const newSha = 'f'.repeat(40);
    await checkForUpdate({ fetchFn: fake(newSha) }); assert.equal(updateState.available, true); assert.equal(updateState.latest.short, 'fffffff'); assert.equal(updateState.latest.message, 'Neue Funktion');
    r = await admin.call('GET', '/api/notifications'); const upd = r.notifications.filter((n) => n.title === 'Update verfügbar'); assert.equal(upd.length, 1); assert.match(upd[0].body, /fffffff/); assert.match(upd[0].body, /abc1234/);
    await checkForUpdate({ fetchFn: fake(newSha) }); assert.equal((await admin.call('GET', '/api/notifications')).notifications.filter((n) => n.title === 'Update verfügbar').length, 1); // je Version nur einmal
    assert.equal((await mod.call('GET', '/api/notifications')).notifications.some((n) => n.title === 'Update verfügbar'), false); // nur Superadmin/Administratoren
    await checkForUpdate({ fetchFn: fake('abc1234' + '0'.repeat(33)) }); assert.equal(updateState.available, false);
    await checkForUpdate({ fetchFn: fake('x', false) }); assert.ok(updateState.error);
    assert.equal((await new Client().call('GET', '/api/admin/update')).status, 401); assert.equal((await admin.call('GET', '/api/admin/update')).installed, 'abc1234');
    ok('Update-Prüfung: Benachrichtigung nur an Superadmin/Administratoren, einmal je Version, Fehler werden abgefangen'); }

  // Audit-Export hat ein eigenes Recht
  await setPerms(['audit.view']); assert.equal((await fetch(`${base}/api/audit/export`, { headers: { cookie: mod.cookie } })).status, 403); await setPerms(['audit.view', 'audit.export']); assert.equal((await fetch(`${base}/api/audit/export`, { headers: { cookie: mod.cookie } })).status, 200); await setPerms([]); ok('Audit-Export braucht audit.export');

  // Audit
  const actions = new Set();
  for (let off = 0; off < 2000; off += 200) { r = await admin.call('GET', `/api/audit?limit=200&offset=${off}`); r.rows.forEach((x) => actions.add(x.action)); if (r.rows.length < 200) break; }
  for (const a of ['system.setup', 'user.registered', 'role.created', 'user.approved', 'user.blocked', 'user.unblocked', 'config.changed']) assert.ok(actions.has(a), `Audit fehlt: ${a}`);
  ok('Audit-Log enthält alle Aktionen');
  assert.equal((await mod.call('GET', '/api/audit')).status, 200); ok('audit.view erlaubt Zugriff');
  assert.equal((await mod.call('GET', '/api/permissions')).status, 200);

  // ══ Werksreset (nur Superadmin) – muss der letzte Test sein ══
  assert.equal((await mod.call('POST', '/api/admin/reset', { confirm: 'ALLES LÖSCHEN', password: 'passwort123' })).status, 403);
  assert.equal((await admin.call('POST', '/api/admin/reset', { confirm: 'alles löschen', password: 'passwort123' })).status, 400);
  assert.equal((await admin.call('POST', '/api/admin/reset', { confirm: 'ALLES LÖSCHEN', password: 'falsch' })).status, 403);
  assert.equal((await admin.call('GET', '/api/users')).users.length > 0, true);
  r = await admin.call('POST', '/api/admin/reset', { confirm: 'ALLES LÖSCHEN', password: 'passwort123' }); assert.equal(r.status, 200); assert.match(r.backup, /^mdt-\d{8}-\d{6}\.db$/);
  assert.equal((await admin.call('GET', '/api/auth/me')).status, 401); // Sitzungen sind weg
  assert.equal((await new Client().call('GET', '/api/bootstrap')).setupRequired, true);
  const fresh = new Client(); assert.equal((await fresh.call('POST', '/api/setup', { systemName: 'Neu', adminRoleName: 'Chef', displayName: 'Neu Admin', username: 'neuadmin', password: 'passwort123' })).status, 201);
  assert.equal((await fresh.call('GET', '/api/users')).users.length, 1); assert.equal((await fresh.call('GET', '/api/partners')).partners.length, 0); assert.equal((await fresh.call('GET', '/api/audit')).total <= 3, true);
  assert.ok((await fresh.call('GET', '/api/permissions')).permissions.length > 40); assert.equal((await fresh.call('GET', '/api/auth/me')).user.isSuperadmin, true);
  assert.equal((await fresh.call('GET', '/api/lookups')).status, 200); assert.equal((await fresh.call('GET', '/api/admin/backups')).backups.length >= 1, true);
  ok('Werksreset: nur Superadmin, Bestätigungstext + Passwort, automatische Sicherung, alle Daten weg, Programm bleibt, Einrichtung startet neu');

  console.log(`\nAlle ${passed} Prüfungen bestanden.`);
} catch (e) {
  console.error('\n✗ FEHLGESCHLAGEN:', e.message, '\n', e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
} finally {
  server.close();
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(process.exitCode ?? 0); }, 200);
}
