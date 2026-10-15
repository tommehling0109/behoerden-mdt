import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { all, get, run, now } from '../core/db.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { audit } from '../core/audit.js';
import { getConfig, setConfig } from '../core/config.js';
import { rateLimit } from '../core/auth.js';
import { notify, staffWith } from '../core/notifications.js';

/**
 * „Hack“-Zugang für die Exekutive (Rollenspiel-Funktion): ein dauerhafter, geheimer Link (/x/<Schlüssel>) ohne Anmeldung und OHNE jede Kennzeichnung
 * des Systems (kein Name, kein Logo). Dahinter vier Minigames; wer alle besteht, bekommt zufällige, bewusst harmlose Schnipsel aus dem System
 * (Personalnummern, Partnernummern, Teilbestände einzelner Lager, Fahrzeugkennzeichen, Geschäftsnummern) – niemals Klarnamen, Telefonnummern,
 * Personalakten oder sonstige sensible Daten. Danach gilt eine gemeinsame Sperrzeit (Cooldown) für den Link.
 *
 * Die Lösungen liegen ausschließlich auf dem Server (Sitzung im Speicher); der Browser bekommt nur die Aufgaben.
 */
const runMs = () => Number(getConfig('hack.max_minutes')) * 60_000; // so lange darf ein Zugriffsversuch dauern
const lives = () => Number(getConfig('hack.lives'));
// Schwierigkeit: Anzahl Befehle, Zeit zum Tippen, Ziffern/Versuche beim Kennwort, Länge/Tempo der Sequenz
const PRESETS = {
  easy: { lines: 2, typeSec: 150, digits: 3, tries: 10, seq: 4, speed: 700, freqTries: 11, mod: 4, showMs: 6000, opts: 4, math: 3, mathSec: 60 },
  normal: { lines: 3, typeSec: 90, digits: 4, tries: 8, seq: 6, speed: 520, freqTries: 9, mod: 7, showMs: 4000, opts: 5, math: 4, mathSec: 45 },
  hard: { lines: 4, typeSec: 45, digits: 5, tries: 6, seq: 8, speed: 340, freqTries: 8, mod: 11, showMs: 2500, opts: 6, math: 5, mathSec: 35 },
};
const preset = () => PRESETS[getConfig('hack.difficulty')] ?? PRESETS.normal;
const sessions = new Map(); // sid → Zustand
export const __sessions = sessions; // nur für den Test
setInterval(() => { const t = Date.now(); for (const [k, s] of sessions) if (t - s.started > 61 * 60_000) sessions.delete(k); }, 60_000).unref();

// ── Link-Schlüssel ──
const KEY = 'hack.link_token';
function linkToken() {
  let t = get('SELECT value FROM settings WHERE key = ?', KEY);
  t = t ? JSON.parse(t.value) : null;
  if (!t) { t = randomBytes(18).toString('base64url'); setConfig(KEY, t, null); }
  return t;
}
const tokenOk = (given) => {
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(linkToken());
  return a.length === b.length && timingSafeEqual(a, b);
};
function guard(ctx) {
  if (!rateLimit(`hk|${ctx.ip}`, 240, 10 * 60_000)) throw new HttpError(429, 'Zu viele Anfragen.', 'rate_limited');
  // Über die eigene Subdomain (hack.host) braucht es keinen Schlüssel im Pfad; sonst gilt der geheime Link /x/<Schlüssel>
  if (ctx.params.token === '-' ? !ctx.hackHost : !tokenOk(ctx.params.token)) throw notFound('Nicht gefunden.');
}

// ── Sperrzeit: gemeinsam für den Link; zählt ab Ende des letzten Versuchs (läuft einer ins Leere, ab Start + Höchstdauer) ──
function cooldownLeftSec() {
  const last = get('SELECT * FROM hack_runs ORDER BY id DESC LIMIT 1');
  if (!last) return 0;
  const end = last.ended_at ? Date.parse(last.ended_at) : Date.parse(last.started_at) + runMs();
  const minutes = last.success ? getConfig('hack.cooldown_minutes') : getConfig('hack.cooldown_fail_minutes');
  return Math.max(0, Math.ceil((end + minutes * 60_000 - Date.now()) / 1000));
}

