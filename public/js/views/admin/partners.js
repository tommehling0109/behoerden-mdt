import { h, mount, fmtDateTime, timeAgo } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, busy, card, field, input, select, checkbox, formError, openModal, confirmDialog, toast, skeletons, empty, note, badge, avatar, levelBadge } from '../../ui/kit.js';
import { api } from '../../api.js';
import { extraFilesBox, extraFilesPicker } from './extra-files.js';
import { can, state } from '../../state.js';

const fullLink = (path) => { const h = state.config['coop.host']; return `${h ? `https://${h}` : location.origin}${path}`; }; // Links für Externe laufen über deren eigene Subdomain

async function copy(text, label = 'Kopiert.') {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast('Kopieren nicht möglich – bitte manuell markieren.', 'warn'); }
}

/** Telefonnummer wird schon beim Tippen ins Format (555) 123-4567 gebracht; Löschen von Sonderzeichen entfernt eine Ziffer. */
export const formatPhone = (digits) => {
  const d = digits.replace(/\D/g, '').slice(0, 10);
  if (!d) return '';
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
};
export function phoneInput(value) {
  const el = input({ value: value ?? '', placeholder: '(555) 123-4567', inputmode: 'tel', maxLength: 14, autocomplete: 'off' });
  let prev = el.value;
  el.addEventListener('input', (e) => {
    let digits = el.value.replace(/\D/g, '');
    if (e.inputType?.startsWith('delete') && digits === prev.replace(/\D/g, '')) digits = digits.slice(0, -1); // nur ein Sonderzeichen gelöscht → Ziffer davor entfernen
    el.value = formatPhone(digits); prev = el.value;
  });
  return el;
}
export const readFile = (file, maxMb = 5) => new Promise((res, rej) => {
  if (file.size > maxMb * 1024 * 1024) return rej(new Error(`${file.name}: Datei zu groß (max. ${maxMb} MB).`));
  const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = () => rej(new Error('Datei konnte nicht gelesen werden.')); rd.readAsDataURL(file);
});
/** Datei-Auswahl mit Anzeige des gewählten Dateinamens */
export function filePicker(label, existing) {
  const f = h('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg,image/webp', hidden: true });
  const name = h('span', { class: 'muted' }, existing ?? 'Keine Datei gewählt');
  const btn = button(label, { size: 'sm', icon: 'download', onClick: () => f.click() });
  f.addEventListener('change', () => { name.textContent = f.files[0]?.name ?? (existing ?? 'Keine Datei gewählt'); });
  return { el: h('div', { class: 'row', style: { alignItems: 'center' } }, f, btn, name), file: () => f.files[0] ?? null };
}
const TYPE_OPTIONS = [{ value: '', label: '— bitte wählen —' }, { value: 'supplier', label: 'Lieferant (liefert uns Ware)' }, { value: 'buyer', label: 'Ankäufer (kauft von uns)' }];
/** Dokumente eines Lieferanten: Schlüssel, Beschriftung, Pflicht */
/** Börse-Freigabe eines Zugangs: alle freigegebenen Artikel oder nur ausgewählte, plus „Sonstiges“ (Freitext-Artikel, die noch nicht angelegt sind). */
export function marketAccessForm(p, items) {
  const mode = select([{ value: 'all', label: 'Alle für Partner freigegebenen Artikel' }, { value: 'selected', label: 'Nur ausgewählte Artikel' }], p?.itemsMode ?? 'all');
  const chosen = new Set(p?.itemIds ?? []);
  const other = h('input', { type: 'checkbox', checked: !!p?.allowOther });
  const box = h('div', { class: 'ct-roles' });
  const draw = () => {
    box.hidden = mode.value !== 'selected';
    mount(box, items.length ? items.map((i) => { const c = h('input', { type: 'checkbox', checked: chosen.has(i.id) }); c.addEventListener('change', () => (c.checked ? chosen.add(i.id) : chosen.delete(i.id))); return h('label', { class: 'check', style: { padding: '2px 0' } }, c, h('span', { class: 'check-text' }, `${i.name} (${i.unit})`)); }) : h('div', { class: 'muted' }, 'Es gibt noch keine Artikel im Katalog.'));
  };
  mode.addEventListener('change', draw); draw();
  return {
    el: h('div', null, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Börse: Artikel dieses Zugangs'),
      field('Welche Artikel darf der Zugang sehen und anbieten?', mode, { help: 'Zusätzlich muss der Artikel selbst für Partner freigegeben sein (Börse → Katalog → Sichtbar für externe Partner).' }), box,
      h('label', { class: 'check', style: { padding: '6px 0 0' } }, other, h('span', { class: 'check-text' }, 'Sonstiges erlauben – der Zugang darf auch Artikel anbieten, die noch nicht angelegt sind (Freitext)'))),
    values: () => ({ itemsMode: mode.value, itemIds: mode.value === 'selected' ? [...chosen] : [], allowOther: other.checked }),
  };
}
export const SUPPLIER_DOCS = [['id', 'Ausweis', false], ['license', 'Führerschein', false], ['weapon', 'Waffenschein', false], ['clearance', 'Führungszeugnis', false]];

