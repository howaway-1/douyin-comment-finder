@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install an LTS version from https://nodejs.org/ first.
  pause
  exit /b 1
)
node.exe -e "if(Number(process.versions.node.split('.')[0]) < 20) process.exit(1)"
if errorlevel 1 (
  echo Your Node.js version is too old. Install a current LTS version from https://nodejs.org/.
  pause
  exit /b 1
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm enabled, then reopen this window.
  pause
  exit /b 1
)
echo Installing project dependencies...
call npm.cmd ci --no-audit --no-fund
if errorlevel 1 (
  echo Installation failed. Check your network connection and the error above, then try again.
  pause
  exit /b 1
)
echo Installation complete. Double-click Start.cmd to open the tool.
pause
exit /b 0
