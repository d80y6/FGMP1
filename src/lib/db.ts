import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Logging: only `warn` and `error` in dev, `error` only in prod.
// The previous `log: ['query']` setting flooded dev.log with every SQL
// statement (20K+ lines/min under the telemetry engine), which was a
// primary contributor to the recurring next-server OOM crashes in the
// 4 GB cgroup. Query-level logging is rarely useful in normal operation
// — enable it temporarily by setting DEBUG_PRISMA=1 if needed.
const logLevels = process.env.DEBUG_PRISMA === '1'
  ? [{ level: 'query' as const, emit: 'stdout' as const }, { level: 'warn' as const, emit: 'stdout' as const }, { level: 'error' as const, emit: 'stdout' as const }]
  : [{ level: 'warn' as const, emit: 'stdout' as const }, { level: 'error' as const, emit: 'stdout' as const }]

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
function usingRlsRole(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false
  // Prisma prefixes may appear, e.g. "prisma+postgres://". Strip the scheme
  // before reading the username.
  const withoutScheme = databaseUrl.replace(/^[a-z+]+:\/\//i, '')
  const userinfo = withoutScheme.split('@')[0] ?? ''
  const user = userinfo.split(':')[0] ?? ''
  return user === 'fgmp_app'
}

const dbIsRlsEnforced = usingRlsRole(process.env.DATABASE_URL)

/**
 * FGMP_REQUIRE_RLS — fail closed on a misconfigured connection.
 *
 * This module is imported by every route and by `next build`'s module graph, so
 * the check MUST NOT throw at module scope: the build evaluates route modules
 * without runtime secrets, and throwing there breaks `next build` entirely
 * (the same reason auth.ts uses a build-time placeholder instead of throwing).
 *
 * So the guard is a FUNCTION that the startup path calls. It is exported
 * separately from `db` so an entrypoint can run it before serving traffic.
 *
 * Default is OFF. Local development without PostgreSQL — or against a database
 * with no policies yet — must still boot. A deployed environment opts in by
 * setting FGMP_REQUIRE_RLS=1, which is the default in docker-compose.yml.
 */
export function assertRlsEnforced(): void {
  const required = process.env.FGMP_REQUIRE_RLS
  // Unset or "0"/"false" → opt out (local development).
  if (!required || required === '0' || required.toLowerCase() === 'false') return

  if (dbIsRlsEnforced) return

  throw new Error(
    'FGMP_REQUIRE_RLS is enabled but DATABASE_URL does not use the `fgmp_app` ' +
      'role. The table owner bypasses Row Level Security, so every tenant ' +
      'isolation guarantee in this application would be silently disabled.\n' +
      '  Fix: set DATABASE_URL to postgresql://fgmp_app:…@…/fgmp?schema=public\n' +
      '  Or:  set FGMP_REQUIRE_RLS=0 to acknowledge the risk (development only).\n' +
      `  Detected role: ${describeDbUser(process.env.DATABASE_URL)}`,
  )
}

/** Best-effort role name for the error message, with credentials redacted. */
function describeDbUser(databaseUrl: string | undefined): string {
  if (!databaseUrl) return '(DATABASE_URL is not set)'
  const withoutScheme = databaseUrl.replace(/^[a-z+]+:\/\//i, '')
  const userinfo = withoutScheme.split('@')[0] ?? ''
  return userinfo.split(':')[0] || '(unparseable DATABASE_URL)'
}

if (process.env.NODE_ENV !== 'production' && !dbIsRlsEnforced) {
  console.warn(
    '[db] DATABASE_URL is not using the `fgmp_app` role. Row Level Security ' +
      'is bypassed by the table owner, so RLS policies will NOT be enforced ' +
      'for this process. Use postgresql://fgmp_app:…@…/fgmp?schema=public for ' +
      'the web app and keep the migrate role for migrations only.',
  )
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: logLevels,
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

/**
 * Run the FGMP_REQUIRE_RLS guard.
 *
 * `assertRlsEnforced` is exported for explicit callers and tests. This wrapper
 * runs it at module load on the SERVER runtime only, which is what makes the
 * app actually "refuse to start" as docker-compose.yml claims — a process that
 * imports the database layer with a misconfigured connection dies here rather
 * than serving traffic with tenant isolation silently disabled.
 *
 * It is deliberately skipped during `next build`: the build imports every route
 * module to collect page data, runtime secrets do not exist yet, and throwing
 * there breaks the production build (the same constraint auth.ts documents for
 * its placeholder secret). A build is not a serving process; a misconfigured
 * deployment must still fail at boot.
 */
if (process.env.NEXT_PHASE !== 'phase-production-build') {
  assertRlsEnforced()
}

/**
 * Whether this process is expected to be running under RLS enforcement.
 *
 * The regression suite reports this so a claim like "cross-tenant reads are
 * blocked" is never made from a connection whose role bypasses the policy.
 */
export const rlsEnforced = dbIsRlsEnforced
