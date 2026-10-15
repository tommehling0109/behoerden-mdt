# MDT - Update unter Windows 11 (Docker Desktop)
# Aufruf im Installationsordner:  powershell -ExecutionPolicy Bypass -File .\update-mdt.ps1
# Holt die aktuelle Compose-Datei, zieht das neueste Image, startet den Container NEU (Daten bleiben im Volume) und zeigt die Commit-Nummer.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$Raw = 'https://raw.githubusercontent.com/tommehling0109/mdt-template/main'

# Port aus .env lesen (Standard 3847)
$Port = 3847
if (Test-Path '.env') { foreach ($l in Get-Content '.env') { if ($l -match '^MDT_PORT=(\d+)$') { $Port = [int]$Matches[1] } } }

Write-Host '1/4  Aktuelle Compose-Datei laden ...' -ForegroundColor Cyan
Invoke-WebRequest -UseBasicParsing "$Raw/deploy/portainer/stack-ghcr.yml" -OutFile 'docker-compose.yml'

Write-Host '2/4  Neuestes Image ziehen ...' -ForegroundColor Cyan
docker compose pull
if ($LASTEXITCODE -ne 0) { Write-Host 'Pull fehlgeschlagen (Docker Desktop gestartet? Internet?).' -ForegroundColor Red; exit 1 }

Write-Host '3/4  Container neu starten (Daten bleiben erhalten) ...' -ForegroundColor Cyan
docker compose up -d --force-recreate

Write-Host '4/4  Warten, bis das MDT antwortet ...' -ForegroundColor Cyan
for ($i = 0; $i -lt 40; $i++) {
  try {
    $v = (Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/api/version").Content
    Write-Host "Laeuft: $v" -ForegroundColor Green
    Write-Host 'Im Browser einmal STRG+F5 druecken. Unten rechts steht "Build <Commit>".'
    exit 0
  } catch { Start-Sleep 1 }
}
Write-Host 'FEHLER: Das MDT antwortet nicht. Logs:' -ForegroundColor Red
docker compose logs --tail 40
exit 1
