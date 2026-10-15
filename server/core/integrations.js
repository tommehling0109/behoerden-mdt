import { get, run, now } from './db.js';

/**
 * Integrationsschicht (nur Schnittstelle – keine konkrete Server-/FiveM-Anbindung in dieser Phase).
 *
 * Ein Provider (z. B. 'fivem') registriert Handler für Ereignisse wie 'vehicle.parked' oder 'character.position'.
 * Interne Datensätze werden über `external_refs` mit externen IDs verbunden (Character-ID, Fahrzeug-ID, Garage …),
 * sodass das MDT nie feste Server-IDs im Code kennt.
 */
const providers = new Map();

export function registerIntegration({ name, label, handlers = {} }) {
  providers.set(name, { name, label: label ?? name, handlers });
}
export const listIntegrations = () => [...providers.values()].map((p) => ({ name: p.name, label: p.label, events: Object.keys(p.handlers) }));

/** Verarbeitet ein eingehendes Ereignis eines Providers. Unbekannte Provider/Ereignisse werden ignoriert (false). */
export async function dispatchEvent(provider, event, payload) {
  const h = providers.get(provider)?.handlers[event];
  if (!h) return false;
  await h(payload);
  return true;
}

export function setExternalRef({ provider, entityType, entityId, externalId, meta }) {
  run(
    `INSERT INTO external_refs (provider,entity_type,entity_id,external_id,meta,created_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(provider,entity_type,entity_id) DO UPDATE SET external_id=excluded.external_id, meta=excluded.meta`,
    provider, entityType, entityId, String(externalId), meta ? JSON.stringify(meta) : null, now(),
  );
}

/** Interner Datensatz zu einer externen ID (z. B. Fahrzeug zu FiveM-Fahrzeug-ID). */
export function findByExternal(provider, entityType, externalId) {
  const r = get('SELECT entity_id FROM external_refs WHERE provider=? AND entity_type=? AND external_id=?', provider, entityType, String(externalId));
  return r ? r.entity_id : null;
}
export function externalIdOf(provider, entityType, entityId) {
  return get('SELECT external_id FROM external_refs WHERE provider=? AND entity_type=? AND entity_id=?', provider, entityType, entityId)?.external_id ?? null;
}
