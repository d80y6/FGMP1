import type { Role } from "./types";

export interface Permission {
  view: string; // dashboard view key
}

// Capability matrix per role.
//
// Role hierarchy (Task 49 — Super-admin model):
//   SUPERADMIN — platform-level, cross-tenant. Creates tenants + tenant ADMINs.
//                Bypasses tenant isolation entirely (see auth-helpers.ts).
//                Holds the `*` wildcard — the ONLY role that does.
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
// api-keys = SUPER_OR_ADMIN, backups = SUPER_OR_ADMIN, health = ADMIN_ONLY).
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
      "view:backup",
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
      "user:manage", "backup:manage",
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
      "view:suppressions", "view:preferences", "view:dispensers",
      "view:asset-registry", "view:edge-firmware", "view:fuel-forecast",
      "view:consumption-patterns",
      "alarm:ack", "delivery:approve", "ticket:create", "ticket:assign",
      // Matches ROLES.TICK in auth-helpers.ts.
      "simul:tick",
    ],
  },
  FIELD_ENGINEER: {
    label: "Field Engineer",
    description: "Execute maintenance, verify deliveries, view telemetry.",
    capabilities: [
      "view:dashboard", "view:sites", "view:fuel", "view:generators", "view:batteries",
      "view:alarms", "view:inventory", "view:iot", "view:maintenance",
      "view:preferences", "view:dispensers",
      "view:asset-registry", "view:edge-firmware",
      "ticket:complete", "delivery:verify",
    ],
  },
  EXECUTIVE: {
    label: "Executive",
    description: "KPIs, analytics, reports, national overview.",
    capabilities: [
      "view:dashboard", "view:analytics", "view:reports", "view:alarms",
      "view:preferences",
      "view:fuel-forecast", "view:consumption-patterns", "view:asset-registry",
    ],
  },
  READONLY: {
    label: "Read-Only",
    description: "View all monitoring data; no control actions.",
    capabilities: [
      "view:dashboard", "view:sites", "view:fuel", "view:generators", "view:batteries",
      "view:alarms", "view:inventory", "view:iot", "view:maintenance", "view:analytics",
      "view:reports", "view:audit", "view:preferences", "view:dispensers",
      "view:asset-registry", "view:edge-firmware", "view:fuel-forecast",
      "view:consumption-patterns", "view:roles", "view:system-health",
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

/** Whether the given role is the platform-level super-admin (cross-tenant). */
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

// ── Session (in-memory, single active operator) ────────────────────────────
// Production auth is handled by NextAuth (Task 31-A, src/lib/auth.ts) and the
// session is the source of truth. getCurrentUser() below first consults the
// server-side NextAuth session; if there is one, it returns the authenticated
// user (so audit logs + DB writes are attributed to the real operator).
//
// The legacy "mock user" fallback is preserved for boot-time paths that run
// before any HTTP request has a session (seed scripts, the seed-admin CLI,
// and the engine's internal tick when invoked without a request scope). In
// normal request handling the session is always present (requireAuth() at the
// top of each route enforces it).

import { db } from "@/lib/db";

const DEFAULT_USER = {
  id: "u-noc-1",
  name: "A. Al-Rashid",
  email: "noc.operator@fgmp.telecom",
  role: "NOC_OPERATOR" as Role,
  tenantId: "t-default",
};

let _current: { id: string; name: string; email: string; role: Role; tenantId: string } | null = null;

export async function getCurrentUser() {
  // Prefer the NextAuth session if one is present in this request scope.
  try {
    const { getServerSession } = await import("next-auth");
    const { authOptions } = await import("@/lib/auth");
    const session = await getServerSession(authOptions);
    if (session?.user?.id) {
      return {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        role: session.user.role as Role,
        tenantId: session.user.tenantId,
      };
    }
  } catch {
    // Import-time / seed-script contexts where next-auth isn't reachable —
    // fall through to the legacy mock-user path below.
  }

  if (_current) return _current;
  // Ensure a DB user row exists for audit linkage (used by seed scripts and
  // any code path that runs without an HTTP session).
  try {
    const tenant = await db.tenant.upsert({
      where: { code: "NATIONAL-TELCO" },
      update: {},
      create: { id: "t-default", name: "National Telecom Operator", code: "NATIONAL-TELCO", country: "Yemen" },
    });
    const user = await db.user.upsert({
      where: { email: DEFAULT_USER.email },
      update: {},
      create: { id: DEFAULT_USER.id, tenantId: tenant.id, email: DEFAULT_USER.email, name: DEFAULT_USER.name, role: DEFAULT_USER.role },
    });
    _current = { id: user.id, name: user.name, email: user.email, role: user.role as Role, tenantId: user.tenantId };
  } catch {
    _current = { ...DEFAULT_USER };
  }
  return _current;
}

export async function setCurrentRole(role: Role) {
  const u = await getCurrentUser();
  _current = { ...u, role };
  try {
    await db.user.update({ where: { id: u.id }, data: { role } });
  } catch {
    /* ignore */
  }
  return _current;
}
