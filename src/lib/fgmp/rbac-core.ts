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
      "alarm:ack", "alarm:resolve", "gen:control", "ticket:create", "ticket:assign",
      "ticket:complete", "delivery:verify", "delivery:approve", "dispenser:control",
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
      "alarm:ack", "alarm:resolve", "gen:control", "ticket:create", "delivery:verify",
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
      "alarm:ack", "delivery:approve", "ticket:create", "ticket:assign",
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
      "ticket:complete", "delivery:verify",
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
      "view:consumption-patterns", "view:system-health",
      // Phase 5 task 2: added. Every other role had it, so a read-only observer
      // could not tell a muted alarm from a real one — the same blindness this
      // task fixed for FIELD_ENGINEER.
      "view:suppressions",
    ],
  },
};

export const ALL_ROLES: Role[] = [
  "SUPERADMIN", "ADMIN", "NOC_OPERATOR", "REGIONAL_MANAGER", "FIELD_ENGINEER", "EXECUTIVE", "READONLY",
];

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
