@echo off
cd /d "%~dp0"

REM Stop any existing server on port 5000 to prevent port conflicts
FOR /F "tokens=5" %%T IN ('netstat -ano ^| find "LISTENING" ^| findstr ":5000 "') DO (
    taskkill /F /PID %%T >nul 2>&1
)

REM Install dependencies on first run
if not exist "node_modules" (
    call npm install
)

REM Build the SQLite database from your data if it does not exist yet
node migrate_to_sqlite.js

REM Start server directly in this process (runs hidden under VBScript)
node server.js > server_run.log 2>&1
