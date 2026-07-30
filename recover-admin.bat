@echo off
REM ==========================================================================
REM  Emergency account recovery. Use this if you are locked out (an account
REM  was disabled, or a password was lost). Re-enables an account, sets a new
REM  temporary password, and makes it a superuser so you can fix things in the
REM  app again.
REM ==========================================================================
cd /d "%~dp0"
title Parking Pass System - account recovery

echo ==========================================================
echo    Parking Pass System - account recovery
echo ==========================================================
echo.
echo Current accounts:
echo.
call node scripts\recover-admin.js
echo.

set /p RECUSER=Enter the username to recover:
if "%RECUSER%"=="" (
  echo No username entered. Nothing changed.
  pause
  exit /b
)

set /p RECPASS=Enter a new temporary password (min 8 chars):
if "%RECPASS%"=="" (
  echo No password entered. Nothing changed.
  pause
  exit /b
)

echo.
call node scripts\recover-admin.js "%RECUSER%" "%RECPASS%"
echo.
echo You can now start the app (start.bat) and log in.
pause
