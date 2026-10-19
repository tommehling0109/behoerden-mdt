/**
 * Modul-Registry des Frontends. Jedes Modul trägt seine Navigationseinträge hier ein.
 * Spätere Phasen (Fahrzeuge, Lager, Ankauf, Chat …) ergänzen nur weitere Einträge.
 *  - perm: sichtbar, wenn der Benutzer mindestens eines dieser Rechte hat (nur Darstellung; der Server prüft immer)
 *  - view: lazy geladene Ansicht → default export (container, ctx)
 */
export const NAV = [
  {
    section: 'Übersicht',
    items: [
      { id: 'dashboard', label: 'Dashboard', subtitle: 'Aktuelle Lage auf einen Blick', icon: 'dashboard', path: '/dashboard', win: { w: 1040, h: 660 }, view: () => import('./views/dashboard.js') },
      { id: 'schedule', label: 'Termine & Aufträge', subtitle: 'Kalender, Termine und Aufträge für Mitglieder', icon: 'calendar', path: '/schedule', perm: ['schedule.view'], win: { w: 1180, h: 720 }, view: () => import('./views/schedule.js'), badge: 'scheduleOpen' },
      { id: 'activity', label: 'Aktivität & Abmeldung', subtitle: 'Wer ist aktiv – und Abmeldung bei Urlaub oder Pause', icon: 'activity', path: '/activity', perm: ['activity.absence', 'activity.view'], win: { w: 1080, h: 680 }, view: () => import('./views/activity.js') },
      { id: 'help', label: 'Hilfe', subtitle: 'Anleitungen passend zu deinen Rechten', icon: 'help', path: '/help', win: { w: 1120, h: 700 }, view: () => import('./views/help.js') },
    ],
  },
  {
    section: 'Handel',
    items: [
      { id: 'trade', label: 'Handel', subtitle: 'Als Mitglied anbieten und auf Gesuche antworten – wie ein Partner', icon: 'star', path: '/trade', perm: ['market.trade'], cfg: 'market.member_trade', win: { w: 1080, h: 660 }, view: () => import('./views/partner/market.js') },
      { id: 'market', label: 'Börse', subtitle: 'Ankauf & Verkauf mit externen Partnern', icon: 'tag', path: '/market', perm: ['market.view'], win: { w: 1080, h: 660 }, view: () => import('./views/market.js'), badge: 'marketAwaiting' },
    ],
  },
  {
    section: 'Einsatz',
    items: [
      { id: 'map', label: 'Karte', subtitle: 'Interaktive Karte mit Waypoints und Postleitzahlen', icon: 'map', path: '/map', perm: ['map.view'], win: { w: 1200, h: 720 }, view: () => import('./views/map.js') },
      { id: 'warehouse', label: 'Lager', subtitle: 'Lagerstandorte, Bestand und Preisspannen', icon: 'storage', path: '/warehouse', perm: ['warehouse.view'], win: { w: 1120, h: 700 }, view: () => import('./views/warehouse.js') },
      { id: 'vehicles', label: 'Fahrzeuge', subtitle: 'Fuhrpark, Zustand und Standorte', icon: 'car', path: '/vehicles', perm: ['vehicles.view'], win: { w: 1120, h: 700 }, view: () => import('./views/vehicles.js') },
    ],
  },
  {
    section: 'Finanzen',
    items: [
      { id: 'finance', label: 'Finanzen', subtitle: 'Journal, Kontostand und Auswertungen', icon: 'wallet', path: '/finance', perm: ['finance.view'], win: { w: 1120, h: 700 }, view: () => import('./views/finance.js') },
      { id: 'stats', label: 'Statistik', subtitle: 'Kennzahlen und Diagramme aus allen Bereichen', icon: 'chart', path: '/stats', perm: ['stats.view'], win: { w: 1120, h: 700 }, view: () => import('./views/stats.js') },
      { id: 'credit', label: 'Kredit', subtitle: 'Kreditanfragen, Zinsen und Ratenpläne', icon: 'bank', path: '/credit', perm: ['credit.view'], win: { w: 1120, h: 680 }, view: () => import('./views/credit.js'), badge: 'creditAwaiting' },
      { id: 'tab', label: 'Deckel', subtitle: 'Firmen-Deckel, Abrechnungen und Zahlungen', icon: 'dollar', path: '/deckel', perm: ['tab.view', 'tab.statements', 'tab.manage_companies'], win: { w: 1120, h: 680 }, view: () => import('./views/tab.js') },
    ],
  },
  {
    section: 'Kommunikation',
    items: [
      { id: 'tickets', label: 'Tickets', subtitle: 'Fehler melden und verfolgen', icon: 'bug', path: '/tickets', win: { w: 1000, h: 640 }, view: () => import('./views/tickets.js') },
      { id: 'legal', label: 'Legal', subtitle: 'Gesetzessammlung, Bußgeldkatalog und Rechtsfälle', icon: 'scale', path: '/legal', perm: ['legal.view'], win: { w: 1180, h: 720 }, view: () => import('./views/legal.js') },
      { id: 'contacts', label: 'Kontaktbuch', subtitle: 'Institutionen, Personen und Kontaktdaten', icon: 'book', path: '/contacts', perm: ['contacts.view'], win: { w: 1180, h: 700 }, view: () => import('./views/contacts.js') },
      { id: 'chat', label: 'Chat', subtitle: 'Kanäle, Nachrichten und Pinnwand', icon: 'chat', path: '/chat', perm: ['chat.view'], win: { w: 1000, h: 640 }, view: () => import('./views/chat.js'), badge: 'chatUnread' },
    ],
  },
  {
    section: 'Administration',
    items: [
      { id: 'onboarding', label: 'Einarbeitung', subtitle: 'Checkliste für neue Mitglieder', icon: 'userCheck', path: '/onboarding', perm: ['onboarding.check', 'onboarding.manage'], win: { w: 1080, h: 680 }, view: () => import('./views/onboarding.js') },
      { id: 'users', label: 'Benutzer', subtitle: 'Zugänge verwalten und freischalten', icon: 'users', path: '/admin/users', perm: ['users.view'], win: { w: 1020, h: 640 }, view: () => import('./views/admin/users.js'), badge: 'pendingUsers' },
      { id: 'roles', label: 'Rollen & Rechte', subtitle: 'Rollen definieren und Berechtigungen zuweisen', icon: 'shield', path: '/admin/roles', perm: ['roles.view'], view: () => import('./views/admin/roles.js') },
      { id: 'org', label: 'Organisation', subtitle: 'Ränge, Abteilungen und Hierarchie', icon: 'sitemap', path: '/admin/org', perm: ['org.view'], win: { w: 1020, h: 640 }, view: () => import('./views/admin/org.js') },
      { id: 'partners', label: 'Externe Zugänge', subtitle: 'Links und Codes für Partner verwalten', icon: 'link', path: '/admin/partners', perm: ['partners.view'], win: { w: 1000, h: 640 }, view: () => import('./views/admin/partners.js') },
      { id: 'lookups', label: 'Kategorien & Status', subtitle: 'Auswahllisten, Kategorien und Status-Beschriftungen', icon: 'list', path: '/admin/lookups', perm: ['lookups.view'], win: { w: 900, h: 620 }, view: () => import('./views/admin/lookups.js') },
      { id: 'config', label: 'Konfiguration', subtitle: 'Darstellung und Systemverhalten anpassen', icon: 'settings', path: '/admin/config', perm: ['config.view', 'hack.manage', 'legal.manage'], view: () => import('./views/admin/config.js') },
      { id: 'audit', label: 'Audit-Log', subtitle: 'Nachvollziehbarkeit aller wichtigen Aktionen', icon: 'audit', path: '/admin/audit', perm: ['audit.view'], win: { w: 1020, h: 640 }, view: () => import('./views/admin/audit.js') },
    ],
  },
];

