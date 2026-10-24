/**
 * Real PostgreSQL checks for the app-role connection pool.
 *
 * Run against an isolated PostgreSQL database with migrations applied and
 * DATABASE_URL set to the non-owner `fgmp_app` role:
 *
 *   FGMP_REQUIRE_RLS=1 bun run test:db-connections
 *
 * The test performs no writes. It verifies the authenticated database role,
 * samples and saturates the actual PrismaPg/node-postgres pool with read-only
 * work, then uses a second app-role client capped at one connection to prove
 * `pool_timeout` bounds acquisition wait and that the pool recovers. No
 * migrate/ops URL is read.
 */

import { PrismaClient } from "@prisma/client";
import {
  createPgAdapter,
  db,
  getAppPgPoolStats,
  usingRlsRole,
} from "@/lib/db";
import { observePoolSaturation } from "@/lib/fgmp/alerting/metrics-wiring";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { registry } from "@/lib/observability/metrics";

const databaseUrl = process.env.DATABASE_URL;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const testLog = [
  { level: "warn" as const, emit: "stdout" as const },
  { level: "error" as const, emit: "stdout" as const },
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function testUrl(raw: string): string {
  const url = new URL(raw);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "1");
  url.searchParams.set("connect_timeout", "5");
  return url.toString();
}

async function verifyLiveAppRole(): Promise<void> {
  assert(databaseUrl, "DATABASE_URL is required; this test never falls back to a privileged URL");
  assert(usingRlsRole(databaseUrl), "DATABASE_URL must name fgmp_app (RLS-enforced role)");

  const rows = await db.$queryRaw<Array<{
    role_name: string;
    is_superuser: boolean;
    bypass_rls: boolean;
    server_version: string;
    forced_rls_tables: number;
  }>>`
    SELECT current_user::text AS role_name,
           r.rolsuper AS is_superuser,
           r.rolbypassrls AS bypass_rls,
           current_setting('server_version')::text AS server_version,
           (SELECT count(*)::int
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND c.relkind = 'r'
               AND c.relrowsecurity
               AND c.relforcerowsecurity) AS forced_rls_tables
      FROM pg_roles r
     WHERE r.rolname = current_user
  `;
  const actual = rows[0];
  assert(actual, "PostgreSQL did not return role attributes for the authenticated user");
  assert(
    actual.role_name === "fgmp_app" && !actual.is_superuser && !actual.bypass_rls,
    "PostgreSQL must authenticate this connection as fgmp_app without SUPERUSER or BYPASSRLS",
  );
  assert(actual.forced_rls_tables > 0, "no ENABLE+FORCE RLS tables were found in public");
  console.log(
    `PASS live role: ${actual.role_name}; superuser=${actual.is_superuser}; ` +
      `bypassrls=${actual.bypass_rls}; FORCE-RLS tables=${actual.forced_rls_tables}; ` +
      `PostgreSQL ${actual.server_version}`,
  );
}

async function verifyPoolMetrics(): Promise<void> {
  const before = getAppPgPoolStats();
  assert(before, "the app PrismaPg pool did not expose its real pg.Pool statistics");
  assert(before.maxConnections > 0, "the app pool reported an invalid connection cap");
  assert(before.totalConnections <= before.maxConnections, "the app pool exceeded its configured cap");

  const ratio = observePoolSaturation();
  assert(ratio !== null, "pool saturation was not published from the real app pool");
  const exposition = registry.render();
  assert(
    exposition.includes("fgmp_db_pool_saturation_ratio "),
    "the Prometheus saturation gauge is absent after sampling the real pool",
  );
  assert(
    exposition.includes('fgmp_db_pool_connections{state="max"}'),
    "the process-local connection-count gauge is absent after sampling the real pool",
  );
  console.log(
    `PASS app pool metrics: total=${before.totalConnections}, idle=${before.idleConnections}, ` +
      `in_use=${before.inUseConnections}, waiting=${before.waitingClients}, ` +
      `max=${before.maxConnections}, saturation=${ratio.toFixed(3)}`,
  );
}

