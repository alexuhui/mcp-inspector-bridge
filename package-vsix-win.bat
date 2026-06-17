@echo off
setlocal

cd /d "%~dp0"

echo [package-vsix-win] Step 1/2: build extension...
call "%~dp0build-all-win.bat"
if errorlevel 1 goto :fail

if not exist ".\vscode-extension\package.json" (
  echo [package-vsix-win] ERROR: vscode-extension not found.
  goto :fail
)

set "VS_NODE=C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Microsoft\VisualStudio\NodeJs\node.exe"
set "NPM_CLI=E:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"
if exist "%VS_NODE%" (
  set "NODE_BIN=%VS_NODE%"
) else (
  set "NODE_BIN=node"
)

for %%I in ("%NODE_BIN%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"

set "VSCE_TOOL=%~dp0.tools\vsce-packager"
set "VSCE_BIN=%VSCE_TOOL%\node_modules\vsce\vsce"

echo [package-vsix-win] Ensuring isolated vsce tool ^(Node 16 compatible^)...
pushd "%VSCE_TOOL%"
if exist "%NPM_CLI%" (
  "%NODE_BIN%" "%NPM_CLI%" install --scripts-prepend-node-path=true
) else (
  npm install --scripts-prepend-node-path=true
)
if errorlevel 1 (
  popd
  goto :fail
)
popd

if not exist "%VSCE_BIN%" (
  echo [package-vsix-win] ERROR: vsce not found at %VSCE_BIN%
  goto :fail
)

pushd ".\vscode-extension"
echo [package-vsix-win] Step 2/2: packaging VSIX...
echo [package-vsix-win] Node: %NODE_BIN%
"%NODE_BIN%" -p "process.version + ' arch=' + process.arch"
"%NODE_BIN%" "%VSCE_BIN%" package --allow-missing-repository --no-yarn
if errorlevel 1 (
  popd
  goto :fail
)

echo.
echo [package-vsix-win] SUCCESS. VSIX files:
dir /b *.vsix 2>nul
popd
exit /b 0

:fail
echo [package-vsix-win] FAILED.
exit /b 1
