/**
 * Tests for the translation dictionary.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `translate()` falls back to the raw key when a lookup misses, which is a
 * reasonable runtime default — a missing label should not crash a page — but it
 * hides the mistake: the user reads "rules.reset" where a button label should
 * be, and nothing in CI notices. That is exactly what had happened in the
 * correlation-rules editor: the destructive-action confirm button was wired to
 * `t("rules.reset")`, a key that never existed, so the button rendered the key
 * itself in both languages. It took reading the component to find it.
 *
 * The first test below reads the source tree and asserts that every literal
 * `t("…")` key exists in the dictionary, which turns that class of typo into a
 * build failure. The remaining tests hold the dictionary itself to a standard:
 * both languages present, non-empty, and interpolating the same placeholders.
 *
 * Run: bun test src/lib/fgmp/__tests__/i18n.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { DICTIONARY, translate } from "@/lib/fgmp/i18n";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(path, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Remove comments before hunting for calls.
 *
 * Three of the hits in this repository are documentation examples — a `t(…)`
 * inside a doc comment in empty-state.tsx, confirm-destructive.tsx and
 * i18n.ts. They are prose, not lookups, and rewriting the docs to dodge a regex
 * would be the tail wagging the dog, so the scan reads the code and skips the
 * comments. Strings are tracked too: a `//` inside "https://…" is not a comment.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  type State = "code" | "line" | "block" | "single" | "double" | "template";
  let state: State = "code";

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === "code") {
      if (ch === "/" && next === "/") { state = "line"; i += 2; continue; }
      if (ch === "/" && next === "*") { state = "block"; i += 2; continue; }
      if (ch === '"') state = "double";
      else if (ch === "'") state = "single";
      else if (ch === "`") state = "template";
      out += ch;
      i += 1;
      continue;
    }

    if (state === "line") {
      if (ch === "\n") { state = "code"; out += ch; }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (ch === "*" && next === "/") { state = "code"; i += 2; continue; }
      // Keep newlines so reported line numbers still roughly line up.
      if (ch === "\n") out += ch;
      i += 1;
      continue;
    }

    // Inside a string literal: copy verbatim, honouring escapes.
    if (ch === "\\") { out += ch + (next ?? ""); i += 2; continue; }
    if (
      (state === "double" && ch === '"') ||
      (state === "single" && ch === "'") ||
      (state === "template" && ch === "`")
    ) {
      state = "code";
    }
    out += ch;
    i += 1;
  }

  return out;
}

/** Literal `t("key")` calls across the app. */
function literalKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const pattern = /\bt\(\s*"([^"]+)"/g;
  for (const file of walk(SRC)) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(pattern)) {
      const key = match[1];
      const relative = file.slice(process.cwd().length + 1);
      const files = found.get(key) ?? [];
      if (!files.includes(relative)) files.push(relative);
      found.set(key, files);
    }
  }
  return found;
}

describe("dictionary lookups", () => {
  test("every literal t() key exists", () => {
    const keys = literalKeys();
    assert.ok(keys.size > 500, `expected a broad scan, found ${keys.size} keys`);

    const missing: string[] = [];
    for (const [key, files] of keys) {
      if (!(key in DICTIONARY)) missing.push(`${key}  (${files.join(", ")})`);
    }

    assert.deepEqual(
      missing.sort(),
      [],
      `t() called with keys that do not exist — the UI would render the raw key:\n  ${missing
        .sort()
        .join("\n  ")}`,
    );
  });

  test("an unknown key falls back to the key itself", () => {
    // Documents the behaviour the scan above exists to catch early.
    assert.equal(translate("this.key.does.not.exist", "en"), "this.key.does.not.exist");
    assert.equal(translate("this.key.does.not.exist", "ar"), "this.key.does.not.exist");
  });
});

describe("dictionary contents", () => {
  test("both languages are present and non-empty", () => {
    const bad: string[] = [];
    for (const [key, entry] of Object.entries(DICTIONARY)) {
      for (const lang of ["en", "ar"] as const) {
        const value = entry[lang];
        if (typeof value !== "string" || value.trim() === "") {
          bad.push(`${key}.${lang}`);
        }
      }
    }
    assert.deepEqual(bad, [], `empty translations: ${bad.join(", ")}`);
  });

  test("Arabic entries are actually translated", () => {
    // Brand names, codes and units are legitimately identical in both
    // languages; a whole sentence that never changed is a copy-paste miss.
    const same = Object.entries(DICTIONARY)
      .filter(([, e]) => e.en === e.ar && /[a-z]{4,}\s+[a-z]{4,}/i.test(e.en))
      .map(([k, e]) => `${k}: "${e.en}"`);
    assert.deepEqual(same, [], `Arabic text identical to English:\n  ${same.join("\n  ")}`);
  });

  test("placeholders match between languages", () => {
    const placeholder = /\{(\w+)\}/g;
    const mismatched: string[] = [];
    for (const [key, entry] of Object.entries(DICTIONARY)) {
      const en = [...entry.en.matchAll(placeholder)].map((m) => m[1]).sort();
      const ar = [...entry.ar.matchAll(placeholder)].map((m) => m[1]).sort();
      if (en.join(",") !== ar.join(",")) {
        mismatched.push(`${key}: en {${en.join(", ")}} vs ar {${ar.join(", ")}}`);
      }
    }
    assert.deepEqual(mismatched, [], `placeholder mismatch:\n  ${mismatched.join("\n  ")}`);
  });
});
