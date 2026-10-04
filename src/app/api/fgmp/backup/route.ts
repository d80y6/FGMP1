import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import {
  requireRole,
  ROLES,
  tenantWhereOrAll,
} from "@/lib/fgmp/auth-helpers";
import { createBackup, DB_PATH } from "@/lib/fgmp/backup";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Backup & Restore — LEGACY file-oriented family (Task 35-E).
 * ────────────────────────────────────────────────────────────────────────────
 * GET  /api/fgmp/backup   → list backup snapshots belonging to the caller's tenant
 * POST /api/fgmp/backup   → create a new tenant-tagged backup snapshot
 *
 * ⚠ DEPRECATED — prefer the tenant-aware `/api/fgmp/backups/*` family, which
 * stores the same `BackupRecord` rows plus a SHA-256 digest and a restore
 * audit trail. This family is retained only because
 * `src/components/fgmp/views/backup-view.tsx` still calls these paths, and the
 * component is owned by another agent. Once that view is migrated to
 * `/api/fgmp/backups/*`, delete this directory.
 *
 * ── SECURITY ───────────────────────────────────────────────────────────────
 * Previously these routes gated on `ROLES.ADMIN_ONLY` and then operated
 * directly on the shared `backups/` directory by FILENAME. There is no tenant
 * column in the filesystem, so any tenant admin could:
 *   • list every snapshot on the host,
 *   • download the raw SQLite file — which contains EVERY tenant's users,
 *     bcrypt password hashes, alarms and audit log, and
 *   • POST restore to overwrite the live database.
 *
 * Every handler below now resolves the filename through a **tenant-scoped
 * `BackupRecord` lookup** (`tenantWhereOrAll`): a snapshot the caller's tenant
 * does not own is simply not found (404), so existence is not disclosed
 * either. Snapshots created here are registered as `BackupRecord` rows tagged
 * with the creating user's tenantId, which is what makes the scoping work.
 *
 * The database path is resolved from `DATABASE_URL` via `DB_PATH` exported
 * from `src/lib/fgmp/backup.ts` — it was previously hardcoded to
 * `process.cwd()/db/custom.db`, which pointed at a different file than the
 * one Prisma was actually writing whenever `DATABASE_URL` was set to an
 * absolute path (i.e. the snapshot was of the wrong database).
 */

/** Display-only, relative label for the live database file. */
const DB_PATH_DISPLAY = "db/custom.db";

interface BackupFile {
  filename: string;
  size: number;
  createdAt: string; // ISO string
}

/**
 * List this tenant's snapshots, newest first. Rows come from `BackupRecord`
 * (the authoritative, tenant-tagged registry) rather than a bare `readdir`
 * of the shared `backups/` directory, which had no tenant dimension at all.
 */
async function listBackups(tenantId: string | undefined): Promise<BackupFile[]> {
  const rows = await db.backupRecord.findMany({
    where: tenantId ? { tenantId } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { filename: true, sizeBytes: true, createdAt: true },
  });
  return rows.map((r) => ({
    filename: r.filename,
    size: r.sizeBytes,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * GET /api/fgmp/backup
 * Returns:
 *   {
 *     backups:    BackupFile[],         — this tenant's snapshots
 *     dbPath:     string,               — relative db path label (never absolute)
 *     dbSize:     number | null,        — bytes (null if file missing)
 *     backupDir:  string,               — relative label (never absolute)
 *     lastBackup: string | null         — ISO mtime of newest backup (null if none)
 *   }
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const me = auth.user;
    await bootstrap();
    const rl = rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const tenantScope = tenantWhereOrAll(me);
    const backups = await listBackups(tenantScope.tenantId);

    let dbSize: number | null = null;
    try {
      const stat = await fs.stat(DB_PATH);
      dbSize = stat.size;
    } catch {
      // DB file missing — surface null so the UI shows "—" rather than 500.
    }

    const lastBackup = backups.length > 0 ? backups[0]!.createdAt : null;

    const res = NextResponse.json({
      backups,
      dbPath: DB_PATH_DISPLAY,
      backupDir: "./backups",
      dbSize,
      lastBackup,
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/backup
 * Creates a new snapshot by delegating to `createBackup()` in
 * `src/lib/fgmp/backup.ts`, which:
 *   - copies the live SQLite file (path resolved from DATABASE_URL),
 *   - records size + SHA-256,
 *   - inserts a `BackupRecord` tagged with THIS tenant + user.
 *
 * The tenant tag is what allows the list / download / delete / restore
 * handlers to scope access. Returns 201 with the new filename + size.
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

    // Ensure the DB file exists — if not, refuse to back up.
    try {
      await fs.access(DB_PATH);
    } catch {
      const res = NextResponse.json(
        { error: `Database file not found (${DB_PATH_DISPLAY})` },
        { status: 404 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { record } = await createBackup({
      kind: "MANUAL",
      tenantId: me.tenantId,
      userId: me.id,
    });

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "BACKUP_CREATE",
      entity: "Backup",
      entityId: record.filename,
      details: {
        filename: record.filename,
        size: record.sizeBytes,
        source: DB_PATH_DISPLAY,
      },
    });

    const res = NextResponse.json(
      {
        ok: true,
        filename: record.filename,
        size: record.sizeBytes,
        createdAt: record.createdAt.toISOString(),
        path: `backups/${record.filename}`,
      },
      { status: 201 },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
