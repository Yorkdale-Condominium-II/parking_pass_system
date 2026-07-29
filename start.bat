@echo off
REM ==========================================================================
REM  One-click launcher for the Yorkdale Condominium II Parking Pass System.
REM  Double-click this file to start the server and open the app in a browser.
REM ==========================================================================
cd /d "%~dp0"
title Parking Pass System

echo ==========================================================
echo    Yorkdale Condominium II - Parking Pass System
echo ==========================================================
echo.

REM Install dependencies on first run if they are missing.
if not exist "node_modules" (
  echo First run detected - installing dependencies, please wait...
  call npm install
  echo.
)

echo Starting server...
echo A browser tab will open at http://localhost:3000 shortly.
echo.
echo   To STOP the server: press Ctrl+C, or just close this window.
echo.

REM Open the browser (it may need a refresh if it beats the server by a second).
start "" http://localhost:3000

REM Run the server in this window (this line blocks until you stop it).
call npm start

echo.
echo Server stopped. Press any key to close this window.
pause >nul
