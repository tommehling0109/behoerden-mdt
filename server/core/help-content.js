/**
 * Standard-Inhalte der Hilfe-App. Jedes Kapitel gehört zu einer Zielgruppe (aud: 'm' = Mitarbeiter, 'p' = externe Partner) und ist nur sichtbar, wenn die Person
 * Zugriff auf das Thema hat: `perm` (mindestens eines dieser Rechte), `app` (die App darf nicht abgeschaltet sein bzw. ist dem Partner freigeschaltet) und
 * `cfg` (Einstellung muss eingeschaltet sein). Einzelne Abschnitte können ein eigenes `perm` tragen. Administratoren können jedes Kapitel im Panel überschreiben
 * oder ausblenden und eigene Kapitel anlegen (siehe modules/help.js).
 *
 * Textformat der Abschnitte: Absätze durch Leerzeile trennen · „1. …“ = Schritt · „- …“ = Aufzählung · „Tipp: …“, „Achtung: …“, „Hinweis: …“ = Kasten · **fett**.
 */
export const GROUPS_M = ['Grundlagen', 'Apps', 'Verwaltung'];
export const GROUPS_P = ['Grundlagen', 'Apps'];

const S = (title, text, perm) => ({ title, text: text.trim(), ...(perm ? { perm } : {}) });

