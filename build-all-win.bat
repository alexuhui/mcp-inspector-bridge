@echo off
setlocal

cd /d "%~dp0"

call "%~dp0build-win.bat"
if errorlevel 1 goto :fail

if not exist ".\vscode-extension\package.json" (
  echo [build-all-win] WARN: vscode-extension not found, skip.
  echo [build-all-win] SUCCESS ^(core only^).
  exit /b 0
)

set "VS_NODE=C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Microsoft\VisualStudio\NodeJs\node.exe"
set "NPM_CLI=E:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"
if exist "%VS_NODE%" (
  set "NODE_BIN=%VS_NODE%"
) else (
  set "NODE_BIN=node"
)

pushd ".\vscode-extension"
echo [build-all-win] Building vscode-extension...

if exist "%NPM_CLI%" (
  "%NODE_BIN%" "%NPM_CLI%" install
) else (
  npm install
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
