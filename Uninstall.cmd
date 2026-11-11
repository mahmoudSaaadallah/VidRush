@echo off
setlocal
echo Close Chrome before continuing. Downloaded videos will be kept.
pause
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1"
if errorlevel 1 (
  echo Uninstall failed. Close Chrome and retry.
  pause
  exit /b 1
)
pause
