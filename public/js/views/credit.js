import { h, mount, fmtDate, fmtDateTime, debounce, timeAgo } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, card, field, input, select, table, tabs, formError, openModal, confirmDialog, toast, skeletons, empty, note, badge, levelBadge } from '../ui/kit.js';
import { api } from '../api.js';
import { can } from '../state.js';
import { parseMoney } from './tab.js';
import { calcLoan } from '../credit-calc.js';
import { fmtC, FREQ, loanBadge, termsBox, scheduleTable, timeline, dueIn } from './credit-shared.js';

const centsToInput = (c) => (c / 100).toFixed(2).replace('.', ',');

/** Kredit-App der Mitarbeiter: Anfragen verhandeln, Zinsen festlegen, auszahlen, Raten erfassen. */
export default async function render(container, ctx) {
  let opts = await api.get('/api/credit/options');
  let tab = 'overview';
  const f = { group: 'staff', q: '' };
  const tabHost = h('div', { style: { marginBottom: '16px' } });
  const host = h('div');
  mount(container, tabHost, host);

  async function show(t, silent = false) {
    tab = t;
    ctx.setActions('');
    if (!silent) mount(host, skeletons(3, 90));
    try { opts = await api.get('/api/credit/options'); } catch { /* alt */ }
    let sum = null;
    try { sum = (await api.get('/api/credit/summary')).summary; } catch { /* egal */ }
    mount(tabHost, tabs([{ id: 'overview', label: 'Übersicht' }, { id: 'loans', label: 'Kredite', count: sum?.awaitingStaff || undefined }, { id: 'borrowers', label: 'Kreditnehmer' }], tab, (x) => show(x)));
    ctx.refreshCounters?.();
    try { await ({ overview: () => overview(sum), loans, borrowers })[tab](); } catch (e) { mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
  }

  const tile = (v, label, tone, onClick) => { const el = h('div', { class: `tile ${tone ? 't-' + tone : ''} ${onClick ? 'clickable' : ''}` }, h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, v), h('div', { class: 'tile-label' }, label))); if (onClick) el.addEventListener('click', onClick); return el; };

  // ── Übersicht ──
  async function overview(s) {
    if (!ctx.isCurrent() || tab !== 'overview') return;
    const go = (group) => () => { f.group = group; show('loans'); };
    const dueRow = (x, cls) => h('div', { class: 'list-row', style: { padding: '9px 0', cursor: 'pointer' }, onclick: () => openLoan(x.loanId) }, h('div', { class: 'grow' }, h('div', { class: 't' }, `${x.partner} · ${x.loan}`), h('div', { class: 's' }, `Rate ${x.seq} · fällig ${fmtDate(x.dueDate)} (${dueIn(x.dueDate)})`)), h('b', { class: cls }, fmtC(x.amountCents)));
    mount(host, h('div', { class: 'stack-v' },
      h('div', { class: 'tile-row' }, tile(s.awaitingStaff, 'Anfragen – wir sind am Zug', s.awaitingStaff ? 'warn' : '', go('staff')), tile(s.toDisburse, 'Auszahlung offen', s.toDisburse ? 'warn' : '', go('running')), tile(s.active, 'Laufende Kredite', 'info', go('running')),
        tile(s.overdueCount, 'Überfällige Raten', s.overdueCount ? 'err' : '', go('overdue')), tile(s.completed, 'Abbezahlt', 'ok', go('done'))),
      h('div', { class: 'tile-row' }, tile(fmtC(s.outstandingCents), 'Offene Kreditsumme (Tilgung)', 'info'), tile(fmtC(s.expectedInterestCents), 'Erwartete Zinsen'), tile(fmtC(s.receivedCents), 'Bisher zurückgezahlt', 'ok'), tile(fmtC(s.overdueCents), 'Überfällig gesamt', s.overdueCents ? 'err' : '')),
      s.overdue.length > 0 && card('Überfällige Raten', h('div', null, s.overdue.map((x) => dueRow(x, 'due-over'))), { icon: 'alert', flush: false }),
      card('Nächste Fälligkeiten', s.upcoming.length ? h('div', null, s.upcoming.map((x) => dueRow(x))) : empty('Keine anstehenden Raten', null, 'dollar'), { icon: 'hourglass' })));
  }

  // ── Kredite ──
  async function loans() {
    const p = new URLSearchParams();
    if (f.group && f.group !== 'all') p.set('group', f.group);
    if (f.q) p.set('q', f.q);
    const { loans: rows } = await api.get(`/api/credit/loans?${p}`);
    if (!ctx.isCurrent() || tab !== 'loans') return;
    const had = host.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    const search = input({ placeholder: 'Nummer, Kreditnehmer …', value: f.q });
    search.addEventListener('input', debounce(() => { f.q = search.value.trim(); show('loans', true); }));
    const groups = h('div', { class: 'tabs' }, [['staff', 'Wir sind am Zug'], ['open', 'In Verhandlung'], ['running', 'Laufend'], ['overdue', 'Überfällig'], ['done', 'Beendet'], ['all', 'Alle']].map(([id, label]) => {
      const b = h('button', { class: `tab ${f.group === id ? 'active' : ''}`, type: 'button' }, label); b.addEventListener('click', () => { f.group = id; show('loans', true); }); return b;
    }));
    mount(host, h('div', { class: 'toolbar' }, groups, h('div', { class: 'grow' }), h('div', { class: 'input-icon' }, icon('search'), search)),
      table([
        { label: 'Nr.', style: { width: '1%' }, render: (l) => h('span', { class: 'member-no' }, l.number) },
        { label: 'Kreditnehmer', render: (l) => h('div', null, h('b', null, l.partner.number), ' ', levelBadge(l.partner.level), h('div', { class: 'muted', style: { fontSize: '12px' } }, l.partner.name)) },
        { label: 'Summe', render: (l) => h('b', null, fmtC(l.principalCents)) }, { label: 'Raten', render: (l) => `${l.termCount} × ${FREQ[l.frequency]}` },
        { label: 'Zinsen', render: (l) => (l.interest.set ? `${l.interest.text} (${fmtC(l.interestCents)})` : h('span', { class: 'muted' }, 'offen')) },
        { label: 'Status', render: (l) => h('div', { class: 'chips' }, loanBadge(l), l.status === 'requested' || l.status === 'negotiating' ? h('span', { class: `badge no-dot ${l.turn === 'staff' ? 'b-warn' : 'b-mute'}` }, l.turn === 'staff' ? 'Wir sind am Zug' : 'Kreditnehmer am Zug') : null, l.overdueCount > 0 && h('span', { class: 'badge b-err' }, `${l.overdueCount} überfällig`)) },
        { label: 'Nächste Rate', render: (l) => (l.nextDue ? h('div', null, fmtDate(l.nextDue.date), h('div', { class: l.nextDue.overdue ? 'due-over' : 'muted', style: { fontSize: '11.5px' } }, fmtC(l.nextDue.amountCents))) : h('span', { class: 'muted' }, '–')) },
        { label: 'Aktualisiert', render: (l) => h('span', { class: 'muted' }, timeAgo(l.updatedAt)) },
      ], rows, { onRowClick: (l) => openLoan(l.id), empty: empty('Keine Kredite', 'Kreditnehmer stellen ihre Anfragen über den Partner-Zugang mit der App „Kredit“.', 'dollar') }));
    if (had) { const i = host.querySelector('input'); i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); }
  }

  // ── Kreditnehmer ──
  async function borrowers() {
    const { borrowers: rows } = await api.get('/api/credit/borrowers');
    if (!ctx.isCurrent() || tab !== 'borrowers') return;
    mount(host, note('Kreditnehmer sind externe Zugänge, denen unter „Externe Zugänge“ die App „Kredit“ freigeschaltet wurde. Der Kreditrahmen begrenzt die gleichzeitig offene Kreditsumme.', 'link'), h('div', { style: { height: '12px' } }),
      table([
        { label: 'Kreditnehmer', render: (b) => h('div', null, h('b', null, b.number), h('div', { class: 'muted', style: { fontSize: '12px' } }, b.name)) },
        { label: 'Laufende', render: (b) => b.activeLoans }, { label: 'Abbezahlt', render: (b) => b.completedLoans }, { label: 'Ausfälle', render: (b) => (b.defaulted ? h('span', { class: 'due-over' }, b.defaulted) : 0) },
        { label: 'Aktuell offen', render: (b) => fmtC(b.outstandingCents) }, { label: 'Kreditrahmen', render: (b) => (b.limitCents != null ? h('b', null, fmtC(b.limitCents)) : h('span', { class: 'muted' }, 'kein Limit')) },
        { label: 'Status', render: (b) => (b.active ? badge('Aktiv', 'b-ok') : badge('Zugang deaktiviert', 'b-mute')) },
        opts.canLimits && { label: '', render: (b) => button('Rahmen', { size: 'sm', icon: 'edit', onClick: (e) => { e.stopPropagation(); limitDialog(b); } }) },
      ].filter(Boolean), rows, { empty: empty('Noch keine Kreditnehmer', 'Schalte einem externen Zugang die App „Kredit“ frei.', 'dollar') }));
  }
  function limitDialog(b) {
    const err = h('div'); const lim = input({ inputmode: 'decimal', value: b.limitCents != null ? centsToInput(b.limitCents) : '', placeholder: 'leer = kein Limit' });
    const m = openModal({ title: `Kreditrahmen: ${b.number}`, body: h('div', null, err, field('Maximal gleichzeitig offene Kreditsumme', lim, { help: `Aktuell offen: ${fmtC(b.outstandingCents)}` })),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Speichern', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        const v = lim.value.trim() === '' ? null : parseMoney(lim.value); if (lim.value.trim() !== '' && !v) return err.replaceChildren(formError('Ungültiger Betrag.'));
        try { await api.patch(`/api/credit/borrowers/${b.id}`, { limitCents: v }); m.close(); toast('Gespeichert.'); show('borrowers', true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
  }

  // ── Kredit-Dialog ──
  async function openLoan(id) {
    const body = h('div', null, skeletons(3, 80)); let off;
    const m = openModal({ title: 'Kredit', wide: true, body, footer: null, onClose: () => off?.() });
    const footer = h('div', { class: 'modal-foot' }); m.el.append(footer);
    const msg = h('textarea', { class: 'textarea', maxLength: 1000, placeholder: 'Nachricht an den Kreditnehmer …' }); const internal = h('input', { type: 'checkbox' });
    async function reload() {
      let d; try { d = await api.get(`/api/credit/loans/${id}`); } catch (e) { mount(body, note(e.message, 'alert')); return; }
      const l = d.loan;
      m.el.querySelector('.modal-head h3').textContent = `${l.number} · ${l.partner.number}`;
      const myTurn = ['requested', 'negotiating'].includes(l.status) && l.turn === 'staff';
      const act = async (action, payload = {}, ok) => { try { await api.post(`/api/credit/loans/${id}/${action}`, payload); if (ok) toast(ok); await reload(); show(tab, true); } catch (ex) { toast(ex.message, 'err'); } };
      const sched = l.installments?.length ? scheduleTable(l.installments, (i) => opts.canPayments && l.status === 'active' && button('Zahlung erfassen', { size: 'sm', variant: i.reportedAt ? 'ok' : '', icon: 'check', onClick: () => paymentDialog(l, i, reload) })) : null;
      mount(body,
        h('div', { class: 'chips', style: { marginBottom: '12px' } }, loanBadge(l), myTurn && h('span', { class: 'badge no-dot b-warn' }, 'Wir sind am Zug'), l.overdueCount > 0 && h('span', { class: 'badge b-err' }, `${l.overdueCount} Rate(n) überfällig`), h('span', { class: 'muted' }, `${l.partner.number} · ${l.partner.name}`)),
        termsBox(l), l.note && h('div', { style: { margin: '12px 0' } }, note(`Verwendungszweck: ${l.note}`, 'chat')),
        l.status === 'completed' && h('div', { style: { margin: '12px 0' } }, note(`Abbezahlt – insgesamt ${fmtC(l.paidCents)} zurückgezahlt.`, 'check')),
        l.status === 'accepted' && h('div', { style: { margin: '12px 0' } }, note('Der Kredit ist angenommen. Bestätige die Auszahlung, um den Tilgungsplan zu erzeugen.', 'alert')),
        sched && h('div', { style: { margin: '16px 0 4px' } }, h('div', { class: 'sub-title' }, `Tilgungsplan · ${l.installmentsPaid}/${l.termCount} bezahlt · offen ${fmtC(l.remainingCents)}`), sched),
        h('div', { class: 'sep' }), h('div', { class: 'sub-title' }, 'Verlauf'), timeline(d.events),
        opts.canManage && !['completed', 'rejected', 'withdrawn', 'cancelled', 'defaulted'].includes(l.status) && h('div', { class: 'composer' }, msg, h('div', { class: 'row' }, h('label', { class: 'check', style: { padding: 0 } }, internal, h('span', { class: 'check-text' }, 'Interne Notiz')), h('span', { class: 'grow' }),
          button('Senden', { size: 'sm', icon: 'check', onClick: async () => { if (!msg.value.trim()) return; await act('message', { text: msg.value.trim(), internal: internal.checked }); msg.value = ''; } }))));
      const bar = [];
      if (opts.canManage && myTurn) bar.push(button(l.interest.set ? 'Annehmen' : 'Annehmen (zinsfrei)', { variant: 'ok', icon: 'check', onClick: () => acceptDialog(l, reload) }), button('Gegenvorschlag / Zinsen', { variant: 'info', icon: 'refresh', onClick: () => counterDialog(l, reload) }), button('Ablehnen', { variant: 'danger', icon: 'x', onClick: () => confirmDialog({ title: 'Anfrage ablehnen?', message: 'Der Kreditnehmer sieht die Ablehnung.', confirmLabel: 'Ablehnen', withReason: true }).then((r) => r && act('reject', { text: r.reason })) }));
      if (opts.canManage && ['requested', 'negotiating'].includes(l.status) && !myTurn) bar.push(button('Ablehnen', { variant: 'danger', icon: 'x', onClick: () => confirmDialog({ title: 'Anfrage ablehnen?', message: 'Der Kreditnehmer sieht die Ablehnung.', confirmLabel: 'Ablehnen', withReason: true }).then((r) => r && act('reject', { text: r.reason })) }));
      if (opts.canManage && l.status === 'accepted') bar.push(button('Auszahlung bestätigen', { variant: 'primary', icon: 'dollar', onClick: () => disburseDialog(l, reload) }), button('Stornieren', { variant: 'danger', icon: 'x', onClick: () => confirmDialog({ title: 'Kredit stornieren?', message: 'Es wurde noch nichts ausgezahlt.', confirmLabel: 'Stornieren', withReason: true }).then((r) => r && act('cancel', { text: r.reason })) }));
      if (opts.canPayments && l.status === 'active') bar.push(button('Ausfall melden', { variant: 'danger', icon: 'alert', onClick: () => confirmDialog({ title: 'Kredit als ausgefallen markieren?', message: 'Offene Raten werden nicht mehr erwartet (im Finanz-Journal storniert).', confirmLabel: 'Ausfall melden', withReason: true }).then((r) => r && act('default', { text: r.reason })) }));
      if (can('credit.delete')) bar.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
        if (!await confirmDialog({ title: 'Kredit endgültig löschen?', message: `${l.number} (${l.partner.number}) wird samt Tilgungsplan, Verlauf und Finanz-Einträgen gelöscht – in jedem Status. Das lässt sich nicht rückgängig machen.`, confirmLabel: 'Endgültig löschen' })) return;
        try { await api.del(`/api/credit/loans/${id}`); m.close(); toast('Kredit gelöscht.'); show(tab, true); } catch (ex) { toast(ex.message, 'err'); }
      } }));
      mount(footer, bar, h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
    }
    await reload(); off = ctx.live(['credit', 'partners'], reload, { wait: 150 });
  }

  /** Konditionen-Formular mit Live-Berechnung – gemeinsam für Annehmen (zinsfrei) und Gegenvorschlag */
  function termsForm(l, { withInterest }) {
    const principal = input({ inputmode: 'decimal', value: centsToInput(l.principalCents) }), count = input({ type: 'number', min: 1, value: l.termCount });
    const freq = select([{ value: 'weekly', label: 'Wöchentlich' }, { value: 'monthly', label: 'Monatlich' }], l.frequency);
    const type = select([{ value: 'none', label: 'Zinsfrei' }, { value: 'flat', label: 'Zinssatz (einfach, auf die Kreditsumme)' }], l.interest.set ? l.interest.type : opts.defaults.interestType);
    const rate = input({ inputmode: 'decimal', value: l.interest.set && l.interest.type === 'flat' ? String(l.interest.rateBp / 100).replace('.', ',') : String(opts.defaults.ratePercent).replace('.', ',') });
    const period = select([{ value: 'day', label: 'pro Tag' }, { value: 'week', label: 'pro Woche' }, { value: 'month', label: 'pro Monat' }], l.interest.set ? l.interest.ratePeriod : opts.defaults.ratePeriod);
    const payTo = input({ value: l.payTo || opts.defaults.payTo, maxLength: 300, placeholder: 'Konto, Übergabeort …' });
    const text = h('textarea', { class: 'textarea', maxLength: 500, placeholder: 'Nachricht an den Kreditnehmer (optional)' });
    const prev = h('div', { class: 'terms-box' });
    const read = () => ({ principalCents: parseMoney(principal.value), termCount: Number(count.value), frequency: freq.value, interestType: type.value, ratePercent: Number(String(rate.value).replace(',', '.')), ratePeriod: period.value, payTo: payTo.value, text: text.value.trim() });
    const upd = () => {
      const v = read(); const rr = h('div', null);
      if (!v.principalCents || !(v.termCount >= 1)) return mount(prev, h('span', { class: 'muted' }, 'Bitte Summe und Laufzeit eingeben.'));
      const c = calcLoan({ principal: v.principalCents, count: v.termCount, frequency: v.frequency, type: withInterest ? v.interestType : 'none', rateBp: Math.round((v.ratePercent || 0) * 100), ratePeriod: v.ratePeriod });
      mount(prev, h('div', { class: 'tb-col' }, h('div', { class: 'tb-row' }, h('span', { class: 'k' }, 'Zinsen gesamt'), h('b', null, fmtC(c.interest))), h('div', { class: 'tb-row' }, h('span', { class: 'k' }, 'Gesamtrückzahlung'), h('b', null, fmtC(c.total)))),
        h('div', { class: 'tb-col' }, h('div', { class: 'tb-row' }, h('span', { class: 'k' }, `Rate (${FREQ[v.frequency]})`), h('b', null, fmtC(c.installment))), h('div', { class: 'tb-row' }, h('span', { class: 'k' }, 'Laufzeit'), h('span', null, `${c.days} Tage`))));
      void rr;
    };
    const rateRow = h('div', { class: 'form-row' }, field('Zinssatz in %', rate), field('Zins-Zeitraum', period));
    const sync = () => { rateRow.style.display = type.value === 'flat' ? '' : 'none'; upd(); };
    for (const el of [principal, count, freq, type, rate, period]) { el.addEventListener('input', sync); el.addEventListener('change', sync); }
    sync();
    const el = h('div', null, h('div', { class: 'form-row' }, field('Kreditsumme', principal), field('Anzahl Raten (Laufzeit)', count)), field('Ratenrhythmus', freq),
      withInterest && [field('Zinsen', type), rateRow], field('Zahlungsziel – wohin zahlt der Kreditnehmer?', payTo), prev, h('div', { style: { height: '10px' } }), field('Nachricht', text));
    return { el, read };
  }
  function counterDialog(l, after) {
    const err = h('div'); const { el, read } = termsForm(l, { withInterest: true });
    const m = openModal({ title: 'Gegenvorschlag / Zinsen festlegen', wide: true, body: h('div', null, err, note('Der Kreditnehmer sieht Zinsen, Gesamtrückzahlung, Raten und Zahlungsziel transparent und kann annehmen oder einen Gegenvorschlag zur Laufzeit/Summe machen.', 'info'), h('div', { style: { height: '12px' } }), el),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Vorschlag senden', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        const v = read(); if (!v.principalCents) return err.replaceChildren(formError('Ungültige Kreditsumme.'));
        try { await api.post(`/api/credit/loans/${l.id}/counter`, v); m.close(); toast('Vorschlag gesendet.'); await after(); show(tab, true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
  }
  function acceptDialog(l, after) {
    const err = h('div'); const payTo = input({ value: l.payTo || opts.defaults.payTo, maxLength: 300 });
    const needsPay = !l.payTo;
    const m = openModal({ title: 'Kredit annehmen', body: h('div', null, err, termsBox(l), h('div', { style: { height: '10px' } }),
      !l.interest.set && note('Die Anfrage enthält keine Zinsen – bei Annahme wird der Kredit ZINSFREI vergeben. Für Zinsen nutze „Gegenvorschlag / Zinsen“.', 'alert'), field('Zahlungsziel – wohin zahlt der Kreditnehmer?', payTo, { help: needsPay ? 'Pflicht: Konto, Übergabeort oder Anweisung.' : '' })),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Annehmen', { variant: 'ok', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        try { await api.post(`/api/credit/loans/${l.id}/accept`, { payTo: payTo.value }); m.close(); toast('Angenommen – Auszahlung bestätigen, sobald das Geld raus ist.'); await after(); show(tab, true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
  }
  function disburseDialog(l, after) {
    const err = h('div'); const date = input({ type: 'date', value: new Date().toISOString().slice(0, 10) }); const text = input({ maxLength: 200, placeholder: 'Notiz (optional)' });
    const m = openModal({ title: 'Auszahlung bestätigen', body: h('div', null, err, note(`${fmtC(l.principalCents)} an ${l.partner.number} ausgezahlt? Ab dem Auszahlungsdatum laufen die Fälligkeiten (${l.termCount} ${FREQ[l.frequency]}e Raten).`, 'dollar'), h('div', { style: { height: '10px' } }), field('Auszahlungsdatum', date), field('Notiz', text)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Auszahlung bestätigen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        try { await api.post(`/api/credit/loans/${l.id}/disburse`, { date: date.value, text: text.value }); m.close(); toast('Ausgezahlt – Tilgungsplan erstellt.'); await after(); show(tab, true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
  }
  function paymentDialog(l, i, after) {
    const err = h('div'); const rest = i.amountCents - i.paidCents; const amt = input({ inputmode: 'decimal', value: centsToInput(rest) }); const date = input({ type: 'date', value: new Date().toISOString().slice(0, 10) }); const text = input({ maxLength: 200, placeholder: 'Notiz (optional)' });
    const m = openModal({ title: `Zahlung zu Rate ${i.seq}`, body: h('div', null, err, note(`Rate ${i.seq} · fällig ${fmtDate(i.dueDate)} · offen ${fmtC(rest)}${i.reportedAt ? ' · vom Kreditnehmer als gezahlt gemeldet' : ''}.`, 'dollar'), h('div', { style: { height: '10px' } }), h('div', { class: 'form-row' }, field('Eingegangener Betrag', amt, { help: 'Teilzahlungen sind möglich.' }), field('Zahlungsdatum', date)), field('Notiz', text)),
      footer: [button('Abbrechen', { onClick: () => m.close() }), button('Zahlung erfassen', { variant: 'ok', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        const c = parseMoney(amt.value); if (!c) return err.replaceChildren(formError('Ungültiger Betrag.'));
        try { await api.post(`/api/credit/loans/${l.id}/payment`, { installmentId: i.id, amountCents: c, date: date.value, note: text.value }); m.close(); toast('Zahlung erfasst.'); await after(); show(tab, true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
  }

  const openFromTarget = () => { const id = Number(sessionStorage.getItem('mdt:credit:open')); if (id) { sessionStorage.removeItem('mdt:credit:open'); openLoan(id); } };
  window.addEventListener('mdt:credit-open', openFromTarget);
  ctx.live(['credit', 'partners'], () => show(tab, true), { wait: 200 });
  await show('overview');
  openFromTarget();
  return () => window.removeEventListener('mdt:credit-open', openFromTarget);
}
