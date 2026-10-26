import { PrismaPg } from '@prisma/adapter-pg'
import { usingRlsRole } from './db-rls'
import { PrismaClient } from '@prisma/client'

interface PgPoolStatsSource {
  readonly totalCount?: number
  readonly idleCount?: number
  readonly waitingCount?: number
  readonly options?: { readonly max?: number }
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaUrl: string | undefined
  pgPool: PgPoolStatsSource | undefined
}

/** Process-local snapshot of the actual node-postgres pool behind PrismaPg. */
export interface AppPgPoolStats {
  totalConnections: number
  idleConnections: number
  inUseConnections: number
  waitingClients: number
  maxConnections: number
  saturationRatio: number
}

export type PoolEnv = Record<string, string | undefined>

/**
 * Detect serverless / function-per-request runtimes (Netlify Functions,
 * AWS Lambda, Vercel, Cloudflare Pages, and workerd Workers).
 *
 * Serverless instances must not inherit a large default DB pool: the former
 * Prisma default (`num_physical_cpus * 2 + 1`, typically 5–9 connections) can
 * exhaust a 15-connection hosted PostgreSQL limit with only a few concurrent
 * instances. Cap each adapter pool at one connection; in Worker runtimes, also
 * retire each socket after one checkout so it cannot be reused across requests.
 */
