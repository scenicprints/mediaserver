# ============================================================
#  My Media Server — one-time setup for the Dell
#  Right-click this file > "Run with PowerShell"
#  (or open PowerShell, cd into the deploy folder, run .\setup-dell.ps1)
# ============================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # project folder (parent of \deploy)

Write-Host "=== My Media Server - Dell setup ===" -ForegroundColor Cyan

# 1) Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js not found - installing LTS via winget..." -ForegroundColor Yellow
  winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
  # Refresh PATH for this session so 'node' is usable immediately
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
Write-Host ("Node: " + (node --version)) -ForegroundColor Green

# 2) Dependencies
Write-Host "Installing dependencies (npm install)..." -ForegroundColor Yellow
Push-Location $root
npm install
Pop-Location
Write-Host "Dependencies installed." -ForegroundColor Green

# 3) Firewall - allow other devices on your network to reach the server
if (-not (Get-NetFirewallRule -DisplayName 'MyMediaServer 8096' -ErrorAction SilentlyContinue)) {
  try {
    New-NetFirewallRule -DisplayName 'MyMediaServer 8096' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8096 | Out-Null
    Write-Host "Firewall: opened TCP port 8096." -ForegroundColor Green
  } catch {
    Write-Host "Could not add firewall rule (need admin). Re-run this in an ADMIN PowerShell, or add it manually." -ForegroundColor Yellow
  }
}

# 4) Show the address to use from other devices
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' } |
  Select-Object -First 1).IPAddress

Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Cyan
Write-Host "Start the server by double-clicking:  deploy\start-server.bat" -ForegroundColor White
Write-Host ("Then browse from any device (phone, this PC, etc.) at:  http://{0}:8096" -f $ip) -ForegroundColor White
Write-Host ""
Write-Host "Optional: to start it automatically at login, run  deploy\install-autostart.ps1" -ForegroundColor DarkGray
