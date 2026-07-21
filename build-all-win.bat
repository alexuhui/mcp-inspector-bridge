@echo off
setlocal EnableExtensions

cd /d "%~dp0"

call "%~dp0build-win.bat"
if errorlevel 1 goto :fail

if not exist ".\vscode-extension\package.json" (
  echo [build-all-win] WARN: vscode-extension not found, skip.
  echo [build-all-win] SUCCESS ^(core only^).
  exit /b 0
)

REM Same Node resolution as build-win.bat.
set "NODE_HOME=E:\NodeJS\node-v24.17.0-win-x64"
if exist "%NODE_HOME%\node.exe" (
  set "PATH=%NODE_HOME%;%PATH%"
  set "NODE_BIN=%NODE_HOME%\node.exe"
) else (
  set "NODE_BIN=node"
  for /f "delims=" %%I in ('where node 2^>nul') do (
    set "NODE_HOME=%%~dpI"
    goto :after_where_node
  )
)
:after_where_node

set "NPM_CLI="
if defined NODE_HOME if exist "%NODE_HOME%\node_modules\npm\bin\npm-cli.js" (
  if exist "%NODE_HOME%\node_modules\npm\node_modules\semver" (
    set "NPM_CLI=%NODE_HOME%\node_modules\npm\bin\npm-cli.js"
  )
)
if not defined NPM_CLI if exist "E:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" (
  set "NPM_CLI=E:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"
)

pushd ".\vscode-extension"
echo [build-all-win] Building vscode-extension...
echo [build-all-win] Node bin: %NODE_BIN%
"%NODE_BIN%" -v

if defined NPM_CLI (
  "%NODE_BIN%" "%NPM_CLI%" install
) else (
  call npm install
)
if errorlevel 1 (
  popd
  goto :fail
)

"%NODE_BIN%" .\node_modules\typescript\bin\tsc -p .
if errorlevel 1 (
  popd
  goto :fail
)
popd

echo [build-all-win] SUCCESS.
exit /b 0

:fail
echo [build-all-win] FAILED.
exit /b 1
