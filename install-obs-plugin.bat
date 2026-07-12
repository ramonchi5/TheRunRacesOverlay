@echo off
setlocal

set "SOURCE=%~dp0therun-races-overlay"
set "TARGET=%ProgramData%\obs-studio\plugins\therun-races-overlay"

if not exist "%SOURCE%\bin\64bit\therun-races-overlay.dll" (
  echo The native plugin files were not found next to this installer.
  echo Use the v3 release package or build the plugin first.
  pause
  exit /b 1
)

robocopy "%SOURCE%" "%TARGET%" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo OBS plugin installation failed.
  echo Try running this installer as administrator.
  pause
  exit /b 1
)

echo TheRun Race Leaderboard was installed for OBS Studio.
tasklist /FI "IMAGENAME eq obs64.exe" | find /I "obs64.exe" >nul
if not errorlevel 1 echo Restart OBS Studio before adding the source.
pause
