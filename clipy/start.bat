@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run setup.bat first.
  pause
  exit /b 1
)
set CLIPY_PORT=8500
set CLIPY_HOST=0.0.0.0
if not "%1"=="" set CLIPY_PORT=%1
set PYTHONUTF8=1
echo Starting Clipy on http://localhost:%CLIPY_PORT%/clipy/
start "" "http://localhost:%CLIPY_PORT%/clipy/"
cd backend
"..\.venv\Scripts\python.exe" -m uvicorn app.main:app --host %CLIPY_HOST% --port %CLIPY_PORT% --log-level info
pause
