/**
 * Configuration health must be REPORTABLE, not thrown.
 * ─────────────────────────────────────────────────────────────────────────────
 * The regression this file pins is a production failure mode, not a style
 * preference. Two checks used to throw while a route module was being evaluated
 * (`assertRlsEnforced()` in `src/lib/db.ts`, `resolveSessionConfig()` in
 * `src/lib/auth.ts`). On a long-lived Node container that is a boot failure with
 * a printed reason. On Cloudflare Workers — the production target — it is a
 * blanket `500 Internal Server Error` on EVERY `/api/fgmp/*` route, with the
 * reason visible nowhere: no process to kill, no error on the wire, and
 * `observability.logs` disabled in `wrangler.jsonc` to stay inside the free
 * tier.
 *
 * So the cases below assert the two properties that replace it:
 *
 *   1. a broken configuration is DETECTED here (and therefore answerable with
 *      503 RLS_NOT_ENFORCED / ENV_INVALID / SESSION_CONFIG_INVALID), and
 *   2. a sound configuration produces NO problem, so the gate cannot become a
 *      self-inflicted outage — which is the way "fail closed" usually breaks a
 *      deployment.
 *
 * The readiness route's use of this module is not exercised here: importing
 * `src/lib/health/readiness.ts` evaluates `src/lib/db.ts`, which needs a
 * generated Prisma client (`prisma generate`, which needs the engine CDN). That
 * is the same environmental limitation that keeps `src/lib/db.test.ts` out of
 * this sandbox, and it is why the pure verdict lives in `src/lib/db-rls.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  configProblems,
  firstConfigProblem,
  noteConfigProblem,
  resetConfigProblemsForTests,
} from "@/lib/fgmp/config-health";

/** A configuration that must produce no problem at all. */
const SOUND: Record<string, string> = {
  NODE_ENV: "production",
  // The non-owner role: RLS applies, so FGMP_REQUIRE_RLS=1 is satisfied.
  DATABASE_URL: "postgresql://fgmp_app:s3cret@db.internal:5432/fgmp?schema=public",
  FGMP_REQUIRE_RLS: "1",
  NEXTAUTH_SECRET: "e".repeat(48),
  NEXTAUTH_URL: "https://fgmp.example.ye",
  // The one genuinely cross-tenant read (email → tenant) needs this; without it
  // src/lib/env.ts reports an ERROR in production.
  FGMP_OPS_DATABASE_URL: "postgresql://fgmp_ops:s3cret@db.internal:5432/fgmp?schema=public",
};

/** Every variable this module reads, so a case cannot inherit another's env. */
const MANAGED = [
  "NODE_ENV",
  "DATABASE_URL",
  "FGMP_REQUIRE_RLS",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "FGMP_OPS_DATABASE_URL",
  "FGMP_MIGRATE_DATABASE_URL",
  "APINATOR_APP_ID",
  "APINATOR_KEY",
  "APINATOR_SECRET",
] as const;

const original: Record<string, string | undefined> = {};
let captured = false;
/** `process.env.NODE_ENV` is typed read-only; the test seam needs a mutable view. */
const env = process.env as Record<string, string | undefined>;

function useEnv(values: Record<string, string | undefined>): void {
  if (!captured) {
    for (const key of MANAGED) original[key] = env[key];
    captured = true;
  }
  for (const key of MANAGED) delete env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) env[key] = value;
  }
  // The verdict is memoized per isolate (it runs on the request path), so a new
  // environment has to be evaluated from scratch.
  resetConfigProblemsForTests();
}

