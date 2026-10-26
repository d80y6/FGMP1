/**
 * The browser must ask the same question the server answers.
 * ─────────────────────────────────────────────────────────────────────────────
 * `requireAuth(req)` evaluates the capability policy for every API request, and
 * `scripts/verify/route-inventory.ts` proves the route tree agrees with it. The
 * UI is the layer no contract covered: an access gate that restates the policy
 * as a role literal looks correct, compiles, and is wrong in both directions.
 *
 * Two failures were found by reading the views, and both are mechanical enough
 * to guard:
 *
 *   1. A gate NARROWER than the API. `me.role !== "ADMIN"` refused SUPERADMIN —
 *      the wildcard holder — on System Health, System Settings, API Keys and
 *      Geography, while the nav (capability-filtered) still offered those
 *      entries, so the role with the most authority saw "Access denied" on
 *      surfaces its own session could call. The same shape locked FIELD_ENGINEER
 *      and READONLY out of Suppressions, whose `view:suppressions` capability
 *      they hold and whose nav entry was therefore visible.
 *
 *   2. An affordance BROADER than the API. Acknowledge/Resolve, Create Ticket,
 *      Dispatch/Verify and OTA were rendered for every role that could *view*
 *      the screen, including READONLY and EXECUTIVE, for whom the only possible
 *      outcome was a 403 (or the client-side denial toast).
 *
 * Neither is a privilege escalation — the server refuses the request in both
 * cases — but both are RBAC defects: the interface lies about what the operator
 * may do, and an operator who is told "no" by a button they were invited to
 * press learns to distrust the permission model.
 *
 * The checks below are static because there is no test renderer in this repo
 * suite, and because what is being asserted is structural: *the gate names a
 * capability, not a role*. A capability-level assertion cannot be faked by a
 * view that happens to render the right button for the current role.
 *
 * Run: bun test src/lib/fgmp/__tests__/rbac-ui-gates.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { hasCapability, type Role } from "../rbac-core";

const ROOT = process.cwd();
const COMPONENTS = join(ROOT, "src", "components", "fgmp");
const VIEWS = join(COMPONENTS, "views");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Every `.tsx` under src/components/fgmp, with its repo-relative path. */
function componentFiles(): { path: string; file: string; source: string }[] {
  const out: { path: string; file: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(p);
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        out.push({ path: p, file: relative(ROOT, p), source: read(p) });
      }
    }
  };
  walk(COMPONENTS);
  return out;
}

/**
 * Views that require a view capability to open at all, and the capability each
 * one must name.
 *
 * Hand-written on purpose: the point is that somebody looked at each screen and
 * decided which capability it needs. A derived list would be satisfied by the
 * same mistake twice.
 */
const VIEW_GATES: { view: string; capability: string }[] = [
  { view: "api-keys-view.tsx", capability: "view:api-keys" },
  { view: "asset-registry-view.tsx", capability: "view:asset-registry" },
  { view: "geography-view.tsx", capability: "view:geography" },
  { view: "suppressions-view.tsx", capability: "view:suppressions" },
  { view: "system-health-view.tsx", capability: "view:system-health" },
  { view: "system-settings-view.tsx", capability: "view:system-settings" },
  { view: "tenant-isolation-view.tsx", capability: "view:tenant-isolation" },
  { view: "tenants-view.tsx", capability: "view:tenants" },
  { view: "users-view.tsx", capability: "view:users" },
];

/**
 * A minimal static check per action: the component must consult the named
 * capability. It cannot prove the button is hidden (that is a render
 * question), but it does prove the file no longer decides the question with a
 * role comparison — which is what regressed.
 */
const ACTION_GATES: { file: string; capability: string; why: string }[] = [
  { file: "views/dashboard-view.tsx", capability: "alarm:ack", why: "Ack a critical alarm from the dashboard" },
  { file: "views/iot-view.tsx", capability: "edge:manage", why: "OTA deploy / reboot an IoT device" },
  { file: "views/edge-firmware-view.tsx", capability: "asset:manage", why: "OTA for a dispenser-sourced gateway" },
  { file: "views/edge-firmware-view.tsx", capability: "edge:manage", why: "OTA for an iot-sourced gateway" },
  { file: "views/api-keys-view.tsx", capability: "api-key:manage", why: "Create / revoke an API key" },
  { file: "views/system-settings-view.tsx", capability: "settings:manage", why: "Save / reset settings" },
  { file: "views/users-view.tsx", capability: "user:manage", why: "Create / edit / deactivate / reset a user" },
  { file: "views/tenants-view.tsx", capability: "tenant:manage", why: "Create / edit / delete a tenant, open support access" },
  { file: "views/tenants-view.tsx", capability: "user:manage", why: "Mint a tenant's first administrator" },
  { file: "site-form-dialog.tsx", capability: "asset:manage", why: "Site create / edit dialog" },
  { file: "views/alarms-view.tsx", capability: "alarm:ack", why: "Acknowledge / bulk acknowledge" },
  { file: "views/alarms-view.tsx", capability: "alarm:resolve", why: "Resolve / bulk resolve" },
  { file: "views/maintenance-view.tsx", capability: "ticket:manage", why: "Create / complete ticket" },
  { file: "views/inventory-view.tsx", capability: "delivery:manage", why: "Create / dispatch / verify delivery" },
  { file: "views/edge-firmware-view.tsx", capability: "dispenser:control", why: "ESP reboot" },
  { file: "views/sites-view.tsx", capability: "asset:manage", why: "Site create / edit / delete" },
  { file: "views/dispensers-view.tsx", capability: "asset:manage", why: "Dispenser CRUD" },
  { file: "views/dispensers-view.tsx", capability: "dispenser:control", why: "Live dispenser command" },
  { file: "correlation-rules-editor.tsx", capability: "alarm:configure", why: "Correlation-rule authoring" },
  { file: "site-detail-sheet.tsx", capability: "settings:manage", why: "Interlock threshold editing" },
  { file: "header-overflow-menu.tsx", capability: "role:preview", why: "Role switcher" },
  { file: "shift-handover-panel.tsx", capability: "settings:manage", why: "Delete a handover note" },
];

