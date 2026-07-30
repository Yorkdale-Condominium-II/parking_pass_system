@echo off
REM ==========================================================================
REM  Stop the background Parking Pass System server.
REM  start.bat launches the server hidden; double-click this to stop it.
REM ==========================================================================
title Parking Pass System - stopping

echo Stopping the Parking Pass System server (port 3000)...

REM Find whatever process is listening on port 3000 and stop it. This avoids
REM killing unrelated Node apps that may also be running on this PC.
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess | Select-Object -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction Stop; Write-Host 'Server stopped.' } catch { Write-Host 'Could not stop process' $_ } } } else { Write-Host 'Server is not running.' }"

timeout /t 2 /nobreak >nul
exit
