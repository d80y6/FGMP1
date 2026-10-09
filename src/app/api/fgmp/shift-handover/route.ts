import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import {
  createShiftHandoverSchema,
  validateBody,
} from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, tenantWhereOrAll } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/shift-handover
 * Returns the most recent shift handover notes for the caller's tenant,
 * newest first. Includes the count of OPEN notes (awaiting acknowledgement)
 * in a header for cheap dashboard badge rendering.
 *
 * Query params:
 *   - status=OPEN        filter by status (OPEN | ACKNOWLEDGED)
 *   - shift=MORNING      filter by shift
 *   - limit=50           default 50, max 200
 *
 * Any authenticated session may list handover notes — they're a tenant-wide
 * operational record. Tenant isolation is enforced via `tenantWhere(me)`.
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

    const url = new URL(req.url);
    const statusFilter = url.searchParams.get("status");
    const shiftFilter = url.searchParams.get("shift");
    const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    const where: Record<string, unknown> = { ...tenantWhereOrAll(user) };
    if (statusFilter && ["OPEN", "ACKNOWLEDGED"].includes(statusFilter)) {
      where.status = statusFilter;
    }
    if (shiftFilter && ["MORNING", "EVENING", "NIGHT"].includes(shiftFilter)) {
      where.shift = shiftFilter;
    }

    const [notes, openCount] = await Promise.all([
            withTenant(tenantIdOrThrow(user.tenantId), (tx) => tx.shiftHandover.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      })),
            withTenant(tenantIdOrThrow(user.tenantId), (tx) => tx.shiftHandover.count({
        where: { ...tenantWhereOrAll(user), status: "OPEN" },
      })),
    ]);

    const res = NextResponse.json({ notes, openCount });
    res.headers.set("X-Open-Handover-Count", String(openCount));
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/shift-handover
 * Create a new shift handover note. Roles: ADMIN, NOC_OPERATOR,
 * REGIONAL_MANAGER, FIELD_ENGINEER (ROLES.ALARM_OPS + DELIVERY + MAINTENANCE).
 *
 * The server stamps tenantId / authorId / authorName / authorRole and a
 * point-in-time KPI snapshot (openAlarmsCount, criticalSitesCount, avgFuelPct)
 * from the live engine — the client cannot fake these. The client supplies
 * only the descriptive fields (shift, priority, notes, ongoingIssues,
 * flaggedSiteIds).
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, [
    ...ROLES.ALARM_OPS,
    ...ROLES.DELIVERY,
    ...ROLES.MAINTENANCE,
    "SUPERADMIN",
  ] as any);
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
    const r = validateBody(createShiftHandoverSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    // Point-in-time network snapshot — stamped on the note so the incoming
    // operator sees the state of the network at handover time without having
    // to re-derive it. We pull from the live engine's most recent KPIs.
    let openAlarmsCount = 0;
    let criticalSitesCount = 0;
    let avgFuelPct = 0;
    try {
      const snap = await engine.snapshot();
      openAlarmsCount = snap.kpis.openAlarms;
      criticalSitesCount = snap.kpis.tanksCritical + snap.kpis.offlineSites;
      avgFuelPct = snap.kpis.fuelPct;
    } catch {
      // Engine snapshot may fail during cold start; default to 0.
    }

    // Validate flagged site ids belong to the caller's tenant (cheap bulk check).
    let flaggedSiteIds: string | null = null;
    if (data.flaggedSiteIds && data.flaggedSiteIds.length > 0) {
      const owned = await withTenant(tenantIdOrThrow(user.tenantId), (tx) => tx.site.findMany({
        where: { id: { in: data.flaggedSiteIds }, ...tenantWhereOrAll(user) },
        select: { id: true },
      }));
      const ownedSet = new Set(owned.map((s) => s.id));
      const valid = data.flaggedSiteIds.filter((id) => ownedSet.has(id));
      if (valid.length > 0) flaggedSiteIds = valid.join(",");
    }

    const created = await withTenant(tenantIdOrThrow(user.tenantId), (tx) => tx.shiftHandover.create({
      data: {
        tenantId: tenantIdOrThrow(user.tenantId),
        authorId: user.id,
        authorName: user.name,
        authorRole: user.role,
        shift: data.shift,
        priority: data.priority,
        notes: data.notes,
        ongoingIssues: data.ongoingIssues ?? null,
        flaggedSiteIds,
        openAlarmsCount,
        criticalSitesCount,
        avgFuelPct,
        status: "OPEN",
      },
    }));

    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "HANDOVER_CREATE",
      entity: "ShiftHandover",
      entityId: created.id,
      details: {
        shift: data.shift,
        priority: data.priority,
        openAlarmsCount,
        criticalSitesCount,
        avgFuelPct,
        flaggedSiteCount: flaggedSiteIds ? flaggedSiteIds.split(",").length : 0,
      },
    });

    const res = NextResponse.json(created, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
