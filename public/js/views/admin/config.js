import { h, mount } from '../../ui/dom.js';
import { button, busy, card, field, input, select, toggle, toast, skeletons, formError, empty, note, openModal, levelBadge } from '../../ui/kit.js';
import { fmtDateTime } from '../../ui/dom.js';
import { api } from '../../api.js';
import { icon } from '../../ui/icons.js';
import { can, state, applyConfig } from '../../state.js';
import { NAV, allItems, defaultDockLayout } from '../../modules.js';

const SWATCHES = ['#4f8cff', '#22d3ee', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#94a3b8'];

/** Rendert pro Einstellungstyp das passende Eingabeelement und liefert { el, get }. */
function control(s, disabled) {
  switch (s.type) {
    case 'bool': { const t = toggle(s.value ? 'Aktiviert' : 'Deaktiviert', s.value, null); t.input.disabled = disabled;
      t.input.addEventListener('change', () => (t.lastChild.firstChild.textContent = t.input.checked ? 'Aktiviert' : 'Deaktiviert'));
      return { el: t, get: () => t.input.checked }; }
    case 'number': { const i = input({ type: 'number', value: s.value, min: s.min, max: s.max, disabled }); return { el: i, get: () => Number(i.value) }; }
    case 'select': { const sel = select(s.options, s.value, { disabled }); return { el: sel, get: () => sel.value }; }
    case 'color': {
      const i = input({ type: 'color', value: s.value, class: 'input input-color', disabled });
      const wrap = h('div', null, i, h('div', { class: 'swatches' }, SWATCHES.map((c) => h('button', { type: 'button', class: 'swatch', style: { '--s': c }, disabled, 'aria-label': c,
        onclick: () => { i.value = c; i.dispatchEvent(new Event('input')); } }))));
      return { el: wrap, get: () => i.value };
    }
    default: { const i = input({ value: s.value, maxLength: s.max ?? 80, disabled }); return { el: i, get: () => i.value }; }
  }
}

const readAsDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Datei konnte nicht gelesen werden.')); r.readAsDataURL(file); });
const BRANDING = [
  { kind: 'logo', label: 'Logo', help: 'Wird im App-Menü, auf dem Anmeldebildschirm, als Wasserzeichen und als Favicon verwendet. Transparentes PNG oder WebP (weiß/hell) empfohlen, max. 2 MB.', max: 2 },
  { kind: 'wallpaper', label: 'Hintergrundbild', help: 'Ersetzt den Standard-Hintergrund auf dem Desktop und dem Anmeldebildschirm. Empfohlen: 1920×1080, PNG/JPEG/WebP, max. 8 MB.', max: 8, wide: true },
];

/** Karte „Logo & Hintergrund“: eigene Bilder hochladen oder auf den Standard zurücksetzen. */
function brandingCard(host, editable) {
  const body = h('div');
  host.append(card('Logo & Hintergrund', body, { icon: 'palette', flush: true }));
  const draw = () => mount(body, BRANDING.map((b) => {
    const version = state.config[`branding.${b.kind}_version`];
    const url = version ? `/branding/${b.kind}?v=${version}` : (b.kind === 'logo' ? '/img/logo.svg' : null);
    const preview = h('div', { class: `brand-preview ${b.wide ? 'wide' : ''}`, style: url ? { backgroundImage: `url(${url})` } : {} }, !url && h('span', { class: 'muted' }, 'Standard-Hintergrund'));
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > b.max * 1024 * 1024) return toast(`Die Datei ist zu groß (maximal ${b.max} MB).`, 'err');
      try {
        const { version: v } = await api.post(`/api/admin/branding/${b.kind}`, { data: await readAsDataUrl(f) });
        applyConfig({ ...state.config, [`branding.${b.kind}_version`]: v });
        toast(`${b.label} aktualisiert.`); draw();
      } catch (ex) { toast(ex.message, 'err'); }
      file.value = '';
    });
    return h('div', { class: 'brand-row' }, preview,
      h('div', null, h('div', { class: 'lbl' }, b.label), h('div', { class: 'hlp', style: { marginBottom: '10px' } }, b.help),
        editable && h('div', { class: 'row' }, file, button('Bild hochladen', { icon: 'download', size: 'sm', onClick: () => file.click() }),
          version ? button('Auf Standard zurücksetzen', { size: 'sm', variant: 'ghost', onClick: async () => {
            try { await api.del(`/api/admin/branding/${b.kind}`); applyConfig({ ...state.config, [`branding.${b.kind}_version`]: 0 }); toast('Zurückgesetzt.'); draw(); } catch (ex) { toast(ex.message, 'err'); }
          } }) : null)));
  }));
  draw();
}

