import { h, mount, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, select, formError, openModal, confirmDialog, toast, empty, tabs, note } from '../ui/kit.js';
import { api } from '../api.js';

/**
 * Bürgerregister (Staatsdatenbank): links Suche und Trefferliste, rechts die Akte des Einwohners –
 * Stammdaten, Kontaktdaten, zugelassene Fahrzeuge, Lizenzen und verlinkte Akten. Fahndungen sind rot markiert.
 */
export const fmtDay = (s) => (s ? s.slice(0, 10).split('-').reverse().join('.') : '–');
const textarea = (value, rows = 3, max = 2000) => { const t = h('textarea', { class: 'textarea', rows, maxLength: max }); t.value = value ?? ''; return t; };
const kv = (k, v) => (v ? h('div', { class: 'ct-kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)) : null);
const chip = (text, color) => h('span', { class: 'badge', style: { '--c': color } }, text);
export const caseLink = (c, open) => {
  const b = h('button', { class: 'ct-row', type: 'button', style: { marginBottom: '4px' } },
    h('div', { class: 'ct-name' }, h('b', null, c.number), chip(c.typeLabel, c.typeColor), c.role && h('span', { class: 'muted' }, c.role)), h('div', { class: 'ct-sub' }, h('span', null, c.title), h('span', { class: 'muted' }, c.statusLabel)));
  b.addEventListener('click', () => open(c.id)); return b;
};

export default async function render(container, ctx) {
  let opts; try { opts = await api.get('/api/citizens/options'); } catch (e) { return mount(container, empty('Nicht verfügbar', e.message, 'alert')); }
  const f = { q: '', wanted: false };
  let sel = null, list = [], total = 0, wantedCount = 0, tab = 'data';
  const listEl = h('div', { class: 'ct-list' }), detailEl = h('div', { class: 'ct-detail' }), filters = h('div', { class: 'ct-filters' }), counter = h('div', { class: 'muted', style: { padding: '0 12px 6px', fontSize: '12.5px' } });
  mount(container, h('div', { class: 'ct' }, h('aside', { class: 'ct-side' }, h('div', { style: { padding: '10px 10px 4px' } }, filters), counter, listEl), detailEl));
  container.style.maxWidth = 'none'; container.style.height = '100%';

  const q = input({ type: 'search', placeholder: 'Name, Geburtsdatum, Telefon, E-Mail, Kennzeichen …' });
  q.addEventListener('input', debounce(() => { f.q = q.value.trim(); loadList(); }, 250));
  const wantedBtn = button('Fahndung', { size: 'sm', icon: 'alert', onClick: () => { f.wanted = !f.wanted; wantedBtn.classList.toggle('primary', f.wanted); loadList(); } });
  mount(filters, q, h('div', { class: 'row', style: { marginTop: '6px' } }, wantedBtn));
  ctx.setActions(opts.can.create && button('Bürger anlegen', { variant: 'primary', icon: 'plus', onClick: () => citizenDialog(null) }));

  async function loadList() {
    const p = new URLSearchParams(); if (f.q) p.set('q', f.q); if (f.wanted) p.set('wanted', '1');
    try { const r = await api.get(`/api/citizens?${p}`); list = r.citizens; total = r.total; wantedCount = r.wantedCount; } catch (e) { return mount(listEl, empty('Fehler beim Laden', e.message, 'alert')); }
    if (!ctx.isCurrent()) return;
    counter.textContent = `${total} Treffer${wantedCount ? ` · ${wantedCount} zur Fahndung ausgeschrieben` : ''}${total > list.length ? ` (erste ${list.length} angezeigt)` : ''}`;
    mount(listEl, list.length ? list.map((c) => {
      const b = h('button', { class: `ct-row ${sel === c.id ? 'on' : ''}`, type: 'button' },
        h('div', { class: 'ct-name' }, h('b', null, `${c.lastName}, ${c.firstName}`), c.isWanted && chip('Fahndung', '#ef4444'), c.status !== 'active' && chip(c.statusLabel, '#94a3b8')),
        h('div', { class: 'ct-sub' }, h('span', { class: 'muted' }, [c.number, c.birthDate && fmtDay(c.birthDate), c.plates.join(', ')].filter(Boolean).join(' · '))));
      b.addEventListener('click', () => open(c.id)); return b;
    }) : empty(f.q || f.wanted ? 'Nichts gefunden' : 'Noch keine Bürger', opts.can.create ? 'Mit „Bürger anlegen“ erfasst du den ersten Einwohner.' : null));
  }
  async function open(id, keepTab = false) { if (!keepTab) tab = 'data'; sel = id; await loadList(); await showDetail(); }
  async function showDetail() {
    if (!sel) return mount(detailEl, empty('Bürgerregister', 'Wähle links einen Einwohner oder suche nach Name, Kennzeichen oder Telefonnummer.', 'users'));
    let c; try { c = (await api.get(`/api/citizens/${sel}`)).citizen; } catch (e) { sel = null; return mount(detailEl, empty('Nicht gefunden', e.message, 'alert')); }
    if (!ctx.isCurrent()) return;
    const tabBar = tabs([{ id: 'data', label: 'Stammdaten' }, { id: 'vehicles', label: 'Fahrzeuge', count: c.vehicles.length }, { id: 'licenses', label: 'Lizenzen', count: c.licenses.length }, { id: 'cases', label: 'Akten', count: c.cases.length }], tab, (t) => { tab = t; drawBody(); });
    const body = h('div', { style: { marginTop: '12px' } });
    const drawBody = () => mount(body, tab === 'data' ? dataPane(c) : tab === 'vehicles' ? vehiclePane(c) : tab === 'licenses' ? licensePane(c) : casePane(c));
    mount(detailEl,
      c.isWanted && h('div', { class: 'note', style: { borderColor: '#ef4444', marginBottom: '10px' } }, icon('alert'), h('div', null, h('b', null, 'Zur Fahndung ausgeschrieben'), ` – ${c.wantedReason}`, h('div', { class: 'muted' }, `${c.wantedBy ?? ''}${c.wantedAt ? ` · ${fmtDay(c.wantedAt)}` : ''}`))),
      h('div', { class: 'ct-head' }, h('div', null, h('h2', { style: { margin: 0 } }, `${c.firstName} ${c.lastName}`), h('div', { class: 'muted' }, [c.number, c.statusLabel, c.birthDate && `geb. ${fmtDay(c.birthDate)}`].filter(Boolean).join(' · '))),
        h('div', { class: 'row' }, opts.can.wanted && button(c.isWanted ? 'Fahndung aufheben' : 'Zur Fahndung', { icon: 'alert', variant: c.isWanted ? '' : 'danger', onClick: () => wantedDialog(c) }), opts.can.edit && button('Bearbeiten', { icon: 'edit', onClick: () => citizenDialog(c) }),
          opts.can.delete && button('', { icon: 'trash', variant: 'danger', title: 'Löschen', onClick: () => delCitizen(c) }))),
      tabBar, body);
    drawBody();
  }

  const dataPane = (c) => h('div', null,
    h('div', { class: 'ct-section' }, h('div', { class: 'label' }, 'Person'), kv('Nachname', c.lastName), kv('Vorname', c.firstName), kv('Geburtsdatum', c.birthDate && fmtDay(c.birthDate)), kv('Geburtsort', c.birthPlace), kv('Geschlecht', c.gender && c.genderLabel), kv('Nationalität', c.nationality), kv('Größe', c.heightCm && `${c.heightCm} cm`), kv('Beruf', c.occupation)),
    h('div', { class: 'ct-section', style: { marginTop: '14px' } }, h('div', { class: 'label' }, 'Kontakt & Anschrift'), kv('Telefon', c.phone), kv('E-Mail', c.email), kv('Anschrift', c.address)),
    c.notes && h('div', { class: 'ct-section', style: { marginTop: '14px' } }, h('div', { class: 'label' }, 'Notizen'), h('div', { style: { whiteSpace: 'pre-wrap' } }, c.notes)),
    h('div', { class: 'muted', style: { marginTop: '14px', fontSize: '12.5px' } }, `Erfasst ${fmtDay(c.createdAt)}${c.createdBy ? ` von ${c.createdBy}` : ''} · zuletzt geändert ${fmtDay(c.updatedAt)}`));

  const vehiclePane = (c) => h('div', null, opts.can.vehicles && button('Fahrzeug zulassen', { icon: 'plus', size: 'sm', onClick: () => vehicleDialog(c, null) }),
    c.vehicles.length ? c.vehicles.map((v) => h('div', { class: 'card', style: { marginTop: '10px', padding: '12px 14px' } },
      h('div', { class: 'ct-head', style: { marginBottom: '4px' } }, h('div', null, h('b', { style: { fontSize: '16px', letterSpacing: '.05em' } }, v.plate), ' ', chip(v.statusLabel, v.statusColor)), h('div', { class: 'row' },
        opts.can.vehicles && button('', { icon: 'edit', size: 'sm', variant: 'ghost', title: 'Bearbeiten', onClick: () => vehicleDialog(c, v) }), opts.can.vehicles && button('', { icon: 'trash', size: 'sm', variant: 'ghost', title: 'Entfernen', onClick: () => delVehicle(c, v) }))),
      kv('Fahrzeug', v.makeModel), kv('Farbe', v.color), kv('Fahrgestellnr.', v.vin), kv('Zugelassen', v.registeredAt && fmtDay(v.registeredAt)), kv('Notizen', v.notes),
      v.cases.length ? h('div', { style: { marginTop: '8px' } }, h('div', { class: 'label' }, 'Verlinkte Akten'), v.cases.map((x) => caseLink(x, openCase))) : null)) : h('div', { style: { marginTop: '10px' } }, empty('Keine Fahrzeuge', 'Auf diesen Bürger ist kein Fahrzeug zugelassen.', 'car')));

  const licensePane = (c) => h('div', null, opts.can.licenses && button('Lizenz eintragen', { icon: 'plus', size: 'sm', onClick: () => licenseDialog(c, null) }),
    c.licenses.length ? c.licenses.map((l) => h('div', { class: 'ct-row', style: { cursor: 'default', marginTop: '8px' } }, h('div', { class: 'ct-head', style: { marginBottom: 0 } },
      h('div', null, h('b', null, l.kind), ' ', chip(l.statusLabel, l.statusColor), h('div', { class: 'muted' }, [l.issuedAt && `ausgestellt ${fmtDay(l.issuedAt)}`, l.validUntil && `gültig bis ${fmtDay(l.validUntil)}`, l.note].filter(Boolean).join(' · '))),
      h('div', { class: 'row' }, opts.can.licenses && button('', { icon: 'edit', size: 'sm', variant: 'ghost', title: 'Bearbeiten', onClick: () => licenseDialog(c, l) }), opts.can.licenses && button('', { icon: 'trash', size: 'sm', variant: 'ghost', title: 'Entfernen', onClick: () => delLicense(c, l) })))))
      : h('div', { style: { marginTop: '10px' } }, empty('Keine Lizenzen', 'Führerscheine, Waffenscheine und weitere Lizenzen erscheinen hier.', 'shield')));

  const casePane = (c) => (c.cases.length ? h('div', null, note('Es werden nur Akten angezeigt, die du nach den Regeln deiner Behörde sehen darfst.', 'lock'), c.cases.map((x) => caseLink(x, openCase)))
    : empty('Keine sichtbaren Akten', 'Zu diesem Bürger gibt es keine Akten, die du einsehen darfst.', 'list'));
  const openCase = async (id) => { try { sessionStorage.setItem('mdt:cases:open', String(id)); } catch { /* egal */ } (await import('../shell.js')).openApp('cases'); window.dispatchEvent(new Event('mdt:cases-open')); };

  // ── Dialoge ──
  function citizenDialog(c) {
    const err = h('div'), v = (k) => c?.[k] ?? '';
    const last = input({ value: v('lastName'), maxLength: 60 }), first = input({ value: v('firstName'), maxLength: 60 }), birth = input({ type: 'date', value: v('birthDate') ?? '' }), place = input({ value: v('birthPlace'), maxLength: 80 });
    const gender = select(opts.genders.map((g) => ({ value: g.key, label: g.label })), v('gender')), nat = input({ value: v('nationality'), maxLength: 60 }), height = input({ type: 'number', min: 40, max: 260, value: v('heightCm') ?? '' });
    const phone = input({ value: v('phone'), maxLength: 30, placeholder: '555-0101' }), email = input({ value: v('email'), maxLength: 120 }), street = input({ value: v('street'), maxLength: 100 }), postal = input({ value: v('postal'), maxLength: 12 }), city = input({ value: v('city'), maxLength: 80 });
    const job = input({ value: v('occupation'), maxLength: 80 }), status = select(opts.statuses.map((s) => ({ value: s.key, label: s.label })), c?.status ?? 'active'), notes = textarea(c?.notes, 4);
    const m = openModal({ title: c ? `Bürger bearbeiten: ${c.firstName} ${c.lastName}` : 'Bürger anlegen', wide: true,
      body: h('div', null, err, h('div', { class: 'form-row' }, field('Nachname', last), field('Vorname', first)), h('div', { class: 'form-row' }, field('Geburtsdatum', birth), field('Geburtsort', place)),
        h('div', { class: 'form-row' }, field('Geschlecht', gender), field('Nationalität', nat), field('Größe (cm)', height)), h('div', { class: 'form-row' }, field('Telefonnummer', phone), field('E-Mail', email)),
        h('div', { class: 'form-row' }, field('Straße / Hausnummer', street), field('PLZ', postal), field('Ort', city)), h('div', { class: 'form-row' }, field('Beruf', job), c && field('Status', status)), field('Notizen', notes)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button(c ? 'Speichern' : 'Anlegen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        const payload = { lastName: last.value, firstName: first.value, birthDate: birth.value || null, birthPlace: place.value, gender: gender.value, nationality: nat.value, heightCm: height.value ? Number(height.value) : null, phone: phone.value, email: email.value, street: street.value, postal: postal.value, city: city.value, occupation: job.value, notes: notes.value };
        if (c) payload.status = status.value;
        try { const r = c ? await api.patch(`/api/citizens/${c.id}`, payload) : await api.post('/api/citizens', payload); m.close(); toast('Gespeichert.'); await open(r.citizen.id, !!c); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
    last.focus();
  }
  function wantedDialog(c) {
    if (c.isWanted) return confirmDialog({ title: 'Fahndung aufheben?', message: `Die Fahndung nach ${c.firstName} ${c.lastName} wird aufgehoben.`, confirmLabel: 'Aufheben', variant: 'primary' }).then(async (ok) => { if (!ok) return; try { await api.post(`/api/citizens/${c.id}/wanted`, { wanted: false }); toast('Fahndung aufgehoben.'); await open(c.id, true); } catch (e) { toast(e.message, 'err'); } });
    const err = h('div'), reason = textarea('', 3, 500);
    const m = openModal({ title: `Zur Fahndung ausschreiben: ${c.firstName} ${c.lastName}`, body: h('div', null, err, field('Grund der Fahndung', reason)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Ausschreiben', { variant: 'danger', icon: 'alert', onClick: (e) => busy(e.currentTarget, async () => { try { await api.post(`/api/citizens/${c.id}/wanted`, { wanted: true, reason: reason.value }); m.close(); toast('Fahndung eingetragen.'); await open(c.id, true); } catch (ex) { err.replaceChildren(formError(ex.message)); } }) })] });
  }
  async function delCitizen(c) {
    if (!await confirmDialog({ title: 'Bürger löschen?', message: `„${c.firstName} ${c.lastName}“ wird samt Fahrzeugen und Lizenzen aus dem Register entfernt. In Akten bleibt der Name erhalten.`, confirmLabel: 'Löschen' })) return;
    try { await api.del(`/api/citizens/${c.id}`); sel = null; toast('Bürger gelöscht.'); await loadList(); showDetail(); } catch (e) { toast(e.message, 'err'); }
  }
  function vehicleDialog(c, v) {
    const err = h('div'), plate = input({ value: v?.plate ?? '', maxLength: 12, placeholder: 'z. B. LS 4711', style: { textTransform: 'uppercase' } }), model = input({ value: v?.makeModel ?? '', maxLength: 80, placeholder: 'z. B. Karin Sultan' });
    const color = input({ value: v?.color ?? '', maxLength: 40 }), vin = input({ value: v?.vin ?? '', maxLength: 30 }), status = select(opts.vehicleStatuses.map((s) => ({ value: s.key, label: s.label })), v?.status ?? 'registered'), notes = textarea(v?.notes, 2, 500);
    const m = openModal({ title: v ? `Fahrzeug bearbeiten: ${v.plate}` : 'Fahrzeug zulassen', body: h('div', null, err, h('div', { class: 'form-row' }, field('Kennzeichen', plate), field('Marke / Modell', model)), h('div', { class: 'form-row' }, field('Farbe', color), field('Fahrgestellnummer', vin)), field('Status', status), field('Notizen', notes)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        const payload = { plate: plate.value, makeModel: model.value, color: color.value, vin: vin.value, status: status.value, notes: notes.value };
        try { v ? await api.patch(`/api/citizens/${c.id}/vehicles/${v.id}`, payload) : await api.post(`/api/citizens/${c.id}/vehicles`, payload); m.close(); toast('Gespeichert.'); tab = 'vehicles'; await showDetail(); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
  }
  async function delVehicle(c, v) { if (!await confirmDialog({ title: 'Fahrzeug entfernen?', message: `Das Fahrzeug ${v.plate} wird aus dem Register gelöscht.`, confirmLabel: 'Entfernen' })) return; try { await api.del(`/api/citizens/${c.id}/vehicles/${v.id}`); await showDetail(); } catch (e) { toast(e.message, 'err'); } }
  function licenseDialog(c, l) {
    const err = h('div'), kind = input({ value: l?.kind ?? '', maxLength: 60, list: 'lic-kinds', placeholder: 'z. B. Führerschein Klasse B' }), dl = h('datalist', { id: 'lic-kinds' }, opts.licenseKinds.map((k) => h('option', { value: k })));
    const status = select(opts.licenseStatuses.map((s) => ({ value: s.key, label: s.label })), l?.status ?? 'valid'), issued = input({ type: 'date', value: l?.issuedAt ?? '' }), until = input({ type: 'date', value: l?.validUntil ?? '' }), nt = input({ value: l?.note ?? '', maxLength: 300 });
    const m = openModal({ title: l ? 'Lizenz bearbeiten' : 'Lizenz eintragen', body: h('div', null, err, field('Lizenz', kind), dl, field('Status', status), h('div', { class: 'form-row' }, field('Ausgestellt am', issued), field('Gültig bis', until)), field('Notiz', nt)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        const payload = { kind: kind.value, status: status.value, issuedAt: issued.value || null, validUntil: until.value || null, note: nt.value };
        try { l ? await api.patch(`/api/citizens/${c.id}/licenses/${l.id}`, payload) : await api.post(`/api/citizens/${c.id}/licenses`, payload); m.close(); toast('Gespeichert.'); tab = 'licenses'; await showDetail(); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
  }
  async function delLicense(c, l) { if (!await confirmDialog({ title: 'Lizenz entfernen?', message: `„${l.kind}“ wird gelöscht.`, confirmLabel: 'Entfernen' })) return; try { await api.del(`/api/citizens/${c.id}/licenses/${l.id}`); await showDetail(); } catch (e) { toast(e.message, 'err'); } }

  // Sprung aus den Akten (Person → Bürgerregister)
  const takeOpen = () => { let id = null; try { id = Number(sessionStorage.getItem('mdt:citizens:open')); sessionStorage.removeItem('mdt:citizens:open'); } catch { /* egal */ } return id || null; };
  window.addEventListener('mdt:citizens-open', () => { const id = takeOpen(); if (id && ctx.isCurrent()) open(id); });
  const first = takeOpen(); if (first) sel = first;
  await loadList(); await showDetail();
}