// ── Minigames ──
const hex = (n) => randomBytes(n).toString('hex').toUpperCase();
const ip = () => `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(2, 250)}`;
const COMMANDS = [
  () => `scan --host ${ip()} --port ${randomInt(1000, 9999)} --stealth`,
  () => `inject payload_${hex(2)}.bin -> gate${randomInt(10, 99)}`,
  () => `Invoke-Bypass -Token 0x${hex(3)} -Force`,
  () => `tunnel open ${ip()}:${randomInt(2000, 9000)} --relay ${randomInt(1, 9)}`,
  () => `crack --hash ${hex(4).toLowerCase()} --mode fast`,
  () => `Set-Item HKLM:\\sys\\node${randomInt(10, 99)} -Value 0x${hex(2)}`,
  () => `spoof --mac ${hex(1)}:${hex(1)}:${hex(1)}:${hex(1)} --iface eth${randomInt(0, 3)}`,
];
const WORDS = ['FREIGABE', 'ZUGRIFF', 'KENNWORT', 'SCHLUESSEL', 'ARCHIV', 'DATENBANK', 'PROTOKOLL', 'SPERRE', 'TERMINAL', 'BEWEIS'];
const GAMES = ['typing', 'code', 'sequence', 'cipher', 'frequency', 'checksum', 'match', 'math']; // Pool; pro Zugriff werden zufällig einige davon gezogen
const shuffle = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; };
function pickPlan() {
  let pool = GAMES.filter((g) => getConfig(`hack.game_${g}`));
  if (!pool.length) pool = [...GAMES];
  return shuffle(pool).slice(0, Math.min(Number(getConfig('hack.stage_count')) || 4, pool.length));
}
const hexTok = (n) => randomBytes(n).toString('hex').toUpperCase();
const hexSum = (t) => [...t].reduce((a, c) => a + parseInt(c, 16), 0);

function makeStage(type, { round = 1 } = {}) {
  switch (type) {
    case 'typing': { const lines = [...COMMANDS].sort(() => randomInt(0, 3) - 1).slice(0, preset().lines).map((f) => f()); return { type, lines, secret: { lines, limitMs: preset().typeSec * 1000 }, typeSec: preset().typeSec }; }
    case 'code': {
      const p = preset(), digits = shuffle([...'0123456789']).slice(0, p.digits).join(''), rounds = getConfig('hack.pin_reset') ? 2 : 1;
      return { type, secret: { digits, tries: p.tries, round, rounds }, public: { tries: p.tries, length: p.digits, round, rounds } };
    }
    case 'sequence': { const seq = []; const p = preset(); while (seq.length < p.seq) { const n = randomInt(0, 9); if (n !== seq.at(-1)) seq.push(n); } return { type, secret: { seq }, public: { sequence: seq, grid: 9, speed: p.speed } }; }
    case 'cipher': {
      const word = WORDS[randomInt(0, WORDS.length)], shift = randomInt(3, 23);
      const enc = [...word].map((c) => String.fromCharCode(((c.charCodeAt(0) - 65 + shift) % 26) + 65)).join('');
      return { type, secret: { word }, public: { cipher: enc } };
    }
    case 'frequency': { const p = preset(); return { type, secret: { target: randomInt(1, 257), tries: p.freqTries }, public: { min: 1, max: 256, tries: p.freqTries } }; }
    case 'checksum': {
      const p = preset();
      for (let n = 0; n < 2000; n++) {
        const tokens = Array.from({ length: 8 }, () => hexTok(3)), hits = tokens.filter((t) => hexSum(t) % p.mod === 0);
        if (hits.length === 1) return { type, secret: { index: tokens.indexOf(hits[0]) }, public: { tokens, mod: p.mod } };
      }
      throw new Error('checksum');
    }
    case 'match': {
      const p = preset(), target = `${hexTok(2)}-${hexTok(2)}`, opts = new Set([target]);
      while (opts.size < p.opts) { const c = [...target]; for (let k = 0; k < randomInt(1, 3); k++) { const i = [0, 1, 2, 3, 5, 6, 7, 8][randomInt(0, 8)]; c[i] = '0123456789ABCDEF'[randomInt(0, 16)]; } opts.add(c.join('')); }
      const options = shuffle([...opts]);
      return { type, secret: { index: options.indexOf(target) }, public: { target, options, showMs: p.showMs } };
    }
    case 'math': {
      const p = preset(), probs = Array.from({ length: p.math }, () => {
        const op = ['+', '-', '×'][randomInt(0, 3)], a = op === '×' ? randomInt(3, 13) : randomInt(12, 99), b = op === '×' ? randomInt(3, 10) : randomInt(7, 60);
        return { text: `${a} ${op} ${b}`, value: op === '+' ? a + b : op === '-' ? a - b : a * b };
      });
      return { type, secret: { answers: probs.map((x) => x.value), limitMs: p.mathSec * 1000 }, public: { problems: probs.map((x) => x.text), limitSec: p.mathSec } };
    }
    default: throw new Error('stage');
  }
}
const stageDto = (s) => ({ type: s.stage.type, index: s.index, total: s.plan.length, ...(s.stage.type === 'typing' ? { lines: s.stage.lines, typeSec: s.stage.typeSec } : s.stage.public) });