/** Karte „Exekutive-Zugang (Hack-Link)“: Link abrufen/erneuern, Sperrzeit aufheben, Zugriffsprotokoll. */
function hackCard(host) {
    const hkHost = h('div');
    host.append(card('Exekutive-Zugang (Hack-Link)', hkHost, { icon: 'lock', flush: true }));
    const drawHack = (d) => {
      const url = d.host ? `https://${d.host}` : `${location.origin}${d.path}`;
      const urlBox = input({ value: url, readOnly: true, class: 'input mono' }); urlBox.addEventListener('focus', () => urlBox.select());
      mount(hkHost,
        h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr)' } },
          h('div', null, h('div', { class: 'lbl' }, d.host ? 'Link für die Exekutive (eigene Subdomain)' : 'Dauerhafter Link für die Exekutive'),
            h('div', { class: 'hlp' }, 'Ohne Anmeldung nutzbar, zeigt weder Namen noch Logo des Systems. Mehrere zufällig gezogene Minigames, danach zufällige Datenschnipsel (nur Personalkennungen, Teilbestände, Kennzeichen, Vorgangsnummern – nie Klarnamen oder Telefonnummern) und eine Sperrzeit. Einstellungen (aktiv, Sperrzeit, Anzahl Schnipsel) stehen oben unter „Exekutive-Zugang“.'), urlBox,
            h('div', { class: 'row', style: { marginTop: '10px' } },
              button('Link kopieren', { icon: 'link', size: 'sm', onClick: async () => { try { await navigator.clipboard.writeText(url); toast('Link kopiert.'); } catch { urlBox.select(); toast('Zum Kopieren Strg+C drücken.', 'info'); } } }),
              !d.host && button('Link erneuern', { icon: 'refresh', size: 'sm', variant: 'ghost', onClick: async () => {
                try { await api.post('/api/hack/admin/regenerate'); toast('Neuer Link erstellt – der alte funktioniert nicht mehr.'); drawHack(await api.get('/api/hack/admin')); } catch (ex) { toast(ex.message, 'err'); }
              } }),
              button(d.cooldownLeftSec > 0 ? `Sperrzeit aufheben (noch ${Math.ceil(d.cooldownLeftSec / 60)} Min.)` : 'Keine Sperrzeit aktiv', { size: 'sm', variant: 'ghost', disabled: d.cooldownLeftSec <= 0, onClick: async () => {
                try { await api.post('/api/hack/admin/reset-cooldown'); toast('Sperrzeit aufgehoben.'); drawHack(await api.get('/api/hack/admin')); } catch (ex) { toast(ex.message, 'err'); }
              } })))),
        d.runs.length ? d.runs.map((r) => h('div', { class: 'list-row' }, h('div', { class: 'dot-icon' }, icon(r.success ? 'check' : 'alert')),
          h('div', { class: 'grow' }, h('div', { class: 't' }, r.success ? 'Zugriff erfolgreich' : r.endedAt ? `Abgewehrt (in Stufe ${r.stage + 1})` : 'Abgebrochen / läuft'), h('div', { class: 's' }, fmtDateTime(r.startedAt))))) : h('div', { class: 'muted', style: { padding: '12px 20px' } }, 'Noch keine Zugriffsversuche.'));
    };
    api.get('/api/hack/admin').then(drawHack).catch((e) => mount(hkHost, empty('Nicht verfügbar', e.message, 'alert')));
}

