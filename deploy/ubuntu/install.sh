#!/usr/bin/env bash
# MDT – Installation auf Ubuntu/Debian (22.04 / 24.04 getestet vorgesehen)
#
#   sudo bash deploy/ubuntu/install.sh --domain mdt.beispiel.de --email du@beispiel.de
#
# Optionen:
#   --domain D        Domain/Subdomain, unter der das MDT erreichbar sein soll (empfohlen)
#   --email E         E-Mail für Let's Encrypt (HTTPS-Zertifikat)
#   --port N          interner Port der App (Standard 3847, nur auf 127.0.0.1 erreichbar)
#   --no-ssl          kein Zertifikat anfordern (nur HTTP – nur für Tests!)
#   --no-nginx        nur App + systemd, kein nginx (du setzt selbst einen Proxy davor)
#   --import-data P   vorhandenen data-Ordner (mdt.db, branding/) übernehmen, z. B. von Windows
#
# Das Skript ist wiederholbar (idempotent). Bestehende Daten in /var/lib/mdt werden nie überschrieben.
set -euo pipefail

DOMAIN=""; EMAIL=""; PORT="3847"; SSL=1; NGINX=1; IMPORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --no-ssl) SSL=0; shift ;;
    --no-nginx) NGINX=0; shift ;;
    --import-data) IMPORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Bitte mit sudo/root ausführen."
command -v apt-get >/dev/null || die "Nur für Ubuntu/Debian (apt) vorgesehen."
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port muss eine Zahl sein."
if [[ $NGINX -eq 1 && -z "$DOMAIN" ]]; then die "Bitte --domain angeben (oder --no-nginx verwenden)."; fi
if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then die "Ungültige Domain: $DOMAIN"; fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -f "$SRC/server/index.js" ]] || die "Projekt nicht gefunden (erwartet: $SRC/server/index.js)."
APP_DIR=/opt/mdt; DATA_DIR=/var/lib/mdt; CONF_DIR=/etc/mdt

say "Pakete installieren"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
PKGS=(ca-certificates curl gnupg rsync)
[[ $NGINX -eq 1 ]] && PKGS+=(nginx)
[[ $NGINX -eq 1 && $SSL -eq 1 ]] && PKGS+=(certbot python3-certbot-nginx)
apt-get install -y "${PKGS[@]}"

say "Node.js prüfen (benötigt ≥ 22.13)"
node_ok() {
  command -v node >/dev/null || return 1
  local v maj min; v="$(node -p 'process.versions.node')"; maj="${v%%.*}"; min="${v#*.}"; min="${min%%.*}"
  (( maj > 22 )) || (( maj == 22 && min >= 13 ))
}
if ! node_ok; then
  echo "Installiere Node.js 22 über NodeSource (offizielles Repository) …"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node_ok || die "Node.js ≥ 22.13 konnte nicht installiert werden (aktuell: $(node -v 2>/dev/null || echo keine))."
NODE_BIN="$(command -v node)"
echo "Node.js $(node -v) unter $NODE_BIN"

say "Systembenutzer und Verzeichnisse"
id -u mdt >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin mdt
install -d -o mdt -g mdt -m 0750 "$DATA_DIR"
install -d -o root -g root -m 0755 "$APP_DIR" "$CONF_DIR"

say "App nach $APP_DIR kopieren"
rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude '/data' --exclude '*.log' "$SRC/" "$APP_DIR/"
chown -R root:root "$APP_DIR"

if [[ -n "$IMPORT" ]]; then
  say "Daten übernehmen aus $IMPORT"
  [[ -f "$IMPORT/mdt.db" ]] || die "$IMPORT/mdt.db nicht gefunden."
  if [[ -f "$DATA_DIR/mdt.db" ]]; then
    echo "In $DATA_DIR existiert bereits eine Datenbank – Import übersprungen (nichts überschrieben)."
  else
    systemctl stop mdt 2>/dev/null || true
    cp "$IMPORT/mdt.db" "$DATA_DIR/mdt.db"
    [[ -d "$IMPORT/branding" ]] && cp -r "$IMPORT/branding" "$DATA_DIR/branding"
    chown -R mdt:mdt "$DATA_DIR"
    echo "Datenbank übernommen."
  fi
fi

