/**
 * Container entrypoint: apply pending Prisma migrations, then exec the server.
 *
 * ── Why this replaced scripts/docker-init-db.js ─────────────────────────────
 * The previous entrypoint ran `docker-init-db.js`, which was a SQLite-era
 * artifact: it imported `bun:sqlite`, and hard-exited unless DATABASE_URL began
 * with `file:`. Phase 1 migrated the datasource to PostgreSQL, so the shipped
 * image refused to boot against the database docker-compose actually
 * provisions. This file is the PostgreSQL path.
 *
 * ── Why `migrate deploy` and NOT `db push` ─────────────────────────────────
 * `prisma db push` reconciles the live schema to schema.prisma and does not
 * record what it did. It can therefore silently drift the database away from
 * the committed migration history — losing the audit trail of how the schema
 * got here, and making two environments disagree in ways nobody can explain
 * later. The 16 committed migrations under prisma/migrations/ are the
 * authority; `migrate deploy` applies exactly those, in order, and is a no-op
 * when they are already applied (so it is safe on every boot).
 *
 * ── Why migrations do NOT run in the app process ───────────────────────────
 * Least privilege. The web app connects as `fgmp_app`, which is deliberately
 * NOT the schema owner and cannot perform DDL. Handing the app a migration
 * credential would make the entire RLS boundary decorative: any injection bug
 * would inherit owner rights.
 *
 * So this entrypoint is only a fallback for single-container / local use, where
 * no separate migrate job exists. In any real deployment the migration runs as
 * its own one-shot job (docker-compose's `migrate` service, or CI) against
 * FGMP_MIGRATE_DATABASE_URL, and the app is started with a command that skips
 * this entirely. Both paths are supported; neither silently changes the schema.
 */

import { spawnSync } from "node:child_process";

const log = (msg) => console.log(`[entrypoint] ${msg}`);
const fail = (msg) => {
  console.error(`[entrypoint] FATAL: ${msg}`);
  process.exit(1);
};

const SERVER = "server.js";

/**
 * FGMP_SKIP_MIGRATE=1 starts the server without touching the schema.
 *
 * This is the correct setting for the app container in any deployment where a
 * separate one-shot job owns migrations (docker-compose's `migrate` service, or
 * CI). It guarantees the web process never needs — or holds — DDL rights, which
 * is what keeps the RLS boundary meaningful: `fgmp_app` is not the owner and
 * cannot alter the schema even if an attacker reached application code.
 *
 * Default remains "migrate here" so a single-container developer run still gets
 * a working database with no extra ceremony.
 */
const SKIP_MIGRATE = process.env.FGMP_SKIP_MIGRATE === "1";

/**
 * The environment the SERVER runs with.
 *
 * `FGMP_MIGRATE_DATABASE_URL` is deleted unconditionally, in BOTH branches.
 *
 * ── WHY THIS IS NOT DEFENCE IN DEPTH BUT THE ACTUAL BOUNDARY ────────────────
 * Verified by p0-impl against the built image: with the migration credential
 * present in the container environment, application code could read it, connect
 * as `fgmp_migrate`, and successfully execute DDL —
 *
 *     escalate to: {"u":"fgmp_migrate"}
 *     DDL SUCCEEDED as {"u":"fgmp_migrate"}
 *
 * `fgmp_migrate` is the schema owner and a SUPERUSER, so it bypasses RLS
 * outright. Any injection bug inheriting that credential would make every policy
 * in this project decorative.
 *
 * The honest position before this change: the RLS boundary rested on the
 * operator NOT passing the owner URL to the app container. Compose documents
 * that, and the app credential alone cannot do DDL — but "documented" is not
 * "enforced", and anyone passing it in innocently, exactly as p0-impl did to
 * test migrations, silently defeats the whole design.
 *
 * The credential is needed for exactly one `spawnSync` below. It has no reason
 * to exist for the lifetime of the process that serves traffic.
 */
function serverEnv() {
  const env = { ...process.env };
  delete env.FGMP_MIGRATE_DATABASE_URL;
  return env;
}

