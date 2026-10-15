import { get } from '../core/db.js';
import { can } from '../core/permissions.js';
import { getConfig, setConfig, validateConfigValue } from '../core/config.js';
import { audit } from '../core/audit.js';
import { bad } from '../core/http.js';
import { queryAudit } from '../core/audit.js';
import { all } from '../core/db.js';
import { codexInfo } from './legal.js';

const STARTED = Date.now();

/**
 * Widget-Registry. Spätere Module registrieren hier eigene Widgets (Fahrzeuge, Ankauf, Lager, …).
 * Sichtbarkeit/Reihenfolge lassen sich über die Einstellung `dashboard.widgets` überschreiben.
 */
const WIDGETS = [
  { id: 'codex', title: 'Codex', size: 'wide', pinTop: true, data: (ctx) => ({ codex: codexInfo(), canManage: can(ctx.user, 'legal.manage') }) },
  { id: 'welcome', title: 'Willkommen', size: 'wide', data: (ctx) => ({ roles: ctx.user.roles }) },
  { id: 'quick-links', title: 'Schnellzugriff', size: 'wide', data: () => ({}) },
  {
    id: 'user-stats', title: 'Benutzer', size: 'small', permission: 'users.view',
    data: () => ({ counts: Object.fromEntries(all('SELECT status, COUNT(*) c FROM users GROUP BY status').map((r) => [r.status, r.c])) }),
  },
  {
    id: 'pending-access', title: 'Offene Freischaltungen', size: 'medium', permission: 'users.approve',
    data: () => ({ users: all(`SELECT id, username, display_name, created_at FROM users WHERE status='pending' ORDER BY created_at LIMIT 6`)
      .map((u) => ({ id: u.id, username: u.username, displayName: `Antrag #${u.id}`, createdAt: u.created_at })) }),
  },
  {
    id: 'recent-activity', title: 'Letzte Aktivitäten', size: 'medium', permission: 'audit.view',
    data: (ctx) => ({ rows: queryAudit({ limit: 8, viewerId: ctx?.user?.id ?? null }).rows }),
  },
  {
    id: 'system-status', title: 'Systemstatus', size: 'small',
    data: () => ({ uptimeSeconds: Math.floor((Date.now() - STARTED) / 1000), serverTime: new Date().toISOString(), database: get('SELECT 1 ok') ? 'ok' : 'error' }),
  },
];

/** Weitere Module melden hier ihre Widgets an. */
export const registerWidget = (w) => { if (!WIDGETS.some((x) => x.id === w.id)) WIDGETS.push(w); };

// Reihenfolge: gespeicherte Anordnung; Widgets, die dort noch nicht stehen, kommen ans Ende – nur „angeheftete“ (Codex) bleiben vorn
const rank = (idx, w) => idx.get(w.id) ?? (w.pinTop ? -1 : 999);
const orderedLayout = () => {
  const layout = getConfig('dashboard.widgets') ?? [];
  const idx = new Map(layout.map((w, i) => [w.id, i]));
  const off = new Set(layout.filter((w) => !w.enabled).map((w) => w.id));
  return [...WIDGETS].sort((a, b) => rank(idx, a) - rank(idx, b)).map((w) => ({ id: w.id, title: w.title, size: w.size, permission: w.permission ?? null, enabled: !off.has(w.id) }));
};

const validLayout = (v) => Array.isArray(v) && v.every((w) => w && typeof w.id === 'string' && typeof w.enabled === 'boolean');

export default {
  name: 'dashboard',
  config: [
    { key: 'dashboard.widgets', group: 'Dashboard', label: 'Widget-Layout', type: 'json', default: [], hidden: true, validate: validLayout },
  ],
  routes(r) {
    // Konfiguration der Widgets (Sichtbarkeit + Reihenfolge) im Admin-Bereich
    r.get('/api/dashboard/layout', { perm: 'config.view' }, () => ({ widgets: orderedLayout() }));
    r.put('/api/dashboard/layout', { perm: 'config.edit' }, (ctx) => {
      const list = ctx.body.widgets;
      if (!Array.isArray(list) || !list.every((w) => w && typeof w.id === 'string' && typeof w.enabled === 'boolean')) throw bad('Ungültiges Layout.');
      const ids = new Set(WIDGETS.map((w) => w.id));
      if (list.some((w) => !ids.has(w.id))) throw bad('Unbekanntes Widget.');
      const value = validateConfigValue('dashboard.widgets', list.map(({ id, enabled }) => ({ id, enabled })));
      const before = getConfig('dashboard.widgets');
      setConfig('dashboard.widgets', value, ctx.user.id);
      audit(ctx, { action: 'config.changed', module: 'dashboard', targetType: 'setting', targetId: 'dashboard.widgets', targetLabel: 'Dashboard-Widgets', before, after: value });
      return { widgets: orderedLayout() };
    });

    r.get('/api/dashboard', (ctx) => {
      const layout = getConfig('dashboard.widgets') ?? [];
      const order = new Map(layout.map((w, i) => [w.id, i]));
      const off = new Set(layout.filter((w) => !w.enabled).map((w) => w.id));
      const widgets = WIDGETS
        .filter((w) => !off.has(w.id) && (!w.permission || can(ctx.user, w.permission)))
        .sort((a, b) => rank(order, a) - rank(order, b));
      return { widgets: widgets.map((w) => ({ id: w.id, title: w.title, size: w.size, data: w.data(ctx) })) };
    });
  },
};
