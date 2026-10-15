import { all, get, run, tx } from './db.js';

/**
 * Zentrale Auswahllisten (Kategorien, Status-Beschriftungen, Übergabeorte …).
 * Module registrieren eine Liste mit `registerLookup`:
 *  - `fixed`: Einträge, deren SCHLÜSSEL der Code kennt (z. B. Status-Zustände). Admin darf Beschriftung, Farbe und
 *    Beschreibung ändern, aber weder löschen noch deaktivieren.
 *  - ohne `fixed`: freie Liste – der Admin legt Einträge selbst an (z. B. Item-Kategorien).
 *  - `usage(id)`: Anzahl Verwendungen, damit belegte Einträge nicht gelöscht werden.
 */
const lists = new Map();
export function registerLookup(def) { lists.set(def.key, { fixed: null, usage: () => 0, ...def }); }
export const lookupLists = () => [...lists.values()];
export const lookupList = (k) => lists.get(k);

export function syncLookups() {
  tx(() => {
    for (const l of lists.values()) {
      (l.fixed ?? []).forEach((f, i) => {
        run(`INSERT INTO lookups (list_key,key,label,description,color,sort_order,is_active,is_system) VALUES (?,?,?,?,?,?,1,1)
             ON CONFLICT(list_key,key) DO UPDATE SET is_system = 1`, l.key, f.key, f.label, f.description ?? '', f.color ?? '#5b8def', i + 1);
      });
    }
  });
}

const dto = (r) => ({
  id: r.id, listKey: r.list_key, key: r.key, label: r.label, description: r.description, color: r.color,
  sortOrder: r.sort_order, isActive: !!r.is_active, isSystem: !!r.is_system,
});
export const lookupEntry = (id) => { const r = get('SELECT * FROM lookups WHERE id = ?', id); return r ? dto(r) : null; };
export const lookupEntries = (listKey, { onlyActive = false } = {}) =>
  all(`SELECT * FROM lookups WHERE list_key = ? ${onlyActive ? 'AND is_active = 1' : ''} ORDER BY sort_order, label`, listKey).map(dto);
export const lookupByKey = (listKey, key) => { const r = get('SELECT * FROM lookups WHERE list_key = ? AND key = ?', listKey, key); return r ? dto(r) : null; };
/** Gültiger, aktiver Eintrag einer Liste? (für Fremdschlüssel-Prüfungen in Modulen) */
export const isActiveEntry = (listKey, id) => !!get('SELECT 1 x FROM lookups WHERE id = ? AND list_key = ? AND is_active = 1', id, listKey);
export const entryUsage = (e) => lists.get(e.listKey)?.usage(e.id) ?? 0;

export function slugify(label) {
  return label.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'eintrag';
}
