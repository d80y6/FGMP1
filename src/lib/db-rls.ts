/**
 * Row-Level Security posture: which role is connected, and whether that is
 * allowed.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE OF ITS OWN
 *
 * These four functions used to live in `src/lib/db.ts`, which imports Prisma and
 * the PostgreSQL driver. That made the ONLY security check that stands between a
 * misconfigured connection and silently-disabled tenant isolation impossible to
 * consult from anywhere that should not also pull a database driver into the
 * module graph — including `src/lib/fgmp/config-health.ts`, which runs on the
 * request path, and a unit test.
 *
 * Nothing here touches a connection. It reads a URL string and answers a
 * question about it.
 *
 * ── WHAT THE RULE IS ────────────────────────────────────────────────────────
 * RLS policies are enforced by the DATABASE, so the application can only be held
 * to them if it connects as the non-owner role. PostgreSQL skips RLS for the
 * table owner unless `FORCE ROW LEVEL SECURITY` is set, and `fgmp_app` is
 * deliberately provisioned as a separate non-owner role precisely so that a
 * mistake in application code cannot silently disable the backstop.
 *
 * The runtime connection string MUST therefore use the `fgmp_app` role:
 *
 *   postgresql://fgmp_app:…@…/fgmp?schema=public     ← correct (RLS applies)
 *   postgresql://fgmp_migrate:…@…/fgmp?schema=public  ← WRONG in the web app
 *
 * Running the web app on the migrate/owner role would leave the application code
 * as the ONLY line of defence — exactly what this phase exists to remove. This
 * module deliberately does NOT rewrite the role at runtime: silently connecting
 * as a different principal than the operator configured would hide the very
 * misconfiguration we are guarding against. It reports instead, and
 * `rlsEnforced` (exported from `db.ts`) tells health checks and the regression
 * suite whether a claim like "cross-tenant reads are blocked" is meaningful for
 * this process at all.
 */

/**
 * Row Level Security (Phase 1, step 7).
 *
 * RLS policies are enforced by the DATABASE, so the application can only be
 * held to them if it connects as the non-owner role. PostgreSQL skips RLS for
 * the table owner unless `FORCE ROW LEVEL SECURITY` is set, and `fgmp_app` is
 * deliberately provisioned as a separate non-owner role precisely so that a
 * mistake in application code cannot silently disable the backstop.
 *
 * The runtime connection string MUST therefore use the `fgmp_app` role:
 *
 *   postgresql://fgmp_app:…@…/fgmp?schema=public     ← correct (RLS applies)
 *   postgresql://fgmp_migrate:…@…/fgmp?schema=public  ← WRONG in the web app
 *
 * Running the web app on the migrate/owner role would leave the application
 * code as the ONLY line of defence — exactly what this phase exists to
 * remove. This module deliberately does NOT rewrite the role at runtime:
 * silently connecting as a different principal than the operator configured
 * would hide the very misconfiguration we are guarding against. It warns
 * instead, and exposes `rlsEnforced` for health checks and the regression
 * suite, whose claims are only meaningful under a non-owner role.
 */
