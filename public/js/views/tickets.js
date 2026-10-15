import { h, mount, fmtDateTime, timeAgo, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, select, table, tabs, formError, openModal, confirmDialog, toast, skeletons, empty, note, badge } from '../ui/kit.js';
import { api } from '../api.js';
import { subscribe } from '../realtime.js';

/**
 * Ticketsystem (Fehler melden): Jedes Mitglied meldet Fehler, Ideen oder Fragen – mit Screenshot – und verfolgt sie hier und im Chat
 * unter „Meine Tickets“. Das Team (tickets.manage) sieht alle Tickets, setzt Status/Priorität/Zuständigkeit und antwortet.
 */
const statusBadge = (t) => h('span', { class: 'badge', style: { '--c': t.statusColor } }, t.statusLabel);
const PRIO = { low: 'b-mute', normal: 'b-info', high: 'b-err' };

/** Bild mittig begrenzen (max. 1600 px) und als JPEG/WebP verkleinern – Screenshots bleiben klein und schnell. */
async function prepareShot(file) {
  if (file.size > 12 * 1024 * 1024) throw new Error('Das Bild ist zu groß (max. 12 MB).');
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', 0.88);
}
/** Screenshot-Auswahl mit Vorschau; unterstützt auch Einfügen aus der Zwischenablage (Strg+V). */
function shotPicker() {
  let data = null;
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
  const preview = h('div', { class: 'shot-preview', hidden: true });
  const info = h('span', { class: 'muted' }, 'Kein Screenshot gewählt');
  const set = async (f) => {
    try { data = await prepareShot(f); preview.hidden = false; mount(preview, h('img', { src: data, alt: 'Screenshot-Vorschau' }), button('Entfernen', { size: 'sm', variant: 'ghost', icon: 'x', onClick: () => clear() })); info.textContent = 'Screenshot angehängt'; }
    catch (e) { toast(e.message || 'Das Bild konnte nicht verarbeitet werden.', 'err'); }
  };
  const clear = () => { data = null; preview.hidden = true; info.textContent = 'Kein Screenshot gewählt'; file.value = ''; };
  file.addEventListener('change', () => { if (file.files[0]) set(file.files[0]); });
  const paste = (e) => { const it = [...(e.clipboardData?.items ?? [])].find((x) => x.type.startsWith('image/')); if (it) { e.preventDefault(); set(it.getAsFile()); } };
  const el = h('div', null, h('div', { class: 'row', style: { alignItems: 'center' } }, file, button('Screenshot hochladen', { size: 'sm', icon: 'download', onClick: () => file.click() }), info), h('div', { class: 'help' }, 'Oder ein Bild aus der Zwischenablage einfügen (Strg+V).'), preview);
  return { el, data: () => data, clear, paste };
}

/** Neues Ticket melden – auch von überall (Kopfzeile) aufrufbar. */
export async function openReportDialog({ app = '', onDone, base = '/api/tickets' } = {}) {
  let opts; try { opts = await api.get(`${base}/options`); } catch (e) { return toast(e.message, 'err'); }
  const err = h('div');
  const title = input({ maxLength: 120, placeholder: 'Kurz beschreiben, was nicht funktioniert' });
  const cat = select(opts.categories.map((c) => ({ value: c.key, label: c.label })), 'bug');
  const desc = h('textarea', { class: 'textarea', rows: 6, maxLength: 4000, placeholder: 'Was hast du gemacht? Was ist passiert? Was hast du erwartet?' });
  const shot = shotPicker();
  const m = openModal({ title: 'Fehler melden / Ticket eröffnen', body: h('div', null, err, note(base === '/api/tickets' ? 'Dein Ticket sehen das Team und du – gemeldet wird unter deiner Personalnummer. Du findest es auch im Chat unter „Meine Tickets“.' : 'Dein Ticket sehen das Team und du – gemeldet wird unter deiner Partnernummer. Antworten findest du unter „Meine Tickets“ (Symbol oben rechts).', 'info'), h('div', { style: { height: '10px' } }),
    field('Art', cat), field('Titel', title), field('Beschreibung', desc), field('Screenshot (optional)', shot.el)),
  footer: [button('Abbrechen', { onClick: () => m.close() }), button('Ticket senden', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
    err.replaceChildren();
    try {
      const { ticket } = await api.post(base, { title: title.value, description: desc.value, category: cat.value, app: app || (document.querySelector('.win.active .wt')?.textContent ?? ''), screenshot: shot.data() ?? undefined });
      m.close(); toast(`Ticket ${ticket.number} wurde erstellt.`); onDone?.(ticket);
    } catch (ex) { err.replaceChildren(formError(ex.message)); }
  }) })] });
  m.el.addEventListener('paste', shot.paste);
}