/** Zusatzkarten: Logo/Hintergrund, Dashboard-Widgets (Sichtbarkeit/Reihenfolge) und Datensicherung. */
async function addExtras(host, editable) {
  brandingCard(host, editable);
  // Dashboard-Widgets
  const dashHost = h('div');
  host.append(card('Dashboard-Widgets', dashHost, { icon: 'dashboard', flush: true }));
  async function drawWidgets(widgets) {
    const save = async (list) => {
      try { const res = await api.put('/api/dashboard/layout', { widgets: list.map((w) => ({ id: w.id, enabled: w.enabled })) }); drawWidgets(res.widgets); toast('Dashboard gespeichert.'); }
      catch (e) { toast(e.message, 'err'); }
    };
    mount(dashHost, widgets.map((w, i) => {
      const t = toggle('', w.enabled, null); t.input.disabled = !editable;
      t.input.addEventListener('change', () => save(widgets.map((x) => (x.id === w.id ? { ...x, enabled: t.input.checked } : x))));
      return h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr) auto', padding: '12px 20px' } },
        h('div', null, h('div', { class: 'lbl' }, w.title), h('div', { class: 'hlp' }, w.permission ? `Sichtbar mit Recht: ${w.permission}` : 'Für alle freigeschalteten Benutzer')),
        h('div', { class: 'row' }, editable && button('', { size: 'sm', variant: 'ghost', icon: 'chevronU', title: 'Nach oben', disabled: i === 0, onClick: () => { const l = [...widgets]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; save(l); } }),
          editable && button('', { size: 'sm', variant: 'ghost', icon: 'chevronD', title: 'Nach unten', disabled: i === widgets.length - 1, onClick: () => { const l = [...widgets]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; save(l); } }), t));
    }));
  }
  try { drawWidgets((await api.get('/api/dashboard/layout')).widgets); } catch (e) { mount(dashHost, empty('Nicht verfügbar', e.message, 'alert')); }

  // Updates: installierter Stand vs. neuester Stand auf GitHub (Superadmin/Administratoren werden zusätzlich benachrichtigt)
  const updHost = h('div');
  host.append(card('Programm-Updates', updHost, { icon: 'refresh', flush: true }));
  const drawUpdate = (u) => mount(updHost, h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr) auto' } },
    h('div', null, h('div', { class: 'lbl' }, `Installiert: ${u.installed}`),
      h('div', { class: 'hlp' }, u.error ? `Prüfung nicht möglich: ${u.error}`
        : !u.latest ? 'Noch nicht geprüft (automatisch alle 6 Stunden, oder jetzt prüfen).'
          : u.available === null ? `Neuester Stand auf GitHub: ${u.latest.short} – dieser Stand kennt keinen Git-Commit (ZIP-Download), ein Vergleich ist nicht möglich.`
            : u.available ? `Update verfügbar: ${u.latest.short} – ${u.latest.message}` : `Aktuell – du hast den neuesten Stand (${u.latest.short}).`),
      u.available && h('div', { class: 'hlp' }, 'Server aktualisieren: im Installationsordner „update-mdt.sh“ (Linux) bzw. „update-mdt.ps1“ (Windows) ausführen, danach im Browser STRG+F5.'),
      u.checkedAt && h('div', { class: 'hlp' }, `Zuletzt geprüft: ${fmtDateTime(u.checkedAt)}`)),
    h('div', { class: 'row' }, u.available && u.latest?.url && h('a', { class: 'btn btn-sm', href: u.latest.url, target: '_blank', rel: 'noopener' }, 'Änderungen ansehen'),
      button('Jetzt prüfen', { icon: 'refresh', variant: u.available ? '' : 'primary', onClick: (e) => busy(e.currentTarget, async () => { try { drawUpdate(await api.post('/api/admin/update/check')); } catch (ex) { toast(ex.message, 'err'); } }) }))));
  api.get('/api/admin/update').then(drawUpdate).catch((e) => mount(updHost, empty('Nicht verfügbar', e.message, 'alert')));

  if (can('hack.manage')) hackCard(host);

  // Gefahrenzone: Panel auf null setzen (nur Superadmin)
  if (state.user.isSuperadmin) {
    host.append(card('Gefahrenzone', h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr) auto' } },
      h('div', null, h('div', { class: 'lbl' }, 'Panel auf null zurücksetzen'), h('div', { class: 'hlp' }, 'Löscht ALLE Daten (Benutzer, Rollen, Börse, Kredite, Deckel, Chat, Lager, Fahrzeuge, Einstellungen, Audit-Log, hochgeladene Dateien). Das Programm bleibt installiert – es muss nichts neu geladen werden. Vorher wird automatisch eine Datensicherung angelegt.')),
      button('Zurücksetzen …', { variant: 'danger', icon: 'trash', onClick: () => resetDialog() })), { icon: 'alert', flush: true }));
  }

  // Datensicherung
  if (!can('system.backup')) return;
  const bkHost = h('div');
  host.append(card('Datensicherung', bkHost, { icon: 'server', flush: true }));
  async function drawBackups() {
    const data = await api.get('/api/admin/backups');
    mount(bkHost, h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr) auto' } },
      h('div', null, h('div', { class: 'lbl' }, 'Datenbank sichern'), h('div', { class: 'hlp' }, `Erstellt eine konsistente Kopie im Ordner ${data.directory}. Die letzten 15 Sicherungen bleiben erhalten.`)),
      button('Backup erstellen', { icon: 'download', variant: 'primary', onClick: (e) => busy(e.currentTarget, async () => { try { await api.post('/api/admin/backups'); toast('Backup erstellt.'); drawBackups(); } catch (ex) { toast(ex.message, 'err'); } }) })),
    data.backups.map((b) => h('div', { class: 'list-row' }, h('div', { class: 'dot-icon' }, icon('server')), h('div', { class: 'grow' }, h('div', { class: 't mono' }, b.name), h('div', { class: 's' }, fmtDateTime(b.createdAt))),
      h('span', { class: 'muted' }, `${(b.size / 1024 / 1024).toFixed(2)} MB`))));
  }
  drawBackups().catch((e) => mount(bkHost, empty('Nicht verfügbar', e.message, 'alert')));
}

