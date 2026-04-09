@echo off
title HTML Capture Utility

:: ─────────────────────────────────────────────────────────────────────────────
::  START_CAPTURE.bat
::  Double-click this file to launch the HTML Capture Utility.
::  Place this file in the SAME folder as capture.js
:: ─────────────────────────────────────────────────────────────────────────────

:: Move to the folder where this .bat file lives
cd /d "%~dp0"

echo.
echo  ============================================================
echo   HTML Capture Utility  -  Starting...
echo  ============================================================
echo.

:: ── Check Node.js is installed ───────────────────────────────────────────────
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  [ERROR] Node.js is NOT installed or not in PATH.
    echo.
    echo  Please install Node.js from https://nodejs.org
    echo  Choose the LTS version ^(18 or higher^).
    echo.
    pause
    exit /b 1
)

:: ── Print Node version ───────────────────────────────────────────────────────
for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo  Node.js version : %NODE_VER%

:: ── Check node_modules exists, run npm install if not ───────────────────────
if not exist "node_modules\" (
    echo.
    echo  [SETUP] node_modules not found. Running npm install...
    echo  ^(This happens only once^)
    echo.
    call npm install playwright
    if %ERRORLEVEL% NEQ 0 (
        echo  [ERROR] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo.
    echo  [SETUP] Installing Chromium browser...
    call npx playwright install chromium
    if %ERRORLEVEL% NEQ 0 (
        echo  [ERROR] Chromium install failed.
        pause
        exit /b 1
    )
    echo.
    echo  [SETUP] Setup complete!
    echo.
)

:: ── Create output folder if missing ─────────────────────────────────────────
if not exist "src\resources\html-pages\" (
    mkdir "src\resources\html-pages"
    echo  [SETUP] Created output folder: src\resources\html-pages\
)

:: ── Launch capture.js ────────────────────────────────────────────────────────
echo  Output folder : %~dp0src\resources\html-pages\
echo  Browser       : Chromium ^(Playwright^)
echo.
echo  ============================================================
echo   Browser is opening... Navigate to any page.
echo   Click the [Capture HTML] button for a manual snapshot.
echo   Press Ctrl+C in this window to stop.
echo  ============================================================
echo.

node src\capture.js

:: ── Exit message ─────────────────────────────────────────────────────────────
echo.
echo  [STOPPED] Capture utility has exited.
pause