/** Ticket-Detail (Verlauf, Antworten, Status). Wird in der Ticket-App und im Chat verwendet. */
export async function openTicketModal({ id, onChange, base = '/api/tickets' }) {
  const body = h('div', null, skeletons(3, 70)); let off;
  const m = openModal({ title: 'Ticket', wide: true, body, footer: null, onClose: () => off?.() });
  const footer = h('div', { class: 'modal-foot' }); m.el.append(footer);
  let opts; try { opts = await api.get(`${base}/options`); } catch { opts = { statuses: [], priorities: [], assignees: [] }; }
  const msg = h('textarea', { class: 'textarea', rows: 3, maxLength: 4000, placeholder: 'Antwort schreiben …' });
  const shot = shotPicker(); m.el.addEventListener('paste', shot.paste);
  async function reload() {
    let d; try { d = await api.get(`${base}/${id}`); } catch (e) { mount(body, note(e.message, 'alert')); mount(footer, h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() })); return; }
    const t = d.ticket;
    m.el.querySelector('.modal-head h3').textContent = `${t.number} · ${t.title}`;
    const patch = async (p) => { try { await api.patch(`${base}/${id}`, p); await reload(); onChange?.(); } catch (e) { toast(e.message, 'err'); } };
    const ctl = d.canManage ? h('div', { class: 'row', style: { margin: '10px 0', flexWrap: 'wrap' } },
      (() => { const s = select(opts.statuses.map((x) => ({ value: x.key, label: x.label })), t.status, { style: { width: '150px' } }); s.addEventListener('change', () => patch({ status: s.value })); return s; })(),
      (() => { const s = select(opts.priorities.map((x) => ({ value: x.key, label: `Priorität: ${x.label}` })), t.priority, { style: { width: '170px' } }); s.addEventListener('change', () => patch({ priority: s.value })); return s; })(),
      (() => { const s = select([{ value: '', label: '— niemand zuständig —' }, ...opts.assignees.map((x) => ({ value: x.id, label: x.label }))], t.assignee?.id ?? '', { style: { width: '190px' } }); s.addEventListener('change', () => patch({ assigneeId: s.value ? Number(s.value) : null })); return s; })())
      : h('div', { class: 'row', style: { margin: '10px 0' } }, t.status === 'closed' ? button('Wieder öffnen', { size: 'sm', icon: 'refresh', onClick: () => patch({ status: 'open' }) }) : button('Ticket schließen', { size: 'sm', icon: 'check', onClick: () => patch({ status: 'closed' }) }));
    const bubble = (who, text, time, cls, img) => h('div', { class: `tk-msg ${cls}` }, h('div', { class: 'tk-head' }, h('b', null, who), h('span', { class: 'muted' }, ` · ${fmtDateTime(time)}`)), h('div', { class: 'tk-body' }, text),
      img && h('a', { href: img, target: '_blank', rel: 'noopener' }, h('img', { class: 'tk-shot', src: img, alt: 'Screenshot', loading: 'lazy' })));
    mount(body, h('div', { class: 'chips', style: { marginBottom: '6px' } }, statusBadge(t), badge(t.categoryLabel, 'b-info', false), h('span', { class: `badge ${PRIO[t.priority]}` }, t.priorityLabel), t.app && badge(t.app, 'b-mute', false), t.assignee && badge(`Zuständig: ${t.assignee.label}`, 'b-ok', false)),
      ctl,
      bubble(`${t.reporter}${t.mine ? '' : ' (Melder)'}`, t.description, t.createdAt, 'first', t.hasScreenshot ? `${base}/${id}/screenshot` : null),
      d.comments.map((c) => bubble(c.mine ? 'Du' : `${c.author}${c.staff ? ' · Team' : ''}`, c.body, c.createdAt, c.mine ? 'mine' : 'other', c.hasScreenshot ? `${base}/${id}/comments/${c.id}/screenshot` : null)),
      t.status === 'closed' && !d.canManage ? note('Dieses Ticket ist geschlossen. Öffne es wieder, wenn du antworten möchtest.', 'info')
        : h('div', { class: 'composer', style: { marginTop: '12px' } }, msg, shot.el, h('div', { class: 'row', style: { marginTop: '8px' } }, button('Antworten', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
          if (!msg.value.trim()) return;
          try { await api.post(`${base}/${id}/comments`, { body: msg.value, screenshot: shot.data() ?? undefined }); msg.value = ''; shot.clear(); await reload(); onChange?.(); } catch (ex) { toast(ex.message, 'err'); }
        }) }))));
    mount(footer, d.canDelete && button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      if (!await confirmDialog({ title: 'Ticket endgültig löschen?', message: `${t.number} wird samt Antworten und Screenshots gelöscht.`, confirmLabel: 'Endgültig löschen' })) return;
      try { await api.del(`${base}/${id}`); m.close(); toast('Ticket gelöscht.'); onChange?.(); } catch (e) { toast(e.message, 'err'); }
    } }), h('span', { class: 'grow' }), button('Schließen', { onClick: () => m.close() }));
  }
  await reload();
  off = subscribe(['tickets'], () => reload(), { wait: 200 });
}

