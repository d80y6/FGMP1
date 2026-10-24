import { db } from "@/lib/db";
import { withTenant } from "./tenant-context";

/**
 * FGMP system-setting lookup for metrics/threshold helpers.
 * ────────────────────────────────────────────────────────────────────────────
 * There are TWO setting stores in this repo and they do not talk to each other:
 *
 *   1. `SystemSetting` (Prisma) — the LIVE store. The UI writes it via
 *      `PATCH /api/fgmp/settings` (see src/app/api/fgmp/settings/route.ts).
 *      Keys are validated against that route's DEFAULT_SETTINGS catalog.
 *   2. `src/lib/fgmp/settings.ts` — a JSON-file store (`.fgmp-settings.json`)
 *      with `getSettings()` / `saveSettings()`. Verified: it has ZERO callers
 *      (grep for `getSettings|saveSettings` across src/ returns only its own
 *      definition and the doc comment in the settings route). It is dead code.
 *
 * So every threshold/metric helper reads `SystemSetting` first and falls back
 * to an env var, then to a documented default. Values are cached for
 * `CACHE_TTL_MS` because the analytics/patterns endpoints poll every 15–60 s
 * and settings change at most once per admin session.
 *
 * Note: PATCH rejects keys outside the settings route's catalog, so a key that
 * is not in that catalog (e.g. `timezone`) can only exist if it was seeded
 * directly. We still read it — a hand-seeded row should win over the default —
 * but operators cannot create it through the API. That gap is documented in
 * the review notes for the settings route.
 */

const CACHE_TTL_MS = 60_000;

/**
 * ── TENANT SCOPING (security fix, 2026-10) ───────────────────────────────────
 * `SystemSetting` used to be a platform-GLOBAL key/value table, so a single
 * process-wide cache of "all rows" was merely stale, never wrong. Settings are
 * now rows with a nullable `tenantId`: a NULL row is the platform default every
 * tenant inherits, and a tenant row overrides it for that tenant only.
 *
 * Two things had to change with that, and both are correctness AND isolation
 * requirements:
 *
 *   1. Every read must declare WHOSE settings it wants. Reading with no tenant
 *      context returns only the `tenantId IS NULL` platform rows (RLS filters
 *      the rest), which is the correct "platform default" answer — and that is
 *      exactly what used to be returned for a tenant that had configured an
 *      override. Measured before this fix: a `t-default` row
 *      `fuelPriceYerPerL = 999` was ignored and `/api/fgmp/analytics` still
 *      reported 520 (`priceSource: "default"`) because the lookup ran outside
 *      any tenant context.
 *   2. The cache must be keyed BY TENANT. A single map shared by every tenant
 *      would serve tenant A's fuel price or battery threshold to tenant B for
 *      the TTL — a cross-tenant configuration bleed with real monetary effect
 *      (fuel price feeds `fuelCost`/`stolenValueUsd`). It would also be a leak
 *      in the opposite direction: the first caller after a cold start decides
 *      what everyone else sees.
 *
 * So `getSystemSetting()` takes an optional tenant id: pass the authenticated
 * tenant, or `null`/`undefined` when you deliberately want platform defaults
 * only (platform-wide jobs, the multi-tenant engine snapshot).
 */

interface CacheEntry {
  at: number;
  values: Map<string, string>;
}

/**
 * tenant id (`""` = platform defaults only) → cached values.
 *
 * ── WHY `globalThis` AND NOT A MODULE-LEVEL `Map` (measured, 2026-10) ────────
 * Next.js compiles every route handler into its OWN module graph, so a module
 * level `Map` is not a process-wide cache — `/api/fgmp/analytics` and
 * `/api/fgmp/settings` each get a private copy. Measured consequence: a settings
 * PATCH that called `invalidateSettingsCache()` left the analytics route serving
 * the pre-PATCH value, because the invalidation ran against a DIFFERENT Map.
 * Making the caches per-process state anchored on `globalThis` is what makes a
 * cache and its invalidation refer to the same object. (TTL still bounds
 * staleness if a future deployment isolates workers.)
 */
