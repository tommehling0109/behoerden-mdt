import { all, get, run, now, onCommit } from './db.js';
import { userFromToken } from './auth.js';
import { partnerFromToken } from './partner-auth.js';

/**
 * Echtzeit über Server-Sent Events (SSE) – ein einziges Live-System für Panel UND Partner-Portal.
 *
 *  - Jedes Ereignis wird im Event-Log (Tabelle events) gespeichert: fortlaufende ID, nie doppelt.
 *  - Der Server meldet nur „Datensatz X hat sich geändert“ (Invalidierung); die Clients laden über die normalen,
 *    berechtigungsgeprüften Endpunkte nach ⇒ der Backend-Zustand bleibt die einzige Wahrheit, nichts Fremdes wird mitgesendet.
 *  - Benachrichtigungen sind eigene Ereignisse (type 'notification') direkt an den Empfänger.
 *  - Nach Verbindungsabbruch sendet der Browser Last-Event-ID; der Server liefert verpasste Ereignisse nach (oder 'reset').
 *  - Gesendet wird erst NACH dem Commit der Transaktion (onCommit), sodass Clients beim Nachladen den neuen Stand sehen.
 */
const conns = new Set();
const RETAIN = 5000;
const REPLAY_MAX = 1000;

const STAFF_PERM = { users: 'users.view', roles: 'roles.view', org: 'org.view', market: 'market.view', partners: 'partners.view', audit: 'audit.view', chat: 'chat.view', vehicles: 'vehicles.view', map: 'map.view', warehouse: 'warehouse.view', finance: 'finance.view', credit: 'credit.view', board: 'board.view', changelog: 'changelog.view', contacts: 'contacts.view', legal: 'legal.view', schedule: 'schedule.view', activity: 'activity.view', onboarding: 'onboarding.check' };

