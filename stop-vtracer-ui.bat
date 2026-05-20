@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0vtracer-ui.ps1" -Mode Stop
exit /b %errorlevel%
