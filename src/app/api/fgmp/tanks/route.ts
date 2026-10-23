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
import { decimalsToJson, toNum } from "@/lib/fgmp/decimal";

export const dynamic = "force-dynamic";

// Inline Zod schemas (kept local to avoid touching shared schemas.ts).
const createTankSchema = z.object({
  siteId: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(120),
  fuelType: z.enum(["DIESEL", "PETROL", "BIOFUEL"]).default("DIESEL"),
  capacityLitres: z.coerce.number().positive().max(5_000_000),
  currentLitres: z.coerce.number().min(0).max(5_000_000).optional(),
  lowThreshold: z.coerce.number().min(0).max(5_000_000).optional(),
  criticalThreshold: z.coerce.number().min(0).max(5_000_000).optional(),
});

/**
 * GET /api/fgmp/tanks
 * Returns all fuel tanks (optionally filtered by ?siteId=), sorted by label
 * ASC. Includes the related Site (name, code) and merges live telemetry from
 * the engine (currentLitres, status, lastReadingAt) so the registry table
 * reflects the latest tick.
 *
 * Any authenticated session may list tanks — ADMIN-only mutations are
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
    // Nested include of `site` below is RLS-protected, so it is scoped with
    // the query rather than after it.
    const tanks = await asTenant(user, (tx) =>
      tx.fuelTank.findMany({
      where,
      orderBy: { label: "asc" },
      include: { site: { select: { id: true, name: true, code: true } } },
    }),
    );

    // Merge live telemetry from the engine.
    const live = engine.tanks;
    const merged = tanks.map((t) => {
      const l = live.find((x) => x.id === t.id);
      return {
        ...t,
        liveCurrentLitres: l?.current ?? t.currentLitres,
        liveStatus: l?.status ?? t.status,
        liveLastReadingAt: l?.lastReadingAt ?? t.lastReadingAt?.getTime(),
        liveLowThreshold: l?.low ?? t.lowThreshold,
        liveCriticalThreshold: l?.critical ?? t.criticalThreshold,
      };
    });

    const res = NextResponse.json(decimalsToJson(merged));
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/tanks
 * Create a new fuel tank. ADMIN-only. Validates with createTankSchema
 * (siteId, label, fuelType, capacityLitres, optional currentLitres,
 * lowThreshold, criticalThreshold). The new row is persisted to the DB AND
 * pushed into the engine's in-memory array so the next snapshot reflects it.
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
    const r = createTankSchema.safeParse(body);
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

    const current = data.currentLitres ?? 0;
    const low = data.lowThreshold ?? data.capacityLitres * 0.25;
    const critical = data.criticalThreshold ?? data.capacityLitres * 0.1;

    const row = await asTenant(user, (tx) =>
      tx.fuelTank.create({
      data: {
        siteId: data.siteId,
        tenantId: site.tenantId,
        label: data.label,
        fuelType: data.fuelType,
        capacityLitres: data.capacityLitres,
        currentLitres: current,
        lowThreshold: low,
        criticalThreshold: critical,
        calibration: "[]",
        status: "OPERATIONAL",
      },
      include: { site: { select: { id: true, name: true, code: true } } },
    }),
    );

    // Push into the engine so the next snapshot reflects the new tank.
    engine.tanks.push({
      id: row.id,
      siteId: row.siteId,
      label: row.label,
      fuelType: row.fuelType,
      // The volume columns are `numeric(12,3)` — Prisma.Decimal. This object
      // feeds the in-process engine, whose TankState declares `number`, so the
      // conversion happens HERE rather than being cast away. `scale: 3` matches
      // the column so the value is not widened into digits the ledger does not
      // hold.
      capacity: toNum(row.capacityLitres, { scale: 3 }),
      current: toNum(row.currentLitres, { scale: 3 }),
      low: toNum(row.lowThreshold, { scale: 3 }),
      critical: toNum(row.criticalThreshold, { scale: 3 }),
      status: row.status,
      lastReadingAt: row.lastReadingAt?.getTime() ?? Date.now(),
      history: [],
      prevLevel: toNum(row.currentLitres, { scale: 3 }),
    });

    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "TANK_CREATE",
      entity: "FuelTank",
      entityId: row.id,
      details: {
        siteId: data.siteId,
        label: data.label,
        fuelType: data.fuelType,
        capacityLitres: data.capacityLitres,
      },
    });

    const res = NextResponse.json(row, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
