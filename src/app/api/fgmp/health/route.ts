import { NextResponse, type NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { asTenant } from "@/lib/fgmp/route-tenant";
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
 *   - database         : SQLite file size + TENANT-SCOPED row counts
 *   - realtime         : hosted Apinator channels probe — `connected` reflects
 *                        a successful channels API call, `clients` is the sum
 *                        of subscription counts across `private-tenant-*`
 *                        channels, `url` is the cluster's WebSocket endpoint
 *   - api              : avg response time + total requests (since boot)
 *   - sessions         : users with lastLoginAt within the last 24h (tenant)
 *   - errors           : last 10 captured errors, detail REDACTED
 *   - timestamp        : ISO string of when this snapshot was assembled
 *
 * The result is cached in-process for 10 seconds (CACHE_TTL_MS) so the
 * auto-refreshing dashboard (polls every 10s) doesn't hammer the DB with
 * count() queries on every render. The cache is per-process; in a multi-
 * instance deployment each instance would have its own cache (acceptable
 * for a NOC display — Prometheus/StatsD would replace this in a hardened
 * production deployment).
 *
 * ── LEAK FIXES ────────────────────────────────────────────────────────────
 * This endpoint previously disclosed three things to ANY tenant admin:
 *
 *  1. `database.path` was the ABSOLUTE SQLite path from `DATABASE_URL` —
 *     filesystem disclosure (mount layout, often the OS username).
 *  2. `tableCounts` ran UNSCOPED `db.*.count()`, so tenant A learned
 *     platform-wide row counts across all tenants (alarm/user/audit volume
 *     for the whole platform, i.e. a side channel on every other tenant's
 *     size and activity). Counts are now tenant-scoped; SUPERADMIN (who
 *     bypasses tenant isolation by design) still sees the global numbers.
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
async function opsCounts(twentyFourHoursAgo: Date) {
  const url =
    process.env.FGMP_OPS_DATABASE_URL ?? process.env.FGPS_OPS_DATABASE_URL ??
    process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!url) {
    throw new Error(
      "SUPERADMIN health view requires FGMP_OPS_DATABASE_URL (or FGMP_MIGRATE_DATABASE_URL). " +
        "Platform-wide counts cannot be served by a tenant-scoped connection. Refusing rather " +
        "than reporting zero, because an empty platform reported as healthy is a monitoring lie.",
    );
  }
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    const [s, a, u, al, au] = await Promise.all([
      client.site.count(),
      client.alarm.count(),
      client.user.count(),
      client.auditLog.count(),
      client.user.count({ where: { lastLoginAt: { gte: twentyFourHoursAgo } } }),
    ]);
    return {
      sites: s, alarms: a, sensorReadings: 0, users: u, auditLogs: al, activeUsers: au,
      scopeMode: "platform" as const,
    };
  } finally {
    await client.$disconnect();
  }
}

// ── Config ────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 10_000;
/**
 * Budget for the hosted Apinator channels call. The old self-hosted probe
 * used a 500ms TCP connect + an 800ms HTTP fetch; a single 800ms race against
 * the hosted REST API keeps the dashboard's 10s poll responsive even when the
 * provider is unreachable (the probe degrades to `connected: false` instead
 * of hanging the snapshot).
 */
const APINATOR_PROBE_TIMEOUT_MS = 800;
/**
 * Only tenant-private channels are counted: they exist exactly when at least
 * one browser holds a live subscription, which is the number the NOC display
 * means by "clients". Server-triggered public channels would otherwise
 * inflate the figure with sockets nobody is watching.
 */
const APINATOR_CHANNEL_PREFIX = "private-tenant-";
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
    type: "sqlite";
    sizeBytes: number;
    sizeMB: number;
    /**
     * Relative label only ("db/custom.db"). The absolute path from
     * DATABASE_URL is a filesystem disclosure and is deliberately NOT returned.
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

/** Relative, non-disclosing label for the live SQLite file. */
const DB_PATH_DISPLAY = "db/custom.db";

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
 * Resolve the on-disk SQLite path from the `DATABASE_URL` env var.
 * Supports both `file:/abs/path.db` and `file:./rel/path.db` shapes.
 * Returns the absolute path if resolvable, or null if the env var is
 * missing / unparseable (the caller falls back gracefully).
 */
function resolveSqlitePath(): string | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (url.startsWith("file:")) {
    const raw = url.slice("file:".length);
    // Absolute paths (leading / on POSIX, leading drive letter on Win)
    if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
    // Relative path → resolve against process.cwd()
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolve } = require("node:path") as typeof import("node:path");
      return resolve(process.cwd(), raw);
    } catch {
      return raw;
    }
  }
  return null;
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
      getApinatorServer()?.getChannels(APINATOR_CHANNEL_PREFIX),
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
    const clients = channels.reduce(
      (sum, ch) => sum + (Number(ch.subscription_count) || 0),
      0,
    );
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

  // SUPERADMIN holds the `*` capability and bypasses tenant isolation by
  // design (see assertTenantOwned); everyone else is pinned to their tenant.
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

    // ── DB size via fs.statSync on the SQLite file ────────────────────
    // The absolute path is used for the stat() only — it is never returned.
    const dbPath = resolveSqlitePath();
    let sizeBytes = 0;
    if (dbPath) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { statSync } = require("node:fs") as typeof import("node:fs");
        sizeBytes = statSync(dbPath).size;
      } catch {
        sizeBytes = 0;
      }
    }

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
    const { sites, alarms, sensorReadings, users, auditLogs, activeUsers, scopeMode } =
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
            return {
              sites: s, alarms: a, sensorReadings: sr, users: u, auditLogs: al, activeUsers: au,
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
        type: "sqlite",
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
