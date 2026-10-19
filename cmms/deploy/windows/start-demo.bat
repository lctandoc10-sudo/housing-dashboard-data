@echo off
rem ------------------------------------------------------------------
rem  Precast CMMS - try it on this PC with demo data.
rem  Double-click this file. The first run takes a few minutes.
rem ------------------------------------------------------------------
setlocal
cd /d "%~dp0..\.."
title Precast CMMS (demo)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Install the LTS version from https://nodejs.org then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing components - first run only, please wait...
  call npm install --omit=dev
  if errorlevel 1 (
    echo.
    echo  Installation failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

set CMMS_DB=data\demo.db
set PORT=3000

if not exist data\demo.db (
  echo Creating demo database with 90 days of sample data...
  set CMMS_ADMIN_PASSWORD=Admin12345
  call node server\cli.js demo
  if errorlevel 1 (
    echo.
    echo  Could not create the demo database.
    pause
    exit /b 1
  )
)

echo.
echo  ============================================================
echo   Precast CMMS is starting at  http://localhost:3000
echo   Sign in as  manager  /  Demo1234   (or admin / Admin12345)
echo   Keep this window open while you use the app.
echo   Close this window to stop the app.
echo  ============================================================
echo.
start "" cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:3000"
node server\index.js
pause
