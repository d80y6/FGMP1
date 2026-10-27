/**
 * Every capability in the matrix must be TRUE — enforced somewhere, or explained.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * `user:grant-superadmin` was declared in `SUPERADMIN_ONLY_CAPABILITIES`, shown in
 * the Roles screen, and enforced nowhere. It was not an isolated slip: scanning
 * the matrix found four more keys in the same state —
 *
 *   delivery:approve   delivery:verify   ticket:create
 *   ticket:assign      ticket:complete
 *
 * Each one is a claim the product makes to an administrator: "this role may
 * verify deliveries". Where nothing reads the key, the claim is decorative, and
 * the two ways it can go wrong are both real:
 *
 *   • a developer trusts it (`useCan("delivery:approve")`) and renders a button
 *     the server does not gate — the click either works for someone the matrix
 *     says may not, or 403s for someone it says may;
 *   • an auditor reads the Roles screen, sees a control, and stops looking.
 *
 * A capability is therefore only allowed to exist if one of these holds:
 *
 *   1. POLICY  — it appears in an API_READ_RULES / API_WRITE_RULES entry, so
 *                `canAccessApi` (browser AND server) answers for it.
 *   2. GATE    — a non-test file outside rbac-core.ts names it: a route's
 *                `can(...)`/`hasCapability(...)`, or a component's `useCan(...)`.
 *   3. NAV     — it is a `view:*` key, whose surface is the nav entry; the nav
 *                mapping is derived and asserted by `rbac-nav-single-source` and
 *                `platform-surface`.
 *   4. LISTED  — it is in `DECLARED_BUT_INERT` below, with the reason, and this
 *                test also asserts that every listed key still IS inert (an
 *                exemption that has since been wired up fails the test, so the
 *                list cannot drift into a graveyard of stale comments).
 *
 * The rule this encodes: the matrix is the source of truth for the UI, so the
 * matrix must not describe a control that does not exist.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALL_ROLES, ROLE_PERMISSIONS, SUPERADMIN_ONLY_CAPABILITIES } from "../rbac-core";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SRC = join(REPO_ROOT, "src");
const RBAC_CORE = join(SRC, "lib", "fgmp", "rbac-core.ts");

/**
 * Declared capabilities that intentionally gate nothing yet.
 *
 * ── EMPTY ON PURPOSE. KEEP IT THAT WAY. ──────────────────────────────────
 * The four keys that used to live here — `delivery:approve`, `ticket:create`,
 * `ticket:assign`, `ticket:complete` — were enforced instead of excused:
 *
 *   • `delivery:approve`   → the `dispatch` branch of POST /api/fgmp/deliveries
 *   • `ticket:create`      → the `create` branch of POST /api/fgmp/maintenance
 *   • `ticket:complete`    → the `complete` branch of the same route
 *   • `ticket:assign`      → POST /api/fgmp/maintenance/[id]/assign
 *
 * Each was excused on the grounds that enforcing it would "change access",
 * because the route's coarse role set and the capability list named different
 * populations. That was true, and it was the matrix that was wrong: every role
 * the route already admitted now HOLDS the capability it is now asked for, so
 * the checks add no new 403 and remove the divergence. The grants are:
 *
 *   FIELD_ENGINEER  + delivery:approve, ticket:create
 *   REGIONAL_MANAGER + ticket:complete
 *
 * A new entry here is a decision that a capability is decoration. It needs a
 * reason and the condition that retires it, and this test fails the moment the
 * excuse stops being true — so an entry cannot quietly outlive the problem.
 */
export const DECLARED_BUT_INERT: Record<string, string> = {};

interface Capability {
  key: string;
  /** Roles whose list contains it. */
  roles: string[];
  inPolicy: boolean;
  gated: boolean;
}

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walkFiles(full, acc);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * `rbac-core.ts` with the ROLE_PERMISSIONS matrix removed.
 *
 * What is left is everything that can ENFORCE a capability: the API policy rules
 * (`API_READ_RULES`, `API_WRITE_RULES`, `AUTH_ONLY_API_RULES`), the export map and
 * `SUPERADMIN_ONLY_CAPABILITIES`. The matrix block is cut out by its two
 * neighbours rather than by brace-matching: it starts at `export const
 * ROLE_PERMISSIONS` and the next export is `ALL_ROLES`.
 */
