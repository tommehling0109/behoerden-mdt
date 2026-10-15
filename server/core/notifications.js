import { all, get, run, now } from './db.js';
import { loadAccess } from './permissions.js';
import { publish } from './realtime.js';

/**
 * Zentrale Benachrichtigungslogik – identisch für Mitarbeiter ('user') und Partner ('partner').
 *
 * Jede Benachrichtigung hat einen Ereignis-Schlüssel (event_key), der EINE echte Änderung identifiziert
 * (z. B. deal:12:ev:341 = Verlaufseintrag 341). Der UNIQUE-Index (Empfänger + Schlüssel) verhindert doppelte Verarbeitung
 * desselben Ereignisses, jede neue Änderung hat aber einen neuen Schlüssel und erzeugt daher immer eine eigene Benachrichtigung.
 */
export function notify(recipients, { key, title, body = '', target: target0 = null }) {
  const created = now();
  let count = 0;
  for (let r of recipients) {
    let target = target0;
    if (r.type === 'partner') { const uid = get('SELECT user_id FROM partners WHERE id = ?', r.id)?.user_id; if (uid) { r = { type: 'user', id: uid }; if (target?.app === 'market') target = { ...target, app: 'trade' }; } }
    const res = run(
      `INSERT OR IGNORE INTO notifications (recipient_type,recipient_id,event_key,title,body,target,created_at) VALUES (?,?,?,?,?,?,?)`,
      r.type, r.id, key, title, body, target ? JSON.stringify(target) : null, created,
    );
    if (Number(res.changes) !== 1) continue; // dasselbe Ereignis wurde für diesen Empfänger bereits verarbeitet
    count++;
    publish({
      type: 'notification', topic: 'notification', kind: 'new',
      userId: r.type === 'user' ? r.id : null, partnerId: r.type === 'partner' ? r.id : null,
      data: { id: Number(res.lastInsertRowid), key, title, body, target, createdAt: created },
    });
  }
  return count;
}

const dto = (n) => ({ id: n.id, key: n.event_key, title: n.title, body: n.body, target: n.target ? JSON.parse(n.target) : null, createdAt: n.created_at, read: !!n.read_at });

export function listNotifications(type, id, limit = 40) {
  return {
    notifications: all('SELECT * FROM notifications WHERE recipient_type = ? AND recipient_id = ? ORDER BY id DESC LIMIT ?', type, id, limit).map(dto),
    unread: get('SELECT COUNT(*) c FROM notifications WHERE recipient_type = ? AND recipient_id = ? AND read_at IS NULL', type, id).c,
  };
}

export function markRead(type, id, ids) {
  const t = now();
  if (Array.isArray(ids) && ids.length) {
    for (const nid of ids.filter(Number.isInteger)) run('UPDATE notifications SET read_at = ? WHERE id = ? AND recipient_type = ? AND recipient_id = ? AND read_at IS NULL', t, nid, type, id);
  } else run('UPDATE notifications SET read_at = ? WHERE recipient_type = ? AND recipient_id = ? AND read_at IS NULL', t, type, id);
  // andere Tabs/Geräte desselben Empfängers aktualisieren ihren Zähler
  publish({ type: 'notification', topic: 'notification', kind: 'read', userId: type === 'user' ? id : null, partnerId: type === 'partner' ? id : null });
}

/** Eigene Benachrichtigungen löschen (ids = Auswahl, null = alle). */
export function removeNotifications(type, id, ids) {
  if (Array.isArray(ids)) { for (const nid of ids.filter(Number.isInteger)) run('DELETE FROM notifications WHERE id = ? AND recipient_type = ? AND recipient_id = ?', nid, type, id); }
  else run('DELETE FROM notifications WHERE recipient_type = ? AND recipient_id = ?', type, id);
  publish({ type: 'notification', topic: 'notification', kind: 'read', userId: type === 'user' ? id : null, partnerId: type === 'partner' ? id : null });
}

/** Alle aktiven Mitarbeiter, die ein Recht besitzen (ohne optional auszuschließenden Benutzer). */
export function staffWith(perm, exceptUserId = null) {
  return all(`SELECT id FROM users WHERE status = 'active'`)
    .filter((u) => u.id !== exceptUserId && loadAccess(u.id).perms.has(perm))
    .map((u) => ({ type: 'user', id: u.id }));
}
