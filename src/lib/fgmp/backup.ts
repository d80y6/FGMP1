/**
 * FGMP Backup & Restore — server-side helper lib (Task GAP-B).
 * ────────────────────────────────────────────────────────────────────────────
 * Snapshots the SQLite database file to `backups/` and tracks each snapshot
 * in the `BackupRecord` Prisma table. The actual copy is a plain
 * `fs.copyFile` — SQLite in WAL mode handles concurrent reads from Prisma's
 * open file descriptors safely, so we don't need to teardown the client.
 *
 * All functions are tenant-scoped: callers must pass the acting user's
 * tenantId + userId so the BackupRecord row is tagged correctly and the
 * audit log can attribute the action.
 *
 * NOTE: This module is server-only. It uses `node:fs`, `node:path`,
 * `node:crypto` — none of which are available in the client bundle. Route
 * handlers (which are server-only by default in the App Router) import these
 * helpers directly.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { audit } from "@/lib/fgmp/audit";
import type { BackupRecord } from "@prisma/client";

// ──────────────────────────────────────────────────────────────────────────
// Filesystem paths
// ──────────────────────────────────────────────────────────────────────────

/** Directory where .db snapshot files are stored. Created on-demand. */
export const BACKUP_DIR = path.resolve(process.cwd(), "backups");

/**
 * Resolve the SQLite database file path from `process.env.DATABASE_URL`.
 * Accepts both `file:/abs/path.db` and `file:./rel/path.db` forms. Falls
 * back to `<cwd>/db/custom.db` if the env var is missing.
 */
function resolveDbPath(): string {
  const raw = process.env.DATABASE_URL ?? "file:./db/custom.db";
  const stripped = raw.startsWith("file:") ? raw.slice(5) : raw;
  return path.isAbsolute(stripped)
    ? stripped
    : path.resolve(process.cwd(), stripped);
}

/** Absolute path to the live SQLite database file. */
export const DB_PATH = resolveDbPath();