/**
 * Dock-Gruppen („Ordner“ wie auf dem Handy): mehrere Apps teilen sich ein Symbol im Dock; ein Klick öffnet die Auswahl.
 * Apps, die in keiner Gruppe stehen (Dashboard, Hilfe, Legal …), bleiben einzelne Symbole – neue Apps erscheinen so automatisch im Dock
 * und lassen sich hier bei Bedarf einer Gruppe zuordnen. Eine Gruppe mit nur einer sichtbaren App zeigt direkt diese App.
 * Die Reihenfolge im Dock folgt der Navigation: eine Gruppe steht dort, wo ihre erste App steht.
 */
export const DOCK_GROUPS = [
  { id: 'trade', label: 'Handel & Lager', items: ['trade', 'market', 'warehouse'] },
  { id: 'ops', label: 'Einsatz', items: ['map', 'vehicles'] },
  { id: 'money', label: 'Finanzen', items: ['finance', 'stats', 'credit', 'tab'] },
  { id: 'comm', label: 'Kommunikation', items: ['chat', 'tickets', 'contacts'] },
  { id: 'admin', label: 'Verwaltung', items: ['users', 'onboarding', 'roles', 'org', 'partners'] },
  { id: 'system', label: 'System', items: ['lookups', 'config', 'audit'] },
];

