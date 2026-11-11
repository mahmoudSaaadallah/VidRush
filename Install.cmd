@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install the LTS version from https://nodejs.org/
  echo Then close this window and run Install.cmd again.
  pause
  exit /b 1
)
node "%~dp0scripts\install.cjs"
if errorlevel 1 (
  echo.
  echo Installation did not complete. Read the error above.
  pause
  exit /b 1
)
pause
