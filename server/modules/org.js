import { all, get, run, tx, now } from '../core/db.js';
import { seedRanks } from '../core/seed-ranks.js';
import { bad, conflict, forbidden, notFound, str, strList, intList } from '../core/http.js';
import { permissionExists } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { backfillMemberNumbers, nextMemberNumberPreview } from '../core/members.js';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const color = (v, fallback = '#5b8def') => (v == null || v === '' ? fallback : COLOR_RE.test(v) ? v : (() => { throw bad('Ungültige Farbe.'); })());

const rankDto = (r) => ({
  id: r.id, name: r.name, description: r.description, color: r.color, sortOrder: r.sort_order,
  departmentId: r.department_id, parentRankId: r.parent_rank_id, memberCount: r.member_count ?? 0,
  permissions: all('SELECT permission_key k FROM rank_permissions WHERE rank_id = ?', r.id).map((x) => x.k),
});
const deptDto = (d) => ({
  id: d.id, name: d.name, description: d.description, color: d.color, sortOrder: d.sort_order,
  memberCount: d.member_count ?? 0, rankCount: d.rank_count ?? 0,
});
const loadRank = (id) => {
  const r = get('SELECT r.*, (SELECT COUNT(*) FROM users WHERE rank_id=r.id) member_count FROM ranks r WHERE r.id = ?', id);
  return r ? rankDto(r) : null;
};
const loadDept = (id) => {
  const d = get(`SELECT d.*, (SELECT COUNT(*) FROM users WHERE department_id=d.id) member_count,
    (SELECT COUNT(*) FROM ranks WHERE department_id=d.id) rank_count FROM departments d WHERE d.id = ?`, id);
  return d ? deptDto(d) : null;
};

/** Verhindert Zyklen in der Vorgesetzten-Kette (Rang A → Rang B → … → A). */
function assertNoCycle(rankId, parentId) {
  let cur = parentId;
  const seen = new Set();
  while (cur != null) {
    if (cur === rankId) throw bad('Die Rang-Hierarchie darf keine Schleife enthalten.');
    if (seen.has(cur)) break;
    seen.add(cur);
    cur = get('SELECT parent_rank_id p FROM ranks WHERE id = ?', cur)?.p ?? null;
  }
}
const optId = (v, table, label) => {
  if (v == null || v === '') return null;
  if (!Number.isInteger(v) || !get(`SELECT 1 x FROM ${table} WHERE id = ?`, v)) throw bad(`${label}: unbekannter Eintrag.`);
  return v;
};
function checkGrantable(actor, keys, existing = []) {
  const old = new Set(existing);
  for (const k of keys) {
    if (!permissionExists(k)) throw bad(`Unbekanntes Recht: ${k}`);
    if (!actor.isAdmin && !old.has(k) && !actor.perms.has(k)) throw forbidden(`Du kannst das Recht „${k}“ nicht vergeben, da du es selbst nicht besitzt.`);
  }
}
const setRankPerms = (id, keys) => {
  run('DELETE FROM rank_permissions WHERE rank_id = ?', id);
  for (const k of keys) run('INSERT INTO rank_permissions (rank_id,permission_key) VALUES (?,?)', id, k);
};

