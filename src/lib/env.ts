/**
 * Environment validation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every failure this checks for was previously discovered at request time, as a
 * 500 on some unrelated screen, or — worse — not at all:
 *
 *   - a missing `NEXTAUTH_SECRET` produced "JWEDecryptionFailed" on login;
 *   - a `DATABASE_URL` pointing at the owner role disabled every RLS policy
 *     while the UI stayed green;
 *   - a missing `FGMP_MFA_ENCRYPTION_KEY` surfaced only when an operator tried
 *     to enrol, which is exactly when they cannot debug it.
 *
 * A production process should refuse to start, once, with a list of every
 * problem — not start and fail in a hundred places.
 *
 * DESIGN CONSTRAINTS
 * ------------------
 * 1. **Not evaluated at module scope.** `next build` imports route modules with
 *    `NODE_ENV=production` and no runtime secrets; throwing at import time
 *    would break the build (the same reason `db.ts` exports a function). The
 *    check is a function, called from `instrumentation.ts` when the server
 *    starts.
 * 2. **Never print a value.** Only names, and only a length/format verdict.
 *    A validation error that echoes a secret into the logs is a new incident.
 * 3. **Warnings do not block.** A deployment without Apinator credentials can
 *    serve every page; realtime is a latency feature, not a data source. A
 *    device credentials are tenant-scoped database API keys, not global env
 *    secrets, so this validator does not require an ingest key.
 */

export type EnvIssue = {
  name: string;
  problem: string;
  /** `error` blocks startup; `warn` is reported and ignored. */
  severity: "error" | "warn";
};

export const MIN_SECRET_LENGTH = 32;

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Username portion of a postgres URL, or null when unparseable. */
export function databaseUser(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).username) || null;
  } catch {
    return null;
  }
}

/**
 * Collect every problem in the current environment.
 *
 * Pure with respect to `process.env` (it reads but never mutates), so the proof
 * script can exercise it with a synthetic environment.
 */
