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
