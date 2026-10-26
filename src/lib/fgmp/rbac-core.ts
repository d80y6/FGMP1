import type { Role } from "./types";

// Re-exported so consumers of the capability matrix can name the role type
// without reaching into `./types`. `rbac-matrix.test.ts` does exactly that,
// and `ROLE_PERMISSIONS` is `Record<Role, …>` — a matrix you cannot type-check
// against its own key union is a matrix nothing verifies.
export type { Role };

export interface Permission {
  view: string; // dashboard view key
}

// Capability matrix per role.
//
// Role hierarchy (Task 49 — Super-admin model):
//   SUPERADMIN — platform-level. Creates tenants + tenant ADMINs, and may obtain
//                time-boxed access to ONE tenant at a time through a support
//                session (docs/SUPERADMIN.md). It does NOT bypass tenant
//                isolation: every tenant-scoped route still runs in a tenant
//                context. Holds the `*` wildcard — the ONLY role that does.
//   ADMIN      — tenant-level administrator. Creates users (non-SUPERADMIN)
//                within their own tenant only. Cannot create tenants or
//                touch SUPERADMIN accounts. Holds an EXPLICIT list (below),
//                not the wildcard.
//   (other roles — operational, scoped to their tenant.)
//
// ── Why ADMIN is an explicit allow-list, not `"*"` ─────────────────────────
// ADMIN used to be `["*"]`, identical to SUPERADMIN, which meant
// `hasCapability(ADMIN, anything)` returned true — including for the two
// surfaces that are strictly platform-level:
//
//   view:tenants           — /api/fgmp/tenants POST is SUPERADMIN_ONLY
//   view:tenant-isolation  — SUPERADMIN-only diagnostic view
//   tenant:manage          — create / update / delete tenants
//   platform:firmware      — create / delete GLOBAL EspFirmwareRelease rows
//                            (that table has no tenantId — see prisma/schema.prisma)
//
// Callers of hasCapability() (verified against the whole repo):
//   • src/components/fgmp/app-shell.tsx  — NAV.filter(n => hasCapability(role, n.cap))
//   • src/components/fgmp/command-palette.tsx — same filter
//   • src/components/fgmp/views/roles-view.tsx — display only
//   • src/app/api/fgmp/me/route.ts — display only
// The two UI filters treat a missing capability as "hide the nav item", and
// app-shell.tsx ALREADY hides `tenants` + `tenant-isolation` for non-SUPERADMIN
// with an extra role check. So dropping those two caps from ADMIN removes the
// duplicate command-palette entry for Tenants (whose only mutating route is
// SUPERADMIN_ONLY) without hiding anything an admin could legitimately use.
//
// Every other `view:*` key the sidebar renders is retained below, because
// ADMIN's routes really do permit those surfaces (settings PUT = ADMIN_ONLY,
// api-keys = SUPER_OR_ADMIN, health = ADMIN_ONLY).
// This is an ALLOW-list, not a deny-list: an unrecognised capability is denied
// for ADMIN until someone adds it here deliberately.
//
// The action capabilities below mirror the ROLES.* allow-lists the API actually
// enforces (see src/lib/fgmp/auth-helpers.ts).
export const ROLE_PERMISSIONS: Record<Role, {
  label: string;
  description: string;
  capabilities: string[]; // fine-grained capability keys
}> = {
  SUPERADMIN: {
    label: "Platform Super-Admin",
    description: "Cross-tenant platform owner. Creates tenants and tenant administrators, manages all platform data.",
    capabilities: ["*"],
  },
  ADMIN: {
    label: "Tenant Administrator",
    description: "Manages users, sites, and configuration within their tenant. Cannot create tenants or super-admins.",
    capabilities: [
      // Views — every nav surface ADMIN's routes actually permit.
      "view:dashboard", "view:sites", "view:fuel", "view:generators", "view:batteries",
      "view:alarms", "view:inventory", "view:analytics", "view:reports", "view:iot",
      "view:maintenance", "view:audit", "view:users", "view:system-health",
      "view:suppressions", "view:preferences", "view:dispensers", "view:asset-registry",
      "view:edge-firmware", "view:fuel-forecast", "view:consumption-patterns",
      "view:roles", "view:geography", "view:system-settings", "view:api-keys",
      // Actions — mirrors ROLES.ALARM_OPS / CONTROL / DELIVERY / MAINTENANCE /
      // NOTIFICATION / EDGE_MANAGE / DISPENSER_CONTROL in auth-helpers.ts.
      "alarm:ack", "alarm:resolve", "alarm:suppress", "alarm:configure",
      "gen:control", "ticket:create", "ticket:assign", "ticket:complete", "ticket:manage",
      "delivery:verify", "delivery:approve", "delivery:manage", "dispenser:control",
      "notification:manage", "edge:manage", "asset:manage", "geography:manage",
      "settings:manage", "api-key:manage", "role:preview",
      // Advancing the telemetry simulation (POST /api/fgmp/tick) is an
      // operator action, gated server-side on ROLES.TICK. The client uses this
      // capability to decide whether to poll /tick or fall back to a plain
      // tenant-scoped state refresh.
      "simul:tick",
      // Tenant-scoped user administration (SUPER_OR_ADMIN routes).
      "user:manage",
      // DELIBERATELY ABSENT — SUPERADMIN only:
      //   view:tenants, view:tenant-isolation, tenant:manage,
      //   platform:firmware, user:grant-superadmin
    ],
  },
  NOC_OPERATOR: {
    label: "NOC Operator",
    description: "Monitor, acknowledge/resolve alarms, remote generator control.",
    capabilities: [
      "view:dashboard", "view:sites", "view:fuel", "view:generators", "view:batteries",
      "view:alarms", "view:inventory", "view:iot", "view:maintenance", "view:audit",
      "view:suppressions", "view:preferences", "view:dispensers",
      "view:asset-registry", "view:edge-firmware", "view:fuel-forecast",
      "view:consumption-patterns",
      "alarm:ack", "alarm:resolve", "alarm:suppress",
      "gen:control", "ticket:create", "delivery:verify", "notification:manage",
      "dispenser:control",
      // Matches ROLES.TICK in auth-helpers.ts.
      "simul:tick",
    ],
  },
  REGIONAL_MANAGER: {
    label: "Regional Manager",
    description: "Regional oversight, reports, deliveries, maintenance scheduling.",
    capabilities: [
      "view:dashboard", "view:sites", "view:fuel", "view:generators", "view:batteries",
      "view:alarms", "view:inventory", "view:analytics", "view:reports", "view:maintenance",
      // Phase 5 task 2: view:audit and view:iot added. Both were on READONLY
      // while absent here, which is the inversion the audit identified — a
      // management role was strictly less able to see than a read-only one.
      "view:suppressions", "view:preferences", "view:dispensers",
      "view:asset-registry", "view:edge-firmware", "view:fuel-forecast",
      "view:consumption-patterns", "view:audit", "view:iot",
      "alarm:ack", "alarm:suppress", "alarm:configure", "delivery:approve",
      "delivery:manage", "ticket:create", "ticket:assign", "ticket:manage",
      // Matches ROLES.TICK in auth-helpers.ts.
      "simul:tick",
    ],
  },
  FIELD_ENGINEER: {
    label: "Field Engineer",
    description: "Execute maintenance, verify deliveries, view telemetry.",
    capabilities: [
      // Phase 5 task 2: view:suppressions added. A field engineer who cannot
      // see which alarms are suppressed will investigate an alarm that an
      // operator deliberately muted, and may conclude the platform is faulty.
      "view:dashboard", "view:sites", "view:fuel", "view:generators", "view:batteries",
      "view:alarms", "view:inventory", "view:iot", "view:maintenance",
      "view:preferences", "view:dispensers", "view:suppressions",
      "view:asset-registry", "view:edge-firmware",
      "ticket:complete", "ticket:manage", "delivery:verify", "delivery:manage",
      "dispenser:control",
    ],
  },
  EXECUTIVE: {
    label: "Executive",
    description: "KPIs, analytics, reports, national overview.",
    /**
     * Executive — Phase 5 task 2.
     *
     * The audit flagged the absence of view:sites / view:fuel / view:generators
     * as an inversion, and it is one, but the root cause is a design decision
     * rather than an oversight: this was an "executive summary" role with no
     * operational navigation at all. The consequence was that an executive
     * could open the analytics dashboard, read a national fuel figure, and then
     * be unable to click through to the site that figure came from — so the
     * number was visible and its provenance was not.
     *
     * These are READ capabilities. An executive still holds no control action:
     * no alarm:ack, no delivery:approve, no ticket:create, no simul:tick. The
     * distinction that matters is that visibility is not authority.
     */
    capabilities: [
      "view:dashboard", "view:analytics", "view:reports", "view:alarms",
      "view:preferences",
      "view:fuel-forecast", "view:consumption-patterns", "view:asset-registry",
      // Read-only operational visibility, added so a national figure can be
      // traced to the site it came from.
      "view:sites", "view:fuel", "view:generators", "view:batteries",
      "view:inventory", "view:dispensers", "view:maintenance", "view:iot",
    ],
  },
  /**
   * Read-Only — Phase 5 task 2.
   *
   * Two corrections. `view:roles` is GONE: a read-only account should not see
   * the permission matrix at all. It exposes no privilege escalation today
   * (there is no roles API, and every role-changing endpoint already requires
   * SUPER_OR_ADMIN — see users/route.ts:89), but a security-sensitive surface
   * should not be advertised to the least-privileged role in the matrix, and
   * advertising it invites exactly the assumption that it is safe to widen.
   *
   * `view:audit` is KEPT deliberately, against the audit's recommendation to
   * move it to REGIONAL_MANAGER. The audit log is read-only evidence about the
   * platform's own operation; a read-only observer who cannot see who changed
   * what cannot audit anything, and removing it made READONLY strictly less
   * able to see than REGIONAL_MANAGER, which is the inversion this task exists
   * to remove. REGIONAL_MANAGER is a management role and now also has it.
   */
  READONLY: {
    label: "Read-Only",
    description: "View all monitoring data; no control actions.",
    capabilities: [
      "view:dashboard", "view:sites", "view:fuel", "view:generators", "view:batteries",
      "view:alarms", "view:inventory", "view:iot", "view:maintenance", "view:analytics",
      "view:reports", "view:audit", "view:preferences", "view:dispensers",
      "view:asset-registry", "view:edge-firmware", "view:fuel-forecast",
      "view:consumption-patterns",
      // A read-only user must not see the system-health surface: it exposes
      // process, database-size and error diagnostics and the API is ADMIN-only.
      "view:suppressions",
    ],
  },
};