/** Standard-Anordnung des Docks (wenn der Administrator nichts eingestellt hat): Einträge { app } bzw. { gid, label, items }, in Navigationsreihenfolge. */
export function defaultDockLayout(nav = NAV) {
  const items = allItems(nav), ids = new Set(items.map((i) => i.id)), seen = new Set(), out = [];
  for (const it of items) {
    const g = DOCK_GROUPS.find((x) => x.items.includes(it.id));
    if (!g) { out.push({ app: it.id }); continue; }
    if (seen.has(g.id)) continue; seen.add(g.id);
    out.push({ gid: g.id, label: g.label, items: g.items.filter((id) => ids.has(id)) });
  }
  return out;
}

/** Layout + sichtbare Apps → Dock-Einträge ([{ app }] oder [{ group:{id,label}, items }]). Unbekannte/unsichtbare Apps entfallen, Gruppen mit nur einer sichtbaren App zeigen diese direkt, nicht erwähnte Apps (neue) kommen ans Ende. */
export function resolveDock(layout, visible) {
  const byId = new Map(visible.map((i) => [i.id, i])), used = new Set(), out = [];
  for (const e of layout) {
    if (e.app) { const it = byId.get(e.app); if (it && !used.has(it.id)) { used.add(it.id); out.push({ app: it }); } continue; }
    const items = (e.items ?? []).map((id) => byId.get(id)).filter((it) => it && !used.has(it.id)); items.forEach((i) => used.add(i.id));
    if (items.length > 1) out.push({ group: { id: e.gid, label: e.label }, items }); else if (items.length === 1) out.push({ app: items[0] });
  }
  for (const it of visible) if (!used.has(it.id)) out.push({ app: it });
  return out;
}

export const DEFAULT_PATH = '/dashboard';
export const allItems = (nav = NAV) => nav.flatMap((s) => s.items);

/** Apps im Partner-Portal (externe Zugänge). Sichtbar ist, was dem Partner serverseitig freigeschaltet wurde. */
export const PARTNER_NAV = [
  {
    section: 'Apps',
    items: [
      { id: 'market', label: 'Börse', subtitle: 'Angebote, Gesuche und Geschäfte', icon: 'tag', win: { w: 1000, h: 660 }, view: () => import('./views/partner/market.js'), badge: 'marketNew' },
      { id: 'chat', label: 'Chat', subtitle: 'Nachrichten mit dem Team', icon: 'chat', win: { w: 960, h: 620 }, view: () => import('./views/partner/chat.js'), badge: 'chatUnread' },
      { id: 'credit', label: 'Kredit', subtitle: 'Kredite anfragen und Raten verfolgen', icon: 'bank', win: { w: 1000, h: 660 }, view: () => import('./views/partner/credit.js'), badge: 'creditNew' },
      { id: 'help', label: 'Hilfe', subtitle: 'Anleitungen für deinen Zugang', icon: 'help', win: { w: 1040, h: 660 }, view: () => import('./views/help.js') },
    ],
  },
];