say "Konfiguration $CONF_DIR/mdt.env"
if [[ ! -f "$CONF_DIR/mdt.env" ]]; then
  cat > "$CONF_DIR/mdt.env" <<EOF
PORT=$PORT
HOST=127.0.0.1
TRUST_PROXY=1
MDT_DATA_DIR=$DATA_DIR
NODE_ENV=production
EOF
  chmod 0640 "$CONF_DIR/mdt.env"; chown root:mdt "$CONF_DIR/mdt.env"
else
  echo "Vorhanden – unverändert gelassen."
  PORT="$(grep -E '^PORT=' "$CONF_DIR/mdt.env" | cut -d= -f2 || echo "$PORT")"
fi

say "systemd-Dienste einrichten"
sed "s|@NODE@|$NODE_BIN|g" "$APP_DIR/deploy/ubuntu/mdt.service" > /etc/systemd/system/mdt.service
sed "s|@NODE@|$NODE_BIN|g" "$APP_DIR/deploy/ubuntu/mdt-backup.service" > /etc/systemd/system/mdt-backup.service
cp "$APP_DIR/deploy/ubuntu/mdt-backup.timer" /etc/systemd/system/mdt-backup.timer
systemctl daemon-reload
systemctl enable --now mdt.service
systemctl enable --now mdt-backup.timer
systemctl restart mdt.service

if [[ $NGINX -eq 1 ]]; then
  say "nginx einrichten für $DOMAIN"
  if ss -ltn 2>/dev/null | grep -qE ':(80|443)\s' && ! systemctl is-active --quiet nginx; then
    echo "WARNUNG: Port 80/443 wird von einem anderen Dienst (z. B. Apache) belegt, nginx läuft nicht."
    echo "         Stoppe den anderen Dienst oder nutze --no-nginx und konfiguriere deinen vorhandenen Webserver (siehe README-UBUNTU.md)."
  fi
  if grep -rqsE "server_name[^;]*\b${DOMAIN//./\\.}\b" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null \
     && [[ ! -f /etc/nginx/sites-available/mdt ]]; then
    die "Für $DOMAIN existiert bereits ein nginx-Server-Block (z. B. dein Forum). Nimm eine Subdomain (z. B. mdt.$DOMAIN) – das vorhandene Forum bleibt unangetastet."
  fi
  sed -e "s|@DOMAIN@|$DOMAIN|g" -e "s|@PORT@|$PORT|g" "$APP_DIR/deploy/ubuntu/nginx-mdt.conf.template" > /etc/nginx/sites-available/mdt
  ln -sf /etc/nginx/sites-available/mdt /etc/nginx/sites-enabled/mdt
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx

  if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
    ufw allow 'Nginx Full' >/dev/null && echo "ufw: 'Nginx Full' erlaubt."
  fi

  if [[ $SSL -eq 1 ]]; then
    say "HTTPS-Zertifikat (Let's Encrypt)"
    if [[ -n "$EMAIL" ]]; then MAILARG=(-m "$EMAIL"); else MAILARG=(--register-unsafely-without-email); fi
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect "${MAILARG[@]}" \
      || echo "Zertifikat fehlgeschlagen – prüfe, ob der DNS-A-Eintrag von $DOMAIN auf diesen Server zeigt, und führe den Befehl erneut aus."
  fi
fi

say "Gesundheitsprüfung"
for i in 1 2 3 4 5 6 7 8; do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then OK=1; break; fi; sleep 1
done
[[ "${OK:-0}" == 1 ]] || { journalctl -u mdt -n 30 --no-pager || true; die "Der Dienst antwortet nicht. Logs oben bzw.: journalctl -u mdt -f"; }

PROTO=$([[ $SSL -eq 1 && $NGINX -eq 1 ]] && echo https || echo http)
say "Fertig!"
if [[ -n "$DOMAIN" ]]; then echo "Öffne: $PROTO://$DOMAIN  – beim ersten Aufruf erscheint die Ersteinrichtung (Administrator anlegen)."
else echo "Lokal erreichbar unter http://127.0.0.1:$PORT"; fi
echo "Logs:    journalctl -u mdt -f"
echo "Update:  sudo bash $APP_DIR/deploy/ubuntu/update.sh   (aus einem neuen Projektstand)"
echo "Backups: täglich 03:30 → $DATA_DIR/backups  (systemctl list-timers mdt-backup.timer)"
