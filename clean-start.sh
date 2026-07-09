#!/usr/bin/env bash
# clean-start.sh — thin wrapper around start-local.sh.
# Frees ports, builds functions, boots the Firebase emulators, then runs Vite.
# Documented as the harness boot entry-point; delegates to start-local.sh so
# there is a single source of truth for the boot sequence.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/start-local.sh"
