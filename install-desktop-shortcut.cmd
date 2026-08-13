@echo off
REM ============================================================
REM  Create a Desktop shortcut for photo-relay (run once).
REM  Pure ASCII on purpose - see start.cmd for the reason.
REM ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] Node.js not found. Install it first: https://nodejs.org
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$desk = [Environment]::GetFolderPath('Desktop');" ^
  "$node = (Get-Command node).Source;" ^
  "$here = (Get-Location).Path;" ^
  "$sc = $ws.CreateShortcut((Join-Path $desk 'PhotoRelay.lnk'));" ^
  "$sc.TargetPath = $node;" ^
  "$sc.Arguments = '\"' + (Join-Path $here 'server.mjs') + '\" --open';" ^
  "$sc.WorkingDirectory = $here;" ^
  "$sc.Description = 'photo-relay - scan QR to upload photos';" ^
  "$sc.IconLocation = \"$env:SystemRoot\System32\imageres.dll,109\";" ^
  "$sc.Save();" ^
  "Write-Host ''; Write-Host ('  Shortcut created: ' + (Join-Path $desk 'PhotoRelay.lnk'))"

echo.
echo   Done. You can rename the desktop shortcut to anything you like.
echo.
pause
