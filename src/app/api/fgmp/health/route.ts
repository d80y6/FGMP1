import { NextResponse, type NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { getOpsDb } from "@/lib/fgmp/owner-db";
import { auditFailureCount } from "@/lib/fgmp/audit";
import { requireRole, ROLES, isSuperAdminUser } from "@/lib/fgmp/auth-helpers";
import { errorResponse } from "@/lib/fgmp/api-error";
import {
  getMetrics,
  getAvgResponseMs,
  getRecentErrors,
  type RecordedError,
} from "@/lib/fgmp/metrics";
import {
  apinatorServerConfig,
  apinatorWsUrl,
  getApinatorServer,
} from "@/lib/fgmp/apinator-server";

export const dynamic = "force-dynamic";

/**
 * FGMP System Health Endpoint (Task 32-A)
 * ─────────────────────────────────────────────────────────────────────────────
 * ADMIN-only aggregate health snapshot for the System Health NOC dashboard.
 *
 * Returns:
 *   - uptime           : formatted "Xd Yh Zm" + raw `uptimeSeconds`
 *   - memory           : process.memoryUsage() converted to MB
 *   - database         : PostgreSQL size + TENANT-SCOPED row counts
 *   - realtime         : hosted Apinator channels probe — `connected` reflects
 *                        a successful channels API call, `clients` is the sum
 *                        of subscription counts across `private-tenant-*`
 *                        channels, `url` is the cluster's WebSocket endpoint
 *   - api              : avg response time + total requests (since boot)
 *   - sessions         : users with lastLoginAt within the last 24h (tenant)
 *   - errors           : last 10 captured errors, detail REDACTED
 *   - timestamp        : ISO string of when this snapshot was assembled
 *
 * The result is cached in-process for 30 seconds (CACHE_TTL_MS) so the
 * auto-refreshing health indicator doesn't repeatedly query the database. The cache is per-process; in a multi-
 * instance deployment each instance would have its own cache (acceptable
 * for a NOC display — Prometheus/StatsD would replace this in a hardened
 * production deployment).
 *
 * ── LEAK FIXES ────────────────────────────────────────────────────────────
 * This endpoint previously disclosed three things to ANY tenant admin:
 *
 *  1. `database.path` was the ABSOLUTE database path from `DATABASE_URL` —
 *     filesystem disclosure (mount layout, often the OS username).
 *  2. `tableCounts` ran UNSCOPED `db.*.count()`, so tenant A learned
 *     platform-wide row counts across all tenants (alarm/user/audit volume
 *     for the whole platform, i.e. a side channel on every other tenant's
 *     size and activity). Counts are now tenant-scoped; SUPERADMIN still gets
 *     platform-wide FIGURES — read on the ops connection, deliberately, because
 *     a count is not another tenant's row (docs/SUPERADMIN.md §2.1).
 *  3. `errors[]` was the raw ring buffer, whose `message` field carries
 *     internal exception text (Prisma messages, stack-derived strings). It
 *     is reduced to timestamp / method / status / route.
 *
 * Process-level figures (uptime, RSS/heap, total request count, realtime
 * client count) remain global by nature — they describe the server, not a
 * tenant's data, and are needed for the NOC display.
 */

/**
 * Platform-wide counts for the SUPERADMIN view, on the ops connection.
 *
 * A super-admin is not a member of any one tenant and legitimately wants
 * platform-wide figures, so this path cannot use a tenant context — there is
 * no single tenant to scope to. That makes it a deliberate BY-DESIGN-OPS
 * access, documented here so it is not mistaken for the same bug the tenant
 * path just had.
 *
 * It THROWS rather than falling back to the ambient client. A health endpoint
 * that silently reports zeros when its privileged connection is unavailable is
 * precisely the monitoring lie this route previously told.
 */
/**
 * Database size in bytes, asked of PostgreSQL.
 *
 * This replaces `fs.statSync()` on a SQLite file. Since the Phase 1 move to
 * PostgreSQL there is no file to stat, so the old branch reported 0 bytes for
 * every deployment — a number that looks measured and is not. `pg_database_size`
 * includes indexes and TOAST data, which is the figure an operator means by
 * "how big is the database".
 */
async function databaseSize(client: PrismaClient): Promise<number> {
  const rows = await client.$queryRaw<{ size: bigint | number }[]>`
    SELECT pg_database_size(current_database()) AS size
  `;
  return Number(rows[0]?.size ?? 0);
}

interface OpsHealthCountsRow {
  sites: number;
  alarms: number;
  users: number;
  auditLogs: number;
  activeUsers: number;
  sizeBytes: bigint | number;
}

async function opsCounts(twentyFourHoursAgo: Date) {
  const client = getOpsDb();
  if (!client) {
    throw new Error(
      "SUPERADMIN health view requires FGMP_OPS_DATABASE_URL (or FGMP_MIGRATE_DATABASE_URL). " +
        "Platform-wide counts cannot be served by a tenant-scoped connection. Refusing rather " +
        "than reporting zero, because an empty platform reported as healthy is a monitoring lie.",
    );
  }
  // Execute all 6 platform metrics in ONE single SQL statement on the shared
  // `getOpsDb()` pool — uses 1 connection and 1 network round-trip instead of
  // spinning up a transient PrismaClient and opening 6 concurrent connections.
  const rows = await client.$queryRaw<OpsHealthCountsRow[]>`
    SELECT
      (SELECT COUNT(*)::int FROM "Site") AS "sites",
      (SELECT COUNT(*)::int FROM "Alarm") AS "alarms",
      (SELECT COUNT(*)::int FROM "User") AS "users",
      (SELECT COUNT(*)::int FROM "AuditLog") AS "auditLogs",
      (SELECT COUNT(*)::int FROM "User" WHERE "lastLoginAt" >= ${twentyFourHoursAgo}) AS "activeUsers",
      pg_database_size(current_database()) AS "sizeBytes"
  `;
  const row = rows[0];
  return {
    sites: Number(row?.sites ?? 0),
    alarms: Number(row?.alarms ?? 0),
    sensorReadings: 0,
    users: Number(row?.users ?? 0),
    auditLogs: Number(row?.auditLogs ?? 0),
    activeUsers: Number(row?.activeUsers ?? 0),
    sizeBytes: Number(row?.sizeBytes ?? 0),
    scopeMode: "platform" as const,
  };
}

// ── Config ────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 30_000;
/**
 * Budget for the hosted Apinator channels call. The old self-hosted probe
 * used a 500ms TCP connect + an 800ms HTTP fetch; a single 800ms race against
 * the hosted REST API keeps the dashboard's poll responsive even when the
 * provider is unreachable (the probe degrades to `connected: false` instead
 * of hanging the snapshot).
 */
const APINATOR_PROBE_TIMEOUT_MS = 800;
/**
 * Only tenant-private channels are counted: they exist exactly when at least
 * one tenant browser holds a live subscription, which is the number the NOC
 * display means by "clients".
 */
const APINATOR_CHANNEL_PREFIX = "private-tenant-";
const APINATOR_QUERY_PREFIX = "private-";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const BYTES_PER_MB = 1024 * 1024;

/**
 * Cache key per tenant. The snapshot is tenant-scoped now, so the cache must
 * be too — serving tenant A's cached counts to tenant B would reintroduce
 * exactly the cross-tenant leak this endpoint just had.
 */
const cache = new Map<string, { ts: number; data: HealthResponse }>();

// ── Response shape ────────────────────────────────────────────────────────
export interface HealthResponse {
  uptime: string;
  uptimeSeconds: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  database: {
    type: "postgres";
    sizeBytes: number;
    sizeMB: number;
    /**
     * Database name only ("fgmp"). Credentials and host are deliberately NOT
     * returned — the health payload is readable by any tenant ADMIN, and a
     * connection string is an infrastructure disclosure.
     */
    path: string;
    /** True when the row counts below cover only the caller's tenant. */
    scopedToTenant: boolean;
    tableCounts: {
      sites: number;
      alarms: number;
      sensorReadings: number;
      users: number;
      auditLogs: number;
    };
    /**
     * Audit writes that could NOT be persisted by either the tenant-scoped or
     * the owner connection.
     *
     * Surfaced because an operator who cannot see this will believe they have a
     * compliance trail when they do not. A non-zero value means real actions are
     * unrecorded — a compliance gap, and the same class of problem as a platform
     * reporting itself healthy while serving empty data.
     *
     * Counted in-process, so it resets on restart; the durable signal is the
     * error-level log emitted with each failure.
     */
    auditWriteFailures: number;
  };
  realtime: {
    connected: boolean;
    url: string;
    clients: number;
  };
  api: {
    avgResponseMs: number;
    totalRequests: number;
  };
  sessions: {
    activeUsers: number;
  };
  /**
   * Redacted error entries — see `redactErrors`. The `message` field is kept
   * as a fixed placeholder (not the raw text) so the consumer's table shape
   * is unchanged.
   */
  errors: {
    timestamp: string;
    method: string;
    path: string;
    status: number;
    message: string;
  }[];
  timestamp: string;
  /**
   * Three-state verdict. `HEALTHY` requires positive evidence that the scoped
   * read returned rows; an empty scope reports `HEALTHY_BUT_EMPTY` rather than
   * claiming health; an unreadable database throws and produces no verdict.
   */
  verdict: "HEALTHY" | "HEALTHY_BUT_EMPTY";
  /** Whether `tableCounts` covers one tenant or the whole platform. */
  scopeMode: "tenant" | "platform";
}

/** Non-disclosing label for the live database (name only, never the URL). */
const DB_PATH_DISPLAY = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "") || "fgmp";
  } catch {
    return "fgmp";
  }
})();

