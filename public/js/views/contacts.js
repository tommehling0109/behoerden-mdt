import { h, mount, debounce, fmtDateTime } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, select, toggle, checkbox, formError, openModal, confirmDialog, toast, empty, skeletons, note } from '../ui/kit.js';
import { api } from '../api.js';

/**
 * Kontaktbuch: links die Liste (Institutionen oder Personen, mit Suche und Filtern), rechts die Details.
 * Institutionen (Behörden, Firmen, Gruppierungen, Vereine …) haben Kontaktdaten und Personen (Mitarbeiter, Angehörige …);
 * Personen haben Adresse, Wohnanschrift, Kontaktdaten, Stellung und – mit eigenem Recht – Bankdaten. Einträge lassen sich für Rollen sperren und kennzeichnen.
 */
const tag = (t) => (t ? h('span', { class: 'badge', style: { '--c': t.color } }, t.label) : null);
const flagBadge = (f) => (f ? h('span', { class: 'badge ct-flag', style: { '--c': f.color } }, f.label) : null);
const lockMark = (x) => (x.restricted ? h('span', { class: 'ct-lock', title: 'Für bestimmte Rollen gesperrt' }, icon('lockClosed')) : null);
const CH_ICON = { phone: 'activity', mobile: 'activity', email: 'chat', fax: 'list', website: 'link', other: 'info' };

