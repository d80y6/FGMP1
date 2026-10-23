/**
 * Tests for the RLS posture check in `src/lib/db.ts`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `FGMP_REQUIRE_RLS=1` is the switch that turns "we rely on Row Level Security"
 * from a comment into a property of the process: the docs, `.env.example` and
 * docker-compose all say the app refuses to start on a bypassing connection.
 * Two things were wrong with it.
 *
 *   1. The failure message prefixed the raw `DATABASE_URL` — password and all —
 *      and that message is printed at boot, straight into the container log.
 *      `describeDbUser()` existed to redact the credential, and the credential
 *      was interpolated one line above it.
 *   2. The check ran only when something imported the database layer, which in
 *      a production process happened on the first data request rather than at
 *      boot. The process looked healthy until an operator tried to sign in.
 *
 * The cases below pin the parsing (including the pooler-style username a hosted
 * Postgres hands out: `fgmp_app.<project-ref>`) and the message, which must
 * identify the host and role without ever quoting the password.
 *
 * Run: bun test src/lib/db.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  configurePgAdapter,
  configurePoolUrl,
  isServerlessRuntime,
  usingRlsRole,
  rlsViolation,
} from "@/lib/db";

const PASSWORD = "p8ssw0rd-should-never-be-logged";

function url(user: string, host = "aws-1-eu-west-3.pooler.supabase.com"): string {
  return `postgresql://${user}:${PASSWORD}@${host}:5432/fgmp1?schema=public&pgbouncer=true`;
}

describe("which connections count as RLS-enforced", () => {
  test("the plain fgmp_app role", () => {
    assert.equal(usingRlsRole(url("fgmp_app")), true);
  });

  test("the pooler username a hosted Postgres hands out", () => {
    // Supabase et al. route `<role>.<project-ref>` through their pooler; the
    // application still connects as fgmp_app.
    assert.equal(usingRlsRole(url("fgmp_app.fshwzqtgxgwviirbeybw")), true);
  });

  test("Prisma's prefixed scheme", () => {
    assert.equal(usingRlsRole(`prisma+postgres://fgmp_app:${PASSWORD}@db.internal:5432/fgmp`), true);
  });

  test("the owner and migrate roles are not enforced", () => {
    assert.equal(usingRlsRole(url("fgmp_migrate")), false);
    assert.equal(usingRlsRole(url("fgmp_ops")), false);
    assert.equal(usingRlsRole(url("postgres.fshwzqtgxgwviirbeybw")), false);
  });

  test("a role that merely starts with the same letters is not accepted", () => {
    // `fgmp_app_readonly` must not slip through a naive startsWith("fgmp_app").
    assert.equal(usingRlsRole(url("fgmp_app_readonly")), false);
  });

  test("no URL at all", () => {
    assert.equal(usingRlsRole(undefined), false);
    assert.equal(usingRlsRole(""), false);
  });
});

describe("bounded PostgreSQL connection pools", () => {
  test("recognizes Netlify / Lambda / Vercel serverless runtimes", () => {
    assert.equal(isServerlessRuntime({ NETLIFY: "true" }), true);
    assert.equal(isServerlessRuntime({ AWS_LAMBDA_FUNCTION_NAME: "fgmp" }), true);
    assert.equal(isServerlessRuntime({ VERCEL: "1" }), true);
    assert.equal(isServerlessRuntime({ CF_WORKERS: "true" }), true);
    assert.equal(isServerlessRuntime({ NODE_ENV: "production" }), false);
    assert.equal(isServerlessRuntime({ NETLIFY: "false" }), false);
  });

  test("serverless app pools are capped at one connection", () => {
    const configured = configurePoolUrl(
      "postgresql://fgmp_app:p%40ss@db.example.test:5432/fgmp?schema=public",
      { env: { NETLIFY: "true" } },
    );
    const url = new URL(configured);
    assert.equal(url.searchParams.get("connection_limit"), "1");
    assert.equal(url.searchParams.get("pool_timeout"), "5");
    assert.equal(url.searchParams.get("connect_timeout"), "5");
    assert.equal(url.password, "p%40ss");
  });

  test("long-lived app and privileged pools get small explicit limits", () => {
    const appUrl = new URL(configurePoolUrl("postgresql://fgmp_app:p@db.example.test/fgmp"));
    const opsUrl = new URL(
      configurePoolUrl("postgresql://fgmp_ops:p@db.example.test/fgmp", { defaultLimit: 1 }),
    );
    assert.equal(appUrl.searchParams.get("connection_limit"), "3");
    assert.equal(opsUrl.searchParams.get("connection_limit"), "1");
  });

  test("explicit URL parameters win; env only supplies defaults", () => {
    const configured = configurePoolUrl(
      "postgresql://fgmp_app:p@db.example.test/fgmp?connection_limit=3&pool_timeout=7&connect_timeout=4&pgbouncer=true#frag",
      { env: { NETLIFY: "true", FGMP_DB_CONNECTION_LIMIT: "9" } },
    );
    const url = new URL(configured);
    assert.equal(url.searchParams.get("connection_limit"), "3");
    assert.equal(url.searchParams.get("pool_timeout"), "7");
    assert.equal(url.searchParams.get("connect_timeout"), "4");
    assert.equal(url.searchParams.get("pgbouncer"), "true");
    assert.equal(url.hash, "#frag");
  });

  test("custom pool env values apply when the URL has no explicit limit", () => {
    const url = new URL(
      configurePoolUrl("postgresql://fgmp_app:p@db.example.test/fgmp", {
        env: { NETLIFY: "true", FGMP_DB_CONNECTION_LIMIT: "2", FGMP_DB_POOL_TIMEOUT: "8" },
      }),
    );
    assert.equal(url.searchParams.get("connection_limit"), "2");
    assert.equal(url.searchParams.get("pool_timeout"), "8");
  });

  test("the pg adapter gets a one-connection Worker pool and no Prisma-only URL options", () => {
    const config = configurePgAdapter(
      "postgresql://fgmp_app:p%40ss@db.example.test/fgmp?schema=tenant_data&sslmode=require&connection_limit=8&pool_timeout=9&connect_timeout=4#fragment",
      { env: { CF_WORKERS: "true" } },
    );
    const url = new URL(config.connectionString);
    assert.equal(config.schema, "tenant_data");
    assert.equal(config.max, 1);
    assert.equal(config.maxUses, 1);
    assert.equal(config.connectionTimeoutMillis, 4_000);
    assert.equal(config.idleTimeoutMillis, 1_000);
    assert.equal(url.password, "p%40ss");
    assert.equal(url.searchParams.get("sslmode"), "require");
    assert.equal(url.searchParams.has("schema"), false);
    assert.equal(url.searchParams.has("connection_limit"), false);
    assert.equal(url.searchParams.has("pool_timeout"), false);
    assert.equal(url.searchParams.has("connect_timeout"), false);
    assert.equal(url.hash, "");
  });

  test("the pg adapter keeps the small Node pool for non-serverless runtimes", () => {
    const config = configurePgAdapter("postgresql://fgmp_app:p@db.example.test/fgmp", {
      env: { NODE_ENV: "production" },
    });
    assert.equal(config.max, 3);
    assert.equal(config.maxUses, undefined);
    assert.equal(config.idleTimeoutMillis, 300_000);
  });

  test("invalid PostgreSQL URLs fail without echoing credentials", () => {
    assert.throws(
      () => configurePgAdapter("postgresql://secret:password with spaces@"),
      (error: Error) => {
        assert.equal(error.message, "DATABASE_URL is not a valid PostgreSQL connection URL");
        assert.equal(error.message.includes("password"), false);
        return true;
      },
    );
  });
});

describe("the refusal message", () => {
  test("is silent when the guard is off", () => {
    assert.equal(rlsViolation(url("fgmp_migrate"), undefined), null);
    assert.equal(rlsViolation(url("fgmp_migrate"), "0"), null);
    assert.equal(rlsViolation(url("fgmp_migrate"), "false"), null);
  });

  test("is silent when the connection is correct", () => {
    assert.equal(rlsViolation(url("fgmp_app"), "1"), null);
    assert.equal(rlsViolation(url("fgmp_app.abcdefghijklmnop"), "1"), null);
  });

  test("names the host and the role, and never the password", () => {
    const message = rlsViolation(url("fgmp_migrate"), "1");
    assert.ok(message, "expected a refusal");
    assert.match(message, /fgmp_app/);
    assert.match(message, /aws-1-eu-west-3\.pooler\.supabase\.com/);
    assert.match(message, /Detected role: fgmp_migrate/);
    assert.equal(
      message.includes(PASSWORD),
      false,
      "the boot message must not contain the database password",
    );
    assert.equal(
      message.includes("p8ssw0rd"),
      false,
      "the boot message must not quote any part of the credential",
    );
  });

  test("survives an unparseable URL", () => {
    const message = rlsViolation("not a url at all", "1");
    assert.ok(message);
    assert.match(message, /unparseable/);
    assert.equal(message.includes("not a url at all"), false);
  });

  test("reports a missing URL without printing anything else", () => {
    const message = rlsViolation(undefined, "1");
    assert.ok(message);
    assert.match(message, /DATABASE_URL is not set/);
  });
});
