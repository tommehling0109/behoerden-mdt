# MDT - Datensicherung unter Windows 11 (Docker Desktop)
# Aufruf im Installationsordner:  powershell -ExecutionPolicy Bypass -File .\backup-mdt.ps1
# Legt eine konsistente Kopie der Datenbank an und kopiert sie in den Unterordner .\backups
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path '.\backups' | Out-Null

Write-Host 'Sicherung wird erstellt ...' -ForegroundColor Cyan
docker compose exec -T mdt node --disable-warning=ExperimentalWarning scripts/backup.js
if ($LASTEXITCODE -ne 0) { Write-Host 'Sicherung fehlgeschlagen. Laeuft der Container?' -ForegroundColor Red; exit 1 }

# neueste Sicherung aus dem Container holen
$neu = (docker compose exec -T mdt sh -c 'ls -1t /data/backups | head -1').Trim()
if ($neu) {
  docker compose cp "mdt:/data/backups/$neu" ".\backups\$neu"
  Write-Host "Gesichert: $(Resolve-Path ".\backups\$neu")" -ForegroundColor Green
}
