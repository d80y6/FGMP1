import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db, bootstrap } from "@/lib/fgmp";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { BACKUP_DIR } from "@/lib/fgmp/backup";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/backups/[id]/download
 * Stream a backup .db snapshot to the client as an `application/octet-stream`
 * attachment. The filename is taken from the BackupRecord. 404 if the record
 * is missing, the tenant doesn't own it, or the file is gone from disk.
 *
 * Uses `fs.createReadStream` piped into a `ReadableStream` so the whole file
 * is never buffered in memory — important for large snapshots. ADMIN-only.
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
      select: { id: true, tenantId: true, filename: true, sizeBytes: true },
    });
    if (!row || row.tenantId !== me.tenantId) {
      const res = NextResponse.json({ error: "Backup not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const filepath = path.join(BACKUP_DIR, row.filename);
    if (!fs.existsSync(filepath)) {
      const res = NextResponse.json(
        { error: "Backup file missing on disk", code: "FILE_MISSING" },
        { status: 404 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Build a Web ReadableStream backed by the Node file stream. The runtime
    // pipes each chunk straight to the response body — memory usage stays
    // flat regardless of file size.
    const nodeStream = fs.createReadStream(filepath);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        nodeStream.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        nodeStream.on("end", () => controller.close());
        nodeStream.on("error", (err) => controller.error(err));
      },
      cancel() {
        nodeStream.destroy();
      },
    });

    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${row.filename}"`,
      "Content-Length": String(row.sizeBytes),
      "Cache-Control": "no-store",
    });
    applyRateLimitHeaders(headers, rl);
    return new NextResponse(stream, { status: 200, headers });
  } catch (err) {
    return errorResponse(err);
  }
}
