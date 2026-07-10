# ============================================================
#  Make the media server launch automatically when you log in
#  to the Dell. Run once:  Right-click > "Run with PowerShell".
#  (Remove later with:  Unregister-ScheduledTask -TaskName MyMediaServer)
# ============================================================
$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $PSScriptRoot
$node   = (Get-Command node -ErrorAction Stop).Source
$server = Join-Path $root 'src\server.js'

$action  = New-ScheduledTaskAction -Execute $node -Argument ('"' + $server + '"') -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit 0

Register-ScheduledTask -TaskName 'MyMediaServer' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Auto-start installed. The server will launch each time you log in to the Dell." -ForegroundColor Green
Write-Host "Tip: set the Dell to auto-login so it comes up on its own after a reboot." -ForegroundColor DarkGray
