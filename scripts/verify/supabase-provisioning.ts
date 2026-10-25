/**
 * Provisioning contract — the `scripts/supabase/*.sql` path, executed for real.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `scripts/supabase/01-roles.sql` shipped with a statement that only works for a
 * SUPERUSER:
 *
 *     alter default privileges for role fgmp_migrate …   -- needs USAGE on that role
 *
 * On Supabase the administrative account (`postgres`) is CREATEROLE + BYPASSRLS
 * but **not** a superuser, and creating a role grants ADMIN, not membership. So
 * the statement failed with `permission denied to change default privileges` at
 * line 117, in the middle of provisioning a real customer database, and the same
 * missing membership made `02-schema.sql` die at `set role fgmp_migrate` and
 * `04-verify.sql` at `set local role fgmp_app`.
 *
 * Nothing caught it because nothing ever ran these four files: CI provisions the
 * *docker* path (`scripts/db/pg-init-roles.sql` + `prisma migrate deploy`) as a
 * superuser, which is a different set of statements against a different set of
 * privileges. The deployed path was untested.
 *
 * ── WHAT THIS PROVES ───────────────────────────────────────────────────────
 * The whole chain, as a **non-superuser** role that owns the database and
 * created the three FGMP roles — the exact shape Supabase presents:
 *
 *   01 (as provisioner)  → roles created, membership granted, no warnings
 *   01 again             → idempotent
 *   set role fgmp_migrate→ the membership actually works
 *   02 (as provisioner)  → 45 tables, 40 FORCE RLS, 55 policies
 *   03 (as fgmp_ops)     → the seed writes two tenants under BYPASSRLS
 *   04 (as provisioner)  → "FGMP deployment verified."
 *
 * It also asserts the *positive* fact that failed in production: default
 * privileges are recorded for fgmp_migrate afterwards.
 *
 * ── ENVIRONMENT ────────────────────────────────────────────────────────────
 *   FGMP_PG_ADMIN_URL  superuser URL for the cluster. Default: a local socket-less
 *                      URL for the sandbox. In CI the service user is a superuser.
 *   FGMP_PG_DB         database name to create. Default `fgmp_provisioning_ci`.
 *   PGSSLMODE          passed through to psql.
 *
 * Exits non-zero on the first failed assertion, with psql's own output.
 */

import { spawnSync } from "node:child_process";

const ADMIN_URL = process.env.FGMP_PG_ADMIN_URL ?? "postgresql://pgroot@127.0.0.1:5435/postgres";
const DB = process.env.FGMP_PG_DB ?? "fgmp_provisioning_ci";
const REPO = new URL("../..", import.meta.url).pathname;
const SCRIPTS = `${REPO}/scripts/supabase`;

/** The non-superuser administrative role — the Supabase `postgres` analogue. */
const PROVISIONER = "fgmp_provisioner";
const PROVISIONER_PASSWORD = "contract";

let failures = 0;

function ok(label: string, detail = ""): void {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label: string, detail: string): void {
  failures += 1;
  console.error(`  ✗ ${label}\n${detail.split("\n").map((l) => `      ${l}`).join("\n")}`);
}

/**
 * Run psql and return stdout **and stderr merged**.
 *
 * This is not incidental: psql writes NOTICE and WARNING to stderr, so a harness
 * that captures only stdout cannot see the script's own status report — and, worse,
 * an assertion like "emits no warnings" passes because it never looked. The first
 * version of this file did exactly that and reported a warning-free run while the
 * run was emitting a membership warning.
 */
function tryPsql(url: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error) return { ok: false, out: `${out}${r.error.message}` };
  return { ok: r.status === 0, out };
}

function expectOk(label: string, url: string, args: string[]): string {
  const r = tryPsql(url, args);
  if (r.ok) ok(label);
  else fail(label, r.out);
  return r.out;
}

function expectNotice(label: string, out: string, needle: string | RegExp): void {
  const hit = typeof needle === "string" ? out.includes(needle) : needle.test(out);
  if (hit) ok(label);
  else fail(label, `expected ${String(needle)} in:\n${out}`);
}

