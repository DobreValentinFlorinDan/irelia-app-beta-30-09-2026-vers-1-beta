@echo off
REM ---------------------------------------------------------------------------
REM Irelia Fieldbook desktop launcher.
REM
REM ELECTRON_RUN_AS_NODE must be cleared before Electron starts. The DSH harness
REM (and other Electron-based tooling) exports it globally, and while it is set
REM Electron runs as plain node instead of a GUI app, failing immediately on
REM `app.whenReady` being undefined.
REM ---------------------------------------------------------------------------
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="

cd /d "%~dp0.."
if not exist "dist\index.html" (
  echo [irelia] dist\index.html missing - building the client first...
  call npm run build || goto :fail
)

"%~dp0..\node_modules\electron\dist\electron.exe" .
goto :eof

:fail
echo [irelia] Build failed. Run "npm install" then "npm run build".
exit /b 1
