@echo off
setlocal EnableExtensions

cd /d "%~dp0"

REM Prefer Node.js 24 install directly (not dependent on PATH order).
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

REM Prefer npm next to selected Node; skip incomplete installs (e.g. missing semver).
set "NPM_CLI="
if defined NODE_HOME if exist "%NODE_HOME%\node_modules\npm\bin\npm-cli.js" (
  if exist "%NODE_HOME%\node_modules\npm\node_modules\semver" (
    set "NPM_CLI=%NODE_HOME%\node_modules\npm\bin\npm-cli.js"
  )
)
if not defined NPM_CLI if exist "E:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" (
  set "NPM_CLI=E:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"
)

echo [build-win] Working dir: %cd%
echo [build-win] Node bin: %NODE_BIN%
"%NODE_BIN%" -v
if errorlevel 1 goto :fail
echo [build-win] npm cli: %NPM_CLI%

if defined NPM_CLI (
  "%NODE_BIN%" "%NPM_CLI%" install
) else (
  call npm install
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
