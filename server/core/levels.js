import { all, get, run, now } from './db.js';
import { getConfig } from './config.js';
import { notify } from './notifications.js';

/**
 * Level-System für externe Partner (pro Partner aktivierbar): abgeschlossene Geschäfte (Börse Kauf/Verkauf, Kredite) geben XP,
 * 10 Level mit Name und Symbol. XP berechnet sich automatisch aus der Geschäftsgröße oder manuell (fester Wert je Geschäftsart,
 * Börse zusätzlich je Artikel). Nur Admins können XP/Level ändern. Gezählt wird ab der Aktivierung, nie rückwirkend, nie doppelt.
 */
export const LEVEL_ICONS = ['lv1', 'lv2', 'lv3', 'lv4', 'lv5', 'lv6', 'lv7', 'lv8', 'lv9', 'lv10'];
export const DEFAULT_LEVELS = [
  { name: 'Neuling', icon: 'lv1', xp: 0 }, { name: 'Lehrling', icon: 'lv2', xp: 150 }, { name: 'Händler', icon: 'lv3', xp: 450 }, { name: 'Geselle', icon: 'lv4', xp: 1000 },
  { name: 'Profi', icon: 'lv5', xp: 2000 }, { name: 'Experte', icon: 'lv6', xp: 3800 }, { name: 'Meister', icon: 'lv7', xp: 6500 }, { name: 'Veteran', icon: 'lv8', xp: 10500 },
  { name: 'Elite', icon: 'lv9', xp: 16500 }, { name: 'Legende', icon: 'lv10', xp: 25000 },
];
export const validLevels = (v) => Array.isArray(v) && v.length === 10 && v.every((l, i) => l && typeof l.name === 'string' && l.name.trim().length >= 1 && l.name.length <= 24
  && LEVEL_ICONS.includes(l.icon) && Number.isInteger(l.xp) && l.xp >= 0 && l.xp <= 100_000_000 && (i === 0 ? l.xp === 0 : l.xp > v[i - 1].xp));
const levels = () => { const v = getConfig('level.levels'); return validLevels(v) ? v : DEFAULT_LEVELS; };

/** Level zu einer XP-Zahl. */
export function levelOfXp(xp) {
  const ls = levels(); let n = 0;
  ls.forEach((l, i) => { if (xp >= l.xp) n = i; });
  const cur = ls[n], next = ls[n + 1] ?? null;
  return { n: n + 1, name: cur.name, icon: cur.icon, xp, from: cur.xp, next: next ? { n: n + 2, name: next.name, xp: next.xp, remaining: next.xp - xp } : null,
    progress: next ? Math.min(1, (xp - cur.xp) / (next.xp - cur.xp)) : 1 };
}
export const levelThreshold = (n) => levels()[n - 1]?.xp ?? 0;

/** Kurzform für Anzeigen (null = Level-System für diesen Partner aus). */
export function levelBrief(partnerId) {
  const p = get('SELECT level_enabled, level_xp FROM partners WHERE id = ?', partnerId);
  if (!p?.level_enabled) return null;
  const l = levelOfXp(p.level_xp);
  return { n: l.n, name: l.name, icon: l.icon };
}
/** Vollständige Angaben (für das Team und für den Partner selbst). */
export function levelDetail(partnerId, { history = 40 } = {}) {
  const p = get('SELECT level_enabled, level_xp, level_since FROM partners WHERE id = ?', partnerId);
  if (!p) return null;
  if (!p.level_enabled) return { enabled: false, since: p.level_since };
  const l = levelOfXp(p.level_xp);
  return { enabled: true, ...l, since: p.level_since, levels: levels().map((x, i) => ({ n: i + 1, ...x })),
    history: all('SELECT id, delta, xp_after, reason, ref_type, ref_id, note, created_at FROM partner_xp_log WHERE partner_id = ? ORDER BY id DESC LIMIT ?', partnerId, history)
      .map((h) => ({ id: h.id, delta: h.delta, xpAfter: h.xp_after, kind: h.reason, note: h.note, createdAt: h.created_at })) };
}

const cfgNum = (k, d) => { const v = Number(getConfig(k)); return Number.isFinite(v) ? v : d; };
/** XP für ein abgeschlossenes Geschäft. type: 'buy' | 'sell' | 'credit'; value in Währungseinheiten (nicht Cent); itemId nur Börse. */
export function xpFor(type, value, itemId = null) {
  const mode = getConfig(`level.mode.${type}`) ?? 'auto';
  if (mode === 'off') return 0;
  if (mode === 'fixed') {
    const own = itemId ? get('SELECT xp FROM market_items WHERE id = ?', itemId)?.xp : null;
    return Math.max(0, Math.round(own ?? cfgNum(`level.fixed.${type}`, 25)));
  }
  const per = Math.max(1, cfgNum('level.auto_per', 1000)), min = Math.max(0, cfgNum('level.auto_min', 5)), max = Math.max(min, cfgNum('level.auto_max', 500));
  return Math.min(max, Math.max(min, Math.round(cfgNum('level.auto_base', 10) + Math.max(0, value) / per)));
}

