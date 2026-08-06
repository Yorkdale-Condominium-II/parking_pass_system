@echo off
REM Stop the background TAGS-edition server (port 3100).
title Parking Pass System - stopping TAGS edition
echo Stopping the TAGS edition (port 3100)...
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess | Select-Object -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction Stop; Write-Host 'Stopped.' } catch {} } } else { Write-Host 'Not running.' }"
timeout /t 2 /nobreak >nul
exit
