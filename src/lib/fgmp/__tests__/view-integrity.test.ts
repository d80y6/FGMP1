/**
 * Integrity rules for the 27 views that no axe rule can express.
 *
 * WHY. Accessibility rules describe markup: a name, a role, a ratio, a focus
 * order. They say nothing about whether a screen tells the operator the truth
 * about its own contents. Two failures of that kind were found by reading the
 * views (D-21), and both are mechanical enough to guard:
 *
 *   1. A list silently capped at N rows. `filtered.slice(0, 100)` on a tenant
 *      with 140 sites makes row 100 look exactly like the last row there is, so
 *      filtering for a site that sorts past the cap returns "no results" for a
 *      site that exists. A rendering decision producing a data-integrity
 *      impression is the kind of defect that survives every green build.
 *
 *   2. A primary list with no zero-row state: an empty container under a
 *      heading reading "(0)" is indistinguishable from a failed load, and on a
 *      freshly provisioned tenant that is the first screen anyone sees.
 *
 * The first is enforceably mechanical: if a view caps a list at 20 or more
 * rows, it must render `TruncationNote` so the cap is stated. Small caps
 * (top-5, top-8) are deliberate summaries with their own headings and are not
 * the same thing.
 *
 * Run: bun test src/lib/fgmp/__tests__/view-integrity.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const VIEWS = join(ROOT, "src", "components", "fgmp", "views");

/** Caps at or above this are "the table", not a highlighted top-N summary. */
const CAP_THRESHOLD = 20;

interface Cap {
  file: string;
  line: number;
  shown: number;
}

function cappedLists(): Cap[] {
  const caps: Cap[] = [];
  for (const entry of readdirSync(VIEWS)) {
    if (!entry.endsWith(".tsx") || entry.endsWith(".test.tsx")) continue;
    const path = join(VIEWS, entry);
    const source = readFileSync(path, "utf8");
    for (const m of source.matchAll(/\.slice\(0,\s*(\d+)\)\.map/g)) {
      const shown = Number(m[1]);
      if (shown < CAP_THRESHOLD) continue;
      caps.push({
        file: relative(ROOT, path),
        line: source.slice(0, m.index).split("\n").length,
        shown,
      });
    }
  }
  return caps;
}

describe("view integrity", () => {
  test("every capped list states that it is capped", () => {
    const offenders: string[] = [];
    for (const cap of cappedLists()) {
      const source = readFileSync(join(ROOT, cap.file), "utf8");
      if (!source.includes("TruncationNote")) {
        offenders.push(`${cap.file}:${cap.line} caps at ${cap.shown} rows without saying so`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a capped list must render <TruncationNote> — an operator cannot tell row 100 from the last row",
    );
  });

  test("the scan actually finds the caps it is guarding", () => {
    // A guard that silently matches nothing passes forever. There are ~10
    // capped lists across the views; require enough of them to prove the scan
    // is reading the tree, not a stale path.
    const caps = cappedLists();
    assert.ok(caps.length >= 8, `expected the view caps, found ${caps.length}`);
  });

  test("no view renders an untranslated shell", () => {
    // Every view is reachable in Arabic. A view file that never calls the
    // translate hook ships English inside an RTL layout; the i18n guard covers
    // text nodes, this catches the file that forgot the hook entirely.
    const offenders: string[] = [];
    for (const entry of readdirSync(VIEWS)) {
      if (!entry.endsWith(".tsx") || entry.endsWith(".test.tsx")) continue;
      const source = readFileSync(join(VIEWS, entry), "utf8");
      if (!source.includes("useT(")) offenders.push(entry);
    }
    assert.deepEqual(offenders, [], "view files that never translate");
  });
});
