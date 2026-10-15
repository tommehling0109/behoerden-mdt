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
        h('div', { class: 'dc-main' }, ch && h('div', { class: 'fresh-line' }, h('span', { class: 'fresh-badge' }, ch.label)), h('div', { class: 'dc-title' }, h('span', { class: 'member-no' }, d.number), ' ', d.item.name, ' ', catBadge(d.item.category)),
          h('div', { class: 'dc-sub' }, `${d.quantity.toLocaleString('de-DE')} ${d.item.unit} × ${money(d.unitPrice)} · ${timeAgo(d.updatedAt)}`),
          h('div', { class: 'chips', style: { marginTop: '8px' } }, d.direction === 'sell' && h('span', { class: 'badge no-dot b-info' }, 'Angebot vom Team'), dealBadge(d), turnBadge(d, 'partner'))),
        h('div', { class: 'dc-price' }, money(d.total)), icon('chevronR'));
      const open = () => { markDealSeen(scope, d); changes.delete(d.id); el.classList.remove('fresh', 'fresh-new', 'fresh-status', 'fresh-update'); el.querySelector('.fresh-line')?.remove(); ctx.refreshCounters?.(); openDealModal({ side: 'partner', base: '/api/p/market', id: d.id, onChange: async () => { try { const cur = (await api.get('/api/p/market/deals')).deals.find((x) => x.id === d.id); if (cur) markDealSeen(scope, cur); } catch { /* egal */ } show('deals'); } }); };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      return el;
    }));
  }

  function offerDialog() {
    if (!catalog.items.length && !catalog.allowOther) return toast('Aktuell können keine Items angeboten werden.', 'warn');
    const err = h('div');
    const catSel = select([{ value: '', label: 'Alle Kategorien' }, ...catalog.categories.map((c) => ({ value: c.id, label: c.label }))], '');
    const itemSel = h('select', { class: 'select' });
    const fill = () => mount(itemSel, [...catalog.items.filter((i) => !catSel.value || String(i.category?.id) === catSel.value).map((i) => h('option', { value: i.id }, `${i.name} (${i.unit})`)), catalog.allowOther && h('option', { value: 'other' }, 'Sonstiges (Artikel, der nicht in der Liste steht)')]);
    const otherName = input({ maxLength: 80, placeholder: 'Bezeichnung des Artikels' });
    const otherField = field('Was bietest du an? *', otherName, { help: 'Freitext – wir prüfen, ob wir den Artikel annehmen.' });
    const isOther = () => itemSel.value === 'other';
    const syncOther = () => { otherField.style.display = isOther() ? '' : 'none'; };
    catSel.addEventListener('change', () => { fill(); refresh(); }); fill();
    const qty = input({ type: 'number', min: 1, inputmode: 'numeric', placeholder: 'Stückzahl' });
    const price = input({ type: 'number', min: 1, inputmode: 'numeric', placeholder: 'Dein Preis pro Einheit' });
    const text = h('textarea', { class: 'textarea', maxLength: 500, placeholder: 'Beschreibung (Zustand, Besonderheiten …)' });
    const quoteBox = h('div', { class: 'quote-box' });
    let quote = null, custom = false, seq = 0;
    const unit = () => catalog.items.find((i) => String(i.id) === itemSel.value)?.unit ?? 'Stück';
    const draw = () => {
      const q = Number(qty.value) > 0;
      const own = custom || !quote;
      const pf = price.closest('.field');
      if (pf) pf.style.display = own ? '' : 'none';
      if (quote && !custom) {
        mount(quoteBox, h('div', { class: 'qb-label' }, icon('tag'), 'Unser Preisvorschlag'),
          h('div', { class: 'qb-price' }, money(quote.unitPrice), h('span', { class: 'muted' }, ` pro ${unit()}`)),
          h('div', { class: 'qb-total' }, 'Gesamt: ', h('b', null, money(quote.total))),
          h('div', { class: 'help' }, 'Du kannst direkt zu diesem Preis anbieten oder einen eigenen Preis vorschlagen – wir prüfen jedes Angebot.'),
          button('Eigenen Preis vorschlagen', { size: 'sm', variant: 'ghost', icon: 'edit', onClick: () => { custom = true; draw(); price.focus(); } }));
      } else if (quote && custom) {
        mount(quoteBox, h('div', { class: 'qb-label' }, icon('tag'), `Unser Vorschlag: ${money(quote.unitPrice)} pro ${unit()}`),
          q && Number(price.value) > 0 && h('div', { class: 'qb-total' }, 'Dein Angebot gesamt: ', h('b', null, money(Number(qty.value) * Number(price.value)))),
          button('Zum Vorschlag zurück', { size: 'sm', variant: 'ghost', icon: 'refresh', onClick: () => { custom = false; draw(); } }));
      } else mount(quoteBox, q && Number(price.value) > 0 ? h('div', { class: 'qb-total' }, 'Gesamt: ', h('b', null, money(Number(qty.value) * Number(price.value)))) : note('Für diesen Artikel gibt es keinen automatischen Vorschlag – bitte nenne deinen Preis.', 'info'));
    };
    const refresh = async () => {
      const my = ++seq;
      const item = catalog.items.find((i) => String(i.id) === itemSel.value);
      quote = null; syncOther();
      if (!isOther() && item?.suggestedPrice != null) {
        try { const r = await api.get(`/api/p/market/quote?itemId=${item.id}&quantity=${Math.max(1, Number(qty.value) || 1)}`); if (my === seq) quote = r.quote; } catch { /* kein Vorschlag */ }
      }
      if (my === seq) draw();
    };
    let t; const later = () => { clearTimeout(t); t = setTimeout(refresh, 250); };
    itemSel.addEventListener('change', () => { custom = false; refresh(); });
    qty.addEventListener('input', later); price.addEventListener('input', draw);
    const m = openModal({
      title: 'Angebot einstellen',
      body: h('div', null, err, h('div', { class: 'form-row' }, field('Kategorie', catSel), field('Artikel', itemSel)),
        otherField, field('Stückzahl', qty), quoteBox, field('Dein Preis pro Einheit', price), h('div', { style: { height: '12px' } }), field('Hinweis', text)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Angebot senden', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        if (!itemSel.value) return err.replaceChildren(formError('Bitte wähle einen Artikel aus.'));
        const body = isOther() ? { other: true, otherName: otherName.value.trim(), quantity: Number(qty.value), note: text.value.trim(), unitPrice: Number(price.value) } : { itemId: Number(itemSel.value), quantity: Number(qty.value), note: text.value.trim() };
        if (!isOther() && (custom || !quote)) body.unitPrice = Number(price.value);
        try { await api.post('/api/p/market/offers', body); m.close(); toast('Angebot gesendet – wir prüfen es und melden uns.'); show('deals'); }
        catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
    refresh();
  }

  ctx.live(['market', 'lookups', 'system', 'partners'], () => show(tab));
  await show('wanted');
}
