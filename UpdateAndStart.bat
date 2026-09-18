@echo off
REM ============================================================
REM  YetAnotherOverengineeredStoatBot - Update And Start
REM  Pulls the latest code, reinstalls dependencies, then runs.
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

REM --- git pull --------------------------------------------------
where git >nul 2>nul
if %ERRORLEVEL%==0 (
    if exist ".git" (
        echo [Update] Pulling latest changes...
        call git pull --ff-only
        if errorlevel 1 (
            echo [Update] git pull failed - continuing with the local copy.
        )
    ) else (
        echo [Update] Not a git checkout - skipping pull.
    )
) else (
    echo [Update] git not found on PATH - skipping pull.
)

REM --- install dependencies -------------------------------------
echo [Update] Installing dependencies with %RUNNER%...
call %RUNNER% install
if errorlevel 1 goto :fail

REM --- start ----------------------------------------------------
echo [Update] Launching bot with %RUNNER%...
call %RUNNER% start
if errorlevel 1 goto :fail

echo.
echo [Update] Bot stopped.
pause
exit /b 0

:fail
echo.
echo [Update] Something went wrong (exit code %ERRORLEVEL%).
pause
exit /b 1
