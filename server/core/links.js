import { all, get, run, now } from './db.js';

/**
 * Generische Verknüpfungen zwischen beliebigen Datensätzen (entity_type + entity_id).
 * Vorbereitet für Operation↔Fahrzeug, Aufgabe↔Mitarbeiter, Karte↔Lager usw.: Beziehungen werden einmal
 * gespeichert statt doppelt in den Modulen. Typnamen vergeben die Module selbst (z. B. 'user', 'vehicle', 'operation').
 */
export function link(from, to, { relation = 'related', meta, userId } = {}) {
  run(
    `INSERT OR IGNORE INTO entity_links (from_type,from_id,to_type,to_id,relation,meta,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    from.type, from.id, to.type, to.id, relation, meta ? JSON.stringify(meta) : null, userId ?? null, now(),
  );
}

export function unlink(from, to, relation = 'related') {
  run('DELETE FROM entity_links WHERE from_type=? AND from_id=? AND to_type=? AND to_id=? AND relation=?', from.type, from.id, to.type, to.id, relation);
}

/** Alle Verknüpfungen eines Datensatzes – in beide Richtungen. */
export function linksOf(entity, { relation, otherType } = {}) {
  const rows = all(
    `SELECT * FROM entity_links WHERE (from_type=? AND from_id=?) OR (to_type=? AND to_id=?) ORDER BY id`,
    entity.type, entity.id, entity.type, entity.id,
  );
  return rows
    .map((r) => {
      const outgoing = r.from_type === entity.type && r.from_id === entity.id;
      return {
        id: r.id, relation: r.relation, direction: outgoing ? 'out' : 'in',
        other: outgoing ? { type: r.to_type, id: r.to_id } : { type: r.from_type, id: r.from_id },
        meta: r.meta ? JSON.parse(r.meta) : null,
      };
    })
    .filter((l) => (!relation || l.relation === relation) && (!otherType || l.other.type === otherType));
}

export const removeLinksOf = (entity) =>
  run('DELETE FROM entity_links WHERE (from_type=? AND from_id=?) OR (to_type=? AND to_id=?)', entity.type, entity.id, entity.type, entity.id);

export const hasLink = (from, to, relation = 'related') =>
  !!get('SELECT 1 x FROM entity_links WHERE from_type=? AND from_id=? AND to_type=? AND to_id=? AND relation=?', from.type, from.id, to.type, to.id, relation);
