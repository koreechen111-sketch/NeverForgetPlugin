: << 'CMDBLOCK'
@echo off
REM ======================================================================
REM LCM Cross-Platform Hook Runner (Polyglot Script)
REM Windows: cmd.exe executes this batch section
REM Unix/Linux/macOS: shell ignores this section, runs bash code below
REM Usage: run-hook <hook-name>
REM ======================================================================

if "%~1"=="" (
    echo run-hook: missing hook-name >&2
    exit /b 1
)

set "HOOK_DIR=%~dp0"

REM Auto-detect Git Bash on Windows (standard install paths)
if exist "C:\Program Files\Git\bin\bash.exe" (
    "C:\Program Files\Git\bin\bash.exe" "%HOOK_DIR%run-hook" %*
    exit /b %ERRORLEVEL%
)
if exist "C:\Program Files (x86)\Git\bin\bash.exe" (
    "C:\Program Files (x86)\Git\bin\bash.exe" "%HOOK_DIR%run-hook" %*
    exit /b %ERRORLEVEL%
)

REM Use bash from system PATH if available
where bash >nul 2>nul
if %ERRORLEVEL% equ 0 (
    bash "%HOOK_DIR%run-hook" %*
    exit /b %ERRORLEVEL%
)

REM Silent exit if no bash found (do not block Claude Code)
exit /b 0
CMDBLOCK

#!/usr/bin/env bash
# ======================================================================
# Unix/Linux/macOS Hook Runner (Core Logic)
# ======================================================================
set -euo pipefail

# Get core directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${PLUGIN_ROOT}/dist/hook-handlers"

# Validate hook name parameter
HOOK_NAME="${1:-}"
if [ -z "$HOOK_NAME" ]; then
  echo "Usage: run-hook <hook-name>" >&2
  exit 1
fi

# Target compiled JS handler
HOOK_SCRIPT="${DIST_DIR}/${HOOK_NAME}.js"

# Silent exit if plugin is not built (JS file missing)
if [ ! -f "$HOOK_SCRIPT" ]; then
  exit 0
fi

# Set database path from environment variable
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
  export LCM_DB_PATH="${CLAUDE_PLUGIN_DATA}/lcm.db"
fi

# Execute the Node.js hook handler
exec node "${HOOK_SCRIPT}"