@echo off
REM ============================================================
REM  YetAnotherOverengineeredStoatBot - Start
REM  Launches the bot without touching git or reinstalling deps.
REM ============================================================
setlocal
cd /d "%~dp0"

REM Pick a package manager: prefer bun (bun.lock is the committed
REM lockfile), fall back to npm if bun is not on PATH.
where bun >nul 2>nul
if %ERRORLEVEL%==0 (
    set "RUNNER=bun"
) else (
    set "RUNNER=npm"
)

REM First run convenience: install deps if node_modules is missing.
if not exist "node_modules" (
    echo [Start] node_modules not found - installing dependencies with %RUNNER%...
    call %RUNNER% install
    if errorlevel 1 goto :fail
)

echo [Start] Launching bot with %RUNNER%...
call %RUNNER% start
if errorlevel 1 goto :fail

echo.
echo [Start] Bot stopped.
pause
exit /b 0

:fail
echo.
echo [Start] Something went wrong (exit code %ERRORLEVEL%).
pause
exit /b 1
