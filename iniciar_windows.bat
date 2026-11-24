@echo off
chcp 65001 >nul
title OptiRoute
cd /d "%~dp0"
echo ==============================================
echo   OptiRoute - Optimizacion de rutas y logistica
echo ==============================================
set PY=
where py >nul 2>nul && set PY=py
if not defined PY (where python >nul 2>nul && set PY=python)
if not defined PY (
  echo.
  echo No se encontro Python en esta computadora.
  echo Instalalo desde https://www.python.org/downloads/
  echo y marca la casilla "Add python.exe to PATH".
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  echo Preparando el entorno por primera vez, espera un momento...
  %PY% -m venv .venv
  ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)
echo.
echo Abriendo OptiRoute en http://127.0.0.1:5000
echo Para cerrar la aplicacion, cierra esta ventana.
start "" http://127.0.0.1:5000
".venv\Scripts\python.exe" app.py
pause