async function verifyPoolMetricsUnderLoad(): Promise<void> {
  const work = Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      withTenant(`pool-metrics-${index}`, async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ result: number }>>(
          "SELECT 1::int AS result FROM pg_sleep(0.25)",
        );
        assert(rows[0]?.result === 1, "a read-only pool-load query returned an unexpected value");
      }),
    ),
  );

  await sleep(80);
  const stats = getAppPgPoolStats();
  const ratio = observePoolSaturation();
  const exposition = registry.render();
  await work;

  assert(stats, "the app pool snapshot disappeared during real concurrent PostgreSQL work");
  assert(
    stats.inUseConnections === stats.maxConnections && stats.waitingClients > 0,
    `expected a full app pool with queued work; saw in_use=${stats.inUseConnections}/${stats.maxConnections}, ` +
      `waiting=${stats.waitingClients}`,
  );
  assert(ratio === 1, `expected saturation ratio 1 under queued load, got ${String(ratio)}`);
  assert(
    exposition.includes("fgmp_db_pool_saturation_ratio 1"),
    "the Prometheus gauge did not publish full saturation while real work was queued",
  );
  assert(
    exposition.includes(`fgmp_db_pool_connections{state="waiting"} ${stats.waitingClients}`),
    "the Prometheus waiting-client gauge did not match the actual pg.Pool snapshot",
  );
  console.log(
    `PASS saturated app pool metrics: in_use=${stats.inUseConnections}/${stats.maxConnections}, ` +
      `waiting=${stats.waitingClients}, saturation=${ratio}`,
  );
}

interface PoolClientProbe {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  release(): void;
}

interface PgPoolProbe {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  readonly options: {
    readonly max: number;
    readonly connectionTimeoutMillis?: number;
  };
  connect(): Promise<PoolClientProbe>;
}

async function verifyPoolTimeoutAndRecovery(): Promise<void> {
  assert(databaseUrl, "DATABASE_URL is required; no privileged fallback is permitted");
  const observed = { pool: null as PgPoolProbe | null };
  const getObservedPool = (): PgPoolProbe | null => observed.pool;
  const factory = createPgAdapter(testUrl(databaseUrl));
  const observedFactory = new Proxy(factory, {
    get(target, property) {
      if (property === "connect") {
        return async () => {
          const connection = await target.connect();
          observed.pool = connection.underlyingDriver() as unknown as PgPoolProbe;
          return connection;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const client = new PrismaClient({ adapter: observedFactory, log: testLog });

  try {
    // Warm the one-connection pool before holding its only client, so the
    // timeout under test is acquisition queueing, not initial socket connect.
    await client.$queryRaw`SELECT 1::int AS warmed`;
    const pool = getObservedPool();
    assert(pool, "PrismaPg did not expose the pool created for the test client");
    assert(pool.options.max === 1, "the test adapter did not create a one-connection pool");
    assert(
      pool.options.connectionTimeoutMillis === 1_000,
      "pool_timeout=1 and connect_timeout=5 did not map to a 1s pg.Pool deadline",
    );

    // Checkout from the adapter's real pool and hold it with a read-only query
    // against PostgreSQL. A second checkout must time out at pool_timeout.
    const heldClient = await pool.connect();
    let waitedMs = 0;
    const holdMs = 1_800;
    const heldQuery = heldClient.query(
      "SELECT 1::int AS held FROM pg_sleep($1::double precision)",
      [holdMs / 1_000],
    );
    try {
      assert(
        pool.totalCount === 1 && pool.idleCount === 0,
        `the checkout did not hold the pool's only client (total=${pool.totalCount}, idle=${pool.idleCount}, waiting=${pool.waitingCount})`,
      );

      const startedAt = performance.now();
      const pendingCheckout = pool.connect();
      await sleep(50);
      const queuedClientCount = pool.waitingCount;
      let acquisitionRejected = false;
      try {
        const extra = await pendingCheckout;
        extra.release();
      } catch {
        // This calls connect() on the same pg.Pool created by PrismaPg, while a
        // real PostgreSQL query holds its only client. Do not echo driver details.
        acquisitionRejected = true;
      }
      waitedMs = performance.now() - startedAt;
      await heldQuery;

      assert(queuedClientCount === 1, "the pool did not report the extra client waiting for acquisition");
      assert(acquisitionRejected, "pg.Pool.connect() did not enforce the configured acquisition wait");
      assert(
        waitedMs >= 700 && waitedMs < 2_000,
        `expected the 1s pool_timeout to reject near one second, waited ${Math.round(waitedMs)}ms`,
      );
    } finally {
      await heldQuery.catch(() => undefined);
      heldClient.release();
    }

    const recovered = await client.$queryRaw<Array<{ result: number }>>`
      SELECT 7::int AS result
    `;
    assert(recovered[0]?.result === 7, "the one-connection pool did not recover after acquisition timeout");
    console.log(
      `PASS pool timeout/recovery: extra checkout rejected after ${Math.round(waitedMs)}ms; ` +
        "a follow-up Prisma query succeeded",
    );
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  console.log("\nFGMP — real PostgreSQL connection regression\n");
  await verifyLiveAppRole();
  await verifyPoolMetrics();
  await verifyPoolMetricsUnderLoad();
  await verifyPoolTimeoutAndRecovery();
  console.log("\nPASS — live app role, actual pool statistics, pool timeout and recovery.\n");
}

main()
  .catch((error) => {
    console.error("\nFAIL:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect().catch(() => undefined);
  });
