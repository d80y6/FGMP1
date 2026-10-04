import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import {
  requireRole,
  ROLES,
  tenantWhereOrAll,
} from "@/lib/fgmp/auth-helpers";
import { restoreBackup } from "@/lib/fgmp/backup";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Backup & Restore → restore endpoint (LEGACY family, Task 35-E).
 * ────────────────────────────────────────────────────────────────────────────
 * POST /api/fgmp/backup/restore   body: { filename: "fgmp-backup-2025-….db" }
 *
 * ⚠ DEPRECATED — see the note in `../route.ts`. Prefer
 * `/api/fgmp/backups/[id]/restore`, which takes the `BackupRecord` id
 * instead of a bare filename.
 *
 * ── SECURITY (was CRITICAL) ────────────────────────────────────────────────
 * This endpoint used to be the worst hole in the API: ADMIN-only role check,
 * a filename regex, and then an unconditional
 * `fs.copyFile(backups/<filename>, DB_PATH)` — any tenant admin could
 * overwrite the LIVE DATABASE with any file in the shared backups directory.
 * It also hardcoded `DB_PATH` to `process.cwd()/db/custom.db` while Prisma
 * resolves the real file from `DATABASE_URL` (see `DB_PATH` in
 * `src/lib/fgmp/backup.ts`), so in any deployment with an absolute
 * `DATABASE_URL` it silently overwrote the wrong file.
 *
 * It is now a thin, tenant-scoped adapter over `restoreBackup()`, which:
 *   1. re-checks that the BackupRecord belongs to the caller's tenant,
 *   2. takes a PRE_RESTORE snapshot first (rollback path),
 *   3. copies over the live DB at the DATABASE_URL-resolved path,
 *   4. removes the stale `-wal` / `-shm` sidecars so SQLite rehydrates from
 *      the restored file,
 *   5. marks the record RESTORED (restoredAt / restoredById), and
 *   6. audits BACKUP_RESTORE.
 *
 * The filename is resolved through a tenant-scoped `BackupRecord` lookup, so a
 * snapshot owned by another tenant is a plain 404 — existence is not
 * disclosed. Non-super-admins are additionally pinned to their own tenant by
 * `tenantWhereOrAll`.
 */

/** Strict filename whitelist — no path separators, no `..`. */
function isSafeFilename(name: string): boolean {
  if (!name) return false;
  if (name.length > 255) return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.startsWith(".") || name.startsWith("-")) return false;
  return true;
}

/**
 * POST /api/fgmp/backup/restore
 * Body: { filename: string }
 *
 * Returns:
 *   {
 *     ok: true,
 *     filename: string,
 *     preRestoreSnapshot: string | null,   — filename of the safety snapshot
 *     preRestoreBackupId: string,         — id of the safety snapshot
 *     restartRecommended: true
 *   }
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const me = auth.user;
    await bootstrap();
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const filename = typeof (body as { filename?: unknown }).filename === "string"
      ? (body as { filename: string }).filename
      : "";
    if (!isSafeFilename(filename)) {
      const res = NextResponse.json(
        { error: "Invalid or missing filename" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Tenant ownership gate. `tenantWhereOrAll` pins non-super-admins to their
    // own tenant; SUPERADMIN (who bypasses tenant isolation by design) may
    // restore any tenant's snapshot and is attributed to that tenant's audit
    // log, since the snapshot IS that tenant's data.
    const owned = await db.backupRecord.findFirst({
      where: { filename, ...tenantWhereOrAll(me) },
      select: { id: true, filename: true, tenantId: true },
    });
    if (!owned) {
      const res = NextResponse.json(
        { error: "Backup file not found" },
        { status: 404 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { preRestoreBackupId } = await restoreBackup(owned.id, {
      tenantId: owned.tenantId,
      userId: me.id,
    });

    // Surface the safety snapshot's filename for the UI toast. Best-effort —
    // the restore itself already succeeded and is already audited.
    let preRestoreSnapshot: string | null = null;
    try {
      const pre = await db.backupRecord.findUnique({
        where: { id: preRestoreBackupId },
        select: { filename: true },
      });
      preRestoreSnapshot = pre?.filename ?? null;
    } catch {
      preRestoreSnapshot = null;
    }

    const res = NextResponse.json({
      ok: true,
      filename: owned.filename,
      preRestoreSnapshot,
      preRestoreBackupId,
      restartRecommended: true,
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
