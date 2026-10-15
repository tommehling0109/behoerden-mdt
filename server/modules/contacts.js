import { all, get, run, tx, now } from '../core/db.js';
import { bad, forbidden, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { labelForUser } from '../core/identity.js';
import { registerLookup, lookupEntries, lookupEntry, isActiveEntry } from '../core/lookups.js';

/**
 * Kontaktbuch: Institutionen (Behörden, Firmen, Gruppierungen, Vereine …) mit Kontaktdaten und darin Personen
 * (Mitarbeiter, Angehörige, Ansprechpartner …) mit Adresse, Wohnanschrift, Telefon/E-Mail, Bankdaten und Stellung.
 * Einträge können für bestimmte Rollen gesperrt und gekennzeichnet werden. Bankdaten brauchen ein eigenes Recht.
 */
registerLookup({
  key: 'contacts.org_type', module: 'Kontaktbuch', label: 'Arten von Institutionen', description: 'Behörde, Firma, Gruppierung, Verein … – frei erweiterbar.',
  fixed: [{ key: 'authority', label: 'Behörde', color: '#5b8def' }, { key: 'company', label: 'Firma', color: '#10b981' }, { key: 'group', label: 'Gruppierung', color: '#ef4444' },
    { key: 'club', label: 'Verein', color: '#f59e0b' }, { key: 'institution', label: 'Institution', color: '#a78bfa' }, { key: 'other', label: 'Sonstiges', color: '#94a3b8' }],
  usage: (id) => get('SELECT COUNT(*) c FROM contact_orgs WHERE type_id = ?', id).c,
});
registerLookup({
  key: 'contacts.relation', module: 'Kontaktbuch', label: 'Beziehung von Personen', description: 'Mitarbeiter, Angehöriger, Ansprechpartner … – frei erweiterbar.',
  fixed: [{ key: 'employee', label: 'Mitarbeiter', color: '#5b8def' }, { key: 'relative', label: 'Angehöriger', color: '#ec4899' }, { key: 'contact', label: 'Ansprechpartner', color: '#10b981' },
    { key: 'member', label: 'Mitglied', color: '#f59e0b' }, { key: 'other', label: 'Sonstige', color: '#94a3b8' }],
  usage: (id) => get('SELECT COUNT(*) c FROM contact_people WHERE relation_id = ?', id).c,
});

const FLAGS = { important: ['Wichtig', '#f59e0b'], secret: ['Geheim', '#a78bfa'], danger: ['Vorsicht', '#ef4444'], trusted: ['Vertrauenswürdig', '#10b981'] };
const CHANNEL_KINDS = { phone: 'Telefon', mobile: 'Handy', email: 'E-Mail', fax: 'Fax', website: 'Webseite', other: 'Sonstiges' };

// ── Sichtbarkeit: gesperrte Einträge sehen nur Rollen aus der Freigabe-Liste und wer „contacts.secret“ hat ──
const roleIds = (user) => (user.roles ?? []).map((r) => r.id);
export const sees = (user, type, row) => {
  if (!row.restricted || user.perms.has('contacts.secret')) return true;
  const ids = roleIds(user); if (!ids.length) return false;
  return !!get(`SELECT 1 x FROM contact_access WHERE owner_type = ? AND owner_id = ? AND role_id IN (${ids.map(() => '?').join(',')})`, type, row.id, ...ids);
};
function visSql(user, type, alias) {
  if (user.perms.has('contacts.secret')) return { sql: '1=1', params: [] };
  const ids = roleIds(user);
  return { sql: `(${alias}.restricted = 0${ids.length ? ` OR EXISTS (SELECT 1 FROM contact_access a WHERE a.owner_type = '${type}' AND a.owner_id = ${alias}.id AND a.role_id IN (${ids.map(() => '?').join(',')}))` : ''})`, params: ids };
}
const channelsOf = (type, id) => all('SELECT id, kind, label, value FROM contact_channels WHERE owner_type = ? AND owner_id = ? ORDER BY sort, id', type, id).map((c) => ({ id: c.id, kind: c.kind, kindLabel: CHANNEL_KINDS[c.kind], label: c.label, value: c.value }));
const accessOf = (type, id) => all('SELECT r.id, r.name FROM contact_access a JOIN roles r ON r.id = a.role_id WHERE a.owner_type = ? AND a.owner_id = ? ORDER BY r.name', type, id);
const flagDto = (f) => (f && FLAGS[f] ? { key: f, label: FLAGS[f][0], color: FLAGS[f][1] } : null);
const lk = (id) => { const e = id ? lookupEntry(id) : null; return e ? { id: e.id, label: e.label, color: e.color } : null; };

function orgDto(o, user, detail = false) {
  const people = all(`SELECT * FROM contact_people WHERE org_id = ?`, o.id).filter((p) => sees(user, 'person', p));
  const ch = channelsOf('org', o.id);
  return {
    id: o.id, name: o.name, type: lk(o.type_id), flag: flagDto(o.flag), description: o.description, address: o.address, notes: detail ? o.notes : undefined, tags: o.tags,
    restricted: !!o.restricted, peopleCount: people.length, channels: detail ? ch : ch.slice(0, 3), updatedAt: o.updated_at,
    ...(detail ? { createdAt: o.created_at, createdBy: o.created_by ? labelForUser(o.created_by, user.id) : null } : {}),
    ...(user.perms.has('contacts.secret') ? { access: accessOf('org', o.id) } : {}),
  };
}
function personDto(p, user, detail = false) {
  const bank = user.perms.has('contacts.bank');
  const org = p.org_id ? get('SELECT id, name, restricted FROM contact_orgs WHERE id = ?', p.org_id) : null;
  const ch = channelsOf('person', p.id);
  return {
    id: p.id, firstName: p.first_name, lastName: p.last_name, name: `${p.first_name} ${p.last_name}`.trim(), relation: lk(p.relation_id), position: p.position, flag: flagDto(p.flag), tags: p.tags,
    org: org ? { id: org.id, name: org.name } : null, address: p.address, homeAddress: p.home_address, birthday: p.birthday, restricted: !!p.restricted, channels: detail ? ch : ch.slice(0, 3), updatedAt: p.updated_at,
    hasBank: !!(p.bank_name || p.bank_account || p.bank_note),
    ...(detail ? { notes: p.notes, createdAt: p.created_at, createdBy: p.created_by ? labelForUser(p.created_by, user.id) : null, ...(bank ? { bank: { name: p.bank_name, account: p.bank_account, note: p.bank_note } } : { bank: null }) } : {}),
    ...(user.perms.has('contacts.secret') ? { access: accessOf('person', p.id) } : {}),
  };
}

const loadOrg = (user, id) => { const o = get('SELECT * FROM contact_orgs WHERE id = ?', Number(id)); if (!o || !sees(user, 'org', o)) throw notFound('Institution nicht gefunden.'); return o; };
const loadPerson = (user, id) => {
  const p = get('SELECT * FROM contact_people WHERE id = ?', Number(id));
  if (!p || !sees(user, 'person', p)) throw notFound('Person nicht gefunden.');
  if (p.org_id) { const o = get('SELECT * FROM contact_orgs WHERE id = ?', p.org_id); if (o && !sees(user, 'org', o)) throw notFound('Person nicht gefunden.'); }
  return p;
};

function parseChannels(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length > 20) throw bad('Höchstens 20 Kontaktdaten.');
  return list.filter((c) => c && String(c.value ?? '').trim()).map((c) => {
    if (!CHANNEL_KINDS[c.kind]) throw bad('Ungültige Art der Kontaktdaten.');
    return { kind: c.kind, label: str(c.label ?? '', 'Bezeichnung', { max: 40, required: false }) ?? '', value: str(c.value, 'Kontaktdatum', { min: 1, max: 160 }) };
  });
}
function saveChannels(type, id, list) {
  if (list === undefined) return;
  run('DELETE FROM contact_channels WHERE owner_type = ? AND owner_id = ?', type, id);
  list.forEach((c, i) => run('INSERT INTO contact_channels (owner_type,owner_id,kind,label,value,sort) VALUES (?,?,?,?,?,?)', type, id, c.kind, c.label, c.value, i));
}
function saveAccess(type, id, ids) {
  if (ids === undefined) return;
  run('DELETE FROM contact_access WHERE owner_type = ? AND owner_id = ?', type, id);
  for (const rid of ids) if (get('SELECT 1 x FROM roles WHERE id = ?', rid)) run('INSERT OR IGNORE INTO contact_access (owner_type,owner_id,role_id) VALUES (?,?,?)', type, id, rid);
}
/** Sperr-Felder nur mit „contacts.secret“ änderbar. */
function secretFields(ctx, b, out) {
  if (b.restricted === undefined && b.roleIds === undefined) return;
  if (!ctx.user.perms.has('contacts.secret')) throw forbidden('Für Sperren und Freigaben fehlt dir das Recht „contacts.secret“.');
  if (b.restricted !== undefined) out.restricted = b.restricted ? 1 : 0;
  if (b.roleIds !== undefined) { if (!Array.isArray(b.roleIds) || !b.roleIds.every(Number.isInteger)) throw bad('Ungültige Rollen.'); }
}
const opt = (v, name, max) => str(v ?? '', name, { max, required: false }) ?? '';

