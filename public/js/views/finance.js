import { h, mount, fmtDateTime, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, card, field, input, select, table, tabs, formError, openModal, confirmDialog, toast, skeletons, empty, note, badge } from '../ui/kit.js';
import { api } from '../api.js';
import { pairColumns, hbars } from '../ui/charts.js';

const STATUS = { expected: ['erwartet', 'b-warn'], settled: ['verbucht', 'b-ok'], cancelled: ['storniert', 'b-mute'] };
const monthLabel = (m) => { const [y, mo] = m.split('-'); return `${['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'][Number(mo) - 1]} ${y.slice(2)}`; };

/**
 * Finanzen: Überblick (Kontostand, erwartete Ein-/Ausgänge, Verlauf je Monat, Aufteilung nach Art) und Journal aller Geldbewegungen
 * mit Filtern, manuellen Buchungen, CSV-Export und – mit Recht – endgültigem Löschen. Die Beträge entstehen in Börse, Deckel und Kredit.
 */
export default async function render(container, ctx) {
  const opts = await api.get('/api/finance/options');
  const money = (n) => `${Number(n ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${opts.currency}`;
  const f = { status: '', direction: '', type: '', q: '', from: '', to: '' };
  let tab = 'overview';
  const tabHost = h('div', { style: { marginBottom: '16px' } }), host = h('div');
  mount(container, tabHost, host);

  const drawActions = () => ctx.setActions(opts.canManual && button('Manuelle Buchung', { variant: 'primary', icon: 'plus', onClick: () => manualDialog() }));
  async function show(t, silent = false) {
    tab = t; drawActions();
    if (!silent) mount(host, skeletons(3, 90));
    mount(tabHost, tabs([{ id: 'overview', label: 'Überblick' }, { id: 'ledger', label: 'Journal' }], tab, (x) => show(x)));
    try { await (tab === 'overview' ? overview() : ledger()); } catch (e) { mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
  }

  async function overview() {
    const [{ summary: s }, rep] = await Promise.all([api.get('/api/finance/summary'), api.get('/api/finance/report?months=6')]);
    if (!ctx.isCurrent() || tab !== 'overview') return;
    const tile = (v, label, tone) => h('div', { class: `tile ${tone ? 't-' + tone : ''}` }, h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, v), h('div', { class: 'tile-label' }, label)));
    const bal = h('div', { class: `fin-balance ${s.balanceSettled >= 0 ? 'pos' : 'neg'}` }, h('div', { class: 'fb-l' }, 'Saldo (verbuchte Einnahmen − Ausgaben)'), h('div', { class: 'fb-v' }, money(s.balanceSettled)));
    const types = {};
    for (const x of rep.byType) if (x.status === 'settled') (types[x.label] ??= { in: 0, out: 0 })[x.direction] += x.total;
    mount(host, h('div', { class: 'stack-v' }, bal,
      h('div', { class: 'tile-row' }, tile(money(s.settledIn), 'Einnahmen verbucht', 'ok'), tile(money(s.settledOut), 'Ausgaben verbucht', 'err'), tile(money(s.expectedIn), 'Erwartete Einnahmen', 'info'), tile(money(s.expectedOut), 'Erwartete Ausgaben', 'warn')),
      h('div', { class: 'stat-grid' },
        card('Verlauf je Monat (verbucht)', rep.monthly.length ? pairColumns(rep.monthly.map((m) => ({ label: monthLabel(m.month), a: m.in, b: m.out })), { fmt: money }) : empty('Noch keine verbuchten Bewegungen', null, 'dollar'), { icon: 'activity' }),
        card('Nach Art (verbucht)', Object.keys(types).length ? h('div', { class: 'stack-v' }, Object.entries(types).map(([label, v]) => h('div', null, h('div', { class: 'sub-title' }, label),
          hbars([{ label: 'Einnahmen', value: v.in, color: '#34d399', text: money(v.in) }, { label: 'Ausgaben', value: v.out, color: '#f87171', text: money(v.out) }])))) : empty('Keine Daten', null, 'dollar'), { icon: 'list' }))));
  }

  async function ledger() {
    const p = new URLSearchParams(); for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    const { entries } = await api.get(`/api/finance/ledger?${p}&limit=300`);
    if (!ctx.isCurrent() || tab !== 'ledger') return;
    const had = host.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'search';
    const search = input({ type: 'search', placeholder: 'Nummer, Partner, Firma, Zweck …', value: f.q }); search.addEventListener('input', debounce(() => { f.q = search.value.trim(); show('ledger', true); }));
    const mk = (key, options, w) => { const s = select(options, f[key], { style: { width: w } }); s.addEventListener('change', () => { f[key] = s.value; show('ledger', true); }); return s; };
    const date = (key, title) => { const d = input({ type: 'date', value: f[key], title, style: { width: '150px' } }); d.addEventListener('change', () => { f[key] = d.value; show('ledger', true); }); return d; };
    const sum = entries.filter((e) => e.status !== 'cancelled').reduce((a, e) => a + (e.direction === 'in' ? e.amount : -e.amount), 0);
    const exportUrl = `/api/finance/export.csv?${p}`;
    mount(host, h('div', { class: 'toolbar', style: { flexWrap: 'wrap' } }, h('div', { class: 'input-icon' }, icon('search'), search),
      mk('status', [{ value: '', label: 'Alle Status' }, { value: 'expected', label: 'Erwartet' }, { value: 'settled', label: 'Verbucht' }, { value: 'cancelled', label: 'Storniert' }], '140px'),
      mk('direction', [{ value: '', label: 'Ein- & Ausgänge' }, { value: 'in', label: 'Einnahmen' }, { value: 'out', label: 'Ausgaben' }], '150px'),
      mk('type', [{ value: '', label: 'Alle Arten' }, ...opts.types.map((t) => ({ value: t.key, label: t.label }))], '170px'), date('from', 'Von'), date('to', 'Bis'),
      h('div', { class: 'grow' }), h('span', { class: 'muted' }, `${entries.length} Einträge · Saldo `), h('b', null, money(sum)),
      opts.canExport && h('a', { class: 'btn btn-sm', href: exportUrl, download: '' }, icon('download'), 'CSV')),
    table([
      { label: 'Datum', render: (e) => h('span', { title: fmtDateTime(e.createdAt) }, e.createdAt.slice(0, 10).split('-').reverse().join('.')) },
      { label: 'Art', render: (e) => badge(e.typeLabel, 'b-info', false) },
      { label: 'Verwendung', render: (e) => h('div', null, e.note || '–', (e.partner || e.company) && h('div', { class: 'muted', style: { fontSize: '11.5px' } }, e.partner?.number ?? e.company?.number)) },
      { label: 'Betrag', render: (e) => h('b', { style: { color: e.direction === 'in' ? '#34d399' : '#f87171', textDecoration: e.status === 'cancelled' ? 'line-through' : '', opacity: e.status === 'cancelled' ? 0.55 : 1 } }, `${e.direction === 'in' ? '+' : '−'}${money(e.amount)}`) },
      { label: 'Status', render: (e) => badge(STATUS[e.status][0], STATUS[e.status][1]) },
      { label: '', style: { whiteSpace: 'nowrap', width: '1%' }, render: (e) => h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
        opts.canManual && e.entryType === 'manual' && e.status === 'expected' && button('Verbuchen', { size: 'sm', variant: 'ok', icon: 'check', onClick: () => act(`/api/finance/entries/${e.id}/settle`, 'Verbucht.') }),
        opts.canManual && e.entryType === 'manual' && e.status !== 'cancelled' && button('', { size: 'sm', variant: 'ghost', icon: 'x', title: 'Stornieren', onClick: () => act(`/api/finance/entries/${e.id}/cancel`, 'Storniert.') }),
        opts.canDelete && button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Endgültig löschen', onClick: () => del(e) })) },
    ], entries, { empty: empty('Keine Bewegungen', 'Börse, Deckel und Kredit erzeugen ihre Geldbewegungen automatisch. Eigene Posten legst du als manuelle Buchung an.', 'dollar') }));
    if (had) { const i = host.querySelector('input[type=search]'); i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); }
  }
  async function act(url, msg) { try { await api.post(url); toast(msg); show(tab, true); } catch (e) { toast(e.message, 'err'); } }
  async function del(e) {
    if (!await confirmDialog({ title: 'Eintrag endgültig löschen?', message: `${e.typeLabel}: ${e.note || ''} (${e.direction === 'in' ? '+' : '−'}${money(e.amount)}) wird aus dem Journal entfernt. Das zugehörige Geschäft bleibt unverändert. Das lässt sich nicht rückgängig machen.`, confirmLabel: 'Endgültig löschen' })) return;
    try { await api.del(`/api/finance/entries/${e.id}`); toast('Gelöscht.'); show(tab, true); } catch (ex) { toast(ex.message, 'err'); }
  }

  function manualDialog() {
    const err = h('div'); const dir = select([{ value: 'in', label: 'Einnahme' }, { value: 'out', label: 'Ausgabe' }], 'in'); const amount = input({ inputmode: 'decimal', placeholder: '0,00' });
    const desc = input({ maxLength: 200, placeholder: 'z. B. Spende, Reparatur, Miete' }); const date = input({ type: 'date', value: new Date().toISOString().slice(0, 10) });
    const status = select([{ value: 'settled', label: 'Bereits verbucht' }, { value: 'expected', label: 'Erwartet (noch offen)' }], 'settled');
    const m = openModal({ title: 'Manuelle Buchung', body: h('div', null, err, note('Für Posten, die nicht aus Börse, Deckel oder Kredit stammen. Sie erscheinen im Journal und in den Auswertungen.', 'info'), h('div', { style: { height: '10px' } }),
      h('div', { class: 'form-row' }, field('Art', dir), field(`Betrag (${opts.currency})`, amount)), field('Verwendungszweck', desc), h('div', { class: 'form-row' }, field('Datum', date), field('Status', status))),
    footer: [button('Abbrechen', { onClick: () => m.close() }), button('Buchen', { variant: 'primary', icon: 'check', onClick: (b) => busy(b.currentTarget, async () => {
      let a = String(amount.value).trim().replace(/\s/g, ''); a = a.includes(',') ? a.replace(/\./g, '').replace(',', '.') : a;
      try { await api.post('/api/finance/entries', { direction: dir.value, amount: Number(a), description: desc.value, date: date.value, status: status.value }); m.close(); toast('Gebucht.'); show('ledger'); }
      catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) })] });
  }

  ctx.live(['finance', 'market', 'credit', 'tab'], () => show(tab, true), { wait: 250 });
  await show(tab);
}
