import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { engine, bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, siteTenantWhereOrAll, assertTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

// Inline Zod schemas.
const createBatterySchema = z.object({
  siteId: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(120),
  chemistry: z
    .enum(["VRLA", "AGM", "LITHIUM", "GEL", "LIPO"])
    .default("VRLA"),
  capacityAh: z.coerce.number().positive().max(100_000),
  nominalVoltage: z.coerce.number().positive().max(1_000).default(48),
});

/**
 * GET /api/fgmp/batteries
 * Returns all battery banks (optionally filtered by ?siteId=), sorted by
 * label ASC. Includes the related Site (name, code) and merges live telemetry
 * from the engine (voltage, currentA, stateOfCharge, stateOfHealth,
 * temperatureC, charging, status, lastReadingAt) so the registry table
 * reflects the latest tick.
 *
 * Any authenticated session may list batteries — ADMIN-only mutations are
 * enforced on POST/PATCH/DELETE.
 */
export async function GET(req: NextRequest) {
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
    const { searchParams } = new URL(req.url);
    const siteId = searchParams.get("siteId");
    const where: Record<string, unknown> = { ...siteTenantWhereOrAll(user) };
    if (siteId) where.siteId = siteId;
    // Nested `include: { site }` is inside the same context — BatteryBank and
    // Site are both RLS-protected.
    const batteries = await asTenant(user, (tx) =>
      tx.batteryBank.findMany({
      where,
      orderBy: { label: "asc" },
      include: { site: { select: { id: true, name: true, code: true } } },
    }));

    // Merge live telemetry from the engine.
    const live = engine.batteries;
    const merged = batteries.map((b) => {
      const l = live.find((x) => x.id === b.id);
      return {
        ...b,
        liveVoltage: l?.voltage ?? b.voltage,
        liveCurrentA: l?.currentA ?? b.currentA,
        liveStateOfCharge: l?.stateOfCharge ?? b.stateOfCharge,
        liveStateOfHealth: l?.stateOfHealth ?? b.stateOfHealth,
        liveTemperatureC: l?.temperatureC ?? b.temperatureC,
        liveCharging: l?.charging ?? b.charging,
        liveStatus: l?.status ?? b.status,
        liveLastReadingAt: l?.lastReadingAt ?? b.lastReadingAt?.getTime(),
      };
    });

    const res = NextResponse.json(merged);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/batteries
 * Create a new battery bank. ADMIN-only. Validates with createBatterySchema.
 * The new row is persisted to the DB AND pushed into the engine's in-memory
 * array so the next snapshot reflects it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const r = createBatterySchema.safeParse(body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error.flatten() },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    // Verify the site exists in the acting admin's tenant
    // (SUPERADMIN bypasses for cross-tenant asset creation).
    // Scoped in the query so the acting admin's own tenant can find the site.
    // assertTenantOwned is KEPT as defence in depth.
    const site = await asTenant(user, (tx) =>
      tx.site.findFirst({
        where: { id: data.siteId, tenantId: user.tenantId },
        select: { id: true, tenantId: true, name: true },
      }),
    );
    const siteDenied = assertTenantOwned(site, user);
    if (siteDenied) {
      applyRateLimitHeaders(siteDenied.headers, rl);
      return siteDenied;
    }
    if (!site) {
      const res = NextResponse.json(
        { error: "Site not found in your tenant" },
        { status: 404 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // The write AND its nested `include: { site }` are both inside the tenant
    // context. An unscoped create would be rejected outright by WITH CHECK
    // ("new row violates row-level security policy").
    //
    // `tenantId: user.tenantId`, NOT `site.tenantId`. The site was proven
    // above to belong to the caller's tenant by a query already scoped to it, so
    // the derived value was always equal to the caller's and added nothing. With
    // `asTenant(user, …)` it is not merely redundant but structurally
    // unnecessary: there is no longer a way to pass "the tenant" that is not
    // literally the caller's own. This is the deletion the new signature was
    // supposed to buy, and it is a deletion rather than a rewrite.
    const row = await asTenant(user, (tx) =>
      tx.batteryBank.create({
        data: {
          siteId: data.siteId,
          tenantId: tenantIdOrThrow(user.tenantId),
          label: data.label,
          chemistry: data.chemistry,
          capacityAh: data.capacityAh,
          nominalVoltage: data.nominalVoltage,
          voltage: data.nominalVoltage,
          stateOfCharge: 80,
          stateOfHealth: 95,
          status: "OK",
        },
        include: { site: { select: { id: true, name: true, code: true } } },
      }),
    );

    // Push into the engine so the next snapshot reflects the new battery.
    engine.batteries.push({
      id: row.id,
      siteId: row.siteId,
      label: row.label,
      chemistry: row.chemistry,
      capacityAh: row.capacityAh,
      nominalVoltage: row.nominalVoltage,
      voltage: row.voltage,
      currentA: row.currentA,
      stateOfCharge: row.stateOfCharge,
      stateOfHealth: row.stateOfHealth,
      temperatureC: row.temperatureC,
      charging: row.charging,
      status: row.status,
      installedAt: row.installedAt.getTime(),
      lastReadingAt: row.lastReadingAt?.getTime() ?? Date.now(),
      history: [],
    });

    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "BATTERY_CREATE",
      entity: "BatteryBank",
      entityId: row.id,
      details: {
        siteId: data.siteId,
        label: data.label,
        chemistry: data.chemistry,
        capacityAh: data.capacityAh,
        nominalVoltage: data.nominalVoltage,
      },
    });

    const res = NextResponse.json(row, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