if (SKIP_MIGRATE) {
  if (!process.env.FGMP_MIGRATE_DATABASE_URL) {
    fail(
      "FGMP_SKIP_MIGRATE=1 is set but no migration credential was supplied. Run the " +
        "migration job first (docker compose --profile migrate run --rm fgmp-migrate, " +
        "or `prisma migrate deploy` in CI), then start the app.",
    );
  }

  // The narrow, dangerous case: the credential WAS valid, migrations were
  // skipped, and the target database turns out to be empty. Without this check
  // the container starts and reports healthy, and the failure only surfaces as
  // `relation "Site" does not exist` on the first real request. A SELECT
  // (to_regclass), so it needs no owner rights and does not compromise the
  // least-privilege boundary.
  const { preflight } = await import("./db-preflight.mjs");
  const check = await preflight(
    process.env.FGMP_MIGRATE_DATABASE_URL || process.env.DATABASE_URL || "",
    Number(process.env.FGMP_PREFLIGHT_TIMEOUT_MS || 15000),
  );
  if (!check.ok) {
    fail(
      `preflight failed — ${check.detail}\n` +
        `Refusing to start: a mis-ordered deploy must fail here, not on the ` +
        `first operator request.`,
    );
  }
  log(`FGMP_SKIP_MIGRATE=1 — schema verified (${check.detail}); starting server`);

  const run = spawnSync("bun", [SERVER], { stdio: "inherit", env: serverEnv() });
  fail(`bun ${SERVER} exited with status ${run.status}`);
}

// ── Locate the Prisma CLI ────────────────────────────────────────────────────
// The slim runtime image does not install the full `prisma` package (it is a
// ~1500-package devDependency tree). The builder stage does have it, and the
// Dockerfile copies the pieces we need. Prefer the vendored CLI; fall back to a
// PATH lookup so the same script works in the toolchain image used by compose's
// one-shot jobs.
const CLI_CANDIDATES = [
  "./node_modules/prisma/build/index.js",
  "/app/node_modules/prisma/build/index.js",
];

function resolveCli() {
  for (const p of CLI_CANDIDATES) {
    try {
      if (require("node:fs").existsSync(p)) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const cli = resolveCli();
if (!cli) {
  fail(
    "Prisma CLI not found in this image. The runner stage must copy " +
      "node_modules/prisma (and @prisma/engines) from the builder, or the " +
      "migration job must use the toolchain image instead of the slim runtime.",
  );
}

// ── Pick the credential ──────────────────────────────────────────────────────
// Prefer an explicitly supplied migration URL. Falling back to DATABASE_URL is
// only correct when that URL belongs to the owner role; if it is the app's
// RLS-enforced role the deploy will fail on DDL, which is the safe outcome —
// better than silently connecting as something more privileged.
const migrateUrl = process.env.FGMP_MIGRATE_DATABASE_URL || "";

if (!migrateUrl) {
  fail(
    "FGMP_MIGRATE_DATABASE_URL is not set. Migrations must run against the " +
      "schema owner (fgmp_migrate), never against the app's RLS-enforced role. " +
      "Set it for this one-shot container, or set FGMP_SKIP_MIGRATE=1 if a " +
      "separate job has already migrated.",
  );
}

const isPostgres = /^postgres(ql)?:\/\//i.test(migrateUrl);
const isSqlite = /^file:/i.test(migrateUrl);

if (!isPostgres && !isSqlite) {
  fail(
    `DATABASE_URL does not look like a PostgreSQL or file: URL ` +
      `(got: ${migrateUrl.slice(0, 12)}…). Refusing to guess.`,
  );
}

log(
  `applying migrations via ${isPostgres ? "PostgreSQL" : "SQLite"} ` +
    `(${migrateUrl.replace(/:[^:@/]*@/, ":***@")})`,
);

const res = spawnSync(process.execPath, [cli, "migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: migrateUrl },
});

if (res.error) {
  fail(`could not execute the Prisma CLI: ${res.error.message}`);
}

if (res.status !== 0) {
  // Emit the real exit code and stop. A half-applied migration is worse than a
  // container that refuses to serve, so we never fall through to the server.
  fail(
    `prisma migrate deploy exited ${res.status}. The schema was NOT brought ` +
      `up to date, so the server was not started. Fix the database or the ` +
      `migration history and restart.`,
  );
}

log("migrations applied (or already current) — starting server");

// exec so the server becomes PID 1 and receives SIGTERM directly, letting
// Next.js shut down cleanly instead of being killed after the grace period.
const server = spawnSync("bun", [SERVER], { stdio: "inherit", env: serverEnv() });
fail(`bun ${SERVER} exited with status ${server.status}`);
