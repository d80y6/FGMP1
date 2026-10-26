/**
 * Navigation surfaces must not advertise what the role cannot open.
 * ─────────────────────────────────────────────────────────────────────────────
 * `rbac-ui-gates.test.ts` covers *views refusing themselves* and *action
 * controls*. This file covers the third surface, the one with no single choke
 * point: **links**. A view can be perfectly gated and still be linked from six
 * places — the sidebar, the command palette, a dashboard card, a breadcrumb, a
 * widget, a deep link typed by a colleague.
 *
 * The invariant asserted here, in the user's words: if a role has no access to
 * a part of the system, then neither a link to that part nor its content may
 * appear.
 *
 * Three layers enforce it, and each has a test:
 *
 *   1. `store.setView` refuses a view the role cannot open (behavioural test,
 *      the last line of defence, so a forgotten call site cannot mount a
 *      screen).
 *   2. Every call site that navigates asks about the capability first
 *      (static test over `setView("…")` and `?view=…` links).
 *   3. The shell refuses to mount the component even when a URL names it
 *      (already covered by the denied-view path; asserted here for completeness).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { hasCapability, type Role } from "../rbac-core";
import { useFgmp } from "../store";

const ROOT = process.cwd();
const COMPONENTS = join(ROOT, "src", "components", "fgmp");

function componentFiles(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(p);
      } else if (entry.name.endsWith(".tsx")) {
        out.push({ file: relative(ROOT, p), source: readFileSync(p, "utf8") });
      }
    }
  };
  walk(COMPONENTS);
  return out;
}

/** Every view key a file navigates to via `setView("…")`. */
function setViewTargets(source: string): string[] {
  return [...source.matchAll(/setView\(\s*"([a-z-]+)"\s*\)/g)].map((m) => m[1]);
}

/** Every view key a file links to via `?view=…` (breadcrumbs, raw anchors). */
function hrefTargets(source: string): string[] {
  return [...source.matchAll(/[?&]view=([a-z-]+)/g)].map((m) => m[1]);
}

/**
 * A file "consults the capability machinery" when it either names the specific
 * view capability (`"view:sites"`) or delegates to the `canView` predicate —
 * which is what a file with a dynamic target (`canView(item.href)`) must do.
 */
function gatesOn(source: string, view: string): boolean {
  return (
    source.includes(`"view:${view}"`) ||
    source.includes(`'view:${view}'`) ||
    /canView\s*\(/.test(source)
  );
}

describe("every navigation call site asks about the capability first", () => {
  // `store.ts` is the guard itself; `app-shell.tsx` owns `navigate()` (gated,
  // and covered separately); the palette is checked by rbac-ui-gates.
  const EXEMPT = new Set([
    "src/lib/fgmp/store.ts",
    "src/components/fgmp/app-shell.tsx",
  ]);

  test("no component navigates to a view without consulting its capability", () => {
    const offenders: string[] = [];
    for (const { file, source } of componentFiles()) {
      if (EXEMPT.has(file.replace(/\\/g, "/"))) continue;
      for (const target of setViewTargets(source)) {
        if (!gatesOn(source, target)) offenders.push(`${file} → setView("${target}")`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no component links to a view without consulting its capability", () => {
    const offenders: string[] = [];
    for (const { file, source } of componentFiles()) {
      for (const target of hrefTargets(source)) {
        if (!gatesOn(source, target)) offenders.push(`${file} → ?view=${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("store.setView refuses a view the effective role cannot open", () => {
  const seed = (role: Role) =>
    useFgmp.setState({
      me: {
        id: "test",
        name: "Test",
        email: "test@fgmp.invalid",
        role,
        tenantId: "tenant-1",
        roles: [role],
        permissions: { label: "", description: "", capabilities: [] },
      },
      view: "dashboard",
      selectedSiteId: null,
    });

  test("READONLY cannot switch to a SUPERADMIN-only view", () => {
    seed("READONLY");
    useFgmp.getState().setView("tenants");
    expect(useFgmp.getState().view).toBe("dashboard");
    useFgmp.getState().setView("tenant-isolation");
    expect(useFgmp.getState().view).toBe("dashboard");
  });

  test("READONLY can still switch to the views it holds", () => {
    seed("READONLY");
    for (const view of ["sites", "alarms", "suppressions", "audit"] as const) {
      useFgmp.getState().setView(view);
      expect({ view, landed: useFgmp.getState().view }).toEqual({ view, landed: view });
    }
  });

  test("a refusal does not clear the selection or move the user", () => {
    seed("READONLY");
    useFgmp.setState({ view: "alarms", selectedSiteId: "site-9" });
    useFgmp.getState().setView("api-keys");
    expect(useFgmp.getState().view).toBe("alarms");
    expect(useFgmp.getState().selectedSiteId).toBe("site-9");
  });

  test("SUPERADMIN reaches every view", () => {
    seed("SUPERADMIN");
    for (const view of ["tenants", "tenant-isolation", "api-keys", "system-settings"] as const) {
      useFgmp.getState().setView(view);
      expect({ view, landed: useFgmp.getState().view }).toEqual({ view, landed: view });
    }
  });

  test("the guard is the matrix, not a second list", () => {
    // For every role and every view the shell knows, the store's decision must
    // equal `hasCapability(role, "view:<key>")`.
    const VIEW_KEYS = [
      "dashboard", "sites", "fuel", "generators", "batteries", "alarms",
      "inventory", "analytics", "reports", "iot", "maintenance", "audit",
      "users", "system-health", "suppressions", "preferences", "dispensers",
      "asset-registry", "edge-firmware", "fuel-forecast", "consumption-patterns",
      "tenants", "geography", "roles", "system-settings", "api-keys",
      "tenant-isolation",
    ] as const;
    const mismatch: string[] = [];
    for (const role of ["ADMIN", "NOC_OPERATOR", "REGIONAL_MANAGER", "FIELD_ENGINEER", "EXECUTIVE", "READONLY"] as Role[]) {
      for (const view of VIEW_KEYS) {
        seed(role);
        useFgmp.getState().setView(view);
        const landed = useFgmp.getState().view === view;
        const expected = hasCapability(role, `view:${view}`);
        if (landed !== expected) mismatch.push(`${role} → ${view}: landed=${landed} expected=${expected}`);
      }
    }
    expect(mismatch).toEqual([]);
  });
});

describe("the shell's fallback and the store agree", () => {
  test("an unauthorized stored view can never be mounted, because it cannot be stored", () => {
    // The shell also guards independently (`safeView`). This test documents the
    // relationship: with the store refusing, `safeView` is a second lock rather
    // than the only one.
    const shell = readFileSync(join(COMPONENTS, "app-shell.tsx"), "utf8");
    expect(shell.includes('hasCapability(role, `view:${view}`) ? view : "dashboard"')).toBe(true);
    expect(shell.includes("VIEW_COMPONENTS[safeView]")).toBe(true);
  });
});
