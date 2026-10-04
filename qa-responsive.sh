#!/bin/bash
cd /home/z/my-project || exit 1
W="$1"; H="$2"
agent-browser set viewport "$W" "$H" >/dev/null 2>&1
sleep 1
for label in "NOC Dashboard" "Site Management" "Fuel Monitoring" "Alarm Management" "Analytics" "Fuel Forecast" "Consumption Patterns" "Audit Log" "User Management"; do
  # On mobile, open the hamburger nav first
  snap=$(agent-browser snapshot -i -c 2>&1)
  if echo "$snap" | grep -q 'button "Open navigation"'; then
    navbtn=$(echo "$snap" | grep 'button "Open navigation"' | head -1 | sed -n 's/.*\[ref=e\([0-9]*\)\].*/\1/p')
    [ -n "$navbtn" ] && agent-browser click "@e${navbtn}" >/dev/null 2>&1
    sleep 0.5
    snap=$(agent-browser snapshot -i -c 2>&1)
  fi
  line=$(printf '%s' "$snap" | grep "button" | grep -F -- "$label" | head -1)
  num=$(echo "$line" | sed -n 's/.*\[ref=e\([0-9]*\)\].*/\1/p')
  if [ -z "$num" ]; then
    echo "NOTFOUND $label"
    continue
  fi
  agent-browser click "@e${num}" >/dev/null 2>&1
  agent-browser wait --load networkidle >/dev/null 2>&1
  sleep 1
  overflow=$(agent-browser eval "document.documentElement.scrollWidth - window.innerWidth" 2>&1 | tail -1)
  errcount=$(agent-browser errors 2>&1 | grep -c "Error" 2>/dev/null || echo 0)
  echo "${W}x${H} $label | overflow=${overflow}px errors=${errcount}"
done
