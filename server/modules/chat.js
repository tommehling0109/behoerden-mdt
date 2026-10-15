import { all, get, run, tx, now } from '../core/db.js';
import { levelBrief } from '../core/levels.js';
import { bad, conflict, forbidden, notFound, str, intList } from '../core/http.js';
import { audit } from '../core/audit.js';
import { publish } from '../core/realtime.js';
import { notify } from '../core/notifications.js';
import { memberLabel, labelForUser } from '../core/identity.js';
import { loadAccess } from '../core/permissions.js';
import { registerPartnerApp } from '../core/partner-apps.js';

/**
 * Chat: Kanäle (vom Admin angelegt, optional auf Rollen beschränkt und für externe Partner freigebbar), Privatnachrichten,
 * Nachrichten mit Antworten, Bearbeiten, Löschen, Anpinnen, Zeitstempel, Ungelesen-Zähler und Erwähnungen.
 * Absender erscheinen IMMER nur als Nummer (Mitglieder: Personalnummer, Partner: Partnernummer) – Namen werden nie ausgeliefert.
 *
 * „Betrachter“ (viewer): Mitarbeiter = der Benutzer selbst; externer Partner = { isPartner: true, partner }.
 * Externe Partner erreichen den Chat über die Partner-App „chat“: Privatnachrichten mit Mitgliedern, die das Recht
 * „chat.partners“ besitzen, und Kanäle, die ihnen ausdrücklich freigegeben wurden.
 */
registerPartnerApp({ id: 'chat', label: 'Chat', icon: 'chat', description: 'Nachrichten mit dem Team: Privatnachrichten und freigegebene Kanäle' });

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_LEN = 2000;

const senderLabel = (row) => {
  if (row.partner_id != null) return row.sender_partner_number || 'Partner';
  if (row.user_id == null) return 'Gelöschtes Mitglied';
  return memberLabel({ id: row.user_id, member_number: row.sender_number, status: row.sender_status });
};
const snippet = (t) => (t.length > 90 ? `${t.slice(0, 90)}…` : t);
const asPartner = (partner) => ({ isPartner: true, partner });

/** Sichtbare Kanäle: offene für alle mit chat.view, beschränkte nur für passende Rollen (Admins sehen alle). */
function visibleChannelIds(user) {
  if (user.isAdmin) return all("SELECT id FROM chat_channels WHERE kind = 'channel'").map((r) => r.id);
  const roleIds = user.roles.map((r) => r.id);
  return all("SELECT id, restricted FROM chat_channels WHERE kind = 'channel'").filter((c) => {
    if (!c.restricted) return true;
    if (!roleIds.length) return false;
    return !!get(`SELECT 1 x FROM chat_channel_roles WHERE channel_id = ? AND role_id IN (${roleIds.map(() => '?').join(',')})`, c.id, ...roleIds);
  }).map((c) => c.id);
}
const partnerChannelIds = (partner) => all('SELECT channel_id FROM chat_channel_partners WHERE partner_id = ?', partner.id).map((r) => r.channel_id);

function channelFor(v, id) {
  const ch = get('SELECT * FROM chat_channels WHERE id = ?', id);
  if (!ch) throw notFound('Kanal nicht gefunden.');
  if (v.isPartner) {
    const ok = ch.kind === 'dm' ? ch.dm_partner === v.partner.id : partnerChannelIds(v.partner).includes(ch.id);
    if (!ok) throw notFound('Kanal nicht gefunden.');
    return ch;
  }
  if (ch.kind === 'dm') { if (ch.dm_a !== v.id && ch.dm_b !== v.id) throw notFound('Kanal nicht gefunden.'); return ch; }
  if (!visibleChannelIds(v).includes(ch.id)) throw forbidden('Kein Zugriff auf diesen Kanal.');
  return ch;
}

const MSG_SQL = `SELECT m.*, u.member_number sender_number, u.status sender_status, u.avatar_ext sender_avatar_ext, u.avatar_version sender_avatar_v, pp.partner_number sender_partner_number
  FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN partners pp ON pp.id = m.partner_id`;
