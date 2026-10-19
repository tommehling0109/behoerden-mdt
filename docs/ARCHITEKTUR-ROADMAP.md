# Architektur-Vorbereitung für die späteren Phasen

Dieses Dokument hält fest, wie Karte, Mitarbeiter, Fahrzeuge, Aufgaben, Operationen und die FiveM-Anbindung an das
bestehende Fundament andocken. **Implementiert ist davon nur die Grundlage** (siehe „Bereits vorhanden“). Alles andere folgt
in der jeweiligen Phase – die Phasenreihenfolge bleibt verbindlich.

## Bereits vorhanden (Phase 1 + Organisations-Ergänzung)

| Baustein | Zweck |
|---|---|
| `users` (+ `member_number`, `rank_id`, `department_id`, `supervisor_id`) | Mitglied = Benutzer mit Nummer, Rang, Abteilung, Vorgesetztem. RP-Name = `display_name` |
| `ranks`, `departments`, `rank_permissions` | frei konfigurierbare Struktur; Rang ≠ Rechte (Rang-Rechte optional, standardmäßig leer) |
| `sequences` + `core/members.js` | Dienstnummern, nie wiederverwendet, Prefix/Startnummer konfigurierbar (Standard `MDT-`, ab `220`) |
| `entity_links` + `core/links.js` | **eine** Beziehungstabelle für alle Modulverknüpfungen (keine doppelte Speicherung) |
| `external_refs` + `core/integrations.js` | Zuordnung interner Datensätze ↔ externe IDs (FiveM) + Provider-/Event-Registry |
| Modul-Registry (Server + `public/js/modules.js`) | neue Apps = ein Modul + ein Navigationseintrag |
| Konfigurationssystem, Audit-Log, Rechte-Registry | werden von allen künftigen Modulen genutzt |

## Verknüpfungsprinzip

Jedes Modul besitzt seine eigenen Tabellen. Beziehungen **zwischen** Modulen laufen über `entity_links`
(`from_type/from_id → to_type/to_id`, `relation`), z. B.:

```
operation:12  --participant-->  user:7        (meta: Rolle, Status, Teilnahme)
operation:12  --uses_vehicle->  vehicle:3
task:41       --about------->   vehicle:3
task:41       --assigned_to-->  user:7
map_point:5   --represents--->  storage:2
```

* „Meine Aufgaben / Fahrzeuge / Operationen“ = `linksOf({type:'user', id})` gefiltert nach `relation`/`otherType`.
* Typnamen (`user`, `vehicle`, `operation`, `task`, `storage`, `map_point` …) vergibt jedes Modul selbst – keine feste Liste im Kern.
* Beim Löschen eines Datensatzes `removeLinksOf(entity)` aufrufen.

## Geplante Module (nach Phase)

### Mitarbeiter-App (Phase 3, „Mitglieder“)
* Liste/Profil auf Basis von `users`: Foto, RP-Name, **Dienstnummer**, Rang, Abteilung, Status, Vorgesetzter, letzter Login.
* Neu: `dienststatus`, `last_activity_at`; Profilbild als Datei (siehe Dateien) mit `avatar_file_id`.
* Profilbild-Upload: serverseitige Typ-/Größenprüfung (nur PNG/JPEG/WebP, Magic-Bytes), Neuname per Zufalls-ID,
  Auslieferung über `/files/:id` mit Rechteprüfung – nie über den Originalnamen.
* Rechte: `members.view`, `members.view_contact`, `members.edit_own_profile`.

### Fahrzeuge (Phase 4) + Mitarbeiter
* `vehicles` (Kennzeichen, Modell, Status …) und `vehicle_state` (aktuelle Garage, Stellplatz, Nutzer `user_id`,
  `last_used_at`, `last_moved_at`, letzte Position `x,y,z`) – **Zustand getrennt von Stammdaten**, damit Integrationsupdates
  die Akte nicht überschreiben.
* Garagen/Stellplätze sind Lager-/Ortsobjekte (Phase 5) mit eigenem `type`; Fahrzeug verweist per ID, nicht per Text.
* Historie über Audit + `vehicle_events` (eingeparkt/ausgeparkt/Nutzerwechsel).
* Rechte getrennt je Information: `vehicles.view`, `vehicles.view_user`, `vehicles.view_location`.

### Lager / Ortsobjekte (Phase 5)
* Lager, Garagen, Stellplätze als Orte mit Koordinaten (`x,y[,z]`) – dieselben Datensätze erscheinen später auf der Karte.

### Karte (eigene App, nach Phase 5)
* `map_points`: Name, Beschreibung, Kategorie (`map_categories`, konfigurierbar), Koordinaten, Icon, Status, Sichtbarkeit,
  Rechte; optionale Verknüpfung (`entity_links`) zu Lager, Produkt, Auftrag, Operation (Treffpunkt).
