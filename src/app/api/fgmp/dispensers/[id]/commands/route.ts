import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/dispensers/[id]/commands
 * Returns the command history for a single dispenser (most recent first).
 *
 * Query params:
 *   - limit : 1..200 (default 50)
 *
 * There is no DispenserCommand table in the Prisma schema — remote control of
 * a dispenser (POST /api/fgmp/dispensers/[id]/control) is recorded as an
 * AuditLog row with action "CONTROL" and entity "dispenser", so that trail is
 * what this endpoint projects into the `{ commands }` shape.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") ?? 50)));

    // Verify the dispenser's site belongs to the caller's tenant before
    // returning its command history.
    const existing = await db.fuelDispenser.findUnique({
      where: { id },
      select: { site: { select: { tenantId: true } } },
    });
    const tenantDenied = assertSiteTenantOwned(existing?.site ?? null, user);
    if (tenantDenied) {
      applyRateLimitHeaders(tenantDenied.headers, rl);
      return tenantDenied;
    }

    const logs = await db.auditLog.findMany({
      where: { action: "CONTROL", entity: "dispenser", entityId: id },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    const commands = logs.map((log) => {
      // `details` is a JSON string written by audit(); anything unparseable
      // degrades to an empty object rather than failing the whole request.
      let details: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(log.details);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          details = parsed as Record<string, unknown>;
        }
      } catch {
        /* malformed audit payload — fall through with empty details */
      }
      const command = typeof details.command === "string" ? details.command : "UNKNOWN";
      const result = typeof details.result === "object" && details.result !== null
        ? (details.result as { ok?: boolean; message?: string })
        : null;
      return {
        id: log.id,
        command,
        issuedAt: log.createdAt.toISOString(),
        issuedBy: log.user ? { id: log.user.id, name: log.user.name, email: log.user.email } : null,
        ok: result ? result.ok !== false : true,
        message: result?.message ?? null,
        presetVolumeLitres: typeof details.presetVolumeLitres === "number" ? details.presetVolumeLitres : null,
      };
    });

    const res = NextResponse.json({ commands });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
