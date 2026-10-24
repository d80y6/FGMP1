/**
 * Database access for the platform (super-admin) surface.
 *
 * ── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────
 * Route handlers are forbidden from importing the raw Prisma client (see the
 * `no-restricted-imports` rule in eslint.config.mjs), because a `db.*` call
 * without a tenant context silently returns zero rows under FORCE RLS. That
 * rule has one documented exception: "explicit owner-path modules that document
 * WHY they are cross-tenant". This is one.
 *
 * Everything here is one of exactly three kinds of access, each with its own
 * justification:
 *
 *   1. PLATFORM TABLES (`SupportSession`, `PlatformAuditLog`). They carry no
 *      `tenantId` and have no RLS, by design — see the header of
 *      20261023000000_platform_support_access. Reading them without a context is
 *      the intended access path, not a mistake. They hold NO customer content:
 *      which operator may act as which tenant, and what that operator did.
 *
 *   2. THE TENANT REGISTRY (`Tenant`). Also has no `tenantId` column and no RLS;
 *      it is platform metadata (name, code, country). Reading it unscoped is how
 *      `/api/fgmp/tenants` already works. Its RELATIONS do carry tenantId, so
 *      anything that touches users/sites is done per-tenant below.
 *
 *   3. PER-TENANT READS through `withTenant`, one call per tenant. There is no
 *      bypass-role read anywhere in this file: to see a tenant's rows we set
 *      that tenant's context, exactly like a tenant request does. The cost is
 *      O(tenants) and the benefit is that "the app can read every tenant" is
 *      never true — only "the app can read one tenant at a time, on an explicit
 *      platform decision".
 *
 * Nothing here is callable without a SUPERADMIN guard in the route that uses
 * it. That is enforced by `src/lib/fgmp/__tests__/platform-surface.test.ts`,
 * which fails if a route under /api/fgmp/platform/ imports this module without
 * also importing `requireSuperAdmin`.
 */

import { db } from "@/lib/db";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { getOpsDb } from "@/lib/fgmp/owner-db";

export interface SupportSessionView {
  id: string;
  tenantId: string;
  mode: string;
  reason: string;
  ticketRef: string | null;
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: string | null;
}

/** Recent support sessions for one operator (the caller's own — never another
 *  operator's, which is why the actor id is a required argument). */
export function listSupportSessionsFor(actorUserId: string, take = 50): Promise<SupportSessionView[]> {
  return db.supportSession.findMany({
    where: { actorUserId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      tenantId: true,
      mode: true,
      reason: true,
      ticketRef: true,
      createdAt: true,
      expiresAt: true,
      endedAt: true,
      endReason: true,
    },
  });
}

/** One session, for the operator's own review screen. */
export function getSupportSession(id: string) {
  return db.supportSession.findUnique({ where: { id } });
}

export interface PlatformAuditQuery {
  limit: number;
  offset: number;
  actor?: string | null;
  tenant?: string | null;
  action?: string | null;
}

/** The platform trail. Platform-only rows; no customer content. */
export async function listPlatformAudit(q: PlatformAuditQuery) {
  const where: Record<string, unknown> = {};
  if (q.actor) where.actorUserId = q.actor;
  if (q.tenant) where.targetTenantId = q.tenant;
  if (q.action) where.action = q.action;

  const [entries, total] = await Promise.all([
    db.platformAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: q.limit, skip: q.offset }),
    db.platformAuditLog.count({ where }),
  ]);
  return { entries, total };
}

/** Tenant registry rows (no relations). */
export function listTenants() {
  return db.tenant.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, code: true, country: true, createdAt: true },
  });
}

export function getTenantMeta(tenantId: string) {
  return db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, code: true, country: true, createdAt: true },
  });
}

/** The columns `listAllGrants` reads per user. Named so the explicit generic
 *  below states the contract without depending on a generated Prisma type. */
interface UserGrantFields {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface GrantRow {
  tenantId: string;
  tenantName: string;
  tenantCode: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/**
 * Every user in every tenant, for the access-review export.
 *
 * One scoped read per tenant. Deliberately sequential rather than
 * `Promise.all`: each call holds a pooled connection for the duration of an
 * interactive transaction, and an installation with many tenants would open
 * as many transactions at once. An export is a background chore; slow and
 * polite beats fast and connection-starving.
 */
export async function listAllGrants(tenantFilter?: string | null): Promise<GrantRow[]> {
  const tenants = await db.tenant.findMany({
    where: tenantFilter ? { id: tenantFilter } : {},
    orderBy: { name: "asc" },
    select: { id: true, name: true, code: true },
  });

  const rows: GrantRow[] = [];
  for (const t of tenants) {
    // The explicit type argument keeps the contract visible even in a checkout
    // where the Prisma client has not been generated (the callback's return
    // type degrades to `unknown` there, which would otherwise make this look
    // like an unsafe read rather than a typed one).
    const users = await withTenant<UserGrantFields[]>(t.id, (tx) =>
      tx.user.findMany({
        orderBy: [{ role: "asc" }, { email: "asc" }],
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          active: true,
          lastLoginAt: true,
          createdAt: true,
        },
      }),
    );
    for (const u of users) {
      rows.push({
        tenantId: t.id,
        tenantName: t.name,
        tenantCode: t.code,
        userId: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        active: u.active,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
      });
    }
  }
  return rows;
}

/**
 * Orientation figures for the support session's tenant.
 *
 * All of this runs inside ONE `withTenant` transaction, so it is a consistent
 * snapshot of a single tenant — and it is the tenant the session names, passed
 * in by the caller only after `assertSupportTenant`.
 */
export function tenantSummary(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const [users, sites, tanks, generators, openAlarms, tickets, deliveries] = await Promise.all([
      tx.user.count(),
      tx.site.count(),
      tx.fuelTank.count(),
      tx.generator.count(),
      tx.alarm.count({ where: { status: "OPEN" } }),
      tx.maintenanceTicket.count({ where: { status: { notIn: ["DONE", "CANCELLED"] } } }),
      tx.fuelDelivery.count(),
    ]);
    const recentAlarms = await tx.alarm.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        type: true,
        severity: true,
        status: true,
        message: true,
        createdAt: true,
        site: { select: { name: true } },
      },
    });
    return { users, sites, tanks, generators, openAlarms, tickets, deliveries, recentAlarms };
  });
}

