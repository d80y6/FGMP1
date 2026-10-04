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

let cache: { entries: SuppressionEntry[]; expiresAt: number } | null = null;

/** Reset the in-memory cache. Call after any mutation to the AlarmSuppression table. */
export function invalidateSuppressionCache(): void {
  cache = null;
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
  const rows = await db.alarmSuppression.findMany({
    where: { isActive: true },
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
async function getActiveSuppressions(): Promise<SuppressionEntry[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.entries;
  try {
    const entries = await loadActiveSuppressions();
    cache = { entries, expiresAt: now + CACHE_TTL_MS };
    return entries;
  } catch (e) {
    // If the DB is unreachable (e.g. during boot before seed), fail OPEN:
    // don't suppress alarms just because we couldn't read the suppression
    // table. The cache stays null so the next call retries immediately.
    console.error("[suppression-check] failed to load suppressions", e);
    return [];
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
  const entries = await getActiveSuppressions();
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
export async function countActiveSuppressions(): Promise<number> {
  const entries = await getActiveSuppressions();
  const now = Date.now();
  let n = 0;
  for (const e of entries) {
    const start = e.startsAt instanceof Date ? e.startsAt.getTime() : new Date(e.startsAt).getTime();
    const end = e.endsAt instanceof Date ? e.endsAt.getTime() : new Date(e.endsAt).getTime();
    if (now >= start && now <= end) n++;
  }
  return n;
}
