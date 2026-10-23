/**
 * Docker startup: apply the Prisma schema if the database is empty.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `prisma/` contained no migrations and nothing applied the schema at boot, so
 * a fresh named volume produced a database with no tables and the first
 * request failed with "no such table".
 *
 * Options considered:
 *   - `bunx prisma db push` at startup  → downloads ~1500 packages on every
 *     container start and pins no version. Rejected.
 *   - Copying the Prisma CLI into the image → ~100 MB and a long tail of
 *     transitive deps (@prisma/config needs `effect`, …). Rejected.
 *   - Running the CLI at boot from a baked copy → same transitive-dep problem.
 *
 * Chosen: the builder stage emits `prisma/schema.sql` with `prisma migrate
 * diff` (where the full CLI is available), and this script applies it using
 * bun's built-in SQLite driver. No network, no extra dependencies, and it is
 * idempotent — it only writes when the schema is absent.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

const raw = process.env.DATABASE_URL;
if (!raw || !raw.startsWith("file:")) {
  console.error(
    `[init-db] DATABASE_URL must be a file: URL for the SQLite deployment (got: ${raw ?? "unset"})`,
  );
  process.exit(1);
}

const dbPath = raw.slice("file:".length);
// `sqlite:///abs/path` → `/abs/path`; `sqlite:./rel.db` → `./rel.db`.
const resolved = dbPath.replace(/^\/\//, "/").replace(/^sqlite:/, "");
const path = resolved.startsWith("/") ? resolved : `${process.cwd()}/${resolved}`;

// Sentinel table: if it exists the schema is already applied.
const SENTINEL = "Tenant";

let db;
try {
  db = new Database(path, { create: true });
} catch (err) {
  console.error(`[init-db] cannot open database at ${path}:`, err?.message ?? err);
  process.exit(1);
}

try {
  const existing = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(SENTINEL);

  if (existing) {
    console.log("[init-db] schema already present — nothing to do");
  } else {
    const sql = readFileSync("./prisma/schema.sql", "utf8");
    db.exec(sql);
    const tables = db
      .query("SELECT count(*) AS n FROM sqlite_master WHERE type='table'")
      .get();
    console.log(`[init-db] applied prisma/schema.sql (${tables.n} tables)`);
  }
} catch (err) {
  console.error("[init-db] failed to apply schema:", err?.message ?? err);
  process.exit(1);
} finally {
  db.close();
}