export const HELP_ARTICLES = [
  // ───────────── Mitarbeiter · Grundlagen ─────────────
  { id: 'm-welcome', aud: 'm', group: 'Grundlagen', title: 'Willkommen im Panel', icon: 'home', summary: 'Was das Panel ist und wie du dich zurechtfindest.', sections: [
    S('Was ist das Panel?', `
Das Panel ist dein gemeinsamer Arbeitsplatz: Börse, Lager, Fahrzeuge, Finanzen, Chat und vieles mehr an einem Ort. Es sieht aus wie ein Desktop – jede **App** öffnet sich in einem eigenen Fenster.

Du siehst nur das, wofür dein Rang bzw. deine Rolle Rechte hat. Fehlt dir eine App, hast du dafür (noch) keine Berechtigung – frag bei Bedarf die Verwaltung.`),
    S('Die ersten Schritte', `
1. Melde dich mit deinem Benutzernamen und Passwort an. Neue Zugänge müssen zuerst von der Verwaltung freigeschaltet werden.
2. Öffne eine App über das **Dock** am unteren Rand oder das **Startmenü**.
3. Lies das Schwarze Brett und bestätige neue Hinweise, wenn dich das Panel dazu auffordert.
4. Mit dem Fragezeichen in der Fensterleiste kommst du jederzeit zur passenden Hilfe.

Tipp: Die Tour für Neulinge kannst du jederzeit unter „Hilfe“ → „Tour noch einmal ansehen“ wiederholen.`),
  ] },
  { id: 'm-desktop', aud: 'm', group: 'Grundlagen', title: 'Der Desktop und die Fenster', icon: 'dashboard', summary: 'Dock, Startmenü, Fenster verschieben und Größe ändern.', sections: [
    S('Dock und Startmenü', `
- Das **Dock** am unteren Rand zeigt deine Apps. Ein Klick öffnet die App, ein weiterer holt ein minimiertes Fenster zurück.
- Das **Startmenü** listet alle Apps nach Bereichen. Hier findest du auch Einstellungen, Konto und Abmelden.
- Rote Zähler an einer App zeigen, dass dort etwas auf dich wartet (z. B. ungelesene Chat-Nachrichten).`),
    S('Fenster bedienen', `
- **Verschieben:** Titelleiste anfassen und ziehen.
- **Größe ändern:** Fensterrand oder Ecke ziehen.
- **Maximieren / Minimieren / Schließen:** die drei Knöpfe oben rechts im Fenster. Ein Doppelklick auf die Titelleiste maximiert ebenfalls.
- Du kannst mehrere Apps gleichzeitig offen haben.

Tipp: Desktop-Symbole kannst du in den Einstellungen ein- oder ausblenden und frei verschieben.`),
  ] },
  { id: 'm-sidebar', aud: 'm', group: 'Grundlagen', title: 'Rechte Spalte: Brett, Probleme, Online', icon: 'flag', summary: 'Schwarzes Brett, Problemleiste und Online-Liste.', sections: [
    S('Schwarzes Brett', `
Das Schwarze Brett zeigt aktuelle Mitteilungen der Führung. Wichtige Einträge musst du nach dem Lesen **bestätigen**.`, ['board.view']),
    S('Problemleiste', `
Die Problemleiste erscheint nur, wenn es akute Probleme gibt – zum Beispiel beschädigte Fahrzeuge, wartende Börsen-Geschäfte, überfällige Lagerkosten oder offene Tickets. Sie zeigt dir **nur Probleme aus Bereichen, auf die du Zugriff hast**.

Ein Klick auf einen Eintrag öffnet die passende App. Die Leiste lässt sich zuklappen.`),
    S('Online-Liste', `
Zeigt, wer gerade das Panel geöffnet hat – mit Personalnummer und Rang (bei externen Partnern mit Zugangsnummer und dem Kennzeichen „Extern“). Wer im **Sperrbildschirm** ist, erscheint grau. Du selbst stehst mit „(Du)“ in der Liste.

Hinweis: Namen werden hier bewusst nicht angezeigt.`),
  ] },
  { id: 'm-notify', aud: 'm', group: 'Grundlagen', title: 'Benachrichtigungen und Töne', icon: 'bell', summary: 'Hinweise, Ton und Lautstärke einstellen.', sections: [
    S('Benachrichtigungen', `
Über die Glocke oben rechts siehst du alle Benachrichtigungen. Ein Klick öffnet direkt die betroffene App bzw. den betroffenen Eintrag.`),
    S('Ton und Pop-ups einstellen', `
1. Öffne die **Einstellungen** (Zahnrad oben rechts).
2. Schalte Ton und Pop-up-Hinweise ein oder aus.
3. Wähle Lautstärke und Benachrichtigungston – beim Auswählen hörst du eine Vorschau.

Hinweis: Diese Einstellungen gelten nur für dein Gerät und deinen Browser. Neuigkeiten (Changelog, Schwarzes Brett) haben einen eigenen, festen Ton.`),
  ] },
  { id: 'm-account', aud: 'm', group: 'Grundlagen', title: 'Konto, Passwort und Sperrbildschirm', icon: 'lock', summary: 'Passwort ändern, Profilbild und automatische Sperre.', sections: [
    S('Konto & Sicherheit', `
Ein Klick auf deinen Namen oben rechts öffnet „Konto & Sicherheit“. Dort änderst du dein Passwort und siehst deine Daten, Rolle und bestätigten Hinweise.

Achtung: Gib dein Passwort niemals weiter – auch nicht an die Verwaltung. Wenn du es vergessen hast, kann es ein Berechtigter zurücksetzen.`),
    S('Sperrbildschirm', `
Nach einiger Zeit ohne Eingabe sperrt sich der Bildschirm automatisch. Zum Entsperren gibst du dein Passwort ein. Das schützt deine Daten, wenn du kurz weg bist. Beim Sperren bleiben deine Fenster erhalten.`),
  ] },
  { id: 'm-ack', aud: 'm', group: 'Grundlagen', title: 'Neuigkeiten bestätigen', icon: 'check', perm: ['changelog.view', 'board.view'], summary: 'Changelog und Schwarzes Brett müssen gelesen und bestätigt werden.', sections: [
    S('Wie es funktioniert', `
Gibt es neue oder geänderte Einträge im Changelog oder am Schwarzen Brett, erscheint beim Anmelden, Neuladen oder Zurückkehren eine Meldung. Du musst die Einträge **lesen und bestätigen**, bevor du weiterarbeitest.

Wird ein bereits bestätigter Eintrag später geändert, musst du ihn erneut bestätigen. Deine Bestätigungen werden protokolliert und sind in deinem Profil einsehbar.`),
  ] },
  { id: 'm-rights', aud: 'm', group: 'Grundlagen', title: 'Rechte, Ränge und Rollen', icon: 'shield', summary: 'Warum du etwas siehst – oder nicht.', sections: [
    S('Rang und Rolle', `
Dein **Rang** zeigt deine Stellung in der Organisation. Deine **Rolle** bestimmt, welche Rechte du hast. Je höher der Rang, desto mehr Rechte – eine Rolle erbt in der Regel die Rechte der niedrigeren.`),
    S('Warum fehlt mir eine App oder ein Knopf?', `
- Dir fehlt das passende Recht. Die Hilfe zeigt dir nur Funktionen, die du nutzen darfst.
- Die App wurde vom Administrator für alle abgeschaltet.
- Dein Zugang ist noch nicht freigeschaltet.

Wende dich in dem Fall an die Verwaltung.`),
  ] },
  { id: 'm-faq', aud: 'm', group: 'Grundlagen', title: 'Häufige Fragen', icon: 'info', summary: 'Kurze Antworten auf typische Fragen.', sections: [
    S('Ich habe mich ausgesperrt', `
Zu viele falsche Anmeldeversuche sperren die Anmeldung kurz. Warte einige Minuten oder bitte die Verwaltung, dein Passwort zurückzusetzen.`),
    S('Eine Seite lädt nicht richtig', `
Lade die Seite neu (Strg + F5). Hilft das nicht, melde den Fehler als **Ticket**.`),
    S('Wo melde ich einen Fehler?', `
Öffne die App **Tickets** und lege ein neues Ticket an. Beschreibe, was du gemacht hast und was passiert ist.`),
  ] },

  // ───────────── Mitarbeiter · Apps ─────────────
  { id: 'm-dashboard', aud: 'm', group: 'Apps', title: 'Dashboard', icon: 'dashboard', app: 'dashboard', summary: 'Die aktuelle Lage auf einen Blick.', sections: [
    S('Was zeigt das Dashboard?', `
Ganz oben steht der **Regelwerk** der Organisation – mit „Regelwerk lesen“ öffnest du ihn direkt im Panel. Darunter fasst das Dashboard die wichtigsten Kennzahlen und Neuigkeiten zusammen. Welche Kacheln du siehst, hängt davon ab, auf welche Bereiche du Zugriff hast. Ein Klick auf eine Kachel führt dich in die zugehörige App.`),
  ] },
  { id: 'm-market', aud: 'm', group: 'Apps', title: 'Börse', icon: 'tag', app: 'market', perm: ['market.view'], summary: 'Ankauf und Verkauf mit externen Partnern.', sections: [
    S('Überblick', `
In der Börse laufen Angebote und Gesuche zwischen euch und externen Partnern zusammen. Partner stellen Anfragen, ihr bestätigt, verhandelt und schließt Geschäfte ab.`),
    S('Geschäfte bearbeiten', `
1. Öffne ein wartendes Geschäft aus der Liste.
2. Prüfe Artikel, Menge und Preis.
3. Bestätige, lehne ab oder schließe das Geschäft ab.

Ein Zähler am App-Symbol zeigt, wie viele Geschäfte auf dich warten.`, ['market.deals.manage']),
    S('Gesuche verwalten', `
Mit Gesuchen sagt ihr, was ihr sucht. Partner sehen sie nur, wenn der Artikel für sie freigegeben ist.`, ['market.wanted.manage']),
    S('Katalog pflegen', `
Im Katalog legst du Artikel an und bestimmst, **welche Partner** sie sehen dürfen (alle, ausgewählte oder keine) sowie Preise und XP für das Level-System.`, ['market.catalog.manage']),
    S('Tipp zu Sichtbarkeit', `
Ob ein Partner einen Artikel sieht, hängt von beiden Seiten ab: Der Artikel muss für den Partner freigegeben sein **und** der Partner muss den Artikel nutzen dürfen.`, ['market.catalog.manage', 'partners.manage']),
  ] },
  { id: 'm-trade', aud: 'm', group: 'Apps', title: 'Handel (wie ein Partner)', icon: 'star', app: 'trade', perm: ['market.trade'], cfg: 'market.member_trade', summary: 'Als Mitglied in der Börse anbieten und auf Gesuche antworten.', sections: [
    S('Wofür ist die Handel-App?', `
Damit handelst du in der Börse so, wie ein externer Partner es tut: eigene Angebote einstellen und auf Gesuche der Organisation antworten. Du brauchst dafür keinen Partner-Zugang.`),
    S('So funktioniert es', `
1. Öffne **Handel**.
2. Lege ein Angebot an oder antworte auf ein Gesuch.
3. Die Organisation bearbeitet dein Geschäft in der Börse; Hinweise erhältst du als Benachrichtigung.

Hinweis: Auch Mitglieder sammeln XP und steigen im Level auf, wenn das Level-System aktiv ist.`),
  ] },
  { id: 'm-map', aud: 'm', group: 'Apps', title: 'Karte', icon: 'map', app: 'map', perm: ['map.view'], summary: 'Interaktive Karte mit Waypoints und Postleitzahlen.', sections: [
    S('Karte benutzen', `
Verschiebe die Karte mit gedrückter Maustaste, zoome mit dem Mausrad. Waypoints und Postleitzahlen helfen dir bei der Orientierung.`),
    S('Waypoints bearbeiten', `
Mit dem Recht zum Bearbeiten kannst du Waypoints setzen, verschieben und entfernen. Änderungen sehen alle anderen sofort.`, ['map.edit']),
  ] },
  { id: 'm-warehouse', aud: 'm', group: 'Apps', title: 'Lager', icon: 'storage', app: 'warehouse', perm: ['warehouse.view'], summary: 'Lagerstandorte, Bestand und Preisspannen.', sections: [
    S('Lager ansehen', `
Die Lager-App zeigt deine Standorte, den Bestand je Artikel und Preisspannen. Wähle links ein Lager, um Details zu sehen.`),
    S('Bestand buchen', `
1. Wähle das Lager und den Artikel.
2. Trage Zugang oder Abgang ein.
3. Speichere – die Buchung wird protokolliert.`, ['warehouse.stock']),
    S('Lagerkosten', `
Fällige Lagerkosten erscheinen in der Problemleiste, bis du die Zahlung als **bezahlt** bestätigt hast.`, ['warehouse.manage']),
  ] },
  { id: 'm-vehicles', aud: 'm', group: 'Apps', title: 'Fahrzeuge', icon: 'car', app: 'vehicles', perm: ['vehicles.view'], summary: 'Fuhrpark, Zustand und Standorte.', sections: [
    S('Fuhrpark ansehen', `
Die Liste zeigt alle Fahrzeuge mit Zustand, Status und Kennzeichen. Beschädigte Fahrzeuge erscheinen zusätzlich in der Problemleiste.`),
    S('Standort', `
Der Standort eines Fahrzeugs ist nur mit dem entsprechenden Recht sichtbar.`, ['vehicles.view_location']),
    S('Fahrzeug anlegen und ändern', `
Mit dem Recht zum Anlegen und Bearbeiten pflegst du Fahrzeugdaten, Zustand und Standort.`, ['vehicles.create', 'vehicles.edit']),
  ] },
  { id: 'm-finance', aud: 'm', group: 'Apps', title: 'Finanzen', icon: 'wallet', app: 'finance', perm: ['finance.view'], summary: 'Journal, Kontostand und Auswertungen.', sections: [
    S('Journal', `
Das Journal listet alle Einnahmen und Ausgaben. Geschäfte aus Börse, Deckel und Kredit werden automatisch eingetragen.`),
    S('Manuelle Buchungen', `
Mit dem Recht für manuelle Buchungen trägst du zusätzliche Einnahmen oder Ausgaben von Hand ein.`, ['finance.manual']),
    S('Export', `
Mit dem Export-Recht kannst du das Journal als Datei herunterladen.`, ['finance.export']),
  ] },
  { id: 'm-stats', aud: 'm', group: 'Apps', title: 'Statistik', icon: 'chart', app: 'stats', perm: ['stats.view'], summary: 'Kennzahlen und Diagramme aus allen Bereichen.', sections: [
    S('Auswertungen', `
Die Statistik zeigt Diagramme zu Umsatz, Börse, Fahrzeugen und mehr. Du siehst nur Bereiche, auf die du Zugriff hast. Mit dem Zeitraum-Filter grenzt du die Daten ein.`),
  ] },
  { id: 'm-credit', aud: 'm', group: 'Apps', title: 'Kredit', icon: 'bank', app: 'credit', perm: ['credit.view'], summary: 'Kreditanfragen, Zinsen und Ratenpläne.', sections: [
    S('Kreditanfragen', `
Kreditanfragen von Partnern erscheinen hier. Du siehst Betrag, Laufzeit und den berechneten Zins- und Ratenplan.`),
    S('Anfragen bearbeiten', `
1. Öffne die Anfrage.
2. Prüfe Betrag, Zinsen und Laufzeit.
3. Genehmige oder lehne ab.`, ['credit.manage']),
    S('Zahlungen erfassen', `
Eingehende Raten buchst du über „Zahlung erfassen“. Der Restbetrag wird automatisch aktualisiert.`, ['credit.payments']),
  ] },
  { id: 'm-tab', aud: 'm', group: 'Apps', title: 'Deckel', icon: 'dollar', app: 'tab', perm: ['tab.view', 'tab.statements', 'tab.manage_companies'], summary: 'Firmen-Deckel, Abrechnungen und Zahlungen.', sections: [
    S('Was ist ein Deckel?', `
Ein Deckel ist das Konto einer Firma bei euch: Leistungen werden darauf gebucht und in Abrechnungen zusammengefasst.`),
    S('Abrechnungen', `
Du erstellst Abrechnungen für einen Zeitraum und markierst Zahlungen als erhalten.`, ['tab.statements']),
    S('Firmen verwalten', `
Hier legst du Firmen an, änderst Daten und verwaltest die Zugänge der Firmen.`, ['tab.manage_companies']),
  ] },
  { id: 'm-tickets', aud: 'm', group: 'Apps', title: 'Tickets', icon: 'bug', app: 'tickets', summary: 'Fehler melden und verfolgen.', sections: [
    S('Ticket erstellen', `
1. Öffne **Tickets** und wähle „Neues Ticket“.
2. Beschreibe Fehler oder Wunsch möglichst genau (was, wo, wann).
3. Sende das Ticket ab – du wirst über Antworten benachrichtigt.`),
    S('Tickets bearbeiten', `
Mit dem Verwaltungsrecht weist du Tickets zu, setzt den Status und antwortest.`, ['tickets.manage']),
  ] },
  { id: 'm-legal', aud: 'm', group: 'Apps', title: 'Legal', icon: 'scale', app: 'legal', perm: ['legal.view'], summary: 'Gesetzessammlung, Bußgeldkatalog und Rechtsfälle.', sections: [
    S('Gesetzessammlung und Bußgeldkatalog', `
Jeder dieser beiden Reiter zeigt ein hinterlegtes Google-Dokument live im Panel. Mit „Neu laden“ holst du den neuesten Stand, mit „In Google öffnen“ öffnest du das Original. Ist noch kein Dokument hinterlegt, siehst du einen Platzhalter.`),
    S('Rechtsfälle (Aktensystem)', `
Rechtsfälle werden als Akten geführt: Beteiligte, Verlauf, Dokumente und Abrechnung. Wähle einen Fall aus der Liste, um die Akte zu öffnen.`, ['legal.cases.view']),
    S('Akten bearbeiten', `
Mit Bearbeitungsrecht legst du Fälle an, ergänzt Einträge und änderst den Status.`, ['legal.cases.edit']),
    S('Dokumente hinterlegen', `
Hier verwaltest du die Google-Links der Gesetzessammlung. Es sind nur Links zu Google Docs, Tabellen und Präsentationen erlaubt.`, ['legal.manage']),
  ] },
  { id: 'm-contacts', aud: 'm', group: 'Apps', title: 'Kontaktbuch', icon: 'book', app: 'contacts', perm: ['contacts.view'], summary: 'Institutionen, Personen und Kontaktdaten.', sections: [
    S('Kontakte finden', `
Nutze die Suche und die Filter, um Institutionen und Personen zu finden. Ein Klick zeigt alle Details.`),
    S('Kontakte pflegen', `
Mit Bearbeitungsrecht legst du Kontakte an und änderst sie.`, ['contacts.edit']),
  ] },
  { id: 'm-chat', aud: 'm', group: 'Apps', title: 'Chat', icon: 'chat', app: 'chat', perm: ['chat.view'], summary: 'Kanäle, Nachrichten und Pinnwand.', sections: [
    S('Nachrichten schreiben', `
Wähle links einen Kanal und schreibe unten deine Nachricht. Ungelesene Nachrichten zeigt ein Zähler am App-Symbol.`, ['chat.send']),
    S('Nachrichten anpinnen', `
Wichtige Nachrichten kannst du an die Pinnwand des Kanals heften.`, ['chat.pin']),
    S('Moderation', `
Du darfst unpassende Nachrichten entfernen.`, ['chat.moderate']),
    S('Chat mit Partnern', `
Du kannst Kanäle mit externen Partnern führen.`, ['chat.partners']),
  ] },

  // ───────────── Mitarbeiter · Verwaltung ─────────────
  { id: 'm-users', aud: 'm', group: 'Verwaltung', title: 'Benutzer verwalten', icon: 'users', app: 'users', perm: ['users.view'], summary: 'Zugänge freischalten, bearbeiten und Profile ansehen.', sections: [
    S('Neue Zugänge freischalten', `
Neue Registrierungen erscheinen mit dem Status „Wartet“. Ein Zähler am App-Symbol zeigt, wie viele es sind.

1. Öffne den Benutzer.
2. Prüfe Name und Angaben.
3. Gib Rang und Rolle vor und schalte ihn frei.`, ['users.approve']),
    S('Benutzer anlegen und ändern', `
Du legst Zugänge direkt an, änderst Daten, Rang und Rolle.`, ['users.create', 'users.edit']),
    S('Passwort zurücksetzen', `
Setzt ein neues Passwort, das der Benutzer beim nächsten Login ändern sollte.`, ['users.password_reset']),
    S('Profil und Bestätigungen', `
Im Profil siehst du, welche Changelog- und Brett-Einträge die Person bestätigt hat.`),
  ] },
  { id: 'm-roles', aud: 'm', group: 'Verwaltung', title: 'Rollen & Rechte', icon: 'shield', app: 'roles', perm: ['roles.view'], summary: 'Rollen definieren und Berechtigungen zuweisen.', sections: [
    S('Rollen verstehen', `
Eine Rolle bündelt Rechte. Jede Person bekommt über ihre Rolle(n) Zugriff auf Apps und Funktionen. Rollen können Rechte von niedrigeren Rollen erben.`),
    S('Rechte ändern', `
1. Wähle die Rolle.
2. Setze oder entferne Häkchen bei den Rechten.
3. Speichere – die Änderung gilt sofort.

Achtung: Rechte-Änderungen wirken auf alle Personen mit dieser Rolle.`, ['roles.manage']),
  ] },
  { id: 'm-org', aud: 'm', group: 'Verwaltung', title: 'Organisation', icon: 'sitemap', app: 'org', perm: ['org.view'], summary: 'Ränge, Abteilungen und Hierarchie.', sections: [
    S('Ränge und Abteilungen', `
Hier siehst du die Rangfolge und die Abteilungen der Organisation.`),
    S('Hierarchie ändern', `
Du legst Ränge an, ordnest sie in der Hierarchie und weist Abteilungen zu. Neue Ränge lassen sich direkt über einem bestehenden einordnen.`, ['org.manage']),
  ] },
  { id: 'm-partners', aud: 'm', group: 'Verwaltung', title: 'Externe Zugänge (Partner)', icon: 'link', app: 'partners', perm: ['partners.view'], summary: 'Links und Codes für Partner verwalten.', sections: [
    S('Partner anlegen', `
1. Wähle „Neu“ und gib Art, Name und Ansprechpartner an.
2. Wähle die freigeschalteten Apps (z. B. Börse, Chat, Kredit).
3. Gib dem Partner Link und Zugangscode – den Code siehst du nur einmal.`, ['partners.manage']),
    S('Zugang ändern oder sperren', `
Du kannst Apps ändern, den Code erneuern oder den Zugang deaktivieren. Der Partner wird sofort abgemeldet.`, ['partners.manage']),
    S('Level-System', `
Partner sammeln XP durch abgeschlossene Geschäfte und Kredite und steigen im Level auf. Du schaltest das System pro Partner ein, vergibst XP und siehst den Verlauf.`, ['partners.levels']),
    S('Dokumente', `
Hier hinterlegst du Dokumente zu einem Partner.`, ['partners.documents']),
  ] },
  { id: 'm-lookups', aud: 'm', group: 'Verwaltung', title: 'Kategorien & Status', icon: 'list', app: 'lookups', perm: ['lookups.view'], summary: 'Auswahllisten, Kategorien und Status-Beschriftungen.', sections: [
    S('Auswahllisten pflegen', `
Hier legst du die Werte fest, die in Auswahlfeldern der Apps erscheinen (z. B. Kategorien oder Status).`, ['lookups.manage']),
  ] },
  { id: 'm-config', aud: 'm', group: 'Verwaltung', title: 'Konfiguration', icon: 'settings', app: 'config', perm: ['config.view'], summary: 'Darstellung und Systemverhalten anpassen.', sections: [
    S('Einstellungen finden', `
Die Konfiguration ist nach Kategorien gegliedert. Mit der Suche oben findest du Einstellungen schnell; Karten lassen sich auf- und zuklappen.`),
    S('Änderungen speichern', `
Ändere die Werte und klicke unten auf **Speichern**. Die meisten Änderungen gelten sofort für alle.`, ['config.edit']),
    S('Apps ein- und ausschalten', `
Mit dem entsprechenden Recht schaltest du Apps für alle Benutzer ab. Daten bleiben erhalten.`, ['system.apps']),
  ] },
  { id: 'm-audit', aud: 'm', group: 'Verwaltung', title: 'Audit-Log', icon: 'audit', app: 'audit', perm: ['audit.view'], summary: 'Nachvollziehbarkeit aller wichtigen Aktionen.', sections: [
    S('Aktionen nachvollziehen', `
Das Audit-Log zeigt, wer wann was geändert hat. Filtere nach Person, Bereich oder Zeitraum.`),
    S('Export', `
Mit dem Export-Recht lädst du das Log als Datei herunter.`, ['audit.export']),
  ] },

  // ───────────── Partner ─────────────
  { id: 'p-welcome', aud: 'p', group: 'Grundlagen', title: 'Willkommen im Partner-Portal', icon: 'home', summary: 'So findest du dich zurecht.', sections: [
    S('Was ist das Portal?', `
Das Partner-Portal ist dein Zugang zu uns. Je nach Freischaltung kannst du in der Börse handeln, mit dem Team chatten oder Kredite verfolgen. Du siehst nur die Apps, die für dich freigeschaltet sind.`),
    S('Anmelden', `
1. Öffne deinen persönlichen Link.
2. Gib deinen **Zugangscode** ein.

Achtung: Gib Link und Code nicht weiter. Bei Verlust meldest du dich bei uns, wir erneuern ihn.`),
  ] },
  { id: 'p-desktop', aud: 'p', group: 'Grundlagen', title: 'Bedienung des Portals', icon: 'dashboard', summary: 'Dock, Fenster und Benachrichtigungen.', sections: [
    S('Apps und Fenster', `
Deine Apps findest du im **Dock** unten und im **Startmenü**. Jede App öffnet sich in einem Fenster, das du verschieben, vergrößern, minimieren und schließen kannst.`),
    S('Benachrichtigungen', `
Über die Glocke siehst du neue Hinweise. In den Einstellungen (Zahnrad) stellst du Ton und Pop-ups ein.`),
    S('Sperrbildschirm', `
Nach einiger Zeit ohne Eingabe sperrt sich der Bildschirm. Zum Entsperren gibst du deinen Zugangscode ein.`),
  ] },
  { id: 'p-market', aud: 'p', group: 'Apps', title: 'Börse', icon: 'tag', app: 'market', summary: 'Angebote, Gesuche und Geschäfte.', sections: [
    S('Angebote und Gesuche', `
In der Börse siehst du, was wir suchen und anbieten. Du kannst eigene Angebote einstellen oder auf Gesuche antworten.`),
    S('Ein Geschäft abwickeln', `
1. Wähle einen Artikel und gib Menge und Preis an.
2. Sende dein Angebot ab.
3. Wir prüfen es; du erhältst eine Benachrichtigung bei Annahme, Rückfrage oder Ablehnung.

Tipp: Fehlt ein Artikel in der Liste, kannst du — wenn dein Zugang es erlaubt — „Sonstiges“ mit eigenem Namen angeben.`),
  ] },
  { id: 'p-chat', aud: 'p', group: 'Apps', title: 'Chat', icon: 'chat', app: 'chat', summary: 'Nachrichten mit dem Team.', sections: [
    S('Nachrichten schreiben', `
Wähle einen Kanal und schreibe deine Nachricht. Ungelesene Nachrichten zeigt ein Zähler am App-Symbol.`),
  ] },
  { id: 'p-credit', aud: 'p', group: 'Apps', title: 'Kredit', icon: 'bank', app: 'credit', summary: 'Kredite anfragen und Raten verfolgen.', sections: [
    S('Kredit anfragen', `
1. Öffne **Kredit** und starte eine Anfrage.
2. Wähle Betrag und Laufzeit – der Rechner zeigt Zinsen und Raten.
3. Sende die Anfrage ab. Die Antwort kommt als Benachrichtigung.`),
    S('Raten verfolgen', `
Bei laufenden Krediten siehst du den Ratenplan und den Restbetrag.`),
  ] },
  { id: 'p-level', aud: 'p', group: 'Grundlagen', title: 'Dein Level', icon: 'star', summary: 'XP sammeln und aufsteigen.', needLevel: true, sections: [
    S('Wie funktioniert das Level?', `
Für abgeschlossene Geschäfte und Kredite sammelst du **XP**. Mit genug XP steigst du im Level auf. Dein Level erscheint neben deinem Namen.`),
    S('Mehr erfahren', `
Ein Klick auf dein Level-Symbol oben zeigt deinen Fortschritt, die nächsten Stufen und deinen XP-Verlauf.`),
  ] },
  { id: 'p-faq', aud: 'p', group: 'Grundlagen', title: 'Häufige Fragen', icon: 'info', summary: 'Kurze Antworten.', sections: [
    S('Mir fehlt eine App', `
Apps werden von uns für dich freigeschaltet. Melde dich, wenn du etwas Weiteres brauchst.`),
    S('Mein Zugang funktioniert nicht mehr', `
Der Zugang wurde evtl. geändert oder gesperrt. Melde dich bei uns.`),
  ] },
];