export default async function render(container, ctx) {
  const opts = await api.get('/api/tickets/options');
  const tabsList = [{ id: 'mine', label: 'Meine Tickets' }, opts.canManage && { id: 'all', label: 'Alle Tickets' }].filter(Boolean);
  let tab = opts.canManage ? 'all' : 'mine'; const f = { status: '', q: '' };
  const tabHost = h('div', { style: { marginBottom: '14px' } }), host = h('div');
  mount(container, tabHost, host);
  ctx.setActions(button('Neues Ticket', { variant: 'primary', icon: 'plus', onClick: () => openReportDialog({ onDone: () => show(tab, true) }) }));

  async function show(t, silent = false) {
    tab = t;
    if (!silent) mount(host, skeletons(3, 70));
    mount(tabHost, tabsList.length > 1 ? tabs(tabsList, tab, (x) => show(x)) : null);
    const p = new URLSearchParams(); if (tab === 'mine') p.set('mine', '1'); if (f.status) p.set('status', f.status); if (f.q) p.set('q', f.q);
    let rows; try { rows = (await api.get(`/api/tickets?${p}`)).tickets; } catch (e) { return mount(host, empty('Fehler beim Laden', e.message, 'alert')); }
    if (!ctx.isCurrent()) return;
    const chips = h('div', { class: 'count-chips' }, h('span', { class: 'chip-label' }, 'Status'), [['', 'Alle', '#94a3b8'], ...opts.statuses.map((s) => [s.key, s.label, s.color])].map(([k, label, color]) => {
      const b = h('button', { class: `cchip ${f.status === k ? 'on' : ''}`, type: 'button', style: { '--c': color } }, h('span', { class: 'dot' }), label);
      b.addEventListener('click', () => { f.status = k; show(tab, true); }); return b;
    }));
    const search = input({ type: 'search', placeholder: 'Titel oder Nummer …', value: f.q, style: { maxWidth: '260px' } }); search.addEventListener('input', debounce(() => { f.q = search.value.trim(); show(tab, true); }));
    mount(host, h('div', { class: 'toolbar' }, chips, h('div', { class: 'grow' }), search), table([
      { label: 'Nr.', style: { width: '1%' }, render: (x) => h('span', { class: 'member-no' }, x.number) },
      { label: 'Titel', render: (x) => h('div', null, h('b', null, x.title), h('div', { class: 'muted', style: { fontSize: '11.5px' } }, `${x.categoryLabel}${x.app ? ' · ' + x.app : ''}${x.hasScreenshot ? ' · 📎' : ''}`)) },
      tab === 'all' && { label: 'Melder', render: (x) => x.reporter }, { label: 'Priorität', render: (x) => h('span', { class: `badge ${PRIO[x.priority]}` }, x.priorityLabel) },
      { label: 'Status', render: statusBadge }, { label: 'Antworten', render: (x) => x.commentCount }, { label: 'Aktualisiert', render: (x) => h('span', { class: 'muted', title: fmtDateTime(x.updatedAt) }, timeAgo(x.updatedAt)) },
    ].filter(Boolean), rows, { onRowClick: (x) => openTicketModal({ id: x.id, onChange: () => show(tab, true) }), empty: empty('Keine Tickets', 'Mit „Neues Ticket“ meldest du einen Fehler – gern mit Screenshot.', 'flag') }));
  }

  const openFromTarget = () => { const id = Number(sessionStorage.getItem('mdt:tickets:open')); if (id) { sessionStorage.removeItem('mdt:tickets:open'); openTicketModal({ id, onChange: () => show(tab, true) }); } };
  window.addEventListener('mdt:tickets-open', openFromTarget);
  ctx.live(['tickets'], () => show(tab, true), { wait: 250 });
  await show(tab);
  openFromTarget();
  return () => window.removeEventListener('mdt:tickets-open', openFromTarget);
}

