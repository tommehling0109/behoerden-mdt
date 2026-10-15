#!/usr/bin/env bash
# MDT aktualisieren: neuen Projektstand nach /opt/mdt kopieren, Sicherung anlegen, Dienst neu starten.
#   sudo bash deploy/ubuntu/update.sh        (im neu entpackten/geklonten Projektordner ausführen)
# Daten (/var/lib/mdt) bleiben unberührt; Datenbank-Migrationen laufen beim Start automatisch.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Bitte mit sudo ausführen." >&2; exit 1; }
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -f "$SRC/server/index.js" ]] || { echo "Projekt nicht gefunden: $SRC" >&2; exit 1; }
APP_DIR=/opt/mdt
[[ -d "$APP_DIR" ]] || { echo "$APP_DIR existiert nicht – erst install.sh ausführen." >&2; exit 1; }

echo "==> Sicherung vor dem Update"
systemctl start mdt-backup.service || echo "(Backup übersprungen)"

echo "==> Stand: $(git -C "$SRC" log -1 --format='%h %s' 2>/dev/null || echo '(kein Git-Ordner)')"
echo "==> Dateien kopieren"
if [[ "$SRC" != "$APP_DIR" ]]; then
  rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude '/data' --exclude '*.log' "$SRC/" "$APP_DIR/"
  chown -R root:root "$APP_DIR"
fi
NODE_BIN="$(command -v node)"
sed "s|@NODE@|$NODE_BIN|g" "$APP_DIR/deploy/ubuntu/mdt.service" > /etc/systemd/system/mdt.service
sed "s|@NODE@|$NODE_BIN|g" "$APP_DIR/deploy/ubuntu/mdt-backup.service" > /etc/systemd/system/mdt-backup.service
cp "$APP_DIR/deploy/ubuntu/mdt-backup.timer" /etc/systemd/system/mdt-backup.timer
systemctl daemon-reload

echo "==> Neustart"
systemctl restart mdt.service
PORT="$(grep -E '^PORT=' /etc/mdt/mdt.env | cut -d= -f2)"
for i in 1 2 3 4 5 6 7 8; do
  if curl -fsS "http://127.0.0.1:${PORT:-3847}/healthz" >/dev/null 2>&1; then echo "Update erfolgreich – Dienst läuft ($(ls "$APP_DIR/server/modules" | wc -l) Module installiert, u. a. credit.js: $([[ -f "$APP_DIR/server/modules/credit.js" ]] && echo ja || echo NEIN))."; exit 0; fi; sleep 1
done
journalctl -u mdt -n 40 --no-pager || true
echo "Der Dienst antwortet nicht – siehe Logs. Rückfall: Backup in /var/lib/mdt/backups." >&2
exit 1
