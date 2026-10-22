/**
 * Preflight: refuse to serve if the database has no schema.
 *
 * ── The failure this prevents ───────────────────────────────────────────────
 * With FGMP_SKIP_MIGRATE=1 the container starts without touching the schema,
 * which is correct when a separate job owns migrations. But if that job never
 * ran — mis-ordered deploy, silent failure, wrong database — the container
 * starts happily and the FIRST REQUEST fails with `relation "Site" does not
 * exist`. That is the worst shape for an incident: the container looks healthy,
 * the orchestrator reports green, and the outage only appears under real
 * traffic.
 *
 * Checking up front turns that into a loud refusal at boot. This is a SELECT,
 * not DDL, so it needs no schema-owner rights and does not weaken the
 * least-privilege boundary the entrypoint maintains.
 *
 * ── Why the Prisma client, and not `psql` ───────────────────────────────────
 * The runtime image is `oven/bun:1-slim`, which ships NO PostgreSQL client
 * binaries at all — verified: `psql` and `pg_dump` are both absent. So neither
 * `psql -c "SELECT 1 FROM \"Tenant\""` nor a hand-rolled wire-protocol client is
 * available. The generated Prisma client IS in the image (the Dockerfile copies
 * node_modules/.prisma and @prisma), and it speaks the protocol for us.
 *
 * The query is raw on purpose. A model-backed call such as `db.tenant.count()`
 * is exactly what we cannot trust here: on an unmigrated database the generated
 * client's own construction or first call is what throws, so it would fail with
 * a confusing driver error instead of a clear diagnosis. `SELECT to_regclass()`
 * returns NULL rather than raising, which lets this script distinguish "no
 * schema" from "cannot connect" and say which one happened.
 *
 * Note: `to_regclass` is a catalogue lookup, so it works on an empty database
 * and is not subject to the RLS policies that guard the app's tables.
 */

import { PrismaClient } from "@prisma/client";

/**
 * A table created by the very first baseline migration and never dropped, so
 * its absence means the schema genuinely is not there.
 */
const MARKER_TABLE = "Tenant";

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function preflight(url, timeoutMs = 15000) {
  let db;
  try {
    db = new PrismaClient({
      datasources: { db: { url } },
      // Do not let this preflight hang a container start.
      log: [],
    });
  } catch (e) {
    return { ok: false, detail: `could not construct the database client: ${e?.message ?? e}` };
  }

  try {
    // Run the check under its own deadline so a wedged database cannot hold the
    // container in a booting state forever.
    const check = db.$queryRawUnsafe(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      `public."${MARKER_TABLE}"`,
    );
    const timer = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs),
    );
    const rows = await Promise.race([check, timer]);

    if (rows?.[0]?.present) {
      return { ok: true, detail: `schema marker "${MARKER_TABLE}" is present` };
    }
    return {
      ok: false,
      detail:
        `table "${MARKER_TABLE}" does not exist — this database has no schema. ` +
        `FGMP_SKIP_MIGRATE=1 was set but migrations have not been applied to the ` +
        `database this container is pointed at. Refusing to start: serving here ` +
        `would fail on the first request instead of at boot.`,
    };
  } catch (e) {
    // Prisma error messages start with newlines ("\nInvalid ... invocation:"),
    // so a naive first-line extraction yields an empty string. Collapse
    // whitespace and drop the invocation preamble, keeping the part an operator
    // can act on.
    const raw = String(e?.message ?? e);
    const msg =
      raw
        .replace(/^[\s]*/, "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !/^Invalid `prisma\..*` invocation:$/.test(l))
        .join(" ") || raw.trim() || e?.code || String(e);

    // Distinguish "cannot reach / cannot authenticate" from "no schema" — they
    // need completely different operator responses.
    if (/P1001|P1000|P1002|ECONNREFUSED|ETIMEDOUT|timed out|timeout|Authentication|password|does not exist|Can't reach|server/i.test(msg)) {
      return {
        ok: false,
        detail:
          `cannot verify the schema — ${msg}. Check DATABASE_URL, that PostgreSQL ` +
          `is reachable, and that the migrations job ran.`,
      };
    }
    return { ok: false, detail: `schema preflight failed: ${msg}` };
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const url = process.argv[2] || process.env.FGMP_MIGRATE_DATABASE_URL || "";
  if (!url) {
    console.error("[preflight] no database URL given");
    process.exit(1);
  }
  const res = await preflight(url, Number(process.env.FGPL_PREFLIGHT_TIMEOUT_MS || 15000));
  if (res.ok) {
    console.log(`[preflight] OK — ${res.detail}`);
    process.exit(0);
  }
  console.error(`[preflight] ${res.detail}`);
  process.exit(1);
}
