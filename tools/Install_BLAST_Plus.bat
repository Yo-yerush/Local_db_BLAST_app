@echo off
setlocal

cd /d "%~dp0"
title Install NCBI BLAST+

set "BLAST_VERSION=2.17.0+"
set "BLAST_ARCHIVE=ncbi-blast-%BLAST_VERSION%-x64-win64.tar.gz"
set "BLAST_URL=https://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/LATEST/%BLAST_ARCHIVE%"
set "BLAST_DIR=ncbi-blast-%BLAST_VERSION%"
set "BLAST_BIN=%CD%\%BLAST_DIR%\bin"

echo Installing NCBI BLAST+ %BLAST_VERSION% for Windows x64
echo Destination: %CD%\%BLAST_DIR%
echo.

where powershell >nul 2>nul
if errorlevel 1 (
  echo PowerShell was not found on PATH.
  pause
  exit /b 1
)

where tar >nul 2>nul
if errorlevel 1 (
  echo tar was not found on PATH.
  echo On Windows 10/11, tar is usually included. Install BLAST+ manually from:
  echo %BLAST_URL%
  pause
  exit /b 1
)

if exist "%BLAST_BIN%\blastn.exe" if exist "%BLAST_BIN%\makeblastdb.exe" (
  echo BLAST+ already appears to be installed:
  echo %BLAST_BIN%
  echo.
  "%BLAST_BIN%\blastn.exe" -version
  echo.
  pause
  exit /b 0
)

echo Downloading:
echo %BLAST_URL%
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '%BLAST_URL%' -OutFile '%BLAST_ARCHIVE%' -TimeoutSec 600 } catch { Write-Error $_; exit 1 }"
if errorlevel 1 (
  echo.
  echo Download failed.
  pause
  exit /b 1
)

echo Extracting %BLAST_ARCHIVE%...
tar -xzf "%BLAST_ARCHIVE%" -C "%CD%"
if errorlevel 1 (
  echo.
  echo Extraction failed.
  pause
  exit /b 1
)

del "%BLAST_ARCHIVE%" >nul 2>nul

if not exist "%BLAST_BIN%\blastn.exe" (
  echo.
  echo blastn.exe was not found after extraction.
  echo Expected: %BLAST_BIN%\blastn.exe
  pause
  exit /b 1
)

if not exist "%BLAST_BIN%\makeblastdb.exe" (
  echo.
  echo makeblastdb.exe was not found after extraction.
  echo Expected: %BLAST_BIN%\makeblastdb.exe
  pause
  exit /b 1
)

echo.
echo BLAST+ installed successfully.
echo %BLAST_BIN%
echo.
"%BLAST_BIN%\blastn.exe" -version
"%BLAST_BIN%\makeblastdb.exe" -version
echo.
echo You can now run ..\Local_BLAST_app.bat
pause
