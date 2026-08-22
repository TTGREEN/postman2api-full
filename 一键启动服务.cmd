@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\ops\windows-service-start.ps1"
if errorlevel 1 (
  echo.
  echo Startup failed. See messages above.
  pause
)
