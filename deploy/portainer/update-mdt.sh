#!/usr/bin/env bash
# MDT – Update auf dem Server (Docker). Aufruf:  cd /opt/mdt-template && sudo bash update-mdt.sh
# Holt die aktuelle Compose-Datei, zieht das neueste Image, startet den Container NEU und zeigt die laufende Commit-Nummer.
set -euo pipefail
cd "$(dirname "$0")"

REPO="tommehling0109/mdt-template"
RAW="https://raw.githubusercontent.com/${REPO}/main/deploy/portainer/stack-ghcr.yml"

echo "1/4  Aktuelle Compose-Datei laden …"
curl -fsSL "$RAW" -o docker-compose.yml

echo "2/4  Neuestes Image ziehen …"
TRUST_PROXY=1 docker compose pull

echo "3/4  Container neu starten (Daten bleiben im Volume erhalten) …"
TRUST_PROXY=1 docker compose up -d --force-recreate

echo "4/4  Warten, bis das MDT antwortet …"
for i in $(seq 1 30); do
  if out=$(curl -fsS http://localhost:3847/api/version 2>/dev/null); then
    echo "Läuft: $out"
    echo "→ Im Browser einmal STRG+F5 drücken. Unten rechts steht „Build <Commit>“."
    exit 0
  fi
  sleep 1
done
echo "FEHLER: Das MDT antwortet nicht. Logs:"
docker compose logs --tail 40
exit 1