const isMine = (m, v) => (v.isPartner ? m.partner_id === v.partner.id : m.user_id === v.id);
function msgDto(m, v) {
  const deleted = !!m.deleted_at;
  let reply = null;
  if (m.reply_to) {
    const r = get(`${MSG_SQL} WHERE m.id = ?`, m.reply_to);
    if (r) reply = { id: r.id, sender: senderLabel(r), snippet: r.deleted_at ? 'Nachricht gelöscht' : snippet(r.body), deleted: !!r.deleted_at };
  }
  const mine = isMine(m, v);
  const kind = get('SELECT kind FROM chat_channels WHERE id = ?', m.channel_id)?.kind;
  return {
    id: m.id, channelId: m.channel_id, sender: senderLabel(m), senderLevel: m.partner_id != null && !v.isPartner ? levelBrief(m.partner_id) : null, senderAvatar: m.sender_avatar_ext ? `/api/avatars/${m.user_id}?v=${m.sender_avatar_v}` : null, isMine: mine, body: deleted ? '' : m.body, deleted,
    createdAt: m.created_at, editedAt: m.edited_at, pinned: !!m.pinned_at && !deleted, pinnedAt: m.pinned_at, replyTo: reply,
    canEdit: mine && !deleted, canDelete: !deleted && (mine || (!v.isPartner && v.perms.has('chat.moderate') && kind !== 'dm')),
  };
}

/** Gegenüber eines Privatchats aus Sicht des Betrachters (immer nur als Nummer; bei Partnern für Mitarbeiter zusätzlich der Partnername). */
function peerOf(c, v) {
  if (v.isPartner) return { label: labelForUser(c.dm_a, null) };
  if (c.dm_partner) {
    const p = get('SELECT partner_number, name FROM partners WHERE id = ?', c.dm_partner);
    return { id: c.dm_partner, partner: true, label: p?.partner_number ?? 'Partner', subtitle: p?.name ?? '', level: levelBrief(c.dm_partner) };
  }
  const id = c.dm_a === v.id ? c.dm_b : c.dm_a;
  const a = get('SELECT avatar_ext, avatar_version FROM users WHERE id = ?', id);
  return { id, label: labelForUser(id, v.id), avatar: a?.avatar_ext ? `/api/avatars/${id}?v=${a.avatar_version}` : null };
}
const channelDto = (c, v) => {
  const dm = c.kind === 'dm';
  const peer = dm ? peerOf(c, v) : null;
  const unread = v.isPartner
    ? get('SELECT COUNT(*) c FROM chat_messages WHERE channel_id = ? AND id > ? AND (partner_id IS NULL OR partner_id != ?) AND deleted_at IS NULL', c.id,
      get('SELECT COALESCE(last_read_id,0) l FROM chat_partner_reads WHERE channel_id = ? AND partner_id = ?', c.id, v.partner.id)?.l ?? 0, v.partner.id).c
    : get('SELECT COUNT(*) c FROM chat_messages WHERE channel_id = ? AND id > ? AND COALESCE(user_id,0) != ? AND deleted_at IS NULL', c.id,
      get('SELECT COALESCE(last_read_id,0) l FROM chat_reads WHERE channel_id = ? AND user_id = ?', c.id, v.id)?.l ?? 0, v.id).c;
  const out = {
    id: c.id, kind: c.kind, name: dm ? peer.label : c.name, peer, description: dm ? (peer.subtitle || 'Privatnachricht') : c.description, color: dm ? '#5b82b8' : c.color,
    restricted: !!c.restricted, sortOrder: c.sort_order, unread,
    pinnedCount: get('SELECT COUNT(*) c FROM chat_messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL', c.id).c,
    lastMessageAt: get('SELECT MAX(created_at) t FROM chat_messages WHERE channel_id = ? AND deleted_at IS NULL', c.id).t,
  };
  if (!v.isPartner) {
    out.roleIds = all('SELECT role_id FROM chat_channel_roles WHERE channel_id = ?', c.id).map((r) => r.role_id);
    out.partnerIds = all('SELECT partner_id FROM chat_channel_partners WHERE channel_id = ?', c.id).map((r) => r.partner_id);
  }
  return out;
};