export const ALL_ROLES: Role[] = [
  "SUPERADMIN", "ADMIN", "NOC_OPERATOR", "REGIONAL_MANAGER", "FIELD_ENGINEER", "EXECUTIVE", "READONLY",
];

/**
 * Read API route policy. These capabilities mirror the corresponding view
 * permissions and are checked both in the browser (to avoid forbidden fetches)
 * and by `requireAuth` before a handler reaches its database query. An endpoint
 * used by multiple screens accepts any listed capability; this matters for
 * shared dashboard widgets and report exports.
 */
/**
 * Sentinel capability list for an endpoint that NO session role may call.
 *
 * An empty list matches no capability, so the endpoint is denied to every role
 * that arrives with a NextAuth session. That is the correct answer for
 * device-facing routes — `/api/fgmp/iot/ingest` authenticates with a per-tenant
 * API key and `/api/fgmp/realtime/snapshot` with a service token — but as a
 * bare `[]` it is indistinguishable from somebody starting a rule and never
 * finishing it, which is the kind of ambiguity that later gets "fixed" by
 * adding a capability nobody thought about. Naming it makes the intent
 * greppable, and the route-inventory contract check asserts it is used only on
 * routes that actually carry their own non-session credential.
 */
export const NO_SESSION_ROLE: readonly string[] = [];

