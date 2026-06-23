@echo off
cd /d "%~dp0"
echo Stopping Delivery Monitor Server (Port 5000)...

REM Find the process listening on port 5000 and kill it
FOR /F "tokens=5" %%T IN ('netstat -ano ^| find "LISTENING" ^| findstr ":5000 "') DO (
    echo Found running server with PID %%T
    taskkill /F /PID %%T
)

echo.
echo Server stopped successfully.
pause
