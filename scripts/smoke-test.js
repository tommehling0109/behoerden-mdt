// API-Smoketest Behörden-MDT: Setup, Freischaltung, Rollen/Rechte, Behörden/Ränge, Klarnamen + Dienstnummern. Nutzt eine temporäre DB.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

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


  // ══ Behörden-MDT: Behörden, Ränge, Rollen ══
  const org = await admin.call('GET', '/api/org');
  assert.equal(org.departments.length, 7); assert.ok(['Los Santos Police Department', "Blaine County Sheriff's Office", 'San Andreas Highway Patrol (State Troopers)', 'Federal Investigation Bureau', 'Department of Justice'].every((n) => org.departments.some((d) => d.name === n)));
  assert.ok(org.ranks.some((x) => x.name === 'Sheriff (BCSO)') && org.ranks.some((x) => x.name === 'Director (FIB)') && org.ranks.some((x) => x.name === 'Chief of Police (LSPD)'));
  const lspdChief = org.ranks.find((x) => x.name === 'Chief of Police (LSPD)'), lspdOfficer = org.ranks.find((x) => x.name === 'Police Officer I (LSPD)');
  assert.equal(lspdOfficer.departmentId, org.departments.find((d) => d.name === 'Los Santos Police Department').id); assert.equal(lspdChief.parentRankId, null);
  ok('7 Behörden (LSPD, BCSO, SAHP, SAPR, FIB, DOJ, SAFR) mit eigenen, verketteten Rängen');
  const roleNames = (await admin.call('GET', '/api/roles')).roles.map((x) => x.name);
  for (const n of ['Administrator', 'Beamter', 'Dienstgruppenleiter', 'Dienststellenleitung', 'Behördenleitung', 'Personalabteilung']) assert.ok(roleNames.includes(n), n);
  ok('Rollen nach Verantwortung (Beamter … Behördenleitung, Personalabteilung)');

  // ══ Klarnamen + Dienstnummer ══
  const pf = new Client(), pf2 = new Client();
  const hr = (await admin.call('GET', '/api/roles')).roles.find((x) => x.name === 'Personalabteilung'), officerRole = (await admin.call('GET', '/api/roles')).roles.find((x) => x.name === 'Beamter');
  r = await admin.call('POST', '/api/users', { displayName: 'Erika Beispiel', username: 'erika', password: 'passwort123', rankId: lspdOfficer.id, departmentId: lspdOfficer.departmentId, roleIds: [officerRole.id] });
  assert.equal(r.status, 201); const erika = r.user; assert.equal(erika.memberNumber, '1002'); assert.equal(erika.displayName, 'Erika Beispiel'); // 1000 = Superadmin, 1001 = Neuer
  r = await admin.call('POST', '/api/users', { displayName: 'Hans Personal', username: 'hans', password: 'passwort123', roleIds: [hr.id], departmentId: lspdOfficer.departmentId });
  assert.equal(r.status, 201); const hans = r.user; ok('Neue Mitglieder erhalten automatisch fortlaufende Dienstnummern (ab 1000)');
  assert.equal((await pf.call('POST', '/api/auth/login', { username: 'erika', password: 'passwort123' })).status, 200);
  assert.equal((await pf2.call('POST', '/api/auth/login', { username: 'hans', password: 'passwort123' })).status, 200);
  r = await pf2.call('GET', '/api/users'); assert.equal(r.status, 200);
  const seenErika = r.users.find((u) => u.id === erika.id); assert.equal(seenErika.displayName, 'Erika Beispiel'); assert.equal(seenErika.nameVisible, true); assert.equal(seenErika.username, 'erika');
  assert.ok(r.users.every((u) => u.displayName && !/^Mitglied #/.test(u.displayName))); ok('Benutzerliste zeigt Klarnamen für alle (keine Anonymisierung)');
  assert.equal((await pf2.call('GET', '/api/users?q=Beispiel')).users.length, 1); assert.equal((await pf2.call('GET', '/api/users?q=1002')).users[0].id, erika.id); ok('Suche nach Name und Dienstnummer');
  assert.equal((await pf2.call('PATCH', `/api/users/${erika.id}`, { memberNumber: 'LSPD-4711' })).user.memberNumber, 'LSPD-4711'); ok('Recht „Dienstnummern vergeben“: Dienstnummer ändern');
  assert.equal((await pf.call('PATCH', `/api/users/${erika.id}`, { memberNumber: '9999' })).status, 403); ok('Ohne das Recht: Dienstnummer ändern → 403');
  assert.equal((await pf2.call('PATCH', `/api/users/${hans.id}`, { memberNumber: 'lspd-4711' })).status, 409); ok('Dienstnummern sind eindeutig');
  assert.equal((await pf2.call('PATCH', `/api/users/${erika.id}`, { displayName: 'Erika Musterfrau' })).user.displayName, 'Erika Musterfrau'); ok('Personalabteilung kann Namen ändern');

  // ══ Behörden-Trennung ══
  const bcsoDeputy = org.ranks.find((x) => x.name === 'Deputy (BCSO)'), bcsoDept = bcsoDeputy.departmentId, lspdDept = lspdOfficer.departmentId;
  r = await admin.call('POST', '/api/users', { displayName: 'Bob Sheriff', username: 'bob', password: 'passwort123', rankId: bcsoDeputy.id, departmentId: bcsoDept, roleIds: [officerRole.id] });
  assert.equal(r.status, 201); const bob = r.user;
  const hansList = (await pf2.call('GET', '/api/users')).users;
  assert.ok(hansList.some((u) => u.id === erika.id) && !hansList.some((u) => u.id === bob.id)); ok('Mitgliederliste: nur die eigene Behörde (LSPD sieht keine BCSO-Mitglieder)');
  assert.equal((await pf2.call('GET', `/api/users/${bob.id}`)).status, 404); assert.equal((await pf2.call('PATCH', `/api/users/${bob.id}`, { displayName: 'X Y' })).status, 404);
  assert.equal((await pf2.call('POST', `/api/users/${bob.id}/status`, { status: 'blocked' })).status, 404); ok('Fremde Behörde: Details, Bearbeiten und Sperren → 404');
  assert.equal((await pf2.call('POST', '/api/users', { displayName: 'Fremd Eintrag', username: 'fremd', password: 'passwort123', departmentId: bcsoDept })).status, 403); ok('Mitglieder nur in der eigenen Behörde anlegen');
  assert.equal((await pf2.call('PATCH', `/api/users/${erika.id}`, { rankId: bcsoDeputy.id })).status, 400); ok('Rang einer anderen Behörde wird abgelehnt');
  assert.equal((await admin.call('GET', '/api/users')).users.length >= 5, true); ok('Administrator sieht alle Behörden');

  // Fahrzeuge
  const vcls = { fuel: 'petrol', condition: 'ready' };
  await admin.call('PATCH', `/api/roles/${officerRole.id}`, { permissions: [...(await admin.call('GET', '/api/roles')).roles.find((x) => x.id === officerRole.id).permissions, 'vehicles.create', 'vehicles.edit', 'warehouse.manage', 'warehouse.stock'] });
  const bobC = new Client(); await bobC.call('POST', '/api/auth/login', { username: 'bob', password: 'passwort123' });
  r = await bobC.call('POST', '/api/vehicles', { name: 'Streifenwagen', plate: 'BC-100', ...vcls }); assert.equal(r.status, 201, JSON.stringify(r)); const vBcso = r.vehicle;
  assert.equal(vBcso.department.id, bcsoDept); ok('Neues Fahrzeug erhält automatisch die eigene Behörde');
  r = await pf.call('POST', '/api/vehicles', { name: 'Funkwagen', plate: 'LS-200', ...vcls }); assert.equal(r.status, 201, JSON.stringify(r)); const vLspd = r.vehicle;
  assert.equal(vLspd.department.id, lspdDept);
  assert.deepEqual((await pf.call('GET', '/api/vehicles')).vehicles.map((v) => v.plate), ['LS-200']); assert.deepEqual((await bobC.call('GET', '/api/vehicles')).vehicles.map((v) => v.plate), ['BC-100']); ok('Fahrzeugliste: jede Behörde sieht nur ihren Fuhrpark');
  assert.equal((await pf.call('GET', `/api/vehicles/${vBcso.id}`)).status, 404); assert.equal((await pf.call('PATCH', `/api/vehicles/${vBcso.id}`, { name: 'Geklaut' })).status, 404); assert.ok([403, 404].includes((await pf.call('DELETE', `/api/vehicles/${vBcso.id}`)).status)); ok('Fremde Fahrzeuge: lesen, ändern, löschen nicht möglich');
  assert.equal((await pf.call('POST', '/api/vehicles', { name: 'Fremd', plate: 'LS-201', departmentId: bcsoDept, ...vcls })).status, 403); ok('Fahrzeug nicht für fremde Behörde anlegbar');
  assert.equal((await admin.call('GET', '/api/vehicles')).vehicles.length, 2); ok('Administrator sieht alle Fahrzeuge');
  r = await pf.call('GET', '/api/vehicles/options'); assert.deepEqual(r.departments.map((d) => d.id), [lspdDept]); ok('Auswahl der Behörde beschränkt auf eigene');

  // Zusätzliche Freigabe (z. B. FIB-Verbindungsbeamter)
  assert.equal((await pf2.call('PATCH', `/api/users/${erika.id}`, { extraDepartmentIds: [bcsoDept] })).status, 403); ok('Zusätzliche Behörden-Freigabe braucht das Recht „Alle Behörden“');
  r = await admin.call('PATCH', `/api/users/${erika.id}`, { extraDepartmentIds: [bcsoDept] }); assert.equal(r.status, 200); assert.equal(r.user.extraDepartments[0].id, bcsoDept);
  assert.deepEqual((await pf.call('GET', '/api/vehicles')).vehicles.map((v) => v.plate).sort(), ['BC-100', 'LS-200']); ok('Mit Zusatzfreigabe sieht das Mitglied auch den Fuhrpark der zweiten Behörde');
  await admin.call('PATCH', `/api/users/${erika.id}`, { extraDepartmentIds: [] });
  assert.equal((await pf.call('GET', '/api/vehicles')).vehicles.length, 1);

  // Lager
  r = await bobC.call('POST', '/api/warehouses', { name: 'Waffenkammer BCSO' }); assert.equal(r.status, 201, JSON.stringify(r)); const whB = r.warehouse; assert.equal(whB.department.id, bcsoDept);
  assert.equal((await pf.call('GET', '/api/warehouses')).warehouses.length, 0); assert.equal((await pf.call('GET', `/api/warehouses/${whB.id}`)).status, 404); assert.ok([403, 404].includes((await pf.call('DELETE', `/api/warehouses/${whB.id}`)).status));
  assert.equal((await bobC.call('GET', '/api/warehouses')).warehouses.length, 1); assert.equal((await admin.call('GET', '/api/warehouses')).warehouses.length, 1); ok('Lager: nur die eigene Behörde sieht und verwaltet ihre Lager (Admin sieht alle)');


  // Audit + Chat mit Klarnamen
  r = await admin.call('GET', '/api/audit?limit=50'); assert.ok(r.rows.some((x) => /Hans Personal|Erika/.test(x.actor + ' ' + (x.targetLabel ?? '')))); ok('Audit-Log nennt Handelnde und Betroffene mit Name (Dienstnummer)');
  assert.ok((await admin.call('GET', '/api/audit?user=Hans')).rows.length > 0); ok('Audit-Filter nach Name');
  r = await admin.call('GET', '/api/chat/people'); assert.ok(r.people.some((x) => x.label === 'Erika Musterfrau (LSPD-4711)'), JSON.stringify(r.people)); ok('Chat-Kontakte: „Name (Dienstnummer)“');
  r = await pf.call('GET', '/api/presence'); assert.equal(r.status, 200); ok('Online-Liste erreichbar');

  // ══ Kriminelle Module sind entfernt ══
  for (const p of ['/api/market/deals', '/api/partners', '/api/credit/requests', '/api/tab/companies', '/api/hack/admin']) assert.ok([404, 403].includes((await admin.call('GET', p)).status), p);
  assert.equal((await admin.call('GET', '/api/market/deals')).status, 404); ok('Börse, Externe Zugänge, Kredit, Deckel und Exekutive-Zugang sind nicht mehr erreichbar');
  assert.ok(!(await admin.call('GET', '/api/permissions')).permissions.some((x) => /^(market|partners|credit|tab|hack)\./.test(x.key))); ok('Keine Rechte der entfernten Module mehr');

  console.log(`\nAlle ${passed} Prüfungen bestanden.`);
} catch (e) {
  console.error('\n✗ FEHLGESCHLAGEN:', e.message, '\n', e.stack?.split('\n').slice(1, 4).join('\n'));
  process.exitCode = 1;
} finally {
  server.close();
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(process.exitCode ?? 0); }, 200);
}