const API_READ_RULES: readonly { prefix: string; capabilities: readonly string[] }[] = [
  { prefix: "/api/fgmp/admin/tenant-isolation-test", capabilities: ["view:tenant-isolation"] },
  { prefix: "/api/fgmp/alarms", capabilities: ["view:alarms"] },
  { prefix: "/api/fgmp/api-keys", capabilities: ["view:api-keys"] },
  { prefix: "/api/fgmp/audit", capabilities: ["view:audit"] },
  { prefix: "/api/fgmp/batteries", capabilities: ["view:batteries"] },
  { prefix: "/api/fgmp/correlation/rules", capabilities: ["alarm:configure"] },
  { prefix: "/api/fgmp/correlation/matches", capabilities: ["alarm:configure"] },
  { prefix: "/api/fgmp/correlation", capabilities: ["view:alarms"] },
  { prefix: "/api/fgmp/deliveries", capabilities: ["view:inventory"] },
  { prefix: "/api/fgmp/dispensers", capabilities: ["view:dispensers"] },
  { prefix: "/api/fgmp/edge", capabilities: ["view:edge-firmware"] },
  { prefix: "/api/fgmp/forecast", capabilities: ["view:fuel-forecast"] },
  { prefix: "/api/fgmp/fuel/runout-eta", capabilities: ["view:dashboard", "view:fuel-forecast"] },
  { prefix: "/api/fgmp/generators", capabilities: ["view:generators"] },
  { prefix: "/api/fgmp/geography", capabilities: ["view:geography"] },
  { prefix: "/api/fgmp/health", capabilities: ["view:system-health"] },
  { prefix: "/api/fgmp/history", capabilities: ["view:sites", "view:fuel", "view:generators", "view:batteries", "view:asset-registry"] },
  { prefix: "/api/fgmp/interlocks/thresholds", capabilities: ["view:system-settings"] },
  { prefix: "/api/fgmp/iot/ingest", capabilities: NO_SESSION_ROLE },
  { prefix: "/api/fgmp/iot", capabilities: ["view:iot"] },
  { prefix: "/api/fgmp/realtime/snapshot", capabilities: NO_SESSION_ROLE },
  { prefix: "/api/fgmp/maintenance", capabilities: ["view:maintenance"] },
  { prefix: "/api/fgmp/metrics", capabilities: ["alarm:ack"] },
  { prefix: "/api/fgmp/ops/alerts", capabilities: ["alarm:ack"] },
  { prefix: "/api/fgmp/notifications", capabilities: ["view:dashboard"] },
  { prefix: "/api/fgmp/patterns", capabilities: ["view:consumption-patterns"] },
  { prefix: "/api/fgmp/platform/audit", capabilities: ["view:tenants"] },
  { prefix: "/api/fgmp/platform/grants", capabilities: ["view:tenants"] },
  { prefix: "/api/fgmp/platform/support-sessions", capabilities: ["view:tenants"] },
  { prefix: "/api/fgmp/platform/support/", capabilities: ["view:tenants"] },
  { prefix: "/api/fgmp/preferences/", capabilities: ["view:users"] },
  { prefix: "/api/fgmp/reports", capabilities: ["view:reports", "view:generators"] },
  { prefix: "/api/fgmp/settings", capabilities: ["view:system-settings"] },
  { prefix: "/api/fgmp/shift-handover", capabilities: ["view:dashboard"] },
  { prefix: "/api/fgmp/sites", capabilities: ["view:sites"] },
  { prefix: "/api/fgmp/solar-arrays", capabilities: ["view:sites", "view:asset-registry"] },
  { prefix: "/api/fgmp/solar-sites", capabilities: ["view:sites", "view:asset-registry"] },
  { prefix: "/api/fgmp/state", capabilities: ["view:dashboard"] },
  { prefix: "/api/fgmp/tick", capabilities: ["simul:tick"] },
  { prefix: "/api/fgmp/suppressions", capabilities: ["view:suppressions"] },
  { prefix: "/api/fgmp/tanks", capabilities: ["view:fuel", "view:inventory"] },
  { prefix: "/api/fgmp/tenants", capabilities: ["view:tenants"] },
  { prefix: "/api/fgmp/users", capabilities: ["view:users"] },
];

