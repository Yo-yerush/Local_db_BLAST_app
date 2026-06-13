@echo off
setlocal

cd /d "%~dp0"
title Local BLAST Web App

if not defined PORT set "PORT=3000"

if exist "blast-bin-dir.txt" (
  set /p BLAST_BIN_DIR=<"blast-bin-dir.txt"
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH.
  echo Install Node.js 18 or newer, then run this file again.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%/api/databases' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 (
  echo Local BLAST Web App is already running.
  echo Opening http://127.0.0.1:%PORT%
  start "" "http://127.0.0.1:%PORT%"
  echo.
  pause
  exit /b 0
)

echo Starting Local BLAST Web App...
echo URL: http://127.0.0.1:%PORT%
echo.
echo Keep this window open while using the app.
echo Press Ctrl+C in this window to stop the server.
echo.

start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%'"

node server.js

echo.
echo Local BLAST Web App stopped.
pause
