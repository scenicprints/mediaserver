@echo off
title Marquee Optimizer
cd /d "%~dp0.."

REM The optimizer, running as a service rather than something a person starts.
REM
REM It clears whatever backlog exists, then wakes every 15 minutes to handle new
REM content. It stands down on its own whenever anyone is watching, paces itself
REM between files, and aborts the run if Windows reports disk trouble — so it is
REM safe to leave running for ever and that is how it is meant to run.
REM
REM Separate window and separate process from the media server on purpose: a
REM crash here must never take down playback.

:loop
echo(
echo ============================================
echo   Marquee Optimizer
echo   Stands down while anyone is watching.
echo   Close this window or press Ctrl+C to stop.
echo ============================================
echo(

node optimizer\run.mjs watch

REM If it ever falls out of the watch loop, wait a minute and pick itself back
REM up rather than leaving the library unattended until someone notices.
echo(
echo   Optimizer exited. Restarting in 60 seconds...
timeout /t 60 /nobreak >nul
goto loop
