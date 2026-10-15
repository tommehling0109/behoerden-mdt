import { all, get, run, now } from './db.js';
import { bad } from './http.js';

/**
 * Konfigurations-Registry. Module registrieren Definitionen (Default im Code,
 * Wert in der DB). `public: true` ⇒ auch vor dem Login lesbar (z. B. Systemname, Akzentfarbe).
 */
const defs = new Map();
export function registerConfig(list) {
  for (const d of list) defs.set(d.key, { type: 'string', public: false, ...d });
}

export function getConfig(key) {
  const d = defs.get(key);
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (row) { try { return JSON.parse(row.value); } catch { /* fällt auf Default */ } }
  return d?.default;
}

export const publicConfig = () => {
  const out = {};
  for (const d of defs.values()) if (d.public) out[d.key] = getConfig(d.key);
  return out;
};

/** Recht, das zum Ändern einer Einstellung nötig ist (Standard: config.edit). */
export const configEditPerm = (key) => defs.get(key)?.perm ?? 'config.edit';

/** viewer (optional): nur Einstellungen liefern, die der Benutzer sehen darf (config.view = alle, sonst nur die mit eigenem Recht). */
export function describeConfig(viewer = null) {
  return [...defs.values()].filter((d) => !viewer || viewer.perms.has('config.view') || (d.perm && viewer.perms.has(d.perm))).map((d) => ({
    key: d.key, perm: d.perm ?? null, group: d.group, label: d.label, help: typeof d.help === 'function' ? d.help() : d.help, type: d.type, options: d.options,
    min: d.min, max: d.max, hidden: !!d.hidden, value: getConfig(d.key), default: d.default,
  }));
}

export function validateConfigValue(key, v) {
  const d = defs.get(key);
  if (!d) throw bad(`Unbekannte Einstellung: ${key}`);
  switch (d.type) {
    case 'string':
      if (typeof v !== 'string' || (!v.trim() && !d.allowEmpty) || v.length > (d.max ?? 80)) throw bad(`${d.label}: ungültiger Text.`);
      if (d.check && v.trim()) d.check(v.trim()); // z. B. nur Google-Links (wirft bad())
      return v.trim();
    case 'color':
      if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw bad(`${d.label}: ungültige Farbe.`);
      return v.toLowerCase();
    case 'bool':
      if (typeof v !== 'boolean') throw bad(`${d.label}: ungültiger Wert.`);
      return v;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v) || v < (d.min ?? -Infinity) || v > (d.max ?? Infinity)) throw bad(`${d.label}: Zahl außerhalb des erlaubten Bereichs.`);
      return v;
    case 'select':
      if (!d.options.some((o) => o.value === v)) throw bad(`${d.label}: ungültige Auswahl.`);
      return v;
    case 'json':
      if (d.validate && !d.validate(v)) throw bad(`${d.label}: ungültige Struktur.`);
      return v;
    default: throw bad('Unbekannter Typ.');
  }
}

export function setConfig(key, value, userId) {
  run(
    `INSERT INTO settings (key,value,updated_at,updated_by) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    key, JSON.stringify(value), now(), userId ?? null,
  );
}