const REDACTED_ERROR_MESSAGE = "(detail redacted — see server logs)";

/**
 * Strip the raw `message` from the error ring buffer. The message carries
 * raw exception text (Prisma errors, stack-derived strings) which can name
 * tables, columns, file paths and query fragments. Timestamp / method / route
 * / status are enough to locate the corresponding server-side log line.
 *
 * The `message` KEY is retained with a constant placeholder so the client
 * table (`system-health-view.tsx` renders `e.message`) keeps its shape
 * without receiving the detail it used to get.
 */
function redactErrors(errors: RecordedError[]) {
  return errors.map((e) => ({
    timestamp: e.timestamp,
    method: e.method,
    path: e.path,
    status: e.status,
    message: REDACTED_ERROR_MESSAGE,
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Format an uptime in seconds as "Xd Yh Zm" (e.g. "2d 14h 32m"). */
function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

/** Round to 2 decimal places (avoids floating-point noise in MB display). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Convert bytes to MB with 2-decimal precision. */
function bytesToMb(bytes: number): number {
  return round2(bytes / BYTES_PER_MB);
}

/**
 * Probe the hosted Apinator channels API for liveness + client count.
 *
 * Replaces the old two-step probe against the self-hosted realtime service
 * (TCP connect to :3003, then an HTTP `/health` fetch for the client count).
 * Realtime is now an external provider, so "is it up" and "how many clients"
 * both come from the same authenticated REST call: listing the
 * `private-tenant-*` channels. Those channels exist exactly while browsers
 * hold subscriptions, so a successful listing both proves the credentials and
 * the data plane work AND yields the client figure the NOC display wants.
 *
 * Degradation is deliberate and total — any of these reports
 * `connected: false, clients: 0`:
 *   - no Apinator config in the environment (the migration treats realtime as
 *     optional infrastructure; an unconfigured deployment reports down rather
 *     than pretending),
 *   - the call errors (bad credentials, provider outage, rate limit),
 *   - the call exceeds APINATOR_PROBE_TIMEOUT_MS (raced against a resolving
 *     timeout promise; the loser is left to settle on its own — its result is
 *     simply ignored, and a rejection after the race is still observed by the
 *     race's own handler so it cannot become an unhandled rejection).
 */
async function probeApinatorChannels(): Promise<{
  connected: boolean;
  clients: number;
  url: string;
}> {
  const config = apinatorServerConfig();
  // Unconfigured deployment: report down with the em-dash placeholder the
  // system-health view renders for "no endpoint".
  if (!config) {
    return { connected: false, clients: 0, url: "—" };
  }
  const url = apinatorWsUrl(config.cluster);
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channels = await Promise.race([
      getApinatorServer()?.getChannels(APINATOR_QUERY_PREFIX),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), APINATOR_PROBE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    // Null = the timeout won the race (or the server was unavailable). Either
    // way the probe has no positive evidence of a working channel API.
    if (!channels) {
      return { connected: false, clients: 0, url };
    }
    const clients = channels.reduce((sum, ch) => {
      if (ch.name.startsWith(APINATOR_CHANNEL_PREFIX)) {
        return sum + (Number(ch.subscription_count) || 0);
      }
      return sum;
    }, 0);
    return { connected: true, clients, url };
  } catch {
    // Auth failure / network error / provider 5xx. A health endpoint that
    // silently swallows the error into "connected: true" would be the same
    // monitoring lie this route's verdict logic was built to prevent.
    return { connected: false, clients: 0, url };
  }
}

// ── Handler ───────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // ADMIN-only — system internals (process memory, DB size, error log)
  // must not leak to non-admin roles.
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  const me = auth.user;

  // SUPERADMIN gets platform-wide COUNTS, read on the ops connection on
  // purpose; everyone else is pinned to their tenant. Rows are a different
  // question with a different answer — see docs/SUPERADMIN.md.
  const superAdmin = isSuperAdminUser(me);
  const tenantId = superAdmin ? undefined : me.tenantId;
  const cacheKey = tenantId ?? "*";

  // Serve from cache if fresh (avoids re-running the 5+ Prisma count()
  // queries on every dashboard poll). Keyed per tenant.
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
  }

  try {
    // ── Process-level data (cheap) ─────────────────────────────────────
    const mem = process.memoryUsage();
    const uptimeSeconds = process.uptime();

    // ── Realtime probe (hosted Apinator channels API) ──────────────────
    // One authenticated REST call replaces the old TCP probe + /health fetch;
    // it degrades to connected:false on any error or the 800ms timeout.
    const rt = await probeApinatorChannels();

    // ── Prisma aggregations (parallel, TENANT-SCOPED) ─────────────────
    // Models carrying a direct tenantId: Site, Alarm, User, AuditLog.
    // SensorReading has NO tenant column and NO `site` relation in the schema
    // (see prisma/schema.prisma) — only `siteId` — so its scope is resolved
    // by materialising the caller's site ids first.
    const twentyFourHoursAgo = new Date(now - ONE_DAY_MS);

    // ── Scope the reads, and never let an empty read mean "healthy" ──────
    //
    // Previously all six counts ran on the module-level `db` with NO tenant
    // context. Under FORCE RLS that returns 0 for every model, so the health
    // endpoint reported `sites: 0, alarms: 0, users: 0` for a platform that
    // actually holds 52 sites — and, because nothing downstream distinguished
    // "zero rows" from "zero rows because the policy hid them", it reported an
    // EMPTY PLATFORM AS HEALTHY. Same bug class as the tenant-isolation-test
    // route, in a different costume: an unmeasured read presented as a
    // measured result.
    //
    // A tenant caller is scoped with withTenant(theirTenantId). A SUPERADMIN has
    // no single tenant and legitimately wants platform-wide figures, so that
    // path uses the ops connection deliberately — documented below — rather
    // than inheriting the tenant path's scoping.
    const { sites, alarms, sensorReadings, users, auditLogs, activeUsers, sizeBytes, scopeMode } =
      await (tenantId
        ? asTenant(me, async (tx) => {
            const tenantSiteIds = (await tx.site.findMany({
              where: { tenantId },
              select: { id: true },
            })).map((s) => s.id);

            const [s, a, sr, u, al, au] = await Promise.all([
              tx.site.count({ where: { tenantId } }),
              tx.alarm.count({ where: { tenantId } }),
              tx.sensorReading.count({ where: { siteId: { in: tenantSiteIds } } }),
              tx.user.count({ where: { tenantId } }),
              tx.auditLog.count({ where: { tenantId } }),
              tx.user.count({ where: { lastLoginAt: { gte: twentyFourHoursAgo }, tenantId } }),
            ]);
            // `pg_database_size` is a server-wide catalogue read, not a row
            // read: RLS does not — and should not — scope it.
            const sizeBytes = await databaseSize(tx as unknown as PrismaClient);
            return {
              sites: s, alarms: a, sensorReadings: sr, users: u, auditLogs: al, activeUsers: au,
              sizeBytes,
              scopeMode: "tenant" as const,
            };
          })
        : opsCounts(twentyFourHoursAgo));

    // ── Metrics tracker ───────────────────────────────────────────────
    const metricsSnapshot = getMetrics();
    const avgResponseMs = getAvgResponseMs();
    const errors = getRecentErrors(10);

    const data: HealthResponse = {
      uptime: formatUptime(uptimeSeconds),
      uptimeSeconds: Math.round(uptimeSeconds),
      memory: {
        rss: bytesToMb(mem.rss),
        heapUsed: bytesToMb(mem.heapUsed),
        heapTotal: bytesToMb(mem.heapTotal),
        external: bytesToMb(mem.external),
      },
      database: {
        type: "postgres",
        sizeBytes,
        sizeMB: round2(sizeBytes / BYTES_PER_MB),
        path: DB_PATH_DISPLAY,
        scopedToTenant: !superAdmin,
        tableCounts: {
          sites,
          alarms,
          sensorReadings,
          users,
          auditLogs,
        },
        auditWriteFailures: auditFailureCount(),
      },
      realtime: {
        connected: rt.connected,
        url: rt.url,
        clients: rt.clients,
      },
      api: {
        avgResponseMs,
        totalRequests: metricsSnapshot.requestCount,
      },
      sessions: {
        activeUsers,
      },
      /**
       * Explicit three-state verdict.
       *
       * The previous shape had no verdict at all, so a caller could not tell a
       * working platform from one whose rows were invisible. `HEALTHY` requires
       * positive evidence that data is reachable; a read that returns nothing
       * yields `HEALTHY_BUT_EMPTY`, and an unreadable one throws rather than
       * degrading. `EMPTY` is deliberately NOT reported as healthy.
       *
       * - `HEALTHY`         — the scoped read returned rows
       * - `HEALTHY_BUT_EMPTY` — the query succeeded and the scope genuinely has
       *   no rows yet (a brand-new tenant, or pre-seed). Not a fault.
       * - the request FAILS   — the database could not be read at all, so no
       *   verdict is invented from a failed read.
       */
      verdict: sites + alarms + users > 0 ? "HEALTHY" : "HEALTHY_BUT_EMPTY",
      /** Whether the counts above cover one tenant or the whole platform. */
      scopeMode,
      errors: redactErrors(errors),
      timestamp: new Date(now).toISOString(),
    };

    // Update cache (per tenant).
    cache.set(cacheKey, { ts: now, data });
    // Bound the map so a large tenant population cannot grow it without limit.
    if (cache.size > 64) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (const [k] of oldest.slice(0, cache.size - 64)) cache.delete(k);
    }

    return NextResponse.json(data);
  } catch (err) {
    return errorResponse(err);
  }
}
