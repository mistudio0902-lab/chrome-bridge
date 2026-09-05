@echo off
REM MCP stdio client launcher. Place this file next to server.js.
set "SERVER=%~dp0server.js"
set "LOGFILE=%~dp0wrapper-debug.log"
node "%SERVER%" %* 2>> "%LOGFILE%"
