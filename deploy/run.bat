@echo off
setlocal EnableDelayedExpansion
title My Media Server
cd /d "%~dp0.."

REM Keeps the media server running.
REM
REM This used to restart ONLY on exit code 42 - the in-app Update button - and
REM fall through to `pause` on anything else. So a crash, an out-of-memory kill,
REM or the process being stopped left this window sitting at a "press any key"
REM prompt with no server behind it. The window looked alive, which is worse
REM than it being closed, because nothing looked wrong. It restarted reliably
REM for the one case that was already deliberate, and not at all for the cases a
REM restarter exists for. Confirmed on 2026-09-09: node was stopped, the task
REM still read Running, and the server never came back.
REM
REM Now every exit restarts. A planned update goes straight round; anything else
REM waits a few seconds first, and repeated fast failures back off rather than
REM spinning - a server that cannot start should not pin a core retrying ten
REM times a second, and the gap between attempts is what makes the output
REM readable when you come to find out why.

set /a CRASHES=0

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
set EXITCODE=%errorlevel%

if "%EXITCODE%"=="42" (
  echo(
  echo   Update downloaded - restarting...
  set /a CRASHES=0
  goto loop
)

REM Ctrl+C, and the code Windows returns when the process is killed by the
REM console. The operator asked for this, so do not fight them.
if "%EXITCODE%"=="130" goto stopped
if "%EXITCODE%"=="-1073741510" goto stopped

set /a CRASHES+=1
echo(
echo   Server exited with code %EXITCODE% (failure !CRASHES! in a row).

if !CRASHES! GEQ 5 (
  echo   Five failures in a row - waiting 5 minutes before trying again.
  echo   Something is wrong; the reason is in the output above.
  timeout /t 300 /nobreak >nul
  set /a CRASHES=0
  goto loop
)

echo   Restarting in 10 seconds...
timeout /t 10 /nobreak >nul
goto loop

:stopped
echo(
echo   Server stopped by request.
timeout /t 5 /nobreak >nul
endlocal
