import { NextRequest, NextResponse } from "next/server";
import { promises as fs, createReadStream } from "fs";
import path from "path";
import { bootstrap } from "@/lib/fgmp";
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
import type { SessionUser } from "@/lib/auth";
import { BACKUP_DIR, deleteBackup } from "@/lib/fgmp/backup";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Backup & Restore → per-file endpoints (LEGACY family, Task 35-E).
 * ────────────────────────────────────────────────────────────────────────────
 * GET    /api/fgmp/backup/[filename]  → download the backup file (streaming)
 * DELETE /api/fgmp/backup/[filename]  → delete the backup file from disk
 *
 * ⚠ DEPRECATED — see the note in `../route.ts`. Prefer `/api/fgmp/backups/[id]`.
 *
 * ── SECURITY ───────────────────────────────────────────────────────────────
 * These handlers used to `stat` / `unlink` any filename in the SHARED
 * `backups/` directory after nothing more than an ADMIN role check. The
 * directory has no tenant dimension, so any tenant admin could download or
 * delete another tenant's snapshot — and a downloaded snapshot is a full copy
 * of the SQLite database (all tenants' users, password hashes, alarms, audit
 * log).
 *
 * Now the filename is resolved through a **tenant-scoped `BackupRecord`
 * lookup** before any filesystem call: `where: { filename, ...tenantWhere }`.
 * A file the caller's tenant does not own is reported as 404 — we deliberately
 * do not distinguish "does not exist" from "belongs to someone else".
 *
 * Path-traversal protection is retained as defence in depth: the filename
 * must match `/^[a-zA-Z0-9._-]+$/` AND the resolved path must still land
 * inside `BACKUP_DIR`.
 */

/** Validate that a filename is safe to use as a backup file identifier. */
function isSafeFilename(name: string): boolean {
  if (!name) return false;
  if (name.length > 255) return false;
  // Allow only alphanumerics, dot, underscore, dash. No path separators.
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.startsWith(".") || name.startsWith("-")) return false;
  return true;
}

/**
 * Resolve a filename to a tenant-owned `BackupRecord`, or null.
 * This is the single access-control gate for both handlers below.
 */
async function findOwnedBackup(
  filename: string,
  me: SessionUser,
): Promise<{ id: string; filename: string; sizeBytes: number; tenantId: string } | null> {
  const row = await db.backupRecord.findFirst({
    where: { filename, ...tenantWhereOrAll(me) },
    select: { id: true, filename: true, sizeBytes: true, tenantId: true },
  });
  return row;
}

/**
 * GET /api/fgmp/backup/[filename]
 * Streams the requested backup file as an octet-stream download.
 * The Content-Disposition header uses attachment + the filename so the browser
 * saves it rather than rendering.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ filename: string }> }) {
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

    const { filename } = await ctx.params;
    if (!isSafeFilename(filename)) {
      const res = NextResponse.json(
        { error: "Invalid filename" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Tenant ownership gate — before any filesystem access.
    const owned = await findOwnedBackup(filename, me);
    if (!owned) {
      const res = NextResponse.json({ error: "Backup file not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const target = path.join(BACKUP_DIR, owned.filename);
    // Double-check the resolved path is inside BACKUP_DIR (defense in depth).
    if (!target.startsWith(BACKUP_DIR + path.sep) && target !== BACKUP_DIR) {
      const res = NextResponse.json(
        { error: "Invalid path" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      const res = NextResponse.json({ error: "Backup file not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (!stat.isFile()) {
      const res = NextResponse.json({ error: "Not a file" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Stream the file via a Node ReadStream → web ReadableStream adapter.
    // NextResponse supports returning a Response with a stream body.
    const nodeStream = createReadStream(target);
    const webStream = new ReadableStream({
      start(controller) {
        nodeStream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        nodeStream.on("end", () => controller.close());
        nodeStream.on("error", (err: unknown) => controller.error(err));
      },
      cancel() {
        nodeStream.destroy();
      },
    });

    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", String(stat.size));
    headers.set(
      "Content-Disposition",
      `attachment; filename="${owned.filename.replace(/"/g, "_")}"`,
    );
    headers.set("Cache-Control", "no-store");
    applyRateLimitHeaders(headers, rl);

    return new NextResponse(webStream as unknown as BodyInit, { status: 200, headers });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/backup/[filename]
 * Permanently deletes the backup file from disk AND its `BackupRecord` row.
 * `deleteBackup()` re-checks tenant ownership internally and writes the
 * BACKUP_DELETE audit entry, so both families share one audited code path.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ filename: string }> }) {
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

    const { filename } = await ctx.params;
    if (!isSafeFilename(filename)) {
      const res = NextResponse.json(
        { error: "Invalid filename" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Tenant ownership gate — before any filesystem access.
    const owned = await findOwnedBackup(filename, me);
    if (!owned) {
      const res = NextResponse.json({ error: "Backup file not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const size = owned.sizeBytes;
    await deleteBackup(owned.id, { tenantId: owned.tenantId, userId: me.id });

    const res = NextResponse.json({ ok: true, filename: owned.filename, size });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