export default {
  name: 'org',
  permissions: [
    ['org.view', 'Ränge, Abteilungen und Hierarchie ansehen'],
    ['org.manage', 'Ränge und Abteilungen verwalten'],
  ],
  config: [
    { key: 'members.number_prefix', group: 'Mitglieder', label: 'Präfix der Dienstnummer', help: 'Wird neuen Nummern vorangestellt (leer = reine Zahl). Bereits vergebene Nummern ändern sich nie.', type: 'string', default: '', max: 12 },
    { key: 'members.number_start', group: 'Mitglieder', label: 'Startnummer', help: () => `Niedrigste Nummer, die vergeben wird. Nächste Dienstnummer: ${nextMemberNumberPreview()}`, type: 'number', default: 1000, min: 1, max: 999999 },
  ],
  init() {
    backfillMemberNumbers();
    if (get('SELECT 1 x FROM users LIMIT 1')) seedRanks(); // bestehende Systeme ohne Ränge bekommen die Standard-Ränge einmalig
  },
  routes(r) {
    r.get('/api/org', { perm: ['org.view', 'users.view'] }, () => ({
      ranks: all('SELECT r.*, (SELECT COUNT(*) FROM users WHERE rank_id=r.id) member_count FROM ranks r ORDER BY sort_order, name').map(rankDto),
      departments: all(`SELECT d.*, (SELECT COUNT(*) FROM users WHERE department_id=d.id) member_count,
        (SELECT COUNT(*) FROM ranks WHERE department_id=d.id) rank_count FROM departments d ORDER BY sort_order, name`).map(deptDto),
      nextMemberNumber: nextMemberNumberPreview(),
    }));

    // ── Ränge ──
    r.post('/api/ranks', { perm: 'org.manage' }, (ctx) => {
      const b = ctx.body;
      const name = str(b.name, 'Name', { min: 2, max: 60 });
      const description = str(b.description, 'Beschreibung', { max: 200, required: false });
      const perms = strList(b.permissions, 'Rechte');
      checkGrantable(ctx.user, perms);
      if (get('SELECT 1 x FROM ranks WHERE name = ?', name)) throw conflict('Ein Rang mit diesem Namen existiert bereits.');
      const departmentId = optId(b.departmentId, 'departments', 'Abteilung');
      // placeAbove: der neue Rang wird direkt über diesen Rang einsortiert und rückt in der Hierarchie über ihn
      const lowerId = optId(b.placeAbove, 'ranks', 'Rang darunter');
      const lower = lowerId ? get('SELECT sort_order, parent_rank_id FROM ranks WHERE id = ?', lowerId) : null;
      const parentRankId = b.parentRankId === undefined && lower ? lower.parent_rank_id : optId(b.parentRankId, 'ranks', 'Vorgesetzter Rang');
      const id = tx(() => {
        let order;
        if (lower) { order = lower.sort_order; run('UPDATE ranks SET sort_order = sort_order + 1 WHERE sort_order >= ?', order); }
        else order = get('SELECT COALESCE(MAX(sort_order),0) m FROM ranks').m + 1;
        const res = run('INSERT INTO ranks (name,description,color,sort_order,department_id,parent_rank_id,created_at) VALUES (?,?,?,?,?,?,?)',
          name, description, color(b.color), order, departmentId, parentRankId, now());
        const nid = Number(res.lastInsertRowid);
        setRankPerms(nid, perms);
        if (lowerId) run('UPDATE ranks SET parent_rank_id = ? WHERE id = ?', nid, lowerId);
        return nid;
      });
      audit(ctx, { action: 'rank.created', module: 'org', targetType: 'rank', targetId: id, targetLabel: name, after: loadRank(id) });
      ctx.status = 201;
      return { rank: loadRank(id) };
    });

    r.patch('/api/ranks/:id', { perm: 'org.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = loadRank(id);
      if (!cur) throw notFound('Rang nicht gefunden.');
      const b = ctx.body;
      tx(() => {
        if (b.name !== undefined) {
          const name = str(b.name, 'Name', { min: 2, max: 60 });
          if (get('SELECT 1 x FROM ranks WHERE name = ? AND id != ?', name, id)) throw conflict('Ein Rang mit diesem Namen existiert bereits.');
          run('UPDATE ranks SET name = ? WHERE id = ?', name, id);
        }
        if (b.description !== undefined) run('UPDATE ranks SET description = ? WHERE id = ?', str(b.description, 'Beschreibung', { max: 200, required: false }), id);
        if (b.color !== undefined) run('UPDATE ranks SET color = ? WHERE id = ?', color(b.color), id);
        if (b.departmentId !== undefined) run('UPDATE ranks SET department_id = ? WHERE id = ?', optId(b.departmentId, 'departments', 'Abteilung'), id);
        if (b.parentRankId !== undefined) {
          const p = optId(b.parentRankId, 'ranks', 'Vorgesetzter Rang');
          if (p != null) assertNoCycle(id, p);
          run('UPDATE ranks SET parent_rank_id = ? WHERE id = ?', p, id);
        }
        if (b.permissions !== undefined) {
          const keys = strList(b.permissions, 'Rechte');
          checkGrantable(ctx.user, keys, cur.permissions);
          setRankPerms(id, keys);
        }
      });
      const after = loadRank(id);
      audit(ctx, { action: 'rank.updated', module: 'org', targetType: 'rank', targetId: id, targetLabel: after.name, before: cur, after });
      return { rank: after };
    });

    // Reihenfolge der Rang-Hierarchie (höchster Rang zuerst): { ids: [...] }
    r.post('/api/ranks/order', { perm: 'org.manage' }, (ctx) => {
      const ids = intList(ctx.body.ids, 'Reihenfolge');
      const existing = all('SELECT id FROM ranks').map((x) => x.id);
      if (ids.length !== existing.length || !ids.every((i) => existing.includes(i))) throw bad('Die Reihenfolge muss alle Ränge genau einmal enthalten.');
      const before = all('SELECT id FROM ranks ORDER BY sort_order, name').map((x) => x.id);
      tx(() => ids.forEach((rid, i) => run('UPDATE ranks SET sort_order = ? WHERE id = ?', i + 1, rid)));
      audit(ctx, { action: 'rank.reordered', module: 'org', targetType: 'rank', targetLabel: 'Rangfolge', before, after: ids });
      return { ok: true };
    });

    r.delete('/api/ranks/:id', { perm: 'org.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = loadRank(id);
      if (!cur) throw notFound('Rang nicht gefunden.');
      if (cur.memberCount > 0) throw conflict(`Der Rang ist noch ${cur.memberCount} Mitglied(ern) zugewiesen. Weise ihnen zuerst einen anderen Rang zu.`);
      run('DELETE FROM ranks WHERE id = ?', id);
      audit(ctx, { action: 'rank.deleted', module: 'org', targetType: 'rank', targetId: id, targetLabel: cur.name, before: cur });
      return { ok: true };
    });

    // ── Abteilungen ──
    r.post('/api/departments', { perm: 'org.manage' }, (ctx) => {
      const b = ctx.body;
      const name = str(b.name, 'Name', { min: 2, max: 60 });
      if (get('SELECT 1 x FROM departments WHERE name = ?', name)) throw conflict('Eine Abteilung mit diesem Namen existiert bereits.');
      const max = get('SELECT COALESCE(MAX(sort_order),0) m FROM departments').m;
      const res = run('INSERT INTO departments (name,description,color,sort_order,created_at) VALUES (?,?,?,?,?)',
        name, str(b.description, 'Beschreibung', { max: 200, required: false }), color(b.color), max + 1, now());
      const id = Number(res.lastInsertRowid);
      audit(ctx, { action: 'department.created', module: 'org', targetType: 'department', targetId: id, targetLabel: name, after: loadDept(id) });
      ctx.status = 201;
      return { department: loadDept(id) };
    });

    r.patch('/api/departments/:id', { perm: 'org.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = loadDept(id);
      if (!cur) throw notFound('Abteilung nicht gefunden.');
      const b = ctx.body;
      tx(() => {
        if (b.name !== undefined) {
          const name = str(b.name, 'Name', { min: 2, max: 60 });
          if (get('SELECT 1 x FROM departments WHERE name = ? AND id != ?', name, id)) throw conflict('Eine Abteilung mit diesem Namen existiert bereits.');
          run('UPDATE departments SET name = ? WHERE id = ?', name, id);
        }
        if (b.description !== undefined) run('UPDATE departments SET description = ? WHERE id = ?', str(b.description, 'Beschreibung', { max: 200, required: false }), id);
        if (b.color !== undefined) run('UPDATE departments SET color = ? WHERE id = ?', color(b.color), id);
      });
      const after = loadDept(id);
      audit(ctx, { action: 'department.updated', module: 'org', targetType: 'department', targetId: id, targetLabel: after.name, before: cur, after });
      return { department: after };
    });

    r.delete('/api/departments/:id', { perm: 'org.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = loadDept(id);
      if (!cur) throw notFound('Abteilung nicht gefunden.');
      if (cur.memberCount > 0) throw conflict(`Die Abteilung hat noch ${cur.memberCount} Mitglied(er). Weise sie zuerst um.`);
      run('DELETE FROM departments WHERE id = ?', id);
      audit(ctx, { action: 'department.deleted', module: 'org', targetType: 'department', targetId: id, targetLabel: cur.name, before: cur });
      return { ok: true };
    });
  },
};
