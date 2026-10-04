import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { restoreBackup } from "@/lib/fgmp/backup";

export const dynamic = "force-dynamic";

/**
 * POST /api/fgmp/backups/[id]/restore
 * Restore the database from the snapshot identified by `[id]`. The lib
 * `restoreBackup` function:
 *   1. Verifies the record belongs to the caller's tenant (404 otherwise).
 *   2. Takes a PRE_RESTORE snapshot first (rollback safety net).
 *   3. Overwrites the live .db file with `fs.copyFile`.
 *   4. Deletes the WAL + SHM sidecars so SQLite rehydrates from the
 *      restored file.
 *   5. Marks the original record as RESTORED + audits BACKUP_RESTORE.
 *
 * Returns 200 with `{ ok, preRestoreBackupId, warning }`. The warning
 * reminds the operator that long-lived Prisma client connections may serve
 * stale data until the server process is restarted. ADMIN-only.
 *
 * Wrapped in try/catch + rate-limited at MUTATION_LIMIT.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

    // Sanity-check the row exists + belongs to the tenant BEFORE calling
    // restoreBackup so we can return a clean 404 without consuming a
    // PRE_RESTORE snapshot. (restoreBackup also checks; this is the early
    // exit.)
    const existing = await db.backupRecord.findUnique({
      where: { id },
      select: { id: true, tenantId: true, filename: true, status: true },
    });
    if (!existing || existing.tenantId !== me.tenantId) {
      const res = NextResponse.json({ error: "Backup not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { preRestoreBackupId } = await restoreBackup(id, {
      tenantId: me.tenantId,
      userId: me.id,
    });

    const res = NextResponse.json({
      ok: true,
      backupId: id,
      preRestoreBackupId,
      warning:
        "Database restored. A pre-restore snapshot was taken first. " +
        "Long-lived Prisma connections may serve cached data — restart the " +
        "server process to ensure all queries hit the restored DB.",
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
