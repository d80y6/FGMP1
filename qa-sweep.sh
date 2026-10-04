#!/bin/bash
cd /home/z/my-project || exit 1
for label in "$@"; do
  snap=$(agent-browser snapshot -i -c 2>&1)
  line=$(printf '%s' "$snap" | grep "button" | grep -F -- "$label" | head -1)
  num=$(printf '%s' "$line" | grep -oE 'ref=e[0-9]+' | grep -oE '[0-9]+')
  ref="@e${num}"
  if [ -z "$num" ]; then
    echo "NOTFOUND $label"
    continue
  fi
  agent-browser click "$ref" >/dev/null 2>&1
  agent-browser wait --load networkidle >/dev/null 2>&1
  sleep 1
  overflow=$(agent-browser eval "document.documentElement.scrollWidth - window.innerWidth" 2>&1 | tail -1)
  errcount=$(agent-browser errors 2>&1 | grep -c "Error" 2>/dev/null || echo 0)
  h1=$(agent-browser snapshot -i -c 2>&1 | grep "heading" | grep "level=1" | head -1 | sed 's/.*heading "//; s/".*//')
  echo "OK $label | overflow=${overflow}px errors=${errcount} h1=${h1}"
done
