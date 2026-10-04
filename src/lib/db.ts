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
 * held to them if it connects as the non-owner role. The table owner BYPASSES
 * RLS unless `FORCE ROW LEVEL SECURITY` is set, and `fgmp_app` is deliberately
 * provisioned as a separate non-owner role precisely so that mistakes in
 * application code cannot silently disable the backstop.
 *
 * Consequently the runtime connection string MUST use the `fgmp_app` role:
 *
 *   postgresql://fgmp_app:…@…/fgmp?schema=public     ← correct (RLS applies)
 *   postgresql://fgmp_migrate:…@…/fgmp?schema=public  ← WRONG in the web app
 *
 * Running the web app on the migrate/owner role would leave the application
 * code as the ONLY line of defence — which is exactly what this phase exists
 * to remove. This module deliberately does NOT rewrite the role at runtime:
 * silently connecting as a different principal than the operator configured
 * would hide exactly the misconfiguration we are guarding against.
 *
 * `verifyRlsEnforced()` (below) surfaces the mismatch loudly instead.
 */
function usingRlsRole(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false
  // Prisma prefixes may appear, e.g. "prisma+postgres://". Strip them before
  // reading the username.
  const withoutScheme = databaseUrl.replace(/^[a-z+]+:\/\//i, '')
  const userinfo = withoutScheme.split('@')[0] ?? ''
  const user = userinfo.split(':')[0] ?? ''
  return user === 'fgmp_app'
}

const dbIsRlsEnforced = usingRlsRole(process.env.DATABASE_URL)

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
 * Whether this process is expected to be running under RLS enforcement.
 *
 * Exposed for health checks and the regression suite, which assert the real
 * database rejects cross-tenant access — a claim that is only meaningful when
 * the connection is a non-owner role.
 */
export const rlsEnforced = dbIsRlsEnforced