// ── Hinweise: pro Minigame einmal anforderbar; dauert ein paar Sekunden und liefert mit Wahrscheinlichkeit nichts ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeHint(st) {
  const sec = st.secret;
  switch (st.type) {
    case 'typing': sec.limitMs += 30_000; return { text: 'Zeitlimit für diese Stufe um 30 Sekunden verlängert.' };
    case 'code': { const pos = randomInt(0, sec.digits.length); return { text: `Stelle ${pos + 1} des Kennworts ist eine ${sec.digits[pos]}.` }; }
    case 'sequence': return { text: `Die Folge beginnt mit den Feldern ${sec.seq.slice(0, Math.ceil(sec.seq.length / 2)).map((x) => x + 1).join(', ')}.` };
    case 'cipher': return { text: `Das Wort hat ${sec.word.length} Buchstaben und beginnt mit „${sec.word[0]}“.` };
    case 'frequency': { const lo = Math.max(1, sec.target - randomInt(0, 64)), hi = Math.min(256, lo + 63); return { text: `Das Signal liegt zwischen ${lo} und ${hi}.` }; }
    case 'checksum': case 'match': {
      const total = st.type === 'checksum' ? st.public.tokens.length : st.public.options.length;
      const wrong = shuffle([...Array(total).keys()].filter((i) => i !== sec.index)).slice(0, st.type === 'checksum' ? 3 : Math.max(1, Math.floor((total - 1) / 2)));
      return { text: `${wrong.length} falsche ${st.type === 'checksum' ? 'Tokens' : 'Kennungen'} wurden ausgeschlossen.`, eliminate: wrong };
    }
    case 'math': { const index = randomInt(0, sec.answers.length); return { text: `Aufgabe ${index + 1} ergibt ${sec.answers[index]}.`, fill: { index, value: sec.answers[index] } }; }
    default: return null;
  }
}