/**
 * The datasets `GET /api/fgmp/export?type=` can actually produce, and who may
 * read each one.
 *
 * One table, two consumers: `apiReadCapabilities()` authorises against it and
 * the route validates its `type` parameter against it. It used to be two — the
 * policy listed `alarms` and `deliveries`, which the handler never implemented,
 * and the handler's `else` branch answered every unrecognised type with a
 * **sites** export. So `?type=alarms` asked the policy one question and returned
 * another dataset, under a filename that said `alarms`. Neither the policy nor
 * the payload was wrong on its own; the gap between them was.
 *
 * `view:iot` and `view:inventory` are deliberately absent from `sites`: the two
 * screens that used to trigger that grant (IoT, Inventory) were exporting site
 * records from screens that are not about sites, and every role that holds
 * either capability also holds `view:sites` — so the grant bought nothing and
 * permitted an inventory-only role to read site coordinates.
 */
export const EXPORT_TYPE_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  sites: ["view:sites", "view:reports"],
  tanks: ["view:fuel", "view:reports"],
  generators: ["view:generators", "view:reports"],
  batteries: ["view:batteries", "view:reports"],
};

/** Return the any-of capabilities required to read an FGMP API URL. */
export function apiReadCapabilities(url: string | URL): readonly string[] | null {
  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(url, "https://fgmp.invalid");
  } catch {
    return null;
  }
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";

  if (pathname === "/api/fgmp/analytics") {
    // This shared endpoint is projected to the requesting view. Do not let a
    // dashboard/fuel/inventory role inherit the full analytics payload.
    switch (parsed.searchParams.get("projection")) {
      case "dashboard": return ["view:dashboard"];
      case "fuel": return ["view:fuel"];
      case "inventory": return ["view:inventory"];
      case "analytics":
      default: return ["view:analytics"];
    }
  }

  if (pathname === "/api/fgmp/reports") {
    // The generators view requests only its daily command-history slice. Do not
    // let that support request grant non-report roles the full report API.
    return (parsed.searchParams.get("period") ?? "daily") === "daily"
      ? ["view:reports", "view:generators"]
      : ["view:reports"];
  }

  if (pathname === "/api/fgmp/export") {
    return EXPORT_TYPE_CAPABILITIES[parsed.searchParams.get("type") ?? "sites"] ?? ["view:reports"];
  }

  // Read access to control-command history is restricted to the same operators
  // who may issue the command, even though the parent generators view is wider.
  if (/^\/api\/fgmp\/generators\/[^/]+\/control\/[^/]+$/.test(pathname)) {
    return ["gen:control"];
  }

  // Longest-prefix-first, matching API_WRITE_RULES — NOT the first array entry
  // that happens to fit.
  //
  // The rules are currently listed specific-before-general (`/correlation/rules`
  // before `/correlation`, `/iot/ingest` before `/iot`) so `.find()` resolves
  // every existing path identically; that was verified against all 107 route
  // paths before this change. But "the array is in the right order" is an
  // invariant nobody can see at the point of edit, and its failure mode is
  // fail-OPEN: inserting a broad rule such as
  // `{ prefix: "/api/fgmp/platform", capabilities: ["view:dashboard"] }` above
  // the existing platform rules would silently hand the audit, grants and
  // support-session surfaces to every dashboard reader. Sorting makes the
  // outcome independent of list order, which is what docs/AUTHZ.md §1.3 already
  // claims, and what the write rules already do.
  const rule = API_READ_RULES
    .filter(({ prefix }) =>
      pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
    )
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return rule?.capabilities ?? null;
}