/** Append a support note to the tenant's own audit log (see the POST route). */
export async function createSupportNote(args: {
  tenantId: string;
  supportSessionId: string;
  actorUserId: string;
  actorEmail: string | null;
  ticketRef: string | null;
  note: string;
  ip: string | null;
}): Promise<{ id: string; createdAt: Date }> {
  return withTenant(args.tenantId, (tx) =>
    tx.auditLog.create({
      data: {
        tenantId: args.tenantId,
        // Null on purpose: the operator lives in another tenant. See
        // platform-audit.ts for the full reasoning.
        userId: null,
        action: "SUPPORT_NOTE",
        entity: "SupportSession",
        entityId: args.supportSessionId,
        details: JSON.stringify({
          note: args.note,
          actorUserId: args.actorUserId,
          actorEmail: args.actorEmail,
          actorKind: "platform-support",
          ticketRef: args.ticketRef,
        }),
        ip: args.ip,
      },
      select: { id: true, createdAt: true },
    }),
  );
}

/** Tenant registry rows for the control-plane list (no relations). */
export function listTenantRegistry() {
  return db.tenant.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, code: true, country: true, createdAt: true, updatedAt: true },
  });
}

/**
 * Counts for ONE tenant, read inside that tenant's context.
 *
 * The tenants list used to compute these with Prisma `_count` inside
 * `asTenant(user, …)`, which meant a super-admin listing the fleet saw every
 * tenant's row with THEIR OWN tenant's counts — `t-default: users 0`, because
 * the counts were resolved in the platform tenant's context. The numbers looked
 * plausible and were wrong, which is the worst kind of wrong.
 *
 * Here each tenant's counts come from that tenant's own context, so the figure
 * attributed to a tenant is that tenant's figure. The cost is one short
 * transaction per tenant on a platform-only screen.
 */
export function tenantCounts(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const [users, sites, suppressions] = await Promise.all([
      tx.user.count(),
      tx.site.count(),
      tx.alarmSuppression.count(),
    ]);
    return { users, sites, suppressions };
  });
}

/**
 * Counts for EVERY tenant in three queries instead of three per tenant.
 *
 * ── WHY THIS EXISTS (performance, 2026-10) ──────────────────────────────────
 * `GET /api/fgmp/tenants` looped over the registry calling `tenantCounts()` per
 * row: one transaction and three `count(*)` scans per tenant. With three tenants
 * that is 9 statements plus 3 `BEGIN`/`SET LOCAL`/`COMMIT` cycles; the cost grows
 * linearly with the customer base while the payload stays the same size, so the
 * platform admin screen gets slower as the platform succeeds.
 *
 * Aggregate counts are numbers, not rows: docs/SECURITY.md §3 explicitly allows
 * cross-tenant NUMBERS on the ops connection as long as they are never joined
 * into a row set ("Cross-tenant *numbers* … are read on the ops connection and
 * never joined into a row set"). One `groupBy` per table on that connection
 * returns a tenantId→count map, which is joined to the registry in MEMORY.
 *
 * The tenant-scoped `tenantCounts()` above is deliberately kept: it is the
 * correct primitive when a single tenant's counts are needed, and it is what the
 * regression test compares this fan-out against.
 */
export async function tenantCountsAll(
  tenantIds: readonly string[],
): Promise<Map<string, { users: number; sites: number; suppressions: number }>> {
  const out = new Map<string, { users: number; sites: number; suppressions: number }>();
  if (tenantIds.length === 0) return out;

  const client = getOpsDb() ?? db;
  const [users, sites, suppressions] = await Promise.all([
    client.user.groupBy({ by: ["tenantId"], _count: { _all: true } }),
    client.site.groupBy({ by: ["tenantId"], _count: { _all: true } }),
    client.alarmSuppression.groupBy({ by: ["tenantId"], _count: { _all: true } }),
  ]);

  for (const id of tenantIds) out.set(id, { users: 0, sites: 0, suppressions: 0 });
  for (const row of users) {
    const entry = out.get(row.tenantId);
    if (entry) entry.users = row._count._all;
  }
  for (const row of sites) {
    const entry = out.get(row.tenantId);
    if (entry) entry.sites = row._count._all;
  }
  for (const row of suppressions) {
    const entry = out.get(row.tenantId);
    if (entry) entry.suppressions = row._count._all;
  }
  return out;
}