function resetDialog() {
  const err = h('div'); const text = input({ placeholder: 'ALLES LÖSCHEN', autocomplete: 'off' }); const pw = input({ type: 'password', autocomplete: 'current-password' });
  const go = button('Alles endgültig löschen', { variant: 'danger', icon: 'trash', disabled: true, onClick: (e) => busy(e.currentTarget, async () => {
    err.replaceChildren();
    try { await api.post('/api/admin/reset', { confirm: text.value, password: pw.value }); toast('Das Panel wurde zurückgesetzt.'); setTimeout(() => location.replace('/reset'), 600); }
    catch (ex) { err.replaceChildren(formError(ex.message)); }
  }) });
  text.addEventListener('input', () => { go.disabled = text.value !== 'ALLES LÖSCHEN'; });
  const m = openModal({ title: 'Panel wirklich auf null setzen?', body: h('div', null, err,
    note('Alle Daten werden unwiderruflich gelöscht – auch alle Benutzer, auch dein eigener. Danach erscheint wieder die Ersteinrichtung. Eine automatische Datensicherung wird vorher im Ordner „backups“ angelegt.', 'alert'), h('div', { style: { height: '12px' } }),
    field('Zur Bestätigung „ALLES LÖSCHEN“ eintippen', text), field('Dein Passwort', pw)),
  footer: [button('Abbrechen', { onClick: () => m.close() }), go] });
}

/** Hauptkategorien der Konfiguration: Gruppen (Karten) werden darunter einsortiert; unbekannte Gruppen landen unter „Weitere“. */
const CATS = [
  { id: 'system', title: 'System & Zugang', icon: 'server', groups: ['Allgemein', 'Zugang', 'Mitglieder', 'Apps', 'Dock', 'Updates', 'Programm-Updates', 'Datensicherung', 'Gefahrenzone'] },
  { id: 'look', title: 'Darstellung', icon: 'palette', groups: ['Darstellung', 'Logo & Hintergrund', 'Dashboard', 'Dashboard-Widgets'] },
  { id: 'modules', title: 'Apps & Module', icon: 'sliders', groups: ['Hilfe', 'Börse', 'Lager', 'Fahrzeuge', 'Karte', 'Kredit', 'Deckel', 'Tickets', 'Termine & Aufträge', 'Legal', 'Level', 'Level-Stufen'] },
  { id: 'external', title: 'Externe & Sonderzugänge', icon: 'link', groups: ['Externe Zugänge (neutral)', 'Exekutive-Zugang', 'Exekutive-Zugang (Hack-Link)'] },
];
const OPEN_KEY = 'mdt.cfg.open.v1';
const loadOpen = () => { try { return JSON.parse(localStorage.getItem(OPEN_KEY)) ?? {}; } catch { return {}; } };
const saveOpen = (o) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(o)); } catch { /* egal */ } };

/** Karte „Apps“: Apps für alle Benutzer aktivieren/deaktivieren (nur mit Recht „system.apps“, d. h. Superadmin). Verwaltungs-Apps lassen sich nicht abschalten. */
function appsCard(host) {
  const body = h('div');
  host.append(card('Apps', body, { icon: 'dashboard', flush: true }));
  const items = NAV.filter((s) => s.section !== 'Administration').flatMap((s) => s.items.map((i) => ({ ...i, section: s.section })));
  const draw = () => {
    const off = new Set(state.config['system.disabled_apps'] ?? []);
    mount(body, h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr)' } }, h('div', null, h('div', { class: 'lbl' }, 'Apps für alle Benutzer'), h('div', { class: 'hlp' }, 'Deaktivierte Apps verschwinden sofort bei allen Mitarbeitern (Dock, Startmenü, Desktop) und sind auch über die Schnittstelle gesperrt. Daten bleiben erhalten. Konfiguration, Benutzer, Rollen & Co. lassen sich nicht abschalten.'))),
      items.map((i) => {
        const t = toggle('', !off.has(i.id), null);
        t.input.addEventListener('change', async () => {
          const next = new Set(state.config['system.disabled_apps'] ?? []);
          t.input.checked ? next.delete(i.id) : next.add(i.id);
          try { const list = [...next]; await api.put('/api/config', { values: { 'system.disabled_apps': list } }); applyConfig({ ...state.config, 'system.disabled_apps': list }); toast(`${i.label} ${t.input.checked ? 'aktiviert' : 'deaktiviert'}.`); }
          catch (ex) { t.input.checked = !t.input.checked; toast(ex.message, 'err'); }
        });
        return h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr) auto', padding: '12px 20px' } },
          h('div', { class: 'row', style: { alignItems: 'center', gap: '12px', flexWrap: 'nowrap' } }, h('div', { class: 'dot-icon' }, icon(i.icon)), h('div', null, h('div', { class: 'lbl' }, i.label), h('div', { class: 'hlp' }, `${i.section} · ${i.subtitle ?? ''}`))), t);
      }));
  };
  draw();
}

