/**
 * Server-side realtime emitter — used by Next.js API routes to push
 * event notifications to connected browser clients through Apinator.io
 * (hosted, Pusher-style channels).
 *
 * Usage (server-side only):
 *   import { emitToRealtime } from "@/lib/fgmp/realtime-emitter";
 *   emitToRealtime("alarm:new", { id, type, message, severity });
 *   emitToRealtime("delivery:update", { deliveryId, status }, `site:${siteId}`);
 *
 * FULLY EVENT-DRIVEN ARCHITECTURE (read this before "fixing" anything):
 *   There is NO `state:tick` — the server never pushes whole snapshots, and
 *   this emitter never will either. The AppShell's 5-second poll is the ONLY
 *   state refresher; what realtime adds is latency, not data. Every event
 *   published here is an instant "refresh now" trigger for the tenant's
 *   browsers, so a dropped emit is harmless (the poll reconciles within 5s)
 *   and this module may fail closed for ANY reason without degrading the UI.
 *
 * Channel model change vs the socket.io mini-service:
 *   The mini-service fanned events out to rooms (`site:<id>`). Apinator
 *   fans them out tenant-wide on `private-tenant-<tenantId>` — see
 *   apinator-server.ts for why that is a plain private channel and not a
 *   cache channel. The `room` parameter below is therefore only an input to
 *   TENANT RESOLUTION: the room names a site, the site names a tenant, and
 *   the event is published to that tenant's channel. Call sites keep
 *   passing `site:<id>` unchanged; the room no longer scopes delivery, the
 *   browser's own authorization does (every subscriber refreshes from
 *   tenant-scoped APIs, which reconcile only what that user may see).
 *
 * ── SITE → TENANT RESOLUTION, AND WHY IT NEEDS A PRIVILEGED CONNECTION ──────
 * The event's tenant is not always known where the event is raised (the IoT
 * ingest route authenticates a device, not a user; alarm/telemetry payloads
 * carry only a siteId). Resolving it needs `Site.tenantId` — but under Phase 1
 * FORCE RLS the app-role `db` client returns ZERO rows without a tenant
 * context (see route-tenant.ts), and withTenant() needs the very tenant id
 * this lookup is trying to discover. A ladder of three rungs resolves it
 * (mirroring schedulerDb() in scheduler.ts:82-99 and opsCounts() in
 * api/fgmp/health/route.ts):
 *
 *   1. FGMP_OPS_DATABASE_URL ?? FGMP_MIGRATE_DATABASE_URL is set →
 *      dedicated PrismaClient on that URL. This bypasses RLS BY DESIGN —
 *      the same deliberate, documented exception the scheduler makes: it is
 *      the owner/ops role, it performs NO per-tenant authorisation (that is
 *      the role-gated API routes' job, and every call site of this emitter
 *      is role-gated or device-token-gated), and the siteId is a
 *      server-resolved id, never free user input.
 *   2. Else FGMP_REQUIRE_RLS !== "1" → the ambient app-role `db` client.
 *      Local dev where no RLS policy exists yet (the compose default keeps
 *      the flag at 1 precisely so prod cannot silently run this rung).
 *   3. Else → the tenant is UNRESOLVABLE → the event is DROPPED with a
 *      throttled warning. Fail closed, exactly like the scheduler refusing
 *      to advance state under the app role: an emit that publishes to the
 *      WRONG tenant's channel would be a cross-tenant leak, so "cannot
 *      resolve" must never fall back to a guess.
 *
 * DELIBERATELY NOT engine.snapshotForTenant(): that runs ensureAllTenants()
 * and pulls the whole platform into memory per miss — the exact pattern the
 * engine comments (engine.ts:2821-2834) describe removing. One indexed
 * findUnique per (cache-missing) emit is the whole cost here.
 *
 * Reliability contract (unchanged from the socket.io emitter):
 *   - `emitToRealtime` NEVER throws and NEVER blocks its caller — publishing
 *     is fire-and-forget; every failure mode downgrades to "the poll will
 *     refresh the browsers".
 *   - trigger() throws on API errors (401 on bad credentials, 400 on
 *     validation); those are caught and logged THROTTLED so a dead
 *     Apinator account cannot flood the logs at alarm volume.
 *   - Unresolvable tenant → drop + throttled warn, same posture the old
 *     mini-service had for unreachable publishers.
 *
 * Browser clients MUST NOT import this module. It is server-only and pulls
 * in `@apinator/server` (node:crypto) and the Prisma clients. Browsers use
 * `@apinator/client` via use-realtime.ts and subscribe through the
 * channel-auth route, which authorizes each socket against the NextAuth
 * session.
 */

