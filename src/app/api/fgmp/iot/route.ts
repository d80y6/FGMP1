import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import { iotActionSchema, validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, siteTenantWhereOrAll, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

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
    // NESTED READ: the `include: { site }` traversal is RLS-protected too, so
    // it sits inside the same context as the top-level query. Scoping only the
    // outer findMany would return devices with a null site.
    const devices = await asTenant(user, (tx) =>
      tx.iotDevice.findMany({
        where,
        orderBy: { name: "asc" },
        include: { site: { select: { name: true, code: true } } },
      }),
    );
    // merge live status from engine
    const live = engine.iotDevices;
    const merged = devices.map((d) => {
      const l = live.find((x) => x.id === d.id);
      return { ...d, liveStatus: l?.status ?? d.status, signalRssi: l?.signalRssi ?? d.signalRssi, lastSeenAt: l?.lastSeenAt ?? d.lastSeenAt?.getTime() };
    });
    const res = NextResponse.json(merged);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
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
    const r = validateBody(iotActionSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    if (data.action === "ota") {
      // Verify the device's site belongs to the caller's tenant before
      // mutating OTA state.
      // NESTED READ: `select: { site: { … } }` resolves on the same client and
      // Site is RLS-protected, so the relation filter belongs in the query.
      // assertSiteTenantOwned is KEPT as defence in depth.
      const updated = await asTenant(user, async (tx) => {
        const existing = await tx.iotDevice.findFirst({
          where: { id: data.deviceId, site: { tenantId: user.tenantId } },
          select: { site: { select: { tenantId: true } } },
        });
        const denied = assertSiteTenantOwned(existing?.site ?? null, user);
        if (denied) {
          applyRateLimitHeaders(denied.headers, rl);
          return denied;
        }
        return tx.iotDevice.update({
          where: { id: data.deviceId },
          data: { otaTargetFw: data.firmware, otaStatus: "IN_PROGRESS" },
        });
      });
      if (updated instanceof NextResponse) return updated;
      const live = engine.iotDevices.find((x) => x.id === data.deviceId);
      if (live) { live.otaStatus = "IN_PROGRESS"; live.otaTargetFw = data.firmware; }
      await audit({ userId: user.id, action: "OTA", entity: "iot", entityId: data.deviceId, details: { firmware: data.firmware } });
      const res = NextResponse.json(updated);
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // reboot — verify tenant first.
    {
      // Same nested-relation treatment as the OTA branch above.
      const existing = await asTenant(user, (tx) =>
        tx.iotDevice.findFirst({
          where: { id: data.deviceId, site: { tenantId: user.tenantId } },
          select: { site: { select: { tenantId: true } } },
        }),
      );
      const denied = assertSiteTenantOwned(existing?.site ?? null, user);
      if (denied) {
        applyRateLimitHeaders(denied.headers, rl);
        return denied;
      }
    }
    const live = engine.iotDevices.find((x) => x.id === data.deviceId);
    if (live) { live.status = "OFFLINE"; live.lastSeenAt = Date.now(); }
    await audit({ userId: user.id, action: "REBOOT", entity: "iot", entityId: data.deviceId });
    const res = NextResponse.json({ ok: true });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