export function isServerlessRuntime(env: PoolEnv = process.env): boolean {
  const flags = [
    env.NETLIFY,
    env.AWS_LAMBDA_FUNCTION_NAME,
    env.AWS_EXECUTION_ENV,
    env.VERCEL,
    env.CF_PAGES,
    env.CF_WORKERS,
  ]
  const hasRuntimeFlag = flags.some((v) => v !== undefined && v !== '' && v !== 'false' && v !== '0')
  // Cloudflare Workers does not always expose a platform env flag to process.env.
  // workerd's user agent is available in its JS runtime and lets us apply the
  // same one-connection policy without relying on an operator-supplied variable.
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return hasRuntimeFlag || /cloudflare|workerd/i.test(userAgent)
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

export interface ConfigurePoolUrlOptions {
  /** Default `connection_limit` on long-lived servers when not overridden by URL/env. */
  defaultLimit?: number
  /** Default `pool_timeout` in seconds when not already set on URL/env. */
  defaultPoolTimeoutSec?: number
  /** Default `connect_timeout` in seconds when not already set on URL. */
  defaultConnectTimeoutSec?: number
  env?: PoolEnv
}

/**
 * Normalize a PostgreSQL connection URL with bounded pool parameters so a
 * single process or serverless burst cannot exhaust hosted Postgres connection
 * limits (e.g. 15 total connections in Supabase Session Mode).
 *
 * - Never overwrites explicit `connection_limit`, `pool_timeout`, or
 *   `connect_timeout` query parameters already present on `rawUrl`.
 * - Preserves userinfo / password characters verbatim by manipulating only the
 *   query-string segment rather than round-tripping through `new URL()`.
 * - Defaults:
 *   - Serverless (`NETLIFY` / Lambda / Vercel): `connection_limit=1`
 *   - Long-lived server: `connection_limit=3` (or `defaultLimit=1` for the
 *     shared auxiliary/ops pool)
 *   - Explicit `FGMP_DB_CONNECTION_LIMIT` env var overrides the default ceiling.
 */
export function configurePoolUrl(
  rawUrl: string,
  options: ConfigurePoolUrlOptions = {},
): string {
  if (!/^postgres(?:ql)?:\/\//i.test(rawUrl)) {
    return rawUrl
  }
  const env = options.env ?? process.env
  const hashIdx = rawUrl.indexOf('#')
  const withoutHash = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl
  const fragment = hashIdx >= 0 ? rawUrl.slice(hashIdx) : ''

  const qIdx = withoutHash.indexOf('?')
  const base = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash
  const existingQuery = qIdx >= 0 ? withoutHash.slice(qIdx + 1) : ''
  const params = new URLSearchParams(existingQuery)

  if (!params.has('connection_limit')) {
    const envLimit = parsePositiveInt(env.FGMP_DB_CONNECTION_LIMIT)
    const defaultLimit = isServerlessRuntime(env)
      ? 1
      : (options.defaultLimit ?? 3)
    params.set('connection_limit', String(envLimit ?? defaultLimit))
  }
  if (!params.has('pool_timeout')) {
    const envTimeout = parsePositiveInt(env.FGMP_DB_POOL_TIMEOUT)
    params.set(
      'pool_timeout',
      String(envTimeout ?? options.defaultPoolTimeoutSec ?? (isServerlessRuntime(env) ? 5 : 10)),
    )
  }
  if (!params.has('connect_timeout')) {
    params.set(
      'connect_timeout',
      String(options.defaultConnectTimeoutSec ?? (isServerlessRuntime(env) ? 5 : 10)),
    )
  }

  return `${base}?${params.toString()}${fragment}`
}

export interface PgAdapterConfig {
  connectionString: string
  schema: string
  max: number
  maxUses?: number
  connectionTimeoutMillis: number
  idleTimeoutMillis: number
}

/**
 * Convert Prisma's PostgreSQL URL into node-postgres pool settings.
 *
 * Prisma's Rust engine understands URL options such as `schema`,
 * `connection_limit`, and `pool_timeout`; node-postgres uses explicit pool
 * options instead. `pg.Pool` exposes one `connectionTimeoutMillis` for both
 * opening a socket and waiting for a checked-out client, rather than Prisma's
 * separate `connect_timeout` and `pool_timeout` controls. Use the stricter of
 * the two so neither configured deadline is silently discarded. Keep the
 * existing URL defaults, transfer the schema and timeouts, and pass a bounded
 * pool to PrismaPg. Workerd/serverless connections are retired after one
 * checkout so a Worker never reuses a TCP socket across requests. `max: 1`
 * also bounds parallel DB work per client to one connection.
 */
export function configurePgAdapter(
  rawUrl: string,
  options: ConfigurePoolUrlOptions = {},
): PgAdapterConfig {
  if (!/^postgres(?:ql)?:\/\//i.test(rawUrl)) {
    throw new Error('Prisma PostgreSQL adapter requires a postgresql:// DATABASE_URL')
  }
  const configured = configurePoolUrl(rawUrl, options)
  let url: URL
  try {
    url = new URL(configured)
  } catch {
    // Do not rethrow URL's error: Node may attach the original input (including
    // its password) to the error object, which can then leak into deployment logs.
    throw new Error('DATABASE_URL is not a valid PostgreSQL connection URL')
  }
  const schema = url.searchParams.get('schema') || 'public'
  const configuredLimit = parsePositiveInt(url.searchParams.get('connection_limit') ?? undefined) ?? 1
  const connectTimeoutSeconds =
    parsePositiveInt(url.searchParams.get('connect_timeout') ?? undefined) ?? 5
  const poolTimeoutSeconds =
    parsePositiveInt(url.searchParams.get('pool_timeout') ?? undefined) ?? connectTimeoutSeconds
  const isServerless = isServerlessRuntime(options.env ?? process.env)

  for (const parameter of ['schema', 'connection_limit', 'pool_timeout', 'connect_timeout']) {
    url.searchParams.delete(parameter)
  }
  // Fragments are client-side URL metadata and must not reach the PG driver.
  url.hash = ''

  return {
    connectionString: url.toString(),
    schema,
    // Honor the existing pool setting but never let a single client create an
    // unbounded pool. Serverless/Workers defaults are one; local Node defaults
    // remain the existing three.
    max: Math.min(configuredLimit, isServerless ? 1 : 3),
    ...(isServerless ? { maxUses: 1 } : {}),
    connectionTimeoutMillis: Math.min(connectTimeoutSeconds, poolTimeoutSeconds) * 1_000,
    idleTimeoutMillis: isServerless ? 1_000 : 300_000,
  }
}

/** Build an adapter-backed Prisma client configuration from a database URL. */
export function createPgAdapter(
  rawUrl: string,
  options: ConfigurePoolUrlOptions = {},
): PrismaPg {
  const config = configurePgAdapter(rawUrl, options)
  const { schema, ...poolConfig } = config
  return new PrismaPg(poolConfig, { schema })
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
 * Capture the actual pg.Pool exposed by PrismaPg's public adapter API.
 *
 * Keeping the pool reference is observation only: application queries continue
 * through this same adapter and `DATABASE_URL`; this does not create a second
 * connection or bypass tenant context. If a future adapter removes
 * `underlyingDriver()`, query service remains unaffected and the metric remains
 * absent rather than being estimated from request counts.
 */
function observePrismaPgPool(adapter: PrismaPg): PrismaPg {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'connect') {
        return async () => {
          const connection = await target.connect()
          try {
            globalForPrisma.pgPool = connection.underlyingDriver() as unknown as PgPoolStatsSource
          } catch {
            globalForPrisma.pgPool = undefined
          }
          return connection
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function nonnegativeCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

/**
 * Read process-local counters from the real app-role pg.Pool, or null before
 * Prisma has connected / if a future adapter no longer exposes compatible
 * pool statistics. This performs no SQL and never publishes URL/role details.
 */
export function getAppPgPoolStats(): AppPgPoolStats | null {
  const pool = globalForPrisma.pgPool
  const maxConnections = pool?.options?.max
  if (!pool || typeof maxConnections !== 'number' || !Number.isFinite(maxConnections) || maxConnections <= 0) {
    return null
  }

  const totalConnections = nonnegativeCount(pool.totalCount)
  const idleConnections = Math.min(totalConnections, nonnegativeCount(pool.idleCount))
  const inUseConnections = Math.max(0, totalConnections - idleConnections)
  const waitingClients = nonnegativeCount(pool.waitingCount)
  return {
    totalConnections,
    idleConnections,
    inUseConnections,
    waitingClients,
    maxConnections,
    saturationRatio: Math.min(1, inUseConnections / maxConnections),
  }
}

/**
 * Row Level Security posture — the DECISION lives in `src/lib/db-rls.ts`.
 *
 * It is a separate, Prisma-free module so that `src/lib/fgmp/config-health.ts`
 * can consult the verdict on the request path (and a unit test can exercise it)
 * without pulling a database driver into the module graph. Re-exported here so
 * `instrumentation.ts`, the RLS regression scripts and `db.test.ts` keep their
 * existing import path.
 */
export { assertRlsEnforced, rlsViolation, usingRlsRole } from './db-rls'

const dbIsRlsEnforced = usingRlsRole(process.env.DATABASE_URL)

if (process.env.NODE_ENV !== 'production' && !dbIsRlsEnforced) {
  console.warn(
    '[db] DATABASE_URL is not using the `fgmp_app` role. Row Level Security ' +
      'is bypassed by the table owner, so RLS policies will NOT be enforced ' +
      'for this process. Use postgresql://fgmp_app:…@…/fgmp?schema=public for ' +
      'the web app and keep the migrate role for migrations only.',
  )
}

/**
 * The Prisma client, constructed on FIRST USE rather than at import.
 *
 * The generated client uses `engineType = "client"`, so runtime queries go
 * through the PostgreSQL driver adapter rather than a native Rust query engine.
 * Keeping construction lazy still matters: importing the database layer does
 * not allocate a driver pool, and a process that never queries never opens a
 * database connection. The shared adapter pool is capped, and Worker sockets
 * are retired after a single checkout instead of being reused across requests.
 *
 * The proxy forwards every property access to the real client, so `db.user`,
 * `db.$transaction`, `db.$queryRaw` and typing are unchanged for callers — the
 * only difference is that the first access is what constructs it.
 */
function getClient(): PrismaClient {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be configured before querying PostgreSQL')
  }
  const configuredUrl = configurePoolUrl(databaseUrl)
  if (
    !globalForPrisma.prisma ||
    globalForPrisma.prismaUrl !== configuredUrl
  ) {
    globalForPrisma.pgPool = undefined
    globalForPrisma.prisma = new PrismaClient({
      adapter: observePrismaPgPool(createPgAdapter(databaseUrl)),
      log: logLevels,
    })
    globalForPrisma.prismaUrl = configuredUrl
  }
  return globalForPrisma.prisma
}

export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, _receiver) {
    // Never look thenable: awaiting `db` itself is a mistake, not a query.
    if (prop === 'then') return undefined
    const client = getClient() as unknown as Record<PropertyKey, unknown>
    const value = Reflect.get(client, prop, client)
    return typeof value === 'function' ? value.bind(client) : value
  },
  has(_target, prop) {
    return prop in (getClient() as unknown as object)
  },
  set(_target, prop, value) {
    (getClient() as unknown as Record<PropertyKey, unknown>)[prop as string] = value
    return true
  },
})