// ── Beute: harmlose Schnipsel, nur ausdrücklich ausgewählte Spalten (keine Namen, Telefonnummern, Akten, Preise) ──
const SNIPPETS = [
  ['personal', () => { // Personalnummern (nur Kennung + Rang)
    const rows = all("SELECT u.member_number n, r.name rank FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.status = 'active' AND u.member_number IS NOT NULL ORDER BY RANDOM() LIMIT 3");
    return rows.length ? { kind: 'Personal', title: 'Personalkennungen', lines: rows.map((x) => `${x.n}${x.rank ? `  ·  ${x.rank}` : ''}`) } : null;
  }],
  ['warehouse', () => { // Teilbestand eines Lagers – wenige Positionen, gerundete Menge, nur die Lagernummer
    const w = get("SELECT w.id, w.warehouse_number n FROM warehouses w WHERE w.is_active = 1 AND EXISTS (SELECT 1 FROM warehouse_stock s WHERE s.warehouse_id = w.id AND s.quantity > 0) ORDER BY RANDOM() LIMIT 1");
    if (!w) return null;
    const rows = all('SELECT i.name, s.quantity q, i.unit FROM warehouse_stock s JOIN market_items i ON i.id = s.item_id WHERE s.warehouse_id = ? AND s.quantity > 0 ORDER BY RANDOM() LIMIT 2', w.id);
    const round = (q) => (q < 10 ? q : q < 100 ? Math.round(q / 5) * 5 : Math.round(q / 50) * 50);
    return { kind: 'Lager', title: `Lagerauszug ${w.n ?? ''}`.trim(), lines: [...rows.map((x) => `${x.name}  ·  ca. ${round(x.q)} ${x.unit}`), '… (Auszug unvollständig)'] };
  }],
  ['vehicles', () => { // Fahrzeug
    const v = get('SELECT plate, name FROM vehicles ORDER BY RANDOM() LIMIT 1');
    return v ? { kind: 'Fahrzeug', title: 'Fahrzeugregister', lines: [`${v.plate}  ·  ${v.name}`] } : null;
  }],
  ['deals', () => { // Geschäft (ohne Preise und Namen)
    const d = get("SELECT d.deal_number n, i.name item, d.quantity q, d.status FROM market_deals d JOIN market_items i ON i.id = d.item_id ORDER BY RANDOM() LIMIT 1");
    return d ? { kind: 'Handel', title: 'Geschäftsvorgang', lines: [`${d.n}  ·  ${d.item} ×${d.q}  ·  Status: ${d.status}`] } : null;
  }],
  ['partners', () => { // Externe Zugänge (nur Kennung)
    const rows = all("SELECT partner_number n FROM partners WHERE status = 'active' AND partner_number IS NOT NULL ORDER BY RANDOM() LIMIT 2");
    return rows.length ? { kind: 'Extern', title: 'Gegenstellen', lines: rows.map((x) => x.n) } : null;
  }],
  ['contacts', () => { // Kontaktbuch: nur offene Institutionen (Name, Art, Anzahl Personen) – nie Personen, Kontaktdaten oder Bankdaten
    const rows = all("SELECT o.name, l.label type, (SELECT COUNT(*) FROM contact_people p WHERE p.org_id = o.id) n FROM contact_orgs o LEFT JOIN lookups l ON l.id = o.type_id WHERE o.restricted = 0 ORDER BY RANDOM() LIMIT 2");
    return rows.length ? { kind: 'Kontakte', title: 'Kontaktbuch-Auszug', lines: rows.map((x) => `${x.name}${x.type ? `  ·  ${x.type}` : ''}  ·  ${x.n} Einträge`) } : null;
  }],
  ['changelog', () => { // Versionshinweise (nur Version und Titel)
    const c = get('SELECT version, title FROM changelog_entries ORDER BY RANDOM() LIMIT 1');
    return c ? { kind: 'System', title: 'Wartungsnotiz', lines: [`${c.version ? c.version + '  ·  ' : ''}${c.title}`] } : null;
  }],
  ['board', () => { // Schwarzes Brett: nur die Überschrift einer unkritischen Meldung
    const b = get("SELECT title FROM board_posts WHERE level IN ('info','success') ORDER BY RANDOM() LIMIT 1");
    return b ? { kind: 'Intern', title: 'Aushang', lines: [b.title] } : null;
  }],
];
function loot() {
  const want = Math.max(1, Number(getConfig('hack.reward_count')) || 3);
  const out = [];
  for (const [key, f] of [...SNIPPETS].sort(() => randomInt(0, 3) - 1)) {
    if (out.length >= want) break;
    if (!getConfig(`hack.loot_${key}`)) continue;
    const s = f(); if (s) out.push(s);
  }
  return out.length ? out : [{ kind: 'Hinweis', title: 'Keine Daten', lines: ['Der Zugriff war erfolgreich, aber es wurden keine verwertbaren Datensätze gefunden.'] }];
}

