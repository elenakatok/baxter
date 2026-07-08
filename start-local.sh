#!/usr/bin/env bash
# start-local.sh — clean + start Baxter locally for the day-2 play-through harness.
#
# Usage: games/baxter/start-local.sh
#   1. Frees Baxter's emulator + Vite ports.
#   2. Builds the Cloud Functions (tsc → lib/).
#   3. Starts the Firebase emulators in the background (log → $TMPDIR/baxter-emulators.log).
#   4. Waits until they're up, then runs the Vite dev server in the foreground.
#   Ctrl+C stops Vite and shuts the emulators down.
#
# Then, in a SECOND terminal, run the play-through from the Baxter repo root:
#   cd games/baxter && node baxter-playthrough.mjs   (HEADED=1 to watch, SLOWMO=80 to slow it down)
#   (one-time: `npm install` at games/baxter to install the declared playwright devDependency)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ports — source: firebase.json (emulators block) + Vite default 5173.
PORTS=(9101 5005 8082 9002 5006 4002 5173)

echo "Killing old servers…"; killall node 2>/dev/null || true; killall java 2>/dev/null || true; sleep 2

echo "Checking ports…"; DIRTY=false
for port in "${PORTS[@]}"; do
  pid=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pid" ]; then echo "  ⚠️  Port $port in use by PID $pid (kill -9 $pid)"; DIRTY=true; fi
done
[ "$DIRTY" = true ] && { echo "Free the ports above, then re-run."; exit 1; }
echo "Ports clear ✅"

echo "Building Cloud Functions…"
( cd "$SCRIPT_DIR/functions" && npm run build ) || { echo "❌ Functions build failed."; exit 1; }
echo "Functions built ✅"

echo "Starting Firebase emulators (log → $TMPDIR/baxter-emulators.log)…"
( cd "$SCRIPT_DIR" && firebase emulators:start ) >"$TMPDIR/baxter-emulators.log" 2>&1 &
EMULATOR_PID=$!
trap 'echo; echo "Shutting down emulators…"; kill "$EMULATOR_PID" 2>/dev/null; wait "$EMULATOR_PID" 2>/dev/null; echo Done.' EXIT

echo "Waiting for the functions emulator (port 5005)…"; WAITED=0
while ! lsof -ti :5005 >/dev/null 2>&1; do
  sleep 1; WAITED=$((WAITED+1))
  [ "$WAITED" -ge 90 ] && { echo "❌ Emulators didn't come up. cat $TMPDIR/baxter-emulators.log"; exit 1; }
done
echo "Emulators ready ✅"

echo "Starting Vite dev server on http://localhost:5173 …"
echo "  In another terminal: (cd $SCRIPT_DIR && node baxter-playthrough.mjs)"
( cd "$SCRIPT_DIR/frontend" && npm run dev )
