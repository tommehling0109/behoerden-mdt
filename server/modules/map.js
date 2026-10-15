import { all, get, run, now } from '../core/db.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bad, notFound, str } from '../core/http.js';
import { audit } from '../core/audit.js';
import { getConfig } from '../core/config.js';
import { registerLookup, lookupEntries, isActiveEntry } from '../core/lookups.js';

/**
 * Interaktive Karte. Punkte (Waypoints) werden in SPIEL-Koordinaten (x, y) gespeichert – unabhängig von der Kartenquelle.
 * Die Umrechnung auf die Kacheln (Kalibrierung) und die Kachel-URL sind in der Konfiguration einstellbar.
 * Postleitzahlen: Daten des Projekts „nearest-postal“ (MIT-Lizenz, © 2019 BlockBa5her).
 */
registerLookup({
  key: 'map.category', module: 'Karte', label: 'Karten-Kategorien', description: 'Gliedern die Waypoints (z. B. Farming, Lager, Verkauf, Treffpunkt) – frei erweiterbar.',
  usage: (id) => get('SELECT COUNT(*) c FROM map_points WHERE category_id = ?', id).c,
});

export const MAP_ICONS = ['pin', 'flag', 'star', 'home', 'storage', 'wrench', 'fuel', 'car', 'boat', 'plane', 'medical', 'shield', 'dollar', 'camera', 'target', 'key', 'users', 'alert'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

let postals = null;
const loadPostals = () => (postals ??= JSON.parse(readFileSync(fileURLToPath(new URL('../data/postals.json', import.meta.url)), 'utf8'))
  .map((p) => [p.code, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]));

/**
 * Karten-Ebenen: Andere Module (z. B. Lager) melden ihre Orte hier an und erscheinen automatisch auf der Karte.
 *   registerMapLayer({ key, label, icon, color, perm, topic, items: (user) => [{ id, name, subtitle, x, y, postal }] })
 * Ein Ort braucht entweder Koordinaten (x, y) oder eine Postleitzahl (postal) – die Postleitzahl wird serverseitig in Koordinaten umgerechnet.
 */
const layers = new Map();
export const registerMapLayer = (l) => layers.set(l.key, { icon: 'pin', color: '#f59e0b', ...l });
export const postalCoords = (code) => { const p = loadPostals().find((q) => String(q[0]) === String(code).trim()); return p ? { x: p[1], y: p[2] } : null; };

const SQL = `SELECT p.*, c.label cat_label, c.color cat_color FROM map_points p LEFT JOIN lookups c ON c.id = p.category_id`;
const dto = (p, user) => ({
  id: p.id, name: p.name, description: p.description, icon: p.icon, color: p.color ?? p.cat_color ?? '#5b82b8',
  category: p.category_id ? { id: p.category_id, label: p.cat_label, color: p.cat_color } : null,
  x: p.x, y: p.y, visibility: p.visibility, createdAt: p.created_at, updatedAt: p.updated_at, canEdit: user.perms.has('map.edit'),
});

function fields(b, partial) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) out.name = str(b.name, 'Name', { min: 1, max: 80 });
  if (b.description !== undefined || !partial) out.description = str(b.description, 'Notizen', { max: 1500, required: false });
  if (b.categoryId !== undefined) {
    const c = b.categoryId == null || b.categoryId === '' ? null : b.categoryId;
    if (c != null && !isActiveEntry('map.category', c)) throw bad('Unbekannte Kategorie.');
    out.category_id = c;
  }
  if (b.icon !== undefined) { if (!MAP_ICONS.includes(b.icon)) throw bad('Unbekanntes Symbol.'); out.icon = b.icon; }
  if (b.color !== undefined) { if (b.color !== null && !COLOR_RE.test(b.color)) throw bad('Ungültige Farbe.'); out.color = b.color; }
  if (has('x') || has('y')) {
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || Math.abs(b.x) > 20000 || Math.abs(b.y) > 20000) throw bad('Ungültige Koordinaten.');
    out.x = b.x; out.y = b.y;
  }
  if (b.visibility !== undefined) { if (!['all', 'editors'].includes(b.visibility)) throw bad('Ungültige Sichtbarkeit.'); out.visibility = b.visibility; }
  return out;
}

