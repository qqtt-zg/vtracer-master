@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0vtracer-ui.ps1" -Mode Launch
if errorlevel 1 (
    echo.
    echo VTracer UI failed to start.
    echo See "%~dp0vtracer-ui-launch.log" for details.
    pause
)
exit /b %errorlevel%
