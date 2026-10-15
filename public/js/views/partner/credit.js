import { h, mount, fmtDate, timeAgo } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, busy, card, field, input, select, tabs, formError, openModal, confirmDialog, toast, skeletons, empty, note } from '../../ui/kit.js';
import { api } from '../../api.js';
import { parseMoney } from '../tab.js';
import { calcLoan } from '../../credit-calc.js';
import { fmtC, FREQ, loanBadge, termsBox, scheduleTable, timeline, dueIn } from '../credit-shared.js';
import { partnerScope, dealChanges, markDealSeen } from '../../seen.js';

const centsToInput = (c) => (c / 100).toFixed(2).replace('.', ',');

/** Kredit aus Sicht des Kreditnehmers: anfragen, Konditionen transparent sehen, verhandeln, Raten verfolgen, Verlauf. */
export default async function render(container, ctx) {
  const scope = `${partnerScope()}:credit`;
  let cfg = await api.get('/api/p/credit/config');
  let changes = new Map();
  const host = h('div');
  mount(container, host);
  ctx.setActions(button('Kredit beantragen', { variant: 'primary', icon: 'plus', onClick: () => requestDialog() }));

  async function load(silent = false) {
    if (!silent) mount(host, skeletons(3, 110));
    let loans;
    try { [{ loans }, cfg] = await Promise.all([api.get('/api/p/credit/loans'), api.get('/api/p/credit/config')]); } catch (e) { return mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
    if (!ctx.isCurrent()) return;
    changes = dealChanges(scope, loans.map((l) => ({ id: l.id, updatedAt: l.updatedAt, status: l.status, statusLabel: l.statusLabel, direction: l.turn === 'partner' && l.interest.set ? 'sell' : 'buy' })));
    const live = loans.filter((l) => ['requested', 'negotiating', 'accepted', 'active'].includes(l.status));
    const past = loans.filter((l) => !live.includes(l));
    const due = live.filter((l) => l.nextDue).sort((a, b) => a.nextDue.date.localeCompare(b.nextDue.date))[0];
    const overdue = live.reduce((a, l) => a + l.overdueCount, 0);
    mount(host, h('div', { class: 'stack-v' },
      overdue > 0 && h('div', { class: 'cp-overdue' }, icon('alert'), h('div', null, h('b', null, `${overdue} Rate${overdue === 1 ? '' : 'n'} überfällig`), h('div', null, 'Bitte zahle so schnell wie möglich – Details im jeweiligen Kredit.'))),
      due && !due.nextDue.overdue && h('div', { class: 'cp-next' }, icon('hourglass'), h('div', null, h('div', { class: 'k' }, 'Nächste Zahlung'), h('b', null, `${fmtC(due.nextDue.amountCents)} bis ${fmtDate(due.nextDue.date)}`), h('span', { class: 'muted' }, ` · ${dueIn(due.nextDue.date)} · ${due.number}`))),
      cfg.limitCents != null && h('div', { class: 'muted', style: { fontSize: '12.5px' } }, `Kreditrahmen: ${fmtC(cfg.limitCents)} · aktuell offen ${fmtC(cfg.outstandingCents)} · verfügbar ${fmtC(cfg.availableCents)}`),
      live.length ? h('div', null, h('div', { class: 'sub-title' }, 'Aktuelle Kredite'), live.map(loanCard)) : card(null, empty('Kein laufender Kredit', 'Beantrage einen Kredit – Summe, Laufzeit und Ratenrhythmus wählst du selbst.', 'dollar')),
      past.length > 0 && h('div', null, h('div', { class: 'sub-title' }, 'Frühere Kredite'), past.map(loanCard))));
  }

  function loanCard(l) {
    const ch = changes.get(l.id);
    const mineTurn = ['requested', 'negotiating'].includes(l.status) && l.turn === 'partner';
    const el = h('article', { class: `card hoverable deal-card ${mineTurn ? 'attention' : ''} ${ch ? 'fresh' : ''}`, tabindex: 0 },
      h('div', { class: 'dc-main' }, ch && h('div', { class: 'fresh-line' }, h('span', { class: 'fresh-badge' }, mineTurn ? 'Neuer Vorschlag vom Team' : ch.kind === 'new' ? 'Neu' : ch.kind === 'status' ? `Status: ${l.statusLabel}` : 'Aktualisiert')),
        h('div', { class: 'dc-title' }, h('span', { class: 'member-no' }, l.number), ' Kredit über ', fmtC(l.principalCents)),
        h('div', { class: 'dc-sub' }, `${l.termCount} ${FREQ[l.frequency]}e Raten · ${l.interest.text}${l.interest.set ? ` · gesamt ${fmtC(l.totalCents)}` : ''} · ${timeAgo(l.updatedAt)}`),
        h('div', { class: 'chips', style: { marginTop: '8px' } }, loanBadge(l), mineTurn && h('span', { class: 'badge no-dot b-warn' }, 'Du bist am Zug'), l.overdueCount > 0 && h('span', { class: 'badge b-err' }, 'Überfällig'),
          l.nextDue && !l.nextDue.overdue && h('span', { class: 'badge no-dot b-info' }, `Nächste Rate ${fmtDate(l.nextDue.date)}`))),
      h('div', { class: 'dc-price' }, l.status === 'active' ? fmtC(l.remainingCents) : fmtC(l.interest.set ? l.totalCents : l.principalCents), l.status === 'active' && h('div', { class: 'muted', style: { fontSize: '11.5px', fontWeight: 500 } }, 'noch offen')), icon('chevronR'));
    const open = () => { markDealSeen(scope, { id: l.id, updatedAt: l.updatedAt, status: l.status }); el.classList.remove('fresh'); el.querySelector('.fresh-line')?.remove(); ctx.refreshCounters?.(); openLoan(l.id); };
    el.addEventListener('click', open); el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return el;
  }

  // ── Anfrage ──
  function requestDialog() {
    const err = h('div');
    const principal = input({ inputmode: 'decimal', placeholder: 'z. B. 5.000,00' }), count = input({ type: 'number', min: 1, value: 10 });
    const freq = select([{ value: 'weekly', label: 'Wöchentliche Rate' }, { value: 'monthly', label: 'Monatliche Rate' }], 'weekly');
    const purpose = h('textarea', { class: 'textarea', maxLength: 500, placeholder: 'Wofür brauchst du den Kredit? (optional)' });
    const prev = h('div', { class: 'terms-box' });
    const upd = () => {
      const p = parseMoney(principal.value), n = Number(count.value);
      if (!p || !(n >= 1)) return mount(prev, h('span', { class: 'muted' }, 'Gib Summe und Laufzeit ein, um eine Vorschau zu sehen.'));
      const c = calcLoan({ principal: p, count: n, frequency: freq.value });
      mount(prev, h('div', { class: 'tb-col' }, h('div', { class: 'tb-row' }, h('span', { class: 'k' }, 'Kreditsumme'), h('b', null, fmtC(p))), h('div', { class: 'tb-row' }, h('span', { class: 'k' }, 'Laufzeit'), h('span', null, `${n} ${FREQ[freq.value]}e Raten (ca. ${c.days} Tage)`))),
        h('div', { class: 'tb-col' }, h('div', { class: 'tb-row' }, h('span', { class: 'k' }, `Rate ohne Zinsen (${FREQ[freq.value]})`), h('b', null, `ca. ${fmtC(c.installment)}`)), h('div', { class: 'tb-row' }, h('span', { class: 'k' }, 'Zinsen'), h('span', null, 'legt das Team im Vorschlag fest'))));
    };
    for (const e of [principal, count, freq]) { e.addEventListener('input', upd); e.addEventListener('change', upd); }
    upd();
    const L = cfg.limits;
    const m = openModal({ title: 'Kredit beantragen', wide: true, body: h('div', null, err, note(`Du schlägst Summe, Laufzeit und Ratenrhythmus vor. Das Team nimmt an oder macht einen Gegenvorschlag und legt die Zinsen fest – du siehst vor der Annahme genau, was du insgesamt zahlst. Möglich: ${fmtC(L.min)} bis ${fmtC(L.max)}, bis zu ${L.maxTerm.weekly} Wochen bzw. ${L.maxTerm.monthly} Monate.`, 'info'),
      h('div', { style: { height: '12px' } }), h('div', { class: 'form-row' }, field('Gewünschte Kreditsumme', principal), field('Laufzeit (Anzahl Raten)', count)), field('Ratenrhythmus', freq), prev, h('div', { style: { height: '10px' } }), field('Verwendungszweck', purpose)),
    footer: [button('Abbrechen', { onClick: () => m.close() }), button('Anfrage senden', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      const p = parseMoney(principal.value); if (!p) return err.replaceChildren(formError('Bitte gib eine gültige Kreditsumme ein (z. B. 5.000,00).'));
      try { const { loan } = await api.post('/api/p/credit/requests', { principalCents: p, termCount: Number(count.value), frequency: freq.value, note: purpose.value.trim() }); markDealSeen(scope, { id: loan.id, updatedAt: loan.updatedAt, status: loan.status }); m.close(); toast('Anfrage gesendet – wir melden uns mit einem Vorschlag.'); load(true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) })] });
  }

  // ── Kredit ──
  async function openLoan(id) {
    const body = h('div', null, skeletons(3, 80)); let off;
    const m = openModal({ title: 'Kredit', wide: true, body, footer: null, onClose: () => off?.() });
    const footer = h('div', { class: 'modal-foot' }); m.el.append(footer);
    const msg = h('textarea', { class: 'textarea', maxLength: 1000, placeholder: 'Nachricht an das Team …' });
    async function reload() {
      let d; try { d = await api.get(`/api/p/credit/loans/${id}`); } catch (e) { mount(body, note(e.message, 'alert')); return; }
      const l = d.loan;
      markDealSeen(scope, { id: l.id, updatedAt: l.updatedAt, status: l.status }); // solange der Kredit geöffnet ist, gilt er als gesehen
      m.el.querySelector('.modal-head h3').textContent = `Kredit ${l.number}`;
      const myTurn = ['requested', 'negotiating'].includes(l.status) && l.turn === 'partner';
      const act = async (action, payload = {}, okMsg) => { try { await api.post(`/api/p/credit/loans/${id}/${action}`, payload); if (okMsg) toast(okMsg); await reload(); load(true); } catch (ex) { toast(ex.message, 'err'); } };
      const sched = l.installments?.length ? scheduleTable(l.installments, (i) => l.status === 'active' && !i.reportedAt && button('Als gezahlt melden', { size: 'sm', icon: 'check', onClick: () => confirmDialog({ title: 'Zahlung melden?', message: `Rate ${i.seq} über ${fmtC(i.amountCents - i.paidCents)} ist von dir bezahlt? Das Team prüft den Eingang.`, confirmLabel: 'Melden', variant: 'ok' }).then((r) => r && act('report', { installmentId: i.id }, 'Gemeldet – das Team prüft den Zahlungseingang.')) })) : null;
      mount(body,
        h('div', { class: 'chips', style: { marginBottom: '12px' } }, loanBadge(l), myTurn && h('span', { class: 'badge no-dot b-warn' }, 'Du bist am Zug'), l.overdueCount > 0 && h('span', { class: 'badge b-err' }, `${l.overdueCount} Rate(n) überfällig`)),
        myTurn && h('div', { style: { marginBottom: '12px' } }, note('Das Team hat dir einen Vorschlag gemacht. Prüfe Zinsen und Gesamtrückzahlung – dann annehmen, ablehnen oder einen Gegenvorschlag zu Summe/Laufzeit senden.', 'alert')),
        termsBox(l),
        l.status === 'accepted' && h('div', { style: { margin: '12px 0' } }, note('Angenommen! Sobald das Team die Auszahlung bestätigt, erscheint hier dein Tilgungsplan mit allen Fälligkeiten.', 'check')),
        l.status === 'completed' && h('div', { style: { margin: '12px 0' } }, note(`Abbezahlt – danke! Insgesamt zurückgezahlt: ${fmtC(l.paidCents)}.`, 'check')),
        l.status === 'defaulted' && h('div', { style: { margin: '12px 0' } }, note('Dieser Kredit wurde als ausgefallen markiert. Bitte melde dich beim Team.', 'alert')),
        l.status === 'active' && l.nextDue && h('div', { class: l.nextDue.overdue ? 'cp-overdue' : 'cp-next', style: { margin: '12px 0' } }, icon(l.nextDue.overdue ? 'alert' : 'hourglass'), h('div', null, h('div', { class: 'k' }, l.nextDue.overdue ? 'Überfällig' : 'Nächste Zahlung'), h('b', null, `${fmtC(l.nextDue.amountCents)} bis ${fmtDate(l.nextDue.date)}`), h('span', { class: 'muted' }, ` · ${dueIn(l.nextDue.date)}`), l.payTo && h('div', { class: 'muted' }, `Zahlung an: ${l.payTo}`))),
        sched && h('div', { style: { margin: '16px 0 4px' } }, h('div', { class: 'sub-title' }, `Tilgungsplan · ${l.installmentsPaid}/${l.termCount} bezahlt · noch offen ${fmtC(l.remainingCents)}`), sched),
        l.note && h('div', { style: { margin: '12px 0' } }, note(`Dein Verwendungszweck: ${l.note}`, 'chat')),
        h('div', { class: 'sep' }), h('div', { class: 'sub-title' }, 'Verlauf'), timeline(d.events),
        !['completed', 'rejected', 'withdrawn', 'cancelled', 'defaulted'].includes(l.status) && h('div', { class: 'composer' }, msg, h('div', { class: 'row' }, h('span', { class: 'grow' }), button('Senden', { size: 'sm', icon: 'check', onClick: async () => { if (!msg.value.trim()) return; await act('message', { text: msg.value.trim() }); msg.value = ''; } }))));
      const bar = [];
      if (myTurn) bar.push(button('Annehmen', { variant: 'ok', icon: 'check', onClick: () => confirmDialog({ title: 'Kredit annehmen?', message: `${fmtC(l.principalCents)} · ${l.termCount} ${FREQ[l.frequency]}e Raten à ${fmtC(l.installmentCents)} · Zinsen ${fmtC(l.interestCents)} · du zahlst insgesamt ${fmtC(l.totalCents)}.`, confirmLabel: 'Verbindlich annehmen', variant: 'ok' }).then((r) => r && act('accept', {}, 'Angenommen.')) }),
        button('Gegenvorschlag', { variant: 'info', icon: 'refresh', onClick: () => counterDialog(l, reload) }), button('Ablehnen', { variant: 'danger', icon: 'x', onClick: () => confirmDialog({ title: 'Vorschlag ablehnen?', message: 'Der Kredit wird beendet.', confirmLabel: 'Ablehnen', withReason: true }).then((r) => r && act('reject', { text: r.reason })) }));
      if (['requested', 'negotiating'].includes(l.status) && !myTurn) bar.push(button('Anfrage zurückziehen', { variant: 'danger', icon: 'x', onClick: () => confirmDialog({ title: 'Anfrage zurückziehen?', message: 'Die Anfrage wird beendet.', confirmLabel: 'Zurückziehen' }).then((r) => r && act('withdraw', {}, 'Zurückgezogen.')) }));
      if (['completed', 'rejected', 'withdrawn', 'cancelled'].includes(l.status)) bar.push(button('Neuen Kredit beantragen', { variant: 'primary', icon: 'plus', onClick: () => { m.close(); requestDialog(); } }));
      mount(footer, bar, h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
    }
    function counterDialog(l, after) {
      const err = h('div'); const principal = input({ inputmode: 'decimal', value: centsToInput(l.principalCents) }), count = input({ type: 'number', min: 1, value: l.termCount });
      const freq = select([{ value: 'weekly', label: 'Wöchentliche Rate' }, { value: 'monthly', label: 'Monatliche Rate' }], l.frequency); const text = h('textarea', { class: 'textarea', maxLength: 500, placeholder: 'Begründung / Nachricht (optional)' });
      const prev = h('div', { class: 'terms-box' });
      const upd = () => {
        const p = parseMoney(principal.value), n = Number(count.value); if (!p || !(n >= 1)) return mount(prev, h('span', { class: 'muted' }, '…'));
        const c = calcLoan({ principal: p, count: n, frequency: freq.value, type: l.interest.type, rateBp: l.interest.rateBp, ratePeriod: l.interest.ratePeriod });
        mount(prev, h('div', { class: 'tb-col' }, h('div', { class: 'tb-row' }, h('span', { class: 'k' }, 'Zinsen gesamt'), h('b', null, fmtC(c.interest))), h('div', { class: 'tb-row' }, h('span', { class: 'k' }, 'Gesamtrückzahlung'), h('b', null, fmtC(c.total)))), h('div', { class: 'tb-col' }, h('div', { class: 'tb-row' }, h('span', { class: 'k' }, `Rate (${FREQ[freq.value]})`), h('b', null, fmtC(c.installment))), h('div', { class: 'tb-row' }, h('span', { class: 'k' }, 'Zinssatz'), h('span', null, l.interest.text))));
      };
      for (const e of [principal, count, freq]) { e.addEventListener('input', upd); e.addEventListener('change', upd); } upd();
      const cm = openModal({ title: 'Gegenvorschlag', body: h('div', null, err, note(`Der Zinssatz (${l.interest.text}) bleibt wie vom Team festgelegt; Zinsen und Rate werden für deinen Vorschlag neu berechnet.`, 'info'), h('div', { style: { height: '10px' } }),
        h('div', { class: 'form-row' }, field('Kreditsumme', principal), field('Anzahl Raten', count)), field('Ratenrhythmus', freq), prev, h('div', { style: { height: '10px' } }), field('Nachricht', text)),
      footer: [button('Abbrechen', { onClick: () => cm.close() }), button('Vorschlag senden', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        const p = parseMoney(principal.value); if (!p) return err.replaceChildren(formError('Ungültige Kreditsumme.'));
        try { await api.post(`/api/p/credit/loans/${l.id}/counter`, { principalCents: p, termCount: Number(count.value), frequency: freq.value, text: text.value.trim() }); cm.close(); toast('Gegenvorschlag gesendet.'); await after(); load(true); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) })] });
    }
    await reload(); off = ctx.live(['credit'], reload, { wait: 150 });
  }

  const openFromTarget = () => { const id = Number(sessionStorage.getItem('mdt:credit:open')); if (id) { sessionStorage.removeItem('mdt:credit:open'); openLoan(id); } };
  window.addEventListener('mdt:credit-open', openFromTarget);
  ctx.live(['credit', 'partners', 'system'], () => load(true), { wait: 200 });
  await load();
  openFromTarget();
  return () => window.removeEventListener('mdt:credit-open', openFromTarget);
}
