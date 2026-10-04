#!/bin/bash
# Dev server watchdog — auto-restarts `next dev` if it gets OOM-killed.
# The FGMP dashboard's / route is memory-heavy to compile (~1.7GB RSS spike)
# and the 3.9GB sandbox can OOM-kill next-server when under pressure.
# This loop ensures the server always comes back within a few seconds.

PROJECT_DIR="/home/z/my-project"
LOG_FILE="$PROJECT_DIR/dev.log"
PID_FILE="$PROJECT_DIR/.zscripts/dev.pid"
HEAP_LIMIT=1400  # MB — leave room for mini-services + platform agent

cd "$PROJECT_DIR"

while true; do
  # Kill any existing next dev process to avoid duplicates
  pkill -f "next dev -p 3000" 2>/dev/null
  pkill -f "next-server" 2>/dev/null
  sleep 2

  echo "[watchdog $(date '+%H:%M:%S')] Starting next dev (heap=${HEAP_LIMIT}MB)..." >> "$LOG_FILE"

  # Start next dev directly (no tee pipeline — it breaks detachment)
  env NODE_OPTIONS=--max-old-space-size=$HEAP_LIMIT \
    ./node_modules/.bin/next dev -p 3000 \
    >> "$LOG_FILE" 2>&1 &
  DEV_PID=$!
  echo "$DEV_PID" > "$PID_FILE"

  # Wait for the process to exit (it will be killed by OOM or signal)
  wait "$DEV_PID" 2>/dev/null
  EXIT_CODE=$?
  echo "[watchdog $(date '+%H:%M:%S')] next dev exited (code=$EXIT_CODE), restarting in 3s..." >> "$LOG_FILE"

  sleep 3
done
