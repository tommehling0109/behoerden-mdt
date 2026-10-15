import { h, mount, fmtDate, fmtDateTime, timeAgo, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, card, field, input, select, tabs, badge, formError, openModal, confirmDialog, toast, skeletons, empty, note, memberNo } from '../ui/kit.js';
import { api } from '../api.js';
import { can } from '../state.js';

const readAsDataUrl = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Datei konnte nicht gelesen werden.')); r.readAsDataURL(file); });
const num = (el) => (el.value === '' ? null : Number(el.value));
const overdue = (d) => d && d < new Date().toISOString().slice(0, 10);
const chip = (o) => h('span', { class: 'badge', style: { '--c': o.color } }, o.label);

export default async function render(container, ctx) {
  const canCreate = can('vehicles.create'), canEdit = can('vehicles.edit'), canDelete = can('vehicles.delete'), canAssign = can('vehicles.assign'), canLoc = can('vehicles.view_location');
  const f = { q: '', condition: '', fuel: '', category: '', mine: false };
  let opts = await api.get('/api/vehicles/options');
  const toolbar = h('div', { class: 'toolbar' });
  const chips = h('div', { class: 'count-chips' });
  const host = h('div');
  mount(container, toolbar, chips, host);
  if (canCreate) ctx.setActions(button('Fahrzeug anlegen', { variant: 'primary', icon: 'plus', onClick: () => editor(null) }));

  async function load(silent = false) {
    if (!silent) mount(host, skeletons(3, 200));
    const p = new URLSearchParams();
    for (const k of ['q', 'condition', 'fuel', 'category']) if (f[k]) p.set(k, f[k]);
    if (f.mine) p.set('assigned', 'me');
    let data;
    try { [data, opts] = await Promise.all([api.get(`/api/vehicles?${p}`), api.get('/api/vehicles/options')]); } catch (e) { return mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
    if (!ctx.isCurrent()) return;
    drawToolbar(data);
    draw(data.vehicles);
  }

  function drawToolbar(data) {
    const hadFocus = toolbar.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    const search = input({ placeholder: 'Kennzeichen, Name, Fahrgestellnr. …', value: f.q });
    search.addEventListener('input', debounce(() => { f.q = search.value.trim(); load(true); }));
    const mk = (key, list, label) => {
      const s = select([{ value: '', label }, ...list.map((o) => ({ value: o.key ?? o.id, label: o.label }))], f[key], { style: { width: '170px' } });
      s.addEventListener('change', () => { f[key] = s.value; load(true); });
      return s;
    };
    mount(toolbar, h('div', { class: 'input-icon' }, icon('search'), search), mk('condition', opts.conditions, 'Alle Zustände'), mk('fuel', opts.fuels, 'Alle Kraftstoffe'),
      opts.categories.length > 0 && mk('category', opts.categories, 'Alle Klassen'),
      button('Nur meine', { size: 'sm', variant: f.mine ? 'primary' : 'ghost', icon: 'userCheck', onClick: () => { f.mine = !f.mine; load(true); } }), h('div', { class: 'grow' }),
      h('span', { class: 'muted' }, `${data.total} Fahrzeug${data.total === 1 ? '' : 'e'}`));
    mount(chips, h('span', { class: 'chip-label' }, 'Zustand'), opts.conditions.map((c) => {
      const n = data.counts[c.key] ?? 0;
      const b = h('button', { class: `cchip ${f.condition === c.key ? 'on' : ''} ${n === 0 ? 'zero' : ''}`, type: 'button', style: { '--c': c.color } }, h('span', { class: 'dot' }), c.label, h('span', { class: 'count' }, n));
      b.addEventListener('click', () => { f.condition = f.condition === c.key ? '' : c.key; load(true); });
      return b;
    }));
    if (hadFocus) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  function draw(list) {
    if (!list.length) return mount(host, card(null, empty('Keine Fahrzeuge', canCreate ? 'Lege das erste Fahrzeug an.' : 'Für diese Filter gibt es keine Fahrzeuge.', 'car')));
    mount(host, h('div', { class: 'veh-grid' }, list.map((v) => {
      const el = h('article', { class: 'card hoverable veh-card', tabindex: 0 },
        h('div', { class: 'veh-img', style: v.imageUrl ? { backgroundImage: `url(${v.imageUrl})` } : {} }, !v.imageUrl && icon('car'), chip(v.condition)),
        h('div', { class: 'veh-body' },
          h('div', { class: 'veh-title' }, h('h3', null, v.name), memberNo(v.plate)),
          h('div', { class: 'chips' }, chip(v.fuel), v.category && chip(v.category), v.department && h('span', { class: 'badge no-dot', style: { '--c': v.department.color } }, v.department.name), !v.isActive && badge('Inaktiv', 'b-mute', false)),
          h('div', { class: 'veh-meta' },
            h('div', null, h('span', { class: 'k' }, v.fuel.key === 'electric' ? 'Akku' : 'Tank'), v.fuelLevel != null ? `${v.fuelLevel} %` : '–',
              v.fuelLevel != null && h('div', { class: 'fuelbar', style: { '--c': v.fuelLevel < 20 ? 'var(--err)' : v.fuel.color } }, h('i', { style: { width: `${v.fuelLevel}%` } }))),
            h('div', null, h('span', { class: 'k' }, 'Fahrzeug-Nr.'), v.number ?? '–'),
            canLoc && h('div', null, h('span', { class: 'k' }, 'Standort'), v.location?.text || '–', v.location?.slot && ` · ${v.location.slot}`),
            h('div', null, h('span', { class: 'k' }, 'Zugewiesen'), v.assignedTo?.label ?? '–'),
            v.inspectionDue && h('div', null, h('span', { class: 'k' }, 'Hauptuntersuchung'), h('span', { class: overdue(v.inspectionDue) ? 'pill-warn' : '' }, fmtDate(v.inspectionDue)))),
          h('div', { class: 'veh-actions' }, button('Anzeigen', { size: 'sm', variant: 'info', icon: 'eye', onClick: (e) => { e.stopPropagation(); details(v.id); } }),
            canEdit && button('Bearbeiten', { size: 'sm', icon: 'edit', onClick: (e) => { e.stopPropagation(); editor(v); } }))));
      el.addEventListener('click', () => details(v.id));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') details(v.id); });
      return el;
    })));
  }

  // ── Detail (Übersicht / Historie) ──
  async function details(id) {
    const body = h('div', null, skeletons(3, 60));
    let off;
    const m = openModal({ title: 'Fahrzeug', wide: true, body, footer: null, onClose: () => off?.() });
    const footer = h('div', { class: 'modal-foot' });
    m.el.append(footer);
    let tab = 'info';
    async function show() {
      let d;
      try { d = await api.get(`/api/vehicles/${id}`); } catch (e) { mount(body, note(e.message, 'alert')); return; }
      const v = d.vehicle;
      m.el.querySelector('.modal-head h3').textContent = `${v.name} · ${v.plate}`;
      const kv = (k, val) => [h('dt', null, k), h('dd', null, val ?? '–')];
      const info = h('div', null,
        v.imageUrl && h('div', { class: 'veh-img', style: { backgroundImage: `url(${v.imageUrl})`, height: '190px', borderRadius: 'var(--r-lg)', marginBottom: '16px' } }),
        h('div', { class: 'chips', style: { marginBottom: '14px' } }, chip(v.condition), chip(v.fuel), v.category && chip(v.category), memberNo(v.number)),
        h('dl', { class: 'details-dl' },
          kv('Kennzeichen', v.plate), kv('Fahrgestellnummer', v.vin && h('span', { class: 'mono' }, v.vin)), kv('Farbe', v.color || null), kv('Sitzplätze', v.seats),
          kv(v.fuel.key === 'electric' ? 'Akku' : 'Tankstand', v.fuelLevel != null ? `${v.fuelLevel} %` : null), kv('Kilometerstand', v.mileage != null ? `${v.mileage.toLocaleString('de-DE')} km` : null),
          kv('Hauptuntersuchung', v.inspectionDue && h('span', { class: overdue(v.inspectionDue) ? 'pill-warn' : '' }, fmtDate(v.inspectionDue), overdue(v.inspectionDue) && ' (überfällig)')),
          kv('Abteilung', v.department && h('span', { class: 'badge no-dot', style: { '--c': v.department.color } }, v.department.name)),
          kv('Zugewiesen an', v.assignedTo?.label),
          canLoc && kv('Standort', v.location && [v.location.text, v.location.slot && `Stellplatz ${v.location.slot}`].filter(Boolean).join(' · ') || null),
          canLoc && v.location?.x != null && kv('Position', h('span', { class: 'mono' }, `${Math.round(v.location.x)}, ${Math.round(v.location.y)}`)),
          kv('Notizen', v.notes || null), kv('Zuletzt geändert', fmtDateTime(v.updatedAt))));
      const hist = h('div', null, d.history.length ? d.history.map((e) => h('div', { class: 'list-row' }, h('div', { class: 'dot-icon' }, icon(e.kind === 'condition' ? 'wrench' : e.kind === 'location' ? 'map' : e.kind === 'assigned' ? 'userCheck' : 'activity')),
        h('div', { class: 'grow' }, h('div', { class: 't', style: { whiteSpace: 'normal' } }, e.text), h('div', { class: 's' }, `${e.actor} · ${fmtDateTime(e.createdAt)}`)))) : empty('Noch keine Einträge', null, 'activity'));
      const acc = h('div', null, note('Der Zugriff auf Fahrzeuge wird über Rollen und Rechte gesteuert: „Fahrzeuge ansehen“ (nur lesen), „Standorte sehen“, „anlegen“, „bearbeiten“, „löschen“, „zuweisen“. Pflege sie unter Rollen & Rechte.', 'shield'));
      const panes = { info, hist, acc };
      const tbar = tabs([{ id: 'info', label: 'Übersicht' }, { id: 'hist', label: 'Historie', count: d.history.length }, { id: 'acc', label: 'Zugriff' }], tab, (t) => { tab = t; mount(content, panes[t]); });
      tbar.style.marginBottom = '16px';
      const content = h('div');
      mount(content, panes[tab]);
      mount(body, tbar, content);
      mount(footer,
        canEdit && button('Bearbeiten', { icon: 'edit', onClick: () => { m.close(); editor(v); } }),
        canLoc && v.location?.x != null && can('map.view') && button('Auf Karte zeigen', { icon: 'map', onClick: () => { try { sessionStorage.setItem('mdt:map:focus', JSON.stringify({ type: 'vehicle', id: v.id, x: v.location.x, y: v.location.y })); } catch { /* egal */ } m.close(); ctx.openApp('map'); window.dispatchEvent(new Event('mdt:map-focus')); } }),
        h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
    }
    await show();
    off = ctx.live(['vehicles'], show, { wait: 150 });
  }

  // ── Anlegen / Bearbeiten ──
  function editor(v) {
    const err = h('div');
    const name = input({ value: v?.name ?? '', maxLength: 80, placeholder: 'z. B. Mercedes G-Klasse' });
    const plate = input({ value: v?.plate ?? '', maxLength: 14, placeholder: 'AZ 047' });
    const vin = input({ value: v?.vin ?? '', maxLength: 30, placeholder: 'Fahrgestellnummer (VIN)' });
    const cat = select([{ value: '', label: '— keine —' }, ...opts.categories.map((c) => ({ value: c.id, label: c.label }))], v?.category?.id ?? '');
    const color = input({ value: v?.color ?? '', maxLength: 40, placeholder: 'z. B. Schwarz' });
    const seats = input({ type: 'number', min: 0, max: 99, value: v?.seats ?? '' });
    const fuel = select(opts.fuels.map((o) => ({ value: o.key, label: o.label })), v?.fuel.key ?? 'petrol');
    const level = input({ type: 'number', min: 0, max: 100, value: v?.fuelLevel ?? '', placeholder: '0–100' });
    const cond = select(opts.conditions.map((o) => ({ value: o.key, label: o.label })), v?.condition.key ?? 'ready');
    const km = input({ type: 'number', min: 0, value: v?.mileage ?? '' });
    const hu = input({ type: 'date', value: v?.inspectionDue ?? '' });
    const loc = input({ value: v?.location?.text ?? '', maxLength: 120, placeholder: 'z. B. Garage Nord', disabled: !canLoc && !!v });
    const slot = input({ value: v?.location?.slot ?? '', maxLength: 30, placeholder: 'z. B. N-14', disabled: !canLoc && !!v });
    const lx = input({ type: 'number', step: 'any', value: v?.location?.x ?? '', placeholder: 'X', disabled: !canLoc && !!v });
    const ly = input({ type: 'number', step: 'any', value: v?.location?.y ?? '', placeholder: 'Y', disabled: !canLoc && !!v });
    const dept = select([{ value: '', label: '— keine —' }, ...opts.departments.map((d) => ({ value: d.id, label: d.name }))], v?.department?.id ?? '');
    const member = canAssign ? select([{ value: '', label: '— niemand —' }, ...opts.members.map((u) => ({ value: u.id, label: u.label }))], v?.assignedTo?.id ?? '') : null;
    const notes = h('textarea', { class: 'textarea', maxLength: 1000, placeholder: 'Notizen zum Fahrzeug' }, v?.notes ?? '');
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    let pending = null;
    const thumb = h('div', { class: 'upload-thumb', style: v?.imageUrl ? { backgroundImage: `url(${v.imageUrl})` } : {} });
    file.addEventListener('change', async () => {
      const fl = file.files[0];
      if (!fl) return;
      if (fl.size > 2 * 1024 * 1024) return toast('Das Bild ist zu groß (maximal 2 MB).', 'err');
      pending = await readAsDataUrl(fl);
      thumb.style.backgroundImage = `url(${pending})`;
    });
    const active = v && h('label', { class: 'check', style: { padding: 0 } }, h('input', { type: 'checkbox', checked: v.isActive }), h('span', { class: 'check-text' }, 'Fahrzeug ist aktiv (im Fuhrpark)'));
    const body = h('div', null, err,
      h('div', { class: 'label', style: { margin: '0 0 8px' } }, 'Fahrzeug'),
      h('div', { class: 'form-row' }, field('Fahrzeug / Modell', name), field('Kennzeichen', plate)),
      h('div', { class: 'form-row' }, field('Fahrgestellnummer', vin), field('Fahrzeugklasse', cat, { help: opts.categories.length ? '' : 'Klassen legst du unter „Kategorien & Status“ an.' })),
      h('div', { class: 'form-row' }, field('Farbe', color), field('Sitzplätze', seats)),
      h('div', { class: 'upload-row', style: { marginBottom: '16px' } }, thumb, h('div', null, file, button('Bild wählen', { size: 'sm', icon: 'download', onClick: () => file.click() }), h('div', { class: 'help', style: { marginTop: '6px' } }, 'PNG, JPEG oder WebP, max. 2 MB'))),
      h('div', { class: 'sep' }), h('div', { class: 'label', style: { margin: '0 0 8px' } }, 'Technik & Zustand'),
      h('div', { class: 'form-row' }, field('Kraftstoff', fuel), field('Tank / Akku (%)', level)),
      h('div', { class: 'form-row' }, field('Fahrzeugzustand', cond), field('Kilometerstand', km)),
      field('Hauptuntersuchung bis', hu),
      h('div', { class: 'sep' }), h('div', { class: 'label', style: { margin: '0 0 8px' } }, 'Standort'),
      (!canLoc && v) ? note('Für den Standort fehlt dir das Recht „Fahrzeug-Standorte sehen“.', 'lock') : h('div', null,
        h('div', { class: 'form-row' }, field('Standort', loc), field('Stellplatz', slot)),
        h('div', { class: 'form-row' }, field('Position X (Spielkoordinate)', lx), field('Position Y', ly)), h('div', { class: 'help' }, 'Mit Koordinaten erscheint das Fahrzeug auf der Karte (Fahrzeug-Ebene).')),
      h('div', { class: 'sep' }), h('div', { class: 'label', style: { margin: '0 0 8px' } }, 'Zuordnung'),
      h('div', { class: 'form-row' }, field('Abteilung', dept), member ? field('Zugewiesen an (Personalnummer)', member) : field('Zugewiesen an', h('div', { class: 'muted' }, 'Dafür fehlt das Recht „zuweisen“.'))),
      field('Notizen', notes), active);
    const footer = [];
    if (v && canDelete) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      const r = await confirmDialog({ title: 'Fahrzeug löschen?', message: `${v.name} (${v.plate}) wird mit Historie gelöscht.`, confirmLabel: 'Löschen' });
      if (!r) return;
      try { await api.del(`/api/vehicles/${v.id}`); m.close(); toast('Fahrzeug gelöscht.'); load(true); } catch (e) { toast(e.message, 'err'); }
    } }));
    footer.push(h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }), button(v ? 'Speichern' : 'Anlegen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      const payload = {
        name: name.value, plate: plate.value, vin: vin.value, categoryId: cat.value ? Number(cat.value) : null, color: color.value, seats: num(seats), fuel: fuel.value, fuelLevel: num(level),
        condition: cond.value, mileage: num(km), inspectionDue: hu.value || null, notes: notes.value, departmentId: dept.value ? Number(dept.value) : null,
      };
      if (canLoc || !v) Object.assign(payload, { locationText: loc.value, parkingSlot: slot.value, locX: num(lx), locY: num(ly) });
      if (member) payload.assignedUserId = member.value ? Number(member.value) : null;
      if (active) payload.isActive = active.querySelector('input').checked;
      try {
        const res = v ? await api.patch(`/api/vehicles/${v.id}`, payload) : await api.post('/api/vehicles', payload);
        if (pending && canEdit) await api.post(`/api/vehicles/${res.vehicle.id}/image`, { data: pending });
        m.close(); toast(v ? 'Gespeichert.' : 'Fahrzeug angelegt.'); load(true);
      } catch (ex) { err.replaceChildren(formError(ex.message)); body.parentElement.scrollTop = 0; }
    }) }));
    const m = openModal({ title: v ? `Fahrzeug bearbeiten: ${v.plate}` : 'Neues Fahrzeug', wide: true, body, footer });
  }

  ctx.live(['vehicles', 'lookups', 'org'], () => load(true));
  await load();
}
