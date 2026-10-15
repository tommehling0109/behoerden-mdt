# MDT unter Windows 11

Zwei Wege. **Weg A (Docker Desktop)** ist empfohlen – gleiche Technik wie auf dem Linux-Server, Updates mit einem Befehl.

---

## Weg A: Docker Desktop (empfohlen)

### Voraussetzung (einmalig)
1. **Docker Desktop** installieren (PowerShell):
   ```powershell
   winget install -e --id Docker.DockerDesktop
   ```
2. Windows **neu starten**, Docker Desktop **einmal öffnen** und warten, bis unten links „Engine running“ steht.
   (Docker Desktop richtet beim ersten Start WSL 2 ein – dem Assistenten zustimmen.)

### Installation (ein Befehl)
PowerShell öffnen und einfügen:
```powershell
mkdir C:\mdt-template -Force | Out-Null
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/tommehling0109/mdt-template/main/deploy/windows/install-mdt.ps1 -OutFile C:\mdt-template\install-mdt.ps1
powershell -ExecutionPolicy Bypass -File C:\mdt-template\install-mdt.ps1
```
Das Skript prüft Docker, lädt die Dateien nach `C:\mdt-template`, startet das MDT und zeigt die laufende Version.
Danach im Browser: **http://localhost:3847** – beim ersten Mal erscheint die Ersteinrichtung (Superadmin anlegen).

Optionen: `-Ordner "D:\mdt-template"`, `-Port 8080`, `-HinterProxy` (wenn ein HTTPS-Proxy davor sitzt).

### Update (jedes Mal, wenn etwas Neues gepusht wurde)
1. Erst auf GitHub prüfen, dass der Bau fertig ist: https://github.com/tommehling0109/mdt-template/actions → oberster Eintrag **grüner Haken**.
2. Dann:
   ```powershell
   cd C:\mdt-template
   powershell -ExecutionPolicy Bypass -File .\update-mdt.ps1
   ```
   Am Ende steht `Läuft: {"version":"…","commit":"…"}`. Die Daten bleiben erhalten.
3. Im Browser **einmal STRG+F5**. Unten rechts steht „Build <Commit>“ (Klick = Diagnose).

### Datensicherung
```powershell
cd C:\mdt-template
powershell -ExecutionPolicy Bypass -File .\backup-mdt.ps1
```
Die Sicherung landet in `C:\mdt-template\backups`. (Zusätzlich im MDT: Konfiguration → Datensicherung.)

### Automatisch beim Windows-Start
In Docker Desktop → Einstellungen → General → **„Start Docker Desktop when you sign in“** aktivieren. Der Container hat `restart: unless-stopped` und startet dann von selbst mit.

### Von anderen Geräten erreichbar machen
- Im LAN: `http://<IP-des-PCs>:3847` (Windows-Firewall fragt beim ersten Zugriff; „Privates Netzwerk“ erlauben).
- Mit Domain/HTTPS: Reverse-Proxy (z. B. Nginx Proxy Manager, Caddy) davor, **Cache abschalten**, Websockets an, und beim Installieren `-HinterProxy` angeben.

### Häufige Probleme
| Meldung | Lösung |
|---|---|
| „Docker wurde nicht gefunden“ | Docker Desktop installieren/neu starten |
| „Docker Desktop läuft nicht“ | Docker Desktop öffnen, auf „Engine running“ warten |
| Skript wird blockiert | Aufruf mit `powershell -ExecutionPolicy Bypass -File …` (wie oben) |
| Seite zeigt alten Stand | `update-mdt.ps1` ausführen, dann STRG+F5; hinter Proxy: „Cache Assets“ aus |
| Port belegt | `-Port 8080` bei der Installation (oder in `C:\mdt-template\.env` `MDT_PORT=8080`, dann Update ausführen) |
| Logs ansehen | `cd C:\mdt-template ; docker compose logs --tail 50` |

---

## Weg B: Ohne Docker (Node.js direkt)

Nur nötig, wenn Docker nicht gewünscht ist. Benötigt **Node.js ≥ 22.13** und Git.

```powershell
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Git.Git
git clone https://github.com/tommehling0109/mdt-template.git C:\mdt-template-app
cd C:\mdt-template-app
$env:MDT_DATA_DIR = "C:\mdt-template-daten"
npm start
```
Erreichbar unter http://localhost:3847. Die Daten liegen in `C:\mdt-template-daten` (nicht im Programmordner, damit Updates nichts überschreiben).

**Update:** `cd C:\mdt-template-app ; git pull` und das MDT neu starten (Fenster schließen, `npm start` erneut).

**Automatisch starten:** Aufgabenplanung → Aufgabe erstellen → Trigger „Beim Anmelden“ → Aktion: Programm `powershell.exe`, Argumente
`-NoProfile -WindowStyle Hidden -Command "$env:MDT_DATA_DIR='C:\mdt-template-daten'; Set-Location C:\mdt-template-app; npm start"`.