/** Karte „Hilfe als PDF“: die komplette Anleitung (Mitarbeiter bzw. Partner) herunterladen – nur Superadmin. */
function helpPdfCard(host) {
  const body = h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr) auto' } },
    h('div', null, h('div', { class: 'lbl' }, 'Anleitung als PDF'), h('div', { class: 'hlp' }, 'Erzeugt aus allen aktuellen Hilfe-Kapiteln (inklusive eigener Anpassungen) ein PDF – für Mitarbeiter mit allen Bereichen, für Partner mit deren Apps. Ausgeblendete Kapitel fehlen.')),
    h('div', { class: 'row' }, button('Mitarbeiter-PDF', { icon: 'download', onClick: () => window.open('/api/help/export.pdf?aud=m', '_blank', 'noopener') }), button('Partner-PDF', { icon: 'download', onClick: () => window.open('/api/help/export.pdf?aud=p', '_blank', 'noopener') })));
  host.append(card('Hilfe', body, { icon: 'help', flush: true }));
}

/**
 * Karte „Dock“: Anordnung und Gruppen der Apps im Dock für ALLE – per Ziehen und Ablegen (nur mit Recht „system.apps“).
 * App auf eine andere App ziehen = neue Gruppe; App auf eine Gruppe ziehen = hinein; App zwischen die Symbole ziehen = einzeln; Gruppen lassen sich am Griff verschieben.
 */
