/**
 * Every mutating control is tied to the capability its ENDPOINT needs.
 * ─────────────────────────────────────────────────────────────────────────────
 * `rbac-ui-gates.test.ts` checks a hand-written table of views and actions:
 * somebody looked at each screen and wrote down which capability it needs. That
 * table is only as complete as the last audit, and the audit missed three live
 * defects of the same shape:
 *
 *   • `dashboard-view` offered *Ack* on the dashboard. The button posts
 *     `{ action: "acknowledge" }` to `/api/fgmp/alarms`; FIELD_ENGINEER,
 *     EXECUTIVE and READONLY may open the dashboard and read alarms, so the only
 *     possible outcome was a "failed" toast. `rbac-ui-gates` never mentioned the
 *     dashboard.
 *   • `iot-view` rendered *OTA* and *reboot* for five roles that do not hold
 *     `edge:manage`.
 *   • `edge-firmware-view` derived its OTA button from `dispenser:control`,
 *     while the deploy posts to endpoints that need `asset:manage` or
 *     `edge:manage`. NOC_OPERATOR and FIELD_ENGINEER — the two roles the button
 *     was *for* — were the two it refused.
 *
 * A hand-written table cannot catch that class, because the defect is a control
 * nobody wrote down. This file derives the answer instead: it reads every
 * component that issues a mutation, asks the policy core which capabilities that
 * exact method+URL requires (`apiRequestCapabilities`, the same function
 * `requireAuth` uses), and fails if the component never mentions one of them.
 *
 * What it deliberately does NOT do:
 *   - it does not require a particular FORM of the check (`hasCapability`,
 *     `can("…")`, `useCap`, a boolean alias — all count), because the property is
 *     "the file asked", not "the file asked in this spelling";
 *   - it skips URLs that are built from a template literal at the call site
 *     (`/api/fgmp/tanks/${id}`), because the static prefix of a template is not
 *     the endpoint. Those files are covered by the hand-written `ACTION_GATES`
 *     table instead, and the list is asserted below so it cannot grow silently;
 *   - it skips `AUTH_ONLY_API_RULES` paths, which every signed-in role may call.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { apiRequestCapabilities, ROLE_PERMISSIONS, SUPERADMIN_ONLY_CAPABILITIES } from "../rbac-core";

const ROOT = process.cwd();
const COMPONENTS = join(ROOT, "src", "components", "fgmp");

/**
 * Every capability a gate could legitimately name. SUPERADMIN's `"*"` is not a
 * capability, and the platform-level ones (`tenant:manage`, …) never appear in a
 * role's list because they are reached through the wildcard — so they must be
 * added explicitly or a correct gate on `/api/fgmp/tenants` would look like it
 * named a capability that does not exist.
 */
const ALL_CAPABILITIES = new Set<string>([
  ...Object.values(ROLE_PERMISSIONS).flatMap((p) => p.capabilities.filter((c) => c !== "*")),
  ...SUPERADMIN_ONLY_CAPABILITIES,
]);

interface ComponentSource {
  file: string;
  source: string;
}

function componentFiles(): ComponentSource[] {
  const out: ComponentSource[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(p);
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        out.push({ file: relative(ROOT, p), source: readFileSync(p, "utf8") });
      }
    }
  };
  walk(COMPONENTS);
  return out;
}

/** Mutations whose URL is a fully literal string (no interpolation). */
function literalMutations(source: string): { method: string; url: string }[] {
  return [...source.matchAll(/api(Post|Patch|Put|Delete)\(\s*"(\/api\/fgmp[^"]*)"/g)].map((m) => ({
    method: m[1].toUpperCase(),
    url: m[2],
  }));
}

/** Every capability-looking string literal the file mentions. */
function mentionedCapabilities(source: string): Set<string> {
  // `[a-z-]` on the left of the colon too: `api-key:manage` and
  // `user:grant-superadmin` both have hyphens, and a `[a-z]+` there silently
  // skipped them.
  return new Set(
    [...source.matchAll(/"([a-z-]+:[a-z-]+)"/g)].map((m) => m[1]).filter((c) => ALL_CAPABILITIES.has(c)),
  );
}

interface Finding {
  file: string;
  method: string;
  url: string;
  capabilities: string[];
}

