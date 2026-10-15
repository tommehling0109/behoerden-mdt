// Erzeugt docs/RECHTE.md direkt aus dem Code (Rechte-Registry + alle Routen), damit die Doku nie von der Wirklichkeit abweicht.
import { readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
process.env.MDT_DB = tmpdir() + '/genrights-' + process.pid + '.db';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)).split('\\').join('/');
const { buildApp } = await import('file:///' + root + 'server/app.js');
buildApp();
const { listPermissions } = await import('file:///' + root + 'server/core/permissions.js');
const perms = listPermissions();

const rows = [];
const dir = root + 'server/modules/';
for (const f of readdirSync(dir)) {
  const m = (await import('file:///' + dir + f)).default;
  if (!m?.routes) continue;
  const mk = (method) => (path, a) => { const o = typeof a === 'function' ? {} : a; rows.push({ mod: m.name, method, path, auth: o.auth ?? true, perm: [].concat(o.perm ?? []), app: o.partnerApp ?? '' }); };
  m.routes({ get: mk('GET'), post: mk('POST'), put: mk('PUT'), patch: mk('PATCH'), delete: mk('DELETE') });
}

const byModule = {};
for (const p of perms) (byModule[p.module] ??= []).push(p);
let out = '# Rechte-Matrix\n\n*Diese Datei wird aus dem Code erzeugt (`node scripts/gen-rights.mjs`) – nicht von Hand ändern.*\n\n';
out += '## Grundregeln\n\n';
out += '- **Superadmin**: feste Rolle, entsteht bei der Einrichtung (erster Benutzer), **nicht veränderbar und nicht vergebbar**. Hat automatisch **alle** Rechte und darf alles endgültig löschen (jeder Status) sowie das Panel zurücksetzen. Nur der Superadmin ändert Personalnummern.\n';
out += '- **Administrator-Rollen** (`is_admin`): haben automatisch alle fachlichen Rechte, dürfen aber nur von Administratoren/Superadmins vergeben und bearbeitet werden. Superadmins dürfen nur von Superadmins verwaltet werden.\n';
out += '- Alle anderen: ausschließlich die Rechte aus **Rolle(n)**, **Rang** und **direkten Rechten**. Rechte vergeben darf nur, wer sie selbst besitzt (keine Rechteausweitung).\n';
out += '- Mehrere Rechte bei einer Route (`a | b`) bedeuten: **eines davon genügt** (z. B. Lesezugriff für verschiedene Rollen). Schreibende Routen verlangen immer genau das Recht der Aktion.\n';
out += '- Namen von Mitgliedern sieht man nur bei sich selbst, als Superadmin und bei Mitgliedern **unterhalb** der eigenen Hierarchie (übergeordneter Rang / Vorgesetzten-Kette); sonst nur die Personalnummer.\n';
out += '- Statistik: `stats.view` öffnet die App, jeder Abschnitt erscheint zusätzlich nur mit dem Ansichtsrecht des jeweiligen Bereichs.\n\n';
out += `## Rechte (${perms.length})\n\n`;
for (const [m, list] of Object.entries(byModule)) {
  out += `### ${m}\n\n| Recht | Bedeutung |\n|---|---|\n`;
  for (const p of list) out += `| \`${p.key}\` | ${p.description} |\n`;
  out += '\n';
}
out += '## Routen und benötigte Rechte (Mitarbeiter)\n\n| Methode | Pfad | Recht (eines davon) |\n|---|---|---|\n';
for (const r of rows.filter((x) => !/^\/api\/(p|c)\//.test(x.path))) out += `| ${r.method} | \`${r.path}\` | ${r.perm.length ? r.perm.map((p) => `\`${p}\``).join(' \\| ') : (r.auth === false ? '*öffentlich*' : '*angemeldet (eigene Daten)*')} |\n`;
out += '\n## Externe Zugänge (Partner-Portal) und Firmenportal\n\n| Methode | Pfad | Voraussetzung |\n|---|---|---|\n';
for (const r of rows.filter((x) => /^\/api\/(p|c)\//.test(x.path))) out += `| ${r.method} | \`${r.path}\` | ${r.auth === false ? (r.path.startsWith('/api/c/') ? 'persönlicher Firmen-Link' : 'Zugangs-Link / Code') : `externer Zugang${r.app ? `, App „${r.app}“ freigeschaltet` : ''}`} |\n`;
writeFileSync(root + 'docs/RECHTE.md', out);
console.log('docs/RECHTE.md', out.length, 'Zeichen,', perms.length, 'Rechte,', rows.length, 'Routen');
