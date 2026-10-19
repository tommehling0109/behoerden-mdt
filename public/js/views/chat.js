import { h, mount, fmtDateTime } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, checkbox, toggle, formError, openModal, confirmDialog, toast, empty, skeletons, levelBadge } from '../ui/kit.js';
import { api } from '../api.js';
import { can, state } from '../state.js';

const CHANNEL_KEY = 'mdt:chat:channel';
const COLORS = ['#6b7280', '#5b82b8', '#22c4a8', '#f5a524', '#ef4444', '#a78bfa', '#f472b6', '#84cc16'];
const MENTION = /(@[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-\d+)/g;
const sameDay = (a, b) => a.toDateString() === b.toDateString();
const dayLabel = (d) => {
  const now = new Date(); const y = new Date(now); y.setDate(now.getDate() - 1);
  return sameDay(d, now) ? 'Heute' : sameDay(d, y) ? 'Gestern' : d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};
const hhmm = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/** Nachrichtentext: Erwähnungen (@MDT-220) hervorheben – alles andere bleibt reiner Text (kein HTML). */
function renderBody(text) {
  const me = (state.user.memberNumber ?? '').toUpperCase();
  return text.split(MENTION).map((part, i) => (i % 2 ? h('span', { class: `mention ${part.slice(1).toUpperCase() === me ? 'me' : ''}` }, part) : part)); // ungerade Teile = Erwähnungen (Capture-Gruppe)
}

/** Chat der Mitarbeiter (Standard) – und, mit { partner: true }, der Chat im Partner-Portal (gleiche Oberfläche, eigene Endpunkte). */
export default (container, ctx) => chatApp(container, ctx, {});

export async function chatApp(container, ctx, o = {}) {
  const PARTNER = !!o.partner;
  const A = (p) => (PARTNER ? '/api/p/chat' : '/api/chat') + p;
  const canSend = PARTNER || can('chat.send'), canPin = !PARTNER && can('chat.pin'), canManage = !PARTNER && can('chat.manage');
  let partnerOptions = [];
  let myTickets = [];
  let channels = [], dms = [];
  let current = Number(sessionStorage.getItem(CHANNEL_KEY)) || null;
  let data = { messages: [], pinned: [], hasMore: false, channel: null };
  let replyTo = null, editing = null, showPinned = false;

  const side = h('aside', { class: 'chat-side' });
  const head = h('div', { class: 'chat-head' });
  const pinnedBar = h('div', { class: 'chat-pinned', hidden: true });
  const scroller = h('div', { class: 'chat-scroll' });
  const banner = h('div', { class: 'chat-banner', hidden: true });
  const ta = h('textarea', { class: 'textarea chat-input', rows: 1, maxLength: 2000, placeholder: 'Nachricht schreiben … (Enter = senden, Shift+Enter = neue Zeile)', disabled: !canSend });
  const sendBtn = button('', { variant: 'primary', icon: 'check', title: 'Senden', disabled: !canSend });
  const composer = h('div', { class: 'chat-composer' }, banner, h('div', { class: 'row', style: { alignItems: 'flex-end', flexWrap: 'nowrap' } }, ta, sendBtn));
  const main = h('section', { class: 'chat-main' }, head, pinnedBar, scroller, composer);
  mount(container, h('div', { class: 'chat' }, side, main));
  container.style.maxWidth = 'none';
  container.style.height = '100%';

  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };

  // ── Kanäle ──
  async function loadChannels() {
    let fresh = [];
    let first;
    [first, { dms: fresh }] = await Promise.all([api.get(A('/channels')), api.get(A('/dms'))]);
    ({ channels } = first); partnerOptions = first.partners ?? [];
    // noch leere, gerade geöffnete Privatchats in der Liste behalten, bis die erste Nachricht gesendet ist
    const keep = dms.filter((d) => d.keep && !fresh.some((f) => f.id === d.id));
    dms = [...fresh, ...keep];
    if (!channels.some((c) => c.id === current) && !dms.some((c) => c.id === current)) current = channels[0]?.id ?? dms[0]?.id ?? null;
    drawSide();
  }
  const allChats = () => [...channels, ...dms];
  async function openDm(p) {
    if (!p.partner && !PARTNER && p.id === state.user.id) throw new Error('Du kannst dir nicht selbst schreiben.');
    const { channel } = await api.post(A('/dms'), p.partner ? { partnerId: p.id } : { userId: p.id });
    if (!dms.some((d) => d.id === channel.id)) dms.unshift({ ...channel, keep: true });
    current = channel.id; replyTo = editing = null; setBanner(); sessionStorage.setItem(CHANNEL_KEY, String(current));
    drawSide(); await loadMessages({ initial: true }); ta.focus();
  }
  async function newDm() {
    let people = [];
    try { const r = await api.get(A('/people')); people = [...(r.partners ?? []).map((x) => ({ ...x, group: 'Externe Partner' })), ...r.people.filter((x) => PARTNER || x.id !== state.user.id).map((x) => ({ ...x, group: PARTNER ? 'Ansprechpartner im Team' : 'Mitglieder' }))]; } catch (e) { return toast(e.message, 'err'); }
    const q = input({ placeholder: 'Nummer suchen …' });
    const list = h('div', { class: 'people-list' });
    const draw = () => {
      const f = q.value.trim().toLowerCase();
      const rows = people.filter((p) => !f || `${p.label} ${p.subtitle ?? ''}`.toLowerCase().includes(f));
      let lastGroup = null;
      mount(list, rows.length ? rows.flatMap((p) => {
        const b = h('button', { type: 'button', class: 'list-row people-row' }, h('div', { class: 'dot-icon' }, icon('users')), h('div', { class: 'grow' }, h('div', { class: 't' }, p.label, ' ', levelBadge(p.level)), p.subtitle && h('div', { class: 's' }, p.subtitle)), icon('chevronR'));
        b.addEventListener('click', async () => { try { await openDm(p); m.close(); } catch (e) { toast(e.message, 'err'); } });
        const head = p.group !== lastGroup && (people.some((x) => x.group !== p.group)) ? h('div', { class: 'chat-side-title' }, p.group) : null;
        lastGroup = p.group;
        return [head, b].filter(Boolean);
      }) : empty('Niemand gefunden', people.length ? 'Prüfe die Dienstnummer.' : 'Es gibt noch keine weiteren Mitglieder mit Chat-Zugang.', 'users'));
    };
    q.addEventListener('input', draw);
    const m = openModal({ title: 'Neue Privatnachricht', body: h('div', null, h('div', { class: 'input-icon' }, icon('search'), q), h('div', { style: { height: '10px' } }), list), footer: [button('Abbrechen', { onClick: () => m.close() })] });
    draw();
  }
  function drawSide() {
    const row = (c, dm) => {
      const b = h('button', { class: `chat-chan ${c.id === current ? 'on' : ''}`, type: 'button', style: { '--c': c.color } },
        dm ? (c.peer?.avatar ? h('img', { class: 'avatar xs', src: c.peer.avatar, alt: '' }) : icon('users')) : h('span', { class: 'dot' }), h('span', { class: 'cn' }, !dm && c.restricted && icon('lockClosed'), c.name, dm && levelBadge(c.peer?.level, { label: false })), c.unread > 0 && h('span', { class: 'count hot' }, c.unread));
      b.addEventListener('click', () => { if (current !== c.id) { current = c.id; replyTo = editing = null; setBanner(); sessionStorage.setItem(CHANNEL_KEY, String(current)); drawSide(); loadMessages({ initial: true }); } });
      return b;
    };
    mount(side, h('div', { class: 'chat-side-title' }, 'Kanäle'),
      channels.map((c) => row(c, false)),
      h('div', { class: 'chat-side-title dm-title' }, 'Privatnachrichten'),
      canSend && h('div', { class: 'chat-newdm' }, button('Neue Privatnachricht', { size: 'sm', variant: 'primary', icon: 'plus', title: 'Kontakt auswählen und eine Privatnachricht starten', onClick: newDm })),
      dms.length ? dms.map((c) => row(c, true)) : h('div', { class: 'muted', style: { padding: '4px 14px 8px', fontSize: '12px' } }, canSend ? 'Noch keine Unterhaltungen – starte oben mit „Neue Privatnachricht“.' : 'Noch keine Unterhaltungen.'),
      !PARTNER && h('div', { class: 'chat-side-title dm-title' }, 'Meine Tickets', button('', { size: 'sm', variant: 'ghost', icon: 'plus', title: 'Fehler melden', onClick: () => import('./tickets.js').then((m) => m.openReportDialog({ app: 'Chat', onDone: loadTickets })) })),
      !PARTNER && (myTickets.length ? myTickets.slice(0, 8).map((t) => h('button', { class: 'chat-chan', type: 'button', style: { '--c': t.statusColor }, title: t.title,
        onclick: () => import('./tickets.js').then((m) => m.openTicketModal({ id: t.id, onChange: loadTickets })) }, h('span', { class: 'dot' }), h('span', { class: 'cn' }, `${t.number} · ${t.title}`), h('span', { class: 'muted', style: { fontSize: '11px' } }, t.statusLabel)))
        : h('div', { class: 'muted', style: { padding: '4px 14px 8px', fontSize: '12px' } }, 'Keine Tickets – mit + meldest du einen Fehler.')),
      canManage && h('div', { style: { padding: '8px' } }, button('Kanäle verwalten', { size: 'sm', icon: 'settings', onClick: manageChannels })));
  }

  // ── Nachrichten ──
  async function loadMessages({ initial = false } = {}) {
    if (!current) { mount(scroller, h('div', { class: 'chat-start' }, empty('Noch keine Unterhaltung', canSend ? 'Es ist noch kein Kanal für dich freigegeben. Starte eine Privatnachricht: Kontakt auswählen, dann schreiben.' : 'Es ist noch kein Kanal für dich freigegeben.', 'chat'), canSend && button('Neue Privatnachricht', { variant: 'primary', icon: 'plus', onClick: newDm }))); mount(head); return; }
    const stick = initial || nearBottom();
    const prevH = scroller.scrollHeight, prevTop = scroller.scrollTop;
    try { data = await api.get(A(`/channels/${current}/messages`)); } catch (e) { mount(scroller, empty('Nicht verfügbar', e.message, 'lock')); return; }
    if (!ctx.isCurrent()) return;
    drawHead(); drawMessages();
    if (stick) toBottom(); else scroller.scrollTop = prevTop + (scroller.scrollHeight - prevH) * 0;
    const last = data.messages.at(-1)?.id;
    if (last && document.visibilityState === 'visible') {
      api.post(A(`/channels/${current}/read`), { lastId: last }).then(() => { const c = allChats().find((x) => x.id === current); if (c && c.unread) { c.unread = 0; drawSide(); ctx.refreshCounters?.(); } }).catch(() => {});
    }
  }

  function drawHead() {
    const c = data.channel;
    const dm = c.kind === 'dm';
    mount(head, h('div', { class: 'grow' }, h('div', { class: 'ch-name' }, dm ? icon('users') : h('span', { class: 'dot', style: { '--c': c.color } }), dm ? h('span', { class: 'member-no' }, c.name) : c.name), c.description && h('div', { class: 'muted', style: { fontSize: '12px' } }, c.description)),
      c.pinnedCount > 0 && button(`${c.pinnedCount} angepinnt`, { size: 'sm', variant: showPinned ? 'primary' : 'ghost', icon: 'pin', onClick: () => { showPinned = !showPinned; drawHead(); drawMessages(); } }));
    pinnedBar.hidden = !showPinned || !data.pinned.length;
    mount(pinnedBar, data.pinned.map((m) => h('div', { class: 'pin-item', onclick: () => jumpTo(m.id) }, icon('pin'), h('b', null, m.sender), ' ', m.body.slice(0, 110))));
  }

  function jumpTo(id) {
    const el = scroller.querySelector(`[data-mid="${id}"]`);
    if (!el) return toast('Diese Nachricht liegt weiter oben – lade ältere Nachrichten.', 'info');
    el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400);
  }

  function drawMessages() {
    const nodes = [];
    if (data.hasMore) nodes.push(h('div', { class: 'chat-more' }, button('Ältere Nachrichten laden', { size: 'sm', variant: 'ghost', onClick: loadOlder })));
    let lastDay = null;
    for (const m of data.messages) {
      const d = new Date(m.createdAt);
      if (!lastDay || !sameDay(lastDay, d)) { nodes.push(h('div', { class: 'chat-day' }, h('span', null, dayLabel(d)))); lastDay = d; }
      nodes.push(messageEl(m));
    }
    if (!data.messages.length) nodes.push(empty('Noch keine Nachrichten', canSend ? (data.channel?.kind === 'dm' ? 'Schreibe die erste Privatnachricht.' : 'Schreibe die erste Nachricht in diesem Kanal.') : null, 'chat'));
    mount(scroller, nodes);
  }

  function messageEl(m) {
    const actions = h('div', { class: 'msg-actions' },
      canSend && !m.deleted && button('', { size: 'sm', variant: 'ghost', icon: 'reply', title: 'Antworten', onClick: () => startReply(m) }),
      canPin && !m.deleted && button('', { size: 'sm', variant: 'ghost', icon: 'pin', title: m.pinned ? 'Lösen' : 'Anpinnen', onClick: () => togglePin(m) }),
      m.canEdit && button('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Bearbeiten', onClick: () => startEdit(m) }),
      m.canDelete && button('', { size: 'sm', variant: 'ghost', icon: 'trash', title: 'Löschen', onClick: () => del(m) }));
    return h('div', { class: `msg ${m.isMine ? 'mine' : ''} ${m.deleted ? 'gone' : ''}`, 'data-mid': m.id },
      h('div', { class: 'msg-bubble' },
        h('div', { class: 'msg-meta' }, m.senderAvatar && h('img', { class: 'avatar xs', src: m.senderAvatar, alt: '', loading: 'lazy' }), h('span', { class: 'member-no' }, m.sender), levelBadge(m.senderLevel), m.isMine && h('span', { class: 'muted' }, 'Du'), m.pinned && h('span', { class: 'pinmark', title: 'Angepinnt' }, icon('pin')),
          h('span', { class: 'msg-time', title: fmtDateTime(m.createdAt) }, hhmm(m.createdAt)), m.editedAt && !m.deleted && h('span', { class: 'muted', title: `Bearbeitet ${fmtDateTime(m.editedAt)}` }, '(bearbeitet)')),
        m.replyTo && h('div', { class: 'msg-quote', onclick: () => jumpTo(m.replyTo.id) }, h('b', null, m.replyTo.sender), ' ', m.replyTo.snippet),
        h('div', { class: 'msg-body' }, m.deleted ? h('i', null, 'Nachricht gelöscht') : renderBody(m.body))),
      !m.deleted && actions);
  }

  async function loadOlder() {
    const first = data.messages[0]?.id;
    if (!first) return;
    const prevH = scroller.scrollHeight;
    const older = await api.get(A(`/channels/${current}/messages?before=${first}`));
    data.messages = [...older.messages, ...data.messages]; data.hasMore = older.hasMore;
    drawMessages();
    scroller.scrollTop = scroller.scrollHeight - prevH;
  }

  // ── Aktionen ──
  function setBanner() {
    banner.hidden = !replyTo && !editing;
    if (editing) mount(banner, icon('edit'), h('span', { class: 'grow' }, 'Nachricht bearbeiten'), button('', { size: 'sm', variant: 'ghost', icon: 'x', title: 'Abbrechen', onClick: cancelCompose }));
    else if (replyTo) mount(banner, icon('reply'), h('span', { class: 'grow' }, 'Antwort an ', h('b', null, replyTo.sender), ': ', replyTo.body.slice(0, 80)), button('', { size: 'sm', variant: 'ghost', icon: 'x', title: 'Abbrechen', onClick: cancelCompose }));
  }
  function cancelCompose() { replyTo = editing = null; ta.value = ''; setBanner(); }
  function startReply(m) { editing = null; replyTo = m; setBanner(); ta.focus(); }
  function startEdit(m) { replyTo = null; editing = m; ta.value = m.body; setBanner(); ta.focus(); }

  async function send() {
    const body = ta.value.trim();
    if (!current) return toast('Bitte zuerst einen Kontakt oder Kanal auswählen – mit „Neue Privatnachricht“ startest du einen Chat.', 'warn');
    if (!body) return;
    try {
      if (editing) await api.patch(A(`/messages/${editing.id}`), { body });
      else await api.post(A(`/channels/${current}/messages`), { body, replyTo: replyTo?.id });
      cancelCompose();
      await loadMessages({ initial: true });
    } catch (e) { toast(e.message, 'err'); }
  }
  sendBtn.addEventListener('click', send);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape' && (editing || replyTo)) cancelCompose();
  });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; });

  async function togglePin(m) {
    try { if (m.pinned) await api.del(A(`/messages/${m.id}/pin`)); else await api.post(A(`/messages/${m.id}/pin`)); await loadMessages(); } catch (e) { toast(e.message, 'err'); }
  }
  async function del(m) {
    const r = await confirmDialog({ title: 'Nachricht löschen?', message: m.isMine ? 'Deine Nachricht wird für alle gelöscht.' : 'Diese Nachricht wird als Moderator für alle gelöscht.', confirmLabel: 'Löschen' });
    if (!r) return;
    try { await api.del(A(`/messages/${m.id}`)); await loadMessages(); } catch (e) { toast(e.message, 'err'); }
  }

  // ── Kanal-Verwaltung ──
  async function manageChannels() {
    const body = h('div');
    const m = openModal({ title: 'Kanäle verwalten', wide: true, body, footer: [button('Fertig', { variant: 'primary', onClick: () => m.close() })] });
    const redraw = async () => {
      await loadChannels();
      mount(body, button('Kanal erstellen', { variant: 'primary', icon: 'plus', onClick: () => editChannel(null) }), h('div', { style: { height: '12px' } }),
        channels.map((c) => h('div', { class: 'list-row' }, h('span', { class: 'dot', style: { '--c': c.color, width: '10px', height: '10px', borderRadius: '50%', background: c.color } }),
          h('div', { class: 'grow' }, h('div', { class: 't' }, c.name, c.restricted && ' 🔒'), h('div', { class: 's' }, c.description || '–')),
          button('Bearbeiten', { size: 'sm', icon: 'edit', onClick: () => editChannel(c) }))));
    };
    async function editChannel(c) {
      let roles = [];
      try { roles = (await api.get('/api/roles')).roles; } catch { /* kein Recht auf Rollenliste */ }
      const err = h('div');
      const name = input({ value: c?.name ?? '', maxLength: 40 });
      const desc = input({ value: c?.description ?? '', maxLength: 200 });
      let color = c?.color ?? COLORS[1];
      const sw = h('div', { class: 'swatches' });
      const paint = () => mount(sw, COLORS.map((x) => h('button', { type: 'button', class: `swatch ${x === color ? 'on' : ''}`, style: { '--s': x }, 'aria-label': x, onclick: () => { color = x; paint(); } })));
      paint();
      const restricted = toggle('Nur für bestimmte Rollen sichtbar', c?.restricted ?? false);
      const boxes = roles.map((r) => [r, checkbox(h('span', null, r.name), c?.roleIds.includes(r.id) ?? false)]);
      const pBoxes = partnerOptions.map((p) => [p, checkbox(h('span', null, `${p.label} · ${p.name}${p.active ? '' : ' (inaktiv)'}`), c?.partnerIds?.includes(p.id) ?? false)]);
      const footer = [];
      if (c) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
        const r = await confirmDialog({ title: 'Kanal löschen?', message: `„${c.name}“ und alle Nachrichten darin werden endgültig gelöscht.`, confirmLabel: 'Löschen' });
        if (!r) return;
        try { await api.del(A(`/channels/${c.id}`)); em.close(); toast('Kanal gelöscht.'); redraw(); loadMessages({ initial: true }); } catch (e) { toast(e.message, 'err'); }
      } }));
      footer.push(h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => em.close() }), button(c ? 'Speichern' : 'Erstellen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
        err.replaceChildren();
        const payload = { name: name.value, description: desc.value, color, restricted: restricted.input.checked, roleIds: boxes.filter(([, x]) => x.input.checked).map(([r]) => r.id), partnerIds: pBoxes.filter(([, x]) => x.input.checked).map(([p]) => p.id) };
        try { if (c) await api.patch(A(`/channels/${c.id}`), payload); else await api.post(A('/channels'), payload); em.close(); toast('Gespeichert.'); redraw(); } catch (ex) { err.replaceChildren(formError(ex.message)); }
      }) }));
      const em = openModal({ title: c ? `Kanal: ${c.name}` : 'Neuer Kanal', body: h('div', null, err, h('div', { class: 'form-row' }, field('Name', name), field('Beschreibung', desc)), field('Farbe', sw), restricted,
        h('div', { class: 'help', style: { margin: '8px 0 6px' } }, 'Beschränkte Kanäle sehen nur Mitglieder mit einer der gewählten Rollen (Administratoren immer).'),
        boxes.map(([, x]) => x),
        pBoxes.length ? [h('div', { class: 'sep' }), h('div', { class: 'label', style: { margin: '0 0 6px' } }, 'Für externe Partner freigeben'), h('div', { class: 'help', style: { marginBottom: '6px' } }, 'Freigegebene Partner (Partner-App „Chat“) können in diesem Kanal lesen und schreiben – als Partnernummer.'), pBoxes.map(([, x]) => x)] : null), footer });
    }
    redraw();
  }

  // ── Start + Live ──
  mount(scroller, skeletons(4, 56));
  await loadChannels();
  await loadMessages({ initial: true });
  async function loadTickets() { if (PARTNER) return; try { myTickets = (await api.get('/api/tickets?mine=1')).tickets; drawSide(); } catch { /* ohne Tickets */ } }
  ctx.live(['tickets'], loadTickets, { wait: 300 });
  loadTickets();
  ctx.live(['chat', 'profile'], async () => { await loadChannels(); await loadMessages(); }, { wait: 120 });
  const onOpen = async () => { const id = Number(sessionStorage.getItem(CHANNEL_KEY)); if (id && id !== current) { current = id; await loadChannels(); await loadMessages({ initial: true }); } };
  window.addEventListener('mdt:chat-open', onOpen);
  const onVis = () => { if (document.visibilityState === 'visible') loadMessages(); };
  document.addEventListener('visibilitychange', onVis);
  return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('mdt:chat-open', onOpen); };
}
