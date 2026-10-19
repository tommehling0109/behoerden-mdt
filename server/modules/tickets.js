import { all, get, run, tx, now, DB_PATH } from '../core/db.js';
import { bad, forbidden, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { allocateNumber } from '../core/numbers.js';
import { decodeImage, IMAGE_MIME } from '../core/images.js';
import { labelForUser } from '../core/identity.js';
import { notify, staffWith } from '../core/notifications.js';
import { registerWidget } from './dashboard.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Ticketsystem: Jedes Mitglied kann einen Fehler melden (Bug), eine Idee oder Frage einreichen und einen Screenshot anhängen.
 * Der Melder sieht seine Tickets (auch im Chat unter „Meine Tickets“) und kann antworten; das Team (tickets.manage) sieht alle,
 * setzt Status/Priorität/Zuständigkeit und antwortet. Gemeldet wird unter der Dienstnummer (Namen bleiben anonym).
 */
const STATUS = { open: ['Offen', '#f59e0b'], in_progress: ['In Arbeit', '#3b82f6'], resolved: ['Gelöst', '#10b981'], closed: ['Geschlossen', '#94a3b8'] };
const CATEGORY = { bug: 'Fehler / Bug', idea: 'Idee / Wunsch', question: 'Frage', other: 'Sonstiges' };
const PRIORITY = { low: 'Niedrig', normal: 'Normal', high: 'Hoch' };
const dir = () => join(dirname(DB_PATH), 'tickets');
const file = (kind, id, ext) => join(dir(), `${kind}${id}.${ext}`);
const dropFiles = (kind, id) => { for (const e of Object.keys(IMAGE_MIME)) try { unlinkSync(file(kind, id, e)); } catch { /* egal */ } };
function saveShot(kind, id, data) {
  const { buf, ext } = decodeImage(data, 4 * 1024 * 1024, bad);
  mkdirSync(dir(), { recursive: true });
  dropFiles(kind, id);
  writeFileSync(file(kind, id, ext), buf);
  return ext;
}

const partnerNo = (id) => get('SELECT partner_number n FROM partners WHERE id = ?', id)?.n ?? 'Externer Zugang';
const dto = (t, viewer) => ({
  id: t.id, number: t.ticket_number, title: t.title, description: t.description, category: t.category, categoryLabel: CATEGORY[t.category], priority: t.priority, priorityLabel: PRIORITY[t.priority],
  status: t.status, statusLabel: STATUS[t.status][0], statusColor: STATUS[t.status][1], app: t.app, hasScreenshot: !!t.shot_ext,
  reporter: t.partner_id ? partnerNo(t.partner_id) : t.user_id ? labelForUser(t.user_id, viewer.id) : 'Gelöschtes Mitglied', mine: viewer.isPartner ? t.partner_id === viewer.partnerId : t.user_id === viewer.id,
  assignee: t.assignee_id && !viewer.isPartner ? { id: t.assignee_id, label: labelForUser(t.assignee_id, viewer.id) } : null,
  createdAt: t.created_at, updatedAt: t.updated_at, closedAt: t.closed_at,
  commentCount: get('SELECT COUNT(*) c FROM ticket_comments WHERE ticket_id = ?', t.id).c,
});
const canSee = (ctx, t) => t.user_id === ctx.user.id || ctx.user.perms.has('tickets.manage');
const load = (ctx) => {
  const t = get('SELECT * FROM tickets WHERE id = ?', Number(ctx.params.id));
  if (!t || !canSee(ctx, t)) throw notFound('Ticket nicht gefunden.');
  return t;
};

registerWidget({ id: 'tickets-open', title: 'Tickets', size: 'small', permission: 'tickets.manage', data: () => ({
  open: get("SELECT COUNT(*) c FROM tickets WHERE status = 'open'").c, inProgress: get("SELECT COUNT(*) c FROM tickets WHERE status = 'in_progress'").c, high: get("SELECT COUNT(*) c FROM tickets WHERE priority = 'high' AND status IN ('open','in_progress')").c,
}) });

export default {
  name: 'tickets',
  permissions: [
    ['tickets.manage', 'Tickets: alle Tickets sehen, Status/Priorität/Zuständigkeit ändern und antworten'],
    ['tickets.delete', 'Tickets: endgültig löschen'],
  ],
  config: [
    { key: 'tickets.number_prefix', group: 'Tickets', label: 'Präfix der Ticketnummer', type: 'string', default: 'MDT-T-', max: 12 },
    { key: 'tickets.number_start', group: 'Tickets', label: 'Startnummer der Tickets', type: 'number', default: 1001, min: 1, max: 99999999 },
  ],
  routes(r) {
    r.get('/api/tickets/options', (ctx) => ({
      canManage: ctx.user.perms.has('tickets.manage'), canDelete: ctx.user.perms.has('tickets.delete'),
      statuses: Object.entries(STATUS).map(([key, [label, color]]) => ({ key, label, color })),
      categories: Object.entries(CATEGORY).map(([key, label]) => ({ key, label })), priorities: Object.entries(PRIORITY).map(([key, label]) => ({ key, label })),
      assignees: ctx.user.perms.has('tickets.manage') ? staffWith('tickets.manage').map((x) => ({ id: x.id, label: labelForUser(x.id, ctx.user.id) })) : [],
    }));

    r.get('/api/tickets', (ctx) => {
      const where = [], p = [];
      const all_ = ctx.user.perms.has('tickets.manage') && ctx.query.mine !== '1';
      if (!all_) { where.push('user_id = ?'); p.push(ctx.user.id); }
      if (STATUS[ctx.query.status]) { where.push('status = ?'); p.push(ctx.query.status); }
      if (ctx.query.q) { where.push('(title LIKE ? OR ticket_number LIKE ?)'); p.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`); }
      const rows = all(`SELECT * FROM tickets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (status IN ('open','in_progress')) DESC, updated_at DESC LIMIT 300`, ...p);
      return { tickets: rows.map((t) => dto(t, ctx.user)) };
    });

    r.post('/api/tickets', { bodyLimit: 6 * 1024 * 1024 }, (ctx) => {
      const b = ctx.body;
      const title = str(b.title, 'Titel', { min: 3, max: 120 });
      const description = str(b.description, 'Beschreibung', { min: 5, max: 4000 });
      const category = CATEGORY[b.category] ? b.category : 'bug';
      const app = str(b.app, 'App', { max: 40, required: false });
      const t = now();
      const id = tx(() => {
        const res = run('INSERT INTO tickets (ticket_number,user_id,title,description,category,app,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
          allocateNumber('ticket', 'tickets.number_prefix', 'tickets.number_start'), ctx.user.id, title, description, category, app, t, t);
        const tid = Number(res.lastInsertRowid);
        if (b.screenshot) run('UPDATE tickets SET shot_ext = ? WHERE id = ?', saveShot('t', tid, b.screenshot), tid);
        return tid;
      });
      const tk = get('SELECT * FROM tickets WHERE id = ?', id);
      notify(staffWith('tickets.manage', ctx.user.id), { key: `ticket:${id}:new`, title: `Neues Ticket ${tk.ticket_number}`, body: `${CATEGORY[category]} · ${title} · von ${labelForUser(ctx.user.id, null)}`, target: { app: 'tickets', ticketId: id } });
      audit(ctx, { action: 'ticket.created', module: 'tickets', targetType: 'ticket', targetId: id, targetLabel: `${tk.ticket_number} · ${title}`, after: { category } });
      ctx.status = 201;
      return { ticket: dto(tk, ctx.user) };
    });

    r.get('/api/tickets/:id', (ctx) => {
      const t = load(ctx);
      const comments = all('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY id', t.id).map((c) => ({
        id: c.id, body: c.body, hasScreenshot: !!c.shot_ext, createdAt: c.created_at, author: c.partner_id ? partnerNo(c.partner_id) : c.user_id ? labelForUser(c.user_id, ctx.user.id) : 'Gelöschtes Mitglied', mine: c.user_id === ctx.user.id, staff: !!c.user_id && c.user_id !== t.user_id,
      }));
      return { ticket: dto(t, ctx.user), comments, canManage: ctx.user.perms.has('tickets.manage'), canDelete: ctx.user.perms.has('tickets.delete') };
    });

    r.get('/api/tickets/:id/screenshot', (ctx) => {
      const t = load(ctx);
      const f = t.shot_ext && file('t', t.id, t.shot_ext);
      if (!f || !existsSync(f)) throw notFound('Kein Screenshot.');
      ctx.raw = { contentType: IMAGE_MIME[t.shot_ext], body: readFileSync(f), inline: true, cache: 'private, max-age=3600' };
    });
    r.get('/api/tickets/:id/comments/:cid/screenshot', (ctx) => {
      const t = load(ctx);
      const c = get('SELECT * FROM ticket_comments WHERE id = ? AND ticket_id = ?', Number(ctx.params.cid), t.id);
      const f = c?.shot_ext && file('c', c.id, c.shot_ext);
      if (!f || !existsSync(f)) throw notFound('Kein Screenshot.');
      ctx.raw = { contentType: IMAGE_MIME[c.shot_ext], body: readFileSync(f), inline: true, cache: 'private, max-age=3600' };
    });

    r.post('/api/tickets/:id/comments', { bodyLimit: 6 * 1024 * 1024 }, (ctx) => {
      const t = load(ctx);
      if (t.status === 'closed' && !ctx.user.perms.has('tickets.manage')) throw bad('Dieses Ticket ist geschlossen.');
      const body = str(ctx.body.body, 'Nachricht', { min: 1, max: 4000 });
      const cid = tx(() => {
        const res = run('INSERT INTO ticket_comments (ticket_id,user_id,body,created_at) VALUES (?,?,?,?)', t.id, ctx.user.id, body, now());
        const id = Number(res.lastInsertRowid);
        if (ctx.body.screenshot) run('UPDATE ticket_comments SET shot_ext = ? WHERE id = ?', saveShot('c', id, ctx.body.screenshot), id);
        run('UPDATE tickets SET updated_at = ? WHERE id = ?', now(), t.id);
        return id;
      });
      const toReporter = t.user_id && t.user_id !== ctx.user.id;
      const recipients = t.partner_id ? [{ type: 'partner', id: t.partner_id }] : toReporter ? [{ type: 'user', id: t.user_id }] : staffWith('tickets.manage', ctx.user.id);
      notify(recipients, { key: `ticket:${t.id}:c${cid}`, title: `${t.ticket_number}: neue Antwort`, body: body.slice(0, 140), target: t.partner_id ? { partnerTicket: t.id } : { app: 'tickets', ticketId: t.id } });
      audit(ctx, { action: 'ticket.comment', module: 'tickets', targetType: 'ticket', targetId: t.id, targetLabel: `${t.ticket_number} · ${t.title}` });
      return { ok: true, id: cid };
    });

    r.patch('/api/tickets/:id', (ctx) => {
      const t = load(ctx);
      const manage = ctx.user.perms.has('tickets.manage');
      const b = ctx.body;
      const sets = {};
      if (b.status !== undefined) {
        if (!STATUS[b.status]) throw bad('Ungültiger Status.');
        if (!manage && !(t.user_id === ctx.user.id && ['closed', 'open'].includes(b.status))) throw forbidden('Als Melder kannst du dein Ticket nur schließen oder wieder öffnen.');
        sets.status = b.status; sets.closed_at = ['resolved', 'closed'].includes(b.status) ? now() : null;
      }
      if (b.priority !== undefined) { if (!manage) throw forbidden(); if (!PRIORITY[b.priority]) throw bad('Ungültige Priorität.'); sets.priority = b.priority; }
      if (b.assigneeId !== undefined) {
        if (!manage) throw forbidden();
        if (b.assigneeId !== null && !staffWith('tickets.manage').some((x) => x.id === b.assigneeId)) throw bad('Dieses Mitglied kann keine Tickets bearbeiten.');
        sets.assignee_id = b.assigneeId;
      }
      const cols = Object.keys(sets);
      if (cols.length) run(`UPDATE tickets SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => sets[c]), now(), t.id);
      const n = get('SELECT * FROM tickets WHERE id = ?', t.id);
      if (sets.status && t.partner_id) notify([{ type: 'partner', id: t.partner_id }], { key: `ticket:${t.id}:s:${now()}`, title: `${t.ticket_number}: ${STATUS[n.status][0]}`, body: n.title, target: { partnerTicket: t.id } });
      else if (sets.status && t.user_id && t.user_id !== ctx.user.id) notify([{ type: 'user', id: t.user_id }], { key: `ticket:${t.id}:s:${now()}`, title: `${t.ticket_number}: ${STATUS[n.status][0]}`, body: n.title, target: { app: 'tickets', ticketId: t.id } });
      audit(ctx, { action: 'ticket.updated', module: 'tickets', targetType: 'ticket', targetId: t.id, targetLabel: `${t.ticket_number} · ${t.title}`, before: { status: t.status, priority: t.priority }, after: { status: n.status, priority: n.priority } });
      return { ticket: dto(n, ctx.user) };
    });

    // ── Externe Zugaenge: eigene Tickets melden, verfolgen und beantworten (Melder = Partnernummer) ──
    const P = { auth: 'partner' }, PB = { auth: 'partner', bodyLimit: 6 * 1024 * 1024 };
    const pv = (ctx) => ({ id: -1, isPartner: true, partnerId: ctx.partner.id });
    const loadP = (ctx) => {
      const t = get('SELECT * FROM tickets WHERE id = ? AND partner_id = ?', Number(ctx.params.id), ctx.partner.id);
      if (!t) throw notFound('Ticket nicht gefunden.');
      return t;
    };
    r.get('/api/p/tickets/options', P, () => ({
      canManage: false, canDelete: false, statuses: Object.entries(STATUS).map(([key, [label, color]]) => ({ key, label, color })),
      categories: Object.entries(CATEGORY).map(([key, label]) => ({ key, label })), priorities: Object.entries(PRIORITY).map(([key, label]) => ({ key, label })), assignees: [],
    }));
    r.get('/api/p/tickets', P, (ctx) => ({ tickets: all("SELECT * FROM tickets WHERE partner_id = ? ORDER BY (status IN ('open','in_progress')) DESC, updated_at DESC LIMIT 200", ctx.partner.id).map((t) => dto(t, pv(ctx))) }));
    r.post('/api/p/tickets', PB, (ctx) => {
      const b = ctx.body;
      const title = str(b.title, 'Titel', { min: 3, max: 120 });
      const description = str(b.description, 'Beschreibung', { min: 5, max: 4000 });
      const category = CATEGORY[b.category] ? b.category : 'bug';
      const app = str(b.app, 'App', { max: 40, required: false });
      const t = now();
      const id = tx(() => {
        const res = run('INSERT INTO tickets (ticket_number,partner_id,title,description,category,app,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
          allocateNumber('ticket', 'tickets.number_prefix', 'tickets.number_start'), ctx.partner.id, title, description, category, app, t, t);
        const tid = Number(res.lastInsertRowid);
        if (b.screenshot) run('UPDATE tickets SET shot_ext = ? WHERE id = ?', saveShot('t', tid, b.screenshot), tid);
        return tid;
      });
      const tk = get('SELECT * FROM tickets WHERE id = ?', id);
      notify(staffWith('tickets.manage'), { key: `ticket:${id}:new`, title: `Neues Ticket ${tk.ticket_number}`, body: `${CATEGORY[category]} · ${title} · von ${ctx.partner.number}`, target: { app: 'tickets', ticketId: id } });
      audit(ctx, { action: 'ticket.created', module: 'tickets', targetType: 'ticket', targetId: id, targetLabel: `${tk.ticket_number} · ${title}`, after: { category, partner: ctx.partner.number } });
      ctx.status = 201;
      return { ticket: dto(tk, pv(ctx)) };
    });
    r.get('/api/p/tickets/:id', P, (ctx) => {
      const t = loadP(ctx);
      const comments = all('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY id', t.id).map((c) => ({
        id: c.id, body: c.body, hasScreenshot: !!c.shot_ext, createdAt: c.created_at, author: c.partner_id ? ctx.partner.number : c.user_id ? labelForUser(c.user_id, null) : 'Team', mine: c.partner_id === ctx.partner.id, staff: !!c.user_id,
      }));
      return { ticket: dto(t, pv(ctx)), comments, canManage: false, canDelete: false };
    });
    r.get('/api/p/tickets/:id/screenshot', P, (ctx) => {
      const t = loadP(ctx);
      const f = t.shot_ext && file('t', t.id, t.shot_ext);
      if (!f || !existsSync(f)) throw notFound('Kein Screenshot.');
      ctx.raw = { contentType: IMAGE_MIME[t.shot_ext], body: readFileSync(f), inline: true, cache: 'private, max-age=3600' };
    });
    r.get('/api/p/tickets/:id/comments/:cid/screenshot', P, (ctx) => {
      const t = loadP(ctx);
      const c = get('SELECT * FROM ticket_comments WHERE id = ? AND ticket_id = ?', Number(ctx.params.cid), t.id);
      const f = c?.shot_ext && file('c', c.id, c.shot_ext);
      if (!f || !existsSync(f)) throw notFound('Kein Screenshot.');
      ctx.raw = { contentType: IMAGE_MIME[c.shot_ext], body: readFileSync(f), inline: true, cache: 'private, max-age=3600' };
    });
    r.post('/api/p/tickets/:id/comments', PB, (ctx) => {
      const t = loadP(ctx);
      if (t.status === 'closed') throw bad('Dieses Ticket ist geschlossen.');
      const body = str(ctx.body.body, 'Nachricht', { min: 1, max: 4000 });
      const cid = tx(() => {
        const res = run('INSERT INTO ticket_comments (ticket_id,partner_id,body,created_at) VALUES (?,?,?,?)', t.id, ctx.partner.id, body, now());
        const id = Number(res.lastInsertRowid);
        if (ctx.body.screenshot) run('UPDATE ticket_comments SET shot_ext = ? WHERE id = ?', saveShot('c', id, ctx.body.screenshot), id);
        run('UPDATE tickets SET updated_at = ? WHERE id = ?', now(), t.id);
        return id;
      });
      notify(staffWith('tickets.manage'), { key: `ticket:${t.id}:c${cid}`, title: `${t.ticket_number}: neue Antwort`, body: body.slice(0, 140), target: { app: 'tickets', ticketId: t.id } });
      audit(ctx, { action: 'ticket.comment', module: 'tickets', targetType: 'ticket', targetId: t.id, targetLabel: `${t.ticket_number} · ${t.title}` });
      return { ok: true, id: cid };
    });
    r.patch('/api/p/tickets/:id', P, (ctx) => {
      const t = loadP(ctx);
      const s = ctx.body.status;
      if (!['closed', 'open'].includes(s)) throw forbidden('Als Melder kannst du dein Ticket nur schließen oder wieder öffnen.');
      run('UPDATE tickets SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?', s, s === 'closed' ? now() : null, now(), t.id);
      audit(ctx, { action: 'ticket.updated', module: 'tickets', targetType: 'ticket', targetId: t.id, targetLabel: `${t.ticket_number} · ${t.title}`, before: { status: t.status }, after: { status: s } });
      return { ticket: dto(get('SELECT * FROM tickets WHERE id = ?', t.id), pv(ctx)) };
    });

    r.delete('/api/tickets/:id', { perm: 'tickets.delete' }, (ctx) => {
      const t = get('SELECT * FROM tickets WHERE id = ?', Number(ctx.params.id));
      if (!t) throw notFound('Ticket nicht gefunden.');
      for (const c of all('SELECT id FROM ticket_comments WHERE ticket_id = ?', t.id)) dropFiles('c', c.id);
      dropFiles('t', t.id);
      run('DELETE FROM tickets WHERE id = ?', t.id);
      audit(ctx, { action: 'ticket.deleted', module: 'tickets', targetType: 'ticket', targetId: t.id, targetLabel: `${t.ticket_number} · ${t.title}` });
      return { ok: true };
    });
  },
};
