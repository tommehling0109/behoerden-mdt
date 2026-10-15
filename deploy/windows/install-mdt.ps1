# MDT - Installation unter Windows 11 (Docker Desktop)
# Aufruf (PowerShell als normaler Benutzer):
#   powershell -ExecutionPolicy Bypass -File .\install-mdt.ps1
# Optional: -Ordner "D:\mdt-template"  -Port 3847  -HinterProxy (setzt TRUST_PROXY=1, wenn HTTPS-Proxy davor sitzt)
param(
  [string]$Ordner = "C:\mdt-template",
  [int]$Port = 3847,
  [switch]$HinterProxy
)
$ErrorActionPreference = 'Stop'
$Repo = 'tommehling0109/mdt-template'
$Raw = "https://raw.githubusercontent.com/$Repo/main"

function Schritt($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }

Schritt '1/5  Docker pruefen'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Docker wurde nicht gefunden.' -ForegroundColor Red
  Write-Host 'Bitte "Docker Desktop" installieren:  winget install -e --id Docker.DockerDesktop   (danach Windows neu starten, Docker Desktop einmal oeffnen)'
  exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Docker Desktop laeuft nicht. Bitte Docker Desktop starten, warten bis unten links "Engine running" steht, dann dieses Skript erneut ausfuehren.' -ForegroundColor Red
  exit 1
}

Schritt "2/5  Ordner anlegen: $Ordner"
New-Item -ItemType Directory -Force -Path $Ordner | Out-Null
Set-Location $Ordner

Schritt '3/5  Dateien laden'
Invoke-WebRequest -UseBasicParsing "$Raw/deploy/portainer/stack-ghcr.yml" -OutFile 'docker-compose.yml'
Invoke-WebRequest -UseBasicParsing "$Raw/deploy/windows/update-mdt.ps1" -OutFile 'update-mdt.ps1'
Invoke-WebRequest -UseBasicParsing "$Raw/deploy/windows/backup-mdt.ps1" -OutFile 'backup-mdt.ps1'

Schritt '4/5  Einstellungen schreiben (.env)'
$tp = if ($HinterProxy) { 1 } else { 0 }
"MDT_PORT=$Port`nTRUST_PROXY=$tp`nTZ=Europe/Berlin" | Set-Content -Encoding ascii '.env'

Schritt '5/5  MDT starten'
docker compose pull
docker compose up -d
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  try { $v = (Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/api/version").Content; $ok = $true; break } catch { Start-Sleep 1 }
}
if ($ok) {
  Write-Host "`nFERTIG. MDT laeuft: $v" -ForegroundColor Green
  Write-Host "Im Browser oeffnen: http://localhost:$Port   (beim ersten Mal erscheint die Ersteinrichtung)"
  Write-Host "Update spaeter:  cd $Ordner ; powershell -ExecutionPolicy Bypass -File .\update-mdt.ps1"
} else {
  Write-Host 'FEHLER: Das MDT antwortet nicht. Logs:' -ForegroundColor Red
  docker compose logs --tail 40
  exit 1
}
