#!/usr/bin/env python3
"""Scope an asset [id] route's CRUD calls to the caller's tenant.

Phase 3. The five assets/*/[id] routes plus tanks/[id] share one shape:

    const existing = await db.<model>.findUnique({ where: { id }, ... })
    const updated  = await db.<model>.update({ where: { id }, ... })
    await db.<model>.delete({ where: { id } })

Three constraints, each of which has already bitten an agent in this phase:

  1. findUnique/update take a UNIQUE selector, so tenantId cannot be added to
     the where clause. Tenant scoping comes from asTenant's context instead.
     None of these models has a tenantId column of their own anyway - they all
     reach tenancy through Site - so the context is the ONLY scoping available.
  2. `delete` THROWS when the row is absent. Under RLS a foreign id is absent,
     so it produced a 500 that distinguishes a foreign id from a nonexistent
     one. Replaced with deleteMany, which matches zero rows.
  3. Nested `include:` relations are themselves RLS-protected, so they must sit
     inside the same transaction as the top-level call.

This is a look-here transform. Run tsc and read the diff afterwards.

Usage: scope-asset-id.py <file> [userVar]
"""
import re
import sys
import pathlib


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    path = pathlib.Path(sys.argv[1])
    user = sys.argv[2] if len(sys.argv) > 2 else "me"
    src = path.read_text()
    before = src

    # 1. imports
    src = re.sub(
        r'^import \{ db, (\w+) \} from "@/lib/fgmp";$',
        r'import { \1 } from "@/lib/fgmp";\nimport { asTenant } from "@/lib/fgmp/route-tenant";',
        src, count=1, flags=re.M,
    )

    # 2. findUnique -> asTenant(findFirst(...))
    src = re.sub(
        r'await db\.([a-z][A-Za-z]*)\.findUnique\(\{\s*\n(\s*)where: \{ id \},',
        lambda m: (
            f"await asTenant({user}, (tx) =>\n"
            f"{m.group(2)}tx.{m.group(1)}.findFirst({{\n{m.group(2)}  where: {{ id }},"
        ),
        src,
    )

    # 3. update -> asTenant(update(...))
    src = re.sub(
        r'const (\w+) = await db\.([a-z][A-Za-z]*)\.update\(\{\s*\n(\s*)where: \{ id \},',
        lambda m: (
            f"// `update` takes a unique selector, so tenantId cannot be part of the\n"
            f"// where clause; the `existing` guard above already asserted ownership and\n"
            f"// the nested include of site is itself RLS-protected, so it belongs here.\n"
            f"    const {m.group(1)} = await asTenant({user}, (tx) =>\n"
            f"{m.group(3)}tx.{m.group(2)}.update({{\n{m.group(3)}  where: {{ id }},"
        ),
        src,
    )

    # 4. delete -> asTenant(deleteMany(...))
    src = re.sub(
        r'await db\.([a-z][A-Za-z]*)\.delete\(\{ where: \{ id \} \}\);',
        lambda m: (
            f"await asTenant({user}, (tx) =>\n"
            f"      // deleteMany, not delete: `delete` THROWS when the row is absent, so a\n"
            f"      // cross-tenant id would 500 and distinguish itself from a missing one.\n"
            f"      tx.{m.group(1)}.deleteMany({{ where: {{ id }} }}),\n    );"
        ),
        src,
    )

    if src == before:
        print(f"{path}: no change")
        return 0

    # 5. close the arrows we opened. Only lines that start a `tx.<model>.` call
    #    are eligible, so a plain `audit({ ... })` call is never captured.
    lines = src.split("\n")
    out: list[str] = []
    i = 0
    closed = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        if "await asTenant(" in line and "=>" in line:
            indent = " " * (len(line) - len(line.lstrip()))
            j = i + 1
            while j < len(lines):
                stripped = lines[j].strip()
                if stripped.startswith("});") or stripped.startswith("})"):
                    body = lines[j - 1].strip() if j > i else ""
                    # Close only when the call actually being wrapped is the tx call.
                    if "tx." in body or stripped == "});":
                        out.append(indent + "  }),")
                        out.append(indent + ");")
                        closed += 1
                        i = j + 1
                        break
                out.append(lines[j])
                j += 1
            else:
                i = j
            continue
        i += 1

    path.write_text("\n".join(out))
    print(f"{path}: {closed} arrow(s) closed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())