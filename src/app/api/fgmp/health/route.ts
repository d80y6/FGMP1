import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole, ROLES, isSuperAdminUser } from "@/lib/fgmp/auth-helpers";
import { errorResponse } from "@/lib/fgmp/api-error";
import {
  getMetrics,
  getAvgResponseMs,
  getRecentErrors,
  type RecordedError,
} from "@/lib/fgmp/metrics";

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
 *   - realtime         : TCP-port-check on :3003 + fetched `clients` count
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

// ── Config ────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 10_000;
const REALTIME_HOST = "127.0.0.1";
const REALTIME_PORT = 3003;
const REALTIME_HEALTH_URL = `http://${REALTIME_HOST}:${REALTIME_PORT}/health`;
const TCP_PROBE_TIMEOUT_MS = 500;
const HTTP_HEALTH_TIMEOUT_MS = 800;
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
 * TCP port probe — resolves `true` if a connection to (host, port)
 * succeeds within `timeoutMs`. Uses Node's `net` module per task spec.
 * The socket is destroyed immediately on connect / error / timeout so
 * no lingering connection is left on the realtime service.
 */
function probeTcpPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    // Lazy import so the route module loads cleanly in the Edge-checker.
    // (Next.js routes run in the Node.js runtime — `force-dynamic` keeps
    // this code out of the static-build pipeline.)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require("node:net") as typeof import("node:net");
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * Fetch the realtime service's `/health` endpoint to retrieve the live
 * socket.io client count. Returns 0 if the HTTP request fails or the
 * response can't be parsed. Always resolves (never rejects).
 */
async function fetchRealtimeClients(): Promise<number> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_HEALTH_TIMEOUT_MS);
    const res = await fetch(REALTIME_HEALTH_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return 0;
    const data = (await res.json()) as { clients?: number };
    const n = Number(data?.clients);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
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

    // ── Realtime TCP probe + HTTP /health (for client count) ──────────
    const rtConnected = await probeTcpPort(
      REALTIME_HOST,
      REALTIME_PORT,
      TCP_PROBE_TIMEOUT_MS,
    );
    // Only fetch the client count if the port is reachable — saves an
    // 800ms timeout when the realtime service is down.
    const rtClients = rtConnected ? await fetchRealtimeClients() : 0;

    // ── Prisma aggregations (parallel, TENANT-SCOPED) ─────────────────
    // Models carrying a direct tenantId: Site, Alarm, User, AuditLog.
    // SensorReading has NO tenant column and NO `site` relation in the schema
    // (see prisma/schema.prisma) — only `siteId` — so its scope is resolved
    // by materialising the caller's site ids first.
    const twentyFourHoursAgo = new Date(now - ONE_DAY_MS);
    const tenantSiteIds = tenantId
      ? (await db.site.findMany({
          where: { tenantId },
          select: { id: true },
        })).map((s) => s.id)
      : null;

    const [sites, alarms, sensorReadings, users, auditLogs, activeUsers] =
      await Promise.all([
        db.site.count(tenantId ? { where: { tenantId } } : undefined),
        db.alarm.count(tenantId ? { where: { tenantId } } : undefined),
        db.sensorReading.count(
          tenantSiteIds ? { where: { siteId: { in: tenantSiteIds } } } : undefined,
        ),
        db.user.count(tenantId ? { where: { tenantId } } : undefined),
        db.auditLog.count(tenantId ? { where: { tenantId } } : undefined),
        db.user.count({
          where: {
            lastLoginAt: { gte: twentyFourHoursAgo },
            ...(tenantId ? { tenantId } : {}),
          },
        }),
      ]);

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
      },
      realtime: {
        connected: rtConnected,
        url: "ws://localhost:3003",
        clients: rtClients,
      },
      api: {
        avgResponseMs,
        totalRequests: metricsSnapshot.requestCount,
      },
      sessions: {
        activeUsers,
      },
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