function dockCard(host) {
  const apps = new Map(allItems(NAV).map((i) => [i.id, i]));
  const norm = (layout) => { // unbekannte Apps raus, doppelte raus, fehlende ans Ende, leere Gruppen raus
    const seen = new Set(), out = [];
    for (const e of layout) {
      if (e.app) { if (apps.has(e.app) && !seen.has(e.app)) { seen.add(e.app); out.push({ app: e.app }); } continue; }
      const items = (e.items ?? []).filter((id) => apps.has(id) && !seen.has(id)); items.forEach((id) => seen.add(id));
      if (items.length) out.push({ gid: e.gid, label: e.label, items });
    }
    for (const id of apps.keys()) if (!seen.has(id)) out.push({ app: id });
    return out;
  };
  const clone = (l) => JSON.parse(JSON.stringify(l));
  const savedNow = () => { const s = state.config['ui.dock_layout']; return Array.isArray(s) && s.length ? s : defaultDockLayout(); };
  let cur = norm(clone(savedNow())), drag = null;
  const strip = h('div', { class: 'dk-strip' }), err = h('div');
  const newId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  const findApp = (id) => { for (let i = 0; i < cur.length; i++) { if (cur[i].app === id) return { i }; const j = cur[i].items?.indexOf(id) ?? -1; if (j >= 0) return { i, j }; } return null; };
  const takeApp = (id) => { const f = findApp(id); if (!f) return; if (f.j === undefined) cur.splice(f.i, 1); else { cur[f.i].items.splice(f.j, 1); if (!cur[f.i].items.length) cur.splice(f.i, 1); } };
  const insertBefore = (entry, ref) => { const at = ref ? cur.indexOf(ref) : cur.length; cur.splice(at < 0 ? cur.length : at, 0, entry); };

  const dropOnGap = (ref) => { // zwischen Symbole: App wird einzeln, Gruppe wird verschoben
    if (!drag) return;
    if (drag.folder) { const f = cur.find((e) => e.gid === drag.folder); if (!f || f === ref) return; cur.splice(cur.indexOf(f), 1); insertBefore(f, ref); }
    else { if (ref?.app === drag.app) return; takeApp(drag.app); insertBefore({ app: drag.app }, ref); }
  };
  const dropOnApp = (target) => { // App auf App: neue Gruppe
    if (!drag || drag.folder || drag.app === target.app) return;
    takeApp(drag.app); const at = cur.indexOf(target); cur[at] = { gid: newId(), label: 'Neue Gruppe', items: [target.app, drag.app] };
  };
  const dropOnFolder = (folder) => { // App in Gruppe
    if (!drag || drag.folder || folder.items.includes(drag.app)) return;
    takeApp(drag.app); if (!cur.includes(folder)) return; folder.items.push(drag.app);
  };

  const dz = (el, { over, drop, cls }) => { // Ablagefläche
    el.addEventListener('dragover', (e) => { if (!drag || !over()) return; e.preventDefault(); el.classList.add(cls); });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove(cls); });
    el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove(cls); if (over()) { drop(); drag = null; draw(); } });
  };
  const src = (el, payload) => {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => { drag = payload; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', 'dock'); } catch { /* egal */ } e.stopPropagation(); setTimeout(() => el.classList.add('dragging'), 0); });
    el.addEventListener('dragend', () => { drag = null; el.classList.remove('dragging'); draw(); });
  };
  const chip = (id, small) => { const i = apps.get(id); const el = h('div', { class: `dk-chip ${small ? 'small' : ''}`, title: i.label }, h('span', { class: 'dk-ic' }, icon(i.icon)), h('span', null, i.label)); src(el, { app: id }); return el; };
  const gap = (ref) => { const g = h('div', { class: 'dk-gap' }); dz(g, { over: () => true, drop: () => dropOnGap(ref), cls: 'over' }); return g; };

  function tile(e) {
    if (e.app) { const el = h('div', { class: 'dk-tile' }, chip(e.app)); dz(el, { over: () => !drag.folder && drag.app !== e.app, drop: () => dropOnApp(e), cls: 'combine' }); return el; }
    const handle = h('span', { class: 'dk-handle', title: 'Gruppe verschieben' }, icon('menu')), label = h('input', { class: 'input dk-label', value: e.label, maxLength: 30, 'aria-label': 'Name der Gruppe' });
    label.addEventListener('input', () => { e.label = label.value; });
    label.addEventListener('blur', () => { if (!label.value.trim()) { label.value = 'Gruppe'; e.label = 'Gruppe'; } });
    const dissolve = button('', { size: 'sm', variant: 'ghost', icon: 'x', title: 'Gruppe auflösen (Apps bleiben einzeln im Dock)', onClick: () => { cur.splice(cur.indexOf(e), 1, ...e.items.map((app) => ({ app }))); draw(); } });
    const el = h('div', { class: 'dk-folder' }, h('div', { class: 'dk-fhead' }, handle, label, dissolve), h('div', { class: 'dk-fbody' }, e.items.map((id) => chip(id, true))));
    handle.draggable = true; handle.addEventListener('dragstart', (ev) => { drag = { folder: e.gid }; ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', 'dock'); } catch { /* egal */ } ev.dataTransfer.setDragImage?.(el, 20, 20); setTimeout(() => el.classList.add('dragging'), 0); });
    handle.addEventListener('dragend', () => { drag = null; el.classList.remove('dragging'); draw(); });
    dz(el, { over: () => !drag.folder && !e.items.includes(drag.app), drop: () => dropOnFolder(e), cls: 'combine' });
    return el;
  }

  function draw() { mount(strip, cur.flatMap((e) => [gap(e), tile(e)]), gap(null)); }
  draw();

  const payload = () => cur.map((e) => (e.app ? { app: e.app } : { gid: e.gid, label: e.label.trim() || 'Gruppe', items: e.items }));
  const apply = async (value, msg) => {
    err.replaceChildren();
    try { await api.put('/api/config', { values: { 'ui.dock_layout': value } }); applyConfig({ ...state.config, 'ui.dock_layout': value }); cur = norm(clone(savedNow())); draw(); toast(msg); }
    catch (ex) { err.replaceChildren(formError(ex.message)); }
  };
  const body = h('div', { class: 'dk-wrap' },
    h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr)' } }, h('div', null, h('div', { class: 'lbl' }, 'Dock-Anordnung für alle'), h('div', { class: 'hlp' }, 'Ziehe eine App auf eine andere, um eine Gruppe zu bilden, oder in eine Gruppe hinein. Zwischen die Symbole gezogen steht sie einzeln im Dock; Gruppen verschiebst du am Griff. „Speichern“ gilt sofort für alle Mitarbeiter. Neue Apps erscheinen automatisch ganz hinten. Apps, die jemand nicht sehen darf, fehlen bei ihm im Dock.'))),
    err, h('div', { class: 'dk-scroll' }, strip),
    h('div', { class: 'row', style: { padding: '12px 20px 16px', justifyContent: 'flex-end' } },
      button('Standard wiederherstellen', { icon: 'refresh', onClick: () => apply([], 'Dock auf Standard zurückgesetzt – gilt für alle.') }),
      button('Verwerfen', { onClick: () => { cur = norm(clone(savedNow())); draw(); } }),
      button('Speichern', { variant: 'primary', icon: 'check', onClick: () => apply(payload(), 'Dock gespeichert – gilt sofort für alle.') })));
  host.append(card('Dock', body, { icon: 'dashboard', flush: true }));
}

/** Karte „Level-Stufen“: Name, Symbol und XP-Schwelle der zehn Partner-Level. */
function levelsCard(host, setting, editable) {
  const body = h('div');
  host.append(card('Level-Stufen', body, { icon: 'star', flush: true }));
  const rows = setting.value.map((l) => ({ ...l }));
  const names = rows.map((l) => input({ value: l.name, maxLength: 24, disabled: !editable })), xps = rows.map((l) => input({ type: 'number', min: 0, step: '1', value: l.xp, disabled: !editable || l === rows[0] }));
  const icons = rows.map((l) => select(Array.from({ length: 10 }, (_, i) => ({ value: `lv${i + 1}`, label: `Symbol ${i + 1}` })), l.icon, { disabled: !editable }));
  const prev = rows.map((l, i) => h('span', { class: 'lvl-prev' }, icon(l.icon)));
  icons.forEach((s, i) => s.addEventListener('change', () => mount(prev[i], icon(s.value))));
  const err = h('div');
  mount(body, h('div', { class: 'setting-row', style: { gridTemplateColumns: 'minmax(0,1fr)' } }, h('div', null, h('div', { class: 'lbl' }, 'Zehn Stufen für externe Partner'), h('div', { class: 'hlp' }, 'Die XP-Schwelle ist der Wert, ab dem das Level erreicht wird (aufsteigend, Level 1 beginnt bei 0). Je höher die Schwellen, desto länger dauert der Aufstieg.'))),
    h('div', { style: { padding: '4px 20px 14px', display: 'grid', gridTemplateColumns: 'auto 1.2fr 1fr 1fr', gap: '8px 10px', alignItems: 'center' } },
      h('span', { class: 'muted' }, 'Level'), h('span', { class: 'muted' }, 'Name'), h('span', { class: 'muted' }, 'Symbol'), h('span', { class: 'muted' }, 'ab XP'),
      rows.map((l, i) => [h('span', { class: 'row', style: { gap: '6px', alignItems: 'center', flexWrap: 'nowrap' } }, prev[i], h('b', null, i + 1)), names[i], icons[i], xps[i]])),
    editable && h('div', { style: { padding: '0 20px 16px' } }, err, button('Level-Stufen speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      const value = rows.map((_, i) => ({ name: names[i].value.trim(), icon: icons[i].value, xp: i === 0 ? 0 : Number(xps[i].value) }));
      try { await api.put('/api/config', { values: { 'level.levels': value } }); toast('Level-Stufen gespeichert.'); } catch (ex) { err.replaceChildren(formError(ex.message.includes('Struktur') ? 'Ungültig: Namen ausfüllen und die XP-Schwellen müssen aufsteigend sein.' : ex.message)); }
    }) })));
}

