@echo off
setlocal

if not exist node_modules (
  call npm.cmd install
  if errorlevel 1 exit /b 1
)

call npm.cmd run dev
