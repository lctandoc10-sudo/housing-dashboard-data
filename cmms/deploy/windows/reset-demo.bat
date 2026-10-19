@echo off
rem Deletes the demo database so the next start-demo.bat creates a fresh one.
cd /d "%~dp0..\.."
if exist data\demo.db (
  del /q data\demo.db data\demo.db-wal data\demo.db-shm 2>nul
  echo Demo data deleted. Run start-demo.bat to create a fresh copy.
) else (
  echo No demo database found.
)
pause
