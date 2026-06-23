@echo off
cd /d "%~dp0"
echo ====================================================
echo    Stores Database Server - Auto-Startup Setup
echo ====================================================
echo.
echo Please choose how you want the server to start on boot:
echo [1] Silent Background (Recommended - runs hidden)
echo [2] Visible Console Window (Pops up a command prompt)
echo.
set /p choice="Enter choice [1 or 2, default is 1]: "

set MODE=Silent
if "%choice%"=="2" set MODE=Visible

echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_startup.ps1" -Mode %MODE%
echo.
echo Setup completed!
pause
