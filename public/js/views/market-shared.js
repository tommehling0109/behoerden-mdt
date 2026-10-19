// Gemeinsame Bausteine der Börse – genutzt von der Mitarbeiter-App und dem Partner-Portal.
import { h, mount, fmtDateTime, timeAgo } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, select, formError, openModal, confirmDialog, toast, skeletons, note, levelBadge, badge } from '../ui/kit.js';
import { api } from '../api.js';
import { subscribe } from '../realtime.js';
import { state, can } from '../state.js';

export const money = (n) => `${Number(n ?? 0).toLocaleString('de-DE', { maximumFractionDigits: 2 })} ${state.config['market.currency'] || '$'}`;
export const dealBadge = (d) => h('span', { class: 'badge', style: { '--c': d.statusColor } }, d.statusLabel);
/** Richtung: Ankauf (Partner verkauft uns etwas) oder Verkauf (wir bieten dem Partner etwas aus dem Lager an). */
export const dirBadge = (d) => (d.direction === 'sell' ? h('span', { class: 'badge no-dot b-info' }, 'Verkauf') : h('span', { class: 'badge no-dot b-mute' }, 'Ankauf'));
export const catBadge = (c) => (c ? h('span', { class: 'badge no-dot', style: { '--c': c.color } }, c.label) : null);
const OPEN = ['submitted', 'negotiating'];
const FINAL = ['completed', 'rejected', 'withdrawn', 'cancelled'];

/** Wer ist am Zug? – aus Sicht von `side`. */
export function turnBadge(d, side) {
  if (!OPEN.includes(d.status) || !d.turn) return null;
  const mine = d.turn === side;
  return h('span', { class: `badge no-dot ${mine ? 'b-warn' : 'b-mute'}` }, mine ? (side === 'staff' ? 'Wir sind am Zug' : 'Du bist am Zug') : (side === 'staff' ? 'Partner am Zug' : 'Wir sind am Zug'));
}

const KIND = {
  offer: 'hat ein Angebot eingestellt', response: 'hat sich auf das Gesuch gemeldet', counter: 'hat ein Gegenangebot gemacht',
  accept: 'hat angenommen', reject: 'hat abgelehnt', withdraw: 'hat zurückgezogen', message: 'Nachricht', note: 'Interne Notiz',
  handover: 'hat die Übergabe festgelegt', status: 'hat den Status geändert', cancel: 'hat storniert', assign: 'Zuständigkeit',
};
const KIND_ICON = { offer: 'tag', response: 'tag', counter: 'refresh', accept: 'check', reject: 'x', withdraw: 'x', message: 'audit', note: 'lock', handover: 'server', status: 'activity', cancel: 'x', assign: 'userCheck' };

export function timeline(events) {
  return h('div', { class: 'timeline' }, events.map((e) => h('div', { class: `tl-item ${e.internal ? 'internal' : ''} ${e.actorType}` },
    h('div', { class: 'tl-dot' }, icon(KIND_ICON[e.kind] ?? 'info')),
    h('div', { class: 'tl-body' },
      h('div', { class: 'tl-head' }, h('b', null, e.actorName ?? 'System'), ' ', h('span', { class: 'muted' }, KIND[e.kind] ?? e.kind),
        h('span', { class: 'tl-time', title: fmtDateTime(e.createdAt) }, timeAgo(e.createdAt))),
      e.unitPrice != null && h('div', { class: 'tl-offer' }, `${e.quantity != null ? e.quantity.toLocaleString('de-DE') + ' × ' : ''}${money(e.unitPrice)}`, e.quantity != null && h('span', { class: 'muted' }, ` = ${money(e.quantity * e.unitPrice)}`)),
      e.text && h('div', { class: 'tl-text' }, e.text)))));
}