const API_WRITE_RULES: readonly { method: string; prefix: string; capabilities: readonly string[] }[] = [
  { method: "POST", prefix: "/api/fgmp/alarms", capabilities: ["alarm:ack", "alarm:resolve"] },
  { method: "PATCH", prefix: "/api/fgmp/alarms", capabilities: ["alarm:ack", "alarm:resolve"] },
  { method: "POST", prefix: "/api/fgmp/api-keys", capabilities: ["api-key:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/api-keys", capabilities: ["api-key:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/api-keys", capabilities: ["api-key:manage"] },
  { method: "POST", prefix: "/api/fgmp/batteries", capabilities: ["asset:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/batteries", capabilities: ["asset:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/batteries", capabilities: ["asset:manage"] },
  { method: "POST", prefix: "/api/fgmp/correlation", capabilities: ["alarm:configure"] },
  { method: "PATCH", prefix: "/api/fgmp/correlation", capabilities: ["alarm:configure"] },
  { method: "DELETE", prefix: "/api/fgmp/correlation", capabilities: ["alarm:configure"] },
  { method: "POST", prefix: "/api/fgmp/deliveries", capabilities: ["delivery:manage"] },
  { method: "POST", prefix: "/api/fgmp/dispensers", capabilities: ["asset:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/dispensers", capabilities: ["asset:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/dispensers", capabilities: ["asset:manage"] },
  { method: "POST", prefix: "/api/fgmp/dispensers/", capabilities: ["dispenser:control"] },
  { method: "PATCH", prefix: "/api/fgmp/dispensers/", capabilities: ["asset:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/dispensers/", capabilities: ["asset:manage"] },
  { method: "POST", prefix: "/api/fgmp/edge/esp", capabilities: ["dispenser:control"] },
  { method: "POST", prefix: "/api/fgmp/edge/firmware/deploy", capabilities: ["dispenser:control"] },
  { method: "POST", prefix: "/api/fgmp/edge/gateways", capabilities: ["edge:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/edge/gateways", capabilities: ["edge:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/edge/gateways", capabilities: ["edge:manage"] },
  { method: "POST", prefix: "/api/fgmp/edge/firmware", capabilities: ["platform:firmware"] },
  { method: "DELETE", prefix: "/api/fgmp/edge/firmware", capabilities: ["platform:firmware"] },
  { method: "POST", prefix: "/api/fgmp/generators", capabilities: ["asset:manage"] },
  { method: "POST", prefix: "/api/fgmp/generators/", capabilities: ["gen:control", "asset:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/generators", capabilities: ["asset:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/generators", capabilities: ["asset:manage"] },
  { method: "POST", prefix: "/api/fgmp/geography", capabilities: ["geography:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/geography", capabilities: ["geography:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/geography", capabilities: ["geography:manage"] },
  { method: "POST", prefix: "/api/fgmp/interlocks/thresholds", capabilities: ["settings:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/interlocks/thresholds", capabilities: ["settings:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/interlocks/thresholds", capabilities: ["settings:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/iot", capabilities: ["edge:manage"] },
  { method: "POST", prefix: "/api/fgmp/iot/ingest", capabilities: NO_SESSION_ROLE },
  { method: "POST", prefix: "/api/fgmp/iot", capabilities: ["edge:manage"] },
  { method: "POST", prefix: "/api/fgmp/maintenance", capabilities: ["ticket:manage"] },
  { method: "POST", prefix: "/api/fgmp/maintenance/", capabilities: ["ticket:manage"] },
  { method: "POST", prefix: "/api/fgmp/me/preview-role", capabilities: ["role:preview"] },
  { method: "POST", prefix: "/api/fgmp/notifications", capabilities: ["notification:manage"] },
  { method: "POST", prefix: "/api/fgmp/seed", capabilities: ["asset:manage"] },
  { method: "POST", prefix: "/api/fgmp/shift-handover", capabilities: ["alarm:ack", "delivery:manage", "ticket:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/shift-handover", capabilities: ["alarm:ack", "delivery:manage", "ticket:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/shift-handover", capabilities: ["settings:manage"] },
  { method: "POST", prefix: "/api/fgmp/sites", capabilities: ["asset:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/sites", capabilities: ["asset:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/sites", capabilities: ["asset:manage"] },
  { method: "POST", prefix: "/api/fgmp/solar-arrays", capabilities: ["asset:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/solar-arrays", capabilities: ["asset:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/solar-arrays", capabilities: ["asset:manage"] },
  { method: "POST", prefix: "/api/fgmp/solar-sites", capabilities: ["asset:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/solar-sites", capabilities: ["asset:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/solar-sites", capabilities: ["asset:manage"] },
  { method: "POST", prefix: "/api/fgmp/suppressions", capabilities: ["alarm:suppress"] },
  { method: "PATCH", prefix: "/api/fgmp/suppressions", capabilities: ["alarm:suppress"] },
  { method: "DELETE", prefix: "/api/fgmp/suppressions", capabilities: ["settings:manage"] },
  { method: "POST", prefix: "/api/fgmp/tanks", capabilities: ["asset:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/tanks", capabilities: ["asset:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/tanks", capabilities: ["asset:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/settings", capabilities: ["settings:manage"] },
  { method: "POST", prefix: "/api/fgmp/platform/support-sessions", capabilities: ["tenant:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/platform/support-sessions", capabilities: ["tenant:manage"] },
  { method: "POST", prefix: "/api/fgmp/platform/support/", capabilities: ["tenant:manage"] },
  { method: "PUT", prefix: "/api/fgmp/preferences/", capabilities: ["user:manage"] },
  { method: "POST", prefix: "/api/fgmp/tenants", capabilities: ["tenant:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/tenants", capabilities: ["tenant:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/tenants", capabilities: ["tenant:manage"] },
  { method: "POST", prefix: "/api/fgmp/users", capabilities: ["user:manage"] },
  { method: "PATCH", prefix: "/api/fgmp/users", capabilities: ["user:manage"] },
  { method: "PUT", prefix: "/api/fgmp/users", capabilities: ["user:manage"] },
  { method: "DELETE", prefix: "/api/fgmp/users", capabilities: ["user:manage"] },
  { method: "POST", prefix: "/api/fgmp/mfa/reset", capabilities: ["user:manage"] },
  { method: "GET", prefix: "/api/fgmp/tick", capabilities: ["simul:tick"] },
  { method: "POST", prefix: "/api/fgmp/tick", capabilities: ["simul:tick"] },
];

/** Return the any-of capabilities required for an API request, if mapped. */
export function apiRequestCapabilities(method: string, url: string | URL): readonly string[] | null {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET") return apiReadCapabilities(url);
  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(url, "https://fgmp.invalid");
  } catch {
    return null;
  }
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  const rule = API_WRITE_RULES
    .filter((entry) =>
      entry.method === normalizedMethod &&
      (pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`) || (entry.prefix.endsWith("/") && pathname.startsWith(entry.prefix))),
    )
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return rule?.capabilities ?? null;
}

/**
 * Endpoints that every AUTHENTICATED role may call, regardless of capability.
 *
 * Exported because it is half of the authorization contract: `canAccessApi`
 * denies an unmapped `/api/fgmp/**` path, and this list is the only way a route
 * can be reachable without a capability entry. The contract check in
 * scripts/verify/route-inventory.ts must be able to read it to tell "deliberately
 * role-agnostic" apart from "somebody forgot to write a policy".
 */
export const AUTH_ONLY_API_RULES: readonly { method: string; path: string }[] = [
  { method: "GET", path: "/api/fgmp/me" },
  { method: "DELETE", path: "/api/fgmp/me/preview-role" },
  { method: "GET", path: "/api/fgmp/preferences" },
  { method: "PUT", path: "/api/fgmp/preferences" },
  { method: "POST", path: "/api/fgmp/mfa/challenge" },
  { method: "POST", path: "/api/fgmp/mfa/challenge-request" },
  { method: "POST", path: "/api/fgmp/mfa/disable" },
  { method: "POST", path: "/api/fgmp/mfa/enrol" },
  { method: "GET", path: "/api/fgmp/mfa/status" },
  { method: "POST", path: "/api/fgmp/mfa/verify-enrol" },
  { method: "GET", path: "/api/fgmp/proposal" },
  { method: "GET", path: "/api/fgmp/realtime/channel" },
  { method: "POST", path: "/api/fgmp/realtime/auth" },
];

/**
 * Shared browser/server policy check. Unknown FGMP endpoints fail closed; only
 * the explicitly listed account/auth flows are intentionally role-agnostic.
 * This prevents a newly added route from silently becoming a client-accessible
 * API until its view/action policy has been reviewed.
 */
export function canAccessApi(role: Role | string | undefined | null, url: string | URL, method = "GET"): boolean {
  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(url, "https://fgmp.invalid");
  } catch {
    return false;
  }
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  const normalizedMethod = method.toUpperCase();
  const required = apiRequestCapabilities(normalizedMethod, parsed);
  if (required === null) {
    if (!pathname.startsWith("/api/fgmp/")) return true;
    return AUTH_ONLY_API_RULES.some((rule) => rule.method === normalizedMethod && rule.path === pathname);
  }
  if (!role || !(role in ROLE_PERMISSIONS)) return false;
  return required.some((capability) => hasCapability(role as Role, capability));
}

/**
 * SUPERADMIN-only capability keys.
 *
 * These name the surfaces that are NOT tenant-scoped — they guard global
 * platform tables (`Tenant`, and `EspFirmwareRelease` / `SystemSetting`, which
 * have no `tenantId` column at all — see prisma/schema.prisma). Only
 * SUPERADMIN holds them (via the `*` wildcard), which is why ADMIN's explicit
 * list in ROLE_PERMISSIONS above omits them.
 */
export const SUPERADMIN_ONLY_CAPABILITIES = [
  "tenant:manage",
  "view:tenants",
  "view:tenant-isolation",
  "platform:firmware",
  "user:grant-superadmin",
] as const;

/** Whether the given role is the platform-level super-admin. Capability, not a
 *  tenant context: see the note on `ROLE_PERMISSIONS.SUPERADMIN`. */
export function isSuperAdmin(role: Role | string | undefined | null): boolean {
  return role === "SUPERADMIN";
}

/**
 * Capability check.
 *
 * Only SUPERADMIN holds the `"*"` wildcard, so the wildcard branch is now
 * exactly equivalent to "is super-admin" — no other role can accidentally
 * inherit it. Every other role is checked against its EXPLICIT list, so an
 * unknown capability is denied by default (allow-list semantics).
 */
export function hasCapability(role: Role, cap: string): boolean {
  const perms = ROLE_PERMISSIONS[role]?.capabilities ?? [];
  if (perms.includes("*")) return true;
  return perms.includes(cap);
}

export function canView(role: Role, viewKey: string): boolean {
  return hasCapability(role, `view:${viewKey}`);
}