/** Externer Zugang: eigene Tickets ansehen, neues melden, Antworten lesen und beantworten. open = Ticket-ID, die direkt geöffnet wird. */
export async function openPartnerTickets({ open } = {}) {
  const BASE = '/api/p/tickets';
  if (open) return openTicketModal({ id: open, base: BASE });
  const body = h('div', null, skeletons(3, 60)); let off;
  const m = openModal({ title: 'Meine Tickets', wide: true, body, footer: [button('Schließen', { onClick: () => m.close() })], onClose: () => off?.() });
  async function load() {
    let rows; try { rows = (await api.get(BASE)).tickets; } catch (e) { return mount(body, empty('Fehler beim Laden', e.message, 'alert')); }
    mount(body, h('div', { class: 'toolbar' }, button('Neues Ticket', { variant: 'primary', icon: 'plus', onClick: () => openReportDialog({ base: BASE, onDone: load }) })),
      table([
        { label: 'Nr.', style: { width: '1%' }, render: (x) => h('span', { class: 'member-no' }, x.number) },
        { label: 'Titel', render: (x) => h('div', null, h('b', null, x.title), h('div', { class: 'muted', style: { fontSize: '11.5px' } }, `${x.categoryLabel}${x.app ? ' · ' + x.app : ''}`)) },
        { label: 'Status', render: statusBadge }, { label: 'Antworten', render: (x) => x.commentCount }, { label: 'Aktualisiert', render: (x) => h('span', { class: 'muted', title: fmtDateTime(x.updatedAt) }, timeAgo(x.updatedAt)) },
      ], rows, { onRowClick: (x) => openTicketModal({ id: x.id, base: BASE, onChange: load }), empty: empty('Noch keine Tickets', 'Mit „Neues Ticket“ meldest du einen Fehler – gern mit Screenshot.', 'flag') }));
  }
  off = subscribe(['tickets'], () => load(), { wait: 250 });
  await load();
}
