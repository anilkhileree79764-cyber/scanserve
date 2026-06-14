@echo off
title ScanServe - Cafe App
cd /d "%~dp0"
echo Starting your Cafe app...
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org then run this again.
  pause
  exit /b
)
if not exist node_modules ( echo First-time setup... & call npm install )
if not exist cafe.db ( echo Adding demo data... & call npm run seed )
start "" cmd /c "timeout /t 6 >nul & start http://localhost:3000"
echo App is running. KEEP THIS WINDOW OPEN. Close it to stop the app.
call npm start
pause