const dbUrl = (user: string, password: string, db: string) =>
  `postgresql://${user}:${password}@${new URL(ADMIN_URL).host}/${db}`;

function main(): void {
  const adminHost = new URL(ADMIN_URL).host;

  console.log(`Provisioning contract against ${adminHost}, database ${DB}\n`);

  // ── 0. A fresh database owned by a NON-SUPERUSER ──────────────────────────
  // The whole point: if this role were a superuser, every statement below would
  // pass for the wrong reason — exactly how the original defect shipped.
  // Order matters: the roles are cluster-wide and may own objects in the target
  // database, so the database goes first. Leaving stale FGMP roles behind would
  // make this run skip the interesting path entirely — the roles would belong to
  // a previous run's role, 01 would warn, and 02 would fail at `set role`. That
  // is a different (and separately tested) scenario; here we want a first-run.
  tryPsql(ADMIN_URL, ["-q", "-c", `drop database if exists ${DB}`]);
  const stale = tryPsql(ADMIN_URL, [
    "-q", "-c", "drop role if exists fgmp_app, fgmp_ops, fgmp_migrate",
  ]);
  if (!stale.ok) {
    // Not a contract failure — an unclean cluster. The roles still own objects in
    // some other database, so this run would silently become the "roles created by
    // a different role" scenario instead of a first run, and every assertion below
    // would be measuring the wrong thing.
    console.error(
      "  ! cannot drop the FGMP roles, so this is not a clean first run:\n" +
        stale.out
          .split("\n")
          .map((l) => `      ${l}`)
          .join("\n") +
        "\n      Point FGMP_PG_ADMIN_URL at a cluster dedicated to this check.",
    );
    process.exit(2);
  }
  ok("no stale FGMP roles — this is a clean first run");
  expectOk("create the non-superuser provisioner", ADMIN_URL, [
    "-q", "-c", `drop role if exists ${PROVISIONER}`,
  ]);
  expectOk("…", ADMIN_URL, [
    "-q", "-c",
    `create role ${PROVISIONER} login password '${PROVISIONER_PASSWORD}' createrole bypassrls`,
  ]);
  expectOk("create a database owned by it", ADMIN_URL, [
    "-q", "-c", `create database ${DB} owner ${PROVISIONER}`,
  ]);

  const superuser = tryPsql(ADMIN_URL, [
    "-tAc", `select rolsuper from pg_roles where rolname = '${PROVISIONER}'`,
  ]).out.trim();
  if (superuser === "f") ok("the provisioner is NOT a superuser (the real precondition)");
  else fail("the provisioner is not a superuser", `rolsuper=${superuser}`);

  const url = dbUrl(PROVISIONER, PROVISIONER_PASSWORD, DB);

  // ── 1. Roles ──────────────────────────────────────────────────────────────
  const first = tryPsql(url, ["-f", `${SCRIPTS}/01-roles.sql`]);
  if (first.ok) ok("01-roles.sql exits 0");
  else fail("01-roles.sql exits 0", first.out);
  // Only meaningful when the script ran to completion: an aborted run has no
  // warnings to speak of, and asserting "none" on it would be a green tick for a
  // red fact.
  if (first.ok && /WARNING/.test(first.out)) fail("01-roles.sql emits no warnings", first.out);
  else if (first.ok) ok("01-roles.sql emits no warnings");
  expectNotice("…and reports every role assumable", first.out, /fgmp_migrate .*set=t, usage=t/);
  expectNotice("…and names the next step", first.out, "Next: 02-schema.sql");

  const second = expectOk("01-roles.sql re-runs cleanly (idempotent)", url, [
    "-f", `${SCRIPTS}/01-roles.sql`,
  ]);
  if (/ERROR|WARNING/.test(second)) fail("the re-run is silent", second);
  else ok("the re-run is silent");

  // The statement that failed in production. Assert its EFFECT, not its absence
  // of error: default privileges must actually be recorded for fgmp_migrate.
  const dp = tryPsql(url, [
    "-tAc",
    "select count(*) from pg_default_acl a join pg_roles r on r.oid = a.defaclrole where r.rolname = 'fgmp_migrate'",
  ]).out.trim();
  if (dp === "2") ok("default privileges recorded for fgmp_migrate", "tables + sequences");
  else fail("default privileges recorded for fgmp_migrate", `expected 2 rows, got ${dp}`);

  // 02 does `set role fgmp_migrate`. It cannot work without the membership, and
  // this is the assertion that would have failed loudly in production.
  expectOk("the provisioner can assume fgmp_migrate", url, [
    "-q", "-c", "set role fgmp_migrate; reset role;",
  ]);

  // ── 2. Schema ─────────────────────────────────────────────────────────────
  const schema = expectOk("02-schema.sql exits 0", url, ["-f", `${SCRIPTS}/02-schema.sql`]);
  expectNotice("…45 tables, 40 FORCE RLS, 55 policies", schema, /FGMP schema applied: 45 tables, 40 with FORCE RLS, 55 policies/);

  // ── 3a. The seed's own privilege guard ────────────────────────────────────
  // README tells the operator to run 03 with `set role fgmp_ops;` because it is
  // BYPASSRLS. That is only useful if the script ENFORCES it, so prove the guard
  // fires rather than taking its header comment at its word: run the seed as
  // fgmp_migrate, which owns the tables and is not BYPASSRLS. If the guard were
  // absent this would die mid-transaction on a row-level security violation
  // instead — a much worse failure, because it is partial.
  const seedAsMigrate = tryPsql(url, [
    "-c", "set role fgmp_migrate;", "-f", `${SCRIPTS}/03-seed.sql`,
  ]);
  if (seedAsMigrate.ok) {
    fail("03-seed.sql refuses to run without BYPASSRLS", "it succeeded as fgmp_migrate");
  } else if (!/superuser or a BYPASSRLS role/.test(seedAsMigrate.out)) {
    fail(
      "03-seed.sql refuses to run without BYPASSRLS",
      `failed for the wrong reason — expected the guard's message:\n${seedAsMigrate.out}`,
    );
  } else if (
    // The guard's own message *quotes* the RLS error, so "row-level security" in
    // the output proves nothing. Distinguish by origin instead: the guard raises
    // from the DO block (inline_code_block), whereas a real violation would be a
    // server error naming the table.
    !/PL\/pgSQL function inline_code_block/.test(seedAsMigrate.out) ||
    /violates row-level security policy for table/.test(seedAsMigrate.out)
  ) {
    fail(
      "03-seed.sql refuses to run without BYPASSRLS",
      `the guard did not fire; execution reached an RLS violation:\n${seedAsMigrate.out}`,
    );
  } else {
    ok("03-seed.sql refuses to run without BYPASSRLS", "guard fired before any insert");
  }

  // ── 3. Seed, as the BYPASSRLS role ────────────────────────────────────────
  // Not as the provisioner: FORCE RLS binds even the owner when the owner is not
  // superuser, so a multi-tenant seed through a plain role fails its WITH CHECK.
  const seed = expectOk("03-seed.sql exits 0 as fgmp_ops", url, [
    "-c", "set role fgmp_ops;", "-f", `${SCRIPTS}/03-seed.sql`,
  ]);
  expectNotice("…and wrote both tenants", seed, /FGMP seed ready: 2 tenants, 6 users, 8 sites/);

  // ── 4. Verification ───────────────────────────────────────────────────────
  const verify = expectOk("04-verify.sql exits 0", url, ["-f", `${SCRIPTS}/04-verify.sql`]);
  expectNotice("…and certifies the deployment", verify, "FGMP deployment verified.");
  expectNotice("…including that RLS binds with no tenant context", verify, "fgmp_app sees 0 sites with no tenant context");
  expectNotice("…and that fgmp_app cannot create tables", verify, "fgmp_app cannot create tables");

  // ── Report ────────────────────────────────────────────────────────────────
  console.log("");
  if (failures > 0) {
    console.error(`${failures} provisioning-contract assertion(s) failed.`);
    process.exit(1);
  }
  console.log("Provisioning contract: OK — the hosted/admin path works as a non-superuser.");
}

main();