/** Tabelle der Positionen eines Geschäfts (nur bei mehreren Items). */
export const linesTable = (d) => (d.lineCount > 1 ? h('div', { class: 'deal-lines' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Item', 'Menge', 'Preis pro Einheit', 'Summe'].map((t, i) => h('th', { style: i ? { textAlign: 'right' } : null }, t)))),
  h('tbody', null, d.lines.map((l) => h('tr', null, h('td', null, l.item.name, ' ', catBadge(l.item.category)), h('td', { style: { textAlign: 'right' } }, `${l.quantity.toLocaleString('de-DE')} ${l.item.unit}`), h('td', { style: { textAlign: 'right' } }, money(l.unitPrice)), h('td', { style: { textAlign: 'right' } }, h('b', null, money(l.total)))))),
  h('tfoot', null, h('tr', null, h('td', { colspan: 3, style: { textAlign: 'right' } }, 'Gesamt'), h('td', { style: { textAlign: 'right' } }, h('b', null, money(d.total))))))) : null);

/** Gegenangebot für mehrere Positionen: Menge und Preis je Item. */
export function linesDialog({ title, lines, submitLabel = 'Senden', onSubmit }) {
  const err = h('div'), total = h('div', { class: 'total-line' }), text = h('textarea', { class: 'textarea', maxLength: 500, placeholder: 'Nachricht (optional)' });
  const rows = lines.map((l) => ({ l, qty: input({ type: 'number', min: 1, value: l.quantity, inputmode: 'numeric' }), price: input({ type: 'number', min: 0.01, step: '0.01', value: l.unitPrice, inputmode: 'decimal' }), sum: h('b', null) }));
  const upd = () => { let t = 0; for (const r of rows) { const s = Number(r.qty.value) * Number(r.price.value); r.sum.textContent = s > 0 ? money(s) : '–'; if (s > 0) t += s; } mount(total, 'Gesamt: ', h('b', null, money(t))); };
  for (const r of rows) { r.qty.addEventListener('input', upd); r.price.addEventListener('input', upd); } upd();
  const m = openModal({ title, wide: true,
    body: h('div', null, err, h('div', { class: 'lines-edit' }, rows.map((r) => h('div', { class: 'le-row' }, h('div', { class: 'le-name' }, r.l.item.name, h('div', { class: 'muted', style: { fontSize: '12px' } }, `aktuell ${r.l.quantity.toLocaleString('de-DE')} × ${money(r.l.unitPrice)}`)), field(`Menge (${r.l.item.unit})`, r.qty), field('Preis pro Einheit', r.price), h('div', { class: 'le-sum' }, r.sum)))),
      total, h('div', { style: { height: '12px' } }), field('Nachricht', text)),
    footer: [button('Abbrechen', { onClick: () => m.close() }), button(submitLabel, { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      try { await onSubmit({ lines: rows.map((r) => ({ id: r.l.id, quantity: Number(r.qty.value), unitPrice: Number(r.price.value) })), text: text.value.trim() }); m.close(); } catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) })] });
  return m;
}

/** Dialog für Gegenangebote / Angebote: Menge (optional) + Preis pro Einheit + Text. */
export function priceDialog({ title, item, quantity, unitPrice, askQuantity = true, maxQuantity, submitLabel = 'Senden', onSubmit }) {
  const err = h('div');
  const qty = input({ type: 'number', min: 1, max: maxQuantity, value: quantity ?? '', inputmode: 'numeric' });
  const price = input({ type: 'number', min: 0.01, step: '0.01', value: unitPrice ?? '', inputmode: 'decimal' });
  const text = h('textarea', { class: 'textarea', maxLength: 500, placeholder: 'Nachricht (optional)' });
  const total = h('div', { class: 'total-line' });
  const upd = () => { const q = askQuantity ? Number(qty.value) : quantity; const p = Number(price.value); mount(total, 'Gesamt: ', h('b', null, q > 0 && p > 0 ? money(q * p) : '–')); };
  qty.addEventListener('input', upd); price.addEventListener('input', upd); upd();
  const m = openModal({
    title,
    body: h('div', null, err, item && h('div', { class: 'muted', style: { marginBottom: '12px' } }, item),
      h('div', { class: 'form-row' }, askQuantity && field('Menge', qty), field(`Preis pro Einheit (${state.config['market.currency'] || '$'})`, price)),
      total, h('div', { style: { height: '12px' } }), field('Nachricht', text)),
    footer: [button('Abbrechen', { onClick: () => m.close() }), button(submitLabel, { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      err.replaceChildren();
      try {
        await onSubmit({ quantity: askQuantity ? Number(qty.value) : undefined, unitPrice: Number(price.value), text: text.value.trim() });
        m.close();
      } catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) })],
  });
  return m;
}