const GLOBAL_KEY = Symbol.for("fgmp.settings-cache.v1");
type SettingsCacheGlobal = {
  caches: Map<string, CacheEntry>;
  inflight: Map<string, Promise<Map<string, string>>>;
};
const G = globalThis as unknown as Record<symbol, SettingsCacheGlobal | undefined>;
const state: SettingsCacheGlobal = (G[GLOBAL_KEY] ??= {
  caches: new Map<string, CacheEntry>(),
  inflight: new Map<string, Promise<Map<string, string>>>(),
});
const caches = state.caches;
const inflight = state.inflight;

function cacheKey(tenantId?: string | null): string {
  return tenantId ? tenantId : "";
}

/**
 * Load the settings visible to `tenantId` (or only platform defaults when it is
 * null) into a key→value map.
 *
 * A tenant row WINS over a platform default row: rows are applied in ascending
 * precedence, NULL-tenant first. Both kinds come back in ONE query — the RLS
 * read policy is `tenantId IS NULL OR tenantId = current_setting('app.tenant_id')`
 * — so there is no second round trip and no way to forget the merge.
 *
 * Failures degrade to an empty map (callers fall back to their documented
 * defaults) rather than throwing: a missing settings table must not take the
 * dashboard down.
 */
async function loadAll(tenantId?: string | null): Promise<Map<string, string>> {
  const read = async (client: typeof db) => {
    const rows = await client.systemSetting.findMany({
      select: { key: true, value: true, tenantId: true },
    });
    // Precedence: platform default (tenantId === null) first, then the tenant's
    // own row overwrites it. A plain Map#set in this order is the whole merge.
    const ordered = [...rows].sort((a, b) => Number(a.tenantId !== null) - Number(b.tenantId !== null));
    return new Map(ordered.map((r) => [r.key, r.value]));
  };
  try {
    if (tenantId) return await withTenant(tenantId, (tx) => read(tx as unknown as typeof db));
    return await read(db);
  } catch {
    return new Map();
  }
}

function isFresh(entry: CacheEntry | undefined): boolean {
  return !!entry && Date.now() - entry.at < CACHE_TTL_MS;
}

/**
 * Read one setting key for a tenant.
 *
 * Returns `undefined` when neither a tenant row nor a platform default exists,
 * so the caller can distinguish "operator configured this" from "not
 * configured".
 *
 * `tenantId` is optional ONLY for platform-wide work. Every request-scoped
 * caller must pass the authenticated tenant; omitting it silently yields the
 * platform default and that caller's tenant override would be ignored.
 */
export async function getSystemSetting(
  key: string,
  tenantId?: string | null,
): Promise<string | undefined> {
  const id = cacheKey(tenantId);
  const entry = caches.get(id);
  if (entry && isFresh(entry)) return entry.values.get(key);
  let pending = inflight.get(id);
  if (!pending) {
    pending = loadAll(tenantId).then((values) => {
      caches.set(id, { at: Date.now(), values });
      inflight.delete(id);
      return values;
    });
    inflight.set(id, pending);
  }
  return (await pending).get(key);
}

/**
 * Read one setting key as a finite number, or `undefined` when the row is
 * missing / unparseable / not finite. Guarding here means no caller ever has to
 * deal with `NaN` leaking out of a TEXT setting column.
 */
export async function getSystemSettingNumber(
  key: string,
  tenantId?: string | null,
): Promise<number | undefined> {
  const raw = await getSystemSetting(key, tenantId);
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Drop cached settings. With no argument every tenant's cache is dropped
 * (tests / after a settings PATCH); with a tenant id only that tenant's entry
 * goes, so one tenant's edit does not flush the whole platform's cache.
 */
export function invalidateSettingsCache(tenantId?: string | null): void {
  if (tenantId === undefined) {
    caches.clear();
    return;
  }
  caches.delete(cacheKey(tenantId));
}

/** Test hook: how many tenant caches are held. */
export function settingsCacheSize(): number {
  return caches.size;
}
