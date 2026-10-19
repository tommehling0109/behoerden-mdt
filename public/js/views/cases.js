import { h, mount, debounce, fmtDateTime } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, select, toggle, checkbox, formError, openModal, confirmDialog, toast, empty, tabs, note } from '../ui/kit.js';
import { api } from '../api.js';
import { fmtDay } from './citizens.js';

/**
 * Akten: links die Aktenliste (Suche, Art, Status), rechts die Akte – Übersicht (Sachverhalt, Tatablauf), Personen (verknüpft mit dem
 * Bürgerregister), Tatvorwürfe (aus dem Katalog), Beweise, Fahrzeuge (Kennzeichen → Halter), Verlauf und Freigabe für andere Behörden.
 */
const money = (cents) => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'USD' });
const jail = (m) => (m ? (m >= 12 ? `${Math.floor(m / 12)} J.${m % 12 ? ` ${m % 12} Mon.` : ''}` : `${m} Mon.`) : '–');
const textarea = (value, rows = 3, max = 8000) => { const t = h('textarea', { class: 'textarea', rows, maxLength: max }); t.value = value ?? ''; return t; };
const chip = (text, color) => h('span', { class: 'badge', style: { '--c': color } }, text);
const kv = (k, v) => (v ? h('div', { class: 'ct-kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)) : null);
const localInput = (iso) => { if (!iso) return ''; const d = new Date(iso), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

export default async function render(container, ctx) {
  let opts; try { opts = await api.get('/api/cases/options'); } catch (e) { return mount(container, empty('Nicht verfügbar', e.message, 'alert')); }
  const f = { q: '', type: '', status: '', mine: false, open: false };
  let sel = null, list = [], counts = {}, tab = 'overview', cur = null;
  const listEl = h('div', { class: 'ct-list' }), detailEl = h('div', { class: 'ct-detail' }), filters = h('div', { class: 'ct-filters' }), counter = h('div', { class: 'muted', style: { padding: '0 12px 6px', fontSize: '12.5px' } });
  mount(container, h('div', { class: 'ct' }, h('aside', { class: 'ct-side' }, h('div', { style: { padding: '10px 10px 4px' } }, filters), counter, listEl), detailEl));
  container.style.maxWidth = 'none'; container.style.height = '100%';

  const q = input({ type: 'search', placeholder: 'Aktenzeichen, Titel, Person, Kennzeichen, Ort …' });
  q.addEventListener('input', debounce(() => { f.q = q.value.trim(); loadList(); }, 250));
  const typeSel = select([{ value: '', label: 'Alle Aktenarten' }, ...opts.types.map((t) => ({ value: t.key, label: t.label }))], '');
  typeSel.addEventListener('change', () => { f.type = typeSel.value; loadList(); });
  const statusSel = select([{ value: '', label: 'Alle Status' }, ...opts.statuses.map((s) => ({ value: s.key, label: s.label }))], '');
  statusSel.addEventListener('change', () => { f.status = statusSel.value; loadList(); });
  const mineBtn = button('Meine', { size: 'sm', onClick: () => { f.mine = !f.mine; mineBtn.classList.toggle('primary', f.mine); loadList(); } });
  const openBtn = button('Nur offene', { size: 'sm', onClick: () => { f.open = !f.open; openBtn.classList.toggle('primary', f.open); loadList(); } });
  mount(filters, q, h('div', { class: 'row', style: { flexWrap: 'nowrap', marginTop: '6px' } }, typeSel, statusSel), h('div', { class: 'row', style: { marginTop: '6px' } }, mineBtn, openBtn));
  ctx.setActions(h('div', { class: 'row' }, opts.can.catalog && button('Katalog', { icon: 'list', onClick: catalogDialog }), opts.can.create && button('Neue Akte', { variant: 'primary', icon: 'plus', onClick: () => caseDialog() })));

  async function loadList() {
    const p = new URLSearchParams(); if (f.q) p.set('q', f.q); if (f.type) p.set('type', f.type); if (f.status) p.set('status', f.status); if (f.mine) p.set('mine', '1'); if (f.open) p.set('open', '1');
    try { const r = await api.get(`/api/cases?${p}`); list = r.cases; counts = r.counts; } catch (e) { return mount(listEl, empty('Fehler beim Laden', e.message, 'alert')); }
    if (!ctx.isCurrent()) return;
    counter.textContent = `${list.length} Akte${list.length === 1 ? '' : 'n'} · ${opts.types.filter((t) => counts[t.key]).map((t) => `${counts[t.key]} ${t.prefix}`).join(' · ') || 'keine'}`;
    mount(listEl, list.length ? list.map((c) => {
      const b = h('button', { class: `ct-row ${sel === c.id ? 'on' : ''}`, type: 'button' },
        h('div', { class: 'ct-name' }, h('b', null, c.number), chip(c.type.label, c.type.color), c.confidential && h('span', { class: 'ct-lock', title: 'Vertraulich' }, icon('lockClosed')), c.scope === 'state' && chip('Staatsweit', '#10b981')),
        h('div', { style: { margin: '2px 0' } }, c.title), h('div', { class: 'ct-sub' }, chip(c.status.label, c.status.color), h('span', { class: 'muted' }, [c.department?.name, c.people.join(', ')].filter(Boolean).join(' · '))));
      b.addEventListener('click', () => open(c.id)); return b;
    }) : empty(f.q || f.type || f.status || f.mine || f.open ? 'Keine Akten gefunden' : 'Noch keine Akten', opts.can.create ? 'Mit „Neue Akte“ legst du die erste Akte an.' : null, 'list'));
  }
  async function open(id, keepTab = false) { if (!keepTab) tab = 'overview'; sel = id; await loadList(); await showDetail(); }
  async function showDetail() {
    if (!sel) return mount(detailEl, empty('Akten', 'Wähle links eine Akte oder lege eine neue an. Du siehst Akten deiner Behörde, mit dir geteilte und staatsweite Akten.', 'list'));
    try { cur = (await api.get(`/api/cases/${sel}`)).case; } catch (e) { sel = null; return mount(detailEl, empty('Nicht gefunden', e.message, 'alert')); }
    if (!ctx.isCurrent()) return;
    const c = cur, panes = { overview: overviewPane, persons: personsPane, charges: chargesPane, evidence: evidencePane, vehicles: vehiclesPane, events: eventsPane, share: sharePane };
    const tabBar = tabs([{ id: 'overview', label: 'Übersicht' }, { id: 'persons', label: 'Personen', count: c.persons.length }, { id: 'charges', label: 'Tatvorwürfe', count: c.charges.length }, { id: 'evidence', label: 'Beweise', count: c.evidence.length },
      { id: 'vehicles', label: 'Fahrzeuge', count: c.vehicles.length }, { id: 'events', label: 'Verlauf', count: c.events.length }, { id: 'share', label: 'Zugriff' }], tab, (t) => { tab = t; drawBody(); });
    const body = h('div', { style: { marginTop: '12px' } }); const drawBody = () => mount(body, panes[tab](c));
    const statusSelect = select(opts.statuses.map((s) => ({ value: s.key, label: s.label })), c.status.key, { disabled: !c.can.edit });
    statusSelect.addEventListener('change', async () => { try { await api.patch(`/api/cases/${c.id}`, { status: statusSelect.value }); toast('Status geändert.'); await open(c.id, true); } catch (e) { toast(e.message, 'err'); statusSelect.value = c.status.key; } });
    mount(detailEl,
      h('div', { class: 'ct-head' }, h('div', null, h('div', { class: 'row' }, h('b', { style: { fontSize: '15px' } }, c.number), chip(c.type.label, c.type.color), c.confidential && chip('Vertraulich', '#ef4444'), c.scope === 'state' && chip('Staatsweit', '#10b981'), c.priority !== 'normal' && chip(c.priorityLabel, '#f59e0b')),
        h('h2', { style: { margin: '4px 0 0' } }, c.title), h('div', { class: 'muted' }, [c.department?.name, c.lead && `Sachbearbeiter: ${c.lead.label}`, `angelegt ${fmtDay(c.createdAt)}`].filter(Boolean).join(' · '))),
        h('div', { class: 'row' }, statusSelect, c.can.edit && button('Bearbeiten', { icon: 'edit', onClick: () => caseDialog(c) }), c.can.delete && button('', { icon: 'trash', variant: 'danger', title: 'Löschen', onClick: () => delCase(c) }))),
      !c.can.edit && note('Diese Akte wird von einer anderen Behörde geführt (oder dir fehlt das Bearbeitungsrecht) – du kannst sie nur lesen.', 'lock'), tabBar, body);
    drawBody();
  }
  const cLink = (id) => { const b = h('a', { href: '#', style: { cursor: 'pointer' } }, ''); b.addEventListener('click', async (e) => { e.preventDefault(); try { sessionStorage.setItem('mdt:citizens:open', String(id)); } catch { /* egal */ } (await import('../shell.js')).openApp('citizens'); window.dispatchEvent(new Event('mdt:citizens-open')); }); return b; };
  const addBtn = (label, fn, c) => (c.can.edit ? button(label, { icon: 'plus', size: 'sm', onClick: fn }) : null);
  const del = (label, fn, c) => (c.can.edit ? button('', { icon: 'trash', size: 'sm', variant: 'ghost', title: label, onClick: fn }) : null);

  // ── Panes ──
  const overviewPane = (c) => h('div', null,
    h('div', { class: 'ct-section' }, kv('Tatzeit', c.incidentAt && fmtDateTime(c.incidentAt)), kv('Tatort', c.location), kv('Führende Behörde', c.department?.name ?? 'Behördenübergreifend'), kv('Angelegt von', c.createdBy), kv('Abgeschlossen', c.closedAt && fmtDay(c.closedAt))),
    h('div', { class: 'ct-section', style: { marginTop: '14px' } }, h('div', { class: 'label' }, 'Sachverhalt'), h('div', { style: { whiteSpace: 'pre-wrap' } }, c.summary || h('span', { class: 'muted' }, 'Noch kein Sachverhalt eingetragen.'))),
    h('div', { class: 'ct-section', style: { marginTop: '14px' } }, h('div', { class: 'label' }, 'Tatablauf'), h('div', { style: { whiteSpace: 'pre-wrap' } }, c.narrative || h('span', { class: 'muted' }, 'Noch kein Tatablauf dokumentiert.'))),
    c.outcome && h('div', { class: 'ct-section', style: { marginTop: '14px' } }, h('div', { class: 'label' }, 'Ergebnis / Entscheidung'), h('div', { style: { whiteSpace: 'pre-wrap' } }, c.outcome)));

  const personsPane = (c) => h('div', null, addBtn('Person hinzufügen', () => personDialog(c), c), c.persons.length ? c.persons.map((p) => h('div', { class: 'ct-row', style: { cursor: 'default', marginTop: '8px' } }, h('div', { class: 'ct-head', style: { marginBottom: 0 } },
    h('div', null, h('div', { class: 'ct-name' }, h('b', null, p.name), chip(p.roleLabel, '#5b8def'), p.isWanted && chip('Fahndung', '#ef4444'), !p.registered && chip('Nicht im Register', '#94a3b8')),
      h('div', { class: 'muted' }, [p.number, p.birthDate && `geb. ${fmtDay(p.birthDate)}`, p.phone, p.note].filter(Boolean).join(' · '))),
    h('div', { class: 'row' }, p.citizenId && button('Im Register', { size: 'sm', variant: 'ghost', icon: 'users', onClick: async () => { try { sessionStorage.setItem('mdt:citizens:open', String(p.citizenId)); } catch { /* egal */ } (await import('../shell.js')).openApp('citizens'); window.dispatchEvent(new Event('mdt:citizens-open')); } }), del('Entfernen', () => rm(`/api/cases/${c.id}/persons/${p.id}`, 'Person entfernen?', p.name), c)))))
    : h('div', { style: { marginTop: '10px' } }, empty('Keine Personen', 'Beschuldigte, Zeugen und Geschädigte werden hier erfasst.', 'users')));

  const chargesPane = (c) => h('div', null, addBtn('Tatvorwurf hinzufügen', () => chargeDialog(c), c),
    c.charges.length ? h('div', null, c.charges.map((ch) => {
      const person = c.persons.find((p) => p.id === ch.personId), st = select(opts.chargeStatuses.map((s) => ({ value: s.key, label: s.label })), ch.status, { disabled: !c.can.edit || (!c.can.verdict && false) });
      st.addEventListener('change', async () => { try { await api.patch(`/api/cases/${c.id}/charges/${ch.id}`, { status: st.value }); await open(c.id, true); } catch (e) { toast(e.message, 'err'); st.value = ch.status; } });
      return h('div', { class: 'ct-row', style: { cursor: 'default', marginTop: '8px' } }, h('div', { class: 'ct-head', style: { marginBottom: 0 } },
        h('div', null, h('div', { class: 'ct-name' }, h('b', null, ch.title), ch.statute && chip(ch.statute, '#64748b'), ch.count > 1 && chip(`${ch.count}×`, '#f59e0b')), h('div', { class: 'muted' }, [person && `gegen ${person.name}`, `Bußgeld ${money(ch.fineCents)}`, `Haft ${jail(ch.jailMonths)}`, ch.note].filter(Boolean).join(' · '))),
        h('div', { class: 'row' }, st, del('Entfernen', () => rm(`/api/cases/${c.id}/charges/${ch.id}`, 'Tatvorwurf entfernen?', ch.title), c))));
    }), h('div', { class: 'card', style: { marginTop: '12px', padding: '10px 14px' } }, h('b', null, 'Summe (ohne eingestellte/freigesprochene Vorwürfe): '), `${money(c.totals.fineCents)} Bußgeld · ${jail(c.totals.jailMonths)} Haft`),
      !c.can.verdict && note('Urteile (verurteilt/freigesprochen) setzt nur, wer das Recht „cases.verdict“ besitzt.', 'info'))
      : h('div', { style: { marginTop: '10px' } }, empty('Keine Tatvorwürfe', 'Wähle Vorwürfe aus dem Straftaten- und Bußgeldkatalog.', 'scale')));

  const evidencePane = (c) => h('div', null, addBtn('Beweis sichern', () => evidenceDialog(c), c), c.evidence.length ? c.evidence.map((e) => h('div', { class: 'card', style: { marginTop: '10px', padding: '12px 14px' } },
    h('div', { class: 'ct-head', style: { marginBottom: '4px' } }, h('div', null, h('b', null, e.title), ' ', chip(e.tag, '#64748b'), ' ', chip(e.kindLabel, '#5b8def'), ' ', chip(e.favorsLabel, e.favors === 'incriminating' ? '#ef4444' : e.favors === 'exonerating' ? '#10b981' : '#94a3b8')), del('Entfernen', () => rm(`/api/cases/${c.id}/evidence/${e.id}`, 'Beweis entfernen?', e.title), c)),
    e.description && h('div', { style: { whiteSpace: 'pre-wrap' } }, e.description), kv('Lagerort', e.location), kv('Gesichert', [e.collectedAt && fmtDateTime(e.collectedAt), e.collectedBy].filter(Boolean).join(' · ')),
    e.linkUrl && h('div', null, h('a', { href: e.linkUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Anhang / Link öffnen')))) : h('div', { style: { marginTop: '10px' } }, empty('Keine Beweise', 'Fotos, Aussagen, Asservate und Spuren werden mit Beweisnummer erfasst.', 'shield')));

  const vehiclesPane = (c) => h('div', null, addBtn('Fahrzeug verknüpfen', () => vehicleDialog(c), c), c.vehicles.length ? c.vehicles.map((v) => h('div', { class: 'ct-row', style: { cursor: 'default', marginTop: '8px' } }, h('div', { class: 'ct-head', style: { marginBottom: 0 } },
    h('div', null, h('div', { class: 'ct-name' }, h('b', { style: { letterSpacing: '.05em' } }, v.plate), chip(v.roleLabel, '#f59e0b'), !v.registered && chip('Nicht im Register', '#94a3b8')), h('div', { class: 'muted' }, [v.makeModel, v.color, v.owner && `Halter: ${v.owner}`, v.description].filter(Boolean).join(' · '))),
    del('Entfernen', () => rm(`/api/cases/${c.id}/vehicles/${v.id}`, 'Fahrzeug entfernen?', v.plate), c)))) : h('div', { style: { marginTop: '10px' } }, empty('Keine Fahrzeuge', 'Kennzeichen werden automatisch mit dem Fahrzeugregister (und dessen Halter) verknüpft.', 'car')));

  const eventsPane = (c) => { const t = textarea('', 2, 4000); return h('div', null, c.can.edit && h('div', { class: 'card', style: { padding: '10px 14px', marginBottom: '10px' } }, field('Neuer Verlaufseintrag', t), button('Eintragen', { variant: 'primary', size: 'sm', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => { try { await api.post(`/api/cases/${c.id}/events`, { text: t.value }); await open(c.id, true); } catch (ex) { toast(ex.message, 'err'); } }) })),
    c.events.map((e) => h('div', { class: 'ct-kv', style: { marginTop: '6px' } }, h('span', { class: 'k', style: { minWidth: '140px' } }, fmtDateTime(e.createdAt)), h('span', { class: 'v' }, h('b', null, e.by), ' · ', chip(e.kindLabel, e.kind === 'note' ? '#5b8def' : '#64748b'), ' ', e.text)))); };

  const sharePane = (c) => h('div', null,
    h('div', { class: 'ct-section' }, kv('Führende Behörde', c.department?.name ?? 'Behördenübergreifend'), kv('Sichtbarkeit', c.scope === 'state' ? 'Staatsweit – alle Mitglieder mit Aktenrecht' : 'Nur führende und freigegebene Behörden'), kv('Vertraulich', c.confidential ? 'Ja – nur Team und Inhaber von „cases.confidential“' : 'Nein'),
      kv('Freigegeben für', c.sharedWith.length ? c.sharedWith.map((d) => d.name).join(', ') : 'keine weiteren Behörden'), kv('Team', c.team.length ? c.team.map((t) => t.label).join(', ') : 'kein zusätzliches Team')),
    h('div', { class: 'row', style: { marginTop: '12px' } }, c.can.share && button('Freigabe ändern', { icon: 'link', onClick: () => shareDialog(c) }), c.can.edit && button('Team bearbeiten', { icon: 'users', onClick: () => teamDialog(c) })),
    note('Freigegebene Behörden können die Akte lesen, aber nicht ändern. Das Team (Ersteller, Sachbearbeiter, Teammitglieder) sieht die Akte immer – auch wenn sie vertraulich ist.', 'shield'));

  async function rm(url, title, what) { if (!await confirmDialog({ title, message: `„${what}“ wird entfernt.`, confirmLabel: 'Entfernen' })) return; try { await api.del(url); await open(sel, true); } catch (e) { toast(e.message, 'err'); } }
  async function delCase(c) { if (!await confirmDialog({ title: 'Akte löschen?', message: `Die Akte ${c.number} wird mit allen Personen, Vorwürfen und Beweisen endgültig gelöscht.`, confirmLabel: 'Löschen' })) return; try { await api.del(`/api/cases/${c.id}`); sel = null; toast('Akte gelöscht.'); await loadList(); showDetail(); } catch (e) { toast(e.message, 'err'); } }
  const save = (m, err, fn) => (e) => busy(e.currentTarget, async () => { err.replaceChildren(); try { await fn(); m.close(); } catch (ex) { err.replaceChildren(formError(ex.message)); } });

  // ── Dialoge ──
  function caseDialog(c = null) {
    const err = h('div'), type = select(opts.types.map((t) => ({ value: t.key, label: `${t.label} (${t.prefix})` })), c?.type.key ?? opts.types[1]?.key, { disabled: !!c });
    const title = input({ value: c?.title ?? '', maxLength: 160, placeholder: 'z. B. Raubüberfall Tankstelle Grove Street' }), prio = select(opts.priorities.map((p) => ({ value: p.key, label: p.label })), c?.priority ?? 'normal');
    const at = input({ type: 'datetime-local', value: localInput(c?.incidentAt) }), loc = input({ value: c?.location ?? '', maxLength: 200 }), summary = textarea(c?.summary, 4), narrative = textarea(c?.narrative, 7, 20000), outcome = textarea(c?.outcome, 3);
    const dept = (opts.seesAll) ? select([{ value: '', label: 'Behördenübergreifend' }, ...opts.departments.map((d) => ({ value: d.id, label: d.name }))], c ? (c.department?.id ?? '') : (opts.myDepartmentId ?? '')) : null;
    const conf = opts.can.confidential ? toggle('Vertraulich (nur Team und Inhaber von „cases.confidential“)', c?.confidential ?? false) : null;
    const lead = select([{ value: '', label: '— ich selbst —' }, ...opts.members.map((m) => ({ value: m.id, label: m.label }))], c?.lead?.id ?? '');
    const m = openModal({ title: c ? `Akte bearbeiten: ${c.number}` : 'Neue Akte', wide: true,
      body: h('div', null, err, h('div', { class: 'form-row' }, field('Aktenart', type), field('Priorität', prio)), field('Titel', title), h('div', { class: 'form-row' }, field('Tatzeit', at), field('Tatort', loc)),
        h('div', { class: 'form-row' }, dept && field('Führende Behörde', dept), field('Sachbearbeiter', lead)), field('Sachverhalt', summary, { help: 'Kurze Zusammenfassung: Was ist passiert?' }), field('Tatablauf', narrative, { help: 'Chronologische Schilderung des Tatablaufs.' }), c && opts.can.verdict && field('Ergebnis / Entscheidung', outcome), conf),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button(c ? 'Speichern' : 'Akte anlegen', { variant: 'primary', icon: 'check', onClick: save(m, err, async () => {
        const payload = { title: title.value, priority: prio.value, incidentAt: at.value ? new Date(at.value).toISOString() : null, location: loc.value, summary: summary.value, narrative: narrative.value, leadUserId: lead.value ? Number(lead.value) : (c ? null : undefined) };
        if (dept) payload.departmentId = dept.value ? Number(dept.value) : null; if (conf) payload.confidential = conf.input.checked; if (c && opts.can.verdict) payload.outcome = outcome.value;
        if (!c) payload.type = type.value;
        const r = c ? await api.patch(`/api/cases/${c.id}`, payload) : await api.post('/api/cases', payload); toast('Gespeichert.'); await open(r.case.id, !!c);
      }) })] });
    title.focus();
  }
  function personDialog(c) {
    const err = h('div'), s = input({ type: 'search', placeholder: 'Bürger suchen (Name, Geburtsdatum, Telefon, Kennzeichen) …' }), results = h('div', { style: { maxHeight: '180px', overflowY: 'auto', margin: '6px 0' } });
    let chosen = null; const chosenEl = h('div', { class: 'muted', style: { margin: '4px 0' } }, 'Kein Bürger ausgewählt – ohne Auswahl wird der Name frei eingetragen.');
    const free = input({ maxLength: 120, placeholder: 'Name (für Personen ohne Registereintrag)' }), role = select(opts.roles.map((r) => ({ value: r.key, label: r.label })), 'suspect'), nt = input({ maxLength: 500, placeholder: 'Notiz (optional)' });
    const run = debounce(async () => { if (s.value.trim().length < 2) return mount(results); try { const r = await api.get(`/api/citizens?q=${encodeURIComponent(s.value.trim())}`); mount(results, r.citizens.slice(0, 15).map((z) => { const b = h('button', { class: 'ct-row', type: 'button' }, h('b', null, `${z.lastName}, ${z.firstName}`), ' ', h('span', { class: 'muted' }, [z.number, z.birthDate && fmtDay(z.birthDate), z.plates.join(', ')].filter(Boolean).join(' · '))); b.addEventListener('click', () => { chosen = z; chosenEl.textContent = `Ausgewählt: ${z.firstName} ${z.lastName} (${z.number})`; mount(results); }); return b; })); } catch { mount(results, h('div', { class: 'muted' }, 'Für die Suche im Bürgerregister fehlt dir das Recht „citizens.view“.')); } }, 250);
    s.addEventListener('input', run);
    const m = openModal({ title: 'Person zur Akte hinzufügen', body: h('div', null, err, field('Bürgerregister', s), results, chosenEl, field('Oder freier Name', free), h('div', { class: 'form-row' }, field('Rolle in der Akte', role), field('Notiz', nt))),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Hinzufügen', { variant: 'primary', icon: 'check', onClick: save(m, err, async () => { await api.post(`/api/cases/${c.id}/persons`, { citizenId: chosen?.id ?? null, nameText: free.value, role: role.value, note: nt.value }); tab = 'persons'; await open(c.id, true); }) })] });
    s.focus();
  }
  function chargeDialog(c) {
    const err = h('div'), items = opts.catalog.slice().sort((a, b) => (a.type === c.type.key ? -1 : 0) - (b.type === c.type.key ? -1 : 0));
    const cat = select([{ value: '', label: '— freier Tatvorwurf —' }, ...items.map((x) => ({ value: x.id, label: `${x.code ? x.code + ' · ' : ''}${x.title}` }))], '');
    const title = input({ maxLength: 160, placeholder: 'Bezeichnung (nur bei freiem Tatvorwurf)' }), person = select([{ value: '', label: '— gesamte Akte —' }, ...c.persons.map((p) => ({ value: p.id, label: `${p.name} (${p.roleLabel})` }))], ''), count = input({ type: 'number', min: 1, max: 999, value: 1 });
    const fine = input({ type: 'number', min: 0, step: '0.01', placeholder: 'aus Katalog' }), months = input({ type: 'number', min: 0, max: 2400, placeholder: 'aus Katalog' }), nt = input({ maxLength: 500 });
    cat.addEventListener('change', () => { const x = opts.catalog.find((k) => String(k.id) === cat.value); fine.placeholder = x ? String(x.fineCents / 100) : 'aus Katalog'; months.placeholder = x ? String(x.jailMonths) : 'aus Katalog'; });
    const m = openModal({ title: 'Tatvorwurf hinzufügen', body: h('div', null, err, field('Katalog (Straftaten- & Bußgeldkatalog)', cat), field('Freie Bezeichnung', title), field('Gegen', person), h('div', { class: 'form-row' }, field('Anzahl', count), field('Bußgeld', fine, { help: 'Leer = Katalogwert' }), field('Haft (Monate)', months, { help: 'Leer = Katalogwert' })), field('Notiz', nt)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Hinzufügen', { variant: 'primary', icon: 'check', onClick: save(m, err, async () => {
        const b = { catalogId: cat.value ? Number(cat.value) : null, title: title.value || undefined, personId: person.value ? Number(person.value) : null, count: Number(count.value) || 1, note: nt.value };
        if (fine.value !== '') b.fineCents = Math.round(Number(fine.value) * 100); if (months.value !== '') b.jailMonths = Number(months.value);
        await api.post(`/api/cases/${c.id}/charges`, b); tab = 'charges'; await open(c.id, true);
      }) })] });
  }
  function evidenceDialog(c) {
    const err = h('div'), kind = select(opts.evidenceKinds.map((k) => ({ value: k.key, label: k.label })), 'photo'), favors = select(opts.favors.map((k) => ({ value: k.key, label: k.label })), 'neutral'), title = input({ maxLength: 160, placeholder: 'z. B. Überwachungsfoto Tankstelle' });
    const desc = textarea('', 3, 4000), loc = input({ maxLength: 120, placeholder: 'z. B. Asservatenkammer LSPD, Regal 3' }), link = input({ maxLength: 500, placeholder: 'https://… (Foto-/Videolink)' });
    const m = openModal({ title: 'Beweis sichern', body: h('div', null, err, h('div', { class: 'form-row' }, field('Art', kind), field('Wirkung', favors)), field('Bezeichnung', title), field('Beschreibung', desc), h('div', { class: 'form-row' }, field('Lagerort', loc), field('Link (https)', link))),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Sichern', { variant: 'primary', icon: 'check', onClick: save(m, err, async () => { await api.post(`/api/cases/${c.id}/evidence`, { kind: kind.value, favors: favors.value, title: title.value, description: desc.value, location: loc.value, linkUrl: link.value }); tab = 'evidence'; await open(c.id, true); }) })] });
    title.focus();
  }
  function vehicleDialog(c) {
    const err = h('div'), plate = input({ maxLength: 12, placeholder: 'z. B. LS 4711', style: { textTransform: 'uppercase' } }), role = select(opts.vehicleRoles.map((r) => ({ value: r.key, label: r.label })), 'involved'), desc = input({ maxLength: 300, placeholder: 'Beschreibung (optional)' });
    const m = openModal({ title: 'Fahrzeug verknüpfen', body: h('div', null, err, h('div', { class: 'form-row' }, field('Kennzeichen', plate), field('Rolle', role)), field('Beschreibung', desc), note('Ist das Kennzeichen im Register eingetragen, wird der Halter automatisch angezeigt.', 'info')),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Verknüpfen', { variant: 'primary', icon: 'check', onClick: save(m, err, async () => { await api.post(`/api/cases/${c.id}/vehicles`, { plate: plate.value, role: role.value, description: desc.value }); tab = 'vehicles'; await open(c.id, true); }) })] });
    plate.focus();
  }
  function shareDialog(c) {
    const err = h('div'), scope = toggle('Staatsweit sichtbar (alle Behörden mit Aktenrecht)', c.scope === 'state'), boxes = opts.departments.filter((d) => d.id !== c.department?.id).map((d) => [d, checkbox(h('span', null, d.name), c.sharedWith.some((x) => x.id === d.id))]);
    const m = openModal({ title: `Zugriff auf ${c.number}`, body: h('div', null, err, scope, h('div', { class: 'label', style: { margin: '10px 0 6px' } }, 'Lesezugriff für diese Behörden'), ...boxes.map(([, b]) => b)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Speichern', { variant: 'primary', icon: 'check', onClick: save(m, err, async () => { await api.put(`/api/cases/${c.id}/share`, { scope: scope.input.checked ? 'state' : 'department', departmentIds: boxes.filter(([, b]) => b.input.checked).map(([d]) => d.id) }); tab = 'share'; await open(c.id, true); }) })] });
  }
  function teamDialog(c) {
    const err = h('div'), boxes = opts.members.map((u) => [u, checkbox(h('span', null, u.label), c.team.some((t) => t.id === u.id))]);
    const m = openModal({ title: `Team der Akte ${c.number}`, body: h('div', null, err, note('Teammitglieder sehen die Akte immer – auch wenn sie vertraulich ist.', 'info'), h('div', { style: { maxHeight: '320px', overflowY: 'auto', marginTop: '8px' } }, ...boxes.map(([, b]) => b))),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Speichern', { variant: 'primary', icon: 'check', onClick: save(m, err, async () => { await api.put(`/api/cases/${c.id}/team`, { userIds: boxes.filter(([, b]) => b.input.checked).map(([u]) => u.id) }); tab = 'share'; await open(c.id, true); }) })] });
  }
  async function catalogDialog() {
    let rows = []; const host = h('div'), err = h('div');
    const draw = () => mount(host, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Kürzel', 'Bezeichnung', 'Art', 'Bußgeld', 'Haft', ''].map((x) => h('th', null, x)))), h('tbody', null, rows.map((x) => h('tr', { style: { opacity: x.isActive ? 1 : 0.5 } }, h('td', null, x.code), h('td', null, x.title), h('td', null, x.typeLabel), h('td', null, money(x.fineCents)), h('td', null, jail(x.jailMonths)),
      h('td', null, h('div', { class: 'row' }, button('', { icon: 'edit', size: 'sm', variant: 'ghost', onClick: () => edit(x) }), button('', { icon: 'trash', size: 'sm', variant: 'ghost', onClick: async () => { if (await confirmDialog({ title: 'Eintrag löschen?', message: x.title, confirmLabel: 'Löschen' })) { try { await api.del(`/api/cases/catalog/${x.id}`); await reload(); } catch (e) { toast(e.message, 'err'); } } } }))))))));
    const reload = async () => { rows = (await api.get('/api/cases/catalog/all')).catalog; draw(); opts = await api.get('/api/cases/options'); };
    function edit(x) {
      const e2 = h('div'), code = input({ value: x?.code ?? '', maxLength: 20 }), title = input({ value: x?.title ?? '', maxLength: 160 }), type = select(opts.types.map((t) => ({ value: t.key, label: t.label })), x?.type ?? 'criminal'), fine = input({ type: 'number', min: 0, step: '0.01', value: x ? x.fineCents / 100 : 0 }), mon = input({ type: 'number', min: 0, value: x?.jailMonths ?? 0 }), act = toggle('Aktiv', x?.isActive ?? true);
      const m = openModal({ title: x ? 'Katalogeintrag bearbeiten' : 'Neuer Katalogeintrag', body: h('div', null, e2, h('div', { class: 'form-row' }, field('Kürzel', code), field('Aktenart', type)), field('Bezeichnung', title), h('div', { class: 'form-row' }, field('Bußgeld', fine), field('Haft (Monate)', mon)), act),
        footer: [button('Abbrechen', { onClick: () => m.close() }), button('Speichern', { variant: 'primary', icon: 'check', onClick: save(m, e2, async () => { const b = { code: code.value, title: title.value, type: type.value, fineCents: Math.round(Number(fine.value || 0) * 100), jailMonths: Number(mon.value || 0), isActive: act.input.checked }; x ? await api.patch(`/api/cases/catalog/${x.id}`, b) : await api.post('/api/cases/catalog', b); await reload(); }) })] });
    }
    const m = openModal({ title: 'Straftaten- & Bußgeldkatalog', wide: true, body: h('div', null, err, host), footer: [button('Neuer Eintrag', { icon: 'plus', onClick: () => edit(null) }), button('Schließen', { variant: 'primary', onClick: () => m.close() })] });
    try { await reload(); } catch (e) { err.replaceChildren(formError(e.message)); }
  }

  // Sprung aus dem Bürgerregister
  const takeOpen = () => { let id = null; try { id = Number(sessionStorage.getItem('mdt:cases:open')); sessionStorage.removeItem('mdt:cases:open'); } catch { /* egal */ } return id || null; };
  window.addEventListener('mdt:cases-open', () => { const id = takeOpen(); if (id && ctx.isCurrent()) open(id); });
  const first = takeOpen(); if (first) sel = first;
  await loadList(); await showDetail();
}
