import { h, mount, fmtDateTime, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, card, field, input, select, table, tabs, formError, openModal, confirmDialog, toast, skeletons, empty, note, memberNo } from '../ui/kit.js';
import { api } from '../api.js';
import { can, state } from '../state.js';

const nf = (n) => Number(n ?? 0).toLocaleString('de-DE');
const num = (el) => (el.value === '' ? null : Number(el.value));
const KIND = { in: 'Eingelagert', out: 'Ausgelagert', adjust: 'Korrigiert', transfer_in: 'Umlagerung (Eingang)', transfer_out: 'Umlagerung (Ausgang)', deal: 'Wareneingang (Börse)', deal_out: 'Verkauf an Partner (Börse)', deal_return: 'Rückbuchung (Storno)' };
const chip = (o) => h('span', { class: 'badge', style: { '--c': o.color } }, o.label);
const fillBar = (used, cap) => {
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return h('div', { class: 'fuelbar', style: { '--c': pct >= 90 ? 'var(--err)' : pct >= 70 ? 'var(--warn)' : 'var(--ok, #34d399)' } }, h('i', { style: { width: `${pct}%` } }));
};

export default async function render(container, ctx) {
  let opts = await api.get('/api/warehouse/options');
  const canManage = opts.canManage, canItems = opts.canItems, canPrices = opts.canPrices;
  const money = (v) => (v == null ? '–' : `${nf(v)} ${opts.currency}`);
  let tab = 'warehouses';
  const f = { q: '' };
  const tabHost = h('div', { style: { marginBottom: '16px' } });
  const host = h('div');
  mount(container, tabHost, host);

  function drawActions() {
    ctx.setActions(tab === 'warehouses' ? (canManage && button('Lager anlegen', { variant: 'primary', icon: 'plus', onClick: () => editor(null) })) : (canItems && button('Artikel anlegen', { variant: 'primary', icon: 'plus', onClick: () => itemEditor(null) })));
  }

  async function show(t, silent = false) {
    tab = t; drawActions();
    if (!silent) mount(host, skeletons(3, 180));
    try { opts = await api.get('/api/warehouse/options'); } catch { /* alte Optionen */ }
    if (tab === 'warehouses') await showWarehouses(); else await showItems();
  }
  const drawTabs = () => mount(tabHost, tabs([{ id: 'warehouses', label: 'Lager' }, { id: 'items', label: 'Artikel & Preise' }], tab, (x) => show(x)));

  // ── Lager-Übersicht ──
  async function showWarehouses() {
    let data;
    try { data = await api.get(`/api/warehouses?q=${encodeURIComponent(f.q)}`); } catch (e) { return mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
    if (!ctx.isCurrent() || tab !== 'warehouses') return;
    drawTabs();
    const search = input({ placeholder: 'Name, Nummer, Ort, Postleitzahl …', value: f.q });
    search.addEventListener('input', debounce(() => { f.q = search.value.trim(); show('warehouses', true); }));
    const had = document.activeElement?.tagName === 'INPUT' && host.contains(document.activeElement);
    const list = data.warehouses;
    mount(host, h('div', { class: 'toolbar' }, h('div', { class: 'input-icon' }, icon('search'), search), h('div', { class: 'grow' }), h('span', { class: 'muted' }, `${list.length} Lager`)),
      list.length ? h('div', { class: 'veh-grid' }, list.map((w) => {
        const el = h('article', { class: 'card hoverable veh-card', tabindex: 0 },
          h('div', { class: 'veh-body' },
            h('div', { class: 'veh-title' }, h('h3', null, w.name), memberNo(w.number)),
            h('div', { class: 'chips' }, w.type && chip(w.type), w.restricted && h('span', { class: 'badge no-dot b-warn' }, icon('lockClosed'), 'Beschränkt'), !w.isActive && h('span', { class: 'badge no-dot b-mute' }, 'Inaktiv'), w.level === 'view' && h('span', { class: 'badge no-dot b-info' }, 'Nur ansehen')),
            h('div', { class: 'veh-meta' },
              h('div', null, h('span', { class: 'k' }, 'Standort'), w.location.text || '–', w.location.postal && ` · PLZ ${w.location.postal}`),
              h('div', null, h('span', { class: 'k' }, 'Artikel'), `${w.itemCount} Sorte${w.itemCount === 1 ? '' : 'n'}`),
              h('div', { style: { gridColumn: '1 / -1' } }, h('span', { class: 'k' }, 'Auslastung'), w.capacity != null ? `${nf(w.used)} / ${nf(w.capacity)} Slots` : `${nf(w.used)} belegt (ohne Limit)`, w.capacity != null && fillBar(w.used, w.capacity)),
              w.sizeInfo && h('div', null, h('span', { class: 'k' }, 'Größe'), w.sizeInfo)),
            h('div', { class: 'veh-actions' }, button('Öffnen', { size: 'sm', variant: 'info', icon: 'eye', onClick: (e) => { e.stopPropagation(); details(w.id); } }),
              w.level === 'manage' && canManage && button('Bearbeiten', { size: 'sm', icon: 'edit', onClick: async (e) => { e.stopPropagation(); editor((await api.get(`/api/warehouses/${w.id}`)).warehouse); } }))));
        el.addEventListener('click', () => details(w.id));
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') details(w.id); });
        return el;
      })) : card(null, empty('Keine Lager', canManage ? 'Lege das erste Lager an.' : 'Für dich ist noch kein Lager freigegeben.', 'storage')));
    if (had) { const i = host.querySelector('input'); i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); }
  }

  // ── Detail ──
  async function details(id) {
    const body = h('div', null, skeletons(3, 60));
    let off;
    const m = openModal({ title: 'Lager', wide: true, body, footer: null, onClose: () => off?.() });
    const footer = h('div', { class: 'modal-foot' });
    m.el.append(footer);
    let dtab = 'info';
    async function showDetail() {
      let d;
      try { d = await api.get(`/api/warehouses/${id}`); } catch (e) { mount(body, note(e.message, 'alert')); return; }
      const w = d.warehouse;
      m.el.querySelector('.modal-head h3').textContent = `${w.name} · ${w.number}`;
      const kv = (k, v) => [h('dt', null, k), h('dd', null, v ?? '–')];
      const at = w.location.resolved;
      const info = h('div', null,
        h('div', { class: 'chips', style: { marginBottom: '14px' } }, w.type && chip(w.type), w.restricted && h('span', { class: 'badge no-dot b-warn' }, 'Beschränkter Zugriff'), !w.isActive && h('span', { class: 'badge no-dot b-mute' }, 'Inaktiv')),
        h('dl', { class: 'details-dl' },
          kv('Beschreibung', w.description || null), kv('Standort', w.location.text || null), kv('Postleitzahl', w.location.postal),
          kv('Position', at ? h('span', { class: 'mono' }, `${Math.round(at.x)}, ${Math.round(at.y)}${w.location.x == null && w.location.postal ? ' (aus Postleitzahl)' : ''}`) : null),
          kv('Größe', w.sizeInfo || null),
          kv('Kapazität', w.capacity != null ? h('div', { style: { minWidth: '220px' } }, `${nf(w.used)} von ${nf(w.capacity)} Slots belegt (${Math.round((w.used / (w.capacity || 1)) * 100)} %)`, fillBar(w.used, w.capacity)) : `${nf(w.used)} belegt – kein Limit`),
          kv('Zugang / Zugriff', w.accessInfo === null ? h('span', { class: 'muted' }, 'Dafür fehlt dir das Recht „Zugangsinformationen sehen“.') : (w.accessInfo || null)),
          kv('Abteilung', w.department && h('span', { class: 'badge no-dot', style: { '--c': w.department.color } }, w.department.name)), kv('Notizen', w.notes || null), kv('Zuletzt geändert', fmtDateTime(w.updatedAt))));

      const stockTab = h('div', null,
        w.canBook && w.isActive && h('div', { style: { marginBottom: '12px' } }, button('Einlagern', { variant: 'primary', icon: 'plus', onClick: () => stockDialog(w, 'in') })),
        table([
          { label: 'Artikel', render: (s) => h('div', null, h('b', null, s.name), s.category && h('div', null, chip(s.category))) },
          { label: 'Bestand', render: (s) => `${nf(s.quantity)} ${s.unit}` },
          { label: 'Slots', render: (s) => h('span', { title: `${nf(s.stacks)} Stapel à ${nf(s.slotsPerStack)} Slot(s), max. ${nf(s.stackSize)} pro Stapel` }, `${nf(s.space)} (${nf(s.stacks)} Stapel)`) },
          canPrices && { label: 'Preisspanne', render: (s) => (s.minPrice != null ? `${money(s.minPrice)} – ${money(s.maxPrice)}` : '–') },
          w.canBook && { label: '', style: { textAlign: 'right', whiteSpace: 'nowrap' }, render: (s) => h('div', { class: 'row', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
            button('Aus', { size: 'sm', icon: 'download', title: 'Auslagern', onClick: () => stockDialog(w, 'out', s) }), button('Um', { size: 'sm', icon: 'refresh', title: 'Umlagern', onClick: () => transferDialog(w, s) }), button('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Bestand korrigieren', onClick: () => stockDialog(w, 'set', s) })) },
        ].filter(Boolean), d.stock, { empty: empty('Lager ist leer', w.canBook ? 'Lagere den ersten Artikel ein.' : null, 'storage') }));

      const hist = h('div', null, d.events.length ? d.events.map((e) => h('div', { class: 'list-row' },
        h('div', { class: 'dot-icon' }, icon(e.delta > 0 ? 'plus' : 'download')),
        h('div', { class: 'grow' }, h('div', { class: 't', style: { whiteSpace: 'normal' } }, `${KIND[e.kind] ?? e.kind}: ${e.delta > 0 ? '+' : ''}${nf(e.delta)} ${e.unit ?? ''} ${e.item ?? ''}`, ` → ${nf(e.after)} im Lager`), h('div', { class: 's' }, `${e.actor} · ${fmtDateTime(e.createdAt)}${e.note ? ' · ' + e.note : ''}`)))) : empty('Noch keine Bewegungen', null, 'activity'));

      const acc = h('div', null,
        w.rent?.enabled && note(`Lagerkosten-Erinnerung: jeden ${opts.weekdays?.[w.rent.weekday] ?? ''} ab ${String(w.rent.hour).padStart(2, '0')}:00 Uhr${w.rent.cents ? ` · ${(w.rent.cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2 })} ${opts.currency}` : ''}`, 'clock'),
        w.rent?.unpaid && h('div', { style: { margin: '10px 0' } }, note(`Lagerkosten seit ${w.rent.dueDate.split('-').reverse().join('.')} fällig – noch nicht als bezahlt bestätigt (steht in der Problemleiste).`, 'alert'), h('div', { style: { height: '8px' } }), button('Als bezahlt bestätigen', { variant: 'primary', icon: 'check', onClick: async (e) => busy(e.currentTarget, async () => { try { await api.post(`/api/warehouses/${w.id}/rent/paid`, {}); toast('Lagerkosten als bezahlt bestätigt.'); showDetail(); } catch (ex) { toast(ex.message, 'err'); } }) })),
        w.rent?.enabled && h('div', { style: { height: '12px' } }),
        note(w.restricted ? 'Dieses Lager ist beschränkt: Nur die unten genannten Rollen (und Administratoren) sehen es.' : 'Dieses Lager ist offen: Alle Mitglieder mit dem Recht „Lager ansehen“ sehen es. Rollen können zusätzlich Verwaltungsrechte bekommen.', 'shield'),
        h('div', { style: { height: '12px' } }),
        w.access ? (w.access.length ? w.access.map((a) => h('div', { class: 'list-row' }, h('span', { class: 'dot', style: { width: '10px', height: '10px', borderRadius: '50%', background: a.color, flex: 'none' } }), h('div', { class: 'grow' }, h('div', { class: 't' }, a.roleName)), h('span', { class: `badge no-dot ${a.level === 'manage' ? 'b-ok' : 'b-info'}` }, a.level === 'manage' ? 'Verwalten (ein-/auslagern)' : 'Ansehen'))) : h('div', { class: 'muted' }, 'Keine rollenspezifischen Zugriffe festgelegt.'))
          : h('div', { class: 'muted' }, 'Die Zugriffs-Konfiguration sehen nur Verwalter.'));

      const panes = { info, stock: stockTab, hist, acc };
      const content = h('div');
      const tbar = tabs([{ id: 'info', label: 'Übersicht' }, { id: 'stock', label: 'Bestand', count: d.stock.length }, { id: 'hist', label: 'Verlauf', count: d.events.length }, { id: 'acc', label: 'Zugriff' }], dtab, (x) => { dtab = x; mount(content, panes[x]); });
      tbar.style.marginBottom = '16px';
      mount(content, panes[dtab]);
      mount(body, tbar, content);
      mount(footer,
        w.level === 'manage' && canManage && button('Bearbeiten', { icon: 'edit', onClick: () => { m.close(); editor(w); } }),
        at && can('map.view') && button('Auf Karte zeigen', { icon: 'map', onClick: () => { try { sessionStorage.setItem('mdt:map:focus', JSON.stringify({ type: 'warehouse', id: w.id, x: at.x, y: at.y })); } catch { /* egal */ } m.close(); ctx.openApp('map'); window.dispatchEvent(new Event('mdt:map-focus')); } }),
        h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
    }
    await showDetail();
    off = ctx.live(['warehouse'], showDetail, { wait: 150 });
  }

  // ── Ein-/Auslagern/Korrigieren ──
  function stockDialog(w, action, row) {
    const err = h('div');
    const itemSel = select(opts.items.map((i) => ({ value: i.id, label: `${i.name} (${i.unit})` })), row?.itemId ?? '', { disabled: !!row });
    const qty = input({ type: 'number', min: 0, inputmode: 'numeric', value: action === 'set' ? row.quantity : '' });
    const text = input({ maxLength: 200, placeholder: 'Notiz (optional)' });
    const title = { in: 'Einlagern', out: 'Auslagern', set: 'Bestand korrigieren' }[action];
    const hint = action === 'set' ? 'Setzt den Bestand auf genau diese Menge.' : action === 'out' ? `Aktuell im Lager: ${nf(row.quantity)} ${row.unit}` : w.capacity != null ? `Frei: ${nf(Math.max(0, w.capacity - w.used))} Slots` : '';
    const slotInfo = h('div', { class: 'help' });
    const showSlots = () => { const it = opts.items.find((x) => String(x.id) === String(itemSel.value)); if (!it) { slotInfo.textContent = ''; return; } const q = Number(qty.value) || 0; slotInfo.textContent = `${it.name}: ${it.space} Slot${it.space === 1 ? '' : 's'} pro Stapel, max. ${it.stackSize} pro Stapel${q > 0 ? ` – ${nf(q)} Stück = ${nf(Math.ceil(q / it.stackSize))} Stapel = ${nf(Math.ceil(q / it.stackSize) * it.space)} Slots` : ''}`; };
    itemSel.addEventListener('change', showSlots); qty.addEventListener('input', showSlots); setTimeout(showSlots, 0);
    const sm = openModal({
      title: `${title}: ${w.name}`,
      body: h('div', null, err, field('Artikel', itemSel), field(action === 'set' ? 'Neuer Bestand' : 'Menge', qty, { help: hint }), slotInfo, field('Notiz', text),
        !opts.items.length && note('Es gibt noch keine Artikel. Lege sie im Tab „Artikel & Preise“ an.', 'info')),
      footer: [button('Abbrechen', { onClick: () => sm.close() }), button(title, { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        try { await api.post(`/api/warehouses/${w.id}/stock`, { itemId: Number(itemSel.value), action, quantity: Number(qty.value), note: text.value.trim() }); sm.close(); toast('Gebucht.'); }
        catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
  }
  async function transferDialog(w, row) {
    let targets = [];
    try { targets = (await api.get('/api/warehouses')).warehouses.filter((x) => x.id !== w.id && x.canBook && x.isActive); } catch { /* keine */ }
    if (!targets.length) return toast('Es gibt kein weiteres Lager, in das du umlagern darfst.', 'warn');
    const err = h('div');
    const to = select(targets.map((x) => ({ value: x.id, label: x.name })), '');
    const qty = input({ type: 'number', min: 1, inputmode: 'numeric', max: row.quantity });
    const text = input({ maxLength: 200, placeholder: 'Notiz (optional)' });
    const tm = openModal({
      title: `Umlagern: ${row.name}`,
      body: h('div', null, err, field('Ziel-Lager', to), field('Menge', qty, { help: `Verfügbar: ${nf(row.quantity)} ${row.unit}` }), field('Notiz', text)),
      footer: [button('Abbrechen', { onClick: () => tm.close() }), button('Umlagern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        try { await api.post(`/api/warehouses/${w.id}/transfer`, { toId: Number(to.value), itemId: row.itemId, quantity: Number(qty.value), note: text.value.trim() }); tm.close(); toast('Umgelagert.'); }
        catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
  }

  // ── Lager anlegen/bearbeiten ──
  function editor(w) {
    const err = h('div');
    const name = input({ value: w?.name ?? '', maxLength: 80, placeholder: 'z. B. Hafen-Lager' });
    const type = select([{ value: '', label: '— keine —' }, ...opts.types.map((t) => ({ value: t.id, label: t.label }))], w?.type?.id ?? '');
    const desc = input({ value: w?.description ?? '', maxLength: 500, placeholder: 'Wofür wird das Lager genutzt?' });
    const loc = input({ value: w?.location.text ?? '', maxLength: 120, placeholder: 'z. B. Hafen Süd, Halle 3' });
    const postal = input({ value: w?.location.postal ?? '', maxLength: 6, inputMode: 'numeric', placeholder: 'z. B. 7085' });
    const lx = input({ type: 'number', step: 'any', value: w?.location.x ?? '', placeholder: 'X (optional)' }), ly = input({ type: 'number', step: 'any', value: w?.location.y ?? '', placeholder: 'Y (optional)' });
    const cap = input({ type: 'number', min: 0, value: w?.capacity ?? '', placeholder: 'leer = unbegrenzt' });
    const size = input({ value: w?.sizeInfo ?? '', maxLength: 120, placeholder: 'z. B. 120 m², große Halle' });
    const canAcc = can('warehouse.view_access');
    const access = h('textarea', { class: 'textarea', maxLength: 500, placeholder: 'Wie kommt man ins Lager? (Schlüssel, Tor-Code, Ansprechpartner …)', disabled: !canAcc && !!w }, w?.accessInfo ?? '');
    const dept = select([{ value: '', label: '— keine —' }, ...opts.departments.map((d) => ({ value: d.id, label: d.name }))], w?.department?.id ?? '');
    const notes = h('textarea', { class: 'textarea', maxLength: 1000 }, w?.notes ?? '');
    const restricted = h('input', { type: 'checkbox', checked: w?.restricted ?? false });
    const active = w && h('input', { type: 'checkbox', checked: w.isActive });
    const levels = new Map(opts.roles.map((r) => [r.id, w?.access?.find((a) => a.roleId === r.id)?.level ?? '']));
    const roleRows = h('div');
    const drawRoles = () => mount(roleRows, opts.roles.map((r) => {
      const s = select([{ value: '', label: 'Kein Zugriff' }, { value: 'view', label: 'Ansehen' }, { value: 'manage', label: 'Verwalten (ein-/auslagern)' }], levels.get(r.id), { style: { width: '220px' } });
      s.addEventListener('change', () => levels.set(r.id, s.value));
      return h('div', { class: 'list-row' }, h('span', { class: 'dot', style: { width: '10px', height: '10px', borderRadius: '50%', background: r.color, flex: 'none' } }), h('div', { class: 'grow' }, r.name), s);
    }));
    drawRoles();
    // Lagerkosten-Erinnerung (wöchentlich)
    const rent = w?.rent ?? { enabled: false, cents: 0, weekday: 1, hour: 18, roleIds: [], userIds: [] };
    const rentOn = h('input', { type: 'checkbox', checked: rent.enabled });
    const rentAmount = input({ type: 'number', min: 0, step: '0.01', value: rent.cents ? (rent.cents / 100).toFixed(2) : '', placeholder: 'z. B. 2500' });
    const rentDay = select((opts.weekdays ?? []).map((n, i) => ({ value: i, label: n })), rent.weekday);
    const rentHour = select(Array.from({ length: 24 }, (_, i) => ({ value: i, label: `${String(i).padStart(2, '0')}:00 Uhr` })), rent.hour);
    const recRoles = new Set(rent.roleIds), recUsers = new Set(rent.userIds);
    const recBox = h('div', { class: 'ct-roles' });
    const drawRec = () => mount(recBox, [
      ...opts.roles.map((r) => { const c = h('input', { type: 'checkbox', checked: recRoles.has(r.id) }); c.addEventListener('change', () => (c.checked ? recRoles.add(r.id) : recRoles.delete(r.id))); return h('label', { class: 'check', style: { padding: '2px 0' } }, c, h('span', { class: 'check-text' }, h('span', { class: 'dot', style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: r.color, marginRight: '6px' } }), `Rolle: ${r.name}`)); }),
      ...(opts.members ?? []).map((u) => { const c = h('input', { type: 'checkbox', checked: recUsers.has(u.id) }); c.addEventListener('change', () => (c.checked ? recUsers.add(u.id) : recUsers.delete(u.id))); return h('label', { class: 'check', style: { padding: '2px 0' } }, c, h('span', { class: 'check-text' }, `Mitglied: ${u.label}`)); }),
    ]);
    drawRec();
    const sec = (t) => [h('div', { class: 'sep' }), h('div', { class: 'label', style: { margin: '0 0 8px' } }, t)];
    const body = h('div', null, err,
      h('div', { class: 'form-row' }, field('Name', name), field('Lagerart', type, { help: opts.types.length ? '' : 'Arten pflegst du unter „Kategorien & Status“.' })), field('Beschreibung', desc),
      ...sec('Standort'),
      h('div', { class: 'form-row' }, field('Standort', loc), field('Postleitzahl', postal, { help: 'Die Karte setzt das Lager automatisch auf diese Postal.' })),
      h('div', { class: 'form-row' }, field('Position X', lx), field('Position Y', ly)), h('div', { class: 'help' }, 'Koordinaten sind optional und überschreiben die Postleitzahl.'),
      ...sec('Größe & Zugang'),
      h('div', { class: 'form-row' }, field('Kapazität (Slots)', cap), field('Größe', size)), field('Wie wird das Lager zugegriffen?', access),
      ...sec('Zuordnung'), h('div', { class: 'form-row' }, field('Abteilung', dept), field('Notizen', notes)),
      ...sec('Zugriffe im MDT'),
      h('label', { class: 'check', style: { padding: 0 } }, restricted, h('span', { class: 'check-text' }, 'Beschränkt – nur ausgewählte Rollen sehen dieses Lager')),
      h('div', { class: 'help', style: { margin: '6px 0 10px' } }, 'Rollen mit „Verwalten“ dürfen ein- und auslagern (Recht „Lager: Bestand buchen“ vorausgesetzt). Administratoren sehen immer alles.'), roleRows,
      ...sec('Lagerkosten-Erinnerung'),
      h('label', { class: 'check', style: { padding: 0 } }, rentOn, h('span', { class: 'check-text' }, 'Wöchentlich an die fälligen Lagerkosten erinnern')),
      h('div', { class: 'form-row', style: { marginTop: '10px' } }, field(`Kosten pro Woche (${opts.currency})`, rentAmount, { help: 'Wird in der Benachrichtigung genannt. Leer = ohne Betrag.' }), field('Wochentag', rentDay)),
      h('div', { class: 'form-row' }, field('Uhrzeit', rentHour, { help: 'Ab dieser Stunde wird erinnert (Serverzeit).' }), h('div')),
      h('div', { class: 'label', style: { margin: '4px 0 6px' } }, 'Wer wird benachrichtigt?'), recBox,
      h('div', { class: 'help', style: { marginTop: '6px' } }, 'Ohne Auswahl erhalten alle Mitglieder mit dem Recht „Lager verwalten“ die Erinnerung.'),
      active && h('div', { style: { marginTop: '12px' } }, h('label', { class: 'check', style: { padding: 0 } }, active, h('span', { class: 'check-text' }, 'Lager ist aktiv'))));
    const footer = [];
    if (w) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      if (!await confirmDialog({ title: 'Lager löschen?', message: `${w.name} (${w.number}) wird gelöscht. Das geht nur, wenn es leer ist.`, confirmLabel: 'Löschen' })) return;
      try { await api.del(`/api/warehouses/${w.id}`); m.close(); toast('Lager gelöscht.'); }
      catch (e) {
        if (e.status === 409 && state.user.isSuperadmin && await confirmDialog({ title: 'Samt Inhalt löschen?', message: `${w.name} ist nicht leer. Als Superadmin kannst du es samt Bestand und Verlauf endgültig löschen.`, confirmLabel: 'Samt Inhalt löschen' })) {
          try { await api.del(`/api/warehouses/${w.id}?force=1`); m.close(); toast('Lager gelöscht.'); } catch (e2) { toast(e2.message, 'err'); }
        } else if (e.status !== 409 || !state.user.isSuperadmin) toast(e.message, 'err');
      }
    } }));
    footer.push(h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }), button(w ? 'Speichern' : 'Anlegen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      const payload = {
        name: name.value, typeId: type.value ? Number(type.value) : null, description: desc.value, locationText: loc.value, postal: postal.value.trim(), locX: num(lx), locY: num(ly),
        capacity: num(cap), sizeInfo: size.value, notes: notes.value, departmentId: dept.value ? Number(dept.value) : null, restricted: restricted.checked,
        access: [...levels].filter(([, l]) => l).map(([roleId, level]) => ({ roleId, level })),
      };
      if (canAcc || !w) payload.accessInfo = access.value;
      payload.rent = { enabled: rentOn.checked, cents: rentAmount.value === '' ? 0 : Math.round(Number(rentAmount.value) * 100), weekday: Number(rentDay.value), hour: Number(rentHour.value), roleIds: [...recRoles], userIds: [...recUsers] };
      if (active) payload.isActive = active.checked;
      try { w ? await api.patch(`/api/warehouses/${w.id}`, payload) : await api.post('/api/warehouses', payload); m.close(); toast(w ? 'Gespeichert.' : 'Lager angelegt.'); }
      catch (ex) { err.replaceChildren(formError(ex.message)); body.parentElement.scrollTop = 0; }
    }) }));
    const m = openModal({ title: w ? `Lager bearbeiten: ${w.name}` : 'Neues Lager', wide: true, body, footer });
  }

  // ── Artikel & Preise ──
  async function showItems() {
    let data;
    try { data = await api.get('/api/warehouse/items'); } catch (e) { return mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
    if (!ctx.isCurrent() || tab !== 'items') return;
    drawTabs();
    mount(host,
      canPrices && note('Die Preisspanne (Min/Max) bestimmt den automatischen Preisvorschlag für Partner in der Börse. Standardmäßig sinkt der Vorschlag mit steigendem Bestand (Zielbestand) – die Regel stellst du unter Konfiguration → Lager ein. Partner sehen nur den Vorschlag, nie die Spanne.', 'tag'),
      h('div', { style: { height: '12px' } }),
      table([
        { label: 'Artikel', render: (i) => h('div', null, h('b', null, i.name), ' ', !i.isActive && h('span', { class: 'badge no-dot b-mute' }, 'Inaktiv'), i.category && h('div', null, chip(i.category))) },
        { label: 'Einheit', render: (i) => i.unit },
        { label: 'Slots', render: (i) => h('span', { title: 'Slots pro Stapel · maximale Menge pro Stapel' }, `${nf(i.space)} Slot${i.space === 1 ? '' : 's'} · max. ${nf(i.stackSize)} pro Stapel`) },
        { label: 'Bestand', render: (i) => `${nf(i.totalStock)}${i.targetStock ? ` / Ziel ${nf(i.targetStock)}` : ''}` },
        canPrices && { label: 'Preisspanne', render: (i) => (i.minPrice != null ? `${money(i.minPrice)} – ${money(i.maxPrice)}` : h('span', { class: 'muted' }, 'keine')) },
        canPrices && { label: 'Aktueller Vorschlag', render: (i) => (i.suggestedPrice != null ? h('b', null, money(i.suggestedPrice)) : '–') },
        canItems && { label: '', style: { textAlign: 'right' }, render: (i) => button('Bearbeiten', { size: 'sm', icon: 'edit', onClick: () => itemEditor(i) }) },
      ].filter(Boolean), data.items, { empty: empty('Noch keine Artikel', canItems ? 'Lege den ersten Artikel an – er erscheint automatisch in der Börse.' : null, 'tag') }));
  }

  function itemEditor(i) {
    const err = h('div');
    const name = input({ value: i?.name ?? '', maxLength: 80, placeholder: 'z. B. Eisenerz' });
    const cat = select([{ value: '', label: '— keine —' }, ...opts.categories.map((c) => ({ value: c.id, label: c.label }))], i?.category?.id ?? '');
    const unit = input({ value: i?.unit ?? 'Stück', maxLength: 20 });
    const space = input({ type: 'number', min: 1, value: i?.space ?? 1 }), stack = input({ type: 'number', min: 1, value: i?.stackSize ?? 1 });
    const target = input({ type: 'number', min: 0, value: i?.targetStock ?? '', placeholder: 'optional' });
    const lo = input({ type: 'number', min: 0, value: i?.minPrice ?? '', placeholder: 'Mindestpreis' }), hi = input({ type: 'number', min: 0, value: i?.maxPrice ?? '', placeholder: 'Höchstpreis' });
    const desc = input({ value: i?.description ?? '', maxLength: 300 });
    const active = i && h('input', { type: 'checkbox', checked: i.isActive });
    const preview = h('div', { class: 'help' });
    const upd = () => { preview.textContent = lo.value !== '' && hi.value !== '' ? `Preisvorschlag für Partner liegt zwischen ${money(Number(lo.value))} und ${money(Number(hi.value))} pro ${unit.value || 'Einheit'}.` : ''; };
    lo.addEventListener('input', upd); hi.addEventListener('input', upd); upd();
    const body = h('div', null, err,
      h('div', { class: 'form-row' }, field('Name', name), field('Kategorie', cat)),
      h('div', { class: 'form-row' }, field('Einheit', unit), field('Slots pro Stapel', space, { help: 'So viele Slots belegt ein Stapel.' })), h('div', { class: 'form-row' }, field('Max. Menge pro Stapel', stack, { help: 'Wie im Inventar: z. B. 1 Slot / 5 Stück, 2 Slots / 2 Stück, 3 Slots / 1 Stück. Angefangene Stapel belegen volle Slots.' }), h('div')), field('Beschreibung', desc),
      canPrices && [h('div', { class: 'sep' }), h('div', { class: 'label', style: { margin: '0 0 8px' } }, 'Preisspanne für die Börse (pro Einheit)'),
        h('div', { class: 'form-row' }, field('Mindestpreis', lo), field('Höchstpreis', hi)), preview,
        field('Zielbestand', target, { help: 'Ab dieser Menge im Lager liegt der Vorschlag am Mindestpreis; ist das Lager leer, am Höchstpreis.' })],
      active && h('label', { class: 'check', style: { padding: 0, marginTop: '10px' } }, active, h('span', { class: 'check-text' }, 'Artikel ist aktiv (in der Börse sichtbar)')));
    const footer = [];
    if (i) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      if (!await confirmDialog({ title: 'Artikel löschen?', message: `${i.name} wird entfernt. Das geht nur ohne Bestand und ohne Börsen-Geschäfte.`, confirmLabel: 'Löschen' })) return;
      try { await api.del(`/api/warehouse/items/${i.id}`); m.close(); toast('Artikel gelöscht.'); } catch (e) {
        if (e.status === 409 && state.user.isSuperadmin && await confirmDialog({ title: 'Samt allem löschen?', message: `${e.message.split(' (Superadmins')[0]} Als Superadmin kannst du den Artikel samt Geschäften, Gesuchen und Beständen endgültig löschen.`, confirmLabel: 'Alles endgültig löschen' })) {
          try { await api.del(`/api/warehouse/items/${i.id}` + '?force=1'); m.close(); toast('Artikel gelöscht.'); } catch (e2) { toast(e2.message, 'err'); }
        } else if (e.status !== 409 || !state.user.isSuperadmin) toast(e.message, 'err');
      }
    } }));
    footer.push(h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }), button(i ? 'Speichern' : 'Anlegen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      const payload = { name: name.value, categoryId: cat.value ? Number(cat.value) : null, unit: unit.value, space: Number(space.value), stackSize: Number(stack.value), description: desc.value, targetStock: num(target) };
      if (canPrices) { payload.minPrice = num(lo); payload.maxPrice = num(hi); }
      if (active) payload.isActive = active.checked;
      try { i ? await api.patch(`/api/warehouse/items/${i.id}`, payload) : await api.post('/api/warehouse/items', payload); m.close(); toast(i ? 'Gespeichert.' : 'Artikel angelegt.'); }
      catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) }));
    const m = openModal({ title: i ? `Artikel: ${i.name}` : 'Neuer Artikel', wide: true, body, footer });
  }

  ctx.live(['warehouse', 'lookups', 'market', 'org'], () => show(tab, true), { wait: 150 });
  await show('warehouses');
}
