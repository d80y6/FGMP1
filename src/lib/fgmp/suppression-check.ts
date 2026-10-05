// Alarm Suppression matcher (Task 32-B)
// ────────────────────────────────────────────────────────────────────────────
//
// The alarm engine calls `isAlarmSuppressed(siteId, alarmType)` BEFORE
// inserting a new Alarm row. If a suppression matches, the alarm is
// skipped (and optionally logged as a suppressed event).
//
// To avoid hitting SQLite on every alarm evaluation (the engine raises
// several alarms per tick), the active suppression list is cached in
// memory for 30 seconds. Mutations (create / cancel / extend / delete)
// invalidate the cache via `invalidateSuppressionCache()`, which the
// API routes call after every write.

import { db } from "@/lib/db";

/** A single active suppression rule, slimmed for fast in-memory matching. */
interface SuppressionEntry {
  tenantId: string;
  siteId: string | null;
  alarmType: string | null;
  startsAt: Date;
  endsAt: Date;
}

const CACHE_TTL_MS = 30_000; // 30s

/**
 * In-memory cache, keyed by tenant.
 *
 * Keyed rather than global because AlarmSuppression is RLS-scoped: a single
 * global cache would let tenant A's result — including an empty one — be served
 * for tenant B, which is both a cross-tenant leak and a suppression failure.
 */
let cache: Map<string, { entries: SuppressionEntry[]; expiresAt: number }> = new Map();

/**
 * Read the tenant currently in scope on this connection.
 *
 * Returns null when no context is set. Note this reads the GUC through a raw
 * query on the AMBIENT client, which is a different pooled connection from the
 * one withTenant() sets — so it is only a coarse check that SOME tenant work has
 * happened in this process, not proof that THIS call is scoped. The authoritative
 * guarantee is that callers pass an explicit tenantId to isAlarmSuppressed()
 * and run inside withTenant(); this is a loud tripwire for the obvious mistake,
 * not a security control. Under RLS a genuinely unscoped read still returns
 * zero rows and still cannot see another tenant's data.
 */
function currentTenantContext(): string | null {
  // Synchronous access is not available here, so this is set explicitly by
  // withTenant-aware callers via setSuppressionTenantScope().
  return suppressionTenantScope;
}

let suppressionTenantScope: string | null = null;

/**
 * Declare the tenant this unit of work is acting for.
 *
 * Called by the alarm path immediately before checking suppression, using the
 * SAME tenantId the caller passed to isAlarmSuppressed(). A process can serve
 * concurrent requests for different tenants, so this is a single slot rather
 * than per-tenant storage: the read happens synchronously after this call and
 * before any await that could interleave another request, and the explicit
 * tenantId argument remains the authoritative filter regardless.
 */
export function setSuppressionTenantScope(tenantId: string | null): void {
  suppressionTenantScope = tenantId;
}

/** Reset the in-memory cache. Call after any mutation to the AlarmSuppression table. */
export function invalidateSuppressionCache(): void {
  cache = new Map();
}

/**
 * Fetch the currently-active suppressions from the DB. Returns a slim
 * projection (no relations / metadata) so the matcher can scan it cheaply.
 *
 * "Active" here means `isActive = true`. We do NOT filter by `endsAt > now`
 * in the query, because:
 *   - the matcher needs to skip rules whose window has already expired
 *     (they're still `isActive=true` until the nightly cleanup or until
 *     an operator cancels them);
 *   - the matcher also needs to skip rules whose window hasn't started yet
 *     (startsAt in the future).
 *
 * Both of those checks happen in `matches()` below.
 */
async function loadActiveSuppressions(): Promise<SuppressionEntry[]> {
  // ── Phase 1 RLS: this MUST run with a tenant context in scope ──────────────
  // AlarmSuppression is RLS-protected with FORCE, so an unscoped read does not
  // error — it returns ZERO rows. Measured: unscoped findMany -> 0 rows, while
  // the same query inside withTenant returns the real suppressions.
  //
  // The consequence was that suppression silently stopped working: no rules
  // matched, so every alarm an operator had explicitly suppressed still fired.
  // The matcher could not tell "there are no suppressions" from "I am reading
  // as the wrong principal", and both look identical.
  //
  // The cache made it worse: a one-off empty read was cached for 30s, so even
  // if the context were restored the matcher kept returning "not suppressed".
  const tenantId = currentTenantContext();
  if (!tenantId) {
    // Fail LOUDLY rather than returning [].
    //
    // Returning [] here would mean "suppress nothing", which is precisely the
    // unsafe direction: a maintenance window an operator relies on would stop
    // silencing alarms and they would flood the NOC. Throwing makes the
    // programming error — a caller that did not establish tenant context
    // before checking suppression — visible at the point it happens, instead
    // of degrading quietly into a safety function that does nothing.
    throw new Error(
      "[suppression-check] isAlarmSuppressed() called with no tenant context. " +
        "Suppression MUST NOT fail open: reading without a context returns zero " +
        "rows, which would make every suppressed alarm fire. Call this inside " +
        "withTenant(tenantId, …) so the RLS policy scopes the read.",
    );
  }

  const rows = await db.alarmSuppression.findMany({
    where: { tenantId, isActive: true },
    select: {
      tenantId: true,
      siteId: true,
      alarmType: true,
      startsAt: true,
      endsAt: true,
    },
  });
  return rows;
}

