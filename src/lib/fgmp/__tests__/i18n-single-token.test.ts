/**
 * Second guard for the bilingual UI: single-token JSX text.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `untranslated-text.test.ts` counts JSX text that reads as English *prose* —
 * two or more word-shaped tokens. It skips single tokens on purpose, because
 * most of them are correctly identical in both languages: units (`kW`, `h`,
 * `dBm`), bus/protocol names (`RS485`, `Modbus`), format names (`CSV`, `PDF`),
 * hardware families (`ESP`, `SOC`), keyboard keys (`Esc`).
 *
 * That exemption is also a blind spot, and the audit fell into it. Every admin
 * table header in `tenants-view`, `roles-view` and `geography-view` is a single
 * token — `Code`, `Name`, `Country`, `Users`, `Sites`, `Created`, `Role`,
 * `Status`, `Cancel` — as are the API-key status pills (`Active`, `Revoked`,
 * `Expired`), the "YOU" self-badge and the tenant-isolation result chips
 * (`Passed`, `Failed`, `Unmeasured`). All of them rendered English inside the
 * Arabic UI while both guards were green.
 *
 * WHAT IT DOES
 * ------------
 * 1. `MUST_BE_TRANSLATED` names tokens that are unconditionally UI language, not
 *    hardware vocabulary.
 * 2. `PENDING` is the exact multiset of those tokens still found as bare JSX
 *    text, with the file that holds each one. It is not an allowlist to be
 *    topped up: the assertion compares the found set to this list *exactly*, so
 *    a new English label fails the test and a fixed one fails until its entry is
 *    deleted. Shrinking it is the work; growing it is the regression.
 * 3. `CEILING` ratchets the *total* single-token count, which also covers new
 *    tokens that `MUST_BE_TRANSLATED` does not name yet.
 *
 * The 52 entries below are the open tail of D-29 in `TASK_LEDGER.md`. The
 * admin tables this commit fixed (tenants, roles, users, api-keys) were the
 * ones the sweep reached; the rest are the same defect in other views. They are
 * pinned rather than hidden so the Arabic UI's English leakage cannot grow.
 *
 * The file is parsed with the TypeScript compiler, not pattern-matched, so text
 * adjacent to `{…}` expressions and generics is handled correctly.
 *
 * Run: bun test src/lib/fgmp/__tests__/i18n-single-token.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SRC = join(process.cwd(), "src", "components");

/**
 * Tokens whose only job is to name something to an operator. If one appears as
 * a bare JSX text node it is English in the Arabic UI, whatever the context.
 */
const MUST_BE_TRANSLATED = new Set([
  "Name", "Code", "Country", "Users", "Sites", "Created", "Role", "Status",
  "Actions", "Cancel", "Clear", "Total", "Recent", "Earlier", "Sent", "Pending",
  "Passed", "Failed", "Unmeasured", "Leader", "Unscheduled", "Ordered",
  "Samples", "Pattern", "Risk", "Gateways", "Addresses", "Wildcard", "You",
  "Active", "Revoked", "Expired", "Revoke", "Today", "Online", "Offline",
  "Idle", "Fault", "Site", "Day", "Low", "High", "Print", "Source", "Target",
  "Current", "Devices", "Metric", "Rule", "Rules", "Tenant", "Tenants",
  "Platform", "Battery", "Chemistry", "Manufacturer", "Model", "Vendor",
  "Voltage", "Capacity", "Rate",
]);

/**
 * Known remaining leaks (D-29 tail), measured 26/10/2026 — one entry per occurrence,
 * formatted "<file> <token>". Delete an entry when its label is translated: the
 * test compares this list to the tree exactly, in both directions.
 */
