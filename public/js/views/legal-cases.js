import { h, mount, fmtDateTime, fmtDate, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, card, field, input, select, table, tabs, formError, openModal, confirmDialog, toast, skeletons, empty, note, badge } from '../ui/kit.js';
import { api } from '../api.js';
import { readFile } from './admin/partners.js';

/**
 * Rechtsfälle: Aktensystem der Legal-App. Liste mit Filtern → Akte mit Reitern
 * (Übersicht, Beteiligte, Beweise, Verlauf, Termine, Kosten, Dokumente).
 */
const colorBadge = (e, extra = '') => (e ? h('span', { class: `badge ${extra}`, style: { '--c': e.color } }, e.label) : h('span', { class: 'muted' }, '–'));
const PRIO_CLS = { low: 'b-mute', normal: 'b-info', high: 'b-warn', urgent: 'b-err' };
const toLocalInput = (iso) => { const d = iso ? new Date(iso) : new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const textarea = (value = '', attrs = {}) => h('textarea', { class: 'textarea', rows: 4, ...attrs }, value);
const sizeText = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export default async function renderCases(host, ctx, { setActions }) {
  let opt = await api.get('/api/legal/cases/options');
  const money = (c) => `${(Number(c ?? 0) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${opt.currency}`;
  const toCents = (el) => (el.value === '' ? 0 : Math.round(Number(el.value) * 100));
  const fromCents = (c) => (c ? (c / 100).toFixed(2) : '');
  const f = { q: '', status: '', area: '', open: true, mine: false };
  let current = null; // geöffnete Akte (Detail) oder null = Liste
  let tab = 'overview';
  const token = Math.random().toString(36).slice(2); host.dataset.lc = token;
  const alive = () => host.dataset.lc === token; // Reiter gewechselt? Dann nichts mehr in den Bereich schreiben

  // ═════════ Liste ═════════
  async function showList() {
    if (!alive()) return;
    current = null;
    setActions(opt.canEdit && button('Neue Akte', { variant: 'primary', icon: 'plus', onClick: () => caseDialog(null) }));
    mount(host, skeletons(3, 80));
    const qs = new URLSearchParams({ ...(f.q && { q: f.q }), ...(f.status && { status: f.status }), ...(f.area && { area: f.area }), ...(f.open && !f.status && { open: '1' }), ...(f.mine && { mine: '1' }) });
    let d; try { d = await api.get(`/api/legal/cases?${qs}`); } catch (e) { return mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
    if (current || !alive()) return;
    const search = input({ value: f.q, placeholder: 'Suche: Aktenzeichen, Titel, Mandant, Gericht …' });
    search.addEventListener('input', debounce(() => { f.q = search.value; showList(); }, 300));
    const statusSel = select([{ value: '', label: 'Alle Status' }, ...opt.statuses.map((s) => ({ value: s.id, label: `${s.label}${d.counts[s.key] ? ` (${d.counts[s.key]})` : ''}` }))], f.status);
    statusSel.addEventListener('change', () => { f.status = statusSel.value; showList(); });
    const areaSel = select([{ value: '', label: 'Alle Rechtsgebiete' }, ...opt.areas.map((a) => ({ value: a.id, label: a.label }))], f.area);
    areaSel.addEventListener('change', () => { f.area = areaSel.value; showList(); });
    const chk = (label, key) => { const c = h('input', { type: 'checkbox', checked: f[key] }); c.addEventListener('change', () => { f[key] = c.checked; showList(); }); return h('label', { class: 'check', style: { padding: 0 } }, c, h('span', { class: 'check-text' }, label)); };
    mount(host,
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 14px', alignItems: 'center', marginBottom: '12px' } }, h('div', { style: { flex: '1 1 240px' } }, search), h('div', { style: { width: '170px' } }, statusSel), h('div', { style: { width: '190px' } }, areaSel), chk('Nur offene', 'open'), chk('Nur meine', 'mine')),
      d.upcoming.length > 0 && card(null, h('div', { style: { padding: '12px 16px' } }, h('div', { class: 'label', style: { marginBottom: '8px' } }, 'Anstehende Termine'),
        d.upcoming.map((a) => h('div', { class: 'list-row', style: { cursor: 'pointer' }, onclick: () => openCase(a.caseId, 'appointments') },
          h('div', { class: 'dot-icon' }, icon('clock')), h('div', { class: 'grow' }, h('div', { class: 't' }, `${a.title} · ${a.kindLabel}`), h('div', { class: 's' }, `${a.number} · ${a.caseTitle}${a.location ? ` · ${a.location}` : ''}`)), h('span', { class: 'muted' }, fmtDateTime(a.startsAt)))))),
      d.upcoming.length > 0 && h('div', { style: { height: '12px' } }),
      table([
        { label: 'Aktenzeichen', render: (c) => h('span', { class: 'member-no' }, c.number) },
        { label: 'Titel', render: (c) => h('div', null, h('b', null, c.title), c.confidential && h('span', { class: 'muted', title: 'Vertraulich', style: { marginLeft: '6px' } }, icon('lockClosed')), c.court && h('div', { class: 'muted', style: { fontSize: '12px' } }, c.court)) },
        { label: 'Mandant', render: (c) => (c.clients.length ? c.clients.join(', ') : h('span', { class: 'muted' }, '–')) },
        { label: 'Rechtsgebiet', render: (c) => colorBadge(c.area, 'no-dot') },
        { label: 'Status', render: (c) => colorBadge(c.status) },
        { label: 'Priorität', render: (c) => badge(c.priorityLabel, PRIO_CLS[c.priority], false) },
        { label: 'Verantwortlich', render: (c) => c.lead?.label ?? h('span', { class: 'muted' }, '–') },
        { label: 'Nächster Termin', render: (c) => (c.nextAppointment ? h('span', null, fmtDate(c.nextAppointment.at)) : h('span', { class: 'muted' }, '–')) },
        { label: 'Geändert', render: (c) => h('span', { class: 'muted' }, fmtDate(c.updatedAt)) },
      ], d.cases, { onRowClick: (c) => openCase(c.id), empty: empty('Keine Akten gefunden', opt.canEdit ? 'Lege mit „Neue Akte“ den ersten Rechtsfall an.' : 'Passe die Filter an.', 'book') }));
  }

  // ═════════ Akte öffnen ═════════
  async function openCase(id, t = 'overview') {
    if (!alive()) return;
    tab = t;
    mount(host, skeletons(3, 90));
    let c; try { c = (await api.get(`/api/legal/cases/${id}`)).case; } catch (e) { toast(e.message, 'err'); return showList(); }
    current = c;
    drawCase();
  }
  const reload = async () => { if (!alive()) return; if (!current) return showList(); try { current = (await api.get(`/api/legal/cases/${current.id}`)).case; drawCase(); } catch (e) { toast(e.message, 'err'); showList(); } };
  const act = (fn) => (e) => busy(e.currentTarget, async () => { try { await fn(); } catch (ex) { toast(ex.message, 'err'); } });

  function drawCase() {
    if (!alive()) return;
    const c = current;
    setActions(h('div', { class: 'row' }, opt.canEdit && button('Bearbeiten', { icon: 'edit', onClick: () => caseDialog(c) }), opt.canDelete && button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      if (!await confirmDialog({ title: 'Akte löschen?', message: `${c.number} „${c.title}“ wird samt Beteiligten, Beweisen, Verlauf, Terminen, Kosten und Dokumenten endgültig gelöscht.`, confirmLabel: 'Löschen' })) return;
      try { await api.del(`/api/legal/cases/${c.id}`); toast('Akte gelöscht.'); showList(); } catch (e) { toast(e.message, 'err'); }
    } })));
    const TABS = [{ id: 'overview', label: 'Übersicht' }, { id: 'parties', label: 'Beteiligte', count: c.parties.length }, { id: 'evidence', label: 'Beweise', count: c.evidence.length }, { id: 'events', label: 'Verlauf', count: c.events.length },
      { id: 'appointments', label: 'Termine', count: c.appointments.filter((a) => !a.done).length || undefined }, opt.canBilling && { id: 'costs', label: 'Kosten' }, { id: 'docs', label: 'Dokumente', count: c.docs.length }].filter(Boolean);
    const body = h('div'), tabHost = h('div', { style: { marginBottom: '12px' } });
    const pick = (t) => { tab = t; mount(tabHost, tabs(TABS, tab, pick)); draw(); };
    const draw = () => mount(body, ({ overview, parties, evidence, events, appointments, costs, docs })[tab]?.() ?? overview());
    const statusSel = select(opt.statuses.map((s) => ({ value: s.id, label: s.label })), c.status?.id ?? '', { style: { width: 'auto' } });
    statusSel.disabled = !opt.canEdit;
    statusSel.addEventListener('change', async () => { try { await api.patch(`/api/legal/cases/${c.id}`, { statusId: Number(statusSel.value) }); toast('Status geändert.'); reload(); } catch (e) { toast(e.message, 'err'); } });
    mount(host,
      h('div', { class: 'row', style: { alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '10px' } },
        button('Zur Liste', { size: 'sm', icon: 'chevronL', onClick: showList }), h('span', { class: 'member-no' }, c.number), h('h2', { style: { fontSize: '18px', margin: 0 } }, c.title),
        c.confidential && badge('Vertraulich', 'b-warn', false), badge(c.priorityLabel, PRIO_CLS[c.priority], false), c.closed && badge('Beendet', 'b-mute', false), h('span', { class: 'grow' }), statusSel),
      c.conflicts.length > 0 && h('div', { style: { marginBottom: '12px' } }, note(`Interessenkonflikt prüfen: ${c.conflicts.map((x) => `${x.party} ist in ${x.number} („${x.title}“) auf der Seite „${x.otherSide}“`).join('; ')}.`, 'alert')),
      tabHost, body);
    mount(tabHost, tabs(TABS, tab, pick));
    draw();

    // ── Übersicht ──
    function overview() {
      const kv = (k, v) => [h('dt', null, k), h('dd', null, v ?? h('span', { class: 'muted' }, '–'))];
      const textCard = (title, value, ic, extra) => card(null, h('div', { style: { padding: '14px 16px' } }, h('div', { class: 'label', style: { marginBottom: '6px' } }, icon(ic), ' ', title), value ? h('div', { class: 'lc-text' }, value) : h('div', { class: 'muted' }, 'Noch nichts erfasst.'), extra));
      const side = (s) => c.parties.filter((p) => p.side === s);
      const ex = c.exposure;
      return h('div', { class: 'lc-grid' },
        card(null, h('div', { style: { padding: '14px 16px' } }, h('div', { class: 'label', style: { marginBottom: '8px' } }, 'Stammdaten'),
          h('dl', { class: 'details-dl' }, kv('Rechtsgebiet', c.area && colorBadge(c.area, 'no-dot')), kv('Art der Maßnahme', c.measure?.label), kv('Gericht', c.court || null), kv('Status', colorBadge(c.status)),
            kv('Verantwortlich', c.lead?.label), kv('Team', c.team.length ? c.team.map((t) => t.label).join(', ') : null), kv('Abrechnung', c.billingLabel), kv('Vollmacht', c.powerOfAttorney ? 'Liegt vor' : 'Fehlt noch'),
            kv('Geöffnet', fmtDate(c.openedAt)), c.closedAt && kv('Geschlossen', fmtDate(c.closedAt)), kv('Schlagwörter', c.tags || null), kv('Angelegt von', c.createdBy?.label)))),
        card(null, h('div', { style: { padding: '14px 16px' } }, h('div', { class: 'label', style: { marginBottom: '8px' } }, 'Parteien'),
          h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Mandant'), side('client').length ? side('client').map((p) => h('div', null, h('b', null, p.name), p.role && h('span', { class: 'muted' }, ` · ${p.role}`))) : h('div', { class: 'muted' }, '–'),
          h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } }, 'Gegenseite'), side('opponent').length ? side('opponent').map((p) => h('div', null, h('b', null, p.name), p.role && h('span', { class: 'muted' }, ` · ${p.role}`))) : h('div', { class: 'muted' }, '–'),
          side('involved').length > 0 && [h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } }, 'Weitere Beteiligte'), side('involved').map((p) => h('div', null, p.name, p.role && h('span', { class: 'muted' }, ` · ${p.role}`)))])),
        textCard('Kurzbeschreibung', c.summary, 'info'), textCard('Sachverhalt', c.facts, 'list'), textCard('Vorgeworfene Taten / Streitpunkte', c.charges, 'flag'),
        card(null, h('div', { style: { padding: '14px 16px' } }, h('div', { class: 'label', style: { marginBottom: '8px' } }, icon('alert'), ' Mögliche Folgen'),
          h('dl', { class: 'details-dl' }, kv('Geldstrafe', ex.fineCents ? money(ex.fineCents) : null), kv('Haft', ex.jailDays ? `${ex.jailDays} Tag${ex.jailDays === 1 ? '' : 'e'}` : null), kv('Wirtschaftlicher Schaden', ex.damageCents ? money(ex.damageCents) : null)),
          ex.note && h('div', { class: 'lc-text', style: { marginTop: '8px' } }, ex.note))),
        card(null, h('div', { style: { padding: '14px 16px', borderLeft: '3px solid var(--accent)' } }, h('div', { class: 'label', style: { marginBottom: '6px' } }, icon('lockClosed'), ' Strategie & Hinweise (intern)'), c.strategy ? h('div', { class: 'lc-text' }, c.strategy) : h('div', { class: 'muted' }, 'Noch nichts erfasst.'))),
        card(null, h('div', { style: { padding: '14px 16px' } }, h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, h('div', { class: 'label' }, 'Verknüpfte Akten'),
          opt.canEdit && button('Verknüpfen', { size: 'sm', icon: 'link', onClick: linkDialog })),
          c.related.length ? c.related.map((x) => h('div', { class: 'list-row', style: { cursor: 'pointer' }, onclick: () => openCase(x.id) }, h('span', { class: 'member-no' }, x.number), h('div', { class: 'grow' }, x.title),
            opt.canEdit && button('', { size: 'sm', variant: 'ghost', icon: 'x', title: 'Verknüpfung lösen', onClick: async (e) => { e.stopPropagation(); try { await api.del(`/api/legal/cases/${c.id}/related/${x.id}`); reload(); } catch (ex) { toast(ex.message, 'err'); } } }))) : h('div', { class: 'muted' }, 'Keine.'))));
    }
    function linkDialog() {
      const q = input({ placeholder: 'Aktenzeichen oder Titel suchen …' }), res = h('div');
      const run = debounce(async () => { const d = await api.get(`/api/legal/cases?q=${encodeURIComponent(q.value)}`); mount(res, d.cases.filter((x) => x.id !== c.id).slice(0, 8).map((x) => h('div', { class: 'list-row', style: { cursor: 'pointer' }, onclick: async () => { try { await api.post(`/api/legal/cases/${c.id}/related`, { relatedId: x.id }); m.close(); reload(); } catch (ex) { toast(ex.message, 'err'); } } }, h('span', { class: 'member-no' }, x.number), h('div', { class: 'grow' }, x.title)))); }, 250);
      q.addEventListener('input', run);
      const m = openModal({ title: 'Akte verknüpfen', body: h('div', null, field('Suche', q), res), footer: [h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() })] }); run();
    }

    // ── Beteiligte ──
    function parties() {
      const group = (s, title) => {
        const list = c.parties.filter((p) => p.side === s);
        return card(null, h('div', { style: { padding: '14px 16px' } }, h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, h('div', { class: 'label' }, title),
          opt.canEdit && button('Hinzufügen', { size: 'sm', icon: 'plus', onClick: () => partyDialog(s) })),
          list.length ? list.map((p) => h('div', { class: 'list-row' }, h('div', { class: 'dot-icon' }, icon(p.kind === 'contact_org' || p.kind === 'company' ? 'storage' : 'users')),
            h('div', { class: 'grow' }, h('div', { class: 't' }, p.name, p.role && h('span', { class: 'muted' }, ` · ${p.role}`)), h('div', { class: 's' }, [p.sub, p.note].filter(Boolean).join(' · '))),
            opt.canEdit && button('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Rolle/Notiz ändern', onClick: () => partyEdit(p) }),
            opt.canEdit && button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Entfernen', onClick: async () => { if (!await confirmDialog({ title: 'Entfernen?', message: `${p.name} wird aus dieser Akte entfernt (die Person selbst bleibt bestehen).`, confirmLabel: 'Entfernen' })) return; try { await api.del(`/api/legal/cases/${c.id}/parties/${p.id}`); reload(); } catch (e) { toast(e.message, 'err'); } } })))
            : h('div', { class: 'muted' }, 'Noch niemand eingetragen.')));
      };
      return h('div', { class: 'lc-grid' }, group('client', 'Mandanten'), group('opponent', 'Gegenseite'), group('involved', 'Weitere Beteiligte (Zeugen, Mittäter, Sachverständige …)'));
    }
    function partyDialog(side) {
      const role = input({ maxLength: 80, placeholder: side === 'client' ? 'z. B. Beschuldigter, Kläger' : 'z. B. Zeuge, Mittäter, Kläger' }), noteEl = input({ maxLength: 500, placeholder: 'Notiz (optional)' });
      const sideSel = select(Object.entries(opt.sides).map(([value, label]) => [value, label]).map(([value, label]) => ({ value, label })), side);
      const picker = partyPicker(async (pick) => {
        try {
          const body = { side: sideSel.value, role: role.value, note: noteEl.value, kind: pick.kind, refId: pick.refId, create: pick.create };
          const r = await api.post(`/api/legal/cases/${c.id}/parties`, body); m.close(); toast(r.conflicts?.length ? 'Hinzugefügt – bitte Interessenkonflikt prüfen.' : 'Hinzugefügt.', r.conflicts?.length ? 'warn' : 'ok'); reload();
        } catch (e) { toast(e.message, 'err'); }
      });
      const m = openModal({ title: 'Person oder Firma hinzufügen', wide: true, body: h('div', null, h('div', { class: 'form-row' }, field('Seite', sideSel), field('Rolle', role)), field('Notiz', noteEl), h('div', { class: 'sep' }), picker.el), footer: [h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() })] });
    }
    function partyEdit(p) {
      const role = input({ value: p.role, maxLength: 80 }), noteEl = input({ value: p.note, maxLength: 500 }), sideSel = select(Object.entries(opt.sides).map(([value, label]) => ({ value, label })), p.side);
      const m = openModal({ title: p.name, body: h('div', null, field('Seite', sideSel), field('Rolle', role), field('Notiz', noteEl)), footer: [h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }),
        button('Speichern', { variant: 'primary', icon: 'check', onClick: act(async () => { await api.patch(`/api/legal/cases/${c.id}/parties/${p.id}`, { side: sideSel.value, role: role.value, note: noteEl.value }); m.close(); reload(); }) })] });
    }

    // ── Beweise ──
    function evidence() {
      const col = (s, title) => { const list = c.evidence.filter((e) => e.side === s); return card(null, h('div', { style: { padding: '14px 16px' } }, h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '6px' } }, h('div', { class: 'label' }, title), opt.canEdit && button('Hinzufügen', { size: 'sm', icon: 'plus', onClick: () => evidenceDialog(null, s) })),
        list.length ? list.map((e) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 't', style: { whiteSpace: 'normal' } }, e.title), e.description && h('div', { class: 's lc-text' }, e.description)),
          opt.canEdit && button('', { size: 'sm', variant: 'ghost', icon: 'edit', onClick: () => evidenceDialog(e) }), opt.canEdit && button('', { size: 'sm', variant: 'ghost', icon: 'trash', onClick: () => removeItem('evidence', e.id, e.title) }))) : h('div', { class: 'muted' }, 'Keine.'))); };
      return h('div', { class: 'lc-grid' }, col('for', 'Spricht für uns (entlastend)'), col('against', 'Spricht gegen den Mandanten (belastend)'), col('neutral', 'Neutral / zu prüfen'));
    }
    function evidenceDialog(e, side = 'for') {
      const err = h('div'), title = input({ value: e?.title ?? '', maxLength: 120, placeholder: 'z. B. Überwachungsvideo, Zeugenaussage' }), desc = textarea(e?.description ?? ''), sideSel = select(Object.entries(opt.evidenceSides).map(([value, label]) => ({ value, label })), e?.side ?? side);
      const m = openModal({ title: e ? 'Beweis bearbeiten' : 'Beweis hinzufügen', body: h('div', null, err, field('Bezeichnung *', title), field('Zuordnung', sideSel), field('Beschreibung', desc)), footer: [h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }),
        button('Speichern', { variant: 'primary', icon: 'check', onClick: (ev) => busy(ev.currentTarget, async () => { try { const body = { title: title.value, side: sideSel.value, description: desc.value }; e ? await api.patch(`/api/legal/cases/${c.id}/evidence/${e.id}`, body) : await api.post(`/api/legal/cases/${c.id}/evidence`, body); m.close(); reload(); } catch (ex) { err.replaceChildren(formError(ex.message)); } }) })] });
    }
    async function removeItem(path, id, label) {
      if (!await confirmDialog({ title: 'Eintrag entfernen?', message: `„${label}“ wird gelöscht.`, confirmLabel: 'Entfernen' })) return;
      try { await api.del(`/api/legal/cases/${c.id}/${path}/${id}`); reload(); } catch (ex) { toast(ex.message, 'err'); }
    }

    // ── Verlauf ──
    function events() {
      return h('div', null, opt.canEdit && h('div', { style: { marginBottom: '12px' } }, button('Eintrag hinzufügen', { icon: 'plus', variant: 'primary', onClick: () => eventDialog(null) })),
        c.events.length ? h('div', { class: 'lc-tl' }, c.events.map((e) => h('div', { class: `lc-tl-item ${e.kind === 'system' ? 'sys' : ''}` }, h('div', { class: 'lc-tl-dot' }),
          h('div', { class: 'grow' }, h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, badge(e.kindLabel, e.kind === 'system' ? 'b-mute' : 'b-info', false), h('span', { class: 'muted', style: { fontSize: '12px' } }, `${fmtDateTime(e.at)}${e.by ? ` · ${e.by.label}` : ''}`)), h('div', { class: 'lc-text', style: { marginTop: '4px' } }, e.text)),
          opt.canEdit && e.kind !== 'system' && h('div', { class: 'row' }, button('', { size: 'sm', variant: 'ghost', icon: 'edit', onClick: () => eventDialog(e) }), button('', { size: 'sm', variant: 'ghost', icon: 'trash', onClick: () => removeItem('events', e.id, 'Verlaufseintrag') }))))) : empty('Noch kein Verlauf', null, 'clock'));
    }
    function eventDialog(e) {
      const err = h('div'), txt = textarea(e?.text ?? '', { rows: 5, placeholder: 'Was ist passiert? (Gespräch, Schriftsatz, Entscheidung …)' }), kind = select(Object.entries(opt.eventKinds).filter(([k]) => k !== 'system').map(([value, label]) => ({ value, label })), e?.kind ?? 'note');
      const at = input({ type: 'datetime-local', value: toLocalInput(e?.at) });
      const m = openModal({ title: e ? 'Verlaufseintrag bearbeiten' : 'Verlaufseintrag', body: h('div', null, err, h('div', { class: 'form-row' }, field('Art', kind), field('Zeitpunkt', at)), field('Text *', txt)), footer: [h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }),
        button('Speichern', { variant: 'primary', icon: 'check', onClick: (ev) => busy(ev.currentTarget, async () => { try { const body = { text: txt.value, kind: kind.value, at: fromLocalInput(at.value) }; e ? await api.patch(`/api/legal/cases/${c.id}/events/${e.id}`, body) : await api.post(`/api/legal/cases/${c.id}/events`, body); m.close(); reload(); } catch (ex) { err.replaceChildren(formError(ex.message)); } }) })] });
    }

    // ── Termine ──
    function appointments() {
      const nowIso = new Date().toISOString();
      const row = (a) => h('div', { class: 'list-row', style: a.done ? { opacity: 0.6 } : {} }, h('div', { class: 'dot-icon' }, icon(a.kind === 'deadline' ? 'alert' : 'clock')),
        h('div', { class: 'grow' }, h('div', { class: 't' }, a.title, ' ', badge(a.kindLabel, a.kind === 'deadline' ? 'b-err' : 'b-info', false), !a.done && a.startsAt < nowIso && badge('Überfällig', 'b-warn', false)), h('div', { class: 's' }, [fmtDateTime(a.startsAt), a.location, a.note].filter(Boolean).join(' · '))),
        opt.canEdit && button(a.done ? 'Wieder öffnen' : 'Erledigt', { size: 'sm', icon: 'check', onClick: async () => { try { await api.patch(`/api/legal/cases/${c.id}/appointments/${a.id}`, { done: !a.done }); reload(); } catch (e) { toast(e.message, 'err'); } } }),
        opt.canEdit && button('', { size: 'sm', variant: 'ghost', icon: 'edit', onClick: () => apptDialog(a) }), opt.canEdit && button('', { size: 'sm', variant: 'ghost', icon: 'trash', onClick: () => removeItem('appointments', a.id, a.title) }));
      const open = c.appointments.filter((a) => !a.done), done = c.appointments.filter((a) => a.done);
      return h('div', null, opt.canEdit && h('div', { style: { marginBottom: '12px' } }, button('Termin eintragen', { icon: 'plus', variant: 'primary', onClick: () => apptDialog(null) })),
        open.length ? open.map(row) : empty('Keine offenen Termine', 'Verhandlungen, Fristen und Besprechungen trägst du hier ein – das Team wird vorher erinnert.', 'clock'),
        done.length > 0 && [h('div', { class: 'label', style: { margin: '16px 0 6px' } }, 'Erledigt'), done.map(row)]);
    }
    function apptDialog(a) {
      const err = h('div'), title = input({ value: a?.title ?? '', maxLength: 120, placeholder: 'z. B. Hauptverhandlung, Einspruchsfrist' }), kind = select(Object.entries(opt.apptKinds).map(([value, label]) => ({ value, label })), a?.kind ?? 'hearing');
      const at = input({ type: 'datetime-local', value: toLocalInput(a?.startsAt) }), loc = input({ value: a?.location ?? '', maxLength: 120, placeholder: 'Ort (z. B. Gerichtssaal 2)' }), noteEl = textarea(a?.note ?? '', { rows: 3 });
      const m = openModal({ title: a ? 'Termin bearbeiten' : 'Termin eintragen', body: h('div', null, err, field('Titel *', title), h('div', { class: 'form-row' }, field('Art', kind), field('Beginn *', at)), field('Ort', loc), field('Notiz', noteEl)), footer: [h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }),
        button('Speichern', { variant: 'primary', icon: 'check', onClick: (ev) => busy(ev.currentTarget, async () => { try { const body = { title: title.value, kind: kind.value, startsAt: fromLocalInput(at.value), location: loc.value, note: noteEl.value }; a ? await api.patch(`/api/legal/cases/${c.id}/appointments/${a.id}`, body) : await api.post(`/api/legal/cases/${c.id}/appointments`, body); m.close(); reload(); } catch (ex) { err.replaceChildren(formError(ex.message)); } }) })] });
    }

    // ── Kosten ──
    function costs() {
      const s = c.costSummary ?? {};
      const chip = (label, v) => h('div', { class: 'card', style: { padding: '10px 14px', minWidth: '150px' } }, h('div', { class: 'muted', style: { fontSize: '12px' } }, label), h('div', { style: { fontWeight: 700, fontSize: '16px' } }, money(v)));
      return h('div', null, h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', marginBottom: '12px' } }, chip('Offen (noch abzurechnen)', s.open), chip('Abgerechnet', s.billed), chip('Bezahlt', s.paid), chip('Nicht abzurechnen', s.waived)),
        note(`Abrechnung dieser Akte: ${c.billingLabel}. Posten mit dem Status „Nicht abzurechnen“ zählen nicht zur Forderung.`, 'dollar'), h('div', { style: { height: '12px' } }),
        h('div', { style: { marginBottom: '12px' } }, button('Kosten erfassen', { icon: 'plus', variant: 'primary', onClick: () => costDialog(null) })),
        table([
          { label: 'Art', render: (x) => x.kindLabel }, { label: 'Beschreibung', render: (x) => x.description }, { label: 'Betrag', render: (x) => h('b', null, money(x.amountCents)) },
          { label: 'Status', render: (x) => badge(x.statusLabel, { open: 'b-warn', billed: 'b-info', paid: 'b-ok', waived: 'b-mute' }[x.status], false) },
          { label: '', style: { width: '1%' }, render: (x) => h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, button('', { size: 'sm', variant: 'ghost', icon: 'edit', onClick: () => costDialog(x) }), button('', { size: 'sm', variant: 'ghost', icon: 'trash', onClick: () => removeItem('costs', x.id, x.description) })) },
        ], c.costs ?? [], { empty: empty('Noch keine Kosten erfasst', 'Honorar, Gerichtskosten und Auslagen kannst du hier verbuchen.', 'dollar') }));
    }
    function costDialog(x) {
      const err = h('div'), kind = select(Object.entries(opt.costKinds).map(([value, label]) => ({ value, label })), x?.kind ?? 'fee'), desc = input({ value: x?.description ?? '', maxLength: 200, placeholder: 'z. B. Honorar Verteidigung' });
      const amount = input({ type: 'number', min: 0, step: '0.01', value: fromCents(x?.amountCents), placeholder: '0,00' }), status = select(Object.entries(opt.costStatuses).map(([value, label]) => ({ value, label })), x?.status ?? 'open');
      const m = openModal({ title: x ? 'Kosten bearbeiten' : 'Kosten erfassen', body: h('div', null, err, h('div', { class: 'form-row' }, field('Art', kind), field(`Betrag (${opt.currency}) *`, amount)), field('Beschreibung *', desc), field('Status', status, { help: '„Nicht abzurechnen“ für Posten, die nicht in Rechnung gestellt werden.' })), footer: [h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }),
        button('Speichern', { variant: 'primary', icon: 'check', onClick: (ev) => busy(ev.currentTarget, async () => { try { const body = { kind: kind.value, description: desc.value, amountCents: toCents(amount), status: status.value }; x ? await api.patch(`/api/legal/cases/${c.id}/costs/${x.id}`, body) : await api.post(`/api/legal/cases/${c.id}/costs`, body); m.close(); reload(); } catch (ex) { err.replaceChildren(formError(ex.message)); } }) })] });
    }

    // ── Dokumente ──
    function docs() {
      return h('div', null, opt.canEdit && h('div', { style: { marginBottom: '12px' } }, button('Dokument anhängen', { icon: 'plus', variant: 'primary', onClick: docDialog })),
        c.docs.length ? c.docs.map((d) => h('div', { class: 'list-row' }, h('div', { class: 'dot-icon' }, icon(d.kind === 'link' ? 'link' : 'list')),
          h('div', { class: 'grow' }, h('div', { class: 't', style: { whiteSpace: 'normal' } }, d.title), h('div', { class: 's' }, [d.description, d.kind === 'link' ? new URL(d.url).hostname : `${d.ext.toUpperCase()} · ${sizeText(d.size)}`, fmtDate(d.createdAt), d.by?.label].filter(Boolean).join(' · '))),
          d.kind === 'link' ? h('a', { class: 'btn btn-sm', href: d.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Öffnen') : h('a', { class: 'btn btn-sm', href: `/api/legal/cases/${c.id}/docs/${d.id}/file`, target: '_blank', rel: 'noopener' }, icon('search'), ['pdf', 'png', 'jpg', 'webp'].includes(d.ext) ? 'Ansehen' : 'Herunterladen'),
          opt.canEdit && button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Entfernen', onClick: async () => { if (!await confirmDialog({ title: 'Dokument entfernen?', message: `„${d.title}“ wird aus der Akte entfernt.`, confirmLabel: 'Entfernen' })) return; try { await api.del(`/api/legal/cases/${c.id}/docs/${d.id}`); reload(); } catch (e) { toast(e.message, 'err'); } } })))
          : empty('Keine Dokumente', 'Hänge Links (z. B. Google Drive) oder Dateien (PDF, Bilder, Word, Excel, Text) an.', 'list'));
    }
    function docDialog() {
      const err = h('div'), title = input({ maxLength: 120, placeholder: 'z. B. Anklageschrift, Beweisfotos' }), desc = input({ maxLength: 500, placeholder: 'Beschreibung (optional)' });
      const mode = select([{ value: 'link', label: 'Link (z. B. Google Drive / Docs)' }, { value: 'file', label: 'Datei hochladen' }], 'link');
      const url = input({ placeholder: 'https://drive.google.com/…' }), file = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt' });
      const urlF = field('Link *', url, { help: 'Nur https-Links. Die Freigabe regelst du im jeweiligen Dienst.' }), fileF = field('Datei *', file, { help: 'PDF, Bilder, Word, Excel, PowerPoint, Text – max. 8 MB.' });
      const sync = () => { urlF.style.display = mode.value === 'link' ? '' : 'none'; fileF.style.display = mode.value === 'file' ? '' : 'none'; }; mode.addEventListener('change', sync); sync();
      const m = openModal({ title: 'Dokument anhängen', body: h('div', null, err, field('Titel *', title), field('Beschreibung', desc), field('Art', mode), urlF, fileF), footer: [h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }),
        button('Anhängen', { variant: 'primary', icon: 'check', onClick: (ev) => busy(ev.currentTarget, async () => {
          try {
            const body = { title: title.value, description: desc.value };
            if (mode.value === 'link') body.url = url.value.trim(); else { if (!file.files[0]) throw new Error('Bitte eine Datei auswählen.'); body.filename = file.files[0].name; body.data = await readFile(file.files[0], 8); }
            await api.post(`/api/legal/cases/${c.id}/docs`, body); m.close(); toast('Dokument angehängt.'); reload();
          } catch (ex) { err.replaceChildren(formError(ex.message)); }
        }) })] });
    }
  }

  // ═════════ Beteiligte auswählen / neu anlegen ═════════
  function partyPicker(onPick) {
    const q = input({ placeholder: 'Suchen: Mitglied (Personalnummer), Externer Zugang, Firma, Kontakt …' }), res = h('div');
    const KIND_ICON = { user: 'users', partner: 'link', company: 'storage', contact_person: 'users', contact_org: 'storage' };
    const search = debounce(async () => {
      try { const { results } = await api.get(`/api/legal/cases/parties/search?q=${encodeURIComponent(q.value)}`); mount(res, results.length ? results.map((x) => h('div', { class: 'list-row', style: { cursor: 'pointer' }, onclick: () => onPick(x) }, h('div', { class: 'dot-icon' }, icon(KIND_ICON[x.kind])), h('div', { class: 'grow' }, h('div', { class: 't' }, x.name), h('div', { class: 's' }, x.sub)), button('Wählen', { size: 'sm' }))) : h('div', { class: 'muted', style: { padding: '8px 0' } }, 'Nichts gefunden – unten kannst du die Person neu erfassen.')); } catch (e) { mount(res, h('div', { class: 'muted' }, e.message)); }
    }, 250);
    q.addEventListener('input', search); search();
    // Noch nicht angelegt: neu erfassen (landet im Kontaktbuch)
    const kind = select([{ value: 'new_person', label: 'Person' }, { value: 'new_org', label: 'Institution / Firma' }], 'new_person');
    const fn = input({ maxLength: 60, placeholder: 'Vorname' }), ln = input({ maxLength: 60, placeholder: 'Nachname *' }), name = input({ maxLength: 120, placeholder: 'Name der Institution *' });
    const adr = input({ maxLength: 200, placeholder: 'Adresse' }), phone = input({ maxLength: 120, placeholder: 'Telefon' }), mail = input({ maxLength: 120, placeholder: 'E-Mail' }), pos = input({ maxLength: 80, placeholder: 'Stellung / Beruf' }), nts = textarea('', { rows: 2, placeholder: 'Notizen' });
    const personRows = h('div', null, h('div', { class: 'form-row' }, field('Vorname', fn), field('Nachname *', ln)), field('Stellung / Beruf', pos)), orgRows = h('div', null, field('Name *', name));
    const sync = () => { personRows.style.display = kind.value === 'new_person' ? '' : 'none'; orgRows.style.display = kind.value === 'new_org' ? '' : 'none'; }; kind.addEventListener('change', sync); sync();
    const form = h('div', { hidden: true }, note('Die Person wird zusätzlich im Kontaktbuch angelegt und kann dort weiter gepflegt werden.', 'info'), h('div', { style: { height: '8px' } }), field('Art', kind), personRows, orgRows, field('Adresse', adr), h('div', { class: 'form-row' }, field('Telefon', phone), field('E-Mail', mail)), field('Notizen', nts),
      button('Neu anlegen und hinzufügen', { variant: 'primary', icon: 'plus', onClick: () => {
        const create = kind.value === 'new_person' ? { firstName: fn.value.trim(), lastName: ln.value.trim(), position: pos.value.trim(), address: adr.value.trim(), phone: phone.value.trim(), email: mail.value.trim(), notes: nts.value }
          : { name: name.value.trim(), address: adr.value.trim(), phone: phone.value.trim(), email: mail.value.trim(), notes: nts.value };
        if (kind.value === 'new_person' ? !create.lastName : !create.name) return toast(kind.value === 'new_person' ? 'Bitte mindestens den Nachnamen angeben.' : 'Bitte den Namen angeben.', 'warn');
        onPick({ kind: kind.value, create, name: kind.value === 'new_person' ? `${create.firstName} ${create.lastName}`.trim() : create.name });
      } }));
    const toggle = button('Nicht angelegt? Neu erfassen', { size: 'sm', icon: 'plus', onClick: () => { form.hidden = !form.hidden; } });
    return { el: h('div', null, field('Suche', q), h('div', { class: 'lc-results' }, res), h('div', { class: 'sep' }), toggle, h('div', { style: { height: '10px' } }), form) };
  }

  // ═════════ Akte anlegen / bearbeiten ═════════
  async function caseDialog(c) {
    const err = h('div');
    const title = input({ value: c?.title ?? '', maxLength: 120, placeholder: 'z. B. Staat gegen Müller – Raubüberfall' });
    const prio = select(opt.priorities, c?.priority ?? 'normal'), status = select(opt.statuses.map((s) => ({ value: s.id, label: s.label })), c?.status?.id ?? opt.statuses.find((s) => s.key === 'open')?.id ?? '');
    const area = select([{ value: '', label: '— wählen —' }, ...opt.areas.map((a) => ({ value: a.id, label: a.label }))], c?.area?.id ?? '');
    const measure = select([{ value: '', label: '— wählen —' }, ...opt.measures.map((a) => ({ value: a.id, label: a.label }))], c?.measure?.id ?? '');
    const court = input({ value: c?.court ?? '', maxLength: 120, placeholder: 'z. B. District Court Los Santos' });
    const lead = select([{ value: '', label: '— niemand —' }, ...opt.members.map((m) => ({ value: m.id, label: m.label }))], c?.lead?.id ?? '');
    const team = new Set((c?.team ?? []).map((t) => t.id)), teamBox = h('div', { class: 'ct-roles' });
    mount(teamBox, opt.members.map((m) => { const k = h('input', { type: 'checkbox', checked: team.has(m.id) }); k.addEventListener('change', () => (k.checked ? team.add(m.id) : team.delete(m.id))); return h('label', { class: 'check', style: { padding: '2px 0' } }, k, h('span', { class: 'check-text' }, m.label)); }));
    const summary = textarea(c?.summary ?? '', { rows: 2, maxLength: 1000 }), facts = textarea(c?.facts ?? '', { rows: 6 }), charges = textarea(c?.charges ?? '', { rows: 3 }), strategy = textarea(c?.strategy ?? '', { rows: 5 });
    const fine = input({ type: 'number', min: 0, step: '0.01', value: fromCents(c?.exposure.fineCents), placeholder: '0,00' }), jail = input({ type: 'number', min: 0, step: '1', value: c?.exposure.jailDays || '', placeholder: 'Tage' }), dmg = input({ type: 'number', min: 0, step: '0.01', value: fromCents(c?.exposure.damageCents), placeholder: '0,00' });
    const expNote = input({ value: c?.exposure.note ?? '', maxLength: 1000, placeholder: 'z. B. Bewährung möglich' });
    const billing = select(opt.billingModes, c?.billingMode ?? 'billable'), tags = input({ value: c?.tags ?? '', maxLength: 200, placeholder: 'kommagetrennt' });
    const poa = h('input', { type: 'checkbox', checked: !!c?.powerOfAttorney }), conf = h('input', { type: 'checkbox', checked: !!c?.confidential });
    const clients = []; // nur beim Anlegen
    const clientBox = h('div');
    const drawClients = () => mount(clientBox, clients.map((x, i) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('b', null, x.name), h('span', { class: 'muted' }, x.create ? ' · wird neu angelegt' : ` · ${x.sub ?? ''}`)), button('', { size: 'sm', variant: 'ghost', icon: 'x', onClick: () => { clients.splice(i, 1); drawClients(); } }))));
    const picker = !c ? partyPicker((pick) => { clients.push(pick); drawClients(); toast(`${pick.name} als Mandant vorgemerkt.`); }) : null;
    const sec = (t) => [h('div', { class: 'sep' }), h('div', { class: 'label', style: { margin: '0 0 8px' } }, t)];
    const body = h('div', null, err,
      field('Titel *', title), h('div', { class: 'form-row' }, field('Rechtsgebiet', area), field('Art der Maßnahme', measure)), h('div', { class: 'form-row' }, field('Status', status), field('Priorität', prio)), field('Gericht', court),
      !c && [...sec('Mandant'), h('div', { class: 'help', style: { marginBottom: '6px' } }, 'Mitglieder, Externe Zugänge, Firmen oder Kontakte aus dem Kontaktbuch – oder eine Person, die noch nicht angelegt ist.'), clientBox, picker.el],
      ...sec('Sachverhalt'), field('Kurzbeschreibung', summary), field('Sachverhalt', facts), field('Vorgeworfene Taten / Streitpunkte', charges),
      ...sec('Mögliche Folgen'), h('div', { class: 'form-row' }, field(`Geldstrafe (${opt.currency})`, fine), field('Haft (Tage)', jail)), h('div', { class: 'form-row' }, field(`Wirtschaftlicher Schaden (${opt.currency})`, dmg), field('Hinweis', expNote)),
      ...sec('Strategie & Hinweise (intern)'), field('Strategie / Hinweise', strategy),
      ...sec('Zuständigkeit & Abrechnung'), h('div', { class: 'form-row' }, field('Verantwortlich', lead), field('Abrechnung', billing)), field('Team (sieht auch vertrauliche Akten)', teamBox), field('Schlagwörter', tags),
      h('label', { class: 'check', style: { padding: 0 } }, poa, h('span', { class: 'check-text' }, 'Vollmacht liegt vor')),
      h('label', { class: 'check', style: { padding: '6px 0 0' } }, conf, h('span', { class: 'check-text' }, 'Vertraulich – nur Verantwortliche, Team, Ersteller und Berechtigte sehen diese Akte')));
    const m = openModal({ title: c ? `Akte bearbeiten: ${c.number}` : 'Neue Akte', wide: true, body, footer: [h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }),
      button(c ? 'Speichern' : 'Akte anlegen', { variant: 'primary', icon: 'check', onClick: (ev) => busy(ev.currentTarget, async () => {
        err.replaceChildren();
        const payload = { title: title.value, areaId: area.value ? Number(area.value) : null, measureId: measure.value ? Number(measure.value) : null, statusId: Number(status.value), priority: prio.value, court: court.value, summary: summary.value, facts: facts.value, charges: charges.value, strategy: strategy.value,
          exposure: { fineCents: toCents(fine), jailDays: jail.value === '' ? 0 : Number(jail.value), damageCents: toCents(dmg), note: expNote.value }, leadUserId: lead.value ? Number(lead.value) : null, team: [...team], billingMode: billing.value, tags: tags.value, powerOfAttorney: poa.checked, confidential: conf.checked };
        try {
          if (c) { await api.patch(`/api/legal/cases/${c.id}`, payload); m.close(); toast('Gespeichert.'); reload(); return; }
          const made = (await api.post('/api/legal/cases', payload)).case; const failed = [];
          for (const x of clients) { try { await api.post(`/api/legal/cases/${made.id}/parties`, { side: 'client', kind: x.kind, refId: x.refId, create: x.create }); } catch { failed.push(x.name); } }
          m.close(); toast(`Akte ${made.number} angelegt.${failed.length ? ` Nicht hinzugefügt: ${failed.join(', ')}` : ''}`, failed.length ? 'warn' : 'ok'); openCase(made.id);
        } catch (ex) { err.replaceChildren(formError(ex.message)); body.parentElement.scrollTop = 0; }
      }) })] });
  }

  await showList();
  return { refresh: () => { if (alive()) (current ? reload() : showList()); } };
}
