@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "LOG_PATH=%SCRIPT_DIR%.artifacts\logs\msedgedriver.verbose.log"
"I:\迅雷下载\vtracer-master\msedgedriver.exe" --verbose --log-path="%LOG_PATH%" %*
endlocal
