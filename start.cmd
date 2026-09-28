@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer: https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\socket.io\package.json" (
  call npm.cmd ci --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node "%~dp0server.js"
pause
