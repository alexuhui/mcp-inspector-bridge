@echo off
setlocal

cd /d "%~dp0"

set "VS_NODE=C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Microsoft\VisualStudio\NodeJs\node.exe"
set "NPM_CLI=E:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"

if exist "%VS_NODE%" (
  set "NODE_BIN=%VS_NODE%"
) else (
  set "NODE_BIN=node"
)

echo [build-win] Working dir: %cd%
echo [build-win] Node bin: %NODE_BIN%
echo [build-win] npm cli: %NPM_CLI%

if exist "%NPM_CLI%" (
  "%NODE_BIN%" "%NPM_CLI%" install
) else (
  npm install
)
if errorlevel 1 goto :fail

"%NODE_BIN%" .\node_modules\typescript\bin\tsc
if errorlevel 1 goto :fail

if exist ".\node_modules\@esbuild\win32-ia32\esbuild.exe" (
  set "ESBUILD_BIN=.\node_modules\@esbuild\win32-ia32\esbuild.exe"
) else if exist ".\node_modules\@esbuild\win32-x64\esbuild.exe" (
  set "ESBUILD_BIN=.\node_modules\@esbuild\win32-x64\esbuild.exe"
) else (
  set "ESBUILD_BIN="
)

if "%ESBUILD_BIN%"=="" (
  echo [build-win] ERROR: esbuild binary not found. Please run npm install again.
  goto :fail
)

echo [build-win] esbuild: %ESBUILD_BIN%

"%ESBUILD_BIN%" src/probe/index.ts --bundle --outfile=dist/probe.js
if errorlevel 1 goto :fail

"%ESBUILD_BIN%" src/mcp-client/index.ts --bundle --platform=node --outfile=dist/mcp-client/index.js
if errorlevel 1 goto :fail

echo [build-win] SUCCESS.
exit /b 0

:fail
echo [build-win] FAILED.
exit /b 1
