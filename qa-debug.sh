#!/bin/bash
cd /home/z/my-project
snap=$(agent-browser snapshot -i -c 2>&1)
echo "snap length: ${#snap}"
echo "grep button count: $(echo "$snap" | grep -c 'button')"
line=$(echo "$snap" | grep "button" | grep -F -- "Site Management" | head -1)
echo "matched line: [$line]"
ref=$(echo "$line" | grep -oE '@e[0-9]+' | head -1)
echo "ref: [$ref]"
