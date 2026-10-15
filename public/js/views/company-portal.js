import { h, mount, fmtDate, fmtDateTime } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, select, formError, note, empty } from '../ui/kit.js';
import { api } from '../api.js';
import { showLock, brandBlock } from '../shell.js';
import { parseMoney, fmtC } from './tab.js';

/**
 * Firmenportal (Deckel-Abrechnung): persönlicher Link, kein Login. Die Firma sieht ausschließlich ihre eigenen Abrechnungen,
 * wählt den Abrechnungszeitraum, trägt den fälligen Gesamtbetrag ein und übermittelt ihn. Unsere Buchungssummen sieht sie nie.
 * Live: Statuswechsel durch das Team erscheinen sofort (SSE) – ohne dass Eingaben im Formular verloren gehen.
 */
export async function showCompanyPortal({ token }) {
  const url = `/api/c/${encodeURIComponent(token)}`;
  let data;
  try { data = await api.get(url); } catch { return invalid(); }
  function invalid() { return showLock(h('div', { class: 'lock-card', style: { textAlign: 'center' } }, brandBlock(), h('h2', null, 'Link ungültig'),
    h('p', { class: 'lead' }, 'Dieser Link ist ungültig oder wurde deaktiviert. Bitte wende dich an deinen Ansprechpartner.'))); }

  // ── feste Teile (werden nie neu aufgebaut, damit Eingaben erhalten bleiben) ──
  const err = h('div');
  const periodSel = h('select', { class: 'select' });
  const amount = input({ inputmode: 'decimal', placeholder: '0,00', autocomplete: 'off' });
  const comment = h('textarea', { class: 'textarea', maxLength: 500, placeholder: 'Optionaler Kommentar (z. B. Hinweise zur Abrechnung)' });
  const submit = button('Abrechnung absenden', { variant: 'primary', type: 'submit', icon: 'check' });
  const selected = h('div', { class: 'cp-selected' });
  const noPeriods = note('Aktuell gibt es keinen Zeitraum, den du abrechnen kannst. Neue Zeiträume erscheinen nach Ablauf der Woche bzw. des Monats.', 'info');
  const formFields = h('div', null, field(data.company.interval === 'weekly' ? 'Kalenderwoche' : 'Monat', periodSel, { help: 'Es werden nur Zeiträume angeboten, für die noch keine Abrechnung eingereicht wurde.' }), selected,
    field(`Fälliger Gesamtbetrag (${data.currency})`, amount), field('Kommentar', comment), submit);
  const form = h('form', { novalidate: true }, err, formFields, noPeriods);
  const bannerHost = h('div'), history = h('div'), live = h('span', { class: 'cp-live', title: 'Live verbunden' }, h('i'), 'Live');
  const host = h('div', { class: 'company-portal' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h2', null, data.company.name), live),
    h('p', { class: 'lead' }, `Deckel-Abrechnung · ${data.company.intervalLabel.toLowerCase()}e Abrechnung`),
    bannerHost, h('div', { class: 'cp-section' }, 'Neue Abrechnung übermitteln'), form, h('div', { class: 'cp-section' }, 'Deine bisherigen Abrechnungen'), history);
  showLock(h('div', { class: 'lock-card wide' }, brandBlock(), host));
  document.querySelector('.lock-clock')?.remove(); // die große Uhr würde auf kleinen Bildschirmen das Formular überdecken

  const updSelected = () => { const p = data.periods.find((x) => x.key === periodSel.value); selected.textContent = p ? `Abrechnungszeitraum: ${p.label}` : ''; };
  periodSel.addEventListener('change', updSelected);

  const seen = new Map(); // Nummer → Status (für die Hervorhebung geänderter Zeilen)
  function render({ flash = true } = {}) {
    // Zeiträume: Auswahl behalten, soweit der Zeitraum noch angeboten wird
    const keep = periodSel.value;
    mount(periodSel, data.periods.map((p) => h('option', { value: p.key, selected: p.key === keep }, `${p.label} (${fmtDate(p.from)} – ${fmtDate(p.to)})`)));
    formFields.hidden = !data.periods.length; noPeriods.hidden = !!data.periods.length; updSelected();
    // Historie
    const changed = new Set();
    for (const s of data.statements) { if (flash && seen.has(s.number) && seen.get(s.number) !== s.status) changed.add(s.number); seen.set(s.number, s.status); if (flash && !seen.has(s.number)) changed.add(s.number); }
    mount(history, data.statements.length ? h('div', { class: 'table-wrap' }, h('div', { class: 'table-scroll' }, h('table', { class: 'table', style: { minWidth: '480px' } },
      h('thead', null, h('tr', null, ['Zeitraum', 'Betrag', 'Status', 'Eingereicht'].map((t) => h('th', null, t)))),
      h('tbody', null, data.statements.map((s) => h('tr', { class: changed.has(s.number) ? 'row-flash' : '' }, h('td', null, h('b', null, s.period?.label), h('div', { class: 'muted', style: { fontSize: '11.5px' } }, s.number)), h('td', null, fmtC(s.submittedCents)),
        h('td', null, h('span', { class: 'badge', style: { '--c': s.statusColor } }, s.statusLabel), s.rejectReason && h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, `Grund: ${s.rejectReason}`), s.paidAt && h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, `bezahlt am ${fmtDate(s.paidAt)}`)),
        h('td', null, fmtDateTime(s.submittedAt))))))))
      : empty('Noch keine Abrechnungen', 'Sobald du eine Abrechnung übermittelt hast, erscheint sie hier mit ihrem Status.', 'dollar'));
  }
  data.statements.forEach((s) => seen.set(s.number, s.status));
  render({ flash: false });

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.replaceChildren();
    const c = parseMoney(amount.value);
    if (c == null) return err.replaceChildren(formError('Bitte gib den fälligen Betrag ein (z. B. 1.284,50).'));
    await busy(submit, async () => {
      try {
        const res = await api.post(`${url}/statements`, { periodKey: periodSel.value, amountCents: c, comment: comment.value.trim() });
        data = res; amount.value = ''; comment.value = '';
        mount(bannerHost, h('div', { class: 'cp-success' }, icon('check'), res.message)); render({ flash: false });
      } catch (ex) { err.replaceChildren(formError(ex.message)); }
    });
  });

  // ── Live: Änderungen des Teams sofort übernehmen ──
  let timer = null;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(async () => { try { data = await api.get(url); render(); } catch { invalid(); } }, 150); };
  const es = new EventSource(`${url}/events`);
  es.addEventListener('change', refresh);
  es.addEventListener('reset', refresh);
  es.addEventListener('hello', () => { live.classList.remove('off'); });
  es.onerror = () => live.classList.add('off'); // der Browser verbindet automatisch neu und holt Verpasstes nach
  es.addEventListener('open', refresh);
  // Sicherheitsnetz: bei längerer Pause (Standby) beim Zurückkehren neu laden
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
}
