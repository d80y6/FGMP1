#!/bin/bash
# Properly daemonize the Next.js dev server using a double-fork pattern.
# This ensures the process survives the parent Bash tool shell exiting.
#
# Usage: .zscripts/start-dev-daemon.sh

PROJECT_DIR="/home/z/my-project"
LOG_FILE="$PROJECT_DIR/dev.log"
HEAP=1400

cd "$PROJECT_DIR"

# Kill any existing instance
pkill -f "next dev -p 3000" 2>/dev/null
pkill -f "next-server" 2>/dev/null
sleep 2

# Double-fork daemon pattern:
# 1. Parent forks child and exits immediately
# 2. Child becomes session leader (setsid), forks grandchild, exits
# 3. Grandchild is the daemon — fully detached, no controlling terminal,
#    no inherited FDs that could deliver SIGHUP/SIGPIPE when the
#    original shell exits.
#
# We use a subshell + setsid + exec to achieve this portably.

setsid bash -c "
  # This runs in a new session (no controlling terminal)
  # Fork again via subshell so the setsid leader can exit
  (
    exec env NODE_OPTIONS=--max-old-space-size=$HEAP \\
      ./node_modules/.bin/next dev -p 3000 \\
      > '$LOG_FILE' 2>&1 < /dev/null
  ) &
  # Exit the setsid leader immediately; the subshell child is now orphaned
  # and reparented to PID 1 (tini), fully detached.
  exit 0
" &

# Disown the setsid process
disown 2>/dev/null

echo "Dev server daemon started. Check dev.log for output."
echo "Waiting for server to be ready..."

# Wait for server to be ready (up to 30s)
for i in $(seq 1 30); do
  if curl -s -o /dev/null --max-time 2 http://localhost:3000/ 2>/dev/null; then
    echo "Dev server is ready (took ${i}s)"
    exit 0
  fi
  sleep 1
done

echo "Dev server did not become ready in 30s. Check dev.log."
exit 1
