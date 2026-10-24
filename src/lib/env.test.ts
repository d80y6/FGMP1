/**
 * Environment validation — the rules that decide whether the server starts.
 *
 * These are pure: `collectEnvIssues` takes an environment object, so every
 * branch is exercised without mutating `process.env` (which would leak between
 * test files in a single `bun test` run).
 */

import { describe, expect, test } from "bun:test";
import { collectEnvIssues, databaseUser, envErrors } from "./env";

const PROD = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://fgmp_app:pw@db:5432/fgmp?schema=public",
  NEXTAUTH_SECRET: "a".repeat(48),
  NEXTAUTH_URL: "https://fgmp.example.ye",
  FGMP_REQUIRE_RLS: "1",
  FGMP_OPS_DATABASE_URL: "postgresql://fgmp_ops:pw@db:5432/fgmp?schema=public",
  FGMP_MFA_ENCRYPTION_KEY: "c".repeat(48),
  REALTIME_SERVICE_TOKEN: "d".repeat(32),
  APINATOR_APP_ID: "app",
  APINATOR_KEY: "key",
  APINATOR_SECRET: "secret",
} as unknown as NodeJS.ProcessEnv;

describe("env validation", () => {
  test("a complete production environment has no errors or warnings", () => {
    expect(collectEnvIssues(PROD)).toEqual([]);
  });

  test("production without an owner/ops credential is an ERROR, not a warning", () => {
    // Sign-in reads "User" by email, which cannot be tenant-scoped, so it cannot
    // run on the RLS-enforced app role. Without an owner credential the lookup
    // returns no row and EVERY login is a 401 that looks like a wrong password.
    // An app nobody can sign in to must not report itself as started.
    const issues = collectEnvIssues({ ...PROD, FGMP_OPS_DATABASE_URL: "" });
    const e = envErrors(issues);
    expect(e.map((i) => i.name)).toContain("FGMP_OPS_DATABASE_URL");
  });

  test("…and FGMP_MIGRATE_DATABASE_URL is an accepted substitute", () => {
    const issues = collectEnvIssues({
      ...PROD,
      FGMP_OPS_DATABASE_URL: "",
      FGMP_MIGRATE_DATABASE_URL: "postgresql://fgmp_migrate:pw@db:5432/fgmp",
    });
    expect(envErrors(issues).map((i) => i.name)).not.toContain("FGMP_OPS_DATABASE_URL");
  });

  test("…but outside production the same gap is only a warning", () => {
    const issues = collectEnvIssues({
      ...PROD,
      NODE_ENV: "development",
      FGMP_OPS_DATABASE_URL: "",
    });
    expect(envErrors(issues).map((i) => i.name)).not.toContain("FGMP_OPS_DATABASE_URL");
    expect(
      issues.filter((i) => i.name === "FGMP_OPS_DATABASE_URL").map((i) => i.severity),
    ).toEqual(["warn"]);
  });

  test("missing DATABASE_URL is an error", () => {
    const issues = collectEnvIssues({ ...PROD, DATABASE_URL: "" });
    expect(envErrors(issues).map((i) => i.name)).toContain("DATABASE_URL");
  });

  test("a file: URL is rejected — SQLite was removed in Phase 1", () => {
    const issues = collectEnvIssues({ ...PROD, DATABASE_URL: "file:./db/custom.db" });
    expect(envErrors(issues).map((i) => i.name)).toContain("DATABASE_URL");
  });

  test("a short session secret is an error, not a warning", () => {
    const issues = collectEnvIssues({ ...PROD, NEXTAUTH_SECRET: "too-short" });
    const e = envErrors(issues);
    expect(e.map((i) => i.name)).toContain("NEXTAUTH_SECRET");
  });

  test("RLS disabled in production is an error", () => {
    const issues = collectEnvIssues({ ...PROD, FGMP_REQUIRE_RLS: "0" });
    expect(envErrors(issues).map((i) => i.name)).toContain("FGMP_REQUIRE_RLS");
  });

  test("RLS disabled in development is respected (no error)", () => {
    const issues = collectEnvIssues({
      ...PROD,
      NODE_ENV: "development",
      FGMP_REQUIRE_RLS: "0",
    });
    expect(envErrors(issues)).toEqual([]);
  });

  test("connecting as the owner role is a warning, not a failure", () => {
    const issues = collectEnvIssues({
      ...PROD,
      DATABASE_URL: "postgresql://fgmp_migrate:pw@db:5432/fgmp?schema=public",
    });
    expect(envErrors(issues)).toEqual([]);
    expect(issues.some((i) => i.name === "DATABASE_URL" && i.severity === "warn")).toBe(true);
  });

  test("missing realtime credentials degrade, they do not block", () => {
    const issues = collectEnvIssues({
      ...PROD,
      APINATOR_APP_ID: "",
      APINATOR_KEY: "",
      APINATOR_SECRET: "",
    });
    expect(envErrors(issues)).toEqual([]);
    expect(issues.some((i) => i.name === "APINATOR_*")).toBe(true);
  });

  test("PARTIAL realtime credentials are an error", () => {
    const issues = collectEnvIssues({ ...PROD, APINATOR_SECRET: "" });
    expect(envErrors(issues).map((i) => i.name)).toContain("APINATOR_*");
  });

  test("device ingest credentials are tenant API keys, not environment requirements", () => {
    expect(collectEnvIssues({ ...PROD, IOT_API_KEY: "short" })).toEqual([]);
  });

  test("simulation enabled in production is reported, not obeyed", () => {
    const issues = collectEnvIssues({ ...PROD, FGMP_SIMULATION: "1" });
    expect(issues.some((i) => i.name === "FGMP_SIMULATION")).toBe(true);
  });

  test("no value is ever echoed back in a problem description", () => {
    const secret = "SUPER-SECRET-VALUE-THAT-MUST-NOT-LEAK";
    const issues = collectEnvIssues({ ...PROD, NEXTAUTH_SECRET: secret.slice(0, 10) });
    const text = JSON.stringify(issues);
    expect(text).not.toContain(secret.slice(0, 10));
  });
});

describe("databaseUser", () => {
  test("extracts the role from a postgres URL", () => {
    expect(databaseUser("postgresql://fgmp_app:pw@db:5432/fgmp")).toBe("fgmp_app");
  });

  test("returns null for a non-URL", () => {
    expect(databaseUser("not a url")).toBeNull();
  });
});
