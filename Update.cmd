@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" %*
if errorlevel 1 (
  echo.
  echo Update did not complete. Read the error above.
  pause
  exit /b 1
)
pause