export function collectEnvIssues(
  env: NodeJS.ProcessEnv = process.env,
): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const get = (name: string) => (env[name] ?? "").trim();
  const isProd = get("NODE_ENV") === "production";

  const err = (name: string, problem: string) =>
    issues.push({ name, problem, severity: "error" });
  const warn = (name: string, problem: string) =>
    issues.push({ name, problem, severity: "warn" });

  // ── Always required ───────────────────────────────────────────────────────
  const databaseUrl = get("DATABASE_URL");
  if (!databaseUrl) {
    err("DATABASE_URL", "is not set. The app cannot serve any data without it.");
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    err(
      "DATABASE_URL",
      "must be a postgres:// or postgresql:// URL. The SQLite datasource was " +
        "removed in Phase 1; a file: URL will fail on the first query.",
    );
  }

  const nextAuthSecret = get("NEXTAUTH_SECRET");
  if (!nextAuthSecret) {
    err(
      "NEXTAUTH_SECRET",
      "is not set. Sessions cannot be signed or verified; every login fails " +
        "with JWEDecryptionFailed.",
    );
  } else if (nextAuthSecret.length < MIN_SECRET_LENGTH) {
    err(
      "NEXTAUTH_SECRET",
      `is ${nextAuthSecret.length} characters; at least ${MIN_SECRET_LENGTH} are ` +
        "required. Generate one with `openssl rand -base64 32`.",
    );
  }

  const nextAuthUrl = get("NEXTAUTH_URL");
  if (!nextAuthUrl) {
    warn(
      "NEXTAUTH_URL",
      "is not set. NextAuth falls back to the request host, which breaks " +
        "callback URLs behind a proxy and makes cookies origin-inconsistent.",
    );
  } else if (!isHttpUrl(nextAuthUrl)) {
    err("NEXTAUTH_URL", "must be an absolute http(s) URL, e.g. https://fgmp.example.ye.");
  } else if (isProd && nextAuthUrl.startsWith("http://")) {
    warn(
      "NEXTAUTH_URL",
      "is http:// in production. Session cookies are marked Secure only for " +
        "https:// URLs, so they will be sent in clear text.",
    );
  }

  // ── RLS posture ───────────────────────────────────────────────────────────
  const requireRls = get("FGMP_REQUIRE_RLS");
  const rlsExplicitlyOff = ["0", "false", "off", "no"].includes(
    requireRls.toLowerCase(),
  );
  if (isProd && rlsExplicitlyOff) {
    err(
      "FGMP_REQUIRE_RLS",
      "is disabled in production. Every tenant policy becomes advisory: an " +
        "owner-role connection bypasses RLS, and one query bug is a " +
        "cross-tenant read. Set it to 1 and connect as fgmp_app.",
    );
  }
  if (isProd && databaseUrl) {
    const user = databaseUser(databaseUrl);
    if (user && user !== "fgmp_app" && !user.startsWith("fgmp_app.")) {
      warn(
        "DATABASE_URL",
        `connects as "${user}", not the non-owner "fgmp_app" role. If that role ` +
          "owns the tables or has BYPASSRLS, row-level security does not apply.",
      );
    }
  }

  // ── The identity lookup credential ────────────────────────────────────────
  // `findUserByEmail` is the one genuinely cross-tenant read in the system: the
  // tenant is unknown until the user is found. It CANNOT run on fgmp_app, because
  // `"User"` is FORCE ROW LEVEL SECURITY and an unscoped SELECT matches zero
  // rows — for every account, including valid ones. So it needs an owner/ops
  // credential (FGMP_OPS_DATABASE_URL, falling back to FGMP_MIGRATE_DATABASE_URL
  // in src/lib/fgmp/owner-db.ts).
  //
  // With neither set, src/lib/auth-identity.ts falls back to the app client and
  // every login returns "invalid credentials" — a 401 with no server error, no
  // stack trace and no hint in the response, which reads to the operator as a
  // wrong password. src/lib/auth-identity.ts has pointed at a boot-time warning
  // here since the 2026-10 fix; there was none. This is it.
  //
  // It is an ERROR in production, not a warning: an app that rejects every
  // credential cannot serve anyone, and a startup failure names the cause instead
  // of leaving it to be discovered one support ticket at a time. Outside
  // production it is a warning, because a developer may legitimately be running
  // against a database whose owner is DATABASE_URL.
  if (!get("FGMP_OPS_DATABASE_URL") && !get("FGMP_MIGRATE_DATABASE_URL")) {
    const problem =
      "is not set (and neither is FGMP_MIGRATE_DATABASE_URL). Login " +
      "cannot read \"User\" through the RLS-enforced app role, so every sign-in " +
      "returns 401 regardless of password. Set it to an owner/ops connection.";
    if (isProd) err("FGMP_OPS_DATABASE_URL", problem);
    else warn("FGMP_OPS_DATABASE_URL", problem);
  }

  // ── Device ingest ─────────────────────────────────────────────────────────
  // Ingest credentials are tenant-scoped ApiKey records with write/admin
  // scope. A process-global shared secret would permit cross-tenant writes.

  // ── MFA secret encryption ─────────────────────────────────────────────────
  const mfaKey = get("FGMP_MFA_ENCRYPTION_KEY");
  if (!mfaKey) {
    warn(
      "FGMP_MFA_ENCRYPTION_KEY",
      "is not set. The MFA endpoints return a configuration error and no user " +
        "can enrol a second factor. Set it once and keep it stable: changing " +
        "it makes every stored secret undecryptable.",
    );
  } else if (mfaKey.length < 32) {
    err(
      "FGMP_MFA_ENCRYPTION_KEY",
      `is ${mfaKey.length} characters; at least 32 are required (it is used as ` +
        "key material, not as a password).",
    );
  }

  // ── Realtime (hosted) ─────────────────────────────────────────────────────
  const apinator = ["APINATOR_APP_ID", "APINATOR_KEY", "APINATOR_SECRET"];
  const missingApinator = apinator.filter((n) => !get(n));
  const serviceToken = get("REALTIME_SERVICE_TOKEN");
  if (missingApinator.length > 0) {
    if (missingApinator.length === apinator.length) {
      warn(
        "APINATOR_*",
        "are not set. Realtime events are not published and browsers fall back " +
          "to the 5-second poll — the app stays correct, only less immediate.",
      );
    } else {
      err(
        "APINATOR_*",
        `is partially configured (missing: ${missingApinator.join(", ")}). Emit ` +
          "will fail at runtime rather than degrade cleanly.",
      );
    }
  }
  if (!serviceToken) {
    warn(
      "REALTIME_SERVICE_TOKEN",
      "is not set. The IoT bridge cannot poll /api/fgmp/realtime/snapshot, so " +
        "it falls back to its own site list.",
    );
  }

  // ── Simulation must never be on in production ─────────────────────────────
  if (isProd && ["1", "true"].includes(get("FGMP_SIMULATION").toLowerCase())) {
    warn(
      "FGMP_SIMULATION",
      "is enabled in production. It is ignored there by design " +
        "(assertSimulationAllowed), so this is a no-op that suggests the " +
        "deployment was copied from a demo environment.",
    );
  }

  return issues;
}

/** Errors only. */
export function envErrors(issues: EnvIssue[]): EnvIssue[] {
  return issues.filter((i) => i.severity === "error");
}

/**
 * Format issues for a startup log. Values are never included.
 */
export function formatEnvIssues(issues: EnvIssue[]): string {
  return issues
    .map((i) => `  [${i.severity}] ${i.name} ${i.problem}`)
    .join("\n");
}

/**
 * Validate and (on failure) refuse to continue.
 *
 * Called from `instrumentation.ts` exactly once per server process. Returns the
 * warnings so the caller can log them without re-running the checks.
 */
export function assertEnv(): EnvIssue[] {
  const issues = collectEnvIssues();
  const errors = envErrors(issues);
  if (errors.length > 0) {
    const message =
      "\nFGMP cannot start: the environment is not valid.\n\n" +
      formatEnvIssues(issues) +
      "\n\nFix the [error] entries above. Values are never printed, on purpose.\n";
    throw new Error(message);
  }
  return issues;
}
