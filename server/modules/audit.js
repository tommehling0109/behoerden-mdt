import { all } from '../core/db.js';
import { queryAudit } from '../core/audit.js';

const dateOnly = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const csvCell = (v) => {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // Schutz vor Formel-Injektion in Tabellenkalkulationen
  return `"${s.replace(/"/g, '""')}"`;
};

export default {
  name: 'audit',
  permissions: [['audit.view', 'Audit-Log einsehen'], ['audit.export', 'Audit-Log als Datei exportieren']],
  routes(r) {
    r.get('/api/audit/export', { perm: 'audit.export' }, (ctx) => {
      const { rows } = queryAudit({ viewerId: ctx.user.id, limit: 5000, offset: 0, module: ctx.query.module, q: ctx.query.q, action: ctx.query.action, user: ctx.query.user, from: dateOnly(ctx.query.from), to: dateOnly(ctx.query.to) });
      const head = ['Zeitpunkt', 'Benutzer', 'Aktion', 'Modul', 'Datensatz-Typ', 'Datensatz', 'Vorher', 'Nachher', 'IP'];
      const lines = rows.map((r) => [r.ts, r.username, r.action, r.module, r.targetType, r.targetLabel, r.before, r.after, r.ip].map(csvCell).join(';'));
      ctx.raw = { contentType: 'text/csv; charset=utf-8', filename: `audit-${new Date().toISOString().slice(0, 10)}.csv`, body: '\uFEFF' + [head.map(csvCell).join(';'), ...lines].join('\r\n') };
    });

    r.get('/api/audit', { perm: 'audit.view' }, (ctx) => {
      const limit = Math.min(Math.max(parseInt(ctx.query.limit) || 50, 1), 200);
      const offset = Math.max(parseInt(ctx.query.offset) || 0, 0);
      return {
        ...queryAudit({ viewerId: ctx.user.id, limit, offset, module: ctx.query.module, q: ctx.query.q, action: ctx.query.action, user: ctx.query.user, from: dateOnly(ctx.query.from), to: dateOnly(ctx.query.to) }),
        modules: all('SELECT DISTINCT module FROM audit_log ORDER BY module').map((r) => r.module),
      };
    });
  },
};
