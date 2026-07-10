@echo off
title My Media Server
cd /d "%~dp0.."
:loop
echo(
echo ============================================
echo   Checking for updates...
echo ============================================
git pull --ff-only
echo(
echo   Starting My Media Server
echo   (close this window or press Ctrl+C to stop)
echo(
node src\server.js
if %errorlevel%==42 (
  echo(
  echo   Update downloaded - restarting...
  goto loop
)
echo(
echo   Server stopped.
pause
