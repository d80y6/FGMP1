/**
 * Phase 5 task 3 — no selector-less `useFgmp()` calls remain.
 *
 * WHY THIS IS A TEST AND NOT A LINT RULE
 * --------------------------------------
 * The store is vanilla Zustand. A bare `useFgmp()` subscribes a component to
 * EVERY state change, so it re-rendered on every 5s tick — 39 call sites × 12
 * ticks/min. Converting them to selectors is mechanical, and mechanical
 * conversions of this shape produce a specific bug:
 *
 *     const { snapshot, me } = useFgmp(useShallow((s) => ({ snapshot, me })));
 *
 * The selector returns the names `snapshot` and `me` from the component's own
 * scope, NOT from the store. Every call site where that happened TYPECHECKED
 * CLEANLY and returned undefined at runtime. This actually occurred during the
 * conversion — 15 selectors were written that way and tsc reported zero errors
 * for every one.
 *
 * So the check below reads the source rather than trusting the compiler.
 *
 * Run: bun test src/components/fgmp/__tests__/no-selectorless-store.test.ts
 */
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|\.next|\.git/.test(full)) walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const FILES = walk("src");

/** Strip comments so a doc comment mentioning `useFgmp()` is not a finding. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("no selector-less useFgmp() subscriptions", () => {
  test("every call passes a selector", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = codeOnly(fs.readFileSync(file, "utf8"));
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        const m = line.match(/useFgmp\(\s*\)/);
        if (m) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders, `selector-less calls:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("selectors actually read from the store", () => {
  test("no useShallow selector returns bare identifiers", () => {
    // The bug described in the header: `({ snapshot, me })` instead of
    // `({ snapshot: s.snapshot, me: s.me })`. Typechecks, returns undefined.
    const offenders: string[] = [];
    const pattern = /useShallow\(\s*\(s\w*\)\s*=>\s*\(\{([^}]*)\}\)/g;
    for (const file of FILES) {
      const src = codeOnly(fs.readFileSync(file, "utf8"));
      for (const match of src.matchAll(pattern)) {
        const body = match[1];
        for (const raw of body.split(",")) {
          const part = raw.trim();
          if (!part) continue;
          const [key, value] = part.split(":").map((x) => x?.trim());
          if (value === undefined) {
            offenders.push(`${file}: shorthand "${part}" returns no store value`);
          } else if (!/^s\w*\./.test(value)) {
            offenders.push(`${file}: "${part}" does not read from the store argument`);
          } else if (key && value.slice(2) !== key) {
            // `value` is `s.<field>`; the key must name that same field.
            offenders.push(`${file}: "${part}" reads a different field than it is keyed on`);
          }
        }
      }
    }
    expect(offenders, `broken selectors:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("no plain selector returns a bare identifier", () => {
    // Same defect without useShallow: `useFgmp((s) => snapshot)`.
    const offenders: string[] = [];
    const pattern = /useFgmp\(\s*\(s\w*\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\)/g;
    for (const file of FILES) {
      const src = codeOnly(fs.readFileSync(file, "utf8"));
      for (const match of src.matchAll(pattern)) {
        offenders.push(`${file}: returns bare "${match[1]}"`);
      }
    }
    expect(offenders, `broken selectors:\n${offenders.join("\n")}`).toEqual([]);
  });
});