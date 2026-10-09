import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { engine, bootstrap } from "@/lib/fgmp";
import { asTenant, asTenantForAnotherTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { resolveGeographyPath, attachGeographyNames } from "@/lib/fgmp/geography";
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

// Geography is attached by name through `v_geography`, not by Prisma include.
//
// `include: { governorate: true }` no longer works: migration 20261007000000
// revoked SELECT on Governorate and District from `fgmp_app`, because neither
// table carries a tenantId and so neither was protected by RLS. Including them
// fails at the database with `permission denied for table Governorate` and 500s
// the route. Only `region` remains directly includable — Region does carry
// tenantId and is RLS-protected — and the view supplies the other two names
// under the tenant filter.
const siteInclude = {
  region: true,
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
    const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // ── Tenant scoping ────────────────────────────────────────────────────
    // `tenantWhere(me)` builds a WHERE object, but a WHERE alone does NOT
    // satisfy RLS: the policy's USING clause is ANDed with it and
    // current_setting('app.tenant_id') is NULL, so the query returned zero rows
    // regardless of the filter. The filter is kept — it is still correct and
    // still denies a superadmin's unfiltered view — but the query must also run
    // inside a tenant context for the rows to exist at all.
    const sites = await asTenant(me, async (tx) => {
      const rows = await tx.site.findMany({
        where: tenantWhere(me),
        include: siteInclude,
        orderBy: { code: "asc" },
      });
      return attachGeographyNames(tx, rows);
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
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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

    // Fail closed at the boundary rather than letting `string | undefined` flow
    // through the file: a tenant-less session must not build a site filter.
    const tenantId = tenantIdOrThrow(me.tenantId);

    // ── Tenant scoping ────────────────────────────────────────────────────
    // Site, Region, Governorate and District are all FORCE-RLS protected, so
    // these reads returned null and the create was rejected by WITH CHECK. The
    // code-uniqueness probe and the hierarchy validation are done in ONE
    // transaction so the validation and the insert cannot observe different
    // snapshots. Without a context, `region` came back null and every create
    // failed with INVALID_HIERARCHY — a wrong answer, not an error.
    // Also privileged, and for a reason that is easy to get wrong: this
    // validates the Region/Governorate/District hierarchy for the site being
    // CREATED. For a super-admin that site may live in another tenant, so the
    // geography it is validated against must be read in the TARGET tenant.
    // Scoping this to the caller's own tenant would make every cross-tenant
    // site create fail with INVALID_HIERARCHY — a confusing wrong answer rather
    // than an obvious refusal.
    const { codeClash, path } = await asTenantForAnotherTenant(
      me,
      tenantId,
      async (tx) => {
        // Unique code check (the DB enforces this too, but a 409 here gives a
        // cleaner error than the generic P2002 from api-error.)
        const existing = await tx.site.findUnique({ where: { code: data.code } });
        if (existing) {
          return { codeClash: true, path: null };
        }

        // Validate hierarchical consistency: governorate.regionId === regionId
        // AND district.governorateId === governorateId.
        //
        // PHASE 3 — this now resolves through the RLS-filtered `v_geography`
        // view in a SINGLE read. The previous version did three independent
        // lookups on Region, Governorate and District and carried a comment
        // claiming the Region read "gated" the other two. That was wrong, and
        // wrong in a way that mattered: the Region check gated whether the WRITE
        // proceeded, but `tx.governorate.findUnique` and `tx.district.findUnique`
        // ran against base tables that no policy protected — neither carries a
        // tenantId, so neither could be given one. Both returned any tenant's
        // rows. A caller could pair their own region with another tenant's
        // district.
        //
        // The view filters on Region."tenantId" and the base tables are now
        // REVOKEd from fgmp_app, so this read is tenant-scoped by construction.
        // One row matching all three ids also PROVES the chain is internally
        // consistent, which three separate lookups could not.
        const path = await resolveGeographyPath(tx, {
          regionId: data.regionId,
          governorateId: data.governorateId,
          districtId: data.districtId,
        });
        return {
          codeClash: false,
          path,
        };
      },
    );

    if (codeClash) {
      const res = NextResponse.json(
        { error: "Site code already exists", code: "CODE_EXISTS" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // One null check now covers BOTH former failures. Previously this was two
    // checks: existence, and then `governorate.regionId !== region.id ||
    // district.governorateId !== governorate.id`. The second is now impossible
    // to reach — a single `v_geography` row matching all three ids already
    // proves the chain is consistent, because the view joins
    // region → governorate → district rather than looking each up separately.
    // A district belonging to a different tenant is simply absent from the
    // tenant-filtered view, so it yields the same 400 as a nonexistent one
    // rather than disclosing that the id exists elsewhere.
    if (!path) {
      const res = NextResponse.json(
        { error: "Region/Governorate/District hierarchy is invalid", code: "INVALID_HIERARCHY" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Privileged helper, for the same reason as geography/regions and users:
    // a super-admin may legitimately create a site in another tenant, and
    // asTenant(me, …) would silently redirect it into their own tenant.
    const site = await asTenantForAnotherTenant(me, tenantId, (tx) => tx.site.create({
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
      }),
    );
    // Geography names come from the tenant-filtered view, not from a Prisma
    // include — see `siteInclude`. Run inside the same tenant context as the
    // create so the view's current_setting() predicate matches.
    const [withGeography] = await asTenantForAnotherTenant(me, tenantId, (tx) =>
      attachGeographyNames(tx, [site]),
    );

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
        region: path.regionName,
        governorate: path.governorateName,
      },
    });

    const res = NextResponse.json(withGeography ?? site, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
