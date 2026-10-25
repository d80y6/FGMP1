/**
 * Guards for defects that only appear when rendered text is treated as data.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * D-16: the geography view decided whether a region could be deleted with
 *
 *     const hasSites = target.countLabel.includes("sites")
 *                   && !target.countLabel.includes("0 sites");
 *
 * `"10 sites".includes("0 sites")` is **true**, so a governorate holding ten
 * sites was classified as empty: the "still has sites" warning was hidden and
 * the delete button — whose `disabled` is exactly `hasSites` — was enabled. The
 * delete cascades to districts and sites, so the operator could remove ten
 * sites and their history from a dialog that said nothing about them. The same
 * expression would also have failed the moment `countLabel` was translated,
 * because the Arabic label contains neither "sites" nor "0 sites".
 *
 * The class of bug is "decide behaviour by parsing a string that exists to be
 * READ". These tests hold the two halves of the fix:
 *
 *   1. the delete guard is a numeric comparison on a number the caller supplies
 *   2. the substring patterns that made it wrong are not reintroduced
 *
 * Run: bun test src/lib/fgmp/__tests__/rendered-text-as-data.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const GEOGRAPHY = "src/components/fgmp/views/geography-view.tsx";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Strip comments, keep newlines. The geography view documents the old
 * expression in a comment; a guard that cannot tell code from the note
 * explaining why the code changed would forbid explaining it.
 */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (_m, p) => p ?? "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (["node_modules", ".next"].includes(entry)) continue;
      walk(path, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

describe("D-16 · the geography delete guard reads a number, not a label", () => {
  test("the guard compares siteCount, and does not parse countLabel", () => {
    const view = code(GEOGRAPHY);
    expect(view).toContain("const hasSites = (target?.siteCount ?? 0) > 0;");
    // The exact expression that shipped, in any spacing.
    expect(/countLabel\.includes\(\s*["']0\s/.test(view)).toBe(false);
    expect(/countLabel\.includes\(\s*["']sites["']\s*\)/.test(view)).toBe(false);
  });

  test("every delete target is constructed with a numeric siteCount", () => {
    const view = code(GEOGRAPHY);
    const targets = view.match(/setDeleteTarget\(\{/g) ?? [];
    expect(targets.length, "the three delete targets (region, governorate, district)").toBe(3);
    const counts = view.match(/siteCount:\s*(r|g|d)\._count\.sites/g) ?? [];
    expect(counts.length, "each target must carry siteCount from _count.sites").toBe(3);
  });

  test('"10 sites" really does contain "0 sites" — the bug was real', () => {
    // Documents the substring behaviour that made this a data-loss path, so a
    // future reader does not dismiss the guard as paranoia.
    expect("10 sites".includes("0 sites")).toBe(true);
    expect("3 districts · 10 sites".includes("0 sites")).toBe(true);
    // …and the parse that replaced it gets the same row right:
    expect(10 > 0).toBe(true);
  });
});

describe("rendered strings are not used as logic", () => {
  test("no component decides behaviour by substring-matching a rendered count", () => {
    // `countLabel`, `*Label`, `*Text` and `*.description` exist to be displayed.
    // Reading them back to decide whether an action is allowed is how D-16
    // happened; the fix is always to carry the underlying value.
    const offenders: string[] = [];
    for (const file of walk("src/components")) {
      const text = code(file);
      for (const match of text.matchAll(/\b(count|total|sum)Label\s*\.\s*includes\s*\(/g)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
