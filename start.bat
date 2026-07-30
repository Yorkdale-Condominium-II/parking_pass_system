@echo off
REM ==========================================================================
REM  One-click launcher for the Parking Pass System.
REM  Double-click this file to update, apply DB changes, and start the app.
REM ==========================================================================
cd /d "%~dp0"
title Parking Pass System

echo ==========================================================
echo    Parking Pass System - starting
echo ==========================================================
echo.

REM --- Pull the latest code (best-effort; never blocks startup) ------------
where git >nul 2>nul
if %errorlevel%==0 (
  echo Checking for updates...
  REM Discard only the auto-generated lockfile so the pull is never blocked
  REM by local npm-install churn. Your .env is git-ignored and untouched.
  git checkout -- package-lock.json 2>nul
  git pull
  if errorlevel 1 (
    echo.
    echo [warning] Could not update - starting with the current code.
    echo.
  )
) else (
  echo [info] git not found - skipping the update check.
)

REM --- Dependencies (fast when nothing changed) ---------------------------
echo Installing dependencies...
call npm install

REM --- Database migration (idempotent - safe to run every launch) ---------
echo Applying any database updates...
call npm run migrate
if errorlevel 1 (
  echo.
  echo [warning] Database update did not complete. Is PostgreSQL running?
  echo           The app will still try to start.
  echo.
)

echo.
REM --- Stop any server still running from a previous launch ------------------
REM Without this, a freshly pulled build can't take over because the old
REM process keeps holding port 3000 (you'd keep running stale code).
echo Stopping any previous server on port 3000...
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } ; Start-Sleep -Seconds 1 }"

echo Starting server in the background...

REM --- Launch the server as an independent, hidden background process --------
REM Start-Process detaches it from this window, so the server keeps running
REM after this launcher closes. Output goes to server.log / server.err.log.
powershell -NoProfile -Command "Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%~dp0server.log' -RedirectStandardError '%~dp0server.err.log'"

REM --- Wait until the server actually answers (up to ~40s) -------------------
echo Waiting for the server to be ready...
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){ try{ if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://localhost:3000/api/health').StatusCode -eq 200){ exit 0 } }catch{}; Start-Sleep -Seconds 1 }; exit 1"
if errorlevel 1 (
  echo.
  echo [warning] The server did not respond in time. It may still be starting.
  echo           Check server.err.log in this folder if the page does not load.
  echo.
)

REM --- Open the browser, then close this launcher window ---------------------
start "" http://localhost:3000
echo.
echo The app is running at http://localhost:3000
echo   To STOP the server later, double-click stop.bat in this folder.

REM Close this window now that the app is up and open in the browser.
exit
