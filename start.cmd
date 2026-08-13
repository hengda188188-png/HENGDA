@echo off
REM ============================================================
REM  photo-relay launcher (double-click this file)
REM  Keep this window open - it IS the server. Closing it stops the tool.
REM  Filename and contents are pure ASCII on purpose: Chinese in .cmd
REM  gets mangled by the Big5 console codepage on some machines.
REM ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] Node.js not found.
  echo.
  echo   Please install Node.js 20 or newer first:
  echo       https://nodejs.org
  echo.
  echo   Then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting photo-relay ... a browser tab will open automatically.
echo   KEEP THIS WINDOW OPEN. Close it to stop the tool.
echo.

node server.mjs --open

echo.
echo   Server stopped.
pause