/** Kanäle: alle mit chat.view (und freigegebene Partner) bekommen den Hinweis. Privatnachrichten: nur die Beteiligten (Live-Ereignis je Person). */
const changed = (channelId, kind) => {
  const c = get('SELECT kind, dm_a, dm_b, dm_partner FROM chat_channels WHERE id = ?', channelId);
  const base = { topic: 'chat', kind, entityType: 'channel', entityId: channelId };
  if (c?.kind === 'dm') {
    for (const uid of [c.dm_a, c.dm_b].filter((x) => x != null)) publish({ ...base, staff: 1, userId: uid });
    if (c.dm_partner) publish({ ...base, staff: 0, partnerScope: `id:${c.dm_partner}` });
    return;
  }
  publish({ ...base, staff: 1, staffPerm: 'chat.view' });
  for (const p of all('SELECT partner_id FROM chat_channel_partners WHERE channel_id = ?', channelId)) publish({ ...base, staff: 0, partnerScope: `id:${p.partner_id}` });
};

/** @MDT-220 in einer Nachricht benachrichtigt das Mitglied (sofern es den Kanal sehen darf). */
function notifyMentions(msg, channel, sender) {
  const found = new Set((msg.body.match(/@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-\d+)/g) ?? []).map((m) => m.slice(1).toUpperCase()));
  for (const num of found) {
    const u = get('SELECT id FROM users WHERE UPPER(member_number) = ? AND status = ?', num, 'active');
    if (!u || u.id === sender.id) continue;
    const acc = loadAccess(u.id);
    if (!acc.perms.has('chat.view')) continue;
    const peer = { isAdmin: acc.isAdmin, roles: acc.roles };
    if (!visibleChannelIds(peer).includes(channel.id)) continue;
    notify([{ type: 'user', id: u.id }], { key: `chat:${msg.id}:${u.id}`, title: `Erwähnung in #${channel.name}`, body: `${sender.memberNumber ?? 'Mitglied'}: ${snippet(msg.body)}`, target: { app: 'chat', channelId: channel.id, messageId: msg.id } });
  }
}

const partnerOk = (id) => {
  const p = get("SELECT id, status, apps, partner_number, name FROM partners WHERE id = ?", id);
  if (!p || p.status !== 'active') return null;
  let apps = [];
  try { apps = JSON.parse(p.apps); } catch { /* leer */ }
  return apps.includes('chat') ? p : null;
};

// ── gemeinsame Logik für Mitarbeiter und Partner ──
function listMessages(v, channelId, query) {
  const ch = channelFor(v, channelId);
  const limit = Math.min(Math.max(parseInt(query.limit) || 60, 1), 200);
  const before = Number(query.before) || null;
  const rows = all(`${MSG_SQL} WHERE m.channel_id = ? ${before ? 'AND m.id < ?' : ''} ORDER BY m.id DESC LIMIT ?`, ch.id, ...(before ? [before] : []), limit + 1);
  const pinned = all(`${MSG_SQL} WHERE m.channel_id = ? AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL ORDER BY m.pinned_at DESC LIMIT 50`, ch.id).map((m) => msgDto(m, v));
  return { channel: channelDto(ch, v), messages: rows.slice(0, limit).reverse().map((m) => msgDto(m, v)), pinned, hasMore: rows.length > limit };
}