describe("every view that can refuse itself names a capability, not a role", () => {
  for (const { view, capability } of VIEW_GATES) {
    test(`${view} gates on ${capability}`, () => {
      const source = read(join(VIEWS, view));
      // The capability must appear inside a hasCapability()/canAccessApi() call.
      const namesTheCapability = new RegExp(
        `(?:hasCapability|canAccessApi)\\([^)]*"${capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      ).test(source);
      expect({ view, namesTheCapability }).toEqual({ view, namesTheCapability: true });
    });
  }
});

describe("no view restates the policy as a role literal", () => {
  // A denial gate is the dangerous shape: `me.role !== "<ROLE>"`. Comparisons
  // used for *behaviour* (which tenant selector to show, which badge to render,
  // whether the current row's target is a super-admin) are legitimate and are
  // not matched here because they do not deny the viewer the screen.
  const DENIAL_GATE = /me\??\.role\s*!==?\s*"(?:SUPERADMIN|ADMIN|[A-Z_]+)"/;
  const LOCAL_ROLE_SET = /\b(?:const|let)\s+(?:ROLE_OK|ALLOWED_ROLES|ADMIN_ROLES)\s*=/;

  test("no component refuses itself with `me.role !== \"…\"`", () => {
    const offenders = componentFiles()
      .filter((f) => DENIAL_GATE.test(f.source))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  test("no component keeps a local role allow-list", () => {
    const offenders = componentFiles()
      .filter((f) => LOCAL_ROLE_SET.test(f.source))
      .map((f) => f.file);
    expect(offenders).toEqual([]);
  });
});

describe("the affordances a view offers follow the capability its endpoint needs", () => {
  for (const { file, capability, why } of ACTION_GATES) {
    test(`${file} asks for ${capability} (${why})`, () => {
      const source = read(join(COMPONENTS, file));
      const escape = capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Any of the sanctioned spellings: `hasCapability(role, "x")`,
      // `canAccessApi(role, url, method)` against a literal URL is a different
      // question, and the client helpers `can("x")` (from `useCan()`) and
      // `useCap("x")` are the same capability lookup with the role left implicit.
      // Demanding one spelling would fail a correct gate.
      const pattern = new RegExp(`(?:hasCapability|useCap)\\([^)]*"${escape}"|\\bcan\\(\\s*"${escape}"`);
      expect({ why, uses: pattern.test(source) }).toEqual({ why, uses: true });
    });
  }
});

describe("the gates agree with the matrix (this is what made the old ones wrong)", () => {
  test("SUPERADMIN holds every view capability, so an ADMIN-only gate excluded it", () => {
    // The concrete regression: the nav offers these to SUPERADMIN (the wildcard
    // satisfies every capability) while the view demanded the ADMIN role.
    for (const cap of [
      "view:system-health",
      "view:system-settings",
      "view:api-keys",
      "view:geography",
      "view:tenants",
      "view:tenant-isolation",
    ]) {
      expect({ cap, superadmin: hasCapability("SUPERADMIN", cap) }).toEqual({ cap, superadmin: true });
    }
  });

  test("FIELD_ENGINEER and READONLY hold view:suppressions, so a three-role set was wrong", () => {
    for (const role of ["FIELD_ENGINEER", "READONLY"] as Role[]) {
      expect({ role, holds: hasCapability(role, "view:suppressions") })
        .toEqual({ role, holds: true });
    }
    // …and neither may suppress or delete one: visibility is not authority.
    for (const role of ["FIELD_ENGINEER", "READONLY"] as Role[]) {
      expect({ role, suppress: hasCapability(role, "alarm:suppress") })
        .toEqual({ role, suppress: false });
    }
  });

  test("the roles offered control affordances cannot call the endpoint", () => {
    // Sanity for the ACTION_GATES table: a role that can view alarms but holds
    // no alarm capability is exactly the case the UI used to get wrong.
    for (const role of ["READONLY", "EXECUTIVE"] as Role[]) {
      expect({ role, ack: hasCapability(role, "alarm:ack") }).toEqual({ role, ack: false });
      expect({ role, ticket: hasCapability(role, "ticket:manage") }).toEqual({ role, ticket: false });
      expect({ role, delivery: hasCapability(role, "delivery:manage") })
        .toEqual({ role, delivery: false });
    }
  });

  test("every capability named above exists in rbac-core", () => {
    // Guards a typo in this file. Several capabilities (view:tenants,
    // view:tenant-isolation) are reachable only through SUPERADMIN's "*", so
    // they cannot be found by scanning the per-role lists — the source text is
    // the honest oracle.
    const core = read(join(ROOT, "src", "lib", "fgmp", "rbac-core.ts"));
    for (const { capability } of [...VIEW_GATES, ...ACTION_GATES]) {
      expect({ capability, declared: core.includes(`"${capability}"`) })
        .toEqual({ capability, declared: true });
    }
  });
});
