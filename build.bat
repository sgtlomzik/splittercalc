@echo off
setlocal

call npm.cmd install
if errorlevel 1 exit /b 1

call npm.cmd run build
if errorlevel 1 exit /b 1

start "" "dist\index.html"
