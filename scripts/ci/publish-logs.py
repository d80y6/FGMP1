#!/usr/bin/env python3
"""Publish the tail of CI log files as a check run.

Why this exists
───────────────
The GitHub Actions *log archive* is served from
`results-receiver.actions.githubusercontent.com`, which is a different host from
the REST API and is not reachable from every environment (it is blocked outright
in some sandboxes). `gh run view --log-failed` therefore sometimes returns
nothing but `EOF`, leaving a red build with no readable cause.

The Checks API is on `api.github.com`, so a check run carrying the relevant log
tail is reachable everywhere the API itself is. This is diagnostics, not a gate:
the run is published with conclusion `neutral` so it can only add information,
never change whether the workflow passes.

Usage
─────
    python3 scripts/ci/publish-logs.py "rls diagnostics" /tmp/migrate.log ...

Requires GH_TOKEN (or GITHUB_TOKEN) with `checks: write`, and the standard
GITHUB_SHA / GITHUB_REPOSITORY variables that Actions exports.

Missing files are reported as "(not produced)", which is itself useful: it says
the step never got far enough to write its log.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

# GitHub rejects a check-run summary over 65535 characters, and truncates
# silently rather than erroring. Keep the budget well under it and give every
# file an equal share so one noisy log cannot hide the others.
MAX_SUMMARY = 60_000
PER_FILE = 20_000


def tail(path: str, limit: int = PER_FILE) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            data = fh.read()
    except FileNotFoundError:
        return "(not produced)"
    except OSError as exc:  # permission, is-a-directory, …
        return f"(unreadable: {exc})"
    if len(data) <= limit:
        return data
    # Trim from the front: the end of a failed build is where the error is.
    return f"… {len(data) - limit} bytes elided …\n" + data[-limit:]


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: publish-logs.py <check-name> <logfile>…", file=sys.stderr)
        return 2

    name, files = argv[1], argv[2:]
    sections = []
    for path in files:
        sections.append(f"## {path}\n\n```\n{tail(path)}\n```\n")
    summary = "\n".join(sections)[:MAX_SUMMARY]

    sha = os.environ.get("GITHUB_SHA")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not sha or not repo:
        print("GITHUB_SHA / GITHUB_REPOSITORY are not set", file=sys.stderr)
        return 1

    body = {
        "name": name,
        "head_sha": sha,
        "status": "completed",
        "conclusion": "neutral",
        "output": {"title": name, "summary": summary},
    }

    result = subprocess.run(
        ["gh", "api", f"repos/{repo}/check-runs", "--input", "-"],
        input=json.dumps(body).encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        print(
            "could not publish the check run: "
            + result.stderr.decode(errors="replace")[:2000],
            file=sys.stderr,
        )
        return result.returncode
    print(f"published check run: {name} ({len(summary)} chars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
