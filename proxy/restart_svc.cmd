@echo off
rem Usage:
rem   restart_svc.cmd -status              -> show is-active for every whitelisted service
rem   restart_svc.cmd <service.name>      -> restart that service (whitelist enforced server-side)
rem Token lives in svc_token.txt next to this file.
setlocal
set "T=%LOCALAPPDATA%\dsh-gui-forward"
if not exist "%T%\svc_token.txt" (
  echo [x] missing %T%\svc_token.txt  - put the token there first
  exit /b 2
)
set /p TOK=<"%T%\svc_token.txt"
if /i "%1"=="-status" (
  curl -s -m 30 "http://127.0.0.1:19395/status?token=%TOK%"
) else if "%~1"=="" (
  echo usage: restart_svc.cmd -status ^| restart_svc.cmd ^<service.name^>
  exit /b 2
) else (
  curl -s -m 60 "http://127.0.0.1:19395/restart?svc=%~1&token=%TOK%"
)
echo.
endlocal
