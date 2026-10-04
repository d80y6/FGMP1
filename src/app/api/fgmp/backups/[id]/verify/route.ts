import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { verifyBackup } from "@/lib/fgmp/backup";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/backups/[id]/verify
 * Re-hash the backup file and compare to the stored `sha256`. Returns
 * `{ ok, expected, actual }`. `ok` is true iff the digests match and the
 * stored digest was non-empty. 404 if the record is missing or cross-tenant.
 * ADMIN-only.
 *
 * Wrapped in try/catch + rate-limited at READ_LIMIT.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
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
    const { id } = await ctx.params;

    // Tenant-scoped check before delegating to verifyBackup (which also
    // checks, but throws a P2025-tagged error). Doing the explicit check
    // here lets us return a clean 404 with the right shape.
    const existing = await db.backupRecord.findUnique({
      where: { id },
      select: { id: true, tenantId: true },
    });
    if (!existing || existing.tenantId !== me.tenantId) {
      const res = NextResponse.json({ error: "Backup not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const result = await verifyBackup(id);
    const res = NextResponse.json(result);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
