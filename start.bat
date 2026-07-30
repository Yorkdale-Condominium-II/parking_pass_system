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
echo Starting server... a browser tab will open at http://localhost:3000
echo   To STOP the server: press Ctrl+C, or just close this window.
echo.

REM Open the browser (a refresh may be needed if it beats the server by a second).
start "" http://localhost:3000

REM Run the server in this window (blocks until you stop it).
call npm start

echo.
echo Server stopped. Press any key to close this window.
pause >nul
