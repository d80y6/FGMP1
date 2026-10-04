import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { deleteBackup } from "@/lib/fgmp/backup";

export const dynamic = "force-dynamic";

const includeUsers = {
  createdBy: { select: { id: true, name: true, email: true, role: true } },
  restoredBy: { select: { id: true, name: true, email: true, role: true } },
} as const;

/**
 * GET /api/fgmp/backups/[id]
 * Returns a single BackupRecord by id (must belong to the current tenant).
 * 404 if not found or cross-tenant. Includes createdBy + restoredBy user
 * relations. ADMIN-only.
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

    const row = await db.backupRecord.findUnique({
      where: { id },
      include: includeUsers,
    });
    if (!row || row.tenantId !== me.tenantId) {
      const res = NextResponse.json({ error: "Backup not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const res = NextResponse.json(row);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/backups/[id]
 * Hard-delete a backup: removes the .db snapshot file from disk (ignoring
 * ENOENT) and deletes the `BackupRecord` row. Audited as `BACKUP_DELETE`
 * inside `deleteBackup`. 404 if not found, 403 if cross-tenant. ADMIN-only.
 *
 * Wrapped in try/catch + rate-limited at MUTATION_LIMIT.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    const { id } = await ctx.params;

    // Tenant-scoped lookup happens inside deleteBackup; on miss it throws a
    // P2025-tagged error which errorResponse() maps to 404.
    await deleteBackup(id, { tenantId: me.tenantId, userId: me.id });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