function postMessage(v, channelId, b) {
  const ch = channelFor(v, channelId);
  const body = str(b.body, 'Nachricht', { min: 1, max: MAX_LEN });
  let reply = null;
  if (b.replyTo != null) {
    reply = get('SELECT id FROM chat_messages WHERE id = ? AND channel_id = ?', b.replyTo, ch.id)?.id;
    if (!reply) throw bad('Die Nachricht, auf die du antwortest, existiert nicht mehr.');
  }
  if (ch.kind === 'dm' && ch.dm_partner && !v.isPartner && !partnerOk(ch.dm_partner)) throw conflict('Dieser Partner-Zugang ist nicht aktiv oder hat keinen Chat-Zugriff.');
  const id = tx(() => {
    const res = v.isPartner
      ? run('INSERT INTO chat_messages (channel_id,partner_id,body,reply_to,created_at) VALUES (?,?,?,?,?)', ch.id, v.partner.id, body, reply, now())
      : run('INSERT INTO chat_messages (channel_id,user_id,body,reply_to,created_at) VALUES (?,?,?,?,?)', ch.id, v.id, body, reply, now());
    const mid = Number(res.lastInsertRowid);
    if (v.isPartner) run('INSERT INTO chat_partner_reads (channel_id,partner_id,last_read_id) VALUES (?,?,?) ON CONFLICT(channel_id,partner_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)', ch.id, v.partner.id, mid);
    else run('INSERT INTO chat_reads (channel_id,user_id,last_read_id) VALUES (?,?,?) ON CONFLICT(channel_id,user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)', ch.id, v.id, mid);
    if (ch.kind === 'dm') {
      const target = { app: 'chat', channelId: ch.id, messageId: mid };
      const key = `dm:${mid}`;
      if (v.isPartner) notify([{ type: 'user', id: ch.dm_a }], { key, title: 'Neue Privatnachricht', body: `${v.partner.number}: ${snippet(body)}`, target });
      else if (ch.dm_partner) notify([{ type: 'partner', id: ch.dm_partner }], { key, title: 'Neue Privatnachricht', body: `${v.memberNumber ?? 'Mitglied'}: ${snippet(body)}`, target });
      else notify([{ type: 'user', id: ch.dm_a === v.id ? ch.dm_b : ch.dm_a }], { key, title: 'Neue Privatnachricht', body: `${v.memberNumber ?? 'Mitglied'}: ${snippet(body)}`, target });
    } else if (!v.isPartner) notifyMentions({ id: mid, body }, ch, v);
    changed(ch.id, 'message');
    return mid;
  });
  return msgDto(get(`${MSG_SQL} WHERE m.id = ?`, id), v);
}

function ownMessage(v, id) {
  const m = get(`${MSG_SQL} WHERE m.id = ?`, id);
  if (!m) throw notFound('Nachricht nicht gefunden.');
  channelFor(v, m.channel_id);
  return m;
}
function editMessage(v, id, b) {
  const m = ownMessage(v, id);
  if (!isMine(m, v)) throw forbidden('Du kannst nur eigene Nachrichten bearbeiten.');
  if (m.deleted_at) throw conflict('Die Nachricht wurde gelöscht.');
  run('UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?', str(b.body, 'Nachricht', { min: 1, max: MAX_LEN }), now(), m.id);
  changed(m.channel_id, 'edit');
  return msgDto(get(`${MSG_SQL} WHERE m.id = ?`, m.id), v);
}
function markRead(v, channelId, lastId) {
  const ch = channelFor(v, channelId);
  const last = Number.isInteger(lastId) ? lastId : get('SELECT COALESCE(MAX(id),0) m FROM chat_messages WHERE channel_id = ?', ch.id).m;
  const prev = v.isPartner ? get('SELECT last_read_id l FROM chat_partner_reads WHERE channel_id = ? AND partner_id = ?', ch.id, v.partner.id)?.l ?? 0 : get('SELECT last_read_id l FROM chat_reads WHERE channel_id = ? AND user_id = ?', ch.id, v.id)?.l ?? 0;
  if (last > prev) { // Ungelesen-Zähler in anderen Tabs/Geräten derselben Person sofort aktualisieren
    const base = { topic: 'chat', kind: 'read', entityType: 'channel', entityId: ch.id };
    if (v.isPartner) publish({ ...base, staff: 0, partnerScope: `id:${v.partner.id}` }); else publish({ ...base, staff: 1, userId: v.id });
  }
  if (v.isPartner) run('INSERT INTO chat_partner_reads (channel_id,partner_id,last_read_id) VALUES (?,?,?) ON CONFLICT(channel_id,partner_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)', ch.id, v.partner.id, last);
  else run('INSERT INTO chat_reads (channel_id,user_id,last_read_id) VALUES (?,?,?) ON CONFLICT(channel_id,user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)', ch.id, v.id, last);
}

/** Mitglieder, die externe Partner anschreiben dürfen / von Partnern angeschrieben werden dürfen. */
const partnerContacts = () => all("SELECT id FROM users WHERE status = 'active' ORDER BY member_number").filter((u) => loadAccess(u.id).perms.has('chat.partners'));

