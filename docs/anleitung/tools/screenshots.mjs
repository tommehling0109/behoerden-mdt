// Automatische Screenshots für die Anleitung (headless Chrome über CDP) – Argument: Ausgabeordner
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true });
const DIR = './tmp/doc', DIR2 = './tmp/doc-empty';
const ROOT = '.', CHROME = '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envBase = { ...process.env, MDT_UPDATE_CHECK: '0', APP_COMMIT: 'doc0000' };
const srv = (port, dir) => spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env: { ...envBase, PORT: String(port), MDT_DATA_DIR: dir }, stdio: 'ignore' });
rmSync(DIR2, { recursive: true, force: true }); mkdirSync(DIR2, { recursive: true });
const s1 = srv(3910, DIR), s2 = srv(3911, DIR2); await sleep(3000);
const B = 'http://127.0.0.1:3910', E = 'http://127.0.0.1:3911';
const hack = JSON.parse(readFileSync(`${DIR}/hack.json`, 'utf8')), partner = JSON.parse(readFileSync(`${DIR}/partner.json`, 'utf8')), firma = JSON.parse(readFileSync(`${DIR}/firma.json`, 'utf8'));
const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + process.env.TEMP + '/chrome-doc-' + Date.now(), '--hide-scrollbars', '--window-size=1480,900', '--disable-gpu', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let info; for (let i = 0; i < 40; i++) { try { info = await (await fetch('http://127.0.0.1:9333/json/list')).json(); if (info.find((t) => t.type === 'page')) break; } catch { /* warten */ } await sleep(300); }
const ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
await send('Page.enable'); await send('Network.enable'); await send('Network.clearBrowserCookies'); await send('Emulation.setDeviceMetricsOverride', { width: 1480, height: 880, deviceScaleFactor: 1, mobile: false });
const go = async (url, ms = 1800) => { await send('Page.navigate', { url }); await sleep(ms); };
let n = 0; const shots = [];
const shot = async (name, title, ms = 0) => { if (ms) await sleep(ms); const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 }); const file = `${String(++n).padStart(2, '0')}-${name}.jpg`; writeFileSync(`${OUT}/${file}`, Buffer.from(r.result.data, 'base64')); shots.push({ file, name, title }); console.log('shot', file); };
const clickText = (text, scope = 'body') => ev(`(() => { const els = [...document.querySelectorAll('${scope} button, ${scope} a, ${scope} [role=tab], ${scope} .tab, ${scope} .cchip, ${scope} .list-row, ${scope} tr')]; const el = els.find((e) => e.textContent.trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())})); if (el) { el.scrollIntoView({block:'center'}); el.click(); return true; } return false; })()`);
const closeAll = () => ev(`(() => { for (let i = 0; i < 12; i++) { const b = document.querySelector('.modal-root .modal-head button, .modal .close, .modal button[aria-label=Schließen], .modal-x'); if (!b) break; b.click(); } document.querySelectorAll('.win .win-btn.close').forEach((b) => b.click()); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return 1; })()`);
const openApp = async (label, ms = 2200) => { await closeAll(); await sleep(300); await ev(`document.querySelector('.dock-item[data-label=${JSON.stringify(label)}]')?.click()`); await sleep(600); await ev(`document.querySelector('.win .win-btn.max')?.click()`); await sleep(ms); };
const login = async (base) => { await ev(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mdt' }, body: JSON.stringify({ username: 'admin', password: 'passwort123' }) }).then((r) => r.status)`); };

// ── Ersteinrichtung + Anmeldung (leeres System) ──
await go(E + '/'); await shot('einrichtung', 'Ersteinrichtung');
await go(B + '/'); await shot('anmeldung', 'Anmeldung');
await ev(`document.querySelector('a, button.link')`); // Registrierung
await clickText('Zugang beantragen'); await sleep(600); await shot('registrierung', 'Registrierung');
await login(B); await go(B + '/', 2600); await shot('desktop', 'Der Desktop mit Schwarzem Brett');
await ev(`document.querySelector('.start-btn').click()`); await sleep(500); await shot('startmenue', 'Das Startmenü'); await ev(`document.querySelector('.start-btn').click()`);
await ev(`document.querySelector('.bell, .panel-btn[aria-label=Benachrichtigungen]').click()`); await sleep(500); await shot('benachrichtigungen', 'Benachrichtigungen'); await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await ev(`document.querySelector('.panel-btn[aria-label=Einstellungen]').click()`); await sleep(500); await shot('einstellungen', 'Einstellungen (Ton, Lautstärke)'); await closeAll();
await ev(`document.querySelector('.panel-user').click()`); await sleep(700); await shot('konto', 'Konto & Sicherheit'); await closeAll();
await ev(`document.querySelector('.panel-btn[aria-label="Fehler melden"]').click()`); await sleep(900); await shot('ticket-melden', 'Fehler melden / Ticket'); await closeAll();

// ── Apps ──
await openApp('Dashboard'); await shot('dashboard', 'Dashboard');
await openApp('Börse'); await shot('boerse', 'Börse'); await clickText('Katalog'); await sleep(900); await shot('boerse-katalog', 'Börse: Katalog'); await clickText('Gesuche'); await sleep(900); await shot('boerse-gesuche', 'Börse: Gesuche');
await openApp('Karte', 4500); await shot('karte', 'Karte');
await openApp('Lager'); await shot('lager', 'Lager'); await clickText('Öffnen'); await sleep(1400); await shot('lager-uebersicht', 'Lager: Übersicht'); await clickText('Bestand', '.modal'); await sleep(900); await shot('lager-detail', 'Lager: Bestand mit Slots'); await clickText('Einlagern', '.modal'); await sleep(900); await ev(`(() => { const s = document.querySelector('.modal select'); if (s) { const i = [...s.options].findIndex((o) => o.text.includes('Schwarze Weste')); s.selectedIndex = i >= 0 ? i : 3; s.dispatchEvent(new Event('change')); } const q = document.querySelector('.modal input[type=number]'); if (q) { q.value = '5'; q.dispatchEvent(new Event('input')); } })()`); await sleep(400); await shot('lager-einlagern', 'Einlagern mit Slot-Berechnung'); await closeAll();
await openApp('Lager'); await clickText('Artikel'); await sleep(900); await shot('lager-artikel', 'Lager: Artikel & Preise'); await clickText('Artikel anlegen'); await sleep(700); await shot('lager-artikel-dialog', 'Artikel mit Slots und Stapelgröße'); await closeAll();
await closeAll(); await go(B + '/', 2200); await ev(`document.querySelector('.board .btn, .board button[title="Neue Ankündigung"]').click()`); await sleep(700); await shot('brett-neu', 'Schwarzes Brett: Ankündigung anlegen'); await closeAll();
await openApp('Fahrzeuge'); await shot('fahrzeuge', 'Fahrzeuge'); await clickText('Fahrzeug anlegen'); await sleep(800); await shot('fahrzeug-neu', 'Fahrzeug anlegen'); await closeAll();
await openApp('Finanzen'); await shot('finanzen', 'Finanzen: Überblick'); await clickText('Journal'); await sleep(900); await shot('finanzen-journal', 'Finanzen: Journal');
await clickText('Manuelle Buchung'); await sleep(800); await shot('finanzen-buchung', 'Manuelle Buchung'); await closeAll();
await openApp('Statistik'); await shot('statistik', 'Statistik');
await openApp('Kredit'); await shot('kredit', 'Kredit');
await openApp('Deckel'); await shot('deckel', 'Deckel'); await clickText('Firmen'); await sleep(900); await shot('deckel-firmen', 'Deckel: Firmen'); await clickText('Firma anlegen'); await sleep(800); await shot('deckel-firma-neu', 'Firma anlegen'); await closeAll();
await openApp('Tickets'); await shot('tickets', 'Tickets');
await openApp('Chat'); await shot('chat', 'Chat'); await clickText('Kanäle verwalten'); await sleep(900); await shot('chat-kanaele', 'Kanäle verwalten'); await closeAll(); await openApp('Chat'); await clickText('Neue Privatnachricht'); await sleep(900); await shot('chat-privat', 'Neue Privatnachricht'); await closeAll();
await openApp('Benutzer'); await shot('benutzer', 'Benutzer'); await clickText('Benutzer anlegen'); await sleep(900); await shot('benutzer-neu', 'Benutzer anlegen (Personalakte)'); await closeAll();
await openApp('Rollen & Rechte'); await shot('rollen', 'Rollen & Rechte');
await openApp('Organisation'); await shot('organisation', 'Organisation: Ränge & Abteilungen'); await clickText('Abteilungen'); await sleep(900); await shot('organisation-abt', 'Organisation: Abteilungen');
await openApp('Externe Zugänge'); await shot('partner', 'Externe Zugänge'); await clickText('Zugang erstellen'); await sleep(900); await shot('partner-neu', 'Externen Zugang anlegen'); await closeAll();
await openApp('Kategorien & Status'); await shot('lookups', 'Kategorien & Status');
await openApp('Konfiguration', 2600); await shot('konfig', 'Konfiguration');
await ev(`(() => { const h = [...document.querySelectorAll('.card-head h3')].find((x) => x.textContent.includes('Exekutive')); h?.scrollIntoView({ block: 'start' }); const w = document.querySelector('.win .content, .win-body, .win-content'); return !!h; })()`); await sleep(500); await shot('konfig-hack', 'Konfiguration: Exekutive-Zugang');
await ev(`(() => { const h = [...document.querySelectorAll('.card-head h3')].find((x) => x.textContent.includes('Updates')); h?.scrollIntoView({ block: 'center' }); })()`); await sleep(500); await shot('konfig-updates', 'Konfiguration: Updates & Datensicherung');
await openApp('Audit-Log'); await shot('audit', 'Audit-Log');
await closeAll(); await ev(`document.querySelector('.panel-btn[aria-label="Bildschirm sperren"]').click()`); await sleep(900); await shot('sperre', 'Sperrbildschirm');
await ev(`localStorage.clear(); sessionStorage.clear(); 1`);

// ── Hack-Terminal ──
await go(`${B}${hack.path}`, 3500); await shot('hack-start', 'Exekutive-Zugang: Startbildschirm');
await clickText('Verbindung aufbauen'); await sleep(2500); await shot('hack-stufe', 'Exekutive-Zugang: ein Minigame');
// ── Partner-Portal & Firmenportal ──
await closeAll(); await go(`${B}${partner.link}`, 2200); await shot('partner-login', 'Partner-Portal: Anmeldung per Code');
await ev(`fetch(location.pathname + '/login', {method:'POST'}).then(()=>0)`);
const tok = partner.link.split('/').pop();
await ev(`fetch('/api/p/${tok}/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mdt' }, body: JSON.stringify({ code: '${JSON.parse(readFileSync(DIR + '/partner.json', 'utf8')).code}' }) }).then((r) => r.status)`);
await go(`${B}${partner.link}`, 2600); await shot('partner-portal', 'Partner-Portal: Desktop');
await openApp('Börse'); await shot('partner-boerse', 'Partner-Portal: Börse'); await openApp('Kredit'); await shot('partner-kredit', 'Partner-Portal: Kredit');
await closeAll(); await go(`${B}${firma.link}`, 2400); await shot('firmenportal', 'Firmenportal (Deckel-Abrechnung)');
console.log(JSON.stringify(shots)); writeFileSync(`${OUT}/shots.json`, JSON.stringify(shots, null, 1));
ch.kill(); s1.kill(); s2.kill(); process.exit(0);