import type { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { getOpsDb } from "@/lib/fgmp/owner-db";
import { getApinatorServer, tenantChannel } from "@/lib/fgmp/apinator-server";

// ── Throttled logging ─────────────────────────────────────────────────────────
// Fires at most one log per key per window. The emitter sits on hot paths
// (telemetry ingest runs per reading batch), so an unthrottled warn would
// drown the logs exactly when a real outage makes every emit fail.

const LOG_THROTTLE_MS = 60_000;
/** Cap on throttle keys (same "absorb garbage" reasoning as the TTL cache). */
const LOG_THROTTLE_MAX_KEYS = 5_000;
const lastLoggedAt = new Map<string, number>();

function throttledWarn(key: string, message: string): void {
  const now = Date.now();
  const last = lastLoggedAt.get(key) ?? 0;
  if (now - last < LOG_THROTTLE_MS) return;
  if (lastLoggedAt.size >= LOG_THROTTLE_MAX_KEYS) lastLoggedAt.clear();
  lastLoggedAt.set(key, now);
  console.warn(`[realtime-emitter] ${message}`);
}

function throttledError(key: string, message: string): void {
  const now = Date.now();
  const last = lastLoggedAt.get(key) ?? 0;
  if (now - last < LOG_THROTTLE_MS) return;
  if (lastLoggedAt.size >= LOG_THROTTLE_MAX_KEYS) lastLoggedAt.clear();
  lastLoggedAt.set(key, now);
  console.error(`[realtime-emitter] ${message}`);
}

// ── Site → tenant resolution (see header: the three-rung ladder) ─────────────

/**
 * Dedicated PrismaClient on the ops/owner role for the RLS-bypassing lookup.
 * Same pattern as schedulerDb() (scheduler.ts): ops role preferred, migrate
 * role as fallback, null when neither is configured. One client per process —
 * constructing one per emit would churn connections for no benefit.
 */
function siteResolverDb(): PrismaClient | null {
  return getOpsDb();
}

/**
 * TTL cache for site → tenant. Caching BOTH positive and negative results
 * is deliberate:
 *   - positive: telemetry ingest can emit many batches per second for the
 *     same site; without the cache every batch pays a DB round-trip.
 *   - negative: a deleted (or spoofed/garbage) site id must not keep
 *     re-hammering the database with a lookup that can never succeed —
 *     the same "absorb the miss" reason the negative half exists.
 *
 * A site REASSIGNING tenants propagates within one TTL (60s) — stale
 * publishes for 60s go to the old channel and the poll covers the new
 * state, an acceptable trade for not putting invalidation plumbing on the
 * hot path.
 */
const TENANT_CACHE_TTL_MS = 60_000;
/**
 * Hard cap so a pathological stream of unique garbage ids cannot grow the
 * map without bound. Clearing wholesale (rather than LRU) is fine: the
 * cache only saves round-trips, and a clear just costs a few lookups.
 */
const TENANT_CACHE_MAX_ENTRIES = 5_000;

const tenantCache = new Map<
  string,
  { tenantId: string | null; expiresAt: number }
>();

/**
 * Resolve a site id to its tenant id through the ladder in the header.
 * Returns null when the tenant cannot be resolved — callers drop the event.
 */
async function lookupTenantIdForSite(siteId: string): Promise<string | null> {
  // Rung 1: owner/ops connection — bypasses FORCE RLS by design (header).
  const owner = siteResolverDb();
  if (owner) {
    try {
      const site = await owner.site.findUnique({
        where: { id: siteId },
        select: { tenantId: true },
      });
      return site?.tenantId ?? null;
    } catch (err) {
      // Transient DB failure is NOT the same as "site unknown": it must be
      // dropped but NOT cached as a negative, or one blip would blacklist
      // the site's events for a full TTL after the database has recovered.
      throttledError(
        `lookup-error:${siteId}`,
        `site→tenant lookup failed for site ${siteId} — event dropped (not cached): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  // Rung 2: ambient app-role client, only where RLS is not enforced —
  // local dev with FGMP_REQUIRE_RLS=0. Under RLS (=1, the compose default)
  // this client returns zero rows for everything, which would read as
  // "site unknown" for every site in the platform and silently disable all
  // pushes; rung 3 fails closed instead, loudly.
  if (process.env.FGMP_REQUIRE_RLS !== "1") {
    try {
      const site = await db.site.findUnique({
        where: { id: siteId },
        select: { tenantId: true },
      });
      return site?.tenantId ?? null;
    } catch (err) {
      throttledError(
        `lookup-error:${siteId}`,
        `site→tenant lookup failed for site ${siteId} — event dropped (not cached): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  // Rung 3: fail closed. RLS is enforced and no privileged connection is
  // configured — resolving would require a guess, and a wrong guess is a
  // cross-tenant publish.
  throttledWarn(
    "no-privileged-connection",
    "FGMP_REQUIRE_RLS=1 and neither FGMP_OPS_DATABASE_URL nor " +
      "FGMP_MIGRATE_DATABASE_URL is set — site→tenant resolution is impossible, " +
      "so ALL realtime emits are being DROPPED. Set an ops/migrate database URL " +
      "to enable push (the app-shell poll keeps the UI live meanwhile).",
  );
  return null;
}

/**
 * Cached wrapper around lookupTenantIdForSite. Cache hits (including cached
 * negatives) skip the DB entirely; misses go through the ladder.
 */
async function resolveTenantIdForSite(siteId: string): Promise<string | null> {
  const now = Date.now();
  const hit = tenantCache.get(siteId);
  if (hit) {
    if (hit.expiresAt > now) return hit.tenantId;
    tenantCache.delete(siteId);
  }

  const tenantId = await lookupTenantIdForSite(siteId);

  if (tenantCache.size >= TENANT_CACHE_MAX_ENTRIES) tenantCache.clear();
  tenantCache.set(siteId, { tenantId, expiresAt: now + TENANT_CACHE_TTL_MS });
  return tenantId;
}

/**
 * Extract the site id that anchors tenant resolution, from either the
 * `site:<id>` room (the form all existing call sites use) or the payload's
 * `siteId` field (the helpers' callers always include it). An event with
 * neither cannot be attributed to a tenant and is dropped — see
 * emitToRealtime.
 */
function extractSiteId(
  room: string | undefined,
  payload: unknown,
): string | null {
  if (typeof room === "string" && room.startsWith("site:")) {
    const id = room.slice("site:".length).trim();
    if (id !== "") return id;
  }
  if (typeof payload === "object" && payload !== null) {
    const siteId = (payload as { siteId?: unknown }).siteId;
    if (typeof siteId === "string" && siteId.trim() !== "") return siteId.trim();
  }
  return null;
}

/**
 * Push an event to every connected browser client of the event's tenant.
 * No-op if called from the browser, if Apinator is unconfigured, or if the
 * event's tenant cannot be resolved — polling covers freshness in all cases.
 *
 * @param event   The browser-facing event name (e.g. "alarm:new")
 * @param payload Arbitrary JSON-serializable payload (sent as a JSON string)
 * @param room    Optional site room (e.g. "site:<id>") — used ONLY to resolve
 *                the tenant; delivery is tenant-wide on the private channel.
 */
export function emitToRealtime(
  event: string,
  payload?: unknown,
  room?: string,
): void {
  if (typeof window !== "undefined") return; // server-only guard

  // Unconfigured deployment: apinator-server warned once in production;
  // here we just bow out. Polling keeps the UI live.
  const client = getApinatorServer();
  if (!client) return;

  const siteId = extractSiteId(room, payload);
  if (!siteId) {
    throttledWarn(
      `no-site:${event}`,
      `event "${event}" carries no site (no "site:<id>" room, no payload.siteId) — ` +
        "tenant cannot be resolved, event DROPPED. Call sites must include the site id.",
    );
    return;
  }

  // Fire-and-forget: the caller's route must never wait on the realtime
  // provider, and every failure inside is logged (throttled), not thrown.
  void (async () => {
    const tenantId = await resolveTenantIdForSite(siteId);
    if (!tenantId) return; // dropped — lookup already logged why (throttled)

    try {
      // Payloads are JSON strings on the wire; the browser defensively
      // JSON.parses (the SDK may hand it the parsed object or the raw
      // string). `?? null` because JSON.stringify(undefined) returns the
      // value `undefined`, which is not a string — every current call site
      // sends a payload, so null is the honest empty case.
      await client.trigger({
        name: event,
        channel: tenantChannel(tenantId),
        data: JSON.stringify(payload ?? null),
      });
    } catch (err) {
      // trigger() throws on API errors (auth, validation, 5xx). A dead or
      // misconfigured Apinator app must not crash the route that raised the
      // event, nor flood the logs — hence catch + throttle, and the poll
      // reconciles the browsers regardless.
      throttledError(
        `trigger:${event}`,
        `publish of "${event}" to ${tenantChannel(tenantId)} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();
}

/**
 * Convenience helpers for the most common FGMP realtime events.
 *
 * The shapes are UNCHANGED from the socket.io emitter — all call sites
 * (deliveries, maintenance, iot/ingest) keep compiling untouched. The
 * `site:` room argument now feeds tenant resolution instead of room
 * targeting; see the header's channel-model note.
 */
export const realtime = {
  alarmNew: (alarm: {
    id: string;
    type: string;
    severity: string;
    message: string;
    siteId: string;
  }) => emitToRealtime("alarm:new", alarm, `site:${alarm.siteId}`),

  alarmAck: (alarmId: string, siteId: string) =>
    emitToRealtime("alarm:ack", { alarmId }, `site:${siteId}`),

  alarmResolve: (alarmId: string, siteId: string) =>
    emitToRealtime("alarm:resolve", { alarmId }, `site:${siteId}`),

  commandStatus: (cmd: {
    generatorId: string;
    command: string;
    status: string;
    siteId?: string;
  }) => {
    const room = cmd.siteId ? `site:${cmd.siteId}` : undefined;
    emitToRealtime("command:status", cmd, room);
  },

  deliveryUpdate: (delivery: {
    id: string;
    siteId: string;
    status: string;
  }) => emitToRealtime("delivery:update", delivery, `site:${delivery.siteId}`),

  telemetry: (reading: { siteId: string; readings: unknown }) =>
    emitToRealtime("telemetry:new", reading, `site:${reading.siteId}`),
};
