@echo off
cd /d "%~dp0"
set PORT=8000
echo Cotton Risk Management local server
echo Open: http://localhost:%PORT%
start "" http://localhost:%PORT%
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -m http.server %PORT%
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server %PORT%
  goto :eof
)
echo Python was not found. Install Python 3 and run this file again.
pause