/** Files that issue a literal mutation without asking for its capability. */
function ungatedMutations(): Finding[] {
  const findings: Finding[] = [];
  for (const { file, source } of componentFiles()) {
    const mentioned = mentionedCapabilities(source);
    for (const { method, url } of literalMutations(source)) {
      const caps = apiRequestCapabilities(method, url);
      // null → unmapped or auth-only: not this test's question.
      if (!caps || caps.length === 0) continue;
      if (caps.some((c) => mentioned.has(c))) continue;
      findings.push({ file, method, url, capabilities: [...caps] });
    }
  }
  return findings;
}

describe("a mutating control names the capability its endpoint needs", () => {
  test("no component issues a mutation it never asked permission for", () => {
    const findings = ungatedMutations();
    const report = findings.map((f) => `${f.file}: ${f.method} ${f.url} needs any-of [${f.capabilities.join("|")}]`);
    expect(report).toEqual([]);
  });

  test("the scan actually sees mutations (guards against a silent no-op)", () => {
    // A regex that matches nothing would make the assertion above vacuous.
    const files = componentFiles().filter((f) => literalMutations(f.source).length > 0);
    expect(files.length).toBeGreaterThanOrEqual(8);
    const total = files.reduce((n, f) => n + literalMutations(f.source).length, 0);
    expect(total).toBeGreaterThanOrEqual(15);
  });

  test("the policy core resolves the endpoints the scan depends on", () => {
    // If `apiRequestCapabilities` returned null for these, every call site would
    // be skipped and the whole file would pass for the wrong reason.
    const probes: [string, string][] = [
      ["POST", "/api/fgmp/alarms"],
      ["PATCH", "/api/fgmp/iot"],
      ["PATCH", "/api/fgmp/settings"],
      ["POST", "/api/fgmp/api-keys"],
      ["POST", "/api/fgmp/users"],
      ["POST", "/api/fgmp/tenants"],
      ["POST", "/api/fgmp/sites"],
    ];
    for (const [method, url] of probes) {
      const caps = apiRequestCapabilities(method, url);
      expect({ method, url, mapped: Array.isArray(caps) && caps.length > 0 }).toEqual({
        method,
        url,
        mapped: true,
      });
    }
    // …and each names a capability that exists in the matrix, or the gate can
    // never be satisfied by any role.
    for (const [method, url] of probes) {
      const unknown = (apiRequestCapabilities(method, url) ?? []).filter((c) => !ALL_CAPABILITIES.has(c));
      expect({ method, url, unknown }).toEqual({ method, url, unknown: [] });
    }
  });
});

describe("the template-URL blind spot is a known, bounded list", () => {
  /**
   * Files whose only mutations are template-built (`/api/fgmp/x/${id}`). Their
   * static prefix is a different endpoint, so the scan above skips them; each
   * one is instead covered by an entry in `ACTION_GATES`
   * (`rbac-ui-gates.test.ts`). Listed explicitly so adding an ungated one is a
   * reminder rather than an invisible gap.
   */
  const TEMPLATE_ONLY = [
    "src/components/fgmp/remote-control-dialog.tsx",
    "src/components/fgmp/site-detail-sheet.tsx",
    "src/components/fgmp/views/sites-view.tsx",
  ];
  /**
   * Files that issue at least one literal mutation (covered by the scan) AND at
   * least one templated one (not). The literal one is what makes the file appear
   * above; the templated ones are covered by `ACTION_GATES` or by the same
   * capability already proven for the literal call.
   */
  const MIXED = [
    "src/components/fgmp/site-form-dialog.tsx",
    "src/components/fgmp/views/api-keys-view.tsx",
    "src/components/fgmp/views/edge-firmware-view.tsx",
    "src/components/fgmp/views/tenants-view.tsx",
    "src/components/fgmp/views/users-view.tsx",
  ];

  test("every component that mutates is in one of the two tables", () => {
    const mutating = componentFiles()
      .filter((f) => /api(?:Post|Patch|Put|Delete)\(/.test(f.source))
      .map((f) => f.file)
      .sort();
    const covered = componentFiles()
      .filter((f) => literalMutations(f.source).length > 0)
      .map((f) => f.file)
      .sort();
    const unaccounted = mutating.filter((f) => !covered.includes(f) && !TEMPLATE_ONLY.includes(f));
    expect(unaccounted).toEqual([]);
    // The two lists must not rot: an entry that no longer mutates is stale.
    for (const f of [...TEMPLATE_ONLY, ...MIXED]) {
      expect({ f, mutates: /api(?:Post|Patch|Put|Delete)\(/.test(readFileSync(join(ROOT, f), "utf8")) }).toEqual({
        f,
        mutates: true,
      });
    }
  });
});
