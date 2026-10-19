import { h, mount, timeAgo, debounce, fmtDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import {
  button, busy, card, field, input, select, tabs, table, badge, formError, openModal, confirmDialog, toast, skeletons, empty, note, toggle, levelBadge } from '../ui/kit.js';
import { api } from '../api.js';
import { can, state } from '../state.js';
import { money, dealBadge, catBadge, turnBadge, dirBadge, openDealModal } from './market-shared.js';

export default async function render(container, ctx) {
  const canDeals = can('market.deals.manage'), canWanted = can('market.wanted.manage'), canCatalog = can('market.catalog.manage');
  let tab = 'deals';
  const f = { group: 'staff', q: '', status: '', category: '' };
  const tabHost = h('div', { style: { marginBottom: '16px' } });
  const host = h('div');
  mount(container, tabHost, host);

  async function showTab(t, silent = false) {
    tab = t;
    const sum = await api.get('/api/market/summary').catch(() => ({ awaitingStaff: 0, openWanted: 0 }));
    mount(tabHost, tabs([
      { id: 'deals', label: 'Geschäfte', count: sum.awaitingStaff || undefined },
      { id: 'wanted', label: 'Gesuche', count: sum.openWanted || undefined },
      { id: 'catalog', label: 'Katalog' },
    ], tab, (id) => showTab(id)));
    ctx.refreshCounters?.();
    ctx.setActions(tab === 'deals' && canDeals && can('warehouse.stock') ? button('Angebot an Partner', { variant: 'primary', icon: 'storage', onClick: () => sellDialog() }) : tab === 'wanted' && canWanted ? button('Gesuch erstellen', { variant: 'primary', icon: 'plus', onClick: () => wantedEditor(null) })
      : tab === 'catalog' && canCatalog ? button('Item anlegen', { variant: 'primary', icon: 'plus', onClick: () => itemEditor(null) }) : '');
    if (!silent) mount(host, skeletons(4, 54));
    try { await ({ deals: () => deals(sum), wanted, catalog })[tab](); } catch (e) { mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
  }

  // Zähler-Chip: zeigt die Zahl, hebt sich kurz hervor, wenn sie sich ändert
  const prev = new Map();
  const countBadge = (key, n, hot = false) => {
    const el = h('span', { class: `count ${hot && n > 0 ? 'hot' : ''}` }, n);
    if (prev.has(key) && prev.get(key) !== n) el.classList.add('bump');
    prev.set(key, n);
    return el;
  };

  // ── Geschäfte ──
  async function deals(sum) {
    const hadFocus = host.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    const p = new URLSearchParams();
    if (f.group === 'staff') { p.set('turn', 'staff'); p.set('group', 'open'); }
    else if (f.group !== 'all') p.set('group', f.group);
    if (f.status) p.set('status', f.status);
    if (f.category) p.set('category', f.category);
    if (f.q) p.set('q', f.q);
    const { deals: rows } = await api.get(`/api/market/deals?${p}`);
    if (!ctx.isCurrent()) return;
    const by = sum.byStatus ?? {};
    const n = (...keys) => keys.reduce((a, k) => a + (by[k] ?? 0), 0);
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    const GROUPS = [['staff', 'Wir sind am Zug', sum.awaitingStaff ?? 0, true], ['open', 'In Verhandlung', n('submitted', 'negotiating')], ['active', 'Laufend', n('accepted', 'delivery', 'delivered', 'payout')], ['done', 'Beendet', n('completed', 'rejected', 'withdrawn', 'cancelled')], ['all', 'Alle', total]];
    const search = input({ placeholder: 'Nummer, Partner oder Item suchen …', value: f.q });
    search.addEventListener('input', debounce(() => { f.q = search.value.trim(); showTab('deals', true); }));
    const groups = h('div', { class: 'tabs' }, GROUPS.map(([id, label, cnt, hot]) => {
      const b = h('button', { class: `tab ${f.group === id && !f.status ? 'active' : ''}`, type: 'button' }, label, ' ', countBadge('g:' + id, cnt, hot));
      b.addEventListener('click', () => { f.group = id; f.status = ''; showTab('deals', true); });
      return b;
    }));
    const catChips = h('div', { class: 'count-chips' }, h('span', { class: 'chip-label' }, 'Kategorie'),
      (() => {
        const all = h('button', { class: `cchip ${!f.category ? 'on' : ''}`, type: 'button' }, 'Alle', countBadge('c:all', (sum.byCategory ?? []).reduce((a, c) => a + c.active, 0)));
        all.addEventListener('click', () => { f.category = ''; showTab('deals', true); });
        return all;
      })(),
      (sum.byCategory ?? []).map((c) => {
        const key = c.id == null ? 'none' : String(c.id);
        const b = h('button', { class: `cchip ${f.category === key ? 'on' : ''} ${c.active === 0 ? 'zero' : ''}`, type: 'button', title: `${c.active} aktive Vorgänge, ${c.waiting} warten auf uns`, style: { '--c': c.color } },
          h('span', { class: 'dot' }), c.label, countBadge('c:' + key, c.active, c.waiting > 0));
        b.addEventListener('click', () => { f.category = f.category === key ? '' : key; showTab('deals', true); });
        return b;
      }));
    const statusChips = h('div', { class: 'count-chips' }, h('span', { class: 'chip-label' }, 'Status'),
      (sum.statuses ?? []).map((st) => {
        const b = h('button', { class: `cchip ${f.status === st.key ? 'on' : ''} ${st.count === 0 ? 'zero' : ''}`, type: 'button', style: { '--c': st.color } }, h('span', { class: 'dot' }), st.label, countBadge('s:' + st.key, st.count));
        b.addEventListener('click', () => { f.status = f.status === st.key ? '' : st.key; f.group = 'all'; showTab('deals', true); });
        return b;
      }));
    mount(host, h('div', { class: 'toolbar' }, groups, h('div', { class: 'grow' }), h('div', { class: 'input-icon' }, icon('search'), search)), catChips, statusChips,
      table([
        { label: 'Nr.', style: { width: '1%' }, render: (d) => h('div', null, h('span', { class: 'member-no' }, d.number), h('div', { style: { marginTop: '4px' } }, dirBadge(d))) },
        { label: 'Partner', render: (d) => h('div', null, h('b', null, d.partner.number), ' ', d.partner.isMember && badge('Mitglied', 'b-info', false), ' ', levelBadge(d.partner.level), h('div', { class: 'muted', style: { fontSize: '12px' } }, d.partner.name)) },
        { label: 'Item', render: (d) => h('div', null, d.item.name, ' ', d.lineCount > 1 ? badge(`+ ${d.lineCount - 1} weitere`, 'b-info', false) : catBadge(d.item.category)) },
        { label: 'Menge', render: (d) => (d.lineCount > 1 ? `${d.lineCount} Positionen` : `${d.quantity.toLocaleString('de-DE')} ${d.item.unit}`) },
        { label: 'Preis/Einh.', render: (d) => (d.lineCount > 1 ? h('span', { class: 'muted' }, 'verschieden') : money(d.unitPrice)) },
        { label: 'Gesamt', render: (d) => h('b', null, money(d.total)) },
        { label: 'Status', render: (d) => h('div', { class: 'chips' }, dealBadge(d), turnBadge(d, 'staff')) },
        { label: 'Aktualisiert', render: (d) => h('span', { class: 'muted' }, timeAgo(d.updatedAt)) },
      ], rows, { onRowClick: (d) => openDealModal({ side: 'staff', base: '/api/market', id: d.id, onChange: () => showTab('deals', true) }),
        empty: empty(f.group === 'staff' && !f.status ? 'Nichts zu tun' : 'Keine Geschäfte', f.group === 'staff' && !f.status ? 'Aktuell wartet kein Partner auf eine Antwort.' : 'Passe Filter oder Suche an – Partner stellen Angebote über ihren Zugang ein.', 'tag') }));
    if (hadFocus) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  // ── Angebot an einen Partner: Items aus unseren Lagern ──
  async function sellDialog() {
    let partners = [], whs = [];
    try {
      [{ partners }, { warehouses: whs }] = await Promise.all([api.get('/api/market/partners'), api.get('/api/warehouses')]);
    } catch (e) { return toast(e.message, 'err'); }
    whs = whs.filter((w) => w.canBook && w.isActive).sort((a, b) => (b.itemCount > 0) - (a.itemCount > 0)); // Lager mit Bestand zuerst
    if (!partners.length) return toast('Es gibt keinen aktiven Partner mit Börsen-Zugang.', 'warn');
    if (!whs.length) return toast('Du hast kein Lager, aus dem du verkaufen darfst (Lager-Verwaltung + Buchungsrecht nötig).', 'warn');
    const err = h('div');
    const partner = select(partners.map((p) => ({ value: p.id, label: `${p.number} · ${p.name}` })), '');
    const wh = select(whs.map((w) => ({ value: w.id, label: w.name })), whs[0].id);
    const text = h('textarea', { class: 'textarea', maxLength: 500, placeholder: 'Hinweis für den Partner (optional)' });
    const total = h('div', { class: 'total-line' }, 'Gesamt: –'), rowsBox = h('div', { class: 'stack', style: { gap: '10px' } });
    let stock = [], rows = [];
    // Eine Position = Item aus dem Lager + Menge + Preis; jedes Item nur einmal (die Auswahl blendet schon gewählte aus)
    const upd = () => {
      let t = 0;
      for (const r of rows) {
        const s = stock.find((x) => String(x.itemId) === r.item.value);
        r.info.textContent = s ? `Im Lager verfügbar: ${s.quantity.toLocaleString('de-DE')} ${s.unit}${s.minPrice != null ? ` · Ankaufs-Spanne: ${money(s.minPrice)} – ${money(s.maxPrice)}` : ''}` : '';
        const sum = Number(r.qty.value) * Number(r.price.value); r.sum.textContent = sum > 0 ? money(sum) : ''; if (sum > 0) t += sum;
      }
      mount(total, 'Gesamt: ', h('b', null, t > 0 ? money(t) : '–'), rows.length > 1 && h('span', { class: 'muted' }, ` (${rows.length} Positionen)`));
    };
    const fillItems = () => { for (const r of rows) { const cur = r.item.value, taken = new Set(rows.filter((x) => x !== r && x.item.value).map((x) => x.item.value)); const opts = stock.filter((s) => !taken.has(String(s.itemId)) || String(s.itemId) === cur); mount(r.item, opts.length ? opts.map((s) => h('option', { value: s.itemId }, `${s.name} (${s.quantity.toLocaleString('de-DE')} ${s.unit})`)) : h('option', { value: '' }, stock.length ? 'Alle Items sind schon im Angebot' : 'Dieses Lager ist leer')); if (cur && opts.some((s) => String(s.itemId) === cur)) r.item.value = cur; } };
    const drawRows = () => { mount(rowsBox, rows.map((r, i) => h('div', { class: 'offer-line' }, h('div', { class: 'form-row' }, field(rows.length > 1 ? `Item ${i + 1}` : 'Artikel', r.item), field('Menge', r.qty), field('Preis pro Einheit', r.price)), h('div', { class: 'ol-foot' }, r.info, h('span', { class: 'grow' }), r.sum, rows.length > 1 && button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Position entfernen', onClick: () => { rows.splice(i, 1); fillItems(); drawRows(); upd(); } }))))); };
    const addRow = () => {
      if (rows.length >= 25) return toast('Höchstens 25 Positionen pro Angebot.', 'warn');
      const r = { item: h('select', { class: 'select' }), qty: input({ type: 'number', min: 1, inputmode: 'numeric', placeholder: 'Menge' }), price: input({ type: 'number', min: 0.01, step: '0.01', inputmode: 'decimal', placeholder: 'Preis pro Einheit' }), info: h('div', { class: 'help' }), sum: h('b', null) };
      for (const el of [r.item, r.qty, r.price]) { el.addEventListener('input', upd); el.addEventListener('change', () => { if (el === r.item) fillItems(); upd(); }); }
      rows.push(r); fillItems(); const taken = new Set(rows.filter((x) => x !== r && x.item.value).map((x) => x.item.value)); const free = stock.find((s) => !taken.has(String(s.itemId))); if (free) r.item.value = String(free.itemId); fillItems(); drawRows(); upd();
    };
    const loadStock = async () => {
      try { stock = (await api.get(`/api/warehouses/${wh.value}`)).stock; } catch { stock = []; }
      rows = []; addRow();
    };
    wh.addEventListener('change', loadStock);
    const m = openModal({
      title: 'Angebot an Partner', wide: true,
      body: h('div', null, err, note('Der Partner sieht dein Angebot in seiner Börse und kann annehmen, ablehnen oder ein Gegenangebot machen. Bei Annahme wird die Ware automatisch aus dem gewählten Lager abgebucht und die Zahlung im Finanz-Journal vorgemerkt.', 'info'), h('div', { style: { height: '12px' } }),
        field('Partner', partner), field('Aus Lager', wh), rowsBox, button('Weiteres Item hinzufügen', { icon: 'plus', size: 'sm', onClick: addRow }), total, h('div', { style: { height: '10px' } }), field('Hinweis', text)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Angebot senden', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        if (rows.some((r) => !r.item.value)) return err.replaceChildren(formError('Bitte wähle für jede Position einen Artikel aus dem Lager.'));
        try { await api.post('/api/market/offers', { partnerId: Number(partner.value), warehouseId: Number(wh.value), lines: rows.map((r) => ({ itemId: Number(r.item.value), quantity: Number(r.qty.value), unitPrice: Number(r.price.value) })), note: text.value.trim() }); m.close(); toast(rows.length > 1 ? `Angebot mit ${rows.length} Positionen gesendet.` : 'Angebot gesendet.'); showTab('deals', true); }
        catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
    loadStock();
  }

  // ── Gesuche ──
  async function wanted() {
    const [{ wanted: rows }, { items }] = await Promise.all([api.get('/api/market/wanted'), api.get('/api/market/items')]);
    if (!ctx.isCurrent()) return;
    mount(host, note('Gesuche sehen alle Partner mit Börsen-Zugang. Sie können sich direkt darauf melden – die Antworten erscheinen unter „Geschäfte“.', 'info'), h('div', { style: { height: '14px' } }),
      table([
        { label: 'Wir suchen', render: (w) => h('div', null, h('b', null, w.item.name), ' ', catBadge(w.item.category)) },
        { label: 'Menge', render: (w) => `${w.quantity.toLocaleString('de-DE')} ${w.item.unit}` },
        { label: 'Wir zahlen', render: (w) => `${money(w.unitPrice)} / ${w.item.unit}` },
        { label: 'Status', render: (w) => (w.status === 'open' && (!w.expiresAt || w.expiresAt > new Date().toISOString()) ? badge('Offen', 'b-ok') : badge(w.status === 'closed' ? 'Geschlossen' : 'Abgelaufen', 'b-mute')) },
        { label: 'Läuft bis', render: (w) => (w.expiresAt ? fmtDate(w.expiresAt) : h('span', { class: 'muted' }, 'unbegrenzt')) },
        { label: 'Antworten', render: (w) => w.responseCount },
        canWanted && { label: '', style: { width: '1%' }, render: (w) => button('Bearbeiten', { size: 'sm', icon: 'edit', onClick: () => wantedEditor(w, items) }) },
      ].filter(Boolean), rows, { onRowClick: canWanted ? (w) => wantedEditor(w, items) : undefined, empty: empty('Keine Gesuche', canWanted ? 'Lege fest, was wir aktuell suchen – Partner können sich darauf melden.' : null, 'search') }));
  }

  async function wantedEditor(w, itemsIn) {
    const items = (itemsIn ?? (await api.get('/api/market/items')).items).filter((i) => i.isActive || i.id === w?.item.id);
    if (!items.length) return toast('Lege zuerst Items im Katalog an.', 'warn');
    const err = h('div');
    const item = select(items.map((i) => ({ value: i.id, label: `${i.name}${i.category ? ' · ' + i.category.label : ''}` })), w?.item.id ?? items[0].id);
    const qty = input({ type: 'number', min: 1, value: w?.quantity ?? '' });
    const price = input({ type: 'number', min: 0.01, step: '0.01', value: w?.unitPrice ?? '' });
    const exp = input({ type: 'date', value: w?.expiresAt ? w.expiresAt.slice(0, 10) : '' });
    const text = h('textarea', { class: 'textarea', maxLength: 300, placeholder: 'Hinweis für Partner (z. B. Qualität, Dringlichkeit)' }, w?.note ?? '');
    const open = toggle('Gesuch ist offen', w ? w.status === 'open' : true);
    const footer = [];
    if (w) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      const r = await confirmDialog({ title: 'Gesuch löschen?', message: 'Bereits eingegangene Antworten bleiben unter „Geschäfte“ erhalten.', confirmLabel: 'Löschen' });
      if (!r) return;
      try { await api.del(`/api/market/wanted/${w.id}`); m.close(); toast('Gesuch gelöscht.'); showTab('wanted'); } catch (e) { toast(e.message, 'err'); }
    } }));
    footer.push(h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }), button(w ? 'Speichern' : 'Veröffentlichen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      const payload = { itemId: Number(item.value), quantity: Number(qty.value), unitPrice: Number(price.value), note: text.value.trim(), expiresAt: exp.value || null };
      if (w) payload.status = open.input.checked ? 'open' : 'closed';
      try { if (w) await api.patch(`/api/market/wanted/${w.id}`, payload); else await api.post('/api/market/wanted', payload); m.close(); toast(w ? 'Gespeichert.' : 'Gesuch veröffentlicht.'); showTab('wanted'); }
      catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) }));
    const m = openModal({ title: w ? 'Gesuch bearbeiten' : 'Neues Gesuch', body: h('div', null, err, field('Gesuchtes Item', item),
      h('div', { class: 'form-row' }, field('Gewünschte Menge', qty), field('Preis pro Einheit', price)), field('Läuft bis (optional)', exp), field('Hinweis', text), w && open), footer });
  }

  // ── Katalog ──
  async function catalog() {
    const [{ items, partners, itemDefault }, lk] = await Promise.all([api.get('/api/market/items'), api.get('/api/lookups')]);
    if (!ctx.isCurrent()) return;
    const cats = lk.lists.find((l) => l.key === 'market.item_category')?.entries.filter((e) => e.isActive) ?? [];
    mount(host, h('div', { class: 'toolbar' }, h('span', { class: 'muted' }, `${items.length} Items im Katalog – Partner wählen daraus aus.`), h('div', { class: 'grow' }),
      can('lookups.view') && button('Kategorien verwalten', { icon: 'tag', size: 'sm', onClick: () => ctx.openApp('lookups') })),
    table([
      { label: 'Item', render: (i) => h('div', null, h('b', null, i.name), i.description && h('div', { class: 'muted', style: { fontSize: '12px' } }, i.description)) },
      { label: 'Kategorie', render: (i) => catBadge(i.category) ?? h('span', { class: 'muted' }, '–') },
      { label: 'Einheit', render: (i) => i.unit },
      { label: 'Richtpreis', render: (i) => (i.referencePrice != null ? money(i.referencePrice) : h('span', { class: 'muted' }, '–')) },
      { label: 'Status', render: (i) => (i.isActive ? badge('Aktiv', 'b-ok') : badge('Inaktiv', 'b-mute')) },
      { label: 'Partner', render: (i) => (i.partnerAccess === 'none' ? badge('Keine', 'b-mute') : i.partnerAccess === 'selected' ? badge(`${i.partnerIds.length} ausgewählt`, 'b-info') : badge('Alle', 'b-ok')) },
      canCatalog && { label: '', style: { width: '1%' }, render: (i) => button('Bearbeiten', { size: 'sm', icon: 'edit', onClick: () => itemEditor(i, cats, partners, itemDefault) }) },
    ].filter(Boolean), items, { onRowClick: canCatalog ? (i) => itemEditor(i, cats, partners, itemDefault) : undefined, empty: empty('Der Katalog ist leer', canCatalog ? 'Lege Items an (z. B. Eisen, Waffen, Gold), die Partner anbieten oder die wir suchen.' : null, 'tag') }));
  }

  async function itemEditor(item, catsIn, partnersIn, defIn) {
    const cats = catsIn ?? (await api.get('/api/lookups')).lists.find((l) => l.key === 'market.item_category')?.entries.filter((e) => e.isActive) ?? [];
    const meta = partnersIn ? null : await api.get('/api/market/items');
    const partnerList = partnersIn ?? meta.partners ?? [], accessDefault = defIn ?? meta?.itemDefault ?? 'all';
    const err = h('div');
    const name = input({ value: item?.name ?? '', maxLength: 80 });
    const desc = input({ value: item?.description ?? '', maxLength: 300 });
    const cat = select([{ value: '', label: '— keine Kategorie —' }, ...cats.map((c) => ({ value: c.id, label: c.label }))], item?.category?.id ?? '');
    const unit = input({ value: item?.unit ?? 'Stück', maxLength: 20 });
    const ref = input({ type: 'number', min: 0, step: '0.01', value: item?.referencePrice ?? '', placeholder: 'optional, nur intern' });
    const xp = input({ type: 'number', min: 0, step: '1', value: item?.xp ?? '', placeholder: 'leer = Standard' });
    const active = toggle('Im Katalog aktiv (für Partner auswählbar)', item ? item.isActive : true);
    // Sichtbarkeit für externe Partner (damit sie nicht sehen, was wir im Lager haben)
    const access = select([{ value: 'all', label: 'Alle Partner' }, { value: 'selected', label: 'Nur ausgewählte Partner' }, { value: 'none', label: 'Keine Partner (nur intern)' }], item?.partnerAccess ?? accessDefault);
    const chosen = new Set(item?.partnerIds ?? []);
    const pBox = h('div', { class: 'ct-roles' });
    const drawP = () => {
      pBox.hidden = access.value !== 'selected';
      mount(pBox, partnerList.length ? partnerList.map((p) => { const c = h('input', { type: 'checkbox', checked: chosen.has(p.id) }); c.addEventListener('change', () => (c.checked ? chosen.add(p.id) : chosen.delete(p.id))); return h('label', { class: 'check', style: { padding: '2px 0' } }, c, h('span', { class: 'check-text' }, `${p.number ?? ''} · ${p.name}`)); }) : h('div', { class: 'muted' }, 'Es gibt noch keine aktiven externen Zugänge.'));
    };
    access.addEventListener('change', drawP); drawP();
    const footer = [];
    if (item) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      const r = await confirmDialog({ title: 'Item löschen?', message: `„${item.name}“ wird aus dem Katalog entfernt. Items mit Geschäften können nur deaktiviert werden.`, confirmLabel: 'Löschen' });
      if (!r) return;
      try { await api.del(`/api/market/items/${item.id}`); m.close(); toast('Item gelöscht.'); showTab('catalog'); } catch (e) {
        if (e.status === 409 && state.user.isSuperadmin && await confirmDialog({ title: 'Samt allem löschen?', message: `${e.message.split(' (Superadmins')[0]} Als Superadmin kannst du den Artikel samt Geschäften, Gesuchen und Beständen endgültig löschen.`, confirmLabel: 'Alles endgültig löschen' })) {
          try { await api.del(`/api/market/items/${item.id}` + '?force=1'); m.close(); toast('Item gelöscht.'); showTab('catalog'); } catch (e2) { toast(e2.message, 'err'); }
        } else if (e.status !== 409 || !state.user.isSuperadmin) toast(e.message, 'err');
      }
    } }));
    footer.push(h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }), button(item ? 'Speichern' : 'Anlegen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      const payload = { name: name.value, description: desc.value, categoryId: cat.value ? Number(cat.value) : null, unit: unit.value, referencePrice: ref.value === '' ? null : Number(ref.value), isActive: active.input.checked, xp: xp.value === '' ? '' : Number(xp.value), partnerAccess: access.value, partnerIds: access.value === 'selected' ? [...chosen] : [] };
      try { if (item) await api.patch(`/api/market/items/${item.id}`, payload); else await api.post('/api/market/items', payload); m.close(); toast('Gespeichert.'); showTab('catalog'); }
      catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) }));
    const m = openModal({ title: item ? `Item: ${item.name}` : 'Neues Item', body: h('div', null, err, h('div', { class: 'form-row' }, field('Name', name), field('Kategorie', cat)), field('Beschreibung', desc),
      h('div', { class: 'form-row' }, field('Einheit', unit, { help: 'z. B. Stück, kg, Packung' }), field('Richtpreis', ref, { help: 'Interne Orientierung – Partner sehen ihn nicht.' })), active,
      field('Level-XP (manueller Modus)', xp, { help: 'Wie viele Erfahrungspunkte ein abgeschlossenes Geschäft mit diesem Artikel gibt, wenn die XP in der Konfiguration (Level) manuell festgelegt sind. Leer = fester Standardwert.' }),
      h('div', { class: 'sep' }), field('Sichtbar für externe Partner', access, { help: 'Wer diesen Artikel in der externen Börse sieht und anbieten kann. Zusätzlich kann jeder Zugang auf bestimmte Artikel beschränkt sein (Externe Zugänge → Börse-Artikel).' }), pBox), footer });
  }

  ctx.live(['market', 'lookups', 'partners'], () => showTab(tab, true)); // jede Änderung aktualisiert Listen, Zähler und Badges
  await showTab('deals');
}