export function usingRlsRole(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false
  // Prisma prefixes may appear, e.g. "prisma+postgres://". Strip the scheme
  // before reading the username.
  const withoutScheme = databaseUrl.replace(/^[a-z+]+:\/\//i, '')
  const userinfo = withoutScheme.split('@')[0] ?? ''
  const user = userinfo.split(':')[0] ?? ''
  return user === 'fgmp_app' || user.startsWith('fgmp_app.')
}

/**
 * FGMP_REQUIRE_RLS — fail closed on a misconfigured connection.
 *
 * The check MUST NOT throw at module scope. `next build` evaluates route modules
 * without runtime secrets — throwing there breaks the build entirely (the same
 * reason auth.ts uses a build-time placeholder) — and on Cloudflare Workers,
 * where the app actually runs, a module-scope throw is answered to every
 * `/api/fgmp/*` request as a bare `500` with the reason visible nowhere. It is a
 * FUNCTION, called by `src/instrumentation.ts` at boot and by
 * `src/lib/fgmp/config-health.ts` on the request path, which turns the verdict
 * into `503 RLS_NOT_ENFORCED`. See the block comment in `src/lib/db.ts`.
 *
 * This module imports no database driver, so either caller can consult it
 * without loading Prisma.
 *
 * So the guard is a FUNCTION that the startup path calls. It is exported
 * separately from `db` so an entrypoint can run it before serving traffic.
 *
 * Default is OFF. Local development without PostgreSQL — or against a database
 * with no policies yet — must still boot. A deployed environment opts in by
 * setting FGMP_REQUIRE_RLS=1, which is the default in docker-compose.yml.
 */
export function assertRlsEnforced(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  required: string | undefined = process.env.FGMP_REQUIRE_RLS,
): void {
  const violation = rlsViolation(databaseUrl, required)
  if (violation) throw new Error(violation)
}

/**
 * The refusal message, or null when there is nothing to refuse.
 *
 * Split out from `assertRlsEnforced` so the text can be tested without
 * arranging a whole process environment — and so the message has exactly one
 * definition, which matters because it is printed at boot.
 *
 * ── WHY THE MESSAGE NAMES THE HOST AND ROLE BUT NEVER THE URL ───────────────
 * This text goes to stderr at startup, which in most deployments means the
 * container log, often shipped somewhere central and read by people who should
 * not hold database credentials. An earlier version prefixed the raw
 * `DATABASE_URL` — password included — to make the misconfiguration "easy to
 * spot". The host and the role are what an operator needs to identify the
 * connection; the password has no diagnostic value.
 *
 * Both arguments are required on purpose. Defaulting them to the environment
 * reads well at the call site but makes `rlsViolation(undefined, "1")` mean "use
 * the ambient DATABASE_URL" rather than "there is no URL", which is a different
 * question and is not what a caller passing `undefined` intends — a mistake
 * this function made until CI, where DATABASE_URL is set, disagreed with the
 * machine that wrote it.
 */
export function rlsViolation(
  databaseUrl: string | undefined,
  required: string | undefined,
): string | null {
  // Unset or "0"/"false" → opt out (local development).
  if (!required || required === '0' || required.toLowerCase() === 'false') return null
  if (usingRlsRole(databaseUrl)) return null

  return (
    'FGMP_REQUIRE_RLS is enabled but DATABASE_URL does not use the `fgmp_app` ' +
    'role. The table owner bypasses Row Level Security, so every tenant ' +
    'isolation guarantee in this application would be silently disabled.\n' +
    `  Host: ${describeDbHost(databaseUrl)}\n` +
    `  Detected role: ${describeDbUser(databaseUrl)}\n` +
    '  Fix: set DATABASE_URL to postgresql://fgmp_app:…@<host>/<database>?schema=public\n' +
    '  Or:  set FGMP_REQUIRE_RLS=0 to acknowledge the risk (development only).'
  )
}

/** Host only — enough to identify the connection, never the credentials. */
function describeDbHost(databaseUrl: string | undefined): string {
  if (!databaseUrl) return '(DATABASE_URL is not set)'
  try {
    return new URL(databaseUrl).host || '(unparseable DATABASE_URL)'
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

/** Best-effort role name for the error message, with credentials redacted. */
function describeDbUser(databaseUrl: string | undefined): string {
  if (!databaseUrl) return '(DATABASE_URL is not set)'
  const withoutScheme = databaseUrl.replace(/^[a-z+]+:\/\//i, '')
  const userinfo = withoutScheme.split('@')[0] ?? ''
  const user = userinfo.split(':')[0] ?? ''
  // Anything that is not shaped like a role is not a role. Echoing an
  // arbitrary substring of a malformed URL into a log line is how a stray
  // credential ends up somewhere it was never meant to be read.
  return /^[A-Za-z0-9_.-]+$/.test(user) ? user : '(unparseable DATABASE_URL)'
}