function finish(ctx, s, success, reason) {
  s.done = true; sessions.delete(s.sid);
  run('UPDATE hack_runs SET ended_at = ?, success = ?, stage = ? WHERE id = ?', now(), success ? 1 : 0, s.index, s.runId);
  audit({ ip: ctx.ip, actorName: 'Unbekannter Zugriff' }, { action: success ? 'hack.success' : 'hack.failed', module: 'hack', targetType: 'hack', targetId: s.runId, targetLabel: success ? 'Zugriff erfolgreich' : `Zugriff abgebrochen (${reason})` });
  notify(staffWith('hack.manage'), { key: `hack:${s.runId}:end`, title: success ? 'Unbefugter Zugriff erfolgreich' : 'Unbefugter Zugriff abgewehrt', body: success ? 'Ein externer Zugriff über den Sonderzugang hat Daten abgegriffen.' : `Ein externer Zugriffsversuch ist gescheitert (${reason}).` });
}

export default {
  name: 'hack',
  permissions: [['hack.manage', 'Exekutive-Zugang: Link ansehen/erneuern, Einstellungen und Zugriffsprotokoll']],
  config: [
    { key: 'hack.host', group: 'Exekutive-Zugang', label: 'Eigene Subdomain', help: 'Unter diesem Hostnamen (z. B. access.example.com) liegt der Zugang direkt auf der Startseite – ohne Schlüssel im Pfad und ohne irgendetwas vom eigentlichen System. DNS-Eintrag und Proxy-Host müssen auf diesen Server zeigen.', type: 'string', default: 'access.example.com', max: 120, perm: 'hack.manage' },
    { key: 'hack.enabled', group: 'Exekutive-Zugang', label: 'Zugang aktiv', help: 'Schaltet den Hack-Link der Exekutive ein oder aus.', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.difficulty', group: 'Exekutive-Zugang', label: 'Schwierigkeit', help: 'Leicht: 2 Befehle, 3 Ziffern, kurze Folge. Normal: 3 Befehle, 4 Ziffern, 6er-Folge. Schwer: 4 Befehle (knappe Zeit), 5 Ziffern, 8er-Folge, schnelles Tempo.', type: 'select', default: 'normal', options: [{ value: 'easy', label: 'Leicht' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Schwer' }], perm: 'hack.manage' },
    { key: 'hack.stage_count', group: 'Exekutive-Zugang', label: 'Minigames pro Zugriff', help: 'So viele Stufen werden pro Zugriff zufällig aus den aktiven Minigames gezogen.', type: 'number', default: 4, min: 1, max: 8, perm: 'hack.manage' },
    { key: 'hack.game_typing', group: 'Exekutive-Zugang', label: 'Minigame: Befehle abtippen', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.game_code', group: 'Exekutive-Zugang', label: 'Minigame: PIN/Kennwort knacken', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.pin_reset', group: 'Exekutive-Zugang', label: 'PIN wird nach dem Knacken einmal zurückgesetzt', help: 'Nach dem ersten Knacken setzt die Abwehr ein neues Kennwort – es muss ein zweites Mal geknackt werden.', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.game_sequence', group: 'Exekutive-Zugang', label: 'Minigame: Sequenz merken', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.game_cipher', group: 'Exekutive-Zugang', label: 'Minigame: Entschlüsseln', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.game_frequency', group: 'Exekutive-Zugang', label: 'Minigame: Frequenz finden (höher/tiefer)', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.game_checksum', group: 'Exekutive-Zugang', label: 'Minigame: Gültiges Token finden (Prüfsumme)', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.game_match', group: 'Exekutive-Zugang', label: 'Minigame: Muster wiedererkennen', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.game_math', group: 'Exekutive-Zugang', label: 'Minigame: Prüfsummen rechnen', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.hints', group: 'Exekutive-Zugang', label: 'Hinweise erlauben', help: 'In jedem Minigame darf einmal ein Hinweis angefordert werden.', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.hint_chance', group: 'Exekutive-Zugang', label: 'Hinweis: Trefferchance (%)', help: 'Wahrscheinlichkeit, dass die Suche einen Hinweis findet – sonst bleibt sie ohne Ergebnis (und der Hinweis ist trotzdem verbraucht).', type: 'number', default: 65, min: 0, max: 100, perm: 'hack.manage' },
    { key: 'hack.hint_seconds', group: 'Exekutive-Zugang', label: 'Hinweis: Ladezeit (Sekunden)', help: 'Mindestdauer, bis das Ergebnis da ist (zufällig bis zu 1 Sekunde länger).', type: 'number', default: 3, min: 0, max: 20, perm: 'hack.manage' },
    { key: 'hack.lives', group: 'Exekutive-Zugang', label: 'Versuche (Leben) pro Zugriff', help: 'Jeder Fehler in einer Stufe kostet ein Leben; bei 0 ist der Zugriff gescheitert.', type: 'number', default: 3, min: 1, max: 10, perm: 'hack.manage' },
    { key: 'hack.max_minutes', group: 'Exekutive-Zugang', label: 'Zeitlimit pro Zugriff (Minuten)', type: 'number', default: 10, min: 2, max: 60, perm: 'hack.manage' },
    { key: 'hack.cooldown_minutes', group: 'Exekutive-Zugang', label: 'Sperrzeit nach Erfolg (Minuten)', help: 'Gilt für den Link insgesamt (alle Beamten gemeinsam).', type: 'number', default: 30, min: 1, max: 10080, perm: 'hack.manage' },
    { key: 'hack.cooldown_fail_minutes', group: 'Exekutive-Zugang', label: 'Sperrzeit nach Misserfolg (Minuten)', type: 'number', default: 15, min: 1, max: 10080, perm: 'hack.manage' },
    { key: 'hack.reward_count', group: 'Exekutive-Zugang', label: 'Datenschnipsel pro Erfolg', type: 'number', default: 3, min: 1, max: 5, perm: 'hack.manage' },
    { key: 'hack.loot_personal', group: 'Exekutive-Zugang', label: 'Beute: Personalkennungen', help: 'Nur Kennung und Rang – nie Namen.', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.loot_warehouse', group: 'Exekutive-Zugang', label: 'Beute: Lager-Teilbestände', help: 'Nur Lagernummer, wenige Positionen, gerundete Mengen.', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.loot_vehicles', group: 'Exekutive-Zugang', label: 'Beute: Fahrzeuge', help: 'Kennzeichen und Modell.', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.loot_deals', group: 'Exekutive-Zugang', label: 'Beute: Geschäftsvorgänge', help: 'Vorgangsnummer, Artikel, Menge – ohne Preis und Partner.', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.loot_contacts', group: 'Exekutive-Zugang', label: 'Beute: Kontaktbuch', help: 'Nur Institutionsname, Art und Anzahl der Einträge – keine Personen, Kontakt- oder Bankdaten, keine gesperrten Einträge.', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.loot_changelog', group: 'Exekutive-Zugang', label: 'Beute: Changelog', help: 'Nur Version und Titel eines Eintrags.', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.loot_board', group: 'Exekutive-Zugang', label: 'Beute: Schwarzes Brett', help: 'Nur die Überschrift einer Info-/Erfolgsmeldung, nie Text oder Dringendes.', type: 'bool', default: true, perm: 'hack.manage' },
    { key: 'hack.loot_partners', group: 'Exekutive-Zugang', label: 'Beute: Externe Zugänge', help: 'Nur die Partnernummer.', type: 'bool', default: true, perm: 'hack.manage' },
  ],
  routes(r) {
    // ── Verwaltung ──
    r.get('/api/hack/admin', { perm: 'hack.manage' }, () => ({
      path: `/x/${linkToken()}`, host: String(getConfig('hack.host') ?? '').trim().toLowerCase() || null, enabled: getConfig('hack.enabled'), cooldownLeftSec: cooldownLeftSec(),
      runs: all('SELECT id, started_at startedAt, ended_at endedAt, success, stage FROM hack_runs ORDER BY id DESC LIMIT 20'),
    }));
    r.post('/api/hack/admin/regenerate', { perm: 'hack.manage' }, (ctx) => {
      setConfig(KEY, randomBytes(18).toString('base64url'), ctx.user.id); sessions.clear();
      audit(ctx, { action: 'hack.link_renewed', module: 'hack', targetType: 'hack', targetLabel: 'Link erneuert' });
      return { path: `/x/${linkToken()}` };
    });
    r.post('/api/hack/admin/reset-cooldown', { perm: 'hack.manage' }, (ctx) => {
      run('UPDATE hack_runs SET ended_at = ? WHERE id = (SELECT MAX(id) FROM hack_runs)', new Date(0).toISOString());
      audit(ctx, { action: 'hack.cooldown_reset', module: 'hack', targetType: 'hack', targetLabel: 'Sperrzeit aufgehoben' });
      return { ok: true };
    });

    // ── Öffentlicher Link (ohne Anmeldung, ohne Kennzeichnung) ──
    const O = { auth: false };
    r.get('/api/h/:token/status', O, (ctx) => { guard(ctx); return { enabled: getConfig('hack.enabled'), cooldownSec: cooldownLeftSec(), lives: lives(), stages: pickPlan().length, hints: !!getConfig('hack.hints') }; });

    r.post('/api/h/:token/start', O, (ctx) => {
      guard(ctx);
      if (!getConfig('hack.enabled')) throw new HttpError(403, 'Verbindung nicht möglich.', 'disabled');
      const left = cooldownLeftSec();
      if (left > 0) throw new HttpError(429, 'Gesperrt.', 'cooldown', { cooldownSec: left });
      const runId = Number(run('INSERT INTO hack_runs (started_at, ip) VALUES (?, ?)', now(), ctx.ip).lastInsertRowid);
      const sid = randomBytes(16).toString('hex');
      const plan = pickPlan(), s = { sid, runId, started: Date.now(), index: 0, lives: lives(), plan, hints: new Set(), stage: makeStage(plan[0]) };
      sessions.set(sid, s);
      audit({ ip: ctx.ip, actorName: 'Unbekannter Zugriff' }, { action: 'hack.started', module: 'hack', targetType: 'hack', targetId: runId, targetLabel: 'Zugriffsversuch gestartet' });
      return { sid, lives: s.lives, maxLives: s.lives, stage: stageDto(s) };
    });

    r.post('/api/h/:token/hint', O, async (ctx) => {
      guard(ctx);
      const s = sessions.get(String(ctx.body.sid ?? ''));
      if (!s || s.done) throw new HttpError(410, 'Verbindung verloren.', 'lost');
      if (!getConfig('hack.hints')) throw new HttpError(403, 'Keine Hinweise verfügbar.', 'disabled');
      if (s.hints.has(s.index)) throw new HttpError(409, 'Hinweis bereits verwendet.', 'used');
      s.hints.add(s.index); // zählt auch, wenn die Suche nichts findet
      const idx = s.index, st = s.stage, secs = Number(getConfig('hack.hint_seconds'));
      if (secs > 0) await sleep((secs + Math.random()) * 1000);
      if (s.done || s.index !== idx || s.stage.type !== st.type) return { hint: null, stale: true };
      const found = randomInt(0, 100) < Number(getConfig('hack.hint_chance'));
      return { hint: found ? makeHint(s.stage) : null };
    });

    r.post('/api/h/:token/answer', O, (ctx) => {
      guard(ctx);
      const s = sessions.get(String(ctx.body.sid ?? ''));
      if (!s || s.done) throw new HttpError(410, 'Verbindung verloren.', 'lost');
      if (Date.now() - s.started > runMs()) { finish(ctx, s, false, 'Zeit abgelaufen'); return { result: 'failed', reason: 'Zeitüberschreitung', cooldownSec: cooldownLeftSec() }; }
      const st = s.stage, a = ctx.body;
      const lose = (feedback) => { // Leben verlieren, neue Aufgabe gleicher Art
        s.lives -= 1;
        if (s.lives <= 0) { finish(ctx, s, false, 'keine Versuche mehr'); return { result: 'failed', reason: 'Rückverfolgung abgeschlossen', cooldownSec: cooldownLeftSec() }; }
        s.stage = makeStage(st.type);
        return { result: 'retry', lives: s.lives, message: feedback, stage: stageDto(s) };
      };
      const advance = () => {
        s.index += 1;
        if (s.index >= s.plan.length) { const rewards = loot(); finish(ctx, s, true); return { result: 'done', rewards, cooldownSec: cooldownLeftSec() }; }
        s.stage = makeStage(s.plan[s.index]);
        return { result: 'ok', lives: s.lives, stage: stageDto(s) };
      };
      switch (st.type) {
        case 'typing': {
          const text = String(a.text ?? ''), ms = Number(a.ms);
          if (!Number.isFinite(ms) || ms < text.length * 45) return lose('Eingabe zu schnell – Muster erkannt.'); // Einfügen/Automaten abwehren
          if (ms > st.secret.limitMs) return lose('Zeit abgelaufen.');
          return text === st.secret.lines.join('\n') ? advance() : lose('Eingabe fehlerhaft.');
        }
        case 'code': {
          const g = String(a.guess ?? '');
          if (g.length !== st.secret.digits.length || !/^\d+$/.test(g)) throw bad(`${st.secret.digits.length} Ziffern eingeben.`);
          st.secret.tries -= 1;
          const d = st.secret.digits;
          const exact = [...g].filter((c, i) => c === d[i]).length;
          const present = [...g].filter((c, i) => c !== d[i] && d.includes(c)).length;
          if (exact === d.length) {
            if (st.secret.round < st.secret.rounds) { s.stage = makeStage('code', { round: st.secret.round + 1 }); return { result: 'reset', message: 'Kennwort geknackt – aber die Abwehr hat es soeben zurückgesetzt! Neues Kennwort, neue Versuche.', stage: stageDto(s) }; }
            return advance();
          }
          if (st.secret.tries <= 0) return lose('Kennwort nicht geknackt.');
          return { result: 'feedback', exact, present, tries: st.secret.tries };
        }
        case 'sequence': {
          const seq = Array.isArray(a.sequence) ? a.sequence.map(Number) : [];
          return seq.length === st.secret.seq.length && seq.every((x, i) => x === st.secret.seq[i]) ? advance() : lose('Falsche Reihenfolge.');
        }
        case 'cipher': return String(a.text ?? '').toUpperCase() === st.secret.word ? advance() : lose('Entschlüsselung falsch.');
        case 'frequency': {
          const g = Number(a.guess);
          if (!Number.isInteger(g) || g < 1 || g > 256) throw bad('Frequenz zwischen 1 und 256 wählen.');
          st.secret.tries -= 1;
          if (g === st.secret.target) return advance();
          if (st.secret.tries <= 0) return lose('Signal verloren.');
          return { result: 'feedback', hint: g < st.secret.target ? 'higher' : 'lower', strength: Math.max(0, Math.round(100 - (Math.abs(g - st.secret.target) / 256) * 100)), tries: st.secret.tries };
        }
        case 'checksum': return Number(a.index) === st.secret.index ? advance() : lose('Falsches Token.');
        case 'match': return Number(a.index) === st.secret.index ? advance() : lose('Falsches Muster.');
        case 'math': {
          const ans = Array.isArray(a.answers) ? a.answers.map(Number) : [], ms = Number(a.ms);
          if (!Number.isFinite(ms) || ms < st.secret.answers.length * 700) return lose('Eingabe zu schnell – Muster erkannt.');
          if (ms > st.secret.limitMs) return lose('Zeit abgelaufen.');
          return ans.length === st.secret.answers.length && ans.every((x, i) => x === st.secret.answers[i]) ? advance() : lose('Prüfsumme falsch.');
        }
        default: throw bad('Ungültig.');
      }
    });
  },
};
