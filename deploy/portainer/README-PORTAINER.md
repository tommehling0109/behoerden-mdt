# MDT in Portainer – plug and play

Es sind **keine Variablen nötig**. Stack anlegen → starten → im Browser die Ersteinrichtung durchführen. Fertig.

Daten (Datenbank, Bilder, Backups) liegen im Docker-Volume `mdt-data` und bleiben bei Updates erhalten.

## Variante A – Stack aus dem Git-Repository (Portainer baut selbst)

1. Portainer → **Stacks → Add stack → Repository**
2. **Repository URL:** `https://github.com/tommehling0109/mdt-template`
   - Repository ist privat? → **Authentication** einschalten, GitHub-Benutzername + ein *Personal Access Token* (Recht `repo` / „Contents: read“) eintragen.
3. **Repository reference:** `refs/heads/main` · **Compose path:** `docker-compose.yml`
4. Optional unter *Environment variables* (alles hat Standardwerte):

   | Variable | Standard | Bedeutung |
   |---|---|---|
   | `MDT_PORT` | `3847` | Port auf dem Docker-Host |
   | `TRUST_PROXY` | `0` | `1`, wenn ein Reverse-Proxy mit HTTPS davor sitzt |
   | `TZ` | `Europe/Berlin` | Zeitzone des Containers |

5. **Deploy the stack.** Danach `http://<server>:3847` öffnen → Ersteinrichtung.

**Update:** Stack öffnen → **Pull and redeploy** (bei *Re-pull image and redeploy* den Haken setzen). Das Volume bleibt unberührt.

## Variante B – Fertiges Image (kein Build auf dem Server)

Bei jedem Push auf `main` baut GitHub Actions das Image `ghcr.io/tommehling0109/mdt-template:latest` (amd64 + arm64).

1. Portainer → **Stacks → Add stack → Web editor**
2. Inhalt von [`stack-ghcr.yml`](stack-ghcr.yml) einfügen → **Deploy the stack**.
3. Ist das GitHub-Paket **privat** (Standard bei privaten Repos): Portainer → **Registries → Add registry → Custom/GitHub**:
   `ghcr.io`, Benutzername = GitHub-Name, Passwort = Token mit `read:packages`.
   Alternativ das Paket auf GitHub unter *Packages → mdt-template → Package settings → Change visibility* öffentlich stellen.

**Update:** Stack → **Update the stack** mit *Re-pull image and redeploy*.

## Hinter einem Reverse-Proxy (empfohlen für HTTPS)

- `TRUST_PROXY=1` setzen und im Proxy `X-Forwarded-Proto`/`X-Forwarded-For` durchreichen (Nginx Proxy Manager, Traefik und Caddy tun das standardmäßig). Nur dann gelten die Sitzungs-Cookies als „secure“.
- **WebSocket/SSE:** Die Live-Updates laufen über Server-Sent Events (`/api/events`). Beim Nginx Proxy Manager *Websockets Support* einschalten; bei eigenem Nginx `proxy_buffering off;` für diesen Pfad.
- Ohne Proxy (nur `http://IP:3847` im LAN) bleibt `TRUST_PROXY=0` – dann funktioniert die Anmeldung auch ohne HTTPS.

## Backups

- Im Admin-Bereich: **Konfiguration → Datensicherung → Backup erstellen** (Ordner `/data/backups`, die letzten 15 bleiben).
- Volume sichern: `docker run --rm -v mdt-data:/data -v "$PWD":/out busybox tar czf /out/mdt-data.tgz -C /data .`
- Wiederherstellen: Stack stoppen, Volume leeren, `tar xzf` in das Volume entpacken, Stack starten.

## Fehlersuche

- Logs: Portainer → Container `mdt-template` → **Logs**.
- Health: `http://<server>:3847/healthz` muss `ok` liefern (der Container-Healthcheck nutzt dasselbe).
- Port belegt? `MDT_PORT` auf einen freien Port stellen (z. B. `3950`).