export default {
  name: 'map',
  permissions: [
    ['map.view', 'Karte öffnen und Waypoints ansehen'],
    ['map.edit', 'Karte: Waypoints setzen, bearbeiten und löschen'],
  ],
  config: [
    { key: 'map.base', group: 'Karte', label: 'Kartengrundlage', help: 'Kacheln = Satellitenkarte aus Kacheln (Standard) mit eingeblendeten Postleitzahlen. Bild = die mitgelieferte Postal-Karte (Nummern aufgedruckt).', type: 'select', default: 'tiles', options: [{ value: 'image', label: 'Bild (Postal-Karte)' }, { value: 'tiles', label: 'Kacheln (Satellit)' }] },
    { key: 'map.image_url', group: 'Karte', label: 'Kartenbild (URL)', help: 'Standard: /img/map.webp (mitgeliefert). Ein eigenes Bild muss zur Kalibrierung unten passen.', type: 'string', default: '/img/map.webp', max: 300 },
    { key: 'map.image_width', group: 'Karte', label: 'Kartenbild: Breite (px)', type: 'number', default: 1333, min: 1, max: 100000 },
    { key: 'map.image_height', group: 'Karte', label: 'Kartenbild: Höhe (px)', type: 'number', default: 2000, min: 1, max: 100000 },
    { key: 'map.image_scale', group: 'Karte', label: 'Kartenbild: Pixel pro Spieleinheit', type: 'number', default: 0.1485, min: 0.00001, max: 1000 },
    { key: 'map.image_x', group: 'Karte', label: 'Kartenbild: X-Versatz (px)', help: 'Bildspalte, an der die Spielkoordinate X = 0 liegt.', type: 'number', default: 613, min: -1000000, max: 1000000 },
    { key: 'map.image_y', group: 'Karte', label: 'Kartenbild: Y-Versatz von oben (px)', help: 'Bildzeile, an der die Spielkoordinate Y = 0 liegt.', type: 'number', default: 1246.2, min: -1000000, max: 1000000 },
    { key: 'map.tile_url', group: 'Karte', label: 'Kachel-URL der Karte', help: 'Vorlage mit {z}, {x} und {y} (z. B. …/{z}/{x}-{y}.webp). Eigene Kacheln lassen sich unter /maptiles/{z}/{x}/{y}.png aus dem Ordner data/maptiles ausliefern.', type: 'string', default: 'https://viruxe.github.io/gtav-map-tiles/satelite/{z}/{x}-{y}.webp', max: 300 },
    { key: 'map.min_zoom', group: 'Karte', label: 'Kleinste Zoomstufe', type: 'number', default: 0, min: 0, max: 12 },
    { key: 'map.max_zoom', group: 'Karte', label: 'Größte Zoomstufe (Kachelauflösung)', type: 'number', default: 5, min: 1, max: 12 },
    { key: 'map.calib_scale', group: 'Karte', label: 'Kalibrierung: Pixel pro Spieleinheit', help: 'Rechnet Spielkoordinaten in Kartenpixel der größten Zoomstufe um. Standard: per Küstenabgleich mit der Postal-Karte berechnet (scripts/fit-map-calibration.py) – die Postleitzahlen liegen damit auf den Gebäuden der Satellitenkarte.', type: 'number', default: 0.66, min: 0.0001, max: 1000 },
    { key: 'map.calib_x', group: 'Karte', label: 'Kalibrierung: X-Versatz (px)', type: 'number', default: 3755.8, min: -1000000, max: 1000000 },
    { key: 'map.calib_y', group: 'Karte', label: 'Kalibrierung: Y-Versatz von oben (px)', type: 'number', default: 5530.1, min: -1000000, max: 1000000 },
    { key: 'map.show_postals', group: 'Karte', label: 'Postleitzahlen standardmäßig anzeigen', help: 'Blendet die Postleitzahlen als Beschriftung über der Karte ein. Bei der Postal-Karte (Bild) sind sie bereits aufgedruckt – dann besser aus.', type: 'bool', default: true },
  ],
  routes(r) {
    r.get('/api/map/config', { perm: 'map.view' }, (ctx) => ({
      base: getConfig('map.base'),
      image: { url: getConfig('map.image_url'), width: getConfig('map.image_width'), height: getConfig('map.image_height'), calib: { scale: getConfig('map.image_scale'), x: getConfig('map.image_x'), y: getConfig('map.image_y') } },
      tileUrl: getConfig('map.tile_url'), minZoom: getConfig('map.min_zoom'), maxZoom: getConfig('map.max_zoom'),
      calib: { scale: getConfig('map.calib_scale'), x: getConfig('map.calib_x'), y: getConfig('map.calib_y') },
      showPostals: getConfig('map.show_postals'), icons: MAP_ICONS,
      canEdit: ctx.user.perms.has('map.edit'), canVehicles: ctx.user.perms.has('vehicles.view') && ctx.user.perms.has('vehicles.view_location'),
      categories: lookupEntries('map.category', { onlyActive: true }),
    }));

    r.get('/api/map/layers', { perm: 'map.view' }, (ctx) => ({
      layers: [...layers.values()].filter((l) => !l.perm || ctx.user.perms.has(l.perm)).map((l) => ({
        key: l.key, label: l.label, icon: l.icon, color: l.color, topic: l.topic ?? null,
        items: l.items(ctx.user).map((i) => {
          const at = Number.isFinite(i.x) && Number.isFinite(i.y) ? { x: i.x, y: i.y } : i.postal ? postalCoords(i.postal) : null;
          return at ? { id: i.id, name: i.name, subtitle: i.subtitle ?? '', postal: i.postal ?? null, x: at.x, y: at.y } : null;
        }).filter(Boolean),
      })),
    }));

    r.get('/api/map/postals', { perm: 'map.view' }, () => ({ postals: loadPostals() }));

    r.get('/api/map/points', { perm: 'map.view' }, (ctx) => {
      const canEdit = ctx.user.perms.has('map.edit');
      const rows = all(`${SQL} ${canEdit ? '' : "WHERE p.visibility = 'all'"} ORDER BY p.name`);
      return { points: rows.map((p) => dto(p, ctx.user)) };
    });

    r.post('/api/map/points', { perm: 'map.edit' }, (ctx) => {
      const f = fields(ctx.body, false);
      const t = now();
      const cols = { icon: 'pin', visibility: 'all', ...f, created_by: ctx.user.id, created_at: t, updated_at: t };
      const res = run(`INSERT INTO map_points (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`, ...Object.values(cols));
      const id = Number(res.lastInsertRowid);
      audit(ctx, { action: 'map.point_created', module: 'map', targetType: 'point', targetId: id, targetLabel: f.name, after: { name: f.name, x: Math.round(f.x), y: Math.round(f.y) } });
      ctx.status = 201;
      return { point: dto(get(`${SQL} WHERE p.id = ?`, id), ctx.user) };
    });

    r.patch('/api/map/points/:id', { perm: 'map.edit' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get(`${SQL} WHERE p.id = ?`, id);
      if (!cur) throw notFound('Waypoint nicht gefunden.');
      const f = fields(ctx.body, true);
      const cols = Object.keys(f);
      if (cols.length) run(`UPDATE map_points SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => f[c]), now(), id);
      const p = get(`${SQL} WHERE p.id = ?`, id);
      audit(ctx, { action: 'map.point_updated', module: 'map', targetType: 'point', targetId: id, targetLabel: p.name, before: { name: cur.name, x: Math.round(cur.x), y: Math.round(cur.y) }, after: { name: p.name, x: Math.round(p.x), y: Math.round(p.y) } });
      return { point: dto(p, ctx.user) };
    });

    r.delete('/api/map/points/:id', { perm: 'map.edit' }, (ctx) => {
      const id = Number(ctx.params.id);
      const cur = get('SELECT * FROM map_points WHERE id = ?', id);
      if (!cur) throw notFound('Waypoint nicht gefunden.');
      run('DELETE FROM map_points WHERE id = ?', id);
      audit(ctx, { action: 'map.point_deleted', module: 'map', targetType: 'point', targetId: id, targetLabel: cur.name });
      return { ok: true };
    });

    // Fahrzeug-Ebene: nur mit Fahrzeug- UND Standortrecht
    r.get('/api/map/vehicles', { perm: 'map.view' }, (ctx) => {
      if (!ctx.user.perms.has('vehicles.view') || !ctx.user.perms.has('vehicles.view_location')) return { vehicles: [] };
      const rows = all(`SELECT v.id, v.vehicle_number, v.plate, v.name, v.loc_x, v.loc_y, v.location_text, v.parking_slot, v.condition_key, k.label cond_label, k.color cond_color
        FROM vehicles v LEFT JOIN lookups k ON k.list_key = 'vehicles.condition' AND k.key = v.condition_key WHERE v.is_active = 1 AND v.loc_x IS NOT NULL`);
      return { vehicles: rows.map((v) => ({ id: v.id, number: v.vehicle_number, plate: v.plate, name: v.name, x: v.loc_x, y: v.loc_y, location: v.location_text, slot: v.parking_slot, condition: { key: v.condition_key, label: v.cond_label, color: v.cond_color } })) };
    });
  },
};
