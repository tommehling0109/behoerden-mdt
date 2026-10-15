import { get, run } from '../core/db.js';
import { bad } from '../core/http.js';
import { getConfig, setConfig } from '../core/config.js';

/**
 * Legal: zwei Dokument-Reiter – Gesetzessammlung und Bußgeldkatalog –, je ein Google-Dokument, das live im MDT eingebettet wird, plus die Rechtsfälle (legalcases.js).
 * Dazu der Link zum Codex, der oben im Dashboard angezeigt wird (siehe modules/dashboard.js).
 * Die Links stehen in der Konfiguration (Gruppe „Legal“, Recht „legal.manage“); ohne Link zeigt die Stelle einen Platzhalter.
 * Sehen: „legal.view“.
 */
const KINDS = { document: 'Dokument', spreadsheets: 'Tabelle', presentation: 'Präsentation' };
const SLOTS = [
  ['laws', 'legal.laws_url', 'Link zur Gesetzessammlung', 'Google-Dokument mit der Gesetzessammlung. Wird im Reiter „Gesetzessammlung“ live eingebettet. Leer lassen = Platzhalter.'],
  ['fines', 'legal.fines_url', 'Link zum Bußgeldkatalog', 'Google-Dokument oder -Tabelle mit dem Bußgeldkatalog. Wird im Reiter „Bußgeldkatalog“ live eingebettet. Leer lassen = Platzhalter.'],
  ['codex', 'legal.codex_url', 'Link zum Codex', 'Google-Dokument mit dem Codex. Wird oben im Dashboard für alle angezeigt und dort live eingebettet. Leer lassen = Platzhalter.'],
];

/** Erkennt einen Google-Docs-Link; liefert Art und ID oder wirft einen Fehler. */
function parseGoogle(raw) {
  let u; try { u = new URL(String(raw ?? '').trim()); } catch { throw bad('Bitte einen gültigen Link angeben.'); }
  const m = u.protocol === 'https:' && u.hostname === 'docs.google.com' && /^\/(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{20,})/.exec(u.pathname);
  if (!m) throw bad('Nur Links zu Google Docs, Tabellen oder Präsentationen (https://docs.google.com/…) sind erlaubt.');
  return { kind: m[1], docId: m[2], tab: /^t\.[A-Za-z0-9]+$/.test(u.searchParams.get('tab') ?? '') ? u.searchParams.get('tab') : null };
}
const dto = (url) => {
  const raw = String(url ?? '').trim(); if (!raw) return null;
  let g; try { g = parseGoogle(raw); } catch { return null; }
  return {
    url: raw, kind: g.kind, kindLabel: KINDS[g.kind],
    embedUrl: `https://docs.google.com/${g.kind}/d/${g.docId}/preview`, // live: lädt immer den aktuellen Stand des Dokuments
    openUrl: `https://docs.google.com/${g.kind}/d/${g.docId}/edit${g.tab ? `?tab=${g.tab}` : ''}`,
  };
};

/** Codex für das Dashboard: eingebettetes Dokument oder null (Platzhalter). */
export const codexInfo = () => dto(getConfig('legal.codex_url'));

export default {
  name: 'legal',
  permissions: [
    ['legal.view', 'Legal: Gesetzessammlung, Bußgeldkatalog und Rechts-Bereiche ansehen'],
    ['legal.manage', 'Legal: Links zu Gesetzessammlung, Bußgeldkatalog und Codex in der Konfiguration hinterlegen und ändern'],
  ],
  config: SLOTS.map(([, key, label, help]) => ({ key, group: 'Legal', label, help, type: 'string', default: '', max: 500, allowEmpty: true, perm: 'legal.manage', check: (v) => { parseGoogle(v); } })),
  init() {
    // Einmalig: bestehende Rechte vergeben …
    if (!get("SELECT 1 x FROM sequences WHERE name = 'legal_seeded'")) {
      run("INSERT INTO sequences (name,next_value) VALUES ('legal_seeded',1)");
      if (get("SELECT 1 x FROM permissions WHERE key = 'legal.view'")) run("INSERT OR IGNORE INTO role_permissions (role_id,permission_key) SELECT id, 'legal.view' FROM roles");
    }
    // … und das bisher hinterlegte Dokument (frühere „Dokumente verwalten“-Liste) als Link der Gesetzessammlung übernehmen
    if (!get("SELECT 1 x FROM sequences WHERE name = 'legal_links_migrated'")) {
      run("INSERT INTO sequences (name,next_value) VALUES ('legal_links_migrated',1)");
      const old = get('SELECT url FROM legal_docs ORDER BY sort_order, id LIMIT 1');
      if (old?.url && !get("SELECT 1 x FROM settings WHERE key = 'legal.laws_url'")) setConfig('legal.laws_url', old.url, null);
    }
  },
  routes(r) {
    r.get('/api/legal', { perm: 'legal.view' }, (ctx) => ({
      laws: dto(getConfig('legal.laws_url')), fines: dto(getConfig('legal.fines_url')),
      canManage: ctx.user.perms.has('legal.manage'), canCases: ctx.user.perms.has('legal.cases.view'),
    }));
  },
};