export function publish({ type = 'change', topic, kind = null, entityType = null, entityId = null, staff = 0, staffPerm = null, partnerScope = null, userId = null, partnerId = null, data = null }) {
  const row = {
    ts: now(), type, topic, kind, entity_type: entityType, entity_id: entityId != null ? String(entityId) : null,
    staff: staff ? 1 : 0, staff_perm: staffPerm, partner_scope: partnerScope, user_id: userId, partner_id: partnerId,
    data: data ? JSON.stringify(data) : null,
  };
  const res = run(
    `INSERT INTO events (ts,type,topic,kind,entity_type,entity_id,staff,staff_perm,partner_scope,user_id,partner_id,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.ts, row.type, row.topic, row.kind, row.entity_type, row.entity_id, row.staff, row.staff_perm, row.partner_scope, row.user_id, row.partner_id, row.data,
  );
  row.id = Number(res.lastInsertRowid);
  onCommit(() => {
    broadcast(row);
    if (row.id % 250 === 0) run('DELETE FROM events WHERE id <= ?', row.id - RETAIN);
  });
  return row.id;
}

/** Wird von audit() aufgerufen: jede protokollierte Änderung wird automatisch zu einem Live-Ereignis. */
export function publishChange({ module, action, targetType, targetId }) {
  if (module === 'auth') return;
  let partnerScope = null;
  if (module === 'market') {
    if (targetType === 'deal') {
      const pid = targetId != null ? get('SELECT partner_id FROM market_deals WHERE id = ?', Number(targetId))?.partner_id : null;
      partnerScope = pid ? `id:${pid}` : null;
    } else partnerScope = 'all'; // Katalog, Gesuche
  } else if (module === 'tab') {
    // Firmenportal: Abrechnungs-/Firmenänderungen gehen live an die betroffene Firma
    let cid = null;
    if (targetType === 'tab_statement' && targetId != null) cid = get('SELECT company_id FROM tab_statements WHERE id = ?', Number(targetId))?.company_id;
    else if (targetType === 'tab_company' && targetId != null) cid = Number(targetId);
    if (cid) publish({ topic: 'tab', kind: action, entityType: targetType, entityId: targetId, staff: 0, partnerScope: `company:${cid}` });
  } else if (module === 'credit') {
    const pid = targetType === 'loan' && targetId != null ? get('SELECT partner_id FROM credit_loans WHERE id = ?', Number(targetId))?.partner_id : null;
    partnerScope = pid ? `id:${pid}` : null;
  } else if (module === 'tickets') {
    const pid = targetId != null ? get('SELECT partner_id FROM tickets WHERE id = ?', Number(targetId))?.partner_id : null;
    partnerScope = pid ? `id:${pid}` : null; // Tickets von externen Zugängen: nur der Melder wird live aktualisiert
  } else if (['lookups', 'system', 'dashboard', 'help'].includes(module)) partnerScope = 'all'; // Beschriftungen, Farben, Logo …
  else if (module === 'partners' && targetType === 'partner' && targetId) partnerScope = `id:${targetId}`; // Zugangsänderung betrifft den Partner selbst
  const staffPerm = STAFF_PERM[module] ?? null;
  publish({ topic: module, kind: action, entityType: targetType, entityId: targetId, staff: 1, staffPerm, partnerScope });
  // Audit-Log-Fenster sollen jede Änderung sehen, auch ohne Recht auf das Modul
  if (staffPerm !== 'audit.view') publish({ topic: 'audit', kind: action, staff: 1, staffPerm: 'audit.view' });
}

const matches = (c, e) => {
  if (c.kind === 'company') return e.type === 'change' && e.partner_scope === `company:${c.companyId}`; // Firmenportal: nur Ereignisse der eigenen Firma
  if (e.type === 'change' && e.user_id != null) return c.kind === 'staff' && e.user_id === c.userId; // personenbezogene Änderung (z. B. Privatnachricht)
  if (e.type === 'notification') return c.kind === 'staff' ? e.user_id === c.userId : e.partner_id === c.partnerId;
  if (c.kind === 'staff') return e.staff === 1 && (!e.staff_perm || c.perms.has(e.staff_perm));
  return !!e.partner_scope && (e.partner_scope === 'all' || e.partner_scope === `id:${c.partnerId}`);
};

const frame = (e) => {
  const extra = e.data ? JSON.parse(e.data) : {};
  return `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ topic: e.topic, kind: e.kind, entityType: e.entity_type, entityId: e.entity_id, ts: e.ts, ...extra })}\n\n`;
};

function refreshStaff(c) {
  const u = userFromToken(c.token);
  if (!u || u.status !== 'active') return close(c);
  c.perms = u.perms;
}
const close = (c) => { conns.delete(c); try { c.res.end(); } catch { /* weg */ } };

function broadcast(e) {
  const affectsAccess = e.type === 'change' && ['users', 'roles', 'org', 'partners'].includes(e.topic);
  for (const c of [...conns]) {
    if (affectsAccess) { if (c.kind === 'staff') refreshStaff(c); else if (c.kind === 'partner' && !partnerFromToken(c.token)) close(c); }
    if (c.closed || !conns.has(c)) continue;
    if (!matches(c, e)) continue;
    try { c.res.write(frame(e)); } catch { conns.delete(c); }
  }
}

/** Öffnet den SSE-Stream für eine authentifizierte Verbindung und liefert ggf. verpasste Ereignisse nach. */
export function openStream(ctx, conn) {
  const { req, res } = ctx;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  conn.res = res;
  const since = req.headers['last-event-id'] ?? ctx.query.since;
  const last = since != null && /^\d+$/.test(String(since)) ? Number(since) : null;
  const max = get('SELECT COALESCE(MAX(id),0) m FROM events').m;
  if (last != null) {
    if (last > max) res.write(`id: ${max}\nevent: reset\ndata: {}\n\n`); // z. B. Datenbank wurde ersetzt
    else {
      const rows = all('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?', last, REPLAY_MAX + 1);
      const oldest = get('SELECT MIN(id) m FROM events').m;
      if (rows.length > REPLAY_MAX || (oldest != null && oldest > last + 1 && max > last)) res.write(`id: ${max}\nevent: reset\ndata: {}\n\n`); // zu viel verpasst → Client lädt komplett neu
      else for (const e of rows) if (matches(conn, e)) res.write(frame(e));
    }
  }
  res.write(`id: ${max}\nevent: hello\ndata: ${JSON.stringify({ lastId: max, ts: now(), resumed: last != null })}\n\n`);
  conns.add(conn);
  req.on('close', () => { conn.closed = true; conns.delete(conn); });
  ctx.handled = true;
}

// Keepalive + Sitzungs-Prüfung: abgelaufene/beendete Sitzungen und deaktivierte Zugänge verlieren den Stream
setInterval(() => {
  for (const c of [...conns]) {
    if (c.kind === 'staff') { refreshStaff(c); } else if (c.kind === 'company') { if (!get("SELECT 1 x FROM tab_companies WHERE link_token = ? AND status = 'active'", c.token)) close(c); } else if (!partnerFromToken(c.token)) close(c);
    if (conns.has(c)) { try { c.res.write(': ping\n\n'); } catch { conns.delete(c); } }
  }
}, 15_000).unref();

export const connectionCount = () => conns.size;
