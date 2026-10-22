#!/bin/bash
# Daemonize the FGMP mini-services (iot-bridge only) using double-fork.
# Same detachment pattern as start-dev-daemon.sh so they survive across
# Bash tool invocations.
#
# The realtime mini-service was retired in the Apinator migration: realtime
# is now a hosted service (browser → Apinator directly, server → Apinator
# REST), so there is nothing local to daemonize any more.

PROJECT_DIR="/home/z/my-project"
IOT_LOG="$PROJECT_DIR/.zscripts/mini-service-iot-bridge.log"

# Kill existing instances
pkill -f "bun --hot index.ts" 2>/dev/null
sleep 2

start_service() {
  local svc_dir="$1"
  local log_file="$2"
  local svc_name="$3"

  cd "$svc_dir"

  setsid bash -c "
    (
      exec bun --hot index.ts > '$log_file' 2>&1 < /dev/null
    ) &
    exit 0
  " &

  disown 2>/dev/null
  echo "Started $svc_name"
}

start_service "$PROJECT_DIR/mini-services/iot-bridge" "$IOT_LOG" "iot-bridge"

echo "Waiting for services to start..."
sleep 6

echo "=== Service status ==="
ps aux | grep "bun --hot" | grep -v grep | wc -l
echo "bun --hot processes running"
curl -s -o /dev/null -w "Dev server (3000): HTTP %{http_code}\n" --max-time 10 http://localhost:3000/ 2>/dev/null
