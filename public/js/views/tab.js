import { h, mount, fmtDateTime, fmtDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, card, field, input, select, table, tabs, formError, openModal, confirmDialog, toast, skeletons, empty, note, memberNo, badge } from '../ui/kit.js';
import { api } from '../api.js';
import { state } from '../state.js';

export const fmtC = (c) => `${(Number(c ?? 0) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${state.config['market.currency'] || '$'}`;
/** „1.284,50“ / „1284.5“ / „25“ → Cent (oder null) */
export function parseMoney(text) {
  let s = String(text ?? '').trim().replace(/\s|[€$]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
const statusBadge = (s) => h('span', { class: 'badge', style: { '--c': s.statusColor } }, s.statusLabel);
const copyText = async (t) => { try { await navigator.clipboard.writeText(t); toast('Link kopiert.'); } catch { toast('Kopieren nicht möglich – bitte manuell markieren.', 'warn'); } };
const fullLink = (path) => { const h = state.config['coop.host']; return `${h ? `https://${h}` : location.origin}${path}`; }; // Links für Externe laufen über deren eigene Subdomain
const money = (c) => (c / 100).toFixed(2).replace('.', ',');

/**
 * Deckel: gedacht für externe Firmen. Eine Firma hat Firmenname, Firmensitz und Kontonummer und reicht über ihren Portal-Link
 * den fälligen Betrag ein. Wir buchen nichts selbst, gleichen nichts ab und kennen deshalb keine Differenz – wir prüfen nur,
 * bestätigen (mit Konto und Betrag) und dokumentieren die Zahlung.
 */
export default async function render(container, ctx) {
  let opts = await api.get('/api/tab/options');
  const TABS = [
    (opts.canView || opts.canStatements) && { id: 'overview', label: 'Übersicht' },
    (opts.canView || opts.canStatements) && { id: 'statements', label: 'Abrechnungen' },
    { id: 'companies', label: 'Firmen' },
  ].filter(Boolean);
  let tab = TABS[0].id;
  const f = { stStatus: '' };
  const tabHost = h('div', { style: { marginBottom: '16px' } });
  const host = h('div');
  mount(container, tabHost, host);

  function drawActions() { ctx.setActions(tab === 'companies' && opts.canCompanies && button('Firma anlegen', { variant: 'primary', icon: 'plus', onClick: () => companyEditor(null) })); }
  async function show(t, silent = false) {
    tab = t; drawActions();
    if (!silent) mount(host, skeletons(3, 90));
    try { opts = await api.get('/api/tab/options'); } catch { /* alte Optionen */ }
    mount(tabHost, tabs(TABS, tab, (x) => show(x)));
    try { await ({ overview, statements, companies })[tab](); } catch (e) { mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
  }

  // ── Übersicht ──
  async function overview() {
    const { summary: s } = await api.get('/api/tab/summary');
    if (!ctx.isCurrent() || tab !== 'overview') return;
    const tile = (v, label, tone, to) => { const el = h('div', { class: `tile ${tone ? 't-' + tone : ''} clickable` }, h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, v), h('div', { class: 'tile-label' }, label))); el.addEventListener('click', () => { f.stStatus = to ?? ''; show('statements'); }); return el; };
    mount(host, h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(s.companies, 'Aktive Firmen', 'info', ''), tile(s.submitted + s.review, 'Neu / in Prüfung', s.submitted ? 'warn' : '', 'submitted'),
        tile(s.confirmed + s.paymentPending, 'Zahlung ausstehend', s.paymentPending + s.confirmed ? 'warn' : '', 'payment_pending'), tile(s.paid, 'Bezahlt', 'ok', 'paid')),
      h('div', { class: 'fin-balance neg' }, h('div', { class: 'fb-l' }, 'Noch zu zahlen (eingereichte, nicht bezahlte Abrechnungen)'), h('div', { class: 'fb-v' }, fmtC(s.openCents))),
      card('Aktuelle Abrechnungen', table([
        { label: 'Firma', render: (x) => h('b', null, x.company) }, { label: 'Zeitraum', render: (x) => x.period },
        { label: 'Betrag', render: (x) => fmtC(x.amountCents) }, { label: 'Status', render: (x) => h('span', { class: 'badge', style: { '--c': x.statusColor } }, x.statusLabel) },
      ], s.recent, { onRowClick: (x) => openStatement(x.id), empty: empty('Noch keine Abrechnungen', 'Sobald eine Firma ihren Betrag übermittelt, erscheint sie hier.', 'dollar') }), { icon: 'dollar', flush: true })));
  }

  // ── Abrechnungen ──
  async function statements() {
    const p = new URLSearchParams(); if (f.stStatus) p.set('status', f.stStatus);
    const { statements: rows } = await api.get(`/api/tab/statements?${p}`);
    if (!ctx.isCurrent() || tab !== 'statements') return;
    const chips = h('div', { class: 'count-chips' }, h('span', { class: 'chip-label' }, 'Status'), [['', 'Alle', '#94a3b8'], ...opts.statuses.map((s) => [s.key, s.label, s.color])].map(([k, label, color]) => {
      const b = h('button', { class: `cchip ${f.stStatus === k ? 'on' : ''}`, type: 'button', style: { '--c': color } }, h('span', { class: 'dot' }), label);
      b.addEventListener('click', () => { f.stStatus = k; show('statements', true); });
      return b;
    }));
    mount(host, chips, table([
      { label: 'Nr.', style: { width: '1%' }, render: (s) => memberNo(s.number) }, { label: 'Firma', render: (s) => h('b', null, s.company.name) }, { label: 'Zeitraum', render: (s) => s.period?.label },
      { label: 'Konto', render: (s) => h('span', { class: 'mono' }, s.company.accountNumber) }, { label: 'Betrag', render: (s) => h('b', null, fmtC(s.amountCents)) },
      { label: 'Status', render: statusBadge }, { label: 'Eingegangen', render: (s) => fmtDateTime(s.submittedAt) },
    ], rows, { onRowClick: (s) => openStatement(s.id), empty: empty('Keine Abrechnungen', 'Firmen reichen ihre Abrechnungen über den persönlichen Portal-Link ein.', 'dollar') }));
  }

  async function openStatement(id) {
    const body = h('div', null, skeletons(3, 70));
    let off;
    const m = openModal({ title: 'Abrechnung', wide: true, body, footer: null, onClose: () => off?.() });
    const footer = h('div', { class: 'modal-foot' }); m.el.append(footer);
    let dtab = 'info';
    async function reload() {
      let d;
      try { d = await api.get(`/api/tab/statements/${id}`); } catch (e) { mount(body, note(e.message, 'alert')); mount(footer, h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() })); return; }
      const s = d.statement, manage = d.canManage;
      m.el.querySelector('.modal-head h3').textContent = `${s.number} · ${s.company.name} · ${s.period?.label}`;
      const pay = h('div', { class: 'fin-balance neg' }, h('div', { class: 'fb-l' }, `${s.status === 'paid' ? 'Bezahlt' : 'Zu zahlen'} auf Konto ${s.company.accountNumber}`), h('div', { class: 'fb-v' }, fmtC(s.amountCents)));
      const info = h('div', { class: 'stack-v' }, h('div', { class: 'chips' }, statusBadge(s), s.payMethod && badge(s.payMethod === 'transfer' ? 'Überweisung' : 'Rechnung der Firma', 'b-info', false)), pay,
        s.approvedCents != null && s.approvedCents !== s.submittedCents && note(`Eingereicht wurden ${fmtC(s.submittedCents)}, freigegeben ${fmtC(s.approvedCents)}.`, 'alert'),
        s.comment && note(`Kommentar der Firma: ${s.comment}`, 'chat'), s.diffNote && note(`Notiz: ${s.diffNote}`, 'alert'), s.rejectReason && note(`Abgelehnt: ${s.rejectReason}`, 'x'),
        h('dl', { class: 'details-dl' },
          h('dt', null, 'Firma'), h('dd', null, `${s.company.name} (${s.company.number})`), h('dt', null, 'Firmensitz'), h('dd', null, s.company.seat || '–'), h('dt', null, 'Kontonummer'), h('dd', { class: 'mono' }, s.company.accountNumber),
          h('dt', null, 'Zeitraum'), h('dd', null, `${s.period?.label} (${fmtDate(s.period?.from)} – ${fmtDate(s.period?.to)})`), h('dt', null, 'Eingereicht am'), h('dd', null, fmtDateTime(s.submittedAt)),
          s.reviewer && [h('dt', null, 'Bearbeitet von'), h('dd', null, s.reviewer)], s.paidAt && [h('dt', null, 'Bezahlt am'), h('dd', null, fmtDate(s.paidAt))], s.payReference && [h('dt', null, 'Transaktion'), h('dd', { class: 'mono' }, s.payReference)]),
        s.payMethod === 'invoice' || s.invoice.received ? invoiceBox(s, manage) : null);
      const logTab = h('div', null, d.log.length ? d.log.map((l) => h('div', { class: 'list-row' }, h('div', { class: 'dot-icon' }, icon('activity')), h('div', { class: 'grow' }, h('div', { class: 't', style: { whiteSpace: 'normal' } }, l.text), h('div', { class: 's' }, `${l.actor} · ${fmtDateTime(l.ts)}`)))) : empty('Noch kein Verlauf', null, 'activity'));
      const panes = { info, log: logTab };
      const content = h('div'); mount(content, panes[dtab]);
      const tbar = tabs([{ id: 'info', label: 'Übersicht' }, { id: 'log', label: 'Verlauf', count: d.log.length }], dtab, (x) => { dtab = x; mount(content, panes[x]); });
      tbar.style.marginBottom = '16px';
      mount(body, tbar, content);
      mount(footer, manage && actions(s, reload), d.canDelete && button('Löschen', { variant: 'danger', icon: 'trash', onClick: () => deleteStatement(s, m) }), h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
    }
    const actions = (s, after) => {
      const run = (action, payload = {}, msg) => async () => { try { await api.post(`/api/tab/statements/${s.id}/${action}`, payload); if (msg) toast(msg); await after(); show(tab, true); } catch (ex) { toast(ex.message, 'err'); } };
      const out = [];
      if (s.status === 'submitted') out.push(button('Prüfung starten', { variant: 'info', icon: 'search', onClick: run('review', {}, 'In Prüfung.') }));
      if (['submitted', 'review'].includes(s.status)) out.push(button('Bestätigen', { variant: 'ok', icon: 'check', onClick: () => confirmDialogFor(s, after) }));
      if (s.status === 'confirmed') out.push(button('Zahlung per Überweisung', { variant: 'primary', icon: 'dollar', onClick: run('prepare', { method: 'transfer' }, 'Zahlung vorbereitet.') }), button('Rechnung der Firma', { variant: 'primary', icon: 'audit', onClick: run('prepare', { method: 'invoice' }, 'Zahlung vorbereitet.') }));
      if (s.status === 'payment_pending') out.push(s.payMethod === 'transfer' ? button('Überweisung dokumentieren', { variant: 'ok', icon: 'check', onClick: () => payDialog(s, after) }) : button('Als bezahlt markieren', { variant: 'ok', icon: 'check', onClick: run('pay', {}, 'Als bezahlt markiert.') }));
      if (['submitted', 'review', 'confirmed', 'payment_pending'].includes(s.status)) out.push(button('Ablehnen', { variant: 'danger', icon: 'x', onClick: () => rejectDialog(s, after) }));
      return out;
    };
    await reload();
    off = ctx.live(['tab'], reload, { wait: 150 });
  }
  async function deleteStatement(s, m) {
    if (!await confirmDialog({ title: 'Abrechnung endgültig löschen?', message: `${s.number} · ${s.company.name} · ${s.period?.label} (${fmtC(s.amountCents)}) wird samt Verlauf und Finanz-Eintrag entfernt. Das lässt sich nicht rückgängig machen.`, confirmLabel: 'Endgültig löschen', danger: true })) return;
    try { await api.del(`/api/tab/statements/${s.id}`); m.close(); toast('Abrechnung gelöscht.'); show(tab, true); } catch (e) { toast(e.message, 'err'); }
  }
  function confirmDialogFor(s, after) {
    const err = h('div'); const diff = input({ inputmode: 'decimal', value: money(s.submittedCents) }); const reason = input({ maxLength: 300, placeholder: 'Begründung bei abweichendem Betrag' });
    const m = openModal({ title: 'Abrechnung bestätigen', body: h('div', null, err,
      note(`Bestätigt wird: ${fmtC(s.submittedCents)} auf Konto ${s.company.accountNumber} (${s.company.name}).`, 'check'), h('div', { style: { height: '10px' } }),
      field('Freigegebener Betrag', diff, { help: 'Normalerweise der eingereichte Betrag. Bei einem anderen Betrag ist eine Begründung Pflicht.' }), field('Begründung', reason)),
    footer: [button('Abbrechen', { onClick: () => m.close() }), button('Bestätigen', { variant: 'ok', icon: 'check', onClick: (b) => busy(b.currentTarget, async () => {
      const c = parseMoney(diff.value); if (c == null) return err.replaceChildren(formError('Ungültiger Betrag.'));
      try { await api.post(`/api/tab/statements/${s.id}/confirm`, c === s.submittedCents ? {} : { approvedCents: c, note: reason.value }); m.close(); toast('Bestätigt – bitte Zahlung abwickeln.'); await after(); show(tab, true); }
      catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) })] });
  }
  function rejectDialog(s, after) {
    const err = h('div'); const reason = input({ maxLength: 300, placeholder: 'Grund (sieht die Firma)' });
    const m = openModal({ title: 'Abrechnung ablehnen', body: h('div', null, err, note('Die Firma sieht den Grund und kann den Zeitraum erneut einreichen.', 'info'), h('div', { style: { height: '10px' } }), field('Grund', reason)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Ablehnen', { variant: 'danger', icon: 'x', onClick: (b) => busy(b.currentTarget, async () => {
        try { await api.post(`/api/tab/statements/${s.id}/reject`, { reason: reason.value }); m.close(); toast('Abgelehnt.'); await after(); show(tab, true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
  }
  function payDialog(s, after) {
    const err = h('div'); const date = input({ type: 'date', value: new Date().toISOString().slice(0, 10) }); const ref = input({ maxLength: 80, placeholder: 'Transaktions-/Buchungsnummer (optional)' });
    const m = openModal({ title: 'Überweisung dokumentieren', body: h('div', null, err, note(`${fmtC(s.approvedCents)} auf Konto ${s.company.accountNumber} (${s.company.name}).`, 'dollar'), h('div', { style: { height: '10px' } }), h('div', { class: 'form-row' }, field('Zahlungsdatum', date), field('Referenz', ref))),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Als bezahlt markieren', { variant: 'ok', icon: 'check', onClick: (b) => busy(b.currentTarget, async () => {
        try { await api.post(`/api/tab/statements/${s.id}/pay`, { paidAt: date.value, reference: ref.value }); m.close(); toast('Bezahlt.'); await after(); show(tab, true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
  }
  function invoiceBox(s, manage) {
    const editable = manage && ['confirmed', 'payment_pending'].includes(s.status);
    const recv = h('input', { type: 'checkbox', checked: s.invoice.received, disabled: !editable }); const num = input({ value: s.invoice.number, disabled: !editable, maxLength: 60 });
    const amt = input({ inputmode: 'decimal', value: s.invoice.amountCents != null ? money(s.invoice.amountCents) : '', disabled: !editable }); const date = input({ type: 'date', value: s.invoice.date ?? '', disabled: !editable });
    const file = h('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg', hidden: true });
    file.addEventListener('change', async () => {
      const fl = file.files[0]; if (!fl) return;
      if (fl.size > 5 * 1024 * 1024) return toast('Die Datei ist zu groß (max. 5 MB).', 'err');
      const data = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(fl); });
      try { await api.post(`/api/tab/statements/${s.id}/invoice-file`, { data }); toast('Rechnungsdatei gespeichert.'); } catch (ex) { toast(ex.message, 'err'); }
    });
    return h('div', { class: 'card', style: { padding: '16px' } }, h('div', { class: 'sub-title' }, 'Rechnung der Firma'),
      h('label', { class: 'check', style: { padding: 0, marginBottom: '8px' } }, recv, h('span', { class: 'check-text' }, 'Rechnung erhalten')),
      h('div', { class: 'form-row' }, field('Rechnungsnummer', num), field('Rechnungsbetrag', amt, { help: s.approvedCents != null ? `Freigegeben: ${fmtC(s.approvedCents)}` : '' })), field('Rechnungsdatum', date),
      h('div', { class: 'row' }, s.invoice.hasFile && h('a', { class: 'btn btn-sm', href: `/api/tab/statements/${s.id}/invoice-file`, target: '_blank', rel: 'noopener' }, icon('download'), 'Datei öffnen'),
        editable && file, editable && button('PDF/Bild hochladen', { size: 'sm', icon: 'download', onClick: () => file.click() }),
        editable && button('Rechnungsdaten speichern', { size: 'sm', variant: 'primary', icon: 'check', onClick: async () => {
          try { await api.post(`/api/tab/statements/${s.id}/invoice`, { received: recv.checked, number: num.value, amountCents: parseMoney(amt.value), date: date.value }); toast('Gespeichert.'); } catch (ex) { toast(ex.message, 'err'); }
        } })));
  }

  // ── Firmen ──
  async function companies() {
    const { companies: rows } = await api.get('/api/tab/companies');
    if (!ctx.isCurrent() || tab !== 'companies') return;
    mount(host, table([
      { label: 'Firma', render: (c) => h('div', null, h('b', null, c.name), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${c.number}${c.contactName ? ' · ' + c.contactName : ''}`)) },
      { label: 'Firmensitz', render: (c) => c.seat || '–' }, { label: 'Kontonummer', render: (c) => h('span', { class: 'mono' }, c.accountNumber || '–') },
      { label: 'Intervall', render: (c) => c.intervalLabel }, { label: 'Offen', render: (c) => h('b', null, fmtC(c.openCents)) }, { label: 'Bezahlt', render: (c) => fmtC(c.paidCents) },
      { label: 'Status', render: (c) => (c.status === 'active' ? badge('Aktiv', 'b-ok') : badge('Deaktiviert', 'b-mute')) },
      opts.canCompanies && { label: 'Portal-Link', render: (c) => c.linkPath && button('Kopieren', { size: 'sm', icon: 'link', onClick: (e) => { e.stopPropagation(); copyText(fullLink(c.linkPath)); } }) },
    ].filter(Boolean), rows, { onRowClick: (c) => companyDetail(c.id), empty: empty('Noch keine Firmen', opts.canCompanies ? 'Lege die erste Firma an – sie bekommt automatisch einen eigenen Portal-Link.' : null, 'dollar') }));
  }
  async function companyDetail(id) {
    const body = h('div', null, skeletons(3, 70)); let off;
    const m = openModal({ title: 'Firma', wide: true, body, footer: null, onClose: () => off?.() });
    const footer = h('div', { class: 'modal-foot' }); m.el.append(footer);
    async function reload() {
      let d; try { d = await api.get(`/api/tab/companies/${id}`); } catch (e) { mount(body, note(e.message, 'alert')); mount(footer, h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() })); return; }
      const c = d.company;
      m.el.querySelector('.modal-head h3').textContent = `${c.name} · ${c.number}`;
      const link = c.linkPath ? fullLink(c.linkPath) : null;
      mount(body, h('div', { class: 'stack-v' }, h('div', { class: 'chips' }, c.status === 'active' ? badge('Aktiv', 'b-ok') : badge('Deaktiviert', 'b-mute'), badge(c.intervalLabel, 'b-info', false)),
        h('div', { class: 'tile-row' }, h('div', { class: 'tile t-warn' }, h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, fmtC(c.openCents)), h('div', { class: 'tile-label' }, 'Aktuell offen'))), h('div', { class: 'tile' }, h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, fmtC(c.paidCents)), h('div', { class: 'tile-label' }, 'Bisher bezahlt')))),
        h('dl', { class: 'details-dl' }, h('dt', null, 'Firmensitz'), h('dd', null, c.seat || '–'), h('dt', null, 'Kontonummer'), h('dd', { class: 'mono' }, c.accountNumber || '–'), h('dt', null, 'Ansprechpartner'), h('dd', null, c.contactName || '–'), h('dt', null, 'Kontakt'), h('dd', null, c.contactInfo || '–'), c.notes && [h('dt', null, 'Notizen'), h('dd', null, c.notes)]),
        link && h('div', { class: 'link-box' }, h('code', null, link), button('Kopieren', { size: 'sm', icon: 'link', onClick: () => copyText(link) }), opts.canCompanies && button('Neuen Link erzeugen', { size: 'sm', variant: 'ghost', icon: 'refresh', onClick: async () => {
          if (!await confirmDialog({ title: 'Neuen Portal-Link erzeugen?', message: 'Der bisherige Link funktioniert danach nicht mehr.', confirmLabel: 'Neuen Link erzeugen' })) return;
          try { await api.post(`/api/tab/companies/${id}/reset-link`); toast('Neuer Link erzeugt.'); reload(); } catch (e) { toast(e.message, 'err'); } } })),
        h('div', { class: 'sub-title' }, 'Abrechnungen'),
        table([{ label: 'Zeitraum', render: (s) => s.period?.label }, { label: 'Betrag', render: (s) => fmtC(s.amountCents) }, { label: 'Status', render: statusBadge }, { label: 'Datum', render: (s) => fmtDate(s.submittedAt) }],
          d.statements, { onRowClick: (s) => openStatement(s.id), empty: empty('Noch keine Abrechnungen', null, 'dollar') })));
      mount(footer, opts.canCompanies && button('Bearbeiten', { icon: 'edit', onClick: () => { m.close(); companyEditor(c); } }),
        (opts.canCompanies || opts.canDelete) && button('Löschen', { variant: 'danger', icon: 'trash', onClick: () => deleteCompany(c, m) }), h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
    }
    await reload(); off = ctx.live(['tab'], reload, { wait: 150 });
  }
  async function deleteCompany(c, m) {
    const n = c.statementCount;
    if (!await confirmDialog({ title: 'Firma endgültig löschen?', message: `${c.name} (${c.number}) wird gelöscht${n ? ` – samt ${n} Abrechnung(en), Verlauf und Finanz-Einträgen` : ''}. Der Portal-Link funktioniert danach nicht mehr. Das lässt sich nicht rückgängig machen.`, confirmLabel: 'Endgültig löschen', danger: true })) return;
    try { await api.del(`/api/tab/companies/${c.id}`); m.close(); toast('Firma gelöscht.'); show(tab, true); } catch (e) { toast(e.message, 'err'); }
  }
  function companyEditor(c) {
    const err = h('div');
    const name = input({ value: c?.name ?? '', maxLength: 80, placeholder: 'z. B. Muster GmbH' });
    const seat = input({ value: c?.seat ?? '', maxLength: 120, placeholder: 'z. B. PC1234 Test Drive' });
    const account = input({ value: c?.accountNumber ?? '', maxLength: 20, placeholder: 'z. B. LS28180705', autocomplete: 'off', style: { textTransform: 'uppercase' } });
    account.addEventListener('input', () => { account.value = account.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    const cn = input({ value: c?.contactName ?? '', maxLength: 80 }); const ci = input({ value: c?.contactInfo ?? '', maxLength: 300, placeholder: 'UMail, Telefon …' });
    const interval = select([{ value: 'weekly', label: 'Wöchentlich' }, { value: 'monthly', label: 'Monatlich' }], c?.interval ?? 'monthly');
    const status = c && select([{ value: 'active', label: 'Aktiv' }, { value: 'disabled', label: 'Deaktiviert' }], c.status); const notes = h('textarea', { class: 'textarea', maxLength: 1000 }, c?.notes ?? '');
    const m = openModal({ title: c ? `Firma bearbeiten: ${c.name}` : 'Neue Firma', wide: true, body: h('div', null, err,
      h('div', { class: 'form-row' }, field('Firmenname', name), field('Firmensitz', seat)),
      h('div', { class: 'form-row' }, field('Kontonummer der Firma', account, { help: 'Erscheint bei jeder Abrechnung – wir sehen, auf welches Konto wie viel gezahlt wird.' }), field('Abrechnungsintervall', interval, { help: c ? 'Nach der ersten Abrechnung nicht mehr änderbar.' : 'Wochen- oder monatsweise.' })),
      h('div', { class: 'form-row' }, field('Ansprechpartner', cn), field('Kontakt', ci)), c && field('Status', status), field('Notizen', notes),
      !c && note('Nach dem Anlegen wird automatisch ein individueller Portal-Link für die Firma erzeugt.', 'link')),
    footer: [button('Abbrechen', { onClick: () => m.close() }), button(c ? 'Speichern' : 'Anlegen', { variant: 'primary', icon: 'check', onClick: (b) => busy(b.currentTarget, async () => {
      err.replaceChildren();
      const payload = { name: name.value, seat: seat.value, accountNumber: account.value, contactName: cn.value, contactInfo: ci.value, interval: interval.value, notes: notes.value };
      if (status) payload.status = status.value;
      try {
        const res = c ? await api.patch(`/api/tab/companies/${c.id}`, payload) : await api.post('/api/tab/companies', payload);
        m.close(); toast(c ? 'Gespeichert.' : 'Firma angelegt – Portal-Link erzeugt.'); await show('companies', true);
        if (!c) companyDetail(res.company.id);
      } catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) })] });
  }

  // Benachrichtigung „Neue Deckel-Abrechnung“ → direkt öffnen
  const openFromTarget = () => { const id = Number(sessionStorage.getItem('mdt:tab:open')); if (id) { sessionStorage.removeItem('mdt:tab:open'); openStatement(id); } };
  window.addEventListener('mdt:tab-open', openFromTarget);

  ctx.live(['tab'], () => show(tab, true), { wait: 200 });
  await show(tab);
  openFromTarget();
  return () => window.removeEventListener('mdt:tab-open', openFromTarget);
}