export default async function render(container, ctx) {
  mount(container, skeletons(3, 120));
  const { settings } = await api.get('/api/config');
  if (!ctx.isCurrent()) return;
  const editable = can('config.edit');
  const full = can('config.view');
  const mayEdit = (s) => (s.perm ? can(s.perm) : editable); // Einstellungen mit eigenem Recht (Exekutive-Zugang: hack.manage)
  const controls = new Map();
  const groups = {};
  for (const s of settings.filter((x) => !x.hidden)) (groups[s.group] ??= []).push(s);

  const err = h('div');
  const rowsOf = new Map(); // Karte → Zeilen (für die Suche)
  const cards = Object.entries(groups).map(([g, items]) => { const rows = []; const el = card(g, items.map((s) => {
    const c = control(s, !mayEdit(s));
    controls.set(s.key, { ...c, initial: s.value });
    // Live-Vorschau: jede Änderung an Darstellungs-Einstellungen wirkt sofort (gespeichert wird erst per Knopf)
    if (s.key.startsWith('ui.')) {
      const fire = () => window.dispatchEvent(new CustomEvent('mdt:config', { detail: Object.fromEntries([...controls].filter(([k]) => k.startsWith('ui.')).map(([k, cc]) => [k, cc.get()]).filter(([, v]) => !(typeof v === 'number' && Number.isNaN(v)))) }));
      c.el.addEventListener('input', fire); c.el.addEventListener('change', fire);
    }
    const row = h('div', { class: 'setting-row' }, h('div', null, h('div', { class: 'lbl' }, s.label), s.help && h('div', { class: 'hlp' }, s.help)), c.el);
    rows.push({ el: row, text: `${s.label} ${s.help ?? ''} ${s.key}`.toLowerCase() });
    return row;
  }), { flush: true, icon: g === 'Darstellung' ? 'palette' : g === 'Zugang' ? 'lock' : g === 'Mitglieder' ? 'users' : 'sliders' }); rowsOf.set(el, rows); return el; });

  const save = button('Änderungen speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
    err.replaceChildren();
    const values = {};
    for (const [k, c] of controls) if (JSON.stringify(c.get()) !== JSON.stringify(c.initial)) values[k] = c.get();
    if (!Object.keys(values).length) return toast('Keine Änderungen.', 'info');
    try {
      const res = await api.put('/api/config', { values });
      for (const s of res.settings) if (controls.has(s.key)) controls.get(s.key).initial = s.value;
      applyConfig({ ...state.config, ...values });
      document.querySelector('.brand-name') && (document.querySelectorAll('.brand-name').forEach((n) => (n.textContent = state.config['system.name'])));
      toast('Einstellungen gespeichert.');
    } catch (ex) { err.replaceChildren(formError(ex.message)); }
  }) });
  // ── Aufbau: Hauptkategorien → ausklappbare Karten, mit Suche ──
  const openState = loadOpen();
  const catEls = new Map(), cardEntries = [];
  const catOf = (title) => CATS.find((c) => c.groups.includes(title)) ?? { id: 'other', title: 'Weitere', icon: 'sliders', groups: [] };
  const catEl = (c) => {
    if (catEls.has(c.id)) return catEls.get(c.id);
    const bodyEl = h('div', { class: 'stack', style: { gap: '14px' } }), count = h('span', { class: 'muted cfg-count' });
    const head = h('button', { type: 'button', class: 'cfg-cat-head' }, icon(c.icon), h('h2', null, c.title), count, h('span', { class: 'cc-chev' }, icon('chevronD')));
    const sec = h('section', { class: 'cfg-cat' }, head, bodyEl);
    const setOpen = (o) => { sec.classList.toggle('collapsed', !o); head.setAttribute('aria-expanded', String(o)); openState['cat:' + c.id] = o; saveOpen(openState); };
    head.addEventListener('click', () => setOpen(sec.classList.contains('collapsed')));
    setOpen(openState['cat:' + c.id] !== false);
    const e = { sec, bodyEl, count, c };
    catEls.set(c.id, e);
    // Reihenfolge der Kategorien bleibt stabil, auch wenn Karten asynchron eintreffen
    const order = [...CATS.map((x) => x.id), 'other'];
    const next = [...catEls.values()].filter((x) => order.indexOf(x.c.id) > order.indexOf(c.id)).sort((a, b) => order.indexOf(a.c.id) - order.indexOf(b.c.id))[0];
    layout.insertBefore(sec, next?.sec ?? null);
    return e;
  };
  const place = (el) => {
    const title = el.querySelector('.card-head h3')?.textContent ?? '';
    const c = catOf(title), ce = catEl(c);
    const head = el.querySelector('.card-head');
    if (head) {
      el.classList.add('cc');
      const chev = h('span', { class: 'cc-chev' }, icon('chevronD'));
      head.append(chev); head.setAttribute('role', 'button'); head.tabIndex = 0;
      const set = (o) => { el.classList.toggle('collapsed', !o); head.setAttribute('aria-expanded', String(o)); };
      const toggleIt = () => { const o = el.classList.contains('collapsed'); set(o); openState[title] = o; saveOpen(openState); };
      head.addEventListener('click', (e) => { if (!e.target.closest('button,a,input,select')) toggleIt(); });
      head.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === head) { e.preventDefault(); toggleIt(); } });
      set(openState[title] === true);
      cardEntries.push({ el, title, set, rows: rowsOf.get(el) ?? [], cat: ce });
    }
    const ord = c.groups.indexOf(title); el.dataset.ord = String(ord < 0 ? 999 : ord); // feste Reihenfolge innerhalb der Kategorie, auch wenn Karten später eintreffen
    ce.bodyEl.insertBefore(el, [...ce.bodyEl.children].find((x) => Number(x.dataset.ord) > Number(el.dataset.ord)) ?? null); ce.count.textContent = `${ce.bodyEl.children.length}`;
  };
  const layout = h('div', { class: 'stack', style: { gap: '18px' } });
  const search = input({ placeholder: 'Einstellungen durchsuchen …', type: 'search' });
  const applySearch = () => {
    const q = search.value.trim().toLowerCase();
    for (const e of cardEntries) {
      if (!q) { e.rows.forEach((r) => { r.el.hidden = false; }); e.el.hidden = false; e.set(openState[e.title] === true); continue; }
      const titleHit = e.title.toLowerCase().includes(q), hits = e.rows.filter((r) => r.text.includes(q));
      e.rows.forEach((r) => { r.el.hidden = !titleHit && !hits.includes(r); });
      const show = titleHit || hits.length > 0; e.el.hidden = !show; if (show) e.set(true);
    }
    for (const ce of catEls.values()) ce.sec.hidden = !!q && ![...ce.bodyEl.children].some((x) => !x.hidden);
  };
  search.addEventListener('input', applySearch);
  const toggleAll = (open) => { for (const e of cardEntries) { e.set(open); openState[e.title] = open; } for (const ce of catEls.values()) { ce.sec.classList.remove('collapsed'); openState['cat:' + ce.c.id] = true; } saveOpen(openState); };
  const bar = h('div', { class: 'cfg-toolbar' }, h('div', { style: { flex: '1 1 260px' } }, search), button('Alle aufklappen', { size: 'sm', icon: 'chevronD', onClick: () => toggleAll(true) }), button('Alle zuklappen', { size: 'sm', icon: 'chevronU', onClick: () => toggleAll(false) }));
  const extras = { append: (el) => { place(el); applySearch(); } };
  cards.forEach(place);
  mount(container, h('div', { class: 'stack', style: { gap: '18px' } }, err, bar, layout), settings.some((x) => !x.hidden && mayEdit(x)) && h('div', { class: 'savebar' }, save));
  if (can('system.apps')) { appsCard(extras); dockCard(extras); }
  if (state.user?.isSuperadmin) helpPdfCard(extras);
  { const ls = settings.find((x) => x.key === 'level.levels'); if (ls) levelsCard(extras, ls, mayEdit(ls)); }
  if (full) addExtras(extras, editable); else if (can('hack.manage')) hackCard(extras);
  // ungespeicherte Live-Vorschau der Akzentfarbe beim Verlassen zurücksetzen
  return () => applyConfig(state.config); // ungespeicherte Vorschau verwerfen
}
