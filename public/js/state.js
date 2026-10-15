/** Kleiner globaler Zustand. Rechte hier dienen NUR der Darstellung – der Server prüft alles erneut. */
export const state = {
  config: {},
  user: null,
};

export const can = (perm) => !!state.user && state.user.status === 'active' && state.user.permissions.includes(perm);
export const canAny = (list) => list.some(can);

const THEMES = ['anthracite', 'black', 'midnight', 'ocean'];
const WALLPAPERS = ['lines', 'gradient', 'solid'];
const RADII = ['sharp', 'normal', 'round'];
const DENSITIES = ['compact', 'normal', 'comfortable'];

/** Setzt alle Darstellungs-Einstellungen (Farben, Vorlage, Radius, Dock …) als CSS-Variablen/Klassen. */
export function applyVars(cfg) {
  const root = document.documentElement;
  const one = (list, cur, prefix, def) => list.forEach((k) => root.classList.toggle(`${prefix}-${k}`, (cur || def) === k));
  const hw = cfg['ui.halloween'] === true; // Halloween-Design: Orange/Violett statt der gewählten Akzentfarben
  root.classList.toggle('halloween', hw);
  if (hw) { root.style.setProperty('--accent', '#ff7a18'); root.style.setProperty('--accent2', '#9b4dff'); }
  else {
    if (cfg['ui.accent']) root.style.setProperty('--accent', cfg['ui.accent']);
    if (cfg['ui.accent2']) root.style.setProperty('--accent2', cfg['ui.accent2']);
  }
  one(THEMES, cfg['ui.theme'], 'theme', 'anthracite');
  one(WALLPAPERS, cfg['ui.wallpaper_style'], 'wp', 'lines');
  one(RADII, cfg['ui.radius'], 'radius', 'normal');
  one(DENSITIES, cfg['ui.density'], 'density', 'normal');
  root.classList.toggle('no-glass', cfg['ui.glass'] === false);
  root.classList.toggle('no-anim', cfg['ui.animations'] === false);
  root.classList.toggle('no-widget', cfg['ui.show_widget'] === false);
  root.classList.toggle('no-watermark', cfg['ui.show_watermark'] === false);
  root.style.setProperty('--dock-size', `${Number(cfg['ui.dock_size']) || 52}px`);
  // Eigenes Logo / Hintergrundbild aus dem Admin-Panel (Version = Cache-Buster)
  const lv = cfg['branding.logo_version'], wv = cfg['branding.wallpaper_version'];
  const neutral = root.classList.contains('neutral'); // Subdomain für Externe: kein Logo
  const logo = neutral ? null : lv ? `/branding/logo?v=${lv}` : '/img/logo.svg';
  root.style.setProperty('--logo-url', logo ? `url(${logo})` : 'none');
  root.classList.toggle('custom-logo', !!lv);
  if (wv) root.style.setProperty('--wallpaper-url', `url(/branding/wallpaper?v=${wv})`); else root.style.removeProperty('--wallpaper-url');
  root.classList.toggle('has-wallpaper', !!wv);
  const fav = document.querySelector('link[rel="icon"]');
  if (fav && logo) fav.href = logo;
}

export function applyConfig(cfg) {
  state.config = cfg;
  applyVars(cfg);
  document.title = cfg['system.name'] || 'MDT';
  window.dispatchEvent(new Event('mdt:config-applied'));
}

/** Live-Vorschau in der Konfiguration: wirkt sofort, ohne zu speichern. */
export const previewConfig = (partial) => applyVars({ ...state.config, ...partial });
