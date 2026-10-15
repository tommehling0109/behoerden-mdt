import { h, mount, debounce } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, select, formError, openModal, confirmDialog, toast, empty } from '../ui/kit.js';
import { api } from '../api.js';

const LEAFLET = '/vendor/leaflet/leaflet.js';
const COLORS = ['#5b82b8', '#e5484d', '#f59e0b', '#84cc16', '#10b981', '#06b6d4', '#8b5cf6', '#ec4899', '#a3a3a3'];
let leafletReady;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return (leafletReady ??= new Promise((res, rej) => {
    if (!document.querySelector('link[data-leaflet]')) document.head.append(h('link', { rel: 'stylesheet', href: '/vendor/leaflet/leaflet.css', 'data-leaflet': '1' }));
    const s = h('script', { src: LEAFLET });
    s.onload = () => res(window.L);
    s.onerror = () => { leafletReady = null; rej(new Error('Kartenbibliothek konnte nicht geladen werden.')); };
    document.head.append(s);
  }));
}
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default async function render(container, ctx) {
  mount(container, h('div', { class: 'empty' }, 'Karte wird geladen …'));
  let L, cfg, postals;
  try { [L, cfg] = await Promise.all([loadLeaflet(), api.get('/api/map/config')]); } catch (e) { return mount(container, empty('Karte nicht verfügbar', e.message, 'alert')); }
  if (!ctx.isCurrent()) return;
  const imageMode = cfg.base === 'image' && cfg.image?.url;
  // Bild-Modus: 1 Karteneinheit = 1 Bildpixel (Zoom 0 = Originalgröße, bis 8-fach hineinzoomen); Kachel-Modus wie bisher
  const calib = imageMode ? cfg.image.calib : cfg.calib, minZoom = imageMode ? -3 : cfg.minZoom, maxZoom = imageMode ? 0 : cfg.maxZoom, maxView = imageMode ? 3 : cfg.maxZoom + 1;
  const toLL = (x, y) => L.latLng(calib.y - calib.scale * y, calib.x + calib.scale * x);
  const toGame = (ll) => ({ x: (ll.lng - calib.x) / calib.scale, y: (calib.y - ll.lat) / calib.scale });
  const SIZE = 256 * 2 ** maxZoom;
  const bounds = imageMode ? L.latLngBounds([[0, 0], [cfg.image.height, cfg.image.width]]) : L.latLngBounds([[0, 0], [SIZE, SIZE]]);

  const state = { points: [], vehicles: [], hidden: new Set(), q: '', showPostals: cfg.showPostals, showVeh: true, layers: [], offLayers: new Set(), placing: false, moving: false };
  const side = h('aside', { class: 'map-side' });
  const mapEl = h('div', { class: 'map-el' });
  const status = h('div', { class: 'map-bar' }, 'Bewege die Maus über die Karte');
  const stage = h('div', { class: 'map-stage' }, mapEl, status);
  mount(container, h('div', { class: 'mapview' }, side, stage));

  const crs = L.extend({}, L.CRS.Simple, { transformation: new L.Transformation(1, 0, 1, 0), scale: (z) => 2 ** (z - maxZoom), zoom: (s) => Math.log2(s) + maxZoom });
  const map = L.map(mapEl, { crs, minZoom, maxZoom: maxView, zoomSnap: 0.5, zoomDelta: 0.5, attributionControl: false, maxBounds: bounds.pad(0.1), maxBoundsViscosity: 0.8 });
  const tiles = imageMode ? L.imageOverlay(cfg.image.url, bounds).addTo(map) : L.tileLayer(cfg.tileUrl, { minZoom, maxNativeZoom: maxZoom, maxZoom: maxZoom + 1, tileSize: 256, noWrap: true, bounds, errorTileUrl: '' }).addTo(map);
  const pointLayer = L.layerGroup().addTo(map);
  const vehLayer = L.layerGroup().addTo(map);
  const postalLayer = L.layerGroup();
  map.fitBounds(bounds, { animate: false });
  const startView = () => (imageMode ? map.fitBounds(bounds, { animate: false }) : map.setView(toLL(0, 0), Math.max(minZoom, maxZoom - 2.5), { animate: false }));
  startView();
  let touched = false; for (const ev of ['pointerdown', 'wheel', 'keydown']) mapEl.addEventListener(ev, () => { touched = true; }, { passive: true });
  const ro = new ResizeObserver(() => { map.invalidateSize(); if (imageMode && !touched) startView(); }); // in den ersten Sekunden (Fenster-Öffnen, Layout) die Gesamtansicht nachführen
  ro.observe(mapEl);
  let tileErr = 0;
  if (imageMode) tiles.getElement?.()?.addEventListener('error', () => toast('Das Kartenbild konnte nicht geladen werden. Prüfe die URL unter Konfiguration → Karte.', 'err'));
  else tiles.on('tileerror', () => { if (++tileErr === 6) toast('Kartenkacheln konnten nicht geladen werden. Prüfe die Kachel-URL unter Konfiguration → Karte.', 'err'); });

  const pinIcon = (p, cls = '') => L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14],
    html: `<div class="map-pin ${cls}" style="--c:${esc(p.color)};width:30px;height:30px">${icon(p.icon).outerHTML}</div>` });

  const notesHtml = (t) => t ? `<div class="pop-notes">${t.split('\n').filter((l) => l.trim()).map((l) => `<p>${/^\s*[-•*]\s*/.test(l) ? '• ' : ''}${esc(l.replace(/^\s*[-•*]\s*/, ''))}</p>`).join('')}</div>` : '';

  function popup(p) {
    const el = h('div');
    el.innerHTML = `<div class="pop-title">${esc(p.name)}</div>${p.category ? `<span class="badge" style="--c:${esc(p.category.color)}">${esc(p.category.label)}</span>` : ''}${notesHtml(p.description)}<div class="pop-kv">X ${Math.round(p.x)} · Y ${Math.round(p.y)}${p.visibility === 'editors' ? ' · nur Bearbeiter' : ''}</div>`;
    if (cfg.canEdit) el.append(h('div', { class: 'pop-actions' }, button('Bearbeiten', { size: 'sm', icon: 'edit', onClick: () => { map.closePopup(); editPoint(p); } }), button('Verschieben', { size: 'sm', icon: 'target', onClick: () => { map.closePopup(); startMove(p); } })));
    return el;
  }

  const markers = new Map();
  function drawPoints() {
    pointLayer.clearLayers(); markers.clear();
    const q = state.q.toLowerCase();
    for (const p of state.points) {
      if (state.hidden.has(p.category?.id ?? 0)) continue;
      if (q && !`${p.name} ${p.description}`.toLowerCase().includes(q)) continue;
      const m = L.marker(toLL(p.x, p.y), { icon: pinIcon(p), title: p.name }).bindPopup(() => popup(p));
      m.addTo(pointLayer); markers.set(p.id, m);
    }
  }
  function drawVehicles() {
    vehLayer.clearLayers();
    if (!state.showVeh) return;
    for (const v of state.vehicles) {
      const m = L.marker(toLL(v.x, v.y), { icon: pinIcon({ icon: 'car', color: v.condition.color ?? '#5b82b8' }, 'veh'), title: v.plate });
      m.bindPopup(() => { const el = h('div'); el.innerHTML = `<div class="pop-title">${esc(v.name)}</div><span class="badge" style="--c:${esc(v.condition.color)}">${esc(v.condition.label)}</span><div class="pop-kv">${esc(v.plate)}${v.number ? ' · ' + esc(v.number) : ''}${v.location ? ' · ' + esc(v.location) : ''}${v.slot ? ' · ' + esc(v.slot) : ''}</div>`; return el; });
      m.addTo(vehLayer); markers.set(`v${v.id}`, m);
    }
  }

  // ── Postleitzahlen (ausgedünnt nach Bildschirmraster) ──
  async function ensurePostals() { if (!postals) postals = (await api.get('/api/map/postals')).postals; return postals; }
  async function drawPostals() {
    postalLayer.clearLayers();
    if (!state.showPostals || map.getZoom() < minZoom + 2) { map.removeLayer(postalLayer); return; }
    await ensurePostals();
    if (!map.hasLayer(postalLayer)) postalLayer.addTo(map);
    const view = map.getBounds().pad(0.1), z = map.getZoom();
    const cell = z >= maxZoom - 1 ? 34 : z >= maxZoom - 2 ? 56 : 84, taken = new Set();
    for (const [code, x, y] of postals) {
      const ll = toLL(x, y);
      if (!view.contains(ll)) continue;
      const pt = map.latLngToContainerPoint(ll), key = `${Math.floor(pt.x / cell)}:${Math.floor(pt.y / cell)}`;
      if (taken.has(key)) continue;
      taken.add(key);
      L.marker(ll, { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="postal-label">${code}</div>` }) }).addTo(postalLayer);
    }
  }
  const redrawPostals = debounce(drawPostals, 120);
  map.on('moveend zoomend', redrawPostals);

  // ── Statusleiste: Spielkoordinaten + nächste PLZ ──
  const nearest = (x, y) => { let b = null, d = Infinity; for (const p of postals ?? []) { const dd = (p[1] - x) ** 2 + (p[2] - y) ** 2; if (dd < d) { d = dd; b = p; } } return b; };
  map.on('mousemove', (e) => { const g = toGame(e.latlng), n = nearest(g.x, g.y); status.textContent = `X ${Math.round(g.x)} · Y ${Math.round(g.y)}${n ? ` · PLZ ${n[0]}` : ''}`; });

  // ── Waypoints setzen / verschieben ──
  let hint = null;
  const stopModes = () => { state.placing = false; state.moving = false; hint?.remove(); hint = null; mapEl.classList.remove('placing'); drawTools(); };
  const setHint = (t) => { hint?.remove(); hint = h('div', { class: 'map-hint' }, t); stage.append(hint); };
  function startPlace() { stopModes(); state.placing = true; mapEl.classList.add('placing'); setHint('Klicke auf die Karte, um einen Waypoint zu setzen (Esc = Abbrechen)'); drawTools(); }
  let movingPoint = null;
  function startMove(p) { stopModes(); state.moving = true; movingPoint = p; mapEl.classList.add('placing'); setHint(`„${p.name}“ – klicke auf die neue Position (Esc = Abbrechen)`); drawTools(); }
  map.on('click', async (e) => {
    const g = toGame(e.latlng);
    if (state.placing) { stopModes(); editPoint(null, { x: Math.round(g.x * 10) / 10, y: Math.round(g.y * 10) / 10 }); }
    else if (state.moving && movingPoint) {
      const p = movingPoint; stopModes();
      try { await api.patch(`/api/map/points/${p.id}`, { x: Math.round(g.x * 10) / 10, y: Math.round(g.y * 10) / 10 }); toast('Waypoint verschoben.'); await loadPoints(); } catch (ex) { toast(ex.message, 'err'); }
    }
  });
  const onKey = (e) => { if (e.key === 'Escape' && (state.placing || state.moving)) stopModes(); };
  document.addEventListener('keydown', onKey);

  function editPoint(p, at) {
    const err = h('div');
    const name = input({ value: p?.name ?? '', maxLength: 80, placeholder: 'z. B. Eisen-Farm' });
    const cat = select([{ value: '', label: '— keine —' }, ...cfg.categories.map((c) => ({ value: c.id, label: c.label }))], p?.category?.id ?? '');
    let iconSel = p?.icon ?? 'pin', colorSel = p?.color ?? '';
    const iconGrid = h('div', { class: 'icon-grid' });
    const drawIcons = () => mount(iconGrid, cfg.icons.map((n) => { const b = h('button', { type: 'button', class: `icon-opt ${n === iconSel ? 'on' : ''}`, title: n }, icon(n)); b.addEventListener('click', () => { iconSel = n; drawIcons(); }); return b; }));
    drawIcons();
    const colorRow = h('div', { class: 'chips' });
    const drawColors = () => mount(colorRow, [h('button', { type: 'button', class: `btn btn-sm ${colorSel === '' ? 'btn-primary' : ''}`, onclick: () => { colorSel = ''; drawColors(); } }, 'Kategoriefarbe'), ...COLORS.map((c) => h('button', { type: 'button', title: c, style: { width: '26px', height: '26px', borderRadius: '50%', background: c, border: colorSel === c ? '3px solid #fff' : '2px solid transparent', cursor: 'pointer' }, onclick: () => { colorSel = c; drawColors(); } }))]);
    drawColors();
    const notes = h('textarea', { class: 'textarea', rows: 5, maxLength: 1500, placeholder: '- Stichpunkt 1\n- Stichpunkt 2' }, p?.description ?? '');
    const vis = select([{ value: 'all', label: 'Alle mit Kartenzugriff' }, { value: 'editors', label: 'Nur Bearbeiter' }], p?.visibility ?? 'all');
    const px = input({ type: 'number', step: 'any', value: p?.x ?? at?.x ?? 0 }), py = input({ type: 'number', step: 'any', value: p?.y ?? at?.y ?? 0 });
    const plz = input({ placeholder: 'z. B. 7085', inputMode: 'numeric', maxLength: 6 });
    plz.addEventListener('change', async () => {
      const code = plz.value.trim();
      if (!code) return;
      await ensurePostals();
      const hit = postals.find((q) => String(q[0]) === code);
      if (hit) { px.value = hit[1]; py.value = hit[2]; } else toast('Postleitzahl nicht gefunden.', 'err');
    });
    const body = h('div', null, err, field('Name', name), h('div', { class: 'form-row' }, field('Kategorie', cat), field('Sichtbarkeit', vis)),
      field('Symbol', iconGrid), field('Farbe', colorRow), field('Notizen (Stichpunkte mit „- “)', notes), field('Position per Postleitzahl setzen (optional)', plz), h('div', { class: 'form-row' }, field('X', px), field('Y', py)));
    const footer = [];
    if (p) footer.push(button('Löschen', { variant: 'danger', icon: 'trash', onClick: async () => {
      if (!await confirmDialog({ title: 'Waypoint löschen?', message: `„${p.name}“ wird entfernt.`, confirmLabel: 'Löschen' })) return;
      try { await api.del(`/api/map/points/${p.id}`); m.close(); toast('Waypoint gelöscht.'); loadPoints(); } catch (e) { toast(e.message, 'err'); }
    } }));
    footer.push(h('span', { class: 'grow' }), button('Abbrechen', { onClick: () => m.close() }), button(p ? 'Speichern' : 'Setzen', { variant: 'primary', icon: 'check', onClick: (e) => busy(e.currentTarget, async () => {
      const payload = { name: name.value, categoryId: cat.value ? Number(cat.value) : null, icon: iconSel, color: colorSel || null, description: notes.value, visibility: vis.value, x: Number(px.value), y: Number(py.value) };
      try { p ? await api.patch(`/api/map/points/${p.id}`, payload) : await api.post('/api/map/points', payload); m.close(); toast(p ? 'Gespeichert.' : 'Waypoint gesetzt.'); loadPoints(); }
      catch (ex) { err.replaceChildren(formError(ex.message)); }
    }) }));
    const m = openModal({ title: p ? 'Waypoint bearbeiten' : 'Neuer Waypoint', body, footer });
  }

  // ── Werkzeuge & Seitenleiste ──
  function drawTools() {
    ctx.setActions(
      cfg.canEdit && button(state.placing ? 'Abbrechen' : 'Waypoint setzen', { variant: 'primary', icon: state.placing ? 'x' : 'pin', onClick: () => (state.placing || state.moving ? stopModes() : startPlace()) }),
      button('Postleitzahlen', { icon: 'list', variant: state.showPostals ? 'info' : '', onClick: () => { state.showPostals = !state.showPostals; drawPostals(); drawTools(); } }),
      cfg.canVehicles && button('Fahrzeuge', { icon: 'car', variant: state.showVeh ? 'info' : '', onClick: () => { state.showVeh = !state.showVeh; drawVehicles(); drawTools(); } }),
      state.layers.map((l) => button(l.label, { icon: l.icon, variant: state.offLayers.has(l.key) ? '' : 'info', onClick: () => { state.offLayers.has(l.key) ? state.offLayers.delete(l.key) : state.offLayers.add(l.key); drawLayers(); drawTools(); } })));
  }
  const search = input({ placeholder: 'Waypoint oder „Postal 1234“ …' });
  const catBox = h('div', { class: 'chips' });
  const list = h('div', { class: 'ms-list' });
  mount(side, h('div', { class: 'ms-head' }, h('div', { class: 'input-icon' }, icon('search'), search), catBox), list);

  const zoomMid = imageMode ? 1.5 : maxZoom - 1, zoomClose = imageMode ? 2 : maxZoom; // passende Zoomstufen je Kartengrundlage
  function goto(x, y, zoom) { map.setView(toLL(x, y), zoom ?? zoomMid, { animate: true }); }
  search.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const m = /^(?:postal|plz|p)?\s*(\d{1,5})$/i.exec(search.value.trim());
    if (!m) return;
    await ensurePostals();
    const hit = postals.find((p) => String(p[0]) === m[1]);
    if (hit) { goto(hit[1], hit[2]); toast(`Postal ${hit[0]}`); } else toast('Postleitzahl nicht gefunden.', 'err');
  });
  search.addEventListener('input', () => { state.q = search.value.trim(); drawPoints(); drawList(); });

  function drawList() {
    const q = state.q.toLowerCase();
    const items = state.points.filter((p) => !state.hidden.has(p.category?.id ?? 0) && (!q || `${p.name} ${p.description}`.toLowerCase().includes(q)));
    mount(catBox, [...cfg.categories, { id: 0, label: 'Ohne', color: '#9aa0a6' }].map((c) => {
      const off = state.hidden.has(c.id);
      const b = h('button', { type: 'button', class: `cchip ${off ? 'zero' : 'on'}`, style: { '--c': c.color } }, h('span', { class: 'dot' }), c.label);
      b.addEventListener('click', () => { off ? state.hidden.delete(c.id) : state.hidden.add(c.id); drawPoints(); drawList(); });
      return b;
    }));
    mount(list, items.length ? items.map((p) => {
      const el = h('div', { class: 'ms-item' }, h('div', { class: 'mi', style: { '--c': p.color } }, icon(p.icon)), h('div', { style: { minWidth: 0 } }, h('div', { class: 'mt' }, p.name), h('div', { class: 'ms' }, p.category?.label ?? 'Ohne Kategorie')));
      el.addEventListener('click', () => { goto(p.x, p.y); markers.get(p.id)?.openPopup(); });
      return el;
    }) : h('div', { class: 'ms', style: { padding: '16px', color: 'var(--text-3)' } }, state.points.length ? 'Keine Treffer.' : cfg.canEdit ? 'Noch keine Waypoints. Setze den ersten über „Waypoint setzen“.' : 'Noch keine Waypoints.'));
  }

  async function loadPoints() {
    try { state.points = (await api.get('/api/map/points')).points; } catch (e) { return toast(e.message, 'err'); }
    drawPoints(); drawList();
  }
  async function loadVehicles() {
    if (!cfg.canVehicles) return;
    try { state.vehicles = (await api.get('/api/map/vehicles')).vehicles; } catch { state.vehicles = []; }
    drawVehicles();
  }

  // Ebenen anderer Module (z. B. Lager) – Orte per Koordinaten oder Postleitzahl
  const layerGroup = L.layerGroup().addTo(map);
  const layerSubs = new Set();
  function drawLayers() {
    layerGroup.clearLayers();
    for (const l of state.layers) {
      if (state.offLayers.has(l.key)) continue;
      for (const i of l.items) {
        const m = L.marker(toLL(i.x, i.y), { icon: pinIcon({ icon: l.icon, color: l.color }), title: i.name });
        m.bindPopup(() => { const el = h('div'); el.innerHTML = `<div class="pop-title">${esc(i.name)}</div><span class="badge" style="--c:${esc(l.color)}">${esc(l.label)}</span>${i.subtitle ? `<div class="pop-kv">${esc(i.subtitle)}</div>` : ''}<div class="pop-kv">${i.postal ? 'Postal ' + esc(i.postal) + ' · ' : ''}X ${Math.round(i.x)} · Y ${Math.round(i.y)}</div>`; return el; });
        m.addTo(layerGroup); markers.set(`${l.key}:${i.id}`, m);
      }
    }
  }
  async function loadLayers() {
    try { state.layers = (await api.get('/api/map/layers')).layers; } catch { state.layers = []; }
    drawLayers(); drawTools();
    for (const l of state.layers) if (l.topic && !layerSubs.has(l.topic)) { layerSubs.add(l.topic); ctx.live([l.topic], loadLayers, { wait: 300 }); }
  }

  drawTools();
  await Promise.all([loadPoints(), loadVehicles(), loadLayers()]);
  if (state.showPostals) drawPostals();

  // Fokus aus der Fahrzeugverwaltung (auch wenn die Karte schon offen ist)
  const applyFocus = () => {
    try {
      const raw = sessionStorage.getItem('mdt:map:focus');
      if (!raw) return;
      sessionStorage.removeItem('mdt:map:focus');
      const f = JSON.parse(raw);
      if (Number.isFinite(f.x) && Number.isFinite(f.y)) { goto(f.x, f.y, zoomClose); setTimeout(() => markers.get(f.type === 'vehicle' ? `v${f.id}` : `${f.type}s:${f.id}`)?.openPopup(), 300); }
    } catch { /* egal */ }
  };
  window.addEventListener('mdt:map-focus', applyFocus);
  applyFocus();

  ctx.live(['map'], loadPoints, { wait: 200 });
  ctx.live(['vehicles'], loadVehicles, { wait: 300 });
  ctx.live(['lookups'], async () => { try { cfg = { ...cfg, categories: (await api.get('/api/map/config')).categories }; drawList(); } catch { /* egal */ } }, { wait: 300 });
  return () => { ro.disconnect(); document.removeEventListener('keydown', onKey); window.removeEventListener('mdt:map-focus', applyFocus); map.remove(); };
}