const PENDING: readonly string[] = [
  "src/components/fgmp/correlation-rules-editor.tsx Rules",
  "src/components/fgmp/fuel-delivery-tracking.tsx Total",
  "src/components/fgmp/maintenance-gantt.tsx Site",
  "src/components/fgmp/maintenance-gantt.tsx Unscheduled",
  "src/components/fgmp/notification-center.tsx Clear",
  "src/components/fgmp/notification-center.tsx Earlier",
  "src/components/fgmp/notification-center.tsx Pending",
  "src/components/fgmp/notification-center.tsx Recent",
  "src/components/fgmp/notification-center.tsx Sent",
  "src/components/fgmp/region-leaderboard.tsx Leader",
  "src/components/fgmp/site-comparison-tool.tsx Metric",
  "src/components/fgmp/site-comparison-tool.tsx Print",
  "src/components/fgmp/site-comparison-tool.tsx Site",
  "src/components/fgmp/views/asset-registry-view.tsx Battery",
  "src/components/fgmp/views/asset-registry-view.tsx Chemistry",
  "src/components/fgmp/views/asset-registry-view.tsx Chemistry",
  "src/components/fgmp/views/asset-registry-view.tsx Model",
  "src/components/fgmp/views/asset-registry-view.tsx Status",
  "src/components/fgmp/views/asset-registry-view.tsx Status",
  "src/components/fgmp/views/asset-registry-view.tsx Status",
  "src/components/fgmp/views/consumption-patterns-view.tsx Day",
  "src/components/fgmp/views/consumption-patterns-view.tsx High",
  "src/components/fgmp/views/consumption-patterns-view.tsx Low",
  "src/components/fgmp/views/consumption-patterns-view.tsx Pattern",
  "src/components/fgmp/views/consumption-patterns-view.tsx Samples",
  "src/components/fgmp/views/consumption-patterns-view.tsx Site",
  "src/components/fgmp/views/edge-firmware-view.tsx Addresses",
  "src/components/fgmp/views/edge-firmware-view.tsx Current",
  "src/components/fgmp/views/edge-firmware-view.tsx Devices",
  "src/components/fgmp/views/edge-firmware-view.tsx Fault",
  "src/components/fgmp/views/edge-firmware-view.tsx Gateways",
  "src/components/fgmp/views/edge-firmware-view.tsx Idle",
  "src/components/fgmp/views/edge-firmware-view.tsx Offline",
  "src/components/fgmp/views/edge-firmware-view.tsx Online",
  "src/components/fgmp/views/edge-firmware-view.tsx Source",
  "src/components/fgmp/views/edge-firmware-view.tsx Target",
  "src/components/fgmp/views/fuel-forecast-view.tsx Risk",
  "src/components/fgmp/views/fuel-forecast-view.tsx Site",
  "src/components/fgmp/views/geography-view.tsx Cancel",
  "src/components/fgmp/views/geography-view.tsx Code",
  "src/components/fgmp/views/geography-view.tsx Name",
  "src/components/fgmp/views/geography-view.tsx Name",
  "src/components/fgmp/views/geography-view.tsx Sites",
  "src/components/fgmp/views/geography-view.tsx Status",
  "src/components/fgmp/views/tenant-isolation-view.tsx Code",
  "src/components/fgmp/views/tenant-isolation-view.tsx Failed",
  "src/components/fgmp/views/tenant-isolation-view.tsx Passed",
  "src/components/fgmp/views/tenant-isolation-view.tsx Status",
  "src/components/fgmp/views/tenant-isolation-view.tsx Tenant",
  "src/components/fgmp/views/tenant-isolation-view.tsx Tenant",
  "src/components/fgmp/views/tenant-isolation-view.tsx Tenants",
  "src/components/fgmp/views/tenant-isolation-view.tsx Unmeasured",
];

/** Measured 26/10/2026 alongside PENDING; was 148 before the admin-table sweep. */
const CEILING = 125;

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      tsxFiles(path, out);
    } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

interface Hit { file: string; line: number; text: string }

function singleTokenTextNodes(): Hit[] {
  const hits: Hit[] = [];
  for (const file of tsxFiles(SRC)) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node)) {
        const text = node.children
          .filter((c) => ts.isJsxText(c))
          .map((c) => (c as ts.JsxText).text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        // A single ASCII word, optionally hyphenated/apostrophised. Anything
        // with digits or punctuation is a value or a code, not UI copy.
        if (/^[A-Za-z][A-Za-z'’-]*$/.test(text)) {
          const first = node.children.find((c) => ts.isJsxText(c) && c.text.trim().length > 0)!;
          hits.push({
            file: relative(process.cwd(), file),
            line: sf.getLineAndCharacterOfPosition(first.getStart(sf)).line + 1,
            text,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

describe("bilingual UI — single-token labels", () => {
  test("operator-facing single-word labels match the pinned pending list exactly", () => {
    const found = singleTokenTextNodes()
      .filter((h) => MUST_BE_TRANSLATED.has(h.text))
      .map((h) => `${h.file} ${h.text}`)
      .sort();
    assert.deepEqual(
      found,
      [...PENDING].sort(),
      "a label was added (translate it) or fixed (delete its PENDING entry) — " +
        "both are commits, neither is silent",
    );
  });

  test("the number of untranslated single tokens only goes down", () => {
    const hits = singleTokenTextNodes();
    assert.ok(
      hits.length <= CEILING,
      `${hits.length} single-token JSX text nodes (ceiling ${CEILING}). ` +
        `Translate the new ones, then lower the ceiling:\n  ` +
        hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join("\n  "),
    );
  });
});