function rbacCoreWithoutRoleLists(): string {
  const source = readFileSync(RBAC_CORE, "utf8");
  const start = source.indexOf("export const ROLE_PERMISSIONS");
  const end = source.indexOf("export const ALL_ROLES", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(0, start) + source.slice(end);
}

function declaredCapabilities(): Capability[] {
  const policySource = rbacCoreWithoutRoleLists();
  const gates = walkFiles(SRC)
    .filter((f) => f !== RBAC_CORE)
    .map((f) => readFileSync(f, "utf8"));

  const byKey = new Map<string, Capability>();
  for (const role of ALL_ROLES) {
    for (const key of ROLE_PERMISSIONS[role].capabilities) {
      if (key === "*") continue;
      const entry = byKey.get(key) ?? {
        key,
        roles: [],
        inPolicy: policySource.includes(`"${key}"`),
        gated: gates.some((source) => source.includes(`"${key}"`)),
      };
      entry.roles.push(role);
      byKey.set(key, entry);
    }
  }
  // The platform keys are reached through SUPERADMIN's wildcard, so they never
  // appear in a role list; they still have to be enforced like everything else.
  for (const key of SUPERADMIN_ONLY_CAPABILITIES) {
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      roles: ["SUPERADMIN"],
      inPolicy: policySource.includes(`"${key}"`),
      gated: gates.some((source) => source.includes(`"${key}"`)),
    });
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const capabilities = declaredCapabilities();

describe("capability reachability: every key in the matrix is enforced or explained", () => {
  test("the scan found the matrix (guards against a silent empty pass)", () => {
    // If the parser above stopped finding the capability lists, every other test
    // here would pass over an empty set.
    expect(capabilities.length).toBeGreaterThan(40);
    expect(capabilities.some((c) => c.key === "view:sites")).toBe(true);
    expect(capabilities.some((c) => c.key === "user:grant-superadmin")).toBe(true);
  });

  test("no capability is decorative", () => {
    const inert = capabilities
      .filter((c) => !c.inPolicy && !c.gated && !c.key.startsWith("view:"))
      .map((c) => c.key)
      .filter((key) => !(key in DECLARED_BUT_INERT));
    expect(inert).toEqual([]);
  });

  test("every exemption is still inert, and still exists in the matrix", () => {
    const problems: string[] = [];
    for (const key of Object.keys(DECLARED_BUT_INERT)) {
      const entry = capabilities.find((c) => c.key === key);
      if (!entry) problems.push(`${key}: no longer declared anywhere — delete the exemption`);
      else if (entry.inPolicy || entry.gated) {
        problems.push(`${key}: is now ENFORCED — remove it from DECLARED_BUT_INERT`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("the platform keys are policy-gated, not capability-gated", () => {
    // `SUPERADMIN_ONLY_CAPABILITIES` describes the platform tier; the parity suite
    // proves each one has a policy row and that no tenant role holds it. What
    // matters here is that they are not merely names.
    const notPoliced = SUPERADMIN_ONLY_CAPABILITIES.filter((key) => {
      const entry = capabilities.find((c) => c.key === key);
      return !entry?.inPolicy;
    });
    expect(notPoliced).toEqual([]);
  });

  test("the four tiers stay separate: view keys are nav, action keys are not", () => {
    // A `view:` key must not appear in a write policy (it would let a read
    // capability authorize a mutation) and an action key must never be treated as
    // a nav surface. Cheap, and it catches the copy-paste that creates either.
    const wrong = capabilities
      .filter((c) => c.key.startsWith("view:") && c.inPolicy)
      .map((c) => c.key);
    // `view:*` keys legitimately appear in API_READ_RULES — that is the read
    // surface — so the assertion is that they do not appear in a WRITE rule.
    const writeSource = readFileSync(RBAC_CORE, "utf8");
    const writeBlock = writeSource.slice(writeSource.indexOf("export const API_WRITE_RULES"));
    const viewInWrite = capabilities
      .filter((c) => c.key.startsWith("view:") && writeBlock.includes(`"${c.key}"`))
      .map((c) => c.key);
    expect(wrong.length).toBeGreaterThan(0); // reads exist …
    expect(viewInWrite).toEqual([]); // … and none of them is a write authorization
  });
});
