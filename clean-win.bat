@echo off
setlocal

cd /d "%~dp0"

echo [clean-win] Working dir: %cd%

if exist ".\node_modules" (
  echo [clean-win] Removing node_modules ...
  rmdir /s /q ".\node_modules"
)

if exist ".\dist" (
  echo [clean-win] Removing dist ...
  rmdir /s /q ".\dist"
)

if exist ".\vscode-extension\dist" (
  echo [clean-win] Removing vscode-extension\dist ...
  rmdir /s /q ".\vscode-extension\dist"
)

if exist ".\vscode-extension\node_modules" (
  echo [clean-win] Removing vscode-extension\node_modules ...
  rmdir /s /q ".\vscode-extension\node_modules"
)

if exist ".\.tools\vsce-packager\node_modules" (
  echo [clean-win] Removing .tools\vsce-packager\node_modules ...
  rmdir /s /q ".\.tools\vsce-packager\node_modules"
)

echo [clean-win] DONE.
exit /b 0
