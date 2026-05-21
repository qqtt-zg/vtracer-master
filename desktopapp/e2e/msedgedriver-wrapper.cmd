@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "REPO_ROOT=%%~fI"
set "DRIVER_PATH=%REPO_ROOT%\msedgedriver.exe"
set "LOG_PATH=%SCRIPT_DIR%.artifacts\logs\msedgedriver.verbose.log"

if not exist "%DRIVER_PATH%" (
  echo msedgedriver not found: "%DRIVER_PATH%"
  exit /b 1
)

"%DRIVER_PATH%" --verbose --log-path="%LOG_PATH%" %*
endlocal
