# Ship a Marquee Apple TV update from this PC.
#
#   powershell -File appletv\push-appletv.ps1 "what changed"
#
# If there are changes under appletv/, it commits + pushes them (which triggers
# the "Apple TV app" workflow -> TestFlight -> your Apple TV auto-updates).
# If nothing changed, it just re-triggers a build (workflow_dispatch) — handy to
# refresh the TestFlight build on demand. Requires the GitHub CLI (`gh`) to be
# installed and authenticated for the live status watch.
param(
  [string]$Message = "Apple TV: update"
)
$ErrorActionPreference = "Stop"
# This script lives in appletv/, so the repo root is its parent directory.
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# Are there staged/unstaged changes under appletv/ or the workflow?
$changes = git status --porcelain -- appletv .github/workflows/appletv.yml
if ($changes) {
  Write-Host "Committing Apple TV changes..." -ForegroundColor Cyan
  git add appletv .github/workflows/appletv.yml
  git commit -m $Message
  git push
  Write-Host "Pushed — the 'Apple TV app' workflow will build and upload to TestFlight." -ForegroundColor Green
} else {
  Write-Host "No Apple TV changes; triggering a rebuild instead..." -ForegroundColor Cyan
  gh workflow run "Apple TV app"
  Write-Host "Triggered a fresh TestFlight build." -ForegroundColor Green
}

# Follow the run live if the GitHub CLI is available.
if (Get-Command gh -ErrorAction SilentlyContinue) {
  Start-Sleep -Seconds 4
  gh run watch --exit-status (gh run list --workflow "Apple TV app" --limit 1 --json databaseId --jq '.[0].databaseId')
} else {
  Write-Host "Install the GitHub CLI (gh) to watch build status here; otherwise check the Actions tab." -ForegroundColor Yellow
}
