/**
 * The RTL layout, enforced instead of remembered.
 *
 * WHY. `<html dir="rtl">` mirrors the page: flex rows reverse, table columns
 * swap edges, `text-right` becomes the *start* side and `margin-left` stays
 * physical. A left-authored class therefore does two different things in the
 * two languages. Before this guard the tree contained **zero** logical
 * utilities and ~400 physical ones, so the Arabic layout was not "the LTR
 * layout mirrored" — it was the LTR spacing left in place while everything
 * moved around it: icon gaps landing on the outside of a row, table headers
 * aligned to the wrong edge, a sticky first column pinned to the physical left
 * while the columns it belongs to started on the right.
 *
 * None of that is visible to axe, to the overflow check or to any green build,
 * which is why it needs a guard and not a note.
 *
 * WHAT IS ENFORCED
 *   1. No physical inline-axis utility in `src/** /*.tsx` — spacing, text
 *      alignment, side borders and corner radii must use the logical form
 *      (`ms`/`me`/`ps`/`pe`, `text-start`/`text-end`, `border-s`/`border-e`,
 *      `rounded-ss` …). In LTR the logical form compiles to exactly the same
 *      box, so this cannot regress English.
 *   2. No `sticky left-0` / `sticky right-0`: a pinned column is pinned to an
 *      inline edge, which is the whole point of pinning it.
 *   3. The two time-axis grids must keep their `dir="ltr"` pin. A Gantt and a
 *      24-hour heatmap are time, and time runs left-to-right in every locale;
 *      they are built from physical offsets (`style={{ left }}`, ticks at
 *      `-translate-x-1/2`, `sticky left-0`), so inside an Arabic page the
 *      inherited RTL reverses the flex row while the absolute positions stay
 *      where they were — the axis and its labels then disagree. The pin is the
 *      thing that keeps them in agreement, and removing it looks like tidying
 *      up.
 *
 * WHY THE ALLOWANCES ARE ALLOWANCES. Two places are physical on purpose:
 *   - `ui/sheet.tsx` is a drawer anchored to a physical edge with physical
 *     slide animations (`slide-out-to-right`); converting the anchor without
 *     converting the animations would make it slide in from the wrong side.
 *   - Decorative glows (`-left-12`, `-right-6`) and centring (`left-[50%]`,
 *     `left-1/2` with `-translate-x-1/2`) are outside the inline axis: they
 *     are positioned decorations, not content order.
 *
 * Run: bun test src/lib/fgmp/__tests__/rtl-logical-classes.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

/** Physical → logical. Kept explicit so a reader can audit the mapping. */
const PHYSICAL: { pattern: RegExp; logical: string; what: string }[] = [
  { pattern: /(?<![\w-])-?pl-[\w[]/g, logical: "ps-", what: "padding-inline-start" },
  { pattern: /(?<![\w-])-?pr-[\w[]/g, logical: "pe-", what: "padding-inline-end" },
  { pattern: /(?<![\w-])-?ml-[\w[]/g, logical: "ms-", what: "margin-inline-start" },
  { pattern: /(?<![\w-])-?mr-[\w[]/g, logical: "me-", what: "margin-inline-end" },
  { pattern: /(?<![\w-])text-left(?![\w-])/g, logical: "text-start", what: "text-align start" },
  { pattern: /(?<![\w-])text-right(?![\w-])/g, logical: "text-end", what: "text-align end" },
  { pattern: /(?<![\w-])border-l(?![\w-])/g, logical: "border-s", what: "border inline-start" },
  { pattern: /(?<![\w-])border-r(?![\w-])/g, logical: "border-e", what: "border inline-end" },
  {
    pattern: /(?<![\w-])rounded-(?:l|r|tl|tr|bl|br)(?![\w-])/g,
    logical: "rounded-s/e/ss/se/es/ee",
    what: "corner radius",
  },
];

/** Physical on purpose — see the header. */
const ALLOW_PHYSICAL = new Set(["src/components/ui/sheet.tsx"]);

/** Time axes: pinned to LTR, so physical offsets inside them are correct. */
const TIME_AXES = [
  "src/components/fgmp/maintenance-gantt.tsx",
  "src/components/fgmp/alarm-severity-heatmap.tsx",
];

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, acc);
    else if (entry.name.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/** Comments explain the old names and must not be policed as classes. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

describe("RTL · the layout is written in logical direction", () => {
  test("no physical inline-axis utility in src/**/*.tsx", () => {
    const violations: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const rel = relative(process.cwd(), file).split("\\").join("/");
      if (ALLOW_PHYSICAL.has(rel)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      for (const { pattern, logical, what } of PHYSICAL) {
        pattern.lastIndex = 0;
        for (const m of source.matchAll(pattern)) {
          const at = m.index ?? 0;
          violations.push(`${rel}:${lineOf(source, at)}  "${m[0]}" (${what}) → use ${logical}`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Physical direction classes do not mirror when <html dir> flips to rtl:\n  ${violations.join("\n  ")}`,
    );
  });

  test("a pinned column is pinned to an inline edge, not to the physical left", () => {
    const violations: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const rel = relative(process.cwd(), file).split("\\").join("/");
      if (TIME_AXES.includes(rel)) continue; // pinned LTR on purpose, checked below
      const source = stripComments(readFileSync(file, "utf8"));
      for (const m of source.matchAll(/sticky\s+(?:-?(?:left|right)-[\w[])/g)) {
        violations.push(`${rel}:${lineOf(source, m.index ?? 0)}  "${m[0]}" → sticky start-0 / end-0`);
      }
    }
    assert.deepEqual(violations, [], `Sticky columns must follow the inline axis:\n  ${violations.join("\n  ")}`);
  });

  test("the time-axis grids keep their dir=ltr pin", () => {
    for (const rel of TIME_AXES) {
      // Comments stripped: this rule exists to keep an *attribute*, and the
      // comment above the attribute quotes it — a check that read the prose
      // would pass on a file that had lost the pin. (It did, once.)
      const source = stripComments(readFileSync(join(process.cwd(), rel), "utf8"));
      assert.match(
        source,
        /dir="ltr"/,
        `${rel} is built from physical offsets and must pin dir="ltr"; without it the axis ` +
          `and its labels disagree in Arabic. See the header of this file.`,
      );
    }
  });
});