/**
 * ── THE FGMP_REQUIRE_RLS GUARD IS NOT RUN AT MODULE SCOPE ───────────────────
 * It used to be:
 *
 *     if (process.env.NEXT_PHASE !== 'phase-production-build') {
 *       assertRlsEnforced()
 *     }
 *
 * That call is removed, and the reason is the platform this app actually runs
 * on. `assertRlsEnforced()` THROWS. On a long-lived Node container that is a
 * boot failure with a printed reason. On Cloudflare Workers — the production
 * target, see docs/DEPLOYMENT.md §4 — a throw during module evaluation is
 * answered to EVERY request to EVERY route that transits this module as a bare
 * `500 Internal Server Error`, with no reason on the wire (`observability.logs`
 * is off) and with the failed evaluation cached for the life of the isolate.
 * Every `/api/fgmp/*` route transitively imports this module through the auth
 * helper, so a database ROLE typo presented as "the entire API is down, cause
 * unknown" — including routes that never touch a tenant table.
 *
 * The guard is not weakened; it MOVED, and it now fails in a way that can be
 * read:
 *
 *   boot    src/instrumentation.ts      assertRlsEnforced() — the Node/Docker
 *                                       path still refuses to start.
 *   request src/lib/fgmp/config-health  the same `rlsViolation()` verdict is
 *                                       turned into 503 RLS_NOT_ENFORCED by
 *                                       requireAuth(), before any handler runs.
 *   probe   GET /api/health/ready       unauthenticated, reports the code.
 *
 * `assertRlsEnforced()` stays exported for scripts, tests and the boot hook.
 * Do not re-add a module-scope call: it converts a configuration error into a
 * platform-wide, unreadable outage.
 */


/**
 * Whether this process is expected to be running under RLS enforcement.
 *
 * The regression suite reports this so a claim like "cross-tenant reads are
 * blocked" is never made from a connection whose role bypasses the policy.
 */
export const rlsEnforced = dbIsRlsEnforced
