import { db } from "@/lib/db";

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

let cache: { at: number; values: Map<string, string> } | null = null;
let inflight: Promise<Map<string, string>> | null = null;

/**
 * Load every `SystemSetting` row into a key→value map. Failures degrade to an
 * empty map (callers fall back to their documented defaults) rather than
 * throwing: a missing settings table must not take the dashboard down.
 */
async function loadAll(): Promise<Map<string, string>> {
  try {
    const rows = await db.systemSetting.findMany({
      select: { key: true, value: true },
    });
    return new Map(rows.map((r) => [r.key, r.value]));
  } catch {
    return new Map();
  }
}

function isFresh(): boolean {
  return !!cache && Date.now() - cache.at < CACHE_TTL_MS;
}

/**
 * Read one setting key. Returns `undefined` when the row does not exist, so
 * the caller can distinguish "operator configured this" from "not configured".
 */
export async function getSystemSetting(key: string): Promise<string | undefined> {
  if (isFresh()) return cache!.values.get(key);
  if (!inflight) {
    inflight = loadAll().then((values) => {
      cache = { at: Date.now(), values };
      inflight = null;
      return values;
    });
  }
  return (await inflight).get(key);
}

/**
 * Read one setting key as a finite number, or `undefined` when the row is
 * missing / unparseable / not finite. Guarding here means no caller ever has to
 * deal with `NaN` leaking out of a TEXT setting column.
 */
export async function getSystemSettingNumber(key: string): Promise<number | undefined> {
  const raw = await getSystemSetting(key);
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Drop the cache (tests / after a settings PATCH). */
export function invalidateSettingsCache(): void {
  cache = null;
}