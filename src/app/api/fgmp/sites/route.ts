import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, engine, bootstrap } from "@/lib/fgmp";
import { requireAuth, requireRole, ROLES, tenantWhere } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";

export const dynamic = "force-dynamic";

// ── Yemen territorial bounds ────────────────────────────────────────────────
// Used to validate manual lat/lng entries on site create/update. The bounds
// are intentionally a bit generous (the mainland spans roughly 12.1–19.0 N
// and 42.4–54.0 E including Socotra) so legitimate operator entries inside
// the country never trip the check, while obviously-wrong coordinates
// (e.g. 25,46 — Saudi Arabia) are rejected before they hit the DB.
const YEMEN_LAT_MIN = 12.0;
const YEMEN_LAT_MAX = 19.0;
const YEMEN_LNG_MIN = 42.0;
const YEMEN_LNG_MAX = 53.0;

const CRITICALITY_VALUES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const POWER_SOURCE_VALUES = ["GRID", "GENERATOR", "HYBRID"] as const;
const STATUS_VALUES = ["ONLINE", "DEGRADED", "OFFLINE", "MAINTENANCE"] as const;

const createSiteSchema = z.object({
  code: z.string().min(3).max(40),
  name: z.string().min(2).max(200),
  regionId: z.string().cuid(),
  governorateId: z.string().cuid(),
  districtId: z.string().cuid(),
  latitude: z.number().min(YEMEN_LAT_MIN).max(YEMEN_LAT_MAX),
  longitude: z.number().min(YEMEN_LNG_MIN).max(YEMEN_LNG_MAX),
  address: z.string().max(500).default(""),
  criticality: z.enum(CRITICALITY_VALUES).default("MEDIUM"),
  loadKw: z.number().min(0).default(0),
  powerSource: z.enum(POWER_SOURCE_VALUES).default("HYBRID"),
  gridAvailable: z.boolean().default(true),
  status: z.enum(STATUS_VALUES).default("ONLINE"),
});

const siteInclude = {
  region: true,
  governorate: true,
  district: true,
} as const;

/**
 * GET /api/fgmp/sites
 * Returns all sites (sorted by code ASC) with their region/governorate/district
 * names joined. Lightweight — no tanks/generators/batteries are included (the
 * snapshot endpoint is the right call for that view).
 *
 * Any authenticated session can list sites.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    await bootstrap();
    const me = auth.user;
    const rl = rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const sites = await db.site.findMany({
      where: tenantWhere(me),
      include: siteInclude,
      orderBy: { code: "asc" },
    });
    const res = NextResponse.json(sites);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/sites
 * Create a new site. ADMIN-only. Zod-validated, audited, rate-limited at
 * MUTATION_LIMIT. The region/governorate/district hierarchy must be
 * consistent (governorate.regionId === regionId AND
 * district.governorateId === governorateId) — otherwise 400.
 *
 * After the row is created the engine is force-reloaded so the new site
 * appears in the live snapshot immediately (the operator's next refresh
 * picks it up).
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    await bootstrap();
    const me = auth.user;
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const parsed = createSiteSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = parsed.data;

    // Unique code check (the DB enforces this too, but a 409 here gives a
    // cleaner error than the generic P2002 from api-error.)
    const existing = await db.site.findUnique({ where: { code: data.code } });
    if (existing) {
      const res = NextResponse.json(
        { error: "Site code already exists", code: "CODE_EXISTS" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Validate hierarchical consistency: governorate.regionId === regionId
    // AND district.governorateId === governorateId. Parallel fetch.
    const [region, governorate, district] = await Promise.all([
      db.region.findUnique({ where: { id: data.regionId } }),
      db.governorate.findUnique({ where: { id: data.governorateId } }),
      db.district.findUnique({ where: { id: data.districtId } }),
    ]);
    if (!region || !governorate || !district) {
      const res = NextResponse.json(
        { error: "Region/Governorate/District hierarchy is invalid", code: "INVALID_HIERARCHY" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (governorate.regionId !== region.id || district.governorateId !== governorate.id) {
      const res = NextResponse.json(
        { error: "Region/Governorate/District hierarchy is invalid", code: "INVALID_HIERARCHY" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const tenantId = me.tenantId;
    const site = await db.site.create({
      data: {
        tenantId,
        code: data.code,
        name: data.name,
        regionId: data.regionId,
        governorateId: data.governorateId,
        districtId: data.districtId,
        latitude: data.latitude,
        longitude: data.longitude,
        address: data.address,
        criticality: data.criticality,
        loadKw: data.loadKw,
        powerSource: data.powerSource,
        gridAvailable: data.gridAvailable,
        status: data.status,
      },
      include: siteInclude,
    });

    // Force the engine to pick up the new site on the next snapshot read.
    await engine.reload();

    await audit({
      userId: me.id,
      tenantId,
      action: "SITE_CREATE",
      entity: "site",
      entityId: site.id,
      details: {
        code: site.code,
        name: site.name,
        region: region.name,
        governorate: governorate.name,
      },
    });

    const res = NextResponse.json(site, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
