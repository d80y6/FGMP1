/**
 * Guards the bilingual UI against regrowth of hardcoded English.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `translate()` falls back to the key itself, and a JSX text node has no
 * fallback at all: whatever is typed in the markup is what the Arabic UI shows.
 * An audit of the tree found English prose rendered inside the RTL layout in
 * whole panels — the fuel-delivery timeline, the API-key table, the tenant
 * support dialog. Those are fixed; this test is what keeps them fixed.
 *
 * WHAT IT COUNTS
 * --------------
 * JSX text that reads as English prose: two or more word-shaped tokens, no
 * code punctuation. It deliberately ignores single tokens — most are brand
 * names, units or codes ("FGMP", "Modbus", "Espressif") that are correctly
 * untranslated.
 *
 * The file is parsed, not pattern-matched. A regex over text can only see a
 * node whose content has no braces, and the normal shape of a heading is
 * `Tank Refuel Forecast ({n})` — prose glued to an expression. That shape is
 * invisible to `>[^<>{}]*<`, which is how 37 English strings survived a passing
 * guard. Here the JSX children are read directly: the literal text of every
 * child that is not an expression is collected and joined, so the prose on
 * either side of `{n}` is examined together.
 *
 * The ceilings below are a RATCHET: they may only go down. Fixing strings
 * without lowering them leaves room for regrowth, so lower them in the same
 * commit.
 *
 * Run: bun test src/lib/fgmp/__tests__/untranslated-text.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SRC = join(process.cwd(), "src", "components");

/**
 * Strings that are correctly the same in both languages. Each needs a reason —
 * this list is the whole difference between a useful guard and a way to hide
 * leftovers.
 */
const ALLOWED = new Set([
  "ESP Device ID",      // hardware identifier label; ESP is a product name
  "API Key",            // product/credential name; appears only as a fragment
  "JSON",               // format name
  "v2.4",               // version string
  "FGMP — Fuel & Generator Monitoring Platform", // brand line on the shell
]);

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      files(path, out);
    } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Blank comments, keep newlines, so line numbers stay true. */
function strip(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (_m, p) => p ?? "");
}

interface Hit { file: string; line: number; text: string }

function englishTextNodes(): Hit[] {
  const hits: Hit[] = [];
  for (const file of files(SRC)) {
    const source = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node)) {
        // The element's TEXT is the concatenation of its JsxText children, with
        // each `{…}` expression standing in for the value it renders.
        //
        // This used to be a regex over the raw file (`>[^<>{}]*<`). Two blind
        // spots, both found in the fuel-forecast view: a node mixing prose with
        // an expression — `Tank Refuel Forecast ({formatNumber(n)})` — contains
        // a brace and was skipped entirely, and loosening the filter to reach it
        // then matched across TypeScript generics (`Record<string, …>`) and
        // reported function signatures as untranslated prose. A JSX parse has
        // neither problem: prose and expressions are different node types.
        const text = node.children
          .map((child) => (ts.isJsxText(child) ? child.text : " "))
          .join("")
          .replace(/\s+/g, " ")
          .trim();
        const firstText = node.children.find((c) => ts.isJsxText(c) && c.text.trim().length > 0);
        if (text.length >= 3 && text.length <= 200 && firstText) {
          if (!/[;=|"`\\!?]/.test(text) && !ALLOWED.has(text)) {
            const words = text.split(" ").filter((w) => /^[A-Za-z][A-Za-z'’-]*[.,:…]?$/.test(w));
            if (words.length >= 2) {
              hits.push({
                file: relative(process.cwd(), file),
                line: lineOf(firstText.getStart(sf)),
                text,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

/**
 * Measured after the Phase-1 sweep (50 remaining, down from 127 before it). It
 * is a ceiling, not a target: every string fixed below it should lower the
 * number in the same commit so the next regression has nowhere to hide. The
 * ledger lists the ones still outstanding (mostly per-view form labels).
 */
const CEILING = 0;

/**
 * English that is never a text node: the accessible name of a control
 * (`aria-label`), a tooltip (`title`), an input hint (`placeholder`), or a prop
 * that some component renders as text (`label`, `description`, `message`,
 * `submitLabel`, `text`, `hint`, `heading`). These are read by screen readers
 * and by operators, so an English literal here is a translation gap even when
 * the visible UI is Arabic.
 *
 * The first sweep guarded only `aria-label`/`title`/`placeholder` and called
 * the rest "not text". That was wrong: `<EmptyState title=… description=…>` and
 * `<KpiCard label=…>` render exactly those strings, and 89 more English
 * literals were hiding in them.
 *
 * Ceiling is ZERO. A value whose only letters are a format example — `v1.0.0`,
 * `ESP32-DISP-001`, `10.0.0.0/8` — is not language and is skipped by the
 * three-lowercase-letters rule below.
 */
const ATTR_CEILING = 0;

/** Attribute names whose string value some component renders or announces. */
const TEXT_ATTRS =
  "aria-label|title|placeholder|label|description|message|submitLabel|text|hint|heading";

function englishAttributeLiterals(): Hit[] {
  const hits: Hit[] = [];
  for (const file of files(SRC)) {
    const source = strip(readFileSync(file, "utf8"));
    const pattern = new RegExp(`\\b(${TEXT_ATTRS})="([A-Za-z][^"]*)"`, "g");
    for (const match of source.matchAll(pattern)) {
      const [, attr, value] = match;
      // A value with no run of three lowercase letters is a format example or a
      // code — `v1.0.0`, `ESP32-DISP-001`, `10.0.0.0/8` — not English prose.
      if (!/[a-z]{3}/.test(value)) continue;
      const line = source.slice(0, match.index).split("\n").length;
      hits.push({ file: relative(process.cwd(), file), line, text: `${attr}="${value}"` });
    }
  }
  return hits;
}

describe("bilingual UI", () => {
  test("no accessible name is a hardcoded English literal", () => {
    const labels = englishAttributeLiterals().filter((h) => h.text.startsWith("aria-label="));
    assert.deepEqual(
      labels.map((h) => `${h.file}:${h.line}  ${h.text}`),
      [],
      "an aria-label is announced verbatim to a screen reader — translate it",
    );
  });

  test("props that render text carry no English literal", () => {
    const hits = englishAttributeLiterals();
    assert.ok(
      hits.length <= ATTR_CEILING,
      `${hits.length} English literals in rendered props (ceiling ${ATTR_CEILING}):\n  ` +
        hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n  "),
    );
  });

  test("no new English prose is hardcoded in JSX", () => {
    const hits = englishTextNodes();
    assert.ok(
      hits.length <= CEILING,
      `${hits.length} untranslated English strings (ceiling ${CEILING}). Use t()/tFmt() from @/lib/fgmp/use-language:\n  ` +
        hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n  "),
    );
  });
});
