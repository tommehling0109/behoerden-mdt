import { state } from './state.js';

/**
 * „Neu / geändert“-Markierungen im Partner-Portal: pro Partner im Browser gemerkt, welchen Stand jedes Geschäft hatte, als es zuletzt angesehen wurde.
 * Beim allerersten Besuch wird der Bestand still als gesehen übernommen (sonst wäre alles „neu“).
 */
export const partnerScope = () => `partner:${state.user?.displayName ?? ''}`;
const key = (scope) => `mdt:seen:${scope}`;
const read = (scope) => { try { const v = JSON.parse(localStorage.getItem(key(scope))); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const write = (scope, v) => { try { localStorage.setItem(key(scope), JSON.stringify(v)); } catch { /* ohne Speicher: nichts markieren */ } };

/** Liefert Map<dealId, { kind: 'new' | 'status' | 'update', label }> der ungesehenen Änderungen. */
export function dealChanges(scope, deals) {
  let s = read(scope);
  if (!s) { s = { deals: Object.fromEntries(deals.map((d) => [d.id, { u: d.updatedAt, s: d.status }])), wanted: s?.wanted ?? null }; write(scope, s); return new Map(); }
  const out = new Map();
  for (const d of deals) {
    const prev = s.deals?.[d.id];
    if (!prev) out.set(d.id, { kind: 'new', label: d.direction === 'sell' ? 'Neues Angebot' : 'Neu' });
    else if (prev.s !== d.status) out.set(d.id, { kind: 'status', label: `Status: ${d.statusLabel}` });
    else if (prev.u !== d.updatedAt) out.set(d.id, { kind: 'update', label: 'Aktualisiert' });
  }
  return out;
}
export function markDealSeen(scope, d) {
  const s = read(scope) ?? { deals: {}, wanted: null };
  (s.deals ??= {})[d.id] = { u: d.updatedAt, s: d.status };
  write(scope, s);
}
export const unseenCount = (scope, deals) => dealChanges(scope, deals).size;

/** Neue Gesuche seit dem letzten Besuch (Set der IDs); markiert alle aktuellen als gesehen. */
export function wantedNew(scope, wanted) {
  const s = read(scope) ?? { deals: {}, wanted: null };
  const known = new Set(s.wanted ?? wanted.map((w) => w.id));
  const fresh = new Set(wanted.filter((w) => !known.has(w.id)).map((w) => w.id));
  s.wanted = wanted.map((w) => w.id);
  write(scope, s);
  return fresh;
}
