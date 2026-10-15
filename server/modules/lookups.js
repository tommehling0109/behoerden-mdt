import { all, get, run, tx } from '../core/db.js';
import { bad, conflict, forbidden, notFound, str, intList } from '../core/http.js';
import { audit } from '../core/audit.js';
import { lookupLists, lookupList, lookupEntries, lookupEntry, entryUsage, slugify } from '../core/lookups.js';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export default {
  name: 'lookups',
  permissions: [
    ['lookups.view', 'Kategorien und Status ansehen'],
    ['lookups.manage', 'Kategorien und Status verwalten'],
  ],
  routes(r) {
    // Alle Listen inkl. Einträgen – auch für Module, die nur Auswahlfelder füllen (z. B. Börse)
    r.get('/api/lookups', { perm: ['lookups.view', 'market.view'] }, () => ({
      lists: lookupLists().map((l) => ({
        key: l.key, label: l.label, description: l.description ?? '', module: l.module ?? '', isFixed: !!l.fixed,
        entries: lookupEntries(l.key).map((e) => ({ ...e, usage: entryUsage(e) })),
      })),
    }));

    r.post('/api/lookups/:list', { perm: 'lookups.manage' }, (ctx) => {
      const list = lookupList(ctx.params.list);
      if (!list) throw notFound('Liste nicht gefunden.');
      if (list.fixed) throw forbidden('Diese Liste hat feste Einträge und kann nicht erweitert werden.');
      const b = ctx.body;
      const label = str(b.label, 'Bezeichnung', { min: 1, max: 60 });
      const description = str(b.description, 'Beschreibung', { max: 500, required: false });
      const color = b.color && COLOR_RE.test(b.color) ? b.color : '#5b8def';
      let key = slugify(label), n = 2;
      while (get('SELECT 1 x FROM lookups WHERE list_key = ? AND key = ?', list.key, key)) key = `${slugify(label)}_${n++}`;
      if (get('SELECT 1 x FROM lookups WHERE list_key = ? AND label = ? COLLATE NOCASE', list.key, label)) throw conflict('Diese Bezeichnung existiert bereits.');
      const max = get('SELECT COALESCE(MAX(sort_order),0) m FROM lookups WHERE list_key = ?', list.key).m;
      const res = run('INSERT INTO lookups (list_key,key,label,description,color,sort_order,is_active,is_system) VALUES (?,?,?,?,?,?,1,0)', list.key, key, label, description, color, max + 1);
      const entry = lookupEntry(Number(res.lastInsertRowid));
      audit(ctx, { action: 'lookup.created', module: 'lookups', targetType: list.key, targetId: entry.id, targetLabel: label, after: entry });
      ctx.status = 201;
      return { entry };
    });

    r.patch('/api/lookups/:list/:id', { perm: 'lookups.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = lookupEntry(id);
      if (!cur || cur.listKey !== ctx.params.list) throw notFound('Eintrag nicht gefunden.');
      const b = ctx.body;
      tx(() => {
        if (b.label !== undefined) {
          const label = str(b.label, 'Bezeichnung', { min: 1, max: 60 });
          if (get('SELECT 1 x FROM lookups WHERE list_key = ? AND label = ? COLLATE NOCASE AND id != ?', cur.listKey, label, id)) throw conflict('Diese Bezeichnung existiert bereits.');
          run('UPDATE lookups SET label = ? WHERE id = ?', label, id);
        }
        if (b.description !== undefined) run('UPDATE lookups SET description = ? WHERE id = ?', str(b.description, 'Beschreibung', { max: 500, required: false }), id);
        if (b.color !== undefined) {
          if (!COLOR_RE.test(b.color)) throw bad('Ungültige Farbe.');
          run('UPDATE lookups SET color = ? WHERE id = ?', b.color, id);
        }
        if (b.isActive !== undefined) {
          if (cur.isSystem && !b.isActive) throw forbidden('Feste Einträge können nicht deaktiviert werden.');
          run('UPDATE lookups SET is_active = ? WHERE id = ?', b.isActive ? 1 : 0, id);
        }
      });
      const after = lookupEntry(id);
      audit(ctx, { action: 'lookup.updated', module: 'lookups', targetType: cur.listKey, targetId: id, targetLabel: after.label, before: cur, after });
      return { entry: after };
    });

    r.post('/api/lookups/:list/order/set', { perm: 'lookups.manage' }, (ctx) => {
      const list = lookupList(ctx.params.list);
      if (!list) throw notFound('Liste nicht gefunden.');
      const ids = intList(ctx.body.ids, 'Reihenfolge');
      const existing = all('SELECT id FROM lookups WHERE list_key = ?', list.key).map((x) => x.id);
      if (ids.length !== existing.length || !ids.every((i) => existing.includes(i))) throw bad('Die Reihenfolge muss alle Einträge genau einmal enthalten.');
      tx(() => ids.forEach((id, i) => run('UPDATE lookups SET sort_order = ? WHERE id = ?', i + 1, id)));
      audit(ctx, { action: 'lookup.reordered', module: 'lookups', targetType: list.key, targetLabel: list.label, after: ids });
      return { ok: true };
    });

    r.delete('/api/lookups/:list/:id', { perm: 'lookups.manage' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = lookupEntry(id);
      if (!cur || cur.listKey !== ctx.params.list) throw notFound('Eintrag nicht gefunden.');
      if (cur.isSystem) throw forbidden('Feste Einträge können nicht gelöscht werden.');
      const used = entryUsage(cur);
      if (used > 0) throw conflict(`Der Eintrag wird noch ${used}× verwendet. Deaktiviere ihn stattdessen.`);
      run('DELETE FROM lookups WHERE id = ?', id);
      audit(ctx, { action: 'lookup.deleted', module: 'lookups', targetType: cur.listKey, targetId: id, targetLabel: cur.label, before: cur });
      return { ok: true };
    });
  },
};
