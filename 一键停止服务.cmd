@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\ops\windows-service-stop.ps1"
pause
