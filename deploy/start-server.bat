@echo off
REM Double-click to start the media server. Leave this window open while you use it.
cd /d "%~dp0.."
echo Starting My Media Server...
echo Close this window (or press Ctrl+C) to stop it.
echo.
node src\server.js
echo.
echo Server stopped.
pause