/** Schreibt XP gut/ab (Verlauf + Benachrichtigung). refType/refId verhindern doppelte Vergabe für Geschäfte. */
export function addXp(partnerId, delta, { kind, refType = null, refId = null, note = '', userId = null, silent = false }) {
  const p = get('SELECT level_enabled, level_xp, partner_number FROM partners WHERE id = ?', partnerId);
  if (!p?.level_enabled || !Number.isInteger(delta) || delta === 0) return null;
  if (refType && get('SELECT 1 x FROM partner_xp_log WHERE partner_id = ? AND ref_type = ? AND ref_id = ?', partnerId, refType, refId)) return null;
  const before = levelOfXp(p.level_xp), after = Math.max(0, p.level_xp + delta), applied = after - p.level_xp;
  if (applied === 0) return null;
  run('UPDATE partners SET level_xp = ? WHERE id = ?', after, partnerId);
  const id = Number(run('INSERT INTO partner_xp_log (partner_id,delta,xp_after,reason,ref_type,ref_id,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)', partnerId, applied, after, kind, refType, refId, note, userId, now()).lastInsertRowid);
  const now_ = levelOfXp(after);
  if (!silent) {
    const up = now_.n > before.n, down = now_.n < before.n;
    notify([{ type: 'partner', id: partnerId }], { key: `xp:${id}`, title: applied > 0 ? `+${applied} XP${up ? ` · Level ${now_.n} erreicht` : ''}` : `${applied} XP${down ? ` · Level ${now_.n}` : ''}`,
      body: up ? `Du bist aufgestiegen: Level ${now_.n} (${now_.name}).` : note || (applied > 0 ? 'Erfahrungspunkte für ein abgeschlossenes Geschäft.' : 'Dein Level wurde angepasst.'), target: { app: 'level' } });
  }
  return { id, applied, level: now_, leveledUp: now_.n > before.n };
}

// ── Hooks: abgeschlossene Geschäfte ──
export function awardForDeal(dealId) {
  const d = get('SELECT d.id, d.partner_id, d.direction, d.deal_number FROM market_deals d WHERE d.id = ?', dealId);
  if (!d) return null;
  const type = d.direction === 'sell' ? 'sell' : 'buy';
  const lines = all('SELECT l.item_id, l.quantity, l.unit_price, i.is_other FROM market_deal_lines l JOIN market_items i ON i.id = l.item_id WHERE l.deal_id = ? ORDER BY l.pos, l.id', dealId);
  if (!lines.length) lines.push(...all('SELECT d.item_id, d.quantity, d.unit_price, i.is_other FROM market_deals d JOIN market_items i ON i.id = d.item_id WHERE d.id = ?', dealId)); // Geschäft ohne Positionszeilen (Altbestand): Kopfdaten
  const total = Math.round(lines.reduce((a, l) => a + l.quantity * l.unit_price, 0) * 100) / 100;
  // Automatisch: einmal nach dem Gesamtwert. Fest: Item-XP je Position, Positionen ohne eigene XP zusammen einmal der Standardwert.
  let xp;
  if ((getConfig(`level.mode.${type}`) ?? 'auto') === 'fixed') {
    xp = 0; let usedDefault = false;
    for (const l of lines) { const own = l.is_other ? null : get('SELECT xp FROM market_items WHERE id = ?', l.item_id)?.xp; if (own != null) xp += Math.max(0, Math.round(own)); else if (!usedDefault) { usedDefault = true; xp += xpFor(type, 0, null); } }
  } else xp = xpFor(type, total, null);
  return addXp(d.partner_id, xp, { kind: 'deal', refType: 'deal', refId: d.id, note: `Geschäft ${d.deal_number ?? d.id} abgeschlossen` });
}
export function awardForLoan(loanId) {
  const l = get('SELECT id, partner_id, principal_cents, loan_number FROM credit_loans WHERE id = ?', loanId);
  if (!l) return null;
  return addXp(l.partner_id, xpFor('credit', l.principal_cents / 100), { kind: 'loan', refType: 'loan', refId: l.id, note: `Kredit ${l.loan_number ?? l.id} vollständig zurückgezahlt` });
}