/**
 * Detail-Dialog eines Geschäfts.
 * side 'staff'  → base '/api/market',   Aktionen für Mitarbeiter
 * side 'partner'→ base '/api/p/market', Aktionen für den Partner
 */
export function openDealModal({ side, base, id, onChange }) {
  const body = h('div', null, skeletons(3, 70));
  const footer = h('div', { class: 'row', style: { width: '100%' } });
  let off = null;
  // Eingabefelder leben außerhalb von render(), damit ein Live-Update nichts Getipptes löscht
  const msg = h('textarea', { class: 'textarea', maxLength: 1000 });
  const internal = side === 'staff' ? h('input', { type: 'checkbox' }) : null;
  const m = openModal({ title: 'Geschäft', wide: true, body, footer: null, onClose: () => off?.() });
  m.el.append(h('div', { class: 'modal-foot' }, footer));
  let places = [];

  async function act(action, payload = {}) {
    const res = await api.post(`${base}/deals/${id}/${action}`, payload);
    onChange?.();
    render(res);
    return res;
  }
  const guard = (fn) => async (e) => busy(e.currentTarget, async () => { try { await fn(); } catch (ex) { toast(ex.message, 'err'); } });

  function render({ deal: d, events }) {
    const open = OPEN.includes(d.status);
    const myTurn = open && d.turn === side;
    const partnerName = d.partner?.name;
    msg.placeholder = side === 'staff' ? 'Nachricht an den Partner …' : 'Nachricht an uns …';
    const head = m.el.querySelector('.modal-head h3');
    if (head) head.textContent = d.number ? `Geschäft ${d.number}` : 'Geschäft';

    const summary = h('div', { class: 'deal-summary' },
      h('div', { class: 'ds-main' },
        h('div', { class: 'ds-title' }, d.number && h('span', { class: 'member-no' }, d.number), d.itemLabel ?? d.item.name, ' ', d.lineCount > 1 ? null : catBadge(d.item.category)),
        h('div', { class: 'ds-sub' }, side === 'staff' ? `${d.partner.number ?? ''} · ${partnerName} · ` : '', side === 'staff' && levelBadge(d.partner.level), side === 'staff' && d.partner.level && ' · ', d.direction === 'sell' ? (side === 'staff' ? 'Unser Angebot an den Partner' : 'Angebot vom Team') : d.origin === 'wanted' ? 'Antwort auf Gesuch' : 'Angebot des Partners', ' · ', timeAgo(d.createdAt)),
        h('div', { class: 'chips', style: { marginTop: '8px' } }, dirBadge(d), dealBadge(d), turnBadge(d, side), side === 'staff' && d.warehouse && h('span', { class: 'badge no-dot b-mute', title: 'Quelle der Ware' }, `Lager: ${d.warehouse.name}`), d.assignee && h('span', { class: 'badge no-dot b-info' }, `${side === 'staff' ? 'Zuständig' : 'Ansprechpartner'}: ${d.assignee.displayName}`))),
      h('div', { class: 'ds-price' },
        h('div', { class: 'dp-total' }, money(d.total)),
        h('div', { class: 'dp-sub' }, d.lineCount > 1 ? `${d.lineCount} Positionen` : `${d.quantity.toLocaleString('de-DE')} ${d.item.unit} × ${money(d.unitPrice)}`),
        d.suggestedPrice != null && h('div', { class: 'dp-sub', title: 'Automatischer Preisvorschlag aus der Preisspanne beim Eingang des Angebots' }, d.suggestedPrice === d.unitPrice && d.proposedBy === 'partner' && d.origin === 'offer' ? 'zum Vorschlagspreis' : `Vorschlag: ${money(d.suggestedPrice)}${d.suggestedPrice !== d.unitPrice ? ` (${d.unitPrice > d.suggestedPrice ? '+' : ''}${Math.round(((d.unitPrice - d.suggestedPrice) / d.suggestedPrice) * 100)} %)` : ''}`)));

    const handover = d.handover && h('div', { class: 'handover-card' },
      h('div', { class: 'hc-title' }, icon('server'), side === 'partner' ? 'So geht es weiter' : 'Übergabe'),
      d.handover.place && h('div', { class: 'hc-row' }, h('span', { class: 'muted' }, 'Ort'), h('b', null, d.handover.place.label)),
      d.handover.place?.description && h('div', { class: 'hc-text' }, d.handover.place.description),
      d.handover.info && h('div', { class: 'hc-text' }, d.handover.info),
      d.handover.payoutInfo && h('div', { class: 'hc-row' }, h('span', { class: 'muted' }, d.direction === 'sell' ? 'Zahlung' : 'Auszahlung'), h('span', null, d.handover.payoutInfo)),
      h('div', { class: 'hc-row' }, h('span', { class: 'muted' }, d.direction === 'sell' ? (side === 'partner' ? 'Du zahlst' : 'Zahlungseingang') : (side === 'partner' ? 'Du erhältst' : 'Auszahlungsbetrag')), h('b', null, money(d.total))));

    mount(body, summary, linesTable(d),
      myTurn && h('div', { style: { margin: '14px 0' } }, note(side === 'staff' ? 'Der Partner wartet auf unsere Antwort.' : 'Wir warten auf deine Antwort: annehmen, ablehnen oder ein Gegenangebot machen.', 'alert')),
      handover,
      h('div', { class: 'sep' }), timeline(events),
      !FINAL.includes(d.status) && h('div', { class: 'composer' }, msg,
        h('div', { class: 'row' }, internal && h('label', { class: 'check', style: { padding: 0 } }, internal, h('span', { class: 'check-text' }, 'Interne Notiz (für Partner unsichtbar)')),
          h('span', { class: 'grow' }),
          button('Senden', { icon: 'check', size: 'sm', onClick: guard(async () => { if (!msg.value.trim()) return; await act('message', { text: msg.value.trim(), internal: internal?.checked === true }); }) }))));

    // Aktionsleiste
    const bar = [];
    const prompt = (label, variant, action, title, askQty = true) => button(label, { variant, icon: action === 'accept' ? 'check' : action === 'counter' ? 'refresh' : 'x', onClick: () => {
      if (action === 'accept') return confirmDialog({ title: 'Angebot annehmen?', message: `${d.lineCount > 1 ? `${d.lineCount} Positionen (${d.lines.map((l) => `${l.quantity.toLocaleString('de-DE')} ${l.item.unit} ${l.item.name}`).join(', ')}) für ${money(d.total)}.` : `${d.quantity.toLocaleString('de-DE')} ${d.item.unit} ${d.item.name} für ${money(d.total)} (${money(d.unitPrice)} pro Einheit).`}${d.direction === 'sell' ? (side === 'staff' ? ' Die Ware wird automatisch aus dem Lager abgebucht.' : ' Die Ware wird dir bereitgestellt, du zahlst den Betrag.') : ''}`, confirmLabel: 'Annehmen', variant: 'ok' }).then((r) => r && act('accept').then(() => toast('Angenommen.')).catch((ex) => toast(ex.message, 'err')));
      if (action === 'counter' && d.lineCount > 1) return linesDialog({ title: 'Gegenangebot', lines: d.lines, submitLabel: 'Gegenangebot senden', onSubmit: async (v) => { await act('counter', v); toast('Gegenangebot gesendet.'); } });
      if (action === 'counter') return priceDialog({ title: 'Gegenangebot', item: `${d.item.name} · aktuell ${money(d.unitPrice)} × ${d.quantity.toLocaleString('de-DE')}`, quantity: d.quantity, unitPrice: d.unitPrice, askQuantity: true, submitLabel: 'Gegenangebot senden',
        onSubmit: async (v) => { await act('counter', v); toast('Gegenangebot gesendet.'); } });
      return confirmDialog({ title, message: 'Dies kann nicht rückgängig gemacht werden.', confirmLabel: label, withReason: true }).then((r) => r && act(action, { text: r.reason }).catch((ex) => toast(ex.message, 'err')));
    } });
    if (myTurn) bar.push(prompt('Annehmen', 'ok', 'accept'), prompt('Gegenangebot', 'info', 'counter'), prompt('Ablehnen', 'danger', 'reject', 'Ablehnen?'));
    if (side === 'staff' && open && !myTurn) bar.push(prompt('Ablehnen', 'danger', 'reject', 'Geschäft ablehnen?'));
    if (side === 'partner' && open && !myTurn) bar.push(prompt('Zurückziehen', 'danger', 'withdraw', 'Angebot zurückziehen?'));
    if (side === 'staff') {
      if (['accepted', 'delivery'].includes(d.status)) bar.push(button(d.status === 'accepted' ? 'Übergabe festlegen' : 'Übergabe ändern', { variant: 'primary', icon: 'server', onClick: () => handoverDialog(d) }));
      const NEXT = (d.direction === 'sell'
        ? { delivery: ['Ware übergeben', 'delivered'], delivered: ['Zahlung ausstehend', 'payout'], payout: ['Zahlung eingegangen – abschließen', 'completed'] }
        : { delivery: ['Ware eingegangen', 'delivered'], delivered: ['Zahlung ausstehend', 'payout'], payout: ['Als bezahlt abschließen', 'completed'] })[d.status];
      if (NEXT) bar.push(button(`Weiter: ${NEXT[0]}`, { variant: 'primary', icon: 'chevronR', onClick: d.status === 'delivery' && d.direction !== 'sell' && can('warehouse.stock') ? () => deliveredDialog(d) : guard(() => act('advance', { to: NEXT[1] })) }));
      if (!FINAL.includes(d.status) && d.status !== 'submitted' && d.status !== 'negotiating') bar.push(button('Stornieren', { variant: 'danger', icon: 'x', onClick: () => confirmDialog({ title: 'Geschäft stornieren?', message: 'Das Geschäft wird beendet.', confirmLabel: 'Stornieren', withReason: true }).then((r) => r && act('cancel', { text: r.reason }).catch((ex) => toast(ex.message, 'err'))) }));
      if (!d.assignee || d.assignee.id !== state.user.id) bar.push(button('Mir zuweisen', { size: 'sm', variant: 'ghost', icon: 'userCheck', onClick: guard(() => act('assign', { userId: state.user.id })) }));
    }
    if (side === 'staff' && can('market.delete')) bar.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      if (!await confirmDialog({ title: 'Geschäft endgültig löschen?', message: 'Das Geschäft wird samt Verlauf und Finanz-Eintrag gelöscht – in jedem Status. Ware, die noch nicht übergeben war, geht zurück ins Lager. Das lässt sich nicht rückgängig machen.', confirmLabel: 'Endgültig löschen' })) return;
      try { await api.del(`${base}/deals/${id}`); m.close(); toast('Geschäft gelöscht.'); onChange?.(); } catch (ex) { toast(ex.message, 'err'); }
    } }));
    mount(footer, bar, h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
  }

  /** Wareneingang: optional direkt in ein Lager einbuchen. */
  async function deliveredDialog(d) {
    let whs = [];
    try { whs = (await api.get('/api/warehouses')).warehouses.filter((w) => w.canBook && w.isActive); } catch { /* kein Lagerzugriff */ }
    const err = h('div');
    const sel = select([{ value: '', label: '— nicht einlagern —' }, ...whs.map((w) => ({ value: w.id, label: `${w.name}${w.capacity != null ? ` (frei: ${Math.max(0, w.capacity - w.used).toLocaleString('de-DE')})` : ''}` }))], whs.length === 1 ? whs[0].id : '');
    const dm = openModal({
      title: 'Ware eingegangen',
      body: h('div', null, err, note(`${d.lineCount > 1 ? d.lines.map((l) => `${l.quantity.toLocaleString('de-DE')} ${l.item.unit} ${l.item.name}`).join(', ') + ' sind' : `${d.quantity.toLocaleString('de-DE')} ${d.item.unit} ${d.item.name} sind`} eingegangen. Wähle ein Lager, um sie direkt einzubuchen.`, 'info'), h('div', { style: { height: '12px' } }),
        field('Einlagern in', sel, { help: whs.length ? '' : 'Du hast kein Lager mit Buchungsrecht – der Wareneingang wird ohne Einlagerung erfasst.' })),
      footer: [button('Abbrechen', { onClick: () => dm.close() }), button('Wareneingang bestätigen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        try { await act('advance', { to: 'delivered', warehouseId: sel.value ? Number(sel.value) : undefined }); dm.close(); toast(sel.value ? 'Eingegangen und eingelagert.' : 'Wareneingang erfasst.'); }
        catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
  }

  function handoverDialog(d) {
    const err = h('div');
    const place = select([{ value: '', label: '— kein fester Ort —' }, ...places.map((p) => ({ value: p.id, label: p.label }))], d.handover?.place?.id ?? '');
    const info = h('textarea', { class: 'textarea', maxLength: 1000, placeholder: 'Wo genau ist die Ware / wie bekommt der Partner Zugriff? …' }, d.handover?.info ?? '');
    const payout = h('textarea', { class: 'textarea', maxLength: 1000, placeholder: 'Wann und wo erhält der Partner sein Geld? …' }, d.handover?.payoutInfo ?? '');
    const hint = h('div', { class: 'help' });
    const sync = () => { const p = places.find((x) => String(x.id) === place.value); hint.textContent = p?.description ? `Anweisung des Ortes: ${p.description}` : ''; };
    place.addEventListener('change', sync); sync();
    const hm = openModal({
      title: 'Übergabe festlegen',
      body: h('div', null, err, note(`Der Partner sieht diese Angaben. Betrag: ${money(d.total)}.`, 'info'), h('div', { style: { height: '12px' } }),
        field('Übergabeort', place, { help: 'Orte pflegst du unter „Kategorien & Status“.' }), hint, field('Anweisung', info), field(d.direction === 'sell' ? 'Zahlung (wie und wann zahlt der Partner?)' : 'Auszahlung', payout)),
      footer: [button('Abbrechen', { onClick: () => hm.close() }), button('Speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        try { await act('handover', { placeId: place.value ? Number(place.value) : null, info: info.value.trim(), payoutInfo: payout.value.trim() }); hm.close(); toast('Übergabe gespeichert.'); }
        catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })],
    });
  }

  (async () => {
    try {
      if (side === 'staff') places = (await api.get('/api/lookups')).lists.find((l) => l.key === 'market.handover_place')?.entries.filter((e) => e.isActive) ?? [];
      render(await api.get(`${base}/deals/${id}`));
      // Live: jede Änderung an Geschäften lädt diesen Dialog neu (Eingaben bleiben erhalten)
      off = subscribe(['market'], async () => {
        try { render(await api.get(`${base}/deals/${id}`)); } catch { m.close(); }
      }, { wait: 120 });
    } catch (e) { mount(body, note(e.message, 'alert')); }
  })();
  return m;
}
