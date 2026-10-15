import { all, get, run, now } from './db.js';
import { publishChange } from './realtime.js';
import { memberLabel, stripNames, labelForUser } from './identity.js';

const json = (v) => (v === undefined ? null : JSON.stringify(v));
const labelForUserRow = (id, viewerId) => labelForUser(Number(id), viewerId);

/** Protokolliert eine Aktion. ctx = Request-Kontext (oder null für Systemaktionen). */
export function audit(ctx, { action, module, targetType, targetId, targetLabel, before, after }) {
  run(
    `INSERT INTO audit_log (ts,user_id,username,action,module,target_type,target_id,target_label,before_value,after_value,ip)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    now(), ctx?.user?.id ?? null, ctx?.actorName ?? null, action, module, // Namen werden nie gespeichert – nur user_id (Anzeige: Personalnummer)
    targetType ?? null, targetId != null ? String(targetId) : null, targetLabel ?? null,
    json(before), json(after), ctx?.ip ?? null,
  );
  // Jede protokollierte Änderung wird automatisch zum Live-Ereignis (Single Source of Truth: der Server meldet, Clients laden nach)
  publishChange({ module, action, targetType, targetId });
}

export function queryAudit({ limit = 50, offset = 0, module, q, action, user, from, to, viewerId = null }) {
  const where = [];
  const p = [];
  if (module) { where.push('a.module = ?'); p.push(module); }
  if (action) { where.push('a.action = ?'); p.push(action); }
  if (user) { where.push('(u.member_number LIKE ? OR a.username LIKE ?)'); p.push(`%${user}%`, `%${user}%`); }
  if (from) { where.push('a.ts >= ?'); p.push(new Date(`${from}T00:00:00`).toISOString()); }
  if (to) { where.push('a.ts <= ?'); p.push(new Date(`${to}T23:59:59.999`).toISOString()); }
  if (q) {
    where.push("(u.member_number LIKE ? OR a.action LIKE ? OR (a.target_type != 'user' AND a.target_label LIKE ?))");
    p.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const JOIN = 'FROM audit_log a LEFT JOIN users u ON u.id = a.user_id';
  const total = get(`SELECT COUNT(*) c ${JOIN} ${w}`, ...p).c;
  const rows = all(`SELECT a.*, u.member_number actor_number, u.status actor_status, u.id actor_uid ${JOIN} ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset).map((r) => {
    // Anonymität: Handelnde und betroffene Mitglieder erscheinen nur als Personalnummer (man selbst als „Du“)
    const actor = r.user_id != null ? (r.user_id === viewerId ? 'Du' : r.actor_uid ? memberLabel({ id: r.actor_uid, member_number: r.actor_number, status: r.actor_status }) : 'Gelöschtes Mitglied')
      : r.action === 'auth.login_failed' ? 'Unbekannt' : (r.username ?? null);
    const targetLabel = r.target_type === 'user' ? (r.target_id ? labelForUserRow(r.target_id, viewerId) : null) : r.target_label;
    return {
      id: r.id, ts: r.ts, userId: null, username: actor, actor, action: r.action, module: r.module,
      targetType: r.target_type, targetId: r.target_id, targetLabel,
      before: r.before_value ? stripNames(JSON.parse(r.before_value)) : null,
      after: r.after_value ? stripNames(JSON.parse(r.after_value)) : null,
      ip: r.ip,
    };
  });
  return { total, rows };
}
