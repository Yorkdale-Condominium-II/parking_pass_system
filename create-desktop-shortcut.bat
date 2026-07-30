@echo off
REM Creates a "Parking Pass System" shortcut on your Desktop that runs start.bat.
REM Double-click this once; then launch the app from the Desktop icon.
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'Parking Pass System.lnk'));" ^
  "$lnk.TargetPath = [IO.Path]::Combine('%~dp0','start.bat');" ^
  "$lnk.WorkingDirectory = '%~dp0';" ^
  "$lnk.IconLocation = '%SystemRoot%\System32\shell32.dll,167';" ^
  "$lnk.Description = 'Start the Parking Pass System';" ^
  "$lnk.Save();"
echo.
echo Done - a "Parking Pass System" icon is now on your Desktop.
echo Double-click it any time to update and launch the app.
echo.
pause
