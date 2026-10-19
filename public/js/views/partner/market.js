import { h, mount, timeAgo, fmtDate } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, busy, card, field, input, select, tabs, formError, openModal, toast, skeletons, empty, note, badge } from '../../ui/kit.js';
import { api } from '../../api.js';
import { partnerScope, dealChanges, markDealSeen, wantedNew } from '../../seen.js';
import { money, dealBadge, catBadge, turnBadge, dirBadge, openDealModal, priceDialog } from '../market-shared.js';

/** Börse aus Sicht des externen Partners: Gesuche einsehen, Angebote einstellen, eigene Geschäfte verfolgen. */
export default async function render(container, ctx) {
  let tab = 'wanted';
  const scope = partnerScope();
  let changes = new Map();
  const freshWanted = new Set(); // in dieser Sitzung neu hinzugekommene Gesuche (Markierung bleibt bis zum Neuladen)
  let catalog = { items: [], categories: [] };
  const tabHost = h('div', { style: { marginBottom: '16px' } });
  const host = h('div');
  mount(container, tabHost, host);
  ctx.setActions(button('Angebot einstellen', { variant: 'primary', icon: 'plus', onClick: () => offerDialog() }));

  async function show(t) {
    tab = t;
    let deals = [], wanted = [];
    try {
      [catalog, { deals }, { wanted }] = await Promise.all([api.get('/api/p/market/catalog'), api.get('/api/p/market/deals'), api.get('/api/p/market/wanted')]);
    } catch (e) { return mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
    if (!ctx.isCurrent()) return;
    changes = dealChanges(scope, deals);
    for (const id of wantedNew(scope, wanted)) freshWanted.add(id);
    const attention = deals.filter((d) => d.turn === 'partner' && ['submitted', 'negotiating'].includes(d.status)).length;
    mount(tabHost, tabs([
      { id: 'wanted', label: 'Gesucht', count: freshWanted.size || wanted.length || undefined },
      { id: 'deals', label: changes.size ? `Meine Geschäfte · ${changes.size} neu` : 'Meine Geschäfte', count: changes.size || attention || deals.length || undefined },
    ], tab, show));
    mount(host, tab === 'wanted' ? wantedView(wanted) : dealsView(deals));
  }

  function wantedView(list) {
    if (!list.length) return card(null, empty('Aktuell suchen wir nichts', 'Du kannst trotzdem jederzeit selbst ein Angebot einstellen.', 'search'));
    return h('div', { class: 'stack' }, note('Das suchen wir aktuell. Hast du etwas davon? Melde dich mit einem Klick – wir antworten dir hier.', 'info'),
      h('div', { class: 'market-grid' }, list.map((w) => h('article', { class: `card wanted-card ${freshWanted.has(w.id) ? 'fresh' : ''}`, style: { '--rc': w.item.category?.color ?? 'var(--accent)' } },
        h('div', { class: 'row' }, freshWanted.has(w.id) && h('span', { class: 'fresh-badge' }, 'Neu'), catBadge(w.item.category), h('span', { class: 'grow' }), w.expiresAt && h('span', { class: 'muted', style: { fontSize: '12px' } }, `bis ${fmtDate(w.expiresAt)}`)),
        h('h3', null, w.item.name),
        h('div', { class: 'wc-price' }, `${money(w.unitPrice)} `, h('span', { class: 'muted', style: { fontSize: '13px', fontWeight: 500 } }, `/ ${w.item.unit}`)),
        h('div', null, `Gesucht: `, h('b', null, `${w.quantity.toLocaleString('de-DE')} ${w.item.unit}`)),
        h('div', { class: 'wc-note' }, w.note),
        button('Ich habe das', { variant: 'primary', icon: 'check', onClick: () => respond(w) })))));
  }

  function respond(w) {
    priceDialog({
      title: `Auf Gesuch melden: ${w.item.name}`, item: `Gesucht: ${w.quantity.toLocaleString('de-DE')} ${w.item.unit} zu ${money(w.unitPrice)} pro ${w.item.unit}`,
      quantity: Math.min(w.quantity, 1), unitPrice: w.unitPrice, maxQuantity: w.quantity, submitLabel: 'Melden',
      onSubmit: async (v) => { await api.post(`/api/p/market/wanted/${w.id}/respond`, { quantity: v.quantity, unitPrice: v.unitPrice, note: v.text }); toast('Gemeldet – wir melden uns bei dir.'); show('deals'); },
    });
  }

  function dealsView(list) {
    if (!list.length) return card(null, empty('Noch keine Geschäfte', 'Stelle ein Angebot ein oder melde dich auf ein Gesuch.', 'tag'));
    const sorted = [...list].sort((a, b) => (changes.has(b.id) - changes.has(a.id)));
    return h('div', null, sorted.map((d) => {
      const mine = d.turn === 'partner' && ['submitted', 'negotiating'].includes(d.status);
      const ch = changes.get(d.id);
      const el = h('article', { class: `card hoverable deal-card ${mine ? 'attention' : ''} ${ch ? `fresh fresh-${ch.kind}` : ''}`, tabindex: 0 },
        h('div', { class: 'dc-main' }, ch && h('div', { class: 'fresh-line' }, h('span', { class: 'fresh-badge' }, ch.label)), h('div', { class: 'dc-title' }, h('span', { class: 'member-no' }, d.number), ' ', d.itemLabel ?? d.item.name, ' ', d.lineCount > 1 ? null : catBadge(d.item.category)),
          h('div', { class: 'dc-sub' }, `${d.lineCount > 1 ? `${d.lineCount} Positionen` : `${d.quantity.toLocaleString('de-DE')} ${d.item.unit} × ${money(d.unitPrice)}`} · ${timeAgo(d.updatedAt)}`),
          h('div', { class: 'chips', style: { marginTop: '8px' } }, d.direction === 'sell' && h('span', { class: 'badge no-dot b-info' }, 'Angebot vom Team'), dealBadge(d), turnBadge(d, 'partner'))),
        h('div', { class: 'dc-price' }, money(d.total)), icon('chevronR'));
      const open = () => { markDealSeen(scope, d); changes.delete(d.id); el.classList.remove('fresh', 'fresh-new', 'fresh-status', 'fresh-update'); el.querySelector('.fresh-line')?.remove(); ctx.refreshCounters?.(); openDealModal({ side: 'partner', base: '/api/p/market', id: d.id, onChange: async () => { try { const cur = (await api.get('/api/p/market/deals')).deals.find((x) => x.id === d.id); if (cur) markDealSeen(scope, cur); } catch { /* egal */ } show('deals'); } }); };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      return el;
    }));
  }

  /** Angebot einstellen: eine oder mehrere Positionen (Items) in einem Vorgang. */
  function offerDialog() {
    if (!catalog.items.length && !catalog.allowOther) return toast('Aktuell können keine Items angeboten werden.', 'warn');
    const err = h('div'), rowsBox = h('div', { class: 'stack', style: { gap: '12px' } }), total = h('div', { class: 'total-line' });
    const catSel = select([{ value: '', label: 'Alle Kategorien' }, ...catalog.categories.map((c) => ({ value: c.id, label: c.label }))], '');
    const text = h('textarea', { class: 'textarea', maxLength: 500, placeholder: 'Beschreibung (Zustand, Besonderheiten …)' });
    let rows = [];
    const itemOf = (r) => catalog.items.find((i) => String(i.id) === r.item.value);
    const isOther = (r) => r.item.value === 'other';
    // Auswahl je Position: Katalog-Items (jedes nur einmal) plus „Sonstiges“ (beliebig oft)
    const fillItems = () => {
      for (const r of rows) {
        const cur = r.item.value, taken = new Set(rows.filter((x) => x !== r && x.item.value && x.item.value !== 'other').map((x) => x.item.value));
        const opts = catalog.items.filter((i) => (!catSel.value || String(i.category?.id) === catSel.value || String(i.id) === cur) && (!taken.has(String(i.id)) || String(i.id) === cur));
        mount(r.item, [...opts.map((i) => h('option', { value: i.id }, `${i.name} (${i.unit})`)), catalog.allowOther && h('option', { value: 'other' }, 'Sonstiges (Artikel, der nicht in der Liste steht)')]);
        if (cur && (opts.some((i) => String(i.id) === cur) || cur === 'other')) r.item.value = cur;
      }
    };
    const draw = () => {
      let t = 0, missing = false;
      for (const r of rows) {
        const q = Number(r.qty.value), own = Number(r.price.value), p = own > 0 ? own : r.quote?.unitPrice ?? 0;
        r.otherField.style.display = isOther(r) ? '' : 'none';
        r.hint.textContent = isOther(r) ? '' : r.quote ? `Unser Preisvorschlag: ${money(r.quote.unitPrice)} pro ${itemOf(r)?.unit ?? 'Stück'}${own > 0 && own !== r.quote.unitPrice ? ` · dein Preis: ${money(own)}` : ''}` : (itemOf(r)?.suggestedPrice != null ? '' : 'Dafür gibt es keinen automatischen Vorschlag – bitte nenne deinen Preis.');
        r.price.placeholder = r.quote && !isOther(r) ? `Vorschlag: ${r.quote.unitPrice}` : 'Dein Preis pro Einheit';
        r.sum.textContent = q > 0 && p > 0 ? money(q * p) : '';
        if (q > 0 && p > 0) t += q * p; else missing = true;
      }
      mount(total, 'Gesamt: ', h('b', null, t > 0 ? money(t) : '–'), rows.length > 1 && h('span', { class: 'muted' }, ` (${rows.length} Positionen)`), missing && t > 0 && h('span', { class: 'muted' }, ' – noch nicht alle Positionen vollständig'));
    };
    const requote = async (r) => {
      const my = ++r.seq, item = itemOf(r); r.quote = null;
      if (!isOther(r) && item?.suggestedPrice != null) { try { const res = await api.get(`/api/p/market/quote?itemId=${item.id}&quantity=${Math.max(1, Number(r.qty.value) || 1)}`); if (my === r.seq) r.quote = res.quote; } catch { /* kein Vorschlag */ } }
      if (my === r.seq) draw();
    };
    const drawRows = () => mount(rowsBox, rows.map((r, i) => h('div', { class: 'offer-line' },
      h('div', { class: 'form-row' }, field(rows.length > 1 ? `Item ${i + 1}` : 'Artikel', r.item), field('Stückzahl', r.qty), field('Dein Preis pro Einheit', r.price)),
      r.otherField, h('div', { class: 'ol-foot' }, r.hint, h('span', { class: 'grow' }), r.sum, rows.length > 1 && button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Position entfernen', onClick: () => { rows.splice(i, 1); fillItems(); drawRows(); draw(); } })))));
    const addRow = () => {
      if (rows.length >= 25) return toast('Höchstens 25 Positionen pro Angebot.', 'warn');
      const r = { seq: 0, quote: null, item: h('select', { class: 'select' }), qty: input({ type: 'number', min: 1, inputmode: 'numeric', placeholder: 'Stückzahl' }), price: input({ type: 'number', min: 0.01, step: '0.01', inputmode: 'decimal' }), other: input({ maxLength: 80, placeholder: 'Bezeichnung des Artikels' }), hint: h('div', { class: 'help' }), sum: h('b', null) };
      r.otherField = field('Was bietest du an? *', r.other, { help: 'Freitext – wir prüfen, ob wir den Artikel annehmen.' });
      r.item.addEventListener('change', () => { fillItems(); drawRows(); requote(r); });
      let tm; r.qty.addEventListener('input', () => { draw(); clearTimeout(tm); tm = setTimeout(() => requote(r), 250); }); r.price.addEventListener('input', draw);
      rows.push(r); fillItems(); drawRows(); requote(r);
    };
    catSel.addEventListener('change', () => { fillItems(); rows.forEach(requote); });
    addRow();
    const m = openModal({
      title: 'Angebot einstellen', wide: true,
      body: h('div', null, err, field('Kategorie (Auswahl eingrenzen)', catSel), rowsBox, button('Weiteres Item hinzufügen', { icon: 'plus', size: 'sm', onClick: addRow }), total, h('div', { style: { height: '12px' } }), field('Hinweis', text)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Angebot senden', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        if (rows.some((r) => !r.item.value)) return err.replaceChildren(formError('Bitte wähle für jede Position einen Artikel aus.'));
        const lines = rows.map((r) => (isOther(r)
          ? { other: true, otherName: r.other.value.trim(), quantity: Number(r.qty.value), unitPrice: Number(r.price.value) }
          : { itemId: Number(r.item.value), quantity: Number(r.qty.value), ...(Number(r.price.value) > 0 ? { unitPrice: Number(r.price.value) } : {}) }));
        try { await api.post('/api/p/market/offers', { lines, note: text.value.trim() }); m.close(); toast(lines.length > 1 ? `Angebot mit ${lines.length} Positionen gesendet – wir prüfen es und melden uns.` : 'Angebot gesendet – wir prüfen es und melden uns.'); show('deals'); }
        catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
  }

  ctx.live(['market', 'lookups', 'system', 'partners'], () => show(tab));
  await show('wanted');
}
