import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { engine, bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { audit } from "@/lib/fgmp/audit";
import { requireAuth, requireRole, assertTenantOwned, ROLES } from "@/lib/fgmp/auth-helpers";
import { resolveGeographyPath, attachGeographyNames } from "@/lib/fgmp/geography";

export const dynamic = "force-dynamic";

// ── Yemen territorial bounds ────────────────────────────────────────────────
// Mirrors /api/fgmp/sites/route.ts. Used to validate manual lat/lng entries on
// site update. Generous bounds so legit in-country entries never trip the check.
const YEMEN_LAT_MIN = 12.0;
const YEMEN_LAT_MAX = 19.0;
const YEMEN_LNG_MIN = 42.0;
const YEMEN_LNG_MAX = 53.0;

const CRITICALITY_VALUES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const POWER_SOURCE_VALUES = ["GRID", "GENERATOR", "HYBRID"] as const;
const STATUS_VALUES = ["ONLINE", "DEGRADED", "OFFLINE", "MAINTENANCE"] as const;

// Region carries a tenantId and is RLS-protected, so it can be included
// directly. Governorate and District do NOT: migration 20261007000000 revoked
// SELECT on both from `fgmp_app` precisely because they had no tenantId to
// filter on. Including them raises `permission denied for table Governorate`
// and 500s the route. `attachGeographyNames` supplies those two names from the
// tenant-filtered `v_geography` view instead.
const siteInclude = {
  region: true,
} as const;

const updateSiteSchema = z
  .object({
    code: z.string().min(3).max(40).optional(),
    name: z.string().min(2).max(200).optional(),
    regionId: z.string().cuid().optional(),
    governorateId: z.string().cuid().optional(),
    districtId: z.string().cuid().optional(),
    latitude: z.number().min(YEMEN_LAT_MIN).max(YEMEN_LAT_MAX).optional(),
    longitude: z.number().min(YEMEN_LNG_MIN).max(YEMEN_LNG_MAX).optional(),
    address: z.string().max(500).optional(),
    criticality: z.enum(CRITICALITY_VALUES).optional(),
    loadKw: z.number().min(0).optional(),
    powerSource: z.enum(POWER_SOURCE_VALUES).optional(),
    gridAvailable: z.boolean().optional(),
    status: z.enum(STATUS_VALUES).optional(),
  })
  .refine(
    (d) => {
      // If any of the hierarchy ids is supplied, ALL three must be supplied —
      // the hierarchy is only ever moved as a unit (region → gov → district).
      const ids = [d.regionId, d.governorateId, d.districtId].filter(Boolean).length;
      return ids === 0 || ids === 3;
    },
    { message: "regionId, governorateId and districtId must be supplied together", path: ["regionId"] },
  );

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await params;

    // ── Tenant scoping ────────────────────────────────────────────────────
    // Site is RLS-protected with FORCE, so the ownership question has to be
    // answered in the QUERY: an unscoped read returns no rows at all and
    // assertTenantOwned(site ?? null) then rejects a site the caller genuinely
    // owns. The site row is fetched inside asTenant first, and only if it
    // belongs to this caller do the child reads run.
    const owned = await asTenant(user, (tx) =>
      tx.site.findFirst({
        where: { id, tenantId: tenantIdOrThrow(user.tenantId) },
        select: { id: true },
      }),
    );
    if (!owned) {
      // Identical to a non-existent id on purpose — a distinguishable response
      // would let an attacker probe which site ids exist.
      const res = NextResponse.json({ error: "Site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const site = engine.sites.find((s) => s.id === id);
    const denied = assertTenantOwned(site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    const tanks = engine.tanks.filter((t) => t.siteId === id);
    const generators = engine.generators.filter((g) => g.siteId === id);
    const batteries = engine.batteries.filter((b) => b.siteId === id);
    const iot = engine.iotDevices.filter((d) => d.siteId === id);
    // Child tables are all RLS-protected too, so they run on the transaction
    // client — on the ambient db they would return empty arrays and the panel
    // would silently show "no alarms" on a site full of them.
    const [alarms, deliveries, tickets] = await asTenant(user, async (tx) =>
      Promise.all([
        tx.alarm.findMany({ where: { siteId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
        tx.fuelDelivery.findMany({ where: { siteId: id }, orderBy: { scheduledAt: "desc" }, take: 20 }),
        tx.maintenanceTicket.findMany({ where: { siteId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
      ]),
    );
    const res = NextResponse.json({ site, tanks, generators, batteries, iot, alarms, deliveries, tickets });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/sites/[id]
 * Update an existing site. ADMIN-only. Zod-validated, audited, rate-limited at
 * MUTATION_LIMIT. Supports partial updates — only the supplied fields are
 * written. If the geographic hierarchy is moved (region/gov/district), all
 * three ids must be supplied together and the hierarchy must be consistent
 * (governorate.regionId === regionId AND district.governorateId === governorateId).
 *
 * lat/lng are bounded to Yemen territory. code changes are uniqueness-checked
 * (excluding self). After the row is updated the engine is force-reloaded so
 * the next snapshot read reflects the change immediately.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const me = user;
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const parsed = updateSiteSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = parsed.data;

    if (Object.keys(data).length === 0) {
      const res = NextResponse.json({ error: "No fields to update" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // ── Tenant scoping ────────────────────────────────────────────────────
    // Site is RLS-protected with FORCE, so ownership must be decided in the
    // QUERY — unscoped, findUnique returns null and the assertTenantOwned below
    // would reject a site the caller legitimately owns. Lookup, code-uniqueness
    // check, hierarchy validation and the update all run in ONE transaction, so
    // a concurrent rename cannot slip past the uniqueness check.
    const outcome = await asTenant(me, async (tx) => {
      const existing = await tx.site.findFirst({
        where: { id, tenantId: tenantIdOrThrow(me.tenantId) },
        include: siteInclude,
      });
      if (!existing) return { kind: "not-found" as const };


      // Unique code check on change (exclude self).
      if (data.code && data.code !== existing.code) {
        const clash = await tx.site.findUnique({ where: { code: data.code } });
        if (clash) return { kind: "code-clash" as const };
      }

      // Hierarchy consistency check — only when moving the whole trio.
      if (data.regionId && data.governorateId && data.districtId) {
        // PHASE 3 — resolved through the RLS-filtered `v_geography` view in a
        // SINGLE read, replacing three lookups on Region/Governorate/District.
        //
        // Two things were wrong with the previous version. First, Region carries
        // tenantId and is RLS-protected, but Governorate and District do NOT —
        // tenancy reaches them only through Region, so neither could be given a
        // policy and both were readable across every tenant. The `region:
        // { tenantId }` filters in those where clauses did nothing: they filter
        // on a joined column of an unprotected table, so the reads still
        // returned another tenant's rows.
        //
        // Second, the separate chain check below was NECESSARY precisely
        // because the three lookups were independent — they proved each row
        // existed but never that they belonged together. One view row matching
        // all three ids proves the chain by construction, because the view joins
        // region -> governorate -> district. The check is now unreachable rather
        // than merely defensive.
        const path = await resolveGeographyPath(tx, {
          regionId: data.regionId,
          governorateId: data.governorateId,
          districtId: data.districtId,
        });
        if (!path) return { kind: "bad-hierarchy" as const };
      }

      const updated = await tx.site.update({
        where: { id },
        data,
        include: siteInclude,
      });
      return { kind: "updated" as const, existing, updated };
    });

    if (outcome.kind === "not-found") {
      const res = NextResponse.json({ error: "Site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (outcome.kind === "code-clash") {
      const res = NextResponse.json(
        { error: "Site code already exists", code: "CODE_EXISTS" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (outcome.kind === "bad-hierarchy") {
      const res = NextResponse.json(
        { error: "Region/Governorate/District hierarchy is invalid", code: "INVALID_HIERARCHY" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // The `region-denied` outcome is gone: it existed only to carry the 404 from
    // assertTenantOwned(region) inside the hierarchy check. The view read returns
    // null for another tenant's path, which is the same 400 as a nonexistent one,
    // so a distinct cross-tenant outcome would disclose that those ids exist
    // elsewhere. The site-level ownership check just below still runs and still
    // 404s for a site the caller does not own.

    // Defence in depth — the where clause above already enforced ownership.
    const denied = assertTenantOwned(outcome.existing, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    const updated = outcome.updated;
    // The pre-update row, for the audit trail's "before" snapshot.
    const existing = outcome.existing;

    // Force the engine to pick up the change on the next snapshot read.
    await engine.reload();

    await audit({
      userId: me.id,
      tenantId: existing.tenantId,
      action: "SITE_UPDATE",
      entity: "site",
      entityId: id,
      details: {
        before: {
          code: existing.code,
          name: existing.name,
          criticality: existing.criticality,
          status: existing.status,
          loadKw: existing.loadKw,
        },
        changes: data as Record<string, unknown>,
      },
    });

    // The update and geography decoration are both in the caller's tenant.
    const decorated = await asTenant(me, (tx) =>
      attachGeographyNames(tx, [updated]),
    ).then((r) => r[0]);

    const res = NextResponse.json(decorated ?? updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/sites/[id]
 * Hard-delete a site. ADMIN-only. The schema cascades the delete to every
 * child row (FuelTank, Generator, BatteryBank, IotDevice, FuelDispenser,
 * FuelTransaction, FuelDelivery, MaintenanceTicket, SensorReading, SiteEvent,
 * Alarm, …) — all of them carry `onDelete: Cascade` on their siteId FK.
 *
 * This is intentionally destructive: the admin has confirmed via the dialog
 * (which surfaces the asset counts BEFORE the delete). The counts are also
 * recorded in the audit log for traceability.
 *
 * After the row is deleted the engine is force-reloaded so the site disappears
 * from the live snapshot immediately.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const me = user;
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await params;

    // ── Tenant scoping ────────────────────────────────────────────────────
    // Site is RLS-protected with FORCE: an unscoped findUnique returns null and
    // the delete would 404 on a site the caller owns. Every child count is on
    // an RLS-protected table too, so unscoped they would report ZERO and the
    // audit trail would understate the blast radius of a cascade delete.
    // Ownership check, counts and delete share one transaction.
    const outcome = await asTenant(me, async (tx) => {
      const existing = await tx.site.findFirst({
        where: { id, tenantId: tenantIdOrThrow(me.tenantId) },
        include: siteInclude,
      });
      if (!existing) return { kind: "not-found" as const };


      // Count the child assets that will be cascade-deleted, for the audit log.
      // (The DB cascade handles the actual deletion; these counts are purely
      // informational and recorded so the audit trail shows the blast radius.)
      const [
        tanks, generators, batteries, iotDevices,
        alarms, deliveries, tickets, sensorReadings, siteEvents,
      ] = await Promise.all([
        tx.fuelTank.count({ where: { siteId: id } }),
        tx.generator.count({ where: { siteId: id } }),
        tx.batteryBank.count({ where: { siteId: id } }),
        tx.iotDevice.count({ where: { siteId: id } }),
        tx.alarm.count({ where: { siteId: id } }),
        tx.fuelDelivery.count({ where: { siteId: id } }),
        tx.maintenanceTicket.count({ where: { siteId: id } }),
        tx.sensorReading.count({ where: { siteId: id } }),
        tx.siteEvent.count({ where: { siteId: id } }),
      ]);

      await tx.site.delete({ where: { id } });

      return {
        kind: "deleted" as const,
        existing,
        counts: { tanks, generators, batteries, iotDevices, alarms, deliveries, tickets, sensorReadings, siteEvents },
      };
    });

    if (outcome.kind === "not-found") {
      const res = NextResponse.json({ error: "Site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Defence in depth — the where clause above already enforced ownership.
    const denied = assertTenantOwned(outcome.existing, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    const { existing } = outcome;
    const {
      tanks, generators, batteries, iotDevices,
      alarms, deliveries, tickets, sensorReadings, siteEvents,
    } = outcome.counts;

    // Force the engine to drop the site on the next snapshot read.
    await engine.reload();

    await audit({
      userId: me.id,
      tenantId: existing.tenantId,
      action: "SITE_DELETE",
      entity: "site",
      entityId: id,
      details: {
        code: existing.code,
        name: existing.name,
        region: existing.region?.name,
        // Governorate/District names are not read here: those tables are no
        // longer readable by `fgmp_app` (migration 20261007000000). The ids are
        // on the site row and are what the audit trail needs to identify what
        // was deleted; resolving display names would mean another view query on
        // a path that is about to delete the row anyway.
        governorateId: existing.governorateId,
        districtId: existing.districtId,
        cascadeDeleted: {
          tanks, generators, batteries, iotDevices,
          alarms, deliveries, tickets, sensorReadings, siteEvents,
        },
      },
    });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
