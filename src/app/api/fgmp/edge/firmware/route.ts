import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/edge/firmware
 * Returns all EspFirmwareRelease rows (newest first) with their live
 * deployment counts. DISP-FW-GW — Edge & Firmware view → Firmware tab.
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

    // EspFirmwareRelease has NO tenantId column — firmware releases are
    // platform-level shared resources (every tenant flashes the same signed
    // binary). So no tenant filter is applied here and SUPERADMIN/ADMIN/all
    // authenticated users see the same list. Cross-tenant isolation is
    // enforced at the *deployment* level (see /edge/firmware/deployments).
    const releases = await withTenant(tenantIdOrThrow(user.tenantId), (tx) => tx.espFirmwareRelease.findMany({
      orderBy: { releasedAt: "desc" },
      include: {
        _count: { select: { deployments: true } },
        deployments: {
          orderBy: { startedAt: "desc" },
          take: 1,
          select: { id: true, status: true, startedAt: true },
        },
      },
    }));

    const res = NextResponse.json(releases);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/edge/firmware
 * Register a new ESP firmware release. SUPERADMIN-only.
 *
 * ── SECURITY ───────────────────────────────────────────────────────────────
 * `EspFirmwareRelease` has NO `tenantId` column (see prisma/schema.prisma) —
 * it is a shared platform table, so a release created here is immediately
 * visible to EVERY tenant. Registration was gated on `ROLES.EDGE_MANAGE`
 * (= ADMIN), letting any tenant admin publish a release (and a checksum) that
 * every other tenant's dispensers would then be offered. Publishing to a
 * global table is a SUPERADMIN action. See the matching note on
 * `edge/firmware/[id]/DELETE`.
 *
 * Body: { version, channel, checksum, sizeKb, releaseNotes, releasedAt? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.SUPERADMIN_ONLY);
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
    const version = typeof body.version === "string" ? body.version.trim() : "";
    const channel = typeof body.channel === "string" ? body.channel.trim() : "stable";
    const checksum = typeof body.checksum === "string" ? body.checksum.trim() : "";
    const sizeKb = Number(body.sizeKb) || 0;
    const releaseNotes = typeof body.releaseNotes === "string" ? body.releaseNotes : "";
    const releasedAt = body.releasedAt ? new Date(body.releasedAt) : new Date();

    if (!version || !checksum || !sizeKb) {
      const res = NextResponse.json(
        { error: "Missing required fields: version, checksum, sizeKb" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (!["stable", "beta", "hotfix"].includes(channel)) {
      const res = NextResponse.json({ error: "channel must be stable|beta|hotfix" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const release = await withTenant(tenantIdOrThrow(user.tenantId), (tx) => tx.espFirmwareRelease.create({
      data: {
        version,
        channel,
        checksum,
        sizeKb,
        releaseNotes,
        releasedAt,
      },
    }));

    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "DISPENSER_CONTROL",
      entity: "EspFirmwareRelease",
      entityId: release.id,
      details: { releaseCreate: { version, channel, sizeKb } },
    });

    const res = NextResponse.json(release, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
