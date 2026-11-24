param(
  [string]$ServerIp = "192.168.88.10",
  [int]$SshPort = 22,
  [string]$Username = "ubuntu",
  [int]$AppPort = 8090
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$KeyPath = "$HOME\.ssh\id_ed25519"
$BundlePath = "$env:TEMP\ai-noc-mikrotik-bundle.tar.gz"

Write-Host "=== [1/4] Build lokal Frontend & Backend ===" -ForegroundColor Cyan
Push-Location "$ProjectRoot\backend"
npm run build
Pop-Location
Push-Location "$ProjectRoot\frontend"
npm run build
Pop-Location

Write-Host "=== [2/4] Mengemas kode sumber + dist AI NOC ===" -ForegroundColor Cyan
Push-Location $ProjectRoot
if (Test-Path $BundlePath) { Remove-Item $BundlePath -Force }
tar -czf $BundlePath --exclude="node_modules" --exclude=".git" --exclude=".env" --exclude="data" .
Pop-Location

Write-Host "=== [3/4] Mengunggah paket ke ~/ai-noc-mikrotik di $ServerIp ===" -ForegroundColor Cyan
ssh -i $KeyPath -p $SshPort "$Username@$ServerIp" "mkdir -p ~/ai-noc-mikrotik"
scp -i $KeyPath -P $SshPort $BundlePath "$Username@${ServerIp}:~/ai-noc-mikrotik/bundle.tar.gz"

Write-Host "=== [4/4] Mengekstrak & merestart layanan AI NOC (Port $AppPort) ===" -ForegroundColor Cyan
$RemoteScript = @'
set -e
cd ~/ai-noc-mikrotik
tar -xzf bundle.tar.gz
rm -f bundle.tar.gz
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
fi
cd ~/ai-noc-mikrotik/backend
npm ci --omit=dev
systemctl --user daemon-reload || true
systemctl --user restart ai-noc-mikrotik.service
systemctl --user status ai-noc-mikrotik.service --no-pager | head -n 15
'@

ssh -i $KeyPath -p $SshPort "$Username@$ServerIp" $RemoteScript
Write-Host "=== Selesai! Buka http://${ServerIp}:${AppPort} untuk Kantor AI NOC 3D ===" -ForegroundColor Green