/** Ensure the backup directory exists. Idempotent. */
function ensureBackupDir(): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Build a UTC timestamp string of the form `YYYY-MM-DD-HHMMSS` (padded). */
function timestampUtc(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/**
 * Stream a file through SHA-256 and resolve with the hex digest. Uses
 * `fs.createReadStream` so we never load the whole file into memory —
 * important for large DB snapshots.
 */
function sha256File(filepath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filepath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Human-readable byte formatter. Returns strings like "1.4 MB", "512 B",
 * "2.0 GB". Used server-side for log/audit messages; the view has its own
 * inline copy (this module is server-only and can't be imported by the
 * client bundle).
 *
 *   - n < 1024         → "{n} B"
 *   - n < 1024^2       → "{x.x} KB"
 *   - n < 1024^3       → "{x.x} MB"
 *   - n < 1024^4       → "{x.x} GB"
 *   - otherwise        → "{x.x} TB"
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

export interface CreateBackupOpts {
  kind?: "MANUAL" | "SCHEDULED" | "PRE_RESTORE";
  note?: string;
  tenantId: string;
  userId: string;
}

export interface CreateBackupResult {
  record: BackupRecord;
  filepath: string;
}

/**
 * Snapshot the live SQLite DB to a new file under `backups/`. Computes the
 * file size + SHA-256 hash and persists a `BackupRecord` row.
 *
 * On failure, still inserts a row with `status = "FAILED"` (so the audit
 * history records the attempt) and rethrows the original error.
 *
 * Does NOT audit — callers (e.g. POST /api/fgmp/backups) audit
 * `BACKUP_CREATE` if appropriate. The internal `restoreBackup` flow uses
 * this function for its pre-restore snapshot without auditing a separate
 * `BACKUP_CREATE`.
 */
export async function createBackup(
  opts: CreateBackupOpts,
): Promise<CreateBackupResult> {
  const kind = opts.kind ?? "MANUAL";
  const note = opts.note?.trim() ? opts.note.trim() : null;
  const filename = `fgmp-backup-${timestampUtc()}.db`;
  ensureBackupDir();
  const filepath = path.join(BACKUP_DIR, filename);

  try {
    // fs.copyFile is safe while Prisma has open connections — SQLite WAL
    // mode handles concurrent reads. The destination file is atomically
    // written (copyFile truncates + streams in chunks).
    await fs.promises.copyFile(DB_PATH, filepath);

    const sizeBytes = fs.statSync(filepath).size;
    const sha256 = await sha256File(filepath);

    const record = await db.backupRecord.create({
      data: {
        tenantId: opts.tenantId,
        filename,
        sizeBytes,
        sha256,
        status: "COMPLETED",
        kind,
        createdById: opts.userId,
        note,
      },
    });

    return { record, filepath };
  } catch (err) {
    // Record the FAILED attempt so the audit history is complete. Best-effort
    // — if this also fails (e.g. DB unreachable), swallow the secondary error
    // so we rethrow the original cause.
    try {
      await db.backupRecord.create({
        data: {
          tenantId: opts.tenantId,
          filename,
          sizeBytes: 0,
          sha256: null,
          status: "FAILED",
          kind,
          createdById: opts.userId,
          note,
        },
      });
    } catch {
      /* swallow — rethrow the original error below */
    }
    throw err;
  }
}

/**
 * Restore the database from a previously-taken snapshot.
 *
 * Flow:
 *   1. Fetch the target BackupRecord (must belong to the caller's tenant).
 *   2. Take a PRE_RESTORE snapshot first — so the admin can roll back if
 *      the restore was a mistake.
 *   3. Overwrite the live DB file with `fs.copyFile`.
 *   4. Delete the WAL + SHM sidecar files (if any) so SQLite rehydrates
 *      from the restored .db file rather than replaying the old WAL.
 *   5. Mark the original BackupRecord as RESTORED (restoredAt + restoredById).
 *   6. Audit `BACKUP_RESTORE` with `{ backupId, preRestoreBackupId }`.
 *
 * Returns `{ preRestoreBackupId }` so the route can surface it in the
 * response payload (the spec asks for it explicitly).
 */
export async function restoreBackup(
  backupId: string,
  opts: { tenantId: string; userId: string },
): Promise<{ preRestoreBackupId: string }> {
  const target = await db.backupRecord.findUnique({
    where: { id: backupId },
    select: { id: true, tenantId: true, filename: true },
  });
  if (!target || target.tenantId !== opts.tenantId) {
    throw newNotFoundError();
  }

  const backupFilepath = path.join(BACKUP_DIR, target.filename);
  if (!fs.existsSync(backupFilepath)) {
    throw newNotFoundError("Backup file missing on disk");
  }

  // 1. Pre-restore snapshot — always. Gives the admin a rollback path.
  const pre = await createBackup({
    kind: "PRE_RESTORE",
    note: "Auto snapshot before restore",
    tenantId: opts.tenantId,
    userId: opts.userId,
  });

  // 2. Overwrite the live DB file.
  await fs.promises.copyFile(backupFilepath, DB_PATH);

  // 3. Clear WAL + SHM sidecars so SQLite starts fresh from the restored
  //    .db file. Ignore ENOENT — the sidecars may not exist if WAL was
  //    checkpointed or never enabled.
  await fs.promises.unlink(`${DB_PATH}-wal`).catch(() => {});
  await fs.promises.unlink(`${DB_PATH}-shm`).catch(() => {});

  // 4. Mark the original record as restored.
  const now = new Date();
  await db.backupRecord.update({
    where: { id: backupId },
    data: {
      status: "RESTORED",
      restoredAt: now,
      restoredById: opts.userId,
    },
  });

  // 5. Audit (the route handler does NOT re-audit — this is the single
  //    source of truth for BACKUP_RESTORE).
  await audit({
    userId: opts.userId,
    tenantId: opts.tenantId,
    action: "BACKUP_RESTORE",
    entity: "BackupRecord",
    entityId: backupId,
    details: { backupId, preRestoreBackupId: pre.record.id },
  });

  return { preRestoreBackupId: pre.record.id };
}

/**
 * Delete a backup file + its DB row. The file `fs.unlink` is best-effort
 * (ignore ENOENT — the row may exist even if the file was removed manually).
 * Audits `BACKUP_DELETE` with `{ filename, sizeBytes }`.
 */
export async function deleteBackup(
  backupId: string,
  opts: { tenantId: string; userId: string },
): Promise<void> {
  const target = await db.backupRecord.findUnique({
    where: { id: backupId },
    select: { id: true, tenantId: true, filename: true, sizeBytes: true },
  });
  if (!target || target.tenantId !== opts.tenantId) {
    throw newNotFoundError();
  }

  const filepath = path.join(BACKUP_DIR, target.filename);
  try {
    await fs.promises.unlink(filepath);
  } catch (err) {
    // Ignore "file not found" — the row may exist without the file (e.g.
    // backups dir was wiped). Other errors propagate.
    if (!isEnoent(err)) throw err;
  }

  await db.backupRecord.delete({ where: { id: backupId } });

  await audit({
    userId: opts.userId,
    tenantId: opts.tenantId,
    action: "BACKUP_DELETE",
    entity: "BackupRecord",
    entityId: backupId,
    details: { filename: target.filename, sizeBytes: target.sizeBytes },
  });
}

/**
 * Re-hash the backup file and compare to the stored `sha256`. Returns the
 * expected (stored) and actual (re-computed) digests plus an `ok` flag.
 *
 * Used by the verify endpoint to detect bit-rot / tampering.
 */
export async function verifyBackup(
  backupId: string,
): Promise<{ ok: boolean; expected: string; actual: string }> {
  const target = await db.backupRecord.findUnique({
    where: { id: backupId },
    select: { id: true, tenantId: true, filename: true, sha256: true },
  });
  if (!target) throw newNotFoundError();

  const filepath = path.join(BACKUP_DIR, target.filename);
  const expected = target.sha256 ?? "";
  if (!fs.existsSync(filepath)) {
    return { ok: false, expected, actual: "" };
  }
  const actual = await sha256File(filepath);
  return { ok: actual === expected && expected !== "", expected, actual };
}

// ──────────────────────────────────────────────────────────────────────────
// Internal error helpers
// ──────────────────────────────────────────────────────────────────────────

/** Prisma's P2025 "record not found" code — `errorResponse` maps it to 404. */
function newNotFoundError(msg = "Backup not found"): Error {
  const err = new Error(msg);
  // Tag with Prisma's not-found code so api-error.ts → errorResponse() maps
  // it to a clean 404 instead of a 500.
  (err as { code?: string }).code = "P2025";
  return err;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