* Layer: Punkte (Admin-gepflegt), Fahrzeuge, Mitarbeiter, Operationen/Treffpunkte – jeder Layer hat eine **eigene** Berechtigung.
* Koordinatensystem GTA-Weltkoordinaten → Kartenbild (Kalibrierung als Konfiguration, nichts im Code).
* Filter/Suche/Kategorien clientseitig über `GET /api/map/layers?…` mit serverseitiger Rechtefilterung.

### Standort-Datenschutz (verbindlich)
Positionen sind sensibel und werden **serverseitig gefiltert**, nie nur im Frontend ausgeblendet:

| Recht | Wirkung |
|---|---|
| `map.view` | Karte öffnen, Punkte sehen |
| `map.staff.view` | aktive Mitarbeiter auf der Karte (Name, Rang, Status) |
| `map.staff.position` | Position der Mitarbeiter (sonst nur Liste ohne Koordinaten) |
| `map.vehicles.view` / `vehicles.view_location` | Fahrzeuge bzw. deren Position |
| `map.manage` | Kartenpunkte/Kategorien verwalten |

Optional ergänzend: Sichtbarkeit nach Abteilung/Rang (Rang-Hierarchie `parent_rank_id`, Vorgesetzter `supervisor_id`),
z. B. „nur eigene Abteilung“. Positionsabrufe werden bei Bedarf im Audit-Log protokolliert.

### Aufgaben (Phase 3/Folgephase)
`tasks` (Titel, Beschreibung, Priorität, Status, Fälligkeit, Ersteller), Zuweisung an Benutzer/Abteilung/Team über
`entity_links` (`assigned_to`), `task_checklist_items`, `task_comments`, Anhänge (Dateien), beliebige Verknüpfungen.

### Operationen / Planung (eigene App)
* `operation_types` (vom Admin angelegt – **keine** festen Kategorien), `operations` (Grunddaten, Status, Priorität, geplant,
  Verantwortlicher, Abteilung, Sichtbarkeit), `operation_participants` (Rolle, Aufgabe, Status, Verantwortlichkeit,
  Teilnahme `offen/bestätigt/abgesagt`), `operation_checklist_items` (frei erstellbar, auch je Teilnehmer).
* Anhänge: allgemeines Dateimodul (`files`: id, Originalname, MIME, Größe, Hash, Besitzer, `entity_type/entity_id`);
  Auslieferung rechtegeprüft.
* **Änderungsverlauf:** `operation_history` (Zeit, Benutzer, Textbaustein + Referenzen), parallel zum Audit-Log.
* Verknüpfungen zu Mitarbeitern, Fahrzeugen, Aufgaben, Dokumenten, Kalender, Karte, Vorgängen via `entity_links`.

## FiveM-/Serverintegration (Phase 9)

Schnittstelle liegt bereits in `core/integrations.js`:

```js
registerIntegration({ name: 'fivem', handlers: {
  'vehicle.unparked': async (p) => { /* p.vehicleId, p.characterId, p.position */ },
  'vehicle.parked':   async (p) => { /* p.vehicleId, p.garageId, p.slot */ },
  'character.position': async (p) => { /* … */ },
}});
```

* **Ablauf Ausparken:** Event → Fahrzeug über `findByExternal('fivem','vehicle',id)` → Character über
  `external_refs` → Mitglied → `vehicle_state` aktualisieren (Nutzer, Status „unterwegs“, Position) → Verlauf/Audit.
* **Ablauf Einparken:** Garage/Stellplatz auflösen → Status „eingeparkt“ → Nutzer freigeben → letzte Position speichern.
* Eingehender Kanal (später): `POST /api/integrations/:provider/events` mit **API-Schlüssel pro Provider** (gehasht gespeichert,
  rotierbar, IP-Begrenzung optional), eigene Rate-Limits, Idempotenz über Event-ID. Keine Browser-Session nötig.
* Ausgehend: Webhooks (konfigurierbar im Admin-Panel).
* Keine Server-IDs, Spielernamen oder Garagen im Code – alles über `external_refs` und Konfiguration.

## Phasen-Zuordnung

| Phase | Enthält (aus den Zusätzen) |
|---|---|
| 1 (fertig) | Fundament, Desktop-UI, Auth, Freischaltung, Rollen/Rechte, Audit, Konfiguration |
| 1+/2 (jetzt) | **Dienstnummern, Ränge, Abteilungen, Hierarchie, Vorgesetzte**, Link-/Integrations-Grundlagen |
| 3 | Dashboard, Benachrichtigungen, **Mitarbeiter-App** (inkl. Profilbild), Akten, Vorgänge, Dokumente, Kalender, **Aufgaben** |
| 4 | Fahrzeuge (+ Zustand, Garage/Stellplatz, Nutzer) |
| 5 | Lager/Garagen/Orte, Stash-Zuordnung |
| 6–8 | Ankauf, Aufträge, Dark Chat |
| nach 5 | **Karte** (Punkte, Fahrzeuge, Mitarbeiter-Layer) |
| nach 3/4 | **Operationen/Planung** (Anhänge, Verlauf, Verknüpfungen) |
| 9 | FiveM-/Serverintegration (Positionen, Fahrzeugereignisse, Charaktere) |
