import { h, mount, timeAgo, fmtDateTime } from '../ui/dom.js';
import { button, busy, field, input, select, tabs, table, rankBadge, formError, openModal, confirmDialog, toast, empty, badge, note, skeletons } from '../ui/kit.js';
import { api } from '../api.js';
import { can } from '../state.js';

/**
 * Aktivität & Abmeldung: „Meine Abmeldung“ (jeder meldet sich selbst für einen Zeitraum ab) und – mit Berechtigung – die Übersicht über alle Mitglieder
 * (zuletzt aktiv, aktive Tage, Abmeldungen). Nur Dienstnummern.
 */
const ST = { active: ['Aktiv', 'b-ok'], absent: ['Abgemeldet', 'b-info'], inactive: ['Inaktiv', 'b-err'], new: ['Neu', 'b-mute'] };
const fmtDay = (d) => (d ? d.split('-').reverse().join('.') : '–');
const todayPlus = (today, n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dots = (n, of) => h('span', { class: 'act-dots', title: `${n} von ${of} Tagen aktiv` }, Array.from({ length: of }, (_, i) => h('i', { class: i < n ? 'on' : '' })));

export default async function render(container, ctx) {
  const canView = can('activity.view'), canAbsence = can('activity.absence');
  let tab = canAbsence ? 'mine' : 'all', mine = null, over = null, filter = { status: '', q: '' };
  const tabHost = h('div', { style: { marginBottom: '12px' } }), host = h('div');
  mount(container, tabHost, host);
  mount(host, skeletons(3, 90));

  const reload = async () => {
    if (canAbsence) mine = await api.get('/api/activity/me');
    if (canView) over = await api.get('/api/activity/overview');
    if (ctx.isCurrent()) draw();
  };
  const TABS = [...(canAbsence ? [{ id: 'mine', label: 'Meine Abmeldung' }] : []), ...(canView ? [{ id: 'all', label: 'Übersicht' }] : [])];
  const drawTabs = () => mount(tabHost, TABS.length > 1 ? tabs(TABS, tab, (id) => { tab = id; draw(); }) : null);

  // ── Abmeldung eintragen (für mich oder – mit activity.manage – für ein anderes Mitglied) ──
  function absenceDialog({ userId = null, label = null } = {}) {
    const today = (mine ?? over).today, max = (mine ?? over).maxDays, err = h('div');
    const from = input({ type: 'date', value: today, min: todayPlus(today, -1) }), to = input({ type: 'date', value: todayPlus(today, 6), min: today });
    const reason = input({ maxLength: 200, placeholder: 'Grund (optional), z. B. Urlaub, Prüfung, Pause' });
    const save = button('Abmelden', { variant: 'primary', icon: 'check', onClick: () => busy(save, async () => {
      err.replaceChildren();
      try { await api.post('/api/activity/absences', { userId: userId ?? undefined, from: from.value, to: to.value, reason: reason.value }); m.close(); toast(userId ? 'Abmeldung eingetragen.' : 'Du bist abgemeldet.'); await reload(); }
      catch (e) { err.replaceChildren(formError(e.message)); }
    }) });
    const m = openModal({ title: label ? `Abmeldung für ${label}` : 'Abmelden', body: h('div', { class: 'stack' }, err,
      note(`Solange du abgemeldet bist, giltst du nicht als inaktiv. Ein Zeitraum darf höchstens ${max} Tage dauern; du kannst dich jederzeit früher zurückmelden.`, 'info'),
      h('div', { class: 'form-row' }, field('Von', from), field('Bis', to)), field('Grund', reason, { help: 'Sichtbar für die Führung.' })), footer: [button('Abbrechen', { onClick: () => m.close() }), save] });
  }
  async function endAbsence(a, who) {
    const started = a.from <= (mine ?? over).today;
    if (!await confirmDialog({ title: started ? 'Zurückmelden?' : 'Abmeldung löschen?', message: started ? `${who ? who + ' gilt' : 'Du giltst'} ab heute wieder als verfügbar.` : 'Die Abmeldung wird gelöscht.', confirmLabel: started ? 'Zurückmelden' : 'Löschen', variant: 'primary' })) return;
    try { await api.del(`/api/activity/absences/${a.id}`); toast(started ? 'Zurückgemeldet.' : 'Gelöscht.'); await reload(); } catch (e) { toast(e.message, 'err'); }
  }

  function drawMine() {
    const s = mine, cur = s.absences.find((a) => a.from <= s.today && a.to >= s.today), upcoming = s.absences.filter((a) => a.from > s.today), past = s.absences.filter((a) => a.to < s.today).reverse();
    ctx.setActions(button('Abmelden', { variant: 'primary', icon: 'calendar', onClick: () => absenceDialog() }));
    const row = (a, who) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, `${fmtDay(a.from)} – ${fmtDay(a.to)}`), h('div', { class: 's' }, [a.reason, a.byOther && 'von der Führung eingetragen'].filter(Boolean).join(' · ') || 'ohne Grund')),
      a.to >= s.today && button(a.from <= s.today ? 'Zurückmelden' : 'Löschen', { size: 'sm', onClick: () => endAbsence(a, who) }));
    mount(host,
      cur ? note(`Du bist abgemeldet bis ${fmtDay(cur.to)}${cur.reason ? ` (${cur.reason})` : ''}.`, 'calendar') : note(s.state === 'inactive' ? `Du warst seit mehr als ${s.inactiveDays} Tagen nicht aktiv. Wenn du pausierst, melde dich ab – dann giltst du nicht als inaktiv.` : 'Du bist aktiv. Bist du länger nicht da (Urlaub, Pause), melde dich hier ab.', cur ? 'calendar' : 'info'),
      h('div', { style: { height: '12px' } }),
      h('div', { class: 'tile-row' }, tile(s.lastActiveAt ? timeAgo(s.lastActiveAt) : '–', 'Zuletzt aktiv'), tile(`${s.days14} / 14`, 'Aktive Tage (14 Tage)'), tile(`${s.days30} / 30`, 'Aktive Tage (30 Tage)')),
      h('div', { style: { height: '16px' } }),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Meine Abmeldungen')),
        h('div', { class: 'card-body flush' }, s.absences.length ? [...(cur ? [cur] : []), ...upcoming, ...past].map((a) => row(a)) : empty('Keine Abmeldungen', 'Du hast dich bisher nicht abgemeldet.', 'calendar'))));
  }
  const tile = (v, label, tone) => h('div', { class: `tile ${tone ? 't-' + tone : ''}` }, h('div', { class: 'tile-body' }, h('div', { class: 'tile-value' }, v), h('div', { class: 'tile-label' }, label)));

  function drawAll() {
    const rows = over.rows, count = (st) => rows.filter((r) => r.status === st).length;
    ctx.setActions(over.canManage ? button('Mitglied abmelden', { icon: 'calendar', onClick: pickMember }) : null);
    const search = input({ type: 'search', placeholder: 'Dienstnummer suchen …', value: filter.q }), sel = select([{ value: '', label: 'Alle Status' }, ...Object.entries(ST).map(([value, [label]]) => ({ value, label }))], filter.status);
    search.style.flex = '1'; sel.style.width = '200px'; sel.style.flex = 'none';
    search.addEventListener('input', () => { filter.q = search.value; paintTable(); });
    sel.addEventListener('change', () => { filter.status = sel.value; paintTable(); });
    const tableHost = h('div');
    const paintTable = () => {
      const q2 = filter.q.trim().toLowerCase(), l2 = rows.filter((r) => (!filter.status || r.status === filter.status) && (!q2 || r.label.toLowerCase().includes(q2)))
        .sort((a, b) => ['inactive', 'new', 'absent', 'active'].indexOf(a.status) - ['inactive', 'new', 'absent', 'active'].indexOf(b.status) || (b.daysSince ?? 999) - (a.daysSince ?? 999));
      mount(tableHost, table([
        { label: 'Nr.', style: { width: '1%' }, render: (r) => h('span', { class: 'member-no' }, r.label) },
        { label: 'Rang', render: (r) => (r.rank ? rankBadge(r.rank) : h('span', { class: 'muted' }, '–')) },
        { label: 'Status', render: (r) => badge(ST[r.status][0], ST[r.status][1]) },
        { label: 'Zuletzt aktiv', render: (r) => (r.lastActiveAt ? h('span', { title: fmtDateTime(r.lastActiveAt) }, timeAgo(r.lastActiveAt)) : h('span', { class: 'muted' }, 'noch nie')) },
        { label: 'Aktive Tage', render: (r) => h('div', null, dots(r.days14, 14), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${r.days14} / 14 · ${r.days30} / 30`)) },
        { label: 'Abmeldung', render: (r) => (r.absence ? h('div', null, `bis ${fmtDay(r.absence.to)}`, r.absence.reason && h('div', { class: 'muted', style: { fontSize: '12px' } }, r.absence.reason)) : r.upcoming ? h('span', { class: 'muted' }, `ab ${fmtDay(r.upcoming.from)}`) : h('span', { class: 'muted' }, '–')) },
        over.canManage && { label: '', style: { width: '1%' }, render: (r) => h('div', { class: 'actions' }, r.absence ? button('Zurückmelden', { size: 'sm', onClick: () => endAbsence(r.absence, r.label) }) : button('Abmelden', { size: 'sm', onClick: () => absenceDialog({ userId: r.id, label: r.label }) })) },
      ].filter(Boolean), l2, { empty: empty('Keine Mitglieder', 'Zu diesem Filter gibt es keine Treffer.', 'users') }));
    };
    mount(host,
      h('div', { class: 'tile-row' }, tile(count('active'), 'Aktiv', 'ok'), tile(count('absent'), 'Abgemeldet', 'info'), tile(count('inactive'), `Inaktiv (≥ ${over.inactiveDays} Tage)`, count('inactive') ? 'err' : 'ok'), tile(count('new'), 'Neu')),
      h('div', { style: { height: '12px' } }), h('div', { class: 'row', style: { marginBottom: '12px', gap: '8px' } }, search, sel), tableHost);
    paintTable();
  }
  function pickMember() {
    const sel = select([{ value: '', label: '— Mitglied wählen —' }, ...over.rows.filter((r) => !r.absence).map((r) => ({ value: r.id, label: r.label }))], '');
    const m = openModal({ title: 'Mitglied abmelden', body: field('Mitglied', sel), footer: [button('Abbrechen', { onClick: () => m.close() }), button('Weiter', { variant: 'primary', onClick: () => { if (!sel.value) return; const r = over.rows.find((x) => String(x.id) === sel.value); m.close(); absenceDialog({ userId: r.id, label: r.label }); } })] });
  }

  function draw() { drawTabs(); if (tab === 'mine' && mine) drawMine(); else if (over) drawAll(); else mount(host, empty('Keine Berechtigung', null, 'lock')); }
  ctx.live(['activity'], () => reload().catch(() => {}), { wait: 800 });
  try { await reload(); } catch (e) { mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
}
