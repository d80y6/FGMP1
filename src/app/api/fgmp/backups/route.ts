import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import fs from "node:fs";
import { db, bootstrap } from "@/lib/fgmp";
import { requireRole, ROLES, tenantWhereOrAll } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { createBackup, DB_PATH, BACKUP_DIR } from "@/lib/fgmp/backup";

export const dynamic = "force-dynamic";

/**
 * Prisma include for the createdBy + restoredBy user names. Both relations
 * are optional (createdById / restoredById are nullable).
 */
const includeUsers = {
  createdBy: { select: { id: true, name: true, email: true, role: true } },
  restoredBy: { select: { id: true, name: true, email: true, role: true } },
} as const;

const createBodySchema = z.object({
  note: z
    .string()
    .trim()
    .max(500, "Note must be at most 500 characters")
    .optional()
    .transform((v) => (v === undefined ? null : v)),
});

/**
 * GET /api/fgmp/backups
 * Returns the 100 most recent BackupRecords for the current tenant, plus DB
 * stats (live db file size, absolute db path, backup directory). ADMIN-only.
 *
 * Wrapped in try/catch + rate-limited at READ_LIMIT.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
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

    const backups = await db.backupRecord.findMany({
      where: tenantWhereOrAll(me),
      orderBy: { createdAt: "desc" },
      take: 100,
      include: includeUsers,
    });

    // Best-effort DB stats. fs.statSync throws if the file is missing —
    // fall back to 0 so the KPI strip doesn't crash the route.
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = fs.statSync(DB_PATH).size;
    } catch {
      dbSizeBytes = 0;
    }

    const res = NextResponse.json({
      backups,
      dbSizeBytes,
      // Relative labels only — the absolute on-disk path is a filesystem
      // disclosure (it reveals the deployment layout / usernames to every
      // tenant admin). `DB_PATH` / `BACKUP_DIR` are still used server-side
      // above; only the display strings are relative.
      dbPath: "db/custom.db",
      backupDir: "./backups",
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/backups
 * Take a new MANUAL backup snapshot now. Body: `{ note?: string }` (max 500
 * chars, optional). Calls `createBackup({ kind: "MANUAL", ... })` which
 * copies the live SQLite file to `backups/`, computes the SHA-256 hash, and
 * inserts a `BackupRecord` row. Audits `BACKUP_CREATE`. Returns 201 with the
 * new record (including createdBy/restoredBy). ADMIN-only. Rate-limited at
 * MUTATION_LIMIT.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
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

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Allow an empty body (`null` / `{}`) — note is optional.
    const parsed = createBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { note } = parsed.data;

    // Delegate the actual snapshot to the lib. On failure, the lib still
    // inserts a FAILED row and rethrows — errorResponse() will convert it
    // to a 500.
    const { record } = await createBackup({
      kind: "MANUAL",
      note: note ?? undefined,
      tenantId: me.tenantId,
      userId: me.id,
    });

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "BACKUP_CREATE",
      entity: "BackupRecord",
      entityId: record.id,
      details: {
        filename: record.filename,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
        kind: record.kind,
      },
    });

    // Re-fetch with the user relations so the client gets the same shape as
    // the GET list response.
    const row = await db.backupRecord.findUnique({
      where: { id: record.id },
      include: includeUsers,
    });

    const res = NextResponse.json(row, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
