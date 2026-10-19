import { h, mount, fmtDateTime } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, select, tabs, formError, openModal, confirmDialog, toast, empty, badge, checkbox, toggle } from '../ui/kit.js';
import { api } from '../api.js';

/**
 * Termine & Aufträge: Kalender (Monat/Agenda) mit Terminen, Beteiligten, Zu-/Absage und Erinnerungen – und Aufträge, die an Mitglieder verteilt werden
 * (Frist, Priorität, Status je Beauftragtem, optional einem Termin zugeordnet). Fristen von Aufträgen erscheinen zusätzlich im Kalender.
 */
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const hm = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const dLong = (d) => d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
const toLocalInput = (iso, dateOnly) => { if (!iso) return ''; const d = new Date(iso); const day = dayKey(d); return dateOnly ? day : `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const PRIO_CLS = { low: 'b-mute', normal: 'b-info', high: 'b-warn', urgent: 'b-err' };
const RSVP_CLS = { pending: 'b-mute', yes: 'b-ok', maybe: 'b-warn', no: 'b-err' };
const STATE_CLS = { open: 'b-mute', accepted: 'b-info', done: 'b-ok', declined: 'b-err' };
const TASK_STATUS = { open: ['Offen', 'b-mute'], in_progress: ['In Arbeit', 'b-info'], done: ['Erledigt', 'b-ok'], cancelled: ['Zurückgezogen', 'b-err'] };

function dueText(iso, done) {
  if (!iso) return 'ohne Frist';
  const ms = new Date(iso) - Date.now(), abs = Math.abs(ms), m = Math.round(abs / 60000), hrs = Math.round(m / 60), d = Math.round(hrs / 24);
  const span = m < 60 ? `${m} Min.` : hrs < 24 ? `${hrs} Std.` : `${d} Tg.`;
  if (done) return `Frist ${fmtDateTime(iso)}`;
  return ms < 0 ? `überfällig seit ${span}` : `fällig in ${span} (${fmtDateTime(iso)})`;
}

export default async function render(container, ctx) {
  const opt = await api.get('/api/schedule/options');
  let tab = 'calendar', mode = 'month', cursor = monthStart(new Date()), scope = 'mine', status = 'open';
  let data = { events: [], tasks: [] }, taskData = { tasks: [], counts: {} };
  const tabHost = h('div', { style: { marginBottom: '12px' } }), host = h('div', { class: 'sch-host' });
  mount(container, tabHost, host);

  // ── gemeinsame Bausteine ──
  const textarea = (value = '', rows = 4) => h('textarea', { class: 'input', rows, style: { minHeight: `${rows * 22}px`, resize: 'vertical' } }, value);
  function memberPicker(selected) {
    const set = new Set(selected), q = input({ placeholder: 'Dienstnummer suchen …', type: 'search' }), count = h('div', { class: 'help' }), list = h('div', { class: 'sch-pick' });
    const draw = () => { const f = q.value.trim().toLowerCase(); mount(list, opt.members.filter((m) => !f || m.label.toLowerCase().includes(f) || set.has(m.id)).map((m) => { const cb = checkbox(m.label, set.has(m.id)); cb.input.addEventListener('change', () => { cb.input.checked ? set.add(m.id) : set.delete(m.id); count.textContent = `${set.size} ausgewählt`; }); return cb; })); count.textContent = `${set.size} ausgewählt`; };
    q.addEventListener('input', draw); draw();
    return { el: h('div', null, q, count, list), get: () => [...set] };
  }
  const dot = (c) => h('i', { class: 'sch-dot', style: { background: c ?? 'var(--accent)' } });

  // ── Daten laden ──
  const range = () => {
    if (mode === 'agenda') { const a = new Date(); a.setHours(0, 0, 0, 0); return [a, addDays(a, 45)]; }
    const first = (monthStart(cursor).getDay() + 6) % 7; const s = addDays(monthStart(cursor), -first); return [s, addDays(s, 42)];
  };
  async function loadCalendar() { const [a, b] = range(); data = await api.get(`/api/schedule/events?from=${encodeURIComponent(a.toISOString())}&to=${encodeURIComponent(b.toISOString())}`); }
  async function loadTasks() { taskData = await api.get(`/api/schedule/tasks?scope=${scope}&status=${status}`); }
  const refresh = async () => { try { if (tab === 'calendar') { await loadCalendar(); drawCalendar(); } else { await loadTasks(); drawTasks(); } } catch (e) { mount(host, empty('Fehler beim Laden', e.message, 'alert')); } };

  // ── Kalender ──
  function chipEv(e) {
    const c = e.kind?.color;
    const el = h('button', { class: `sch-ev ${e.status === 'cancelled' ? 'cancelled' : ''} ${e.rsvp === 'pending' ? 'invited' : ''}`, type: 'button', style: { '--c': c ?? 'var(--accent)' }, title: `${e.title}${e.location ? ` · ${e.location}` : ''}` },
      !e.allDay && h('span', { class: 'sch-t' }, hm(e.startsAt)), h('span', { class: 'sch-n' }, e.title));
    el.addEventListener('click', (ev) => { ev.stopPropagation(); openEvent(e.id); });
    return el;
  }
  function chipTask(t) {
    const el = h('button', { class: `sch-due ${t.overdue ? 'over' : ''} ${t.status === 'done' ? 'done' : ''}`, type: 'button', title: `Auftrag: ${t.title} (${dueText(t.dueAt, t.status === 'done')})` }, icon('flag'), h('span', { class: 'sch-n' }, t.title));
    el.addEventListener('click', (ev) => { ev.stopPropagation(); openTask(t.id); });
    return el;
  }
  const byDay = () => {
    const map = new Map(), [from, to] = range(), put = (k, v) => { if (!map.has(k)) map.set(k, { events: [], tasks: [] }); map.get(k)[v.kindOf].push(v.item); };
    for (const e of data.events) { const s = new Date(e.startsAt), en = e.endsAt ? new Date(e.endsAt) : s; let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); const last = new Date(en.getFullYear(), en.getMonth(), en.getDate()); for (let i = 0; d <= last && i < 60; i++, d = addDays(d, 1)) if (d >= addDays(from, -1) && d < to) put(dayKey(d), { kindOf: 'events', item: e }); }
    for (const t of data.tasks) put(dayKey(new Date(t.dueAt)), { kindOf: 'tasks', item: t });
    return map;
  };
  function drawCalendar() {
    tabsRow();
    const title = h('h3', { class: 'sch-title' }, mode === 'month' ? cursor.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }) : 'Die nächsten 45 Tage');
    const nav = h('div', { class: 'row', style: { alignItems: 'center', gap: '8px' } },
      mode === 'month' && button('', { size: 'sm', icon: 'chevronL', title: 'Voriger Monat', onClick: () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1); refresh(); } }),
      title,
      mode === 'month' && button('', { size: 'sm', icon: 'chevronR', title: 'Nächster Monat', onClick: () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); refresh(); } }),
      mode === 'month' && button('Heute', { size: 'sm', onClick: () => { cursor = monthStart(new Date()); refresh(); } }),
      h('span', { class: 'grow' }), tabs([{ id: 'month', label: 'Monat' }, { id: 'agenda', label: 'Agenda' }], mode, (m) => { mode = m; refresh(); }));
    const legend = h('div', { class: 'sch-legend' }, opt.kinds.map((k) => h('span', null, dot(k.color), k.label)), h('span', null, icon('flag'), 'Auftragsfrist'));
    mount(host, nav, mode === 'month' ? monthGrid() : agenda(), legend);
  }
  function monthGrid() {
    const [start] = range(), map = byDay(), today = dayKey(new Date()), grid = h('div', { class: 'sch-grid' }, WD.map((w) => h('div', { class: 'sch-dow' }, w)));
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i), k = dayKey(d), cell = map.get(k) ?? { events: [], tasks: [] }, other = d.getMonth() !== cursor.getMonth();
      const items = [...cell.events.map(chipEv), ...cell.tasks.map(chipTask)];
      const el = h('div', { class: `sch-day ${other ? 'other' : ''} ${k === today ? 'today' : ''}`, tabindex: 0, role: 'button', 'aria-label': dLong(d) },
        h('div', { class: 'sch-dn' }, d.getDate()), items.slice(0, 3), items.length > 3 && h('div', { class: 'sch-more' }, `+ ${items.length - 3} weitere`));
      el.addEventListener('click', () => openDay(d));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDay(d); });
      grid.append(el);
    }
    return grid;
  }
  function agenda() {
    const map = byDay(), keys = [...map.keys()].sort();
    if (!keys.length) return h('div', { class: 'card card-body' }, empty('Keine Termine in den nächsten Wochen', opt.canCreate ? 'Lege mit „Neuer Termin“ den ersten an.' : null, 'calendar'));
    return h('div', { class: 'stack' }, keys.map((k) => { const d = new Date(`${k}T00:00`), c = map.get(k); return h('div', { class: 'card' }, h('div', { class: 'sch-agenda-day' }, dLong(d), k === dayKey(new Date()) && badge('Heute', 'b-info', false)),
      h('div', { class: 'sch-agenda-list' }, c.events.map(agendaRow), c.tasks.map((t) => h('div', { class: 'list-row clickable', onclick: () => openTask(t.id) }, h('div', { class: 'sch-time' }, icon('flag')), h('div', { class: 'grow' }, h('div', { class: 't' }, `Frist: ${t.title}`), h('div', { class: 's' }, `${t.number} · ${dueText(t.dueAt, t.status === 'done')}`)), badge(t.priorityLabel, PRIO_CLS[t.priority]))))); }));
  }
  const agendaRow = (e) => h('div', { class: 'list-row clickable', onclick: () => openEvent(e.id) }, h('div', { class: 'sch-time' }, e.allDay ? 'ganztägig' : hm(e.startsAt)),
    h('div', { class: 'grow' }, h('div', { class: 't' }, dot(e.kind?.color), e.title, e.status === 'cancelled' && badge('Abgesagt', 'b-err', false)), h('div', { class: 's' }, [e.kind?.label, e.location, e.participantCount ? `${e.participantCount} Beteiligte` : null].filter(Boolean).join(' · '))), e.rsvp && e.rsvp !== 'pending' ? badge(opt.rsvp[e.rsvp], RSVP_CLS[e.rsvp]) : e.rsvp === 'pending' ? badge('Zusage offen', 'b-warn') : null);

  function openDay(d) {
    const k = dayKey(d), c = byDay().get(k) ?? { events: [], tasks: [] };
    const m = openModal({ title: dLong(d), body: h('div', { class: 'stack' }, c.events.length || c.tasks.length ? [...c.events.map(agendaRow), ...c.tasks.map((t) => h('div', { class: 'list-row clickable', onclick: () => { m.close(); openTask(t.id); } }, h('div', { class: 'sch-time' }, icon('flag')), h('div', { class: 'grow' }, h('div', { class: 't' }, `Frist: ${t.title}`), h('div', { class: 's' }, `${t.number} · ${dueText(t.dueAt, t.status === 'done')}`))))] : empty('Nichts an diesem Tag', null, 'calendar')),
      footer: [h('span', { class: 'grow' }), opt.canAssign && button('Auftrag', { icon: 'flag', onClick: () => { m.close(); taskForm(null, { dueAt: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 18, 0).toISOString() }); } }), opt.canCreate && button('Termin', { variant: 'primary', icon: 'plus', onClick: () => { m.close(); eventForm(null, d); } })] });
    m.el.addEventListener('click', (e) => { if (e.target.closest('.list-row')) setTimeout(() => m.close(), 0); });
  }

  // ── Termin: Ansicht ──
  async function openEvent(id) {
    let ev; try { ev = (await api.get(`/api/schedule/events/${id}`)).event; } catch (e) { return toast(e.message, 'err'); }
    const when = ev.allDay ? `${new Date(ev.startsAt).toLocaleDateString('de-DE', { dateStyle: 'full' })} · ganztägig` : `${fmtDateTime(ev.startsAt)}${ev.endsAt ? ` – ${new Date(ev.endsAt).toDateString() === new Date(ev.startsAt).toDateString() ? hm(ev.endsAt) : fmtDateTime(ev.endsAt)}` : ''}`;
    const rsvpBox = h('div');
    const drawRsvp = () => { if (ev.rsvp === null) return mount(rsvpBox); mount(rsvpBox, h('div', { class: 'sch-rsvp' }, h('span', null, 'Deine Antwort:'), [['yes', 'Zusagen', 'check'], ['maybe', 'Vielleicht', 'clock'], ['no', 'Absagen', 'x']].map(([v, l, ic]) => button(l, { size: 'sm', icon: ic, variant: ev.rsvp === v ? 'primary' : '', onClick: async () => { try { ev = (await api.post(`/api/schedule/events/${ev.id}/rsvp`, { response: v })).event; drawRsvp(); drawParts(); refresh(); } catch (e) { toast(e.message, 'err'); } } })))); };
    const partsBox = h('div'); const drawParts = () => mount(partsBox, ev.participants.length ? h('div', { class: 'sch-people' }, ev.participants.map((p) => h('span', { class: 'sch-person' }, p.label, badge(opt.rsvp[p.rsvp], RSVP_CLS[p.rsvp], false)))) : h('div', { class: 'muted' }, 'Keine Beteiligten eingetragen.'));
    drawRsvp(); drawParts();
    const m = openModal({ wide: true, title: ev.title,
      body: h('div', { class: 'stack' },
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, ev.kind && h('span', { class: 'badge no-dot', style: { '--c': ev.kind.color } }, ev.kind.label), ev.status === 'cancelled' && badge('Abgesagt', 'b-err'), badge(ev.visibility === 'team' ? 'Für alle Mitglieder' : 'Nur Beteiligte', 'b-mute', false)),
        h('div', { class: 'sch-facts' }, h('div', null, icon('clock'), when), ev.location && h('div', null, icon('pin'), ev.location), h('div', { class: 'muted' }, `Eingetragen von ${ev.createdBy}`)),
        ev.description && h('div', { class: 'sch-text' }, ev.description),
        rsvpBox, h('div', null, h('div', { class: 'sch-sub' }, 'Beteiligte'), partsBox),
        ev.reminders.length > 0 && h('div', { class: 'sch-facts' }, h('div', null, icon('bell'), `Erinnerung: ${ev.reminders.map((r) => opt.reminders.find((x) => x.value === r)?.label ?? `${r} Min.`).join(', ')}`)),
        h('div', null, h('div', { class: 'sch-sub' }, 'Aufträge zu diesem Termin'), ev.tasks.length ? ev.tasks.map((t) => h('div', { class: 'list-row clickable', onclick: () => { m.close(); openTask(t.id); } }, h('div', { class: 'grow' }, h('div', { class: 't' }, t.title), h('div', { class: 's' }, `${t.number} · ${dueText(t.dueAt, t.status === 'done')}`)), badge(TASK_STATUS[t.status][0], TASK_STATUS[t.status][1]))) : h('div', { class: 'muted' }, 'Keine.'))),
      footer: [ev.canEdit && button('', { icon: 'trash', variant: 'ghost', title: 'Termin löschen', onClick: async () => { if (await confirmDialog({ title: 'Termin löschen?', message: `„${ev.title}“ wird gelöscht – auch für alle Beteiligten.`, confirmLabel: 'Löschen' })) { try { await api.del(`/api/schedule/events/${ev.id}`); m.close(); toast('Termin gelöscht.'); refresh(); } catch (e) { toast(e.message, 'err'); } } } }),
        h('span', { class: 'grow' }),
        ev.canEdit && ev.status !== 'cancelled' && button('Absagen', { icon: 'x', onClick: async () => { if (await confirmDialog({ title: 'Termin absagen?', message: 'Alle Beteiligten werden benachrichtigt.', confirmLabel: 'Absagen' })) { try { await api.patch(`/api/schedule/events/${ev.id}`, { status: 'cancelled' }); m.close(); refresh(); } catch (e) { toast(e.message, 'err'); } } } }),
        ev.canEdit && ev.status === 'cancelled' && button('Wieder ansetzen', { icon: 'refresh', onClick: async () => { try { await api.patch(`/api/schedule/events/${ev.id}`, { status: 'planned' }); m.close(); refresh(); } catch (e) { toast(e.message, 'err'); } } }),
        opt.canAssign && button('Auftrag dazu', { icon: 'flag', onClick: () => { m.close(); taskForm(null, { eventId: ev.id, dueAt: ev.startsAt }); } }),
        ev.canEdit && button('Bearbeiten', { icon: 'edit', variant: 'primary', onClick: () => { m.close(); eventForm(ev); } })] });
  }

  // ── Termin: Formular ──
  function eventForm(ev, day) {
    const err = h('div'), isNew = !ev, d0 = day ?? new Date(), defStart = isNew ? new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), day ? 18 : Math.min(23, new Date().getHours() + 1), 0) : null;
    const title = input({ value: ev?.title ?? '', maxLength: 120, placeholder: 'z. B. Übergabe am Hafen' }), kind = select(opt.kinds.map((k) => ({ value: k.id, label: k.label })), ev?.kind?.id ?? opt.kinds.find((k) => k.key === 'other')?.id ?? opt.kinds[0].id);
    const allDay = toggle('Ganztägig', ev?.allDay ?? false, null);
    const start = input({ type: ev?.allDay ? 'date' : 'datetime-local', value: ev ? toLocalInput(ev.startsAt, ev.allDay) : toLocalInput(defStart.toISOString()) }), end = input({ type: ev?.allDay ? 'date' : 'datetime-local', value: ev?.endsAt ? toLocalInput(ev.endsAt, ev.allDay) : '' });
    allDay.input.addEventListener('change', () => { for (const i of [start, end]) { const v = i.value.slice(0, 10); i.type = allDay.input.checked ? 'date' : 'datetime-local'; i.value = allDay.input.checked ? v : (v ? `${v}T${i === start ? '18:00' : '19:00'}` : ''); } });
    const loc = input({ value: ev?.location ?? '', maxLength: 120, placeholder: 'Ort (optional)' }), desc = textarea(ev?.description ?? '', 4);
    const vis = select([{ value: 'team', label: 'Alle Mitglieder sehen den Termin' }, { value: 'invited', label: 'Nur Beteiligte (und Verwaltung) sehen ihn' }], ev?.visibility ?? 'team');
    const picker = memberPicker((ev?.participants ?? []).map((p) => p.userId)), rem = new Set(ev?.reminders ?? [15]);
    const remBox = h('div', { class: 'sch-rem' }, opt.reminders.map((r) => { const cb = checkbox(r.label, rem.has(r.value)); cb.input.addEventListener('change', () => { cb.input.checked ? rem.add(r.value) : rem.delete(r.value); }); return cb; }));
    const save = button('Speichern', { variant: 'primary', icon: 'check', onClick: () => busy(save, async () => {
      err.replaceChildren();
      try {
        if (!start.value) throw new Error('Bitte einen Beginn angeben.');
        const ad = allDay.input.checked, conv = (v, endOfDay) => new Date(ad ? `${v}T${endOfDay ? '23:59' : '00:00'}` : v).toISOString();
        const body = { title: title.value, kindId: Number(kind.value), allDay: ad, startsAt: conv(start.value), endsAt: end.value ? conv(end.value, true) : null, location: loc.value, description: desc.value, visibility: vis.value, participants: picker.get(), reminders: [...rem] };
        const res = isNew ? await api.post('/api/schedule/events', body) : await api.patch(`/api/schedule/events/${ev.id}`, body);
        m.close(); toast(isNew ? 'Termin angelegt.' : 'Termin gespeichert.'); tab = 'calendar'; if (mode === 'month') cursor = monthStart(new Date(res.event.startsAt)); refresh();
      } catch (e) { mount(err, formError(e.message)); }
    }) });
    const m = openModal({ wide: true, title: isNew ? 'Neuer Termin' : 'Termin bearbeiten', body: h('div', { class: 'stack' }, err, field('Titel *', title), h('div', { class: 'sch-two' }, field('Art', kind), h('div', { style: { alignSelf: 'end', paddingBottom: '8px' } }, allDay)),
      h('div', { class: 'sch-two' }, field('Beginn *', start), field('Ende (optional)', end)), field('Ort', loc), field('Beschreibung', desc), field('Sichtbarkeit', vis),
      field('Beteiligte', picker.el, { help: 'Beteiligte werden benachrichtigt und können zu- oder absagen.' }), field('Erinnerungen', remBox, { help: 'Erinnert den Ersteller und alle Beteiligten, die nicht abgesagt haben (höchstens vier).' })),
      footer: [button('Abbrechen', { onClick: () => m.close() }), save] });
  }

  // ── Aufträge ──
  const taskCard = (t) => {
    const [stl, stc] = TASK_STATUS[t.status], mineOpen = t.myState === 'open' || t.myState === 'accepted';
    const el = h('div', { class: `sch-task p-${t.priority} ${t.overdue ? 'over' : ''}`, tabindex: 0, role: 'button' },
      h('div', { class: 'grow' }, h('div', { class: 'sch-task-t' }, t.title), h('div', { class: 'sch-task-m' }, h('span', { class: t.overdue ? 'sch-over' : '' }, icon('clock'), dueText(t.dueAt, t.status === 'done' || t.status === 'cancelled')), t.event && h('span', null, icon('calendar'), t.event.title), h('span', null, t.number)),
        h('div', { class: 'sch-people' }, t.assignees.map((a) => h('span', { class: 'sch-person' }, a.label, badge(a.stateLabel, STATE_CLS[a.state], false))))),
      h('div', { class: 'sch-task-r' }, badge(t.priorityLabel, PRIO_CLS[t.priority]), badge(stl, stc),
        mineOpen && t.status !== 'cancelled' && h('div', { class: 'row', style: { gap: '4px' } }, t.myState === 'open' && button('Annehmen', { size: 'sm', onClick: (e) => { e.stopPropagation(); setState(t, 'accepted'); } }), button('Erledigt', { size: 'sm', variant: 'primary', icon: 'check', onClick: (e) => { e.stopPropagation(); doneDialog(t); } }))));
    el.addEventListener('click', () => openTask(t.id)); el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === el) openTask(t.id); });
    return el;
  };
  async function setState(t, state, note) { try { await api.post(`/api/schedule/tasks/${t.id}/state`, { state, note }); toast(state === 'accepted' ? 'Auftrag angenommen.' : state === 'done' ? 'Auftrag als erledigt gemeldet.' : 'Gespeichert.'); refresh(); return true; } catch (e) { toast(e.message, 'err'); return false; } }
  function doneDialog(t, after) {
    const note = textarea('', 3); const m = openModal({ title: `Erledigt: ${t.title}`, body: field('Notiz zur Erledigung (optional)', note, { help: 'z. B. was abgegeben wurde, Besonderheiten.' }), footer: [button('Abbrechen', { onClick: () => m.close() }), button('Als erledigt melden', { variant: 'primary', icon: 'check', onClick: async () => { if (await setState(t, 'done', note.value)) { m.close(); after?.(); } } })] });
  }
  function drawTasks() {
    tabsRow();
    const scopes = [{ id: 'mine', label: 'Meine Aufträge' }, ...(opt.canAssign || opt.canManage ? [{ id: 'created', label: 'Von mir vergeben' }] : []), ...(opt.canManage ? [{ id: 'all', label: 'Alle' }] : [])];
    const c = taskData.counts;
    const bar = h('div', { class: 'row', style: { alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' } },
      scopes.length > 1 ? tabs(scopes, scope, (s) => { scope = s; refresh(); }) : h('div'),
      tabs([{ id: 'open', label: 'Offen', count: c.open }, { id: 'closed', label: 'Abgeschlossen', count: c.closed }, { id: 'all', label: 'Alle', count: c.all }], status, (s) => { status = s; refresh(); }));
    mount(host, bar, taskData.tasks.length ? h('div', { class: 'stack' }, taskData.tasks.map(taskCard)) : h('div', { class: 'card card-body' }, empty(status === 'open' ? 'Keine offenen Aufträge' : 'Keine Aufträge', scope === 'mine' ? 'Dir wurde nichts zugewiesen.' : null, 'flag')));
  }
  async function openTask(id) {
    let t; try { t = (await api.get(`/api/schedule/tasks/${id}`)).task; } catch (e) { return toast(e.message, 'err'); }
    const [stl, stc] = TASK_STATUS[t.status], mine = t.assignees.find((a) => a.isMe), closed = ['done', 'cancelled'].includes(t.status);
    const reload = async () => { m.close(); await refresh(); openTask(id); };
    const m = openModal({ wide: true, title: `${t.number} · ${t.title}`,
      body: h('div', { class: 'stack' },
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, badge(t.priorityLabel, PRIO_CLS[t.priority]), badge(stl, stc)),
        h('div', { class: 'sch-facts' }, h('div', { class: t.overdue ? 'sch-over' : '' }, icon('clock'), dueText(t.dueAt, closed)), t.event && h('div', { class: 'link', onclick: () => { m.close(); openEvent(t.event.id); }, style: { cursor: 'pointer' } }, icon('calendar'), `Termin: ${t.event.title} (${fmtDateTime(t.event.startsAt)})`), h('div', { class: 'muted' }, `Vergeben von ${t.createdBy} am ${fmtDateTime(t.createdAt)}`)),
        t.description && h('div', { class: 'sch-text' }, t.description),
        h('div', null, h('div', { class: 'sch-sub' }, 'Beauftragte'), h('div', { class: 'stack' }, t.assignees.map((a) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, a.label), a.note && h('div', { class: 's' }, `„${a.note}“`)), badge(a.stateLabel, STATE_CLS[a.state]))))),
        mine && !closed && h('div', { class: 'sch-rsvp' }, h('span', null, 'Dein Status:'), mine.state === 'open' && button('Annehmen', { size: 'sm', icon: 'check', onClick: async () => { if (await setState(t, 'accepted')) reload(); } }), mine.state !== 'done' && button('Erledigt', { size: 'sm', variant: 'primary', icon: 'check', onClick: () => doneDialog(t, reload) }), mine.state !== 'declined' && mine.state !== 'done' && button('Ablehnen', { size: 'sm', icon: 'x', onClick: async () => { if (await confirmDialog({ title: 'Auftrag ablehnen?', message: 'Der Auftraggeber wird informiert.', confirmLabel: 'Ablehnen' })) { if (await setState(t, 'declined')) reload(); } } }), mine.state === 'done' && button('Wieder öffnen', { size: 'sm', icon: 'refresh', onClick: async () => { if (await setState(t, 'accepted')) reload(); } }))),
      footer: [t.canEdit && button('', { icon: 'trash', variant: 'ghost', title: 'Auftrag löschen', onClick: async () => { if (await confirmDialog({ title: 'Auftrag löschen?', message: `${t.number} wird endgültig gelöscht.`, confirmLabel: 'Löschen' })) { try { await api.del(`/api/schedule/tasks/${t.id}`); m.close(); toast('Auftrag gelöscht.'); refresh(); } catch (e) { toast(e.message, 'err'); } } } }),
        h('span', { class: 'grow' }),
        t.canEdit && t.status !== 'cancelled' && button('Zurückziehen', { icon: 'x', onClick: async () => { if (await confirmDialog({ title: 'Auftrag zurückziehen?', message: 'Die Beauftragten werden benachrichtigt.', confirmLabel: 'Zurückziehen' })) { try { await api.patch(`/api/schedule/tasks/${t.id}`, { status: 'cancelled' }); reload(); } catch (e) { toast(e.message, 'err'); } } } }),
        t.canEdit && t.status === 'cancelled' && button('Wieder öffnen', { icon: 'refresh', onClick: async () => { try { await api.patch(`/api/schedule/tasks/${t.id}`, { status: 'reopen' }); reload(); } catch (e) { toast(e.message, 'err'); } } }),
        t.canEdit && button('Bearbeiten', { icon: 'edit', variant: 'primary', onClick: () => { m.close(); taskForm(t); } })] });
  }
  async function taskForm(t, preset = {}) {
    const err = h('div'), isNew = !t; let events = [];
    try { const a = new Date(); a.setDate(a.getDate() - 7); events = (await api.get(`/api/schedule/events?from=${encodeURIComponent(a.toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 120 * 86400_000).toISOString())}`)).events.filter((e) => e.status !== 'cancelled'); } catch { /* ohne Terminauswahl */ }
    const title = input({ value: t?.title ?? '', maxLength: 140, placeholder: 'Was wird beauftragt? z. B. 200 Weizen farmen' }), desc = textarea(t?.description ?? '', 4);
    const due = input({ type: 'datetime-local', value: toLocalInput(t?.dueAt ?? preset.dueAt) }), prio = select(opt.priorities, t?.priority ?? 'normal');
    const evSel = select([{ value: '', label: '– keinem Termin zugeordnet –' }, ...events.map((e) => ({ value: e.id, label: `${new Date(e.startsAt).toLocaleDateString('de-DE')} · ${e.title}` }))], t?.event?.id ?? preset.eventId ?? '');
    const picker = memberPicker((t?.assignees ?? []).map((a) => a.userId));
    const quick = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginTop: '6px' } }, [['In 1 Std.', 60], ['Heute 20 Uhr', 'today20'], ['Morgen', 1440], ['In 3 Tagen', 4320], ['In 1 Woche', 10080]].map(([l, v]) => button(l, { size: 'sm', onClick: () => { const d = v === 'today20' ? (() => { const x = new Date(); x.setHours(20, 0, 0, 0); return x; })() : new Date(Date.now() + v * 60000); due.value = toLocalInput(d.toISOString()); } })));
    const save = button('Speichern', { variant: 'primary', icon: 'check', onClick: () => busy(save, async () => {
      err.replaceChildren();
      try {
        const body = { title: title.value, description: desc.value, priority: prio.value, dueAt: due.value ? new Date(due.value).toISOString() : null, eventId: evSel.value ? Number(evSel.value) : null, assignees: picker.get() };
        isNew ? await api.post('/api/schedule/tasks', body) : await api.patch(`/api/schedule/tasks/${t.id}`, body);
        m.close(); toast(isNew ? 'Auftrag vergeben – die Beauftragten wurden benachrichtigt.' : 'Auftrag gespeichert.'); if (tab !== 'tasks') { tab = 'tasks'; scope = 'created'; status = 'open'; } refresh();
      } catch (e) { mount(err, formError(e.message)); }
    }) });
    const m = openModal({ wide: true, title: isNew ? 'Neuer Auftrag' : 'Auftrag bearbeiten', body: h('div', { class: 'stack' }, err, field('Auftrag *', title), field('Beschreibung', desc), h('div', { class: 'sch-two' }, field('Fällig bis', h('div', null, due, quick)), field('Priorität', prio)),
      field('Zugehöriger Termin (optional)', evSel), field('Beauftragte *', picker.el, { help: 'Jeder Beauftragte bekommt eine Benachrichtigung und meldet den Auftrag selbst als angenommen oder erledigt.' })), footer: [button('Abbrechen', { onClick: () => m.close() }), save] });
  }

  // ── Rahmen ──
  const myOpen = async () => { try { return (await api.get('/api/schedule/summary')).openTasks; } catch { return null; } };
  let openCount = await myOpen();
  function tabsRow() {
    mount(tabHost, tabs([{ id: 'calendar', label: 'Kalender' }, { id: 'tasks', label: 'Aufträge', count: openCount || undefined }], tab, (t) => { tab = t; refresh(); }));
    ctx.setActions(h('div', { class: 'row' }, opt.canAssign && button('Neuer Auftrag', { icon: 'flag', onClick: () => taskForm(null) }), opt.canCreate && button('Neuer Termin', { icon: 'plus', variant: 'primary', onClick: () => eventForm(null) })));
  }

  // Sprung aus einer Benachrichtigung
  const jump = () => { let t; try { t = JSON.parse(sessionStorage.getItem('mdt:schedule:open')); sessionStorage.removeItem('mdt:schedule:open'); } catch { t = null; } if (t?.taskId) { tab = 'tasks'; refresh().then(() => openTask(t.taskId)); } else if (t?.eventId) openEvent(t.eventId); };
  window.addEventListener('mdt:schedule-open', jump);
  ctx.live(['schedule'], async () => { openCount = await myOpen(); if (!document.querySelector('.modal-root')) refresh(); else tabsRow(); }, { wait: 400 });
  await refresh(); jump();
  return () => window.removeEventListener('mdt:schedule-open', jump);
}
