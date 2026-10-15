// Baut ein Demo-System für die Anleitung auf (Datenordner = argv[2], Port = argv[3]).
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
const [, , DIR, PORT] = process.argv;
const ROOT = '.';
rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
const env = { ...process.env, PORT, MDT_DATA_DIR: DIR, MDT_UPDATE_CHECK: '0', APP_COMMIT: 'doc0000' };
const start = () => spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: 'ignore', detached: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;
class C { cookie = ''; async call(m, p, b) { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mdt', cookie: this.cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0]; let j = {}; try { j = await r.json(); } catch { /* leer */ } return { status: r.status, ...j }; } }

let srv = start(); await sleep(2500);
const admin = new C();
let r = await admin.call('POST', '/api/setup', { systemName: "MDT", displayName: 'Admin', username: 'admin', password: 'passwort123' });
console.log('setup', r.status);
srv.kill(); await sleep(800);
const seed = spawnSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/seed-demo.js'], { cwd: ROOT, env, encoding: 'utf8' });
console.log(seed.stdout.slice(0, 600), seed.stderr.slice(0, 300));
srv = start(); await sleep(2500);
await admin.call('POST', '/api/auth/login', { username: 'admin', password: 'passwort123' });

// Schwarzes Brett
for (const p of [
  { title: 'ALARM: Razzia vermutet', body: 'Lager räumen, nichts im Chat besprechen.', level: 'urgent', pinned: true },
  { title: 'Treffen am Samstag, 20 Uhr', body: 'Alle Abteilungsleiters am Hafen-Lager. Pünktlich sein!', level: 'important' },
  { title: 'Neues Fahrzeug im Fuhrpark', level: 'success' },
]) await admin.call('POST', '/api/board', p);

// Lager: Items mit Slots/Stapeln und Bestand
const mk = async (name, unit, space, stackSize, minPrice, maxPrice, target) => (await admin.call('POST', '/api/warehouse/items', { name, unit, space, stackSize, minPrice, maxPrice, targetStock: target })).item;
const items = [await mk('Pulver (gestreckt)', 'Stk', 1, 5, 40, 70, 200), await mk('Kupferkabel', 'Stk', 1, 5, 20, 35, 300), await mk('Schwarze Weste', 'Stk', 2, 2, 150, 260, 40), await mk('Sturmgewehr-Kiste', 'Stk', 3, 1, 900, 1400, 10)];
const whs = (await admin.call('GET', '/api/warehouses')).warehouses;
console.log('Lager:', whs.map((w) => `${w.id}:${w.name}`).join(', '), '| Items:', items.map((i) => i?.id).join(','));
const first = whs[0];
if (first) { await admin.call('PATCH', `/api/warehouses/${first.id}`, { capacity: 60 }); for (const [it, q] of [[items[0], 23], [items[1], 12], [items[2], 5], [items[3], 3]]) if (it) console.log('stock', (await admin.call('POST', `/api/warehouses/${first.id}/stock`, { itemId: it.id, action: 'in', quantity: q })).status); }

// Externe Zugänge + Börse-Angebot, Kredit
const partners = {};
for (const [name, apps] of [['Muster Handel', ['market', 'chat', 'credit']], ['Hafen-Zulieferer', ['market', 'chat']]]) { const p = await admin.call('POST', '/api/partners', { name, apps }); partners[name] = p; console.log('partner', name, p.status, p.partner?.number, p.code); }
const ph = partners['Muster Handel'];
if (ph?.partner && first && items[0]) console.log('offer', (await admin.call('POST', '/api/market/offers', { partnerId: ph.partner.id, warehouseId: first.id, itemId: items[0].id, quantity: 10, unitPrice: 55, note: 'Frisch eingetroffen' })).status);
const pc = new C(); await pc.call('POST', `/api/p/${ph.partner.linkPath.split('/').pop()}/login`, { code: ph.code });
console.log('credit', (await pc.call('POST', '/api/p/credit/requests', { principalCents: 500000, termCount: 4, frequency: 'weekly' })).status);
writeFileSync(`${DIR}/partner.json`, JSON.stringify({ link: ph.partner.linkPath, code: ph.code }));

// Deckel-Firmen
for (const c of [{ name: 'Muster GmbH', seat: 'PC1234 Test Drive', accountNumber: 'LS28180705', contactName: 'Frau Muster', interval: 'weekly' }, { name: 'Beispiel AG', seat: 'PC5678 Beispielweg', accountNumber: 'LS11112222', interval: 'monthly' }]) { const x = await admin.call('POST', '/api/tab/companies', c); console.log('firma', x.status); if (c.name === 'Muster GmbH') writeFileSync(`${DIR}/firma.json`, JSON.stringify({ link: x.company?.linkPath })); }

// Finanzen
for (const e of [['in', 12500, 'Verkauf Pulver an Muster Handel'], ['out', 3200, 'Fahrzeugreparatur'], ['in', 8400, 'Einnahmen Wochenmarkt'], ['out', 1500, 'Miete Hafen-Lager'], ['in', 4300, 'Schutzgeld Bezirk Nord']]) await admin.call('POST', '/api/finance/entries', { direction: e[0], amount: e[1], description: e[2], status: 'settled' });
await admin.call('POST', '/api/finance/entries', { direction: 'in', amount: 6000, description: 'Erwartete Zahlung Lieferung', status: 'expected' });

// Chat + Tickets
const chans = (await admin.call('GET', '/api/chat/channels')).channels; const gen = chans[0];
for (const m of ['Willkommen im Allgemein-Kanal! Hier läuft die interne Kommunikation.', 'Heute Abend Lieferung am Hafen – bitte alle @MDT-1 melden.', 'Danke, bin dabei.']) await admin.call('POST', `/api/chat/channels/${gen.id}/messages`, { body: m });
await admin.call('POST', '/api/tickets', { title: 'Karte lädt langsam', description: 'Beim Öffnen der Karte dauert es einige Sekunden, bis die Postleitzahlen erscheinen.', category: 'bug', app: 'Karte' });
await admin.call('POST', '/api/tickets', { title: 'Wunsch: Export der Fahrzeugliste', description: 'Es wäre schön, die Fahrzeugliste als CSV herunterladen zu können.', category: 'idea', app: 'Fahrzeuge' });

// Zugangsdaten für die Screenshots
writeFileSync(`${DIR}/hack.json`, JSON.stringify(await admin.call('GET', '/api/hack/admin')));
console.log('fertig'); srv.kill(); process.exit(0);
