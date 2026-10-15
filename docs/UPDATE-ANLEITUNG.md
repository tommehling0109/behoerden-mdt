# Update-Anleitung (Schritt für Schritt)

So kommt eine Änderung vom Entwickler-PC auf den Server – und was man bei Problemen prüft.

## Überblick: Was passiert wo?

```
PC (Entwicklung)  ──git push──▶  GitHub  ──(automatisch)──▶  GitHub baut ein Image (ghcr.io)
                                                                   │
Server  ◀────────── docker pull / compose up ◀────────────────────┘
                         │
                         ▼
        Nginx Proxy Manager ──▶ Browser (mdt.example.com)
```

Es gibt drei Stationen, an denen ein Update hängenbleiben kann: **GitHub**, **der Server (Container)** und **der Proxy/Browser**. Unten steht für jede ein Test.

---

## A) Pushen (Entwickler-PC)

Im Projektordner:

1. Änderungen ansehen:
   ```bash
   git status
   ```
2. Alles vormerken und speichern (committen):
   ```bash
   git add -A
   git commit -m "Kurze Beschreibung, was geändert wurde"
   ```
3. Hochladen:
   ```bash
   git push
   ```
4. **Prüfen, dass der Push angekommen ist:**
   ```bash
   git status -sb
   ```
   Es muss `## main...origin/main` stehen – **ohne** `ahead` / `[voraus …]`.
5. **Warten, bis GitHub das Image gebaut hat** (ca. 1 Minute):
   - Browser: https://github.com/tommehling0109/mdt-template/actions
   - Der oberste Eintrag „Docker-Image bauen“ muss ein **grünes Häkchen** haben. Gelb = läuft noch, rot = Fehler (dann nicht aktualisieren).
   - Die Commit-Nummer (7 Zeichen, z. B. `51cae81`) merken.

Erst wenn das Häkchen grün ist, ist das neue Image fertig.

---

## B) Pullen / Aktualisieren (Server)

Auf dem Server (SSH):

1. In den Ordner wechseln:
   ```bash
   cd /opt/mdt-template
   ```
2. **Einfachster Weg – das Update-Skript** (zieht das neue Image und startet den Container neu).
   Beim **allerersten Mal** das Skript herunterladen:
   ```bash
   sudo curl -fsSL https://raw.githubusercontent.com/tommehling0109/mdt-template/main/deploy/portainer/update-mdt.sh -o update-mdt.sh
   ```
   Danach bei **jedem Update**:
   ```bash
   sudo bash update-mdt.sh
   ```
   Das Skript holt sich bei Bedarf selbst die aktuelle Compose-Datei und zeigt am Ende die laufende Commit-Nummer.

   **Oder manuell, die zwei Befehle:**
   ```bash
   sudo docker compose pull
   sudo docker compose up -d --force-recreate
   ```
3. **Prüfen, was wirklich läuft:**
   ```bash
   curl -s http://localhost:3847/api/version
   ```
   Es muss `"commit":"<die Nummer aus Schritt A5>"` stehen. Steht dort eine andere Nummer, läuft noch ein alter Container.

> Wichtig: `docker pull` allein ersetzt **keinen** laufenden Container. Erst `docker compose up -d --force-recreate` startet ihn mit dem neuen Image.

Die Daten bleiben erhalten (Docker-Volume `mdt-template_mdt-data`).

---

## C) Browser / Proxy prüfen

1. Im Browser: `https://mdt.example.com/api/version` öffnen.
   Dort muss **dieselbe** Commit-Nummer stehen wie auf dem Server.
   - Andere/alte Nummer oder 502 → Proxy-Problem (siehe unten).
2. Seite öffnen und **einmal STRG+F5** drücken. Unten rechts steht „Build <Nummer>“.
3. Klick auf „Build …“ zeigt eine **Diagnose** (Superadmin ja/nein, fehlende Rechte).

### Einstellungen im Nginx Proxy Manager (einmalig, Proxy Host → Edit)

| Einstellung | Wert |
|---|---|
| Scheme / Forward Host / Port | `http` / **IP des Servers** (nicht `localhost`, wenn der Proxy in Docker läuft) / `3847` |
| **Cache Assets** | **AUS** (sonst liefert der Proxy alte Dateien aus!) |
| **Websockets Support** | **AN** (für Live-Updates) |
| SSL | Zertifikat + „Force SSL“ nach Bedarf |
| Advanced | **keine** Zeilen mit `expires`, `proxy_cache`, `add_header Cache-Control` |

Beim Start des Containers `TRUST_PROXY=1` setzen (steht schon im Update-Skript), damit Anmeldungen/IPs hinter dem Proxy stimmen.

---

## C2) Wie das MDT veraltete Browser-Dateien verhindert (Cache-Schutz)

Das passiert automatisch – nach einem Update muss niemand STRG+F5 drücken:

1. **Versions-Adressen:** Jede Programmdatei wird mit der aktuellen Version angefordert (`/js/main.js?v=<Version>`, ebenso alle Importe zwischen den Skripten und die Styles). Nach einem Update sind es *neue Adressen* – kein Browser-, Proxy- oder CDN-Cache kennt sie, es kann also nichts Altes ausgeliefert werden.
2. **No-Store-Header:** Der Server verbietet jedes Zwischenspeichern der Programmdateien.
3. **Cache-Reset beim ersten Besuch:** Beim ersten Seitenaufruf nach einem Update sendet der Server `Clear-Site-Data: "cache"`; der Browser leert den Zwischenspeicher dieser Seite einmalig (dafür merkt er sich die Version im Cookie `mdt_v`).
4. **Offene Seiten:** Eine bereits geöffnete Seite prüft alle 20 Sekunden die Version und lädt sich bei einem Update selbst neu (wartet, solange gerade getippt wird). Lokale Zwischenstände (`mdt:…`) werden dabei verworfen.
5. **Notausgang:** Klick auf „Build …“ → **„Zwischenspeicher leeren & neu laden“** (bleibt angemeldet). Komplett zurücksetzen (inkl. Abmelden): `/reset` aufrufen.

Nur der **Reverse-Proxy** kann das noch aushebeln, wenn er selbst zwischenspeichert (z. B. Nginx Proxy Manager → „Cache Assets“ AUS lassen, Cloudflare: Cache für diese Domain aus).

## D) Fehlersuche in 3 Fragen

| Frage | Befehl / Ort | Wenn es nicht stimmt |
|---|---|---|
| 1. Ist das neue Image auf GitHub fertig? | GitHub → Actions → grüner Haken | Warten oder Fehler ansehen |
| 2. Läuft der Container mit dem neuen Image? | `curl -s http://localhost:3847/api/version` auf dem Server | `sudo bash update-mdt.sh` |
| 3. Kommt es im Browser an? | `https://<domain>/api/version` | Proxy: Cache Assets aus, Ziel prüfen; im Browser STRG+F5 |

Zusätzlich im Container nachsehen, falls etwas nicht startet:
```bash
sudo docker compose logs --tail 50
```

---

## E) Datensicherung vor größeren Updates

```bash
sudo docker compose exec mdt node --disable-warning=ExperimentalWarning scripts/backup.js
```
(oder im MDT unter Konfiguration → Datensicherung → „Backup erstellen“)

---

## F) Subdomain für den Exekutive-Zugang (access.example.com)

Der Hack-Zugang der Exekutive hat eine eigene Subdomain (einstellbar unter Konfiguration → „Exekutive-Zugang“ → „Eigene Subdomain“, Standard `access.example.com`). Unter dieser Adresse liegt nur die neutrale Terminal-Seite auf der Startseite – ohne Schlüssel im Pfad und ohne Name/Logo; alles andere (das eigentliche System, Anmeldung, Bilder, Skripte) antwortet dort mit „Not found“.

Einrichtung (einmalig):
1. **DNS:** `access.example.com` als A-/CNAME-Eintrag auf denselben Server wie `mdt.example.com`.
2. **Nginx Proxy Manager → Proxy Host → Add:** Domain `access.example.com`, Ziel **dieselbe** IP und derselbe Port (`3847`) wie beim Haupt-Host, **Cache Assets AUS**, SSL-Zertifikat anfordern (Let's Encrypt) + „Force SSL“. Websockets sind hier nicht nötig.
3. Der Container braucht `TRUST_PROXY=1` (steht im Update-Skript), damit der Hostname aus `X-Forwarded-Host` erkannt wird.

Wer den Hostnamen kennt, kann spielen – die Sperrzeit gilt für alle gemeinsam. Der Link mit Schlüssel (`/x/<Schlüssel>`) auf der Hauptdomain funktioniert weiterhin.

---

## G) Subdomain für Externe (coop.example.com)

Partner (Börse/Chat/Kredit) und Firmen (Deckel-Portal) erreichen ihre Portale über eine **eigene, neutrale Subdomain** (einstellbar unter Konfiguration → „Externe Zugänge (neutral)“, Standard `coop.example.com`). Dort gibt es **kein Logo, keinen Panel-/Firmennamen** und nichts zum eigentlichen System: Titel ist „Partnerportal“ (einstellbar), Begriffe wie „MDT-“ werden in der Oberfläche ausgeblendet (aus „MDT-P-100002“ wird „P-100002“; die Liste ist einstellbar). Erreichbar sind nur `/p/<link>` (Partner), `/deckel/firma/<link>` (Firmen) und deren Schnittstellen – die Mitarbeiter-Anmeldung, die Verwaltung, Branding-Dateien und Karten antworten dort mit „Not found“.

Einrichtung wie bei F: DNS-Eintrag auf den Server, Proxy-Host in Nginx Proxy Manager mit gleichem Ziel/Port (3847), **Websockets AN** (Live-Updates der Portale), Cache Assets AUS, SSL. Die Links, die im Panel unter „Externe Zugänge“ und „Deckel“ zum Kopieren angezeigt werden, nutzen automatisch diese Subdomain.
