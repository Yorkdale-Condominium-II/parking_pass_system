@echo off
REM ==========================================================================
REM  Launcher for the PHYSICAL-TAG version of the Parking Pass System.
REM  Runs a SEPARATE instance (TAG_MODE) on port 3100 so you can demo it side
REM  by side with the standard system (start.bat, port 3000).
REM
REM  For full isolation, set TAGS_DATABASE_URL in your .env to a SEPARATE
REM  database (create it once, e.g. a "parking_pass_tags" DB). If unset, this
REM  instance shares the main database.
REM ==========================================================================
cd /d "%~dp0"
title Parking Pass System - TAGS edition (port 3100)

set TAG_MODE=true
set PORT=3100

echo ==========================================================
echo    Parking Pass System - PHYSICAL TAGS edition (port 3100)
echo ==========================================================
echo.

where git >nul 2>nul
if %errorlevel%==0 (
  git checkout -- package-lock.json 2>nul
  git pull 2>nul
)

echo Installing dependencies...
call npm install

echo Applying database updates (tags schema)...
call npm run migrate
echo Ensuring a demo login exists...
call npm run seed

echo.
REM Stop any previous tags instance on port 3100.
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 1 }"

echo Starting the TAGS server in the background...
powershell -NoProfile -Command "$env:TAG_MODE='true'; $env:PORT='3100'; Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%~dp0server-tags.log' -RedirectStandardError '%~dp0server-tags.err.log'"

echo Waiting for the server to be ready...
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){ try{ if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://localhost:3100/api/health').StatusCode -eq 200){ exit 0 } }catch{}; Start-Sleep -Seconds 1 }; exit 1"

start "" http://localhost:3100
echo.
echo The TAGS edition is running at http://localhost:3100
echo   To STOP it later, double-click stop-tags.bat in this folder.
exit