/**
 * Stammdaten eines externen Zugangs. Zuerst wird die Art gewählt:
 *  - Lieferant: Vorname, Nachname, Straße, Postal Code, Telefonnummer, UMail, Kontonummer + Ausweis, Führerschein, Waffenschein (Führungszeugnis optional) – alles Pflicht
 *  - Ankäufer: Name oder Bezeichnung, Ansprechpartner, Tel (optional)
 * Der Server prüft zusätzlich.
 */
function profileForm(p, { docs, hint = '' }) {
  const a = { ...(p ?? {}) };
  const type = select(TYPE_OPTIONS, a.type ?? '');
  const name = input({ value: a.type === 'buyer' ? (a.name ?? '') : '', maxLength: 60, placeholder: 'z. B. Händler Müller GmbH', autocomplete: 'off' });
  const contact = input({ value: a.contactName ?? '', maxLength: 80, autocomplete: 'off' });
  const first = input({ value: a.firstName ?? '', maxLength: 40, autocomplete: 'off' }), last = input({ value: a.lastName ?? '', maxLength: 40, autocomplete: 'off' });
  const postal = input({ value: a.postalCode ?? '', maxLength: 12, placeholder: 'z. B. 1234', autocomplete: 'off' }), street = input({ value: a.street ?? '', maxLength: 80, autocomplete: 'off' });
  const umail = input({ value: a.umailLocal ?? '', maxLength: 40, placeholder: 'name', autocomplete: 'off' });
  umail.addEventListener('input', () => { umail.value = umail.value.toLowerCase().replace(/@.*$/, '').replace(/[^a-z0-9._-]/g, ''); });
  const phone = phoneInput(a.phone); const account = input({ value: a.accountNumber ?? '', maxLength: 20, placeholder: 'z. B. LS28180705', autocomplete: 'off' });
  account.addEventListener('input', () => { account.value = account.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''); });
  const pickers = Object.fromEntries(SUPPLIER_DOCS.map(([k, label]) => [k, filePicker(a.docs?.[k] ? `${label} ersetzen` : `${label} hochladen`, a.docs?.[k] ? `${label} liegt vor` : null)]));
  const rows = h('div');
  const draw = () => {
    if (type.value === 'supplier') {
      mount(rows,
        h('div', { class: 'help', style: { margin: '0 0 12px' } }, 'Lieferant: Alle mit * markierten Angaben sind Pflicht. Dokumente sind optional – was nicht vorliegt, kannst du später nachreichen.'),
        h('div', { class: 'form-row' }, field('Vorname *', first), field('Nachname *', last)),
        h('div', { class: 'form-row' }, field('Street / Straße *', street), field('Postal Code *', postal)),
        h('div', { class: 'form-row' }, field('Telefonnummer *', phone), field('Kontonummer *', account)),
        field('UMail *', h('div', { class: 'input-group' }, umail, h('span', { class: 'addon' }, '@umail.com')), { help: 'RP-interne Mail – die Endung ist fest.' }),
        !docs && hint && note(hint, 'alert'),
        docs && h('div', null, SUPPLIER_DOCS.map(([k, label, must]) => field(must ? `${label} *` : `${label} (optional)`, pickers[k].el, k === 'id' ? { help: 'Optional. PDF, PNG, JPG oder WebP, max. 5 MB.' } : {}))));
    } else if (type.value === 'buyer') {
      mount(rows,
        h('div', { class: 'help', style: { margin: '0 0 12px' } }, 'Ankäufer: Name oder Bezeichnung und Ansprechpartner sind Pflicht, die Telefonnummer ist optional.'),
        field('Name oder Bezeichnung *', name), h('div', { class: 'form-row' }, field('Ansprechpartner *', contact), field('Tel (optional)', phone)));
    } else mount(rows, h('div', { class: 'help' }, 'Bitte zuerst die Art des Zugangs wählen – davon hängt ab, welche Angaben nötig sind.'));
  };
  type.addEventListener('change', draw); draw();
  return {
    el: h('div', null, field('Art des Zugangs *', type), rows),
    values: () => (type.value === 'supplier'
      ? { type: 'supplier', firstName: first.value.trim(), lastName: last.value.trim(), street: street.value.trim(), postalCode: postal.value.trim(), phone: phone.value.trim(), umail: umail.value.trim(), accountNumber: account.value.trim() }
      : { type: type.value || undefined, name: name.value.trim() || undefined, contactName: contact.value.trim(), phone: phone.value.trim() }),
    isSupplier: () => type.value === 'supplier', hasType: () => !!type.value,
    files: async () => (type.value === 'supplier' ? Object.fromEntries(await Promise.all(SUPPLIER_DOCS.map(async ([k]) => [`${k}Doc`, pickers[k].file() ? await readFile(pickers[k].file()) : null]))) : {}),
  };
}

