@echo off
cd /d "%~dp0"
if not exist node_modules (
    echo Installing dependencies...
    call npm install
)
echo Starting rcpt_debt server on http://localhost:3008
node server.js
pause