function orgFields(b, partial) {
  const out = {}; const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) out.name = str(b.name, 'Name', { min: 2, max: 100 });
  if (b.typeId !== undefined) { if (b.typeId !== null && !isActiveEntry('contacts.org_type', b.typeId)) throw bad('Unbekannte Art.'); out.type_id = b.typeId; }
  if (b.flag !== undefined) { if (b.flag && !FLAGS[b.flag]) throw bad('Ungültige Kennzeichnung.'); out.flag = b.flag || null; }
  for (const [k, col, max, label] of [['description', 'description', 600, 'Beschreibung'], ['address', 'address', 200, 'Adresse'], ['notes', 'notes', 3000, 'Notizen'], ['tags', 'tags', 120, 'Schlagwörter']]) if (b[k] !== undefined) out[col] = opt(b[k], label, max);
  return out;
}
function personFields(b, partial, user) {
  const out = {}; const has = (k) => !partial || b[k] !== undefined;
  if (has('lastName') || has('firstName')) { out.first_name = opt(b.firstName, 'Vorname', 60); out.last_name = opt(b.lastName, 'Nachname', 60); if (!out.first_name && !out.last_name) throw bad('Bitte Vor- oder Nachnamen angeben.'); }
  if (b.relationId !== undefined) { if (b.relationId !== null && !isActiveEntry('contacts.relation', b.relationId)) throw bad('Unbekannte Beziehung.'); out.relation_id = b.relationId; }
  if (b.orgId !== undefined) { if (b.orgId !== null) { const o = get('SELECT * FROM contact_orgs WHERE id = ?', b.orgId); if (!o || !sees(user, 'org', o)) throw bad('Unbekannte Institution.'); } out.org_id = b.orgId; }
  if (b.flag !== undefined) { if (b.flag && !FLAGS[b.flag]) throw bad('Ungültige Kennzeichnung.'); out.flag = b.flag || null; }
  if (b.birthday !== undefined) { if (b.birthday && !/^\d{4}-\d{2}-\d{2}$/.test(b.birthday)) throw bad('Ungültiges Datum.'); out.birthday = b.birthday || ''; }
  for (const [k, col, max, label] of [['position', 'position', 100, 'Stellung'], ['address', 'address', 200, 'Adresse'], ['homeAddress', 'home_address', 200, 'Wohnanschrift'], ['notes', 'notes', 3000, 'Notizen'], ['tags', 'tags', 120, 'Schlagwörter']]) if (b[k] !== undefined) out[col] = opt(b[k], label, max);
  if (b.bank !== undefined) {
    if (!user.perms.has('contacts.bank')) throw forbidden('Für Bankdaten fehlt dir das Recht „contacts.bank“.');
    out.bank_name = opt(b.bank?.name, 'Bank', 80); out.bank_account = opt(b.bank?.account, 'Kontonummer', 60); out.bank_note = opt(b.bank?.note, 'Bank-Notiz', 300);
  }
  return out;
}
const insert = (table, cols) => { const k = Object.keys(cols); return Number(run(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`, ...Object.values(cols)).lastInsertRowid); };
const update = (table, id, cols) => { const k = Object.keys(cols); if (k.length) run(`UPDATE ${table} SET ${k.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...Object.values(cols), id); };

export default {
  name: 'contacts',
  permissions: [
    ['contacts.view', 'Kontaktbuch: Institutionen und Personen ansehen'],
    ['contacts.edit', 'Kontaktbuch: Einträge anlegen und bearbeiten'],
    ['contacts.delete', 'Kontaktbuch: Einträge löschen'],
    ['contacts.bank', 'Kontaktbuch: Bankdaten ansehen und bearbeiten'],
    ['contacts.secret', 'Kontaktbuch: Einträge für Rollen sperren/freigeben und alle gesperrten Einträge sehen'],
  ],
  routes(r) {
    r.get('/api/contacts/options', { perm: 'contacts.view' }, (ctx) => ({
      orgTypes: lookupEntries('contacts.org_type', { onlyActive: true }), relations: lookupEntries('contacts.relation', { onlyActive: true }),
      flags: Object.entries(FLAGS).map(([key, [label, color]]) => ({ key, label, color })), channelKinds: Object.entries(CHANNEL_KINDS).map(([key, label]) => ({ key, label })),
      roles: ctx.user.perms.has('contacts.secret') ? all('SELECT id, name, color FROM roles ORDER BY name') : [],
      canEdit: ctx.user.perms.has('contacts.edit'), canDelete: ctx.user.perms.has('contacts.delete'), canBank: ctx.user.perms.has('contacts.bank'), canSecret: ctx.user.perms.has('contacts.secret'),
    }));

    // ── Institutionen ──
    r.get('/api/contacts/orgs', { perm: 'contacts.view' }, (ctx) => {
      const v = visSql(ctx.user, 'org', 'o'), where = [v.sql], p = [...v.params];
      if (ctx.query.type) { where.push('o.type_id = ?'); p.push(Number(ctx.query.type)); }
      if (FLAGS[ctx.query.flag]) { where.push('o.flag = ?'); p.push(ctx.query.flag); }
      if (ctx.query.q) { const q = `%${ctx.query.q}%`; where.push(`(o.name LIKE ? OR o.tags LIKE ? OR o.description LIKE ? OR o.address LIKE ? OR EXISTS (SELECT 1 FROM contact_channels c WHERE c.owner_type = 'org' AND c.owner_id = o.id AND c.value LIKE ?))`); p.push(q, q, q, q, q); }
      return { orgs: all(`SELECT o.* FROM contact_orgs o WHERE ${where.join(' AND ')} ORDER BY o.name COLLATE NOCASE LIMIT 500`, ...p).map((o) => orgDto(o, ctx.user)) };
    });
    r.get('/api/contacts/orgs/:id', { perm: 'contacts.view' }, (ctx) => {
      const o = loadOrg(ctx.user, ctx.params.id);
      const people = all('SELECT * FROM contact_people WHERE org_id = ? ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE', o.id).filter((p) => sees(ctx.user, 'person', p)).map((p) => personDto(p, ctx.user));
      return { org: orgDto(o, ctx.user, true), people };
    });
    r.post('/api/contacts/orgs', { perm: 'contacts.edit' }, (ctx) => {
      const b = ctx.body, f = orgFields(b, false), ch = parseChannels(b.channels), t = now(); secretFields(ctx, b, f);
      const id = tx(() => { const nid = insert('contact_orgs', { ...f, created_by: ctx.user.id, created_at: t, updated_at: t }); saveChannels('org', nid, ch); saveAccess('org', nid, b.roleIds); return nid; });
      audit(ctx, { action: 'contacts.org_created', module: 'contacts', targetType: 'contact_org', targetId: id, targetLabel: f.name });
      ctx.status = 201; return { org: orgDto(get('SELECT * FROM contact_orgs WHERE id = ?', id), ctx.user, true) };
    });
    r.patch('/api/contacts/orgs/:id', { perm: 'contacts.edit' }, (ctx) => {
      const o = loadOrg(ctx.user, ctx.params.id), b = ctx.body, f = orgFields(b, true), ch = parseChannels(b.channels); secretFields(ctx, b, f);
      tx(() => { update('contact_orgs', o.id, { ...f, updated_at: now() }); saveChannels('org', o.id, ch); saveAccess('org', o.id, b.roleIds); });
      audit(ctx, { action: 'contacts.org_updated', module: 'contacts', targetType: 'contact_org', targetId: o.id, targetLabel: f.name ?? o.name });
      return { org: orgDto(get('SELECT * FROM contact_orgs WHERE id = ?', o.id), ctx.user, true) };
    });
    r.delete('/api/contacts/orgs/:id', { perm: 'contacts.delete' }, (ctx) => {
      const o = loadOrg(ctx.user, ctx.params.id), n = get('SELECT COUNT(*) c FROM contact_people WHERE org_id = ?', o.id).c;
      tx(() => { run("DELETE FROM contact_channels WHERE owner_type = 'org' AND owner_id = ?", o.id); run("DELETE FROM contact_access WHERE owner_type = 'org' AND owner_id = ?", o.id); run('UPDATE contact_people SET org_id = NULL WHERE org_id = ?', o.id); run('DELETE FROM contact_orgs WHERE id = ?', o.id); });
      audit(ctx, { action: 'contacts.org_deleted', module: 'contacts', targetType: 'contact_org', targetId: o.id, targetLabel: o.name, after: { peopleKept: n } });
      return { ok: true, peopleKept: n };
    });

    // ── Personen ──
    r.get('/api/contacts/people', { perm: 'contacts.view' }, (ctx) => {
      const v = visSql(ctx.user, 'person', 'p'), where = [v.sql], p = [...v.params];
      const ov = visSql(ctx.user, 'org', 'o'); where.push(`(p.org_id IS NULL OR EXISTS (SELECT 1 FROM contact_orgs o WHERE o.id = p.org_id AND ${ov.sql}))`); p.push(...ov.params);
      if (ctx.query.org) { where.push('p.org_id = ?'); p.push(Number(ctx.query.org)); }
      if (ctx.query.relation) { where.push('p.relation_id = ?'); p.push(Number(ctx.query.relation)); }
      if (FLAGS[ctx.query.flag]) { where.push('p.flag = ?'); p.push(ctx.query.flag); }
      if (ctx.query.q) { const q = `%${ctx.query.q}%`; where.push(`(p.first_name LIKE ? OR p.last_name LIKE ? OR (p.first_name || ' ' || p.last_name) LIKE ? OR p.position LIKE ? OR p.tags LIKE ? OR p.address LIKE ? OR p.home_address LIKE ? OR EXISTS (SELECT 1 FROM contact_channels c WHERE c.owner_type = 'person' AND c.owner_id = p.id AND c.value LIKE ?) OR EXISTS (SELECT 1 FROM contact_orgs oo WHERE oo.id = p.org_id AND oo.name LIKE ?))`); p.push(q, q, q, q, q, q, q, q, q); }
      return { people: all(`SELECT p.* FROM contact_people p WHERE ${where.join(' AND ')} ORDER BY p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE LIMIT 500`, ...p).map((x) => personDto(x, ctx.user)) };
    });
    r.get('/api/contacts/people/:id', { perm: 'contacts.view' }, (ctx) => ({ person: personDto(loadPerson(ctx.user, ctx.params.id), ctx.user, true) }));
    r.post('/api/contacts/people', { perm: 'contacts.edit' }, (ctx) => {
      const b = ctx.body, f = personFields(b, false, ctx.user), ch = parseChannels(b.channels), t = now(); secretFields(ctx, b, f);
      const id = tx(() => { const nid = insert('contact_people', { ...f, created_by: ctx.user.id, created_at: t, updated_at: t }); saveChannels('person', nid, ch); saveAccess('person', nid, b.roleIds); return nid; });
      audit(ctx, { action: 'contacts.person_created', module: 'contacts', targetType: 'contact_person', targetId: id, targetLabel: `${f.first_name} ${f.last_name}`.trim() });
      ctx.status = 201; return { person: personDto(get('SELECT * FROM contact_people WHERE id = ?', id), ctx.user, true) };
    });
    r.patch('/api/contacts/people/:id', { perm: 'contacts.edit' }, (ctx) => {
      const p = loadPerson(ctx.user, ctx.params.id), b = ctx.body, f = personFields(b.firstName !== undefined || b.lastName !== undefined ? { firstName: p.first_name, lastName: p.last_name, ...b } : b, true, ctx.user), ch = parseChannels(b.channels); secretFields(ctx, b, f);
      tx(() => { update('contact_people', p.id, { ...f, updated_at: now() }); saveChannels('person', p.id, ch); saveAccess('person', p.id, b.roleIds); });
      audit(ctx, { action: 'contacts.person_updated', module: 'contacts', targetType: 'contact_person', targetId: p.id, targetLabel: `${f.first_name ?? p.first_name} ${f.last_name ?? p.last_name}`.trim(), after: b.bank !== undefined ? { bankChanged: true } : undefined });
      return { person: personDto(get('SELECT * FROM contact_people WHERE id = ?', p.id), ctx.user, true) };
    });
    r.delete('/api/contacts/people/:id', { perm: 'contacts.delete' }, (ctx) => {
      const p = loadPerson(ctx.user, ctx.params.id);
      tx(() => { run("DELETE FROM contact_channels WHERE owner_type = 'person' AND owner_id = ?", p.id); run("DELETE FROM contact_access WHERE owner_type = 'person' AND owner_id = ?", p.id); run('DELETE FROM contact_people WHERE id = ?', p.id); });
      audit(ctx, { action: 'contacts.person_deleted', module: 'contacts', targetType: 'contact_person', targetId: p.id, targetLabel: `${p.first_name} ${p.last_name}`.trim() });
      return { ok: true };
    });
  },
};