export default async function render(container, ctx) {
  const canManage = can('partners.manage'), canDocs = can('partners.documents'), canDelete = can('partners.delete');
  mount(container, skeletons(3, 90));
  let data;
  const load = async () => { data = await api.get('/api/partners'); if (ctx.isCurrent()) draw(); };

  if (canManage) ctx.setActions(button('Zugang erstellen', { variant: 'primary', icon: 'userPlus', onClick: () => create() }));

  function draw() {
    if (!data.partners.length) return mount(container, card(null, empty('Noch keine externen Zugänge', canManage ? 'Erstelle einen Zugang. Du erhältst einen Link und einen Code, den du an die Person schickst.' : null, 'link')));
    mount(container, note('Externe Zugänge haben keinen Benutzer-Account: Die Person öffnet den persönlichen Link, gibt den Code ein und sieht nur die hier freigeschalteten Apps.', 'info'),
      h('div', { style: { height: '14px' } }),
      h('div', { class: 'role-grid' }, data.partners.map((p) => {
        const c = h('article', { class: 'card role-card hoverable', style: { '--rc': p.status === 'active' ? 'var(--ok)' : 'var(--mute)', cursor: 'pointer' }, tabindex: 0 },
          h('h3', null, p.name, ' ', p.status === 'active' ? badge('Aktiv', 'b-ok') : badge('Deaktiviert', 'b-mute'), p.locked && badge('Gesperrt', 'b-err'), ' ', levelBadge(p.level)),
          h('div', { class: 'desc' }, badge(p.typeLabel ?? '', p.type === 'supplier' ? 'b-warn' : 'b-info', false), ' ', p.note || h('span', { class: 'muted' }, 'Keine Notiz')),
          h('div', { class: 'chips' }, p.apps.length ? p.apps.map((a) => badge((data.apps.find((x) => x.id === a)?.label ?? a), 'b-info', false)) : h('span', { class: 'muted' }, 'Keine Apps freigeschaltet')),
          h('div', { class: 'meta' }, p.rating.stars && h('span', { title: 'Einschätzung der Führung', style: { color: '#fbbf24' } }, '★'.repeat(p.rating.stars)), p.rating.stats.completed + p.rating.stats.cancelled + p.rating.stats.withdrawn >= 3 && h('span', { title: `Abschlussquote ${p.rating.stats.completionRate} %` }, badge(p.rating.auto.label, `b-${p.rating.auto.tone}`, false)), h('span', null, p.lastLoginAt ? `Zuletzt: ${timeAgo(p.lastLoginAt)}` : 'Noch nie angemeldet'), h('span', null, `${p.dealCount} Geschäft${p.dealCount === 1 ? '' : 'e'}`)));
        c.addEventListener('click', () => edit(p));
        c.addEventListener('keydown', (e) => { if (e.key === 'Enter') edit(p); });
        return c;
      })));
  }

  /** Bewertung: automatische Kennzahlen aus den Börsen-Geschäften + Einschätzung der Führung (Sterne, interne Notiz). */
  function ratingBox(p) {
    const r = p.rating, s = r.stats; let stars = r.stars ?? 0;
    const kv = (k, v) => h('div', null, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    const nf = (n) => Number(n ?? 0).toLocaleString('de-DE', { maximumFractionDigits: 2 });
    const noteEl = h('textarea', { class: 'textarea', rows: 2, maxLength: 500, placeholder: 'Interne Notiz zur Zuverlässigkeit (nur für das Team sichtbar)', disabled: !canManage }, r.note ?? '');
    const starBox = h('div', { class: 'rate-stars' }), paint = () => mount(starBox, [1, 2, 3, 4, 5].map((n) => h('button', { type: 'button', class: n <= stars ? 'on' : '', disabled: !canManage, title: `${n} Stern${n === 1 ? '' : 'e'}`, onclick: () => { stars = stars === n ? 0 : n; paint(); } }, '★')));
    paint();
    return h('div', { class: 'rate-box' }, h('div', { class: 'label' }, 'Bewertung ', badge(r.auto.label, `b-${r.auto.tone}`, false)),
      h('div', { class: 'rate-stats' }, kv('Abschlussquote', s.completionRate == null ? '–' : `${s.completionRate} %`), kv('Geschäfte', `${s.total} (${s.open} offen)`), kv('Abgeschlossen', s.completed),
        kv('Storniert / zurückgezogen', `${s.cancelled} / ${s.withdrawn}`), kv('Umsatz abgeschlossen', nf(s.volume)), kv('Ø Dauer bis Abschluss', s.avgDays == null ? '–' : `${nf(s.avgDays)} Tage`),
        kv('Letztes Geschäft', s.lastDealAt ? fmtDateTime(s.lastDealAt) : '–'), s.overdueInstallments > 0 && kv('Überfällige Kreditraten', s.overdueInstallments)),
      h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Die Quote zählt abgeschlossene gegen stornierte und zurückgezogene Geschäfte – Ablehnungen durch uns zählen nicht gegen den Partner. Ab 3 beendeten Geschäften gibt es eine Einstufung.'),
      h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } }, h('span', { class: 'label', style: { margin: 0 } }, 'Einschätzung der Führung'), starBox),
      noteEl,
      canManage && h('div', null, button('Bewertung speichern', { size: 'sm', icon: 'check', onClick: async (e) => { try { await busy(e.currentTarget, () => api.put(`/api/partners/${p.id}/rating`, { stars: stars || null, note: noteEl.value })); toast('Bewertung gespeichert.'); load(); } catch (ex) { toast(ex.message, 'err'); } } })));
  }

  const appBoxes = (selected, locked) => data.apps.map((a) => [a, checkbox(h('span', null, a.label), selected.includes(a.id), { desc: a.description, locked })]);

  /** Zeigt Link + (einmalig) Code zum Weitergeben. */
  function showCredentials(partner, code, title = 'Zugangsdaten') {
    const link = fullLink(partner.linkPath);
    const m = openModal({
      title,
      body: h('div', { class: 'stack' },
        note(`Schicke ${partner.name} den Link und den Code. Der Code wird nur jetzt angezeigt – danach nur noch als Hash gespeichert.`, 'alert'),
        h('div', null, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Persönlicher Link (dauerhaft, bis du ihn deaktivierst)'),
          h('div', { class: 'link-box' }, h('code', null, link), button('Kopieren', { size: 'sm', icon: 'check', onClick: () => copy(link, 'Link kopiert.') }))),
        code && h('div', null, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Zugangscode'), h('div', { class: 'code-display' }, code),
          h('div', { class: 'row', style: { marginTop: '8px' } }, button('Code kopieren', { size: 'sm', icon: 'check', onClick: () => copy(code, 'Code kopiert.') }),
            button('Beides kopieren', { size: 'sm', onClick: () => copy(`Zugang: ${link}\nCode: ${code}`, 'Link und Code kopiert.') })))),
      footer: [button('Fertig', { variant: 'primary', onClick: () => m.close() })],
    });
  }

  function create() {
    const err = h('div');
    const noteEl = input({ maxLength: 300, placeholder: 'Interne Notiz (optional)' });
    const prof = profileForm(null, { docs: canDocs, hint: 'Ausweis, Führerschein, Waffenschein und Führungszeugnis kannst du nur hochladen, wenn dir das Recht „partners.documents“ zugewiesen ist. Alle Dokumente sind optional und lassen sich auch später nachreichen.' });
    const code = input({ maxLength: 12, placeholder: 'leer lassen = zufälliger 6-stelliger Code', autocomplete: 'off' });
    const extras = canDocs ? extraFilesPicker() : null;
    const mkt = marketAccessForm(null, data.items ?? []);
    const lvOn = h('input', { type: 'checkbox' });
    const boxes = appBoxes(data.apps.map((a) => a.id), false);
    const m = openModal({
      title: 'Externen Zugang erstellen', wide: true,
      body: h('div', null, err, prof.el, extras && h('div', { style: { margin: '12px 0' } }, extras.el), field('Notiz', noteEl), field('Code', code, { help: 'Optional eigener Code aus 6–12 Buchstaben/Ziffern.' }),
        h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Freigeschaltete Apps'), boxes.map(([, c]) => c), h('div', { class: 'sep' }), mkt.el, h('div', { class: 'sep' }), h('label', { class: 'check', style: { padding: 0 } }, lvOn, h('span', { class: 'check-text' }, 'Level-System aktivieren (Erfahrungspunkte durch abgeschlossene Geschäfte)'))),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Erstellen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        try {
          if (!prof.hasType()) throw new Error('Bitte wähle, ob der Zugang ein Lieferant oder ein Ankäufer ist.');
          const files = await prof.files();
          const res = await api.post('/api/partners', { ...prof.values(), ...files, ...mkt.values(), levelEnabled: lvOn.checked, note: noteEl.value, code: code.value.trim() || undefined, apps: boxes.filter(([, c]) => c.input.checked).map(([a]) => a.id) });
          const failed = extras?.count() ? await extras.upload('partner', res.partner.id) : [];
          if (failed.length) toast(`Zugang erstellt – diese Dateien konnten nicht gespeichert werden: ${failed.join(', ')}`, 'warn');
          m.close(); await load(); showCredentials(res.partner, res.code, 'Zugang erstellt');
        } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
  }

  /** Dokumente (Ausweis, Führerschein, Waffenschein, Führungszeugnis): ansehen und ersetzen (nur mit „partners.documents“) */
  function docBox(p) {
    if (!canDocs) return null;
    if (p.type !== 'supplier') return h('div', { style: { margin: '12px 0' } }, extraFilesBox({ type: 'partner', id: p.id }));
    const one = (kind, label, has) => {
      const f = h('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg,image/webp', hidden: true });
      f.addEventListener('change', async () => {
        if (!f.files[0]) return;
        try { await api.post(`/api/partners/${p.id}/docs/${kind}`, { data: await readFile(f.files[0], 5) }); toast(`${label} gespeichert.`); load(); } catch (ex) { toast(ex.message, 'err'); }
      });
      return h('div', { class: 'row', style: { alignItems: 'center', marginBottom: '6px' } }, h('b', { style: { minWidth: '130px' } }, label), has ? badge('liegt vor', 'b-ok', false) : badge('fehlt', 'b-mute', false),
        has && h('a', { class: 'btn btn-sm', href: `/api/partners/${p.id}/docs/${kind}`, target: '_blank', rel: 'noopener' }, icon('search'), 'Ansehen'), canManage && f, canManage && button(has ? 'Ersetzen' : 'Hochladen', { size: 'sm', icon: 'download', onClick: () => f.click() }));
    };
    return h('div', { style: { margin: '12px 0' } }, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Dokumente'), SUPPLIER_DOCS.map(([k, label]) => one(k, label, p.docs[k])), h('div', { style: { height: '10px' } }), extraFilesBox({ type: 'partner', id: p.id }));
  }

  /** Level-System eines Zugangs: aktivieren (partners.manage), Stand/Verlauf ansehen, XP und Level ändern (nur mit partners.levels). */
  function levelSection(p) {
    const on = h('input', { type: 'checkbox', checked: !!p.levelEnabled, disabled: !canManage });
    const info = h('div');
    const canAdjust = can('partners.levels');
    const draw = async () => {
      if (!p.levelEnabled) return mount(info, h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Ausgeschaltet: Der Zugang sammelt keine Erfahrungspunkte und zeigt kein Level. Beim Einschalten zählen nur Geschäfte, die danach abgeschlossen werden.'));
      mount(info, h('div', { class: 'muted' }, 'Lade …'));
      try {
        const { level: d } = await api.get(`/api/partners/${p.id}/level`);
        if (!d.enabled) return mount(info, h('div', { class: 'muted' }, 'Wird mit „Speichern“ aktiviert.'));
        const reload = () => { p.levelEnabled = true; draw(); load(); };
        mount(info, h('div', { class: 'row', style: { alignItems: 'center', gap: '10px', marginBottom: '6px' } }, levelBadge({ n: d.n, name: d.name, icon: d.icon }), h('b', null, d.name), h('span', { class: 'muted' }, `${d.xp.toLocaleString('de-DE')} XP${d.next ? ` · noch ${d.next.remaining.toLocaleString('de-DE')} bis Level ${d.next.n}` : ' · höchste Stufe'}`)),
          h('div', { class: 'lvl-bar' }, h('div', { class: 'lvl-bar-fill', style: { width: `${Math.round(d.progress * 100)}%` } })),
          canAdjust && h('div', { class: 'row', style: { margin: '10px 0' } }, button('XP ändern', { size: 'sm', icon: 'plus', onClick: () => adjust('add') }), button('Level setzen', { size: 'sm', icon: 'edit', onClick: () => adjust('set_level', d.n) }), button('Zurücksetzen', { size: 'sm', variant: 'danger', icon: 'refresh', onClick: () => adjust('reset') })),
          d.history.length ? h('div', { style: { maxHeight: '170px', overflowY: 'auto', marginTop: '6px' } }, d.history.map((x) => h('div', { class: 'list-row', style: { padding: '6px 0' } }, h('div', { class: 'grow' }, h('div', { class: 't', style: { whiteSpace: 'normal' } }, x.note || x.kind), h('div', { class: 's' }, fmtDateTime(x.createdAt))), h('b', { style: { color: x.delta > 0 ? 'var(--ok)' : 'var(--err)' } }, `${x.delta > 0 ? '+' : ''}${x.delta}`)))) : h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Noch kein Verlauf.'));
        function adjust(action, cur) {
          const err = h('div'), amount = input({ type: 'number', step: '1', placeholder: 'z. B. 100 oder -50' }), lv = select(Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: `Level ${i + 1}` })), cur ?? 1), reason = input({ maxLength: 200, placeholder: 'Begründung (Pflicht, im Audit-Log)' });
          const m = openModal({ title: action === 'add' ? 'XP vergeben oder abziehen' : action === 'set_level' ? 'Level setzen' : 'Level zurücksetzen', body: h('div', null, err,
            action === 'add' && field('XP (negativ zum Abziehen)', amount), action === 'set_level' && field('Neues Level', lv, { help: 'Die XP werden auf den Beginn dieses Levels gesetzt.' }), action === 'reset' && note('Die XP werden auf 0 gesetzt (Level 1).', 'alert'), field('Begründung *', reason)),
            footer: [h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }), button('Anwenden', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
              try { await api.post(`/api/partners/${p.id}/level/adjust`, { action, amount: action === 'add' ? Number(amount.value) : undefined, level: action === 'set_level' ? Number(lv.value) : undefined, reason: reason.value }); m.close(); toast('Level angepasst.'); reload(); } catch (ex) { err.replaceChildren(formError(ex.message)); }
            }) })] });
        }
      } catch (e) { mount(info, h('div', { class: 'muted' }, e.message)); }
    };
    draw();
    return {
      el: h('div', null, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Level-System'),
        h('label', { class: 'check', style: { padding: 0 } }, on, h('span', { class: 'check-text' }, 'Level-System für diesen Zugang aktivieren (Erfahrungspunkte durch abgeschlossene Geschäfte)')), h('div', { style: { height: '8px' } }), info),
      values: () => ({ levelEnabled: on.checked }),
    };
  }

  /** Löschen: ohne Daten sofort; mit Geschäften/Krediten erst Hinweis, dann (mit „partners.delete“) samt aller Daten. */
  async function deletePartner(p, m) {
    if (!await confirmDialog({ title: 'Zugang löschen?', message: `${p.name} wird endgültig gelöscht.`, confirmLabel: 'Löschen' })) return;
    try {
      try { await api.del(`/api/partners/${p.id}`); } catch (ex) {
        if (ex.status !== 409) throw ex;
        if (!canDelete) throw new Error(`${ex.message.split(' Deaktiviere')[0]} Zum Löschen samt aller Daten fehlt dir das Recht „partners.delete“.`);
        if (!await confirmDialog({ title: 'Samt aller Daten löschen?', message: `${ex.message.split(' Deaktiviere')[0]} Alles wird mit gelöscht (Geschäfte, Kredite, Finanz-Einträge, Dokumente). Das lässt sich nicht rückgängig machen.`, confirmLabel: 'Alles endgültig löschen' })) return;
        await api.del(`/api/partners/${p.id}?force=1`);
      }
      m.close(); toast('Gelöscht.'); load();
    } catch (ex) { toast(ex.message, 'err'); }
  }

  function edit(p) {
    const err = h('div');
    const noteEl = input({ value: p.note, maxLength: 300, disabled: !canManage });
    const prof = profileForm(p, { docs: false });
    const mkt = marketAccessForm(p, data.items ?? []);
    const lvl = levelSection(p);
    const boxes = appBoxes(p.apps, !canManage);
    const link = p.linkPath ? fullLink(p.linkPath) : null;
    const act = (fn) => async (e) => busy(e.currentTarget, async () => { try { await fn(); } catch (ex) { toast(ex.message, 'err'); } });
    const footer = [];
    if (canManage || canDelete) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: () => deletePartner(p, m) }));
    if (canManage) {
      footer.push(button(p.status === 'active' ? 'Link deaktivieren' : 'Link aktivieren', { variant: p.status === 'active' ? 'danger' : 'ok', icon: p.status === 'active' ? 'lock' : 'unlock', onClick: act(async () => {
        if (p.status === 'active') { const r = await confirmDialog({ title: 'Link deaktivieren?', message: `${p.name} wird sofort abgemeldet und kann den Link nicht mehr nutzen. Du kannst ihn jederzeit wieder aktivieren.`, confirmLabel: 'Deaktivieren' }); if (!r) return; }
        await api.patch(`/api/partners/${p.id}`, { status: p.status === 'active' ? 'disabled' : 'active' }); m.close(); toast('Gespeichert.'); load();
      }) }));
    }
    footer.push(h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
    if (canManage) footer.push(button('Speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      try { await api.patch(`/api/partners/${p.id}`, { ...prof.values(), ...(boxes.some(([a, c]) => a.id === 'market' && c.input.checked) ? mkt.values() : {}), ...(canManage ? lvl.values() : {}), note: noteEl.value, apps: boxes.filter(([, c]) => c.input.checked).map(([a]) => a.id) }); m.close(); toast('Gespeichert.'); load(); }
      catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) }));
    const m = openModal({
      title: p.name, wide: true,
      body: h('div', null, err,
        p.locked && h('div', { style: { marginBottom: '14px' } }, note(`Wegen zu vieler Fehlversuche gesperrt bis ${fmtDateTime(p.lockedUntil)}. Ein neuer Code hebt die Sperre auf.`, 'alert')),
        link && h('div', { style: { marginBottom: '16px' } }, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Persönlicher Link'),
          h('div', { class: 'link-box' }, h('code', null, link), button('Kopieren', { size: 'sm', icon: 'check', onClick: () => copy(link, 'Link kopiert.') })),
          h('div', { class: 'row', style: { marginTop: '8px' } },
            button('Neuen Code erzeugen', { size: 'sm', icon: 'key', onClick: act(async () => {
              const r = await confirmDialog({ title: 'Neuen Code erzeugen?', message: 'Der alte Code wird ungültig und bestehende Sitzungen werden beendet.', confirmLabel: 'Neuer Code', variant: 'primary' });
              if (!r) return; const res = await api.post(`/api/partners/${p.id}/code`); showCredentials(p, res.code, 'Neuer Code'); load();
            }) }),
            button('Neuen Link erzeugen', { size: 'sm', icon: 'refresh', onClick: act(async () => {
              const r = await confirmDialog({ title: 'Neuen Link erzeugen?', message: 'Der bisherige Link wird sofort ungültig. Du musst den neuen Link weitergeben.', confirmLabel: 'Neuer Link', variant: 'primary' });
              if (!r) return; const res = await api.post(`/api/partners/${p.id}/link`); m.close(); await load(); showCredentials({ ...p, linkPath: res.linkPath }, null, 'Neuer Link');
            }) }))),
        field('Notiz', noteEl), canManage && prof.el, docBox(p),
        h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Freigeschaltete Apps'), boxes.map(([, c]) => c),
        canManage && h('div', { style: { margin: '14px 0' } }, h('div', { class: 'sep' }), mkt.el),
        h('div', { style: { margin: '14px 0' } }, h('div', { class: 'sep' }), lvl.el),
        h('div', { style: { margin: '14px 0' } }, h('div', { class: 'sep' }), ratingBox(p)),
        h('dl', { class: 'details-dl', style: { marginTop: '14px' } }, h('dt', null, 'Erstellt'), h('dd', null, fmtDateTime(p.createdAt)),
          h('dt', null, 'Letzte Anmeldung'), h('dd', null, p.lastLoginAt ? fmtDateTime(p.lastLoginAt) : 'noch nie'))),
      footer,
    });
  }

  ctx.live(['partners', 'market'], load);
  await load();
}