export default {
  name: 'chat',
  permissions: [
    ['chat.view', 'Chat öffnen und lesen'],
    ['chat.send', 'Chat: Nachrichten schreiben, eigene bearbeiten/löschen'],
    ['chat.pin', 'Chat: Nachrichten anpinnen'],
    ['chat.moderate', 'Chat: Nachrichten anderer löschen'],
    ['chat.manage', 'Chat: Kanäle erstellen, bearbeiten, löschen'],
    ['chat.partners', 'Chat: mit externen Partnern schreiben (Ansprechpartner für Partner)'],
  ],
  init() {
    if (!get("SELECT 1 x FROM chat_channels WHERE kind = 'channel'")) run('INSERT INTO chat_channels (name,description,color,sort_order,restricted,created_at) VALUES (?,?,?,?,0,?)', 'Allgemein', 'Allgemeiner Kanal für alle Mitglieder', '#6b7280', 1, now());
  },
  routes(r) {
    // ══ Mitarbeiter ══
    r.get('/api/chat/channels', { perm: 'chat.view' }, (ctx) => {
      const ids = visibleChannelIds(ctx.user);
      const rows = all("SELECT * FROM chat_channels WHERE kind = 'channel' ORDER BY sort_order, name").filter((c) => ids.includes(c.id));
      const out = { channels: rows.map((c) => channelDto(c, ctx.user)) };
      if (ctx.user.perms.has('chat.manage')) out.partners = all("SELECT id, partner_number, name, status, apps FROM partners ORDER BY partner_number").filter((p) => { try { return JSON.parse(p.apps).includes('chat'); } catch { return false; } }).map((p) => ({ id: p.id, label: p.partner_number, name: p.name,  level: levelBrief(p.id), active: p.status === 'active' }));
      return out;
    });
    r.get('/api/chat/unread', { perm: 'chat.view' }, (ctx) => {
      const ids = visibleChannelIds(ctx.user);
      const rows = all('SELECT * FROM chat_channels').filter((c) => (c.kind === 'dm' ? c.dm_a === ctx.user.id || c.dm_b === ctx.user.id : ids.includes(c.id)));
      return { unread: rows.reduce((a, c) => a + channelDto(c, ctx.user).unread, 0) };
    });

    // Privatnachrichten
    /** Alle aktiven Mitglieder mit Chat-Zugang – ausschließlich als Personalnummer (Anonymität). Mit chat.partners zusätzlich externe Partner (Partnernummer). */
    r.get('/api/chat/people', { perm: 'chat.view' }, (ctx) => ({
      people: all(`SELECT id FROM users WHERE status = 'active' AND id != ? ORDER BY member_number`, ctx.user.id)
        .filter((u) => loadAccess(u.id).perms.has('chat.view')).map((u) => ({ id: u.id, label: labelForUser(u.id, ctx.user.id) })),
      partners: ctx.user.perms.has('chat.partners')
        ? all("SELECT id FROM partners WHERE status = 'active' ORDER BY partner_number").map((p) => partnerOk(p.id)).filter(Boolean).map((p) => ({ id: p.id, label: p.partner_number, subtitle: p.name, partner: true, level: levelBrief(p.id) }))
        : [],
    }));
    r.get('/api/chat/dms', { perm: 'chat.view' }, (ctx) => {
      const rows = all("SELECT * FROM chat_channels WHERE kind = 'dm' AND (dm_a = ? OR dm_b = ?)", ctx.user.id, ctx.user.id);
      const dms = rows.map((c) => channelDto(c, ctx.user)).filter((c) => c.lastMessageAt).sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1));
      return { dms };
    });
    r.post('/api/chat/dms', { perm: 'chat.send' }, (ctx) => {
      if (ctx.body.partnerId != null) {
        if (!ctx.user.perms.has('chat.partners')) throw forbidden('Für Nachrichten an externe Partner fehlt dir das Recht „chat.partners“.');
        const p = partnerOk(ctx.body.partnerId);
        if (!p) throw bad('Dieser Partner ist nicht aktiv oder hat keinen Chat-Zugriff.');
        let ch = get("SELECT * FROM chat_channels WHERE kind = 'dm' AND dm_a = ? AND dm_partner = ?", ctx.user.id, p.id);
        if (!ch) {
          run("INSERT INTO chat_channels (name,description,color,sort_order,restricted,created_at,kind,dm_a,dm_partner) VALUES (?,?,?,?,1,?,'dm',?,?)", `dmp:${ctx.user.id}:${p.id}`, '', '#5b82b8', 0, now(), ctx.user.id, p.id);
          ch = get("SELECT * FROM chat_channels WHERE kind = 'dm' AND dm_a = ? AND dm_partner = ?", ctx.user.id, p.id);
        }
        return { channel: channelDto(ch, ctx.user) };
      }
      const peer = get("SELECT id FROM users WHERE id = ? AND status = 'active'", ctx.body.userId);
      if (!peer) throw bad('Unbekanntes Mitglied.');
      if (peer.id === ctx.user.id) throw bad('Du kannst dir nicht selbst schreiben.');
      if (!loadAccess(peer.id).perms.has('chat.view')) throw bad('Dieses Mitglied hat keinen Chat-Zugang.');
      const [a, b] = [ctx.user.id, peer.id].sort((x, y) => x - y);
      let ch = get("SELECT * FROM chat_channels WHERE kind = 'dm' AND dm_a = ? AND dm_b = ?", a, b);
      if (!ch) {
        run("INSERT INTO chat_channels (name,description,color,sort_order,restricted,created_at,kind,dm_a,dm_b) VALUES (?,?,?,?,1,?,'dm',?,?)", `dm:${a}:${b}`, '', '#5b82b8', 0, now(), a, b);
        ch = get("SELECT * FROM chat_channels WHERE kind = 'dm' AND dm_a = ? AND dm_b = ?", a, b);
      }
      return { channel: channelDto(ch, ctx.user) };
    });

    r.get('/api/chat/channels/:id/messages', { perm: 'chat.view' }, (ctx) => listMessages(ctx.user, Number(ctx.params.id), ctx.query));
    r.post('/api/chat/channels/:id/messages', { perm: 'chat.send' }, (ctx) => { const message = postMessage(ctx.user, Number(ctx.params.id), ctx.body); ctx.status = 201; return { message }; });
    r.patch('/api/chat/messages/:id', { perm: 'chat.send' }, (ctx) => ({ message: editMessage(ctx.user, Number(ctx.params.id), ctx.body) }));

    r.delete('/api/chat/messages/:id', { perm: 'chat.view' }, (ctx) => {
      const m = ownMessage(ctx.user, Number(ctx.params.id));
      const mine = m.user_id === ctx.user.id;
      const dm = get('SELECT kind FROM chat_channels WHERE id = ?', m.channel_id)?.kind === 'dm';
      if (!mine && (dm || !ctx.user.perms.has('chat.moderate'))) throw forbidden('Dafür fehlt dir die Berechtigung.');
      if (mine && !ctx.user.perms.has('chat.send') && !ctx.user.perms.has('chat.moderate')) throw forbidden();
      if (m.deleted_at) return { ok: true };
      run('UPDATE chat_messages SET body = ?, deleted_at = ?, deleted_by = ?, pinned_at = NULL, pinned_by = NULL WHERE id = ?', '', now(), ctx.user.id, m.id);
      if (!mine) audit(ctx, { action: 'chat.message_deleted', module: 'chat', targetType: 'channel', targetId: m.channel_id, targetLabel: `Nachricht #${m.id}` });
      else changed(m.channel_id, 'delete');
      return { ok: true };
    });

    r.post('/api/chat/messages/:id/pin', { perm: 'chat.pin' }, (ctx) => {
      const m = ownMessage(ctx.user, Number(ctx.params.id));
      if (m.deleted_at) throw conflict('Gelöschte Nachrichten lassen sich nicht anpinnen.');
      run('UPDATE chat_messages SET pinned_at = ?, pinned_by = ? WHERE id = ?', now(), ctx.user.id, m.id);
      changed(m.channel_id, 'pin');
      return { message: msgDto(get(`${MSG_SQL} WHERE m.id = ?`, m.id), ctx.user) };
    });
    r.delete('/api/chat/messages/:id/pin', { perm: 'chat.pin' }, (ctx) => {
      const m = ownMessage(ctx.user, Number(ctx.params.id));
      run('UPDATE chat_messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?', m.id);
      changed(m.channel_id, 'pin');
      return { ok: true };
    });

    r.post('/api/chat/channels/:id/read', { perm: 'chat.view' }, (ctx) => { markRead(ctx.user, Number(ctx.params.id), ctx.body.lastId); return { ok: true }; });

    // ── Kanal-Verwaltung ──
    const fields = (b, partial) => {
      const out = {};
      if (!partial || b.name !== undefined) out.name = str(b.name, 'Name', { min: 2, max: 40 });
      if (!partial || b.description !== undefined) out.description = str(b.description, 'Beschreibung', { max: 200, required: false });
      if (b.color !== undefined) { if (!COLOR_RE.test(b.color)) throw bad('Ungültige Farbe.'); out.color = b.color; }
      if (b.restricted !== undefined) out.restricted = b.restricted ? 1 : 0;
      return out;
    };
    const setRoles = (id, roleIds) => {
      run('DELETE FROM chat_channel_roles WHERE channel_id = ?', id);
      for (const rid of roleIds) { if (!get('SELECT 1 x FROM roles WHERE id = ?', rid)) throw bad('Unbekannte Rolle.'); run('INSERT INTO chat_channel_roles (channel_id,role_id) VALUES (?,?)', id, rid); }
    };
    const setPartners = (id, partnerIds) => {
      run('DELETE FROM chat_channel_partners WHERE channel_id = ?', id);
      for (const pid of partnerIds) { if (!get('SELECT 1 x FROM partners WHERE id = ?', pid)) throw bad('Unbekannter Partner.'); run('INSERT INTO chat_channel_partners (channel_id,partner_id) VALUES (?,?)', id, pid); }
    };
    r.post('/api/chat/channels', { perm: 'chat.manage' }, (ctx) => {
      const f = fields(ctx.body, false);
      if (get('SELECT 1 x FROM chat_channels WHERE name = ?', f.name)) throw conflict('Ein Kanal mit diesem Namen existiert bereits.');
      const id = tx(() => {
        const max = get('SELECT COALESCE(MAX(sort_order),0) m FROM chat_channels').m;
        const res = run('INSERT INTO chat_channels (name,description,color,sort_order,restricted,created_at) VALUES (?,?,?,?,?,?)', f.name, f.description ?? '', f.color ?? '#6b7280', max + 1, f.restricted ?? 0, now());
        setRoles(Number(res.lastInsertRowid), intList(ctx.body.roleIds, 'Rollen'));
        if (ctx.body.partnerIds !== undefined) setPartners(Number(res.lastInsertRowid), intList(ctx.body.partnerIds, 'Partner'));
        return Number(res.lastInsertRowid);
      });
      audit(ctx, { action: 'chat.channel_created', module: 'chat', targetType: 'channel', targetId: id, targetLabel: f.name });
      ctx.status = 201;
      return { channel: channelDto(get('SELECT * FROM chat_channels WHERE id = ?', id), ctx.user) };
    });
    r.patch('/api/chat/channels/:id', { perm: 'chat.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get("SELECT * FROM chat_channels WHERE id = ? AND kind = 'channel'", id);
      if (!cur) throw notFound('Kanal nicht gefunden.');
      const f = fields(ctx.body, true);
      if (f.name && get('SELECT 1 x FROM chat_channels WHERE name = ? AND id != ?', f.name, id)) throw conflict('Ein Kanal mit diesem Namen existiert bereits.');
      tx(() => {
        const cols = Object.keys(f);
        if (cols.length) run(`UPDATE chat_channels SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => f[c]), id);
        if (ctx.body.roleIds !== undefined) setRoles(id, intList(ctx.body.roleIds, 'Rollen'));
        if (ctx.body.partnerIds !== undefined) setPartners(id, intList(ctx.body.partnerIds, 'Partner'));
      });
      audit(ctx, { action: 'chat.channel_updated', module: 'chat', targetType: 'channel', targetId: id, targetLabel: f.name ?? cur.name });
      return { channel: channelDto(get('SELECT * FROM chat_channels WHERE id = ?', id), ctx.user) };
    });
    r.delete('/api/chat/channels/:id', { perm: 'chat.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get("SELECT * FROM chat_channels WHERE id = ? AND kind = 'channel'", id);
      if (!cur) throw notFound('Kanal nicht gefunden.');
      if (get("SELECT COUNT(*) c FROM chat_channels WHERE kind = 'channel'").c <= 1) throw conflict('Der letzte Kanal kann nicht gelöscht werden.');
      run('DELETE FROM chat_channels WHERE id = ?', id);
      audit(ctx, { action: 'chat.channel_deleted', module: 'chat', targetType: 'channel', targetId: id, targetLabel: cur.name });
      return { ok: true };
    });

    // ══ Externe Partner (Partner-App „chat“) ══
    const P = { auth: 'partner', partnerApp: 'chat' };
    const pv = (ctx) => asPartner(ctx.partner);
    r.get('/api/p/chat/channels', P, (ctx) => {
      const ids = partnerChannelIds(ctx.partner);
      return { channels: all("SELECT * FROM chat_channels WHERE kind = 'channel' ORDER BY sort_order, name").filter((c) => ids.includes(c.id)).map((c) => channelDto(c, pv(ctx))) };
    });
    r.get('/api/p/chat/dms', P, (ctx) => ({
      dms: all("SELECT * FROM chat_channels WHERE kind = 'dm' AND dm_partner = ?", ctx.partner.id).map((c) => channelDto(c, pv(ctx))).filter((c) => c.lastMessageAt).sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1)),
    }));
    /** Ansprechpartner: nur Mitglieder mit dem Recht „chat.partners“ – als Personalnummer. */
    r.get('/api/p/chat/people', P, () => ({ people: partnerContacts().map((u) => ({ id: u.id, label: labelForUser(u.id, null) })) }));
    r.get('/api/p/chat/unread', P, (ctx) => {
      const ids = partnerChannelIds(ctx.partner);
      const rows = all('SELECT * FROM chat_channels').filter((c) => (c.kind === 'dm' ? c.dm_partner === ctx.partner.id : ids.includes(c.id)));
      return { unread: rows.reduce((a, c) => a + channelDto(c, pv(ctx)).unread, 0) };
    });
    r.post('/api/p/chat/dms', P, (ctx) => {
      const uid = ctx.body.userId;
      const u = get("SELECT id FROM users WHERE id = ? AND status = 'active'", uid);
      if (!u || !loadAccess(u.id).perms.has('chat.partners')) throw bad('Dieses Mitglied ist nicht als Ansprechpartner verfügbar.');
      let ch = get("SELECT * FROM chat_channels WHERE kind = 'dm' AND dm_a = ? AND dm_partner = ?", u.id, ctx.partner.id);
      if (!ch) {
        run("INSERT INTO chat_channels (name,description,color,sort_order,restricted,created_at,kind,dm_a,dm_partner) VALUES (?,?,?,?,1,?,'dm',?,?)", `dmp:${u.id}:${ctx.partner.id}`, '', '#5b82b8', 0, now(), u.id, ctx.partner.id);
        ch = get("SELECT * FROM chat_channels WHERE kind = 'dm' AND dm_a = ? AND dm_partner = ?", u.id, ctx.partner.id);
      }
      return { channel: channelDto(ch, pv(ctx)) };
    });
    r.get('/api/p/chat/channels/:id/messages', P, (ctx) => listMessages(pv(ctx), Number(ctx.params.id), ctx.query));
    r.post('/api/p/chat/channels/:id/messages', P, (ctx) => { const message = postMessage(pv(ctx), Number(ctx.params.id), ctx.body); ctx.status = 201; return { message }; });
    r.patch('/api/p/chat/messages/:id', P, (ctx) => ({ message: editMessage(pv(ctx), Number(ctx.params.id), ctx.body) }));
    r.delete('/api/p/chat/messages/:id', P, (ctx) => {
      const m = ownMessage(pv(ctx), Number(ctx.params.id));
      if (m.partner_id !== ctx.partner.id) throw forbidden('Du kannst nur eigene Nachrichten löschen.');
      if (!m.deleted_at) { run('UPDATE chat_messages SET body = ?, deleted_at = ?, pinned_at = NULL, pinned_by = NULL WHERE id = ?', '', now(), m.id); changed(m.channel_id, 'delete'); }
      return { ok: true };
    });
    r.post('/api/p/chat/channels/:id/read', P, (ctx) => { markRead(pv(ctx), Number(ctx.params.id), ctx.body.lastId); return { ok: true }; });
  },
};