afterEach(() => {
  for (const key of MANAGED) {
    const value = original[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  resetConfigProblemsForTests();
});

describe("config-health: a sound deployment reports nothing", () => {
  test("fgmp_app + FGMP_REQUIRE_RLS=1 + ops credential is clean", () => {
    useEnv(SOUND);
    expect(configProblems()).toEqual([]);
    expect(firstConfigProblem()).toBeNull();
  });

  test("local development without RLS enforcement is clean", () => {
    // The guard is opt-in: an unset FGMP_REQUIRE_RLS must never refuse traffic,
    // or every `bun run dev` would 503.
    useEnv({ ...SOUND, FGMP_REQUIRE_RLS: "", DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/fgmp" });
    expect(configProblems()).toEqual([]);
  });
});

describe("config-health: a bypassing database role is a reported problem", () => {
  test("owner/migrate role under FGMP_REQUIRE_RLS=1 → RLS_NOT_ENFORCED", () => {
    useEnv({
      ...SOUND,
      DATABASE_URL: "postgresql://fgmp_migrate:s3cret@db.internal:5432/fgmp",
    });
    const problem = firstConfigProblem();
    expect(problem?.code).toBe("RLS_NOT_ENFORCED");
    // The message must identify the misconfiguration without leaking the
    // credential — it is returned to an authenticated caller and printed.
    expect(problem?.detail).toContain("fgmp_migrate");
    expect(problem?.detail).not.toContain("s3cret");
  });

  test("the pooler-style fgmp_app username is accepted", () => {
    useEnv({
      ...SOUND,
      DATABASE_URL: "postgresql://fgmp_app.fshwzqtgxgwviirbeybw:s3cret@pool.internal:6543/fgmp",
    });
    expect(configProblems()).toEqual([]);
  });
});

describe("config-health: blocking vs merely degraded", () => {
  test("a missing DATABASE_URL blocks — nothing can be served", () => {
    useEnv({ ...SOUND, DATABASE_URL: undefined, FGMP_REQUIRE_RLS: undefined });
    const problem = firstConfigProblem();
    expect(problem?.code).toBe("ENV_INVALID");
    expect(problem?.detail).toContain("DATABASE_URL");
    // Names only. A detail that echoed a value would be a second incident.
    expect(problem?.detail).not.toContain("s3cret");
  });

  test("a short NEXTAUTH_SECRET blocks — no session can be verified", () => {
    useEnv({ ...SOUND, NEXTAUTH_SECRET: "too-short" });
    const problem = firstConfigProblem();
    expect(problem?.code).toBe("ENV_INVALID");
    expect(problem?.detail).toContain("NEXTAUTH_SECRET");
  });

  test("a missing FGMP_OPS_DATABASE_URL does NOT block", () => {
    // Deliberate, and the distinction matters. `src/lib/env.ts` is right to call
    // this an error for a Node process at boot: without it, sign-in cannot read
    // `User` through the RLS-enforced role and every login is a 401.
    // But an already-issued session still serves correctly scoped data, and
    // refusing every read because LOGIN is broken would be an outage this code
    // caused itself. It stays a startup error and a readiness/diagnostic fact,
    // not a per-request refusal.
    useEnv({ ...SOUND, FGMP_OPS_DATABASE_URL: undefined });
    expect(configProblems()).toEqual([]);
  });

  test("partial realtime credentials do NOT block", () => {
    // Same reasoning: emit fails, browsers fall back to the 5-second poll, and
    // tenant data is unaffected.
    useEnv({ ...SOUND, APINATOR_APP_ID: "app", APINATOR_KEY: undefined, APINATOR_SECRET: undefined });
    expect(configProblems()).toEqual([]);
  });
});

describe("config-health: a module-owned problem is recorded, not thrown", () => {
  test("SESSION_CONFIG_INVALID is reported before the environment is examined", () => {
    // Exactly what src/lib/auth.ts does after catching resolveSessionConfig().
    noteConfigProblem({
      code: "SESSION_CONFIG_INVALID",
      detail: "FGMP_SESSION_MAX_AGE_MS is not a positive number (got 0).",
    });
    useEnv(SOUND);
    noteConfigProblem({
      code: "SESSION_CONFIG_INVALID",
      detail: "duplicate report must not accumulate",
    });
    const problems = configProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe("SESSION_CONFIG_INVALID");
  });
});

describe("config-health: memoized per isolate", () => {
  test("the verdict is computed once, then reused", () => {
    useEnv(SOUND);
    expect(configProblems()).toEqual([]);
    // Simulate the environment changing under a live isolate. It cannot in a
    // Worker, and re-parsing on every request would be a per-request cost on
    // the hot path — so the memoized answer is the documented behaviour.
    env.DATABASE_URL = "postgresql://fgmp_migrate:s3cret@db.internal:5432/fgmp";
    env.FGMP_REQUIRE_RLS = "1";
    expect(configProblems()).toEqual([]);
    resetConfigProblemsForTests();
    expect(firstConfigProblem()?.code).toBe("RLS_NOT_ENFORCED");
  });
});
