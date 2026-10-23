/**
 * Gate for test suites that need a live PostgreSQL.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three suites assert properties that only exist in the database: that FORCE
 * RLS hides a row from an unscoped `db.*` read, that the MFA challenge resolver
 * only returns live tokens, and that `applyCommand` writes the status the
 * dispatch layer actually reported. They cannot be mocked — the bug they pin is
 * a property of the database session, not of the code.
 *
 * Before this helper, `bun test` failed 14 assertions on any machine without a
 * database, for a reason that had nothing to do with the code under test. A
 * permanently red suite is worse than a skipped one: people stop reading it, and
 * a real regression hides in the noise.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not turn a failure into a pass. When `DATABASE_URL` points at a
 * database, the suite runs and any failure fails the run. When it does not, the
 * suite is SKIPPED with a loud banner, and `FGMP_REQUIRE_DB_TESTS=1` turns that
 * skip into an error — CI sets that flag in the job that provisions PostgreSQL,
 * so a misconfigured pipeline cannot silently stop testing isolation.
 */

import { describe } from "bun:test";

const url = (process.env.DATABASE_URL ?? "").trim();

export const DB_AVAILABLE = /^postgres(ql)?:\/\//.test(url);

export const DB_TESTS_REQUIRED = ["1", "true", "yes", "on"].includes(
  (process.env.FGMP_REQUIRE_DB_TESTS ?? "").trim().toLowerCase(),
);

if (!DB_AVAILABLE && DB_TESTS_REQUIRED) {
  throw new Error(
    "FGMP_REQUIRE_DB_TESTS=1 but DATABASE_URL is missing or not a postgres:// URL. " +
      "The database-backed suites would have been skipped, which is exactly what " +
      "this flag exists to prevent. Configure DATABASE_URL before running `bun test`.",
  );
}

if (!DB_AVAILABLE) {
  console.warn(
    "\n[test] no DATABASE_URL — skipping database-backed suites " +
      "(RLS pinning, MFA challenge resolution, command persistence). " +
      "Start PostgreSQL and re-run, or set FGMP_REQUIRE_DB_TESTS=1 to make this an error.\n",
  );
}

/** `describe` when a database is configured, `describe.skip` otherwise. */
export const describeDb = DB_AVAILABLE ? describe : describe.skip;
