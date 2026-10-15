/**
 * Registry der Apps, die für externe Partner freigeschaltet werden können.
 * Künftige Module (z. B. Aufträge, Dokumente) melden sich hier an – im Admin-Bereich wählt man pro Partner, welche gelten.
 */
const apps = new Map();
export const registerPartnerApp = (app) => apps.set(app.id, app);
export const partnerApps = () => [...apps.values()];
export const isPartnerApp = (id) => apps.has(id);
