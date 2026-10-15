// Erzeugt die Anleitung als PDF: node docs/anleitung/build.mjs  (benötigt Chrome/Edge und Python mit pypdf für die Seitenzahlen im Inhaltsverzeichnis)
// Screenshots: docs/anleitung/img (erzeugt mit headless Chrome, siehe Projektverlauf); Text: docs/anleitung/inhalt.html; Rechte: docs/RECHTE.md
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..', '..');
const OUT_PDF = join(ROOT, 'docs', 'Anleitung-MDT.pdf'), OUT_HTML = join(HERE, 'anleitung.html'), PAGES = join(HERE, 'pages.json');
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/EdgeCore/154.0.4258.62/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => p && existsSync(p));
if (!CHROME) throw new Error('Kein Chrome/Edge gefunden (Umgebungsvariable CHROME setzen).');

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const imgs = readdirSync(join(HERE, 'img')).filter((f) => f.endsWith('.jpg'));
const imgFor = (key) => { const suf = key.replace(/^\d+-/, ''); const f = imgs.find((x) => x.replace(/^\d+-/, '') === `${suf}.jpg`); if (!f) throw new Error('Screenshot fehlt: ' + key); return f; };

let body = readFileSync(join(HERE, 'inhalt.html'), 'utf8');
// Überschriften nummerieren + Inhaltsverzeichnis sammeln
const toc = []; let ch = 0, sec = 0;
body = body.replace(/<h([12])( class="anhang")?>(.*?)<\/h\1>/g, (_m, lvl, anh, text) => {
  if (lvl === '1') { if (!anh) ch++; sec = 0; const id = anh ? `a${toc.length}` : `k${ch}`; const num = anh ? '' : `${ch}`; toc.push({ lvl: 1, id, num, text }); return `<h1 id="${id}"${anh ? ' class="anhang"' : ''}>${num ? `<span class="n">${num}</span>` : ''}${text}</h1>`; }
  sec++; const id = `k${ch}-${sec}`, num = `${ch}.${sec}`; toc.push({ lvl: 2, id, num, text }); return `<h2 id="${id}"><span class="n">${num}</span>${text}</h2>`;
});
// Abbildungen
let fig = 0;
body = body.replace(/\{\{fig:([^|}]+)\|([^}]*)\}\}/g, (_m, key, cap) => `<figure><img src="img/${imgFor(key)}" alt=""><figcaption><b>Abbildung ${++fig}:</b> ${cap}</figcaption></figure>`);
// Rechte-Anhang aus docs/RECHTE.md
function rightsHtml() {
  const md = readFileSync(join(ROOT, 'docs', 'RECHTE.md'), 'utf8'), start = md.indexOf('## Rechte (');
  const part = md.slice(start).split(/\n## /)[0]; let out = '';
  for (const block of part.split(/\n### /).slice(1)) {
    const [name, ...lines] = block.split('\n'); const rows = lines.filter((l) => l.startsWith('| `')).map((l) => l.split('|').map((c) => c.trim()).filter(Boolean));
    out += `<h3 class="mod">${esc(name)}</h3><table class="rt"><tr><th style="width:34%">Recht</th><th>Bedeutung</th></tr>${rows.map(([k, d]) => `<tr><td><code>${esc(k.replace(/`/g, ''))}</code></td><td>${esc(d)}</td></tr>`).join('')}</table>`;
  }
  return out;
}
body = body.replace('{{rights}}', rightsHtml());

const pages = existsSync(PAGES) ? JSON.parse(readFileSync(PAGES, 'utf8')) : {};
const tocHtml = `<div class="toc"><h1 class="plain">Inhaltsverzeichnis</h1>${toc.map((t) => `<div class="t${t.lvl}"><a href="#${t.id}"><span class="tn">${t.num}</span><span class="tt">${t.text}</span><span class="dots"></span><span class="tp">${pages[t.id] ?? ''}</span></a></div>`).join('')}</div>`;
const commit = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'lokal'; } })();
const today = new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
const logo = pathToFileURL(join(ROOT, 'public', 'img', 'logo.svg')).href;

const css = `
@page { size: A4; margin: 20mm 17mm 20mm 17mm; @bottom-center { content: counter(page); font: 9pt 'Segoe UI', sans-serif; color: #7b8494; } @bottom-left { content: 'MDT – Handbuch'; font: 8.5pt 'Segoe UI', sans-serif; color: #9aa3b2; } @bottom-right { content: 'Stand ${today}'; font: 8.5pt 'Segoe UI', sans-serif; color: #9aa3b2; } }
@page :first { margin: 0; @bottom-center { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
:root { --ink: #1c2230; --muted: #5b6577; --accent: #3b5fc9; --line: #d9dfeb; --soft: #f3f6fc; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 10.5pt/1.55 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; color: var(--ink); }
.cover { height: 297mm; width: 210mm; page-break-after: always; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; padding: 0 24mm; color: #fff; background: radial-gradient(1200px 700px at 85% 15%, #2c3d78 0%, transparent 60%), radial-gradient(900px 600px at 5% 95%, #1d4f6b 0%, transparent 55%), linear-gradient(160deg, #0d1226 0%, #141b36 55%, #0b1020 100%); position: relative; overflow: hidden; }
.cover img { width: 62mm; opacity: 0.95; margin-bottom: 14mm; filter: drop-shadow(0 6px 24px rgba(80,120,255,.35)); }
.cover h1 { font-size: 34pt; line-height: 1.12; margin: 0 0 6mm; letter-spacing: -0.01em; border: 0; padding: 0; color: #fff; page-break-before: avoid; }
.cover .sub { font-size: 15pt; color: #b9c6ee; margin-bottom: 20mm; max-width: 130mm; }
.cover .meta { font-size: 10.5pt; color: #94a3d1; border-top: 1px solid rgba(255,255,255,.22); padding-top: 5mm; width: 100%; }
.cover .meta b { color: #fff; }
.cover::after { content: ''; position: absolute; right: -30mm; bottom: -30mm; width: 120mm; height: 120mm; border-radius: 50%; background: radial-gradient(circle, rgba(88,130,255,.25), transparent 65%); }
h1 { font-size: 22pt; line-height: 1.2; margin: 0 0 7mm; padding-bottom: 3mm; border-bottom: 3px solid var(--accent); page-break-before: always; page-break-after: avoid; color: #14204a; }
h1.plain { page-break-before: auto; }
h1 .n { display: inline-block; min-width: 13mm; color: var(--accent); }
h2 { font-size: 15pt; margin: 9mm 0 3mm; color: #1b2b63; page-break-after: avoid; }
h2 .n { display: inline-block; min-width: 13.5mm; color: var(--accent); }
h3 { font-size: 11.5pt; margin: 6mm 0 2mm; color: #27345f; page-break-after: avoid; }
h3.mod { text-transform: uppercase; letter-spacing: .08em; font-size: 9.5pt; color: var(--accent); margin-top: 5mm; }
p { margin: 0 0 3mm; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 3.5mm; padding-left: 6mm; } li { margin-bottom: 1.2mm; }
code { font: 9pt Consolas, 'Cascadia Mono', monospace; background: #eef2fb; border: 1px solid #dde4f3; border-radius: 3px; padding: 0 3px; color: #223172; }
kbd { font: 8.5pt Consolas, monospace; background: #fff; border: 1px solid #b9c2d6; border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; }
table { border-collapse: collapse; width: 100%; margin: 2mm 0 5mm; font-size: 9.5pt; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th { background: #e8eefc; color: #1b2b63; text-align: left; padding: 2mm 2.5mm; border: 1px solid var(--line); }
td { padding: 1.8mm 2.5mm; border: 1px solid var(--line); vertical-align: top; }
tbody tr:nth-child(even) td, table tr:nth-child(even) td { background: #fafbfe; }
figure { margin: 4mm 0 6mm; page-break-inside: avoid; text-align: center; }
figure img { width: 100%; border: 1px solid #c4cce0; border-radius: 6px; box-shadow: 0 3px 14px rgba(25,35,80,.18); }
figcaption { font-size: 8.8pt; color: var(--muted); margin-top: 2mm; }
.tip, .warn, .rights { border-radius: 6px; padding: 2.5mm 3.5mm; margin: 3mm 0 4mm; font-size: 9.8pt; page-break-inside: avoid; }
.tip { background: #eaf6ee; border-left: 4px solid #2f9e5b; }
.warn { background: #fff3e0; border-left: 4px solid #e08a00; }
.rights { background: var(--soft); border-left: 4px solid var(--accent); color: #2a3558; }
.b-info, .b-warn, .b-err, .b-ok { font-weight: 700; padding: 0 5px; border-radius: 3px; }
.b-info { background: #dfe9ff; color: #2147a8; } .b-warn { background: #ffe9c7; color: #8a5200; } .b-err { background: #ffd9d9; color: #a41d1d; } .b-ok { background: #d6f3e3; color: #14683a; }
.toc { page-break-after: always; } .toc h1 { border: 0; }
.toc div { margin: 0; } .toc a { display: flex; align-items: baseline; text-decoration: none; color: inherit; gap: 2mm; }
.toc .t1 { margin-top: 3.2mm; font-weight: 700; font-size: 10.8pt; color: #14204a; } .toc .t2 { font-size: 9.8pt; padding-left: 9mm; color: #333c52; line-height: 1.7; }
.toc .tn { min-width: 9mm; color: var(--accent); } .toc .dots { flex: 1; border-bottom: 1px dotted #aab3c7; transform: translateY(-2px); } .toc .tp { min-width: 8mm; text-align: right; }
h1.anhang { margin-top: 0; }
`;

const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>MDT – Handbuch</title><style>${css}</style></head><body>
<section class="cover"><img src="${logo}" alt=""><h1>MDT<br>Das komplette Handbuch</h1><div class="sub">Bedienung, Administration und Betrieb des gesamten Panels – Schritt für Schritt erklärt, mit Beispielen aus dem laufenden System.</div>
<div class="meta"><b>Stand:</b> ${today} &nbsp;·&nbsp; <b>Programmstand:</b> ${commit} &nbsp;·&nbsp; <b>Umfang:</b> ${fig} Abbildungen, ${toc.filter((t) => t.lvl === 1 && t.num).length} Kapitel, 2 Anhänge</div></section>
${tocHtml}
${body}
</body></html>`;
writeFileSync(OUT_HTML, html);

function render() {
  const tmp = join(process.env.TEMP ?? '.', 'chrome-pdf-profile'); rmSync(tmp, { recursive: true, force: true });
  const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${tmp}`, '--allow-file-access-from-files', '--no-pdf-header-footer', `--print-to-pdf=${OUT_PDF}`, '--virtual-time-budget=20000', pathToFileURL(OUT_HTML).href], { encoding: 'utf8', timeout: 240000 });
  if (!existsSync(OUT_PDF)) throw new Error('PDF wurde nicht erzeugt: ' + (r.stderr ?? '').slice(0, 400));
}
render();

// Zweiter Durchgang: Seitenzahlen ins Inhaltsverzeichnis (Überschrift im PDF suchen)
if (!process.argv.includes('--once')) {
  const py = `
import json, re, sys
from pypdf import PdfReader
toc = json.loads(sys.argv[2]); r = PdfReader(sys.argv[1]); texts = [(p.extract_text() or '') for p in r.pages]
norm = lambda s: re.sub(r'\\s+', '', s)
res = {}
for t in toc:
    key = norm((t['num'] or '') + re.sub('<[^>]+>', '', t['text']).replace('&amp;', '&'))
    hits = [i + 1 for i, tx in enumerate(texts) if key in norm(tx)]
    # Inhaltsverzeichnis (frühe Seiten) überspringen: letzte Fundstelle nehmen
    if hits: res[t['id']] = hits[-1]
print(json.dumps(res))
print(len(texts), file=sys.stderr)
`;
  const run = spawnSync('python', ['-I', '-c', py, OUT_PDF, JSON.stringify(toc)], { encoding: 'utf8' });
  if (run.status === 0) { writeFileSync(PAGES, run.stdout); console.log('Seiten:', run.stderr.trim()); } else console.warn('Seitenzahlen nicht ermittelt:', run.stderr.slice(0, 300));
  // neu bauen mit Seitenzahlen
  spawnSync('node', [fileURLToPath(import.meta.url), '--once'], { stdio: 'inherit' });
}
console.log('PDF:', OUT_PDF);
