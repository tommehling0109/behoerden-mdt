import { all } from './db.js';
import { getConfig } from './config.js';
import { APP_COMMIT, COMMIT_KNOWN } from './version.js';
import { loadAccess } from './permissions.js';
import { notify } from './notifications.js';

/**
 * Update-Prüfung: Fragt (alle 6 Stunden und auf Knopfdruck) den neuesten Commit des Repositorys auf GitHub ab und vergleicht ihn mit dem
 * installierten Stand. Ist er neuer, erhalten Superadmin und Administratoren EINMAL je neuer Version eine Benachrichtigung im System.
 * Gesendet wird nichts außer der anonymen Abfrage von api.github.com; abschaltbar unter Konfiguration → Updates.
 */
export const updateState = { checkedAt: null, available: null, latest: null, error: null };

const admins = () => all("SELECT id FROM users WHERE status = 'active'").filter((u) => loadAccess(u.id).isAdmin).map((u) => ({ type: 'user', id: u.id }));

export async function checkForUpdate({ fetchFn = globalThis.fetch, force = false } = {}) {
  if (!force && getConfig('system.update_check') === false) return updateState;
  const repo = String(getConfig('system.update_repo') || 'tommehling0109/mdt-template').trim();
  updateState.checkedAt = new Date().toISOString();
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Ungültiges Repository (erwartet: besitzer/name).');
    const res = await fetchFn(`https://api.github.com/repos/${repo}/commits/main`, { headers: { 'User-Agent': 'mdt-template', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`GitHub antwortet mit ${res.status}.`);
    const c = await res.json();
    const sha = String(c.sha ?? '');
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Unerwartete Antwort von GitHub.');
    const message = String(c.commit?.message ?? '').split('\n')[0].slice(0, 140);
    updateState.latest = { sha, short: sha.slice(0, 7), message, date: c.commit?.committer?.date ?? null, url: `https://github.com/${repo}/commit/${sha}` };
    updateState.error = null;
    updateState.available = COMMIT_KNOWN ? !sha.startsWith(APP_COMMIT) : null; // ohne Git-Stand (ZIP) lässt sich nichts vergleichen
    if (updateState.available) notify(admins(), { key: `update:${sha.slice(0, 7)}`, title: 'Update verfügbar', body: `Neue Version ${sha.slice(0, 7)}: ${message}. Installiert ist ${APP_COMMIT}.`, target: { app: 'config' } });
  } catch (e) { updateState.error = e.message || String(e); }
  return updateState;
}

let timer = null;
/** Startet die regelmäßige Prüfung (erste nach 45 s). In Tests mit MDT_UPDATE_CHECK=0 abgeschaltet. */
export function startUpdateChecks() {
  if (timer || process.env.MDT_UPDATE_CHECK === '0') return;
  const first = setTimeout(() => checkForUpdate(), 45_000); first.unref?.();
  timer = setInterval(() => checkForUpdate(), 6 * 3600_000); timer.unref?.();
}
