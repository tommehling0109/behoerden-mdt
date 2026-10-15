# MDT auf Ubuntu betreiben

Getestet vorgesehen für **Ubuntu 22.04 / 24.04** (auch Debian). Das MDT läuft als eigener Dienst (`mdt`) hinter **nginx** mit **HTTPS** (Let's Encrypt). Es hat keine npm-Abhängigkeiten, benötigt aber **Node.js ≥ 22.13** – der Installer richtet das ein.

## 1. Voraussetzungen

* Ein Ubuntu-Server mit Root-/sudo-Zugriff, Ports **80 und 443** offen.
* Eine **Domain oder Subdomain** (z. B. `mdt.deinedomain.de`) mit einem **A-Eintrag auf die Server-IP**.
* **Läuft dort schon ein Forum/anderes Projekt?** Dann nimm eine **eigene Subdomain** für das MDT. Der Installer legt einen *eigenen* nginx-Server-Block an und fasst vorhandene Seiten nicht an. Er bricht ab, wenn für die Domain schon ein Block existiert, damit nichts überschrieben wird.
  Läuft das Forum über **Apache** auf Port 80/443? Dann entweder das MDT hinter Apache einbinden (`ProxyPass / http://127.0.0.1:3847/`, plus `ProxyPass /api/events http://127.0.0.1:3847/api/events flushpackets=on` und längere Timeouts für die Echtzeit-Verbindung) und den Installer mit `--no-nginx` starten – oder dem MDT einen anderen Server geben.

## 2. Installation

Projektordner auf den Server bringen (z. B. `scp -r mdt user@server:~/` oder `git clone`), dann:

```bash
cd ~/mdt
sudo bash deploy/ubuntu/install.sh --domain mdt.deinedomain.de --email du@deinedomain.de
```

Der Installer: installiert nginx/certbot/Node 22, legt den Systembenutzer `mdt` an, kopiert die App nach `/opt/mdt` (schreibgeschützt), legt Daten in `/var/lib/mdt` ab, richtet den systemd-Dienst und den täglichen Backup-Timer ein, konfiguriert nginx (inkl. Echtzeit-Einstellungen), holt das HTTPS-Zertifikat und prüft den Dienst.

Danach `https://mdt.deinedomain.de` öffnen – es erscheint die **Ersteinrichtung** (Administrator anlegen).

### Bestehende Daten von Windows übernehmen

Den Ordner `data` (mit `mdt.db` und ggf. `branding/`) auf den Server kopieren und beim Installieren angeben:

```bash
sudo bash deploy/ubuntu/install.sh --domain mdt.deinedomain.de --import-data ~/data
```

(Server vorher am besten auf Windows beenden, damit die Datenbank vollständig geschrieben ist.) Vorhandene Server-Daten werden nie überschrieben.

## 3. Betrieb

| Aufgabe | Befehl |
|---|---|
| Status | `systemctl status mdt` |
| Live-Logs | `journalctl -u mdt -f` |
| Neustart | `sudo systemctl restart mdt` |
| Update (neuer Projektstand im Ordner) | `sudo bash deploy/ubuntu/update.sh` |
| Backup jetzt | `sudo systemctl start mdt-backup.service` oder im MDT: *Konfiguration → Datensicherung* |
| Backups ansehen | `ls -lh /var/lib/mdt/backups` (täglich 03:30, die letzten 30 bleiben) |
| Konfiguration | `/etc/mdt/mdt.env` (`PORT`, `HOST`, `TRUST_PROXY`, `MDT_DATA_DIR`) |

Das Update legt vor dem Kopieren automatisch eine Sicherung an; Datenbank-Migrationen laufen beim Start.

### Wiederherstellen

```bash
sudo systemctl stop mdt
sudo cp /var/lib/mdt/backups/mdt-YYYYMMDD-HHMMSS.db /var/lib/mdt/mdt.db
sudo chown mdt:mdt /var/lib/mdt/mdt.db
sudo rm -f /var/lib/mdt/mdt.db-wal /var/lib/mdt/mdt.db-shm
sudo systemctl start mdt
```

## 4. Sicherheit

* Die App lauscht **nur auf 127.0.0.1** – von außen ist ausschließlich nginx (80/443) erreichbar.
* `TRUST_PROXY=1` ist gesetzt: Die App übernimmt Client-IP und `https` vom nginx (der den Header überschreibt, nicht anhängt). **Nicht** auf `1` setzen, wenn die App ohne Proxy direkt erreichbar ist.
* Der Dienst läuft ohne Root-Rechte, mit Schreibzugriff nur auf `/var/lib/mdt` (systemd-Härtung).
* Empfohlen: Firewall `sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable`, optional `fail2ban`, regelmäßig `apt upgrade`.
* Datenbank-Backups enthalten alle Daten (Passwort-Hashes etc.) – nicht öffentlich ablegen.

## 5. Echtzeit-Verbindung & Proxys

Das MDT nutzt **Server-Sent Events** (`/api/events`, `/api/p/events`) für Live-Updates. Die mitgelieferte nginx-Konfiguration schaltet dafür Pufferung ab und erlaubt lange Verbindungen. Bei zusätzlichen Proxys/CDNs davor (z. B. Cloudflare) dürfen diese Pfade nicht gepuffert/zwischengespeichert werden.

## 6. Fehlersuche

* `Node.js ≥ 22.13` Fehlermeldung → `node -v` prüfen, Installer erneut ausführen.
* Seite nicht erreichbar → `systemctl status mdt nginx`, `sudo nginx -t`, DNS-Eintrag und Firewall prüfen.
* Zertifikat schlägt fehl → DNS muss auf den Server zeigen; danach `sudo certbot --nginx -d DOMAIN` wiederholen.
* Port belegt → anderen Port wählen: `--port 3900` (oder `PORT=` in `/etc/mdt/mdt.env`, danach `sudo systemctl restart mdt` und nginx-Konfiguration anpassen).