export default async function render(container, ctx) {
  let opts; try { opts = await api.get('/api/contacts/options'); } catch (e) { return mount(container, empty('Nicht verfügbar', e.message, 'alert')); }
  const f = { tab: 'orgs', q: '', cat: '', flag: '' };
  let sel = null; // { type: 'org'|'person', id }
  let list = { orgs: [], people: [] };
  const listEl = h('div', { class: 'ct-list' }), detailEl = h('div', { class: 'ct-detail' }), tabsEl = h('div', { class: 'ct-tabs' });
  mount(container, h('div', { class: 'ct' }, h('aside', { class: 'ct-side' }, tabsEl, h('div', { class: 'ct-filters' }), listEl), detailEl));
  container.style.maxWidth = 'none'; container.style.height = '100%';
  const filters = container.querySelector('.ct-filters');

  function drawActions() {
    ctx.setActions(opts.canEdit && h('div', { class: 'row' }, button('Institution', { variant: f.tab === 'orgs' ? 'primary' : '', icon: 'plus', onClick: () => orgDialog(null) }), button('Person', { variant: f.tab === 'people' ? 'primary' : '', icon: 'userPlus', onClick: () => personDialog(null, sel?.type === 'org' ? sel.id : null) })));
  }
  function setTab(k) { f.tab = k; f.cat = ''; drawActions(); drawTabs(); return loadList(); }
  function drawTabs() {
    mount(tabsEl, [['orgs', 'Institutionen', list.orgs.length], ['people', 'Personen', list.people.length]].map(([k, label, n]) => {
      const b = h('button', { class: `ct-tab ${f.tab === k ? 'on' : ''}`, type: 'button' }, label, h('span', { class: 'count' }, n));
      b.addEventListener('click', () => setTab(k)); return b;
    }));
    const q = input({ type: 'search', placeholder: f.tab === 'orgs' ? 'Name, Adresse, Telefon, E-Mail …' : 'Name, Stellung, Institution, Telefon …', value: f.q });
    q.addEventListener('input', debounce(() => { f.q = q.value.trim(); loadList(); }, 250));
    const cat = select([{ value: '', label: f.tab === 'orgs' ? 'Alle Arten' : 'Alle Beziehungen' }, ...(f.tab === 'orgs' ? opts.orgTypes : opts.relations).map((x) => ({ value: x.id, label: x.label }))], f.cat);
    cat.addEventListener('change', () => { f.cat = cat.value; loadList(); });
    const flag = select([{ value: '', label: 'Alle Kennzeichen' }, ...opts.flags.map((x) => ({ value: x.key, label: x.label }))], f.flag);
    flag.addEventListener('change', () => { f.flag = flag.value; loadList(); });
    mount(filters, q, h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, cat, flag));
  }
  async function loadList(keepFilters = false) {
    const p = new URLSearchParams(); if (f.q) p.set('q', f.q); if (f.cat) p.set(f.tab === 'orgs' ? 'type' : 'relation', f.cat); if (f.flag) p.set('flag', f.flag);
    try {
      const [a, b] = await Promise.all([api.get(`/api/contacts/orgs?${f.tab === 'orgs' ? p : ''}`), api.get(`/api/contacts/people?${f.tab === 'people' ? p : ''}`)]);
      list = { orgs: a.orgs, people: b.people };
    } catch (e) { return mount(listEl, empty('Fehler beim Laden', e.message, 'alert')); }
    if (!ctx.isCurrent()) return;
    if (!keepFilters) drawTabsOnly(); drawList();
  }
  const drawTabsOnly = () => { const k = tabsEl.querySelectorAll('.ct-tab'); if (!k.length) drawTabs(); else { [list.orgs.length, list.people.length].forEach((n, i) => { k[i].lastChild.textContent = n; k[i].classList.toggle('on', (i === 0) === (f.tab === 'orgs')); }); } };
  function drawList() {
    const rows = f.tab === 'orgs' ? list.orgs : list.people;
    mount(listEl, rows.length ? rows.map((x) => {
      const on = sel && sel.type === (f.tab === 'orgs' ? 'org' : 'person') && sel.id === x.id;
      const b = h('button', { class: `ct-row ${on ? 'on' : ''}`, type: 'button' },
        f.tab === 'orgs'
          ? [h('div', { class: 'ct-name' }, lockMark(x), h('b', null, x.name), flagBadge(x.flag)), h('div', { class: 'ct-sub' }, tag(x.type), h('span', { class: 'muted' }, `${x.peopleCount} Person${x.peopleCount === 1 ? '' : 'en'}`), x.channels[0] && h('span', { class: 'muted' }, x.channels[0].value))]
          : [h('div', { class: 'ct-name' }, lockMark(x), h('b', null, x.name), flagBadge(x.flag)), h('div', { class: 'ct-sub' }, tag(x.relation), h('span', { class: 'muted' }, [x.position, x.org?.name].filter(Boolean).join(' · ')))]);
      b.addEventListener('click', () => select_(f.tab === 'orgs' ? 'org' : 'person', x.id)); return b;
    }) : empty(f.q || f.cat || f.flag ? 'Nichts gefunden' : (f.tab === 'orgs' ? 'Noch keine Institutionen' : 'Noch keine Personen'), opts.canEdit ? 'Mit den Knöpfen oben rechts legst du neue Einträge an.' : null, 'users'));
  }
  async function select_(type, id) { sel = { type, id }; drawList(); await showDetail(); }

  // ── Details ──
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Kopiert.'); } catch { toast('Zum Kopieren Strg+C drücken.', 'info'); } };
  const kv = (k, v) => v ? h('div', { class: 'ct-kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)) : null;
  const channels = (list_) => (list_.length ? h('div', { class: 'ct-channels' }, list_.map((c) => h('div', { class: 'ct-ch' }, icon(CH_ICON[c.kind] ?? 'info'), h('span', { class: 'k' }, c.label || c.kindLabel),
    c.kind === 'email' ? h('a', { href: `mailto:${c.value}` }, c.value) : c.kind === 'website' ? h('a', { href: /^https?:/.test(c.value) ? c.value : `https://${c.value}`, target: '_blank', rel: 'noopener noreferrer' }, c.value) : h('span', { class: 'mono' }, c.value),
    button('', { size: 'sm', variant: 'ghost', icon: 'link', title: 'Kopieren', onClick: () => copy(c.value) })))) : null);
  const accessInfo = (x) => (x.restricted ? note(`Gesperrt – sichtbar nur für ${x.access?.length ? x.access.map((r) => r.name).join(', ') : 'Inhaber des Rechts „contacts.secret“'}.`, 'alert') : null);
  const section = (title, body) => (body ? h('section', { class: 'ct-sec' }, h('h4', null, title), body) : null);
  const tags = (t) => (t ? h('div', { class: 'chips' }, t.split(',').map((x) => x.trim()).filter(Boolean).map((x) => h('span', { class: 'chip' }, x))) : null);

  async function showDetail() {
    if (!sel) return mount(detailEl, h('div', { class: 'ct-empty' }, empty('Kein Eintrag gewählt', 'Wähle links eine Institution oder Person.', 'users')));
    mount(detailEl, skeletons(3, 60));
    try {
      if (sel.type === 'org') {
        const { org, people } = await api.get(`/api/contacts/orgs/${sel.id}`);
        mount(detailEl, h('div', { class: 'ct-head' }, h('div', null, h('div', { class: 'ct-title' }, lockMark(org), org.name), h('div', { class: 'row' }, tag(org.type), flagBadge(org.flag))),
          h('div', { class: 'row' }, opts.canEdit && button('Bearbeiten', { icon: 'edit', onClick: () => orgDialog(org) }), opts.canDelete && button('', { variant: 'danger', icon: 'trash', title: 'Löschen', onClick: () => delOrg(org) }))),
        accessInfo(org), section('Kontaktdaten', channels(org.channels)), section('Adresse', org.address && h('div', null, org.address)), section('Beschreibung', org.description && h('div', { class: 'ct-text' }, org.description)), section('Notizen', org.notes && h('div', { class: 'ct-text' }, org.notes)), section('Schlagwörter', tags(org.tags)),
        h('section', { class: 'ct-sec' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h4', null, `Personen (${people.length})`), opts.canEdit && button('Person hinzufügen', { size: 'sm', icon: 'userPlus', onClick: () => personDialog(null, org.id) })),
          people.length ? h('div', { class: 'ct-people' }, people.map((p) => { const b = h('button', { class: 'ct-person', type: 'button' }, lockMark(p), h('b', null, p.name), tag(p.relation), h('span', { class: 'muted' }, p.position), p.channels[0] && h('span', { class: 'mono muted' }, p.channels[0].value)); b.addEventListener('click', () => { setTab('people').then(() => select_('person', p.id)); }); return b; })) : h('div', { class: 'muted' }, 'Noch keine Personen in dieser Institution.')),
        h('div', { class: 'muted ct-meta' }, `Angelegt von ${org.createdBy ?? '–'} · zuletzt geändert ${fmtDateTime(org.updatedAt)}`));
      } else {
        const { person: p } = await api.get(`/api/contacts/people/${sel.id}`);
        mount(detailEl, h('div', { class: 'ct-head' }, h('div', null, h('div', { class: 'ct-title' }, lockMark(p), p.name), h('div', { class: 'row' }, tag(p.relation), p.position && h('span', { class: 'muted' }, p.position), flagBadge(p.flag))),
          h('div', { class: 'row' }, opts.canEdit && button('Bearbeiten', { icon: 'edit', onClick: () => personDialog(p) }), opts.canDelete && button('', { variant: 'danger', icon: 'trash', title: 'Löschen', onClick: () => delPerson(p) }))),
        accessInfo(p),
        p.org && h('div', { class: 'ct-orglink' }, 'Institution: ', (() => { const a = h('a', { href: '#' }, p.org.name); a.addEventListener('click', (e) => { e.preventDefault(); setTab('orgs').then(() => select_('org', p.org.id)); }); return a; })()),
        section('Kontaktdaten', channels(p.channels)), section('Adressen', (p.address || p.homeAddress || p.birthday) && h('div', null, kv('Adresse', p.address), kv('Wohnanschrift', p.homeAddress), kv('Geburtstag', p.birthday && new Date(p.birthday).toLocaleDateString('de-DE')))),
        section('Bankdaten', p.bank ? (p.bank.name || p.bank.account || p.bank.note) && h('div', null, kv('Bank', p.bank.name), kv('Kontonummer', p.bank.account && h('span', { class: 'mono' }, p.bank.account)), kv('Hinweis', p.bank.note)) : (p.hasBank ? h('div', { class: 'muted' }, 'Bankdaten sind hinterlegt – für die Ansicht fehlt dir das Recht „contacts.bank“.') : null)),
        section('Notizen', p.notes && h('div', { class: 'ct-text' }, p.notes)), section('Schlagwörter', tags(p.tags)),
        h('div', { class: 'muted ct-meta' }, `Angelegt von ${p.createdBy ?? '–'} · zuletzt geändert ${fmtDateTime(p.updatedAt)}`));
      }
    } catch (e) { sel = null; mount(detailEl, empty('Nicht verfügbar', e.message, 'lock')); loadList(); }
  }

  async function delOrg(o) {
    if (!await confirmDialog({ title: 'Institution löschen?', message: `„${o.name}“ wird gelöscht. Die ${o.peopleCount} zugehörigen Personen bleiben als eigenständige Kontakte erhalten.`, confirmLabel: 'Löschen' })) return;
    try { await api.del(`/api/contacts/orgs/${o.id}`); sel = null; toast('Institution gelöscht.'); await loadList(); showDetail(); } catch (e) { toast(e.message, 'err'); }
  }
  async function delPerson(p) {
    if (!await confirmDialog({ title: 'Person löschen?', message: `„${p.name}“ wird endgültig aus dem Kontaktbuch entfernt.`, confirmLabel: 'Löschen' })) return;
    try { await api.del(`/api/contacts/people/${p.id}`); sel = null; toast('Person gelöscht.'); await loadList(); showDetail(); } catch (e) { toast(e.message, 'err'); }
  }

  // ── Bearbeiten ──
  function channelEditor(initial) {
    let rows = (initial?.length ? initial : [{ kind: 'phone', label: '', value: '' }]).map((c) => ({ kind: c.kind, label: c.label, value: c.value }));
    const host = h('div');
    const draw = () => mount(host, rows.map((r, i) => {
      const k = select(opts.channelKinds.map((x) => ({ value: x.key, label: x.label })), r.kind, { style: { width: '110px', flex: 'none' } });
      const l = input({ value: r.label, maxLength: 40, placeholder: 'Bezeichnung (z. B. privat)', style: { width: '170px', flex: 'none' } }), v = input({ value: r.value, maxLength: 160, placeholder: 'Nummer / Adresse' });
      k.addEventListener('change', () => { r.kind = k.value; }); l.addEventListener('input', () => { r.label = l.value; }); v.addEventListener('input', () => { r.value = v.value; });
      return h('div', { class: 'row', style: { flexWrap: 'nowrap', marginBottom: '6px' } }, k, l, v, button('', { size: 'sm', variant: 'ghost', icon: 'x', title: 'Entfernen', onClick: () => { rows.splice(i, 1); if (!rows.length) rows.push({ kind: 'phone', label: '', value: '' }); draw(); } }));
    }));
    draw();
    return { el: h('div', null, h('div', { class: 'label', style: { margin: '10px 0 6px' } }, 'Kontaktdaten (Telefon, Handy, E-Mail …)'), host, button('Kontaktdatum hinzufügen', { size: 'sm', icon: 'plus', onClick: () => { rows.push({ kind: 'phone', label: '', value: '' }); draw(); } })), get: () => rows.filter((r) => r.value.trim()) };
  }
  function secretBlock(x) {
    if (!opts.canSecret) return { el: null, get: () => ({}) };
    const restricted = toggle('Gesperrt: nur für bestimmte Rollen sichtbar', x?.restricted ?? false);
    const boxes = opts.roles.map((r) => [r, checkbox(h('span', null, r.name), x?.access?.some((a) => a.id === r.id) ?? false)]);
    const rolesEl = h('div', { class: 'ct-roles', hidden: !restricted.input.checked }, h('div', { class: 'help', style: { margin: '6px 0' } }, 'Diese Rollen dürfen den Eintrag sehen (zusätzlich wer „contacts.secret“ hat):'), boxes.map(([, b]) => b));
    restricted.input.addEventListener('change', () => { rolesEl.hidden = !restricted.input.checked; });
    return { el: h('div', { class: 'sep-top' }, restricted, rolesEl), get: () => ({ restricted: restricted.input.checked, roleIds: boxes.filter(([, b]) => b.input.checked).map(([r]) => r.id) }) };
  }
  const flagSelect = (x) => select([{ value: '', label: '— keine —' }, ...opts.flags.map((o) => ({ value: o.key, label: o.label }))], x?.flag?.key ?? '');

  function orgDialog(o) {
    const err = h('div'), name = input({ value: o?.name ?? '', maxLength: 100, placeholder: 'z. B. Los Santos Police Department' });
    const type = select([{ value: '', label: '— keine —' }, ...opts.orgTypes.map((t) => ({ value: t.id, label: t.label }))], o?.type?.id ?? ''), flag = flagSelect(o);
    const address = input({ value: o?.address ?? '', maxLength: 200 }), tagsI = input({ value: o?.tags ?? '', maxLength: 120, placeholder: 'kommagetrennt' });
    const desc = h('textarea', { class: 'textarea', rows: 3, maxLength: 600 }); desc.value = o?.description ?? '';
    const notes = h('textarea', { class: 'textarea', rows: 4, maxLength: 3000 }); notes.value = o?.notes ?? '';
    const ch = channelEditor(o?.channels), sec = secretBlock(o);
    const m = openModal({ title: o ? `Institution bearbeiten: ${o.name}` : 'Neue Institution', wide: true,
      body: h('div', null, err, h('div', { class: 'form-row' }, field('Name', name), field('Art', type)), h('div', { class: 'form-row' }, field('Adresse', address), field('Kennzeichnung', flag)), field('Beschreibung', desc), ch.el, field('Schlagwörter', tagsI), field('Notizen', notes), sec.el),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button(o ? 'Speichern' : 'Anlegen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        const payload = { name: name.value, typeId: type.value ? Number(type.value) : null, flag: flag.value || null, address: address.value, description: desc.value, notes: notes.value, tags: tagsI.value, channels: ch.get(), ...sec.get() };
        try { const r = o ? await api.patch(`/api/contacts/orgs/${o.id}`, payload) : await api.post('/api/contacts/orgs', payload); m.close(); toast('Gespeichert.'); if (f.tab !== 'orgs') await setTab('orgs'); else await loadList(); select_('org', r.org.id); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
    name.focus();
  }
  function personDialog(p, orgId = null) {
    const err = h('div'), first = input({ value: p?.firstName ?? '', maxLength: 60 }), last = input({ value: p?.lastName ?? '', maxLength: 60 });
    const orgList = list.orgs;
    const org = select([{ value: '', label: '— keine (eigenständiger Kontakt) —' }, ...orgList.map((x) => ({ value: x.id, label: x.name }))], p?.org?.id ?? orgId ?? '');
    const rel = select([{ value: '', label: '— keine —' }, ...opts.relations.map((t) => ({ value: t.id, label: t.label }))], p?.relation?.id ?? ''), flag = flagSelect(p);
    const pos = input({ value: p?.position ?? '', maxLength: 100, placeholder: 'z. B. Abteilungsleiter, Sekretärin, Sohn' }), birthday = input({ type: 'date', value: p?.birthday ?? '' });
    const address = input({ value: p?.address ?? '', maxLength: 200 }), home = input({ value: p?.homeAddress ?? '', maxLength: 200 }), tagsI = input({ value: p?.tags ?? '', maxLength: 120, placeholder: 'kommagetrennt' });
    const notes = h('textarea', { class: 'textarea', rows: 4, maxLength: 3000 }); notes.value = p?.notes ?? '';
    const ch = channelEditor(p?.channels), sec = secretBlock(p);
    const bankName = input({ value: p?.bank?.name ?? '', maxLength: 80 }), bankAcc = input({ value: p?.bank?.account ?? '', maxLength: 60, placeholder: 'z. B. LS28180705' }), bankNote = input({ value: p?.bank?.note ?? '', maxLength: 300 });
    const m = openModal({ title: p ? `Person bearbeiten: ${p.name}` : 'Neue Person', wide: true,
      body: h('div', null, err, h('div', { class: 'form-row' }, field('Vorname', first), field('Nachname', last)), h('div', { class: 'form-row' }, field('Institution', org), field('Beziehung', rel)), h('div', { class: 'form-row' }, field('Stellung in der Institution', pos), field('Kennzeichnung', flag)), ch.el,
        h('div', { class: 'form-row' }, field('Adresse', address), field('Wohnanschrift', home)), h('div', { class: 'form-row' }, field('Geburtstag', birthday), field('Schlagwörter', tagsI)),
        opts.canBank && h('div', null, h('div', { class: 'label', style: { margin: '10px 0 6px' } }, 'Bankdaten'), h('div', { class: 'form-row' }, field('Bank', bankName), field('Kontonummer', bankAcc)), field('Hinweis', bankNote)),
        field('Notizen', notes), sec.el),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button(p ? 'Speichern' : 'Anlegen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        const payload = { firstName: first.value, lastName: last.value, orgId: org.value ? Number(org.value) : null, relationId: rel.value ? Number(rel.value) : null, flag: flag.value || null, position: pos.value, birthday: birthday.value, address: address.value, homeAddress: home.value, tags: tagsI.value, notes: notes.value, channels: ch.get(), ...sec.get() };
        if (opts.canBank) payload.bank = { name: bankName.value, account: bankAcc.value, note: bankNote.value };
        try { const r = p ? await api.patch(`/api/contacts/people/${p.id}`, payload) : await api.post('/api/contacts/people', payload); m.close(); toast('Gespeichert.'); if (f.tab !== 'people') await setTab('people'); else await loadList(); select_('person', r.person.id); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
    first.focus();
  }

  drawActions(); drawTabs(); await loadList(); await showDetail();
  ctx.live(['contacts'], async () => { await loadList(true); if (sel) showDetail(); }, { wait: 250 });
}
