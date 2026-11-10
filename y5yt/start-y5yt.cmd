@echo off
where py >nul 2>nul
if errorlevel 1 goto use_python
py -3 -B "%~dp0server.py" %*
if errorlevel 1 pause
exit /b
:use_python
where python >nul 2>nul
if errorlevel 1 (
  echo Install Python 3.10 or newer from python.org, then run this launcher again.
  pause
  exit /b 1
)
python -B "%~dp0server.py" %*
if errorlevel 1 pause