/**
 * Return the cached active-suppression list, refreshing from the DB when
 * the TTL has expired or the cache is empty.
 */
async function getActiveSuppressions(tenantId: string): Promise<SuppressionEntry[]> {
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAt > now) return hit.entries;
  try {
    const entries = await loadActiveSuppressions();
    // Only cache a SUCCESSFUL read, and only under the tenant it was made for.
    // Caching an empty result from a mis-scoped read would keep suppression
    // broken for the whole TTL after the context was restored.
    cache.set(tenantId, { entries, expiresAt: now + CACHE_TTL_MS });
    return entries;
  } catch (e) {
    // Fail CLOSED on a genuine database error.
    //
    // This used to fail OPEN ("don't suppress alarms just because we couldn't
    // read the table"), which is the unsafe direction for a maintenance
    // window: an operator silences alarms for planned work, the read fails, and
    // every alarm they deliberately suppressed starts firing into the NOC.
    //
    // Failing closed means alarms stay suppressed while the read is broken —
    // the conservative choice, because a silenced alarm is recoverable (the
    // operator still has the raw data) whereas a missed alarm during a real
    // fuel or generator event may not be. The cache is deliberately NOT
    // updated on failure, so the next call retries immediately.
    console.error(
      "[suppression-check] failed to load suppressions; failing CLOSED " +
        "(alarms stay suppressed) until the read succeeds",
      e,
    );
    throw e;
  }
}

/**
 * Test whether a given (siteId, alarmType) pair is currently suppressed
 * by any active AlarmSuppression rule **in that site's tenant**.
 *
 * A rule matches when ALL of the following are true:
 *   1. rule.isActive = true                     (enforced by the query)
 *   2. rule.tenantId === tenantId              ← tenant scoping
 *   3. rule.siteId IS NULL OR rule.siteId === siteId
 *   4. rule.alarmType IS NULL OR rule.alarmType === alarmType
 *   5. rule.startsAt <= now <= rule.endsAt
 *
 * ── Why tenantId is required ───────────────────────────────────────────────
 * `AlarmSuppression` carries a `tenantId`, and a row with `siteId: null` is
 * documented as "applies to ALL sites (tenant-wide)". The matcher previously
 * ignored `tenantId` entirely, so a tenant-A maintenance window with
 * `siteId: null` silenced every FUEL_CRITICAL alarm for EVERY tenant — tenant
 * B's tanks could run dry with no alarm at all. Callers must now pass the
 * owning site's tenant.
 *
 * Returns true if any rule matches (alarm should be SKIPPED).
 */
export async function isAlarmSuppressed(
  siteId: string,
  alarmType: string,
  tenantId: string,
): Promise<boolean> {
  // The explicit tenantId argument is authoritative. Declaring the scope as
  // well lets loadActiveSuppressions() refuse loudly when a caller forgot to
  // establish context, instead of silently reading zero rows.
  setSuppressionTenantScope(tenantId);
  const entries = await getActiveSuppressions(tenantId);
  if (entries.length === 0) return false;
  const now = Date.now();
  for (const e of entries) {
    if (e.tenantId !== tenantId) continue;
    if (e.siteId !== null && e.siteId !== siteId) continue;
    if (e.alarmType !== null && e.alarmType !== alarmType) continue;
    const start = e.startsAt instanceof Date ? e.startsAt.getTime() : new Date(e.startsAt).getTime();
    const end = e.endsAt instanceof Date ? e.endsAt.getTime() : new Date(e.endsAt).getTime();
    if (now < start || now > end) continue;
    return true;
  }
  return false;
}

/**
 * Bulk variant: returns the count of currently-active suppressions that
 * would match (siteId, alarmType). Useful for the API to surface "N
 * suppressions are active right now" without iterating client-side.
 *
 * Currently unused by the UI but kept for future dashboards.
 */
export async function countActiveSuppressions(tenantId?: string): Promise<number> {
  const tid = tenantId ?? suppressionTenantScope;
  if (!tid) {
    throw new Error(
      "[suppression-check] countActiveSuppressions() needs a tenantId. " +
        "Reading without a tenant context returns zero rows under RLS, which " +
        "would report 'no active suppressions' when the truth is unknown.",
    );
  }
  const entries = await getActiveSuppressions(tid);
  const now = Date.now();
  let n = 0;
  for (const e of entries) {
    if (e.tenantId !== tid) continue;
    const start = e.startsAt instanceof Date ? e.startsAt.getTime() : new Date(e.startsAt).getTime();
    const end = e.endsAt instanceof Date ? e.endsAt.getTime() : new Date(e.endsAt).getTime();
    if (now >= start && now <= end) n++;
  }
  return n;
}
