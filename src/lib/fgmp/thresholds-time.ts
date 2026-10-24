import { getSystemSetting } from "./metrics-settings";

/**
 * FGMP timezone-aware time bucketing.
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Four different behaviours were in play before this helper, all of which
 * disagree with the platform timezone (`Asia/Aden`, UTC+3 — `.fgmp-settings.json`
 * `timezone`, and the container runs UTC because the Dockerfile sets no TZ):
 *
 *   src/app/api/fgmp/patterns/route.ts   new Date(b.t).getDay()/.getHours()  → server-local
 *   src/app/api/fgmp/analytics/route.ts  toISOString().slice(11,16)          → UTC
 *   src/app/api/fgmp/analytics/route.ts  toLocaleDateString("en-US", …)     → server-locale
 *   src/lib/fgmp/engine.ts               new Date().setHours(0,0,0,0)        → server-local midnight
 *
 * In a UTC container that means the 00:00–03:00 Aden window is bucketed into
 * "yesterday" and the hourly trend labels drift 3 h from what the operator sees.
 *
 * This module is the single place that converts an instant into platform-local
 * wall-clock parts, always through `Intl.DateTimeFormat` with an explicit
 * `timeZone`, never through the server-local `Date` getters.
 *
 * The timezone is resolved (in order) from:
 *   1. `SystemSetting.timezone` / `SystemSetting.platformTimezone` (live DB store)
 *   2. `FGMP_TIMEZONE` / `TZ` env vars
 *   3. `DEFAULT_TIMEZONE` below
 *
 * It is resolved ONCE per request via `resolvePlatformTimezone()` and the
 * returned string is threaded through the rest of the helpers, so no call site
 * has to re-derive or hardcode "Asia/Aden" a second time.
 */

/** Documented platform timezone. Asia/Aden = UTC+03:00, no DST. */
export const DEFAULT_TIMEZONE = "Asia/Aden";

export interface ZonedParts {
  /** 0=Sun … 6=Sat */
  dayOfWeek: number;
  /** 0..23 */
  hour: number;
  /** 0..59 */
  minute: number;
  /** "YYYY-MM-DD" in the platform timezone. */
  dateKey: string;
  /** "HH:MM" in the platform timezone. */
  hourLabel: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(opts)}`;
  let f = formatterCache.get(key);
  if (!f) {
    // `timeZone` must be a valid IANA name; an operator typo would otherwise
    // throw a RangeError deep inside a request handler.
    f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone });
    formatterCache.set(key, f);
  }
  return f;
}

/** `hourCycle: "h23"` (not `hour12: false`) — some ICU builds render midnight
 *  as hour 24 under `hour12:false`, which would index hour 24 of 24. */
const HOUR_MINUTE: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const DATE_PARTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };

/**
 * Resolve the platform timezone.
 *
 * NOT cached beyond the `getSystemSetting` layer (which holds its values for
 * 60 s), so a settings change takes effect within a minute without a restart.
 * The `Intl.DateTimeFormat` validation runs once per call; formatter instances
 * themselves are memoised in `formatterCache`, so the cost is negligible.
 */
export async function resolvePlatformTimezone(tenantId?: string | null): Promise<string> {
  // A tenant may set its own `timezone`; otherwise the platform default row
  // applies. Omitting `tenantId` deliberately means "platform defaults only".
  const fromDb =
    (await getSystemSetting("timezone", tenantId)) ??
    (await getSystemSetting("platformTimezone", tenantId));
  const candidates = [fromDb, process.env.FGMP_TIMEZONE, process.env.TZ, DEFAULT_TIMEZONE];
  for (const c of candidates) {
    if (!c) continue;
    const tz = c.trim();
    if (!tz) continue;
    try {
      // Validate before accepting: an operator typo falls through to the next source.
      formatter(tz, HOUR_MINUTE);
      return tz;
    } catch {
      // invalid IANA name — try the next candidate
    }
  }
  return DEFAULT_TIMEZONE;
}

/** Test hook: drop the memoised formatters. */
export function resetTimezoneCache(): void {
  formatterCache.clear();
}

function partMap(timeZone: string, opts: Intl.DateTimeFormatOptions, ms: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of formatter(timeZone, opts).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

/**
 * Wall-clock parts of `ms` (epoch millis) in `timeZone`.
 *
 * Example (Asia/Aden, UTC+3):
 *   2026-10-03T21:30:00Z → { dayOfWeek: 0 (Sun), hour: 0, minute: 30,
 *                           dateKey: "2026-10-04", hourLabel: "00:30" }
 * The same instant via `new Date(x).getHours()` on a UTC host returns 21 — three
 * hours and one calendar day away from what the operator sees.
 *
 * `formatToParts` is used rather than slicing the formatted string: the en-US
 * date pattern is "10/04/2026", so a positional slice would build
 * "10-04-2026" and every `Date.UTC` derived from it would be NaN.
 */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const hm = partMap(timeZone, HOUR_MINUTE, ms);
  const dp = partMap(timeZone, DATE_PARTS, ms);
  const weekdayName = partMap(timeZone, { weekday: "short" }, ms).weekday ?? "";
  const dayOfWeek = WEEKDAY_INDEX[weekdayName] ?? new Date(ms).getUTCDay();
  const rawHour = parseInt(hm.hour ?? "0", 10) || 0;
  const minute = parseInt(hm.minute ?? "0", 10) || 0;
  const hour = rawHour === 24 ? 0 : rawHour; // defensive: normalise any stray 24 back to 0
  const dateKey = `${dp.year}-${dp.month}-${dp.day}`;
  return {
    dayOfWeek,
    hour,
    minute,
    dateKey,
    hourLabel: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

/** Platform-local hour 0..23 for an instant. */
export function zonedHour(ms: number, timeZone: string): number {
  return zonedParts(ms, timeZone).hour;
}

/** Platform-local day-of-week 0=Sun … 6=Sat for an instant. */
export function zonedDayOfWeek(ms: number, timeZone: string): number {
  return zonedParts(ms, timeZone).dayOfWeek;
}

/** "YYYY-MM-DD" day key in the platform timezone. */
export function zonedDateKey(ms: number, timeZone: string): string {
  return zonedParts(ms, timeZone).dateKey;
}

/** "HH:MM" label in the platform timezone (replaces `toISOString().slice(11,16)`). */
export function zonedHourLabel(ms: number, timeZone: string): string {
  return zonedParts(ms, timeZone).hourLabel;
}

/**
 * The instant `ms` expressed as if the platform-local wall clock were UTC.
 * `localWallClockAsUtc(t, "Asia/Aden") - t` is exactly the zone's UTC offset.
 */
function localWallClockAsUtc(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(
    Number(p.dateKey.slice(0, 4)),
    Number(p.dateKey.slice(5, 7)) - 1,
    Number(p.dateKey.slice(8, 10)),
    p.hour,
    p.minute,
    0,
    0,
  );
}

/**
 * Epoch millis of the platform-local midnight that starts the day containing
 * `ms`. This is the timezone-correct replacement for
 * `new Date().setHours(0, 0, 0, 0)`, which yields UTC midnight whenever the
 * host TZ is UTC (which is the case for the Docker image — it sets no TZ).
 *
 * Numeric check, Asia/Aden (UTC+3, no DST):
 *   ms = 2026-10-03T21:30:00Z (which is 00:30 on 2026-10-04 in Aden)
 *   → returns 2026-10-03T21:00:00Z
 *   `new Date(ms).setHours(0,0,0,0)` on a UTC host returns 2026-10-03T00:00:00Z
 *   — three hours and one calendar day early, so anything between 00:00 and
 *   03:00 Aden is attributed to the previous day.
 *
 * Works for DST zones too: the offset is re-evaluated at each iterate but the
 * iteration target (`dayStartAsIfUtc`) stays fixed, so it converges in two
 * passes instead of oscillating.
 */
export function startOfZonedDay(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  // Treat the platform-local calendar date as if it were UTC — that value is
  // the fixed iteration target.
  const dayStartAsIfUtc = Date.UTC(
    Number(p.dateKey.slice(0, 4)),
    Number(p.dateKey.slice(5, 7)) - 1,
    Number(p.dateKey.slice(8, 10)),
  );
  let candidate = dayStartAsIfUtc;
  for (let i = 0; i < 3; i++) {
    const offset = localWallClockAsUtc(candidate, timeZone) - candidate;
    const next = dayStartAsIfUtc - offset;
    if (next === candidate) break;
    candidate = next;
  }
  return candidate;
}

/** Whole days between two instants, counted on platform-local calendar days. */
export function zonedDaySpanDays(fromMs: number, toMs: number, timeZone: string): number {
  return Math.round((startOfZonedDay(toMs, timeZone) - startOfZonedDay(fromMs, timeZone)) / 86_400_000);
}

/**
 * Epoch millis of the platform-local hour boundary at or before `ms`.
 *
 * Used to align the analytics hourly trend buckets so a bucket labelled "03:00"
 * really contains 03:00–03:59 Aden, not 03:00–03:59 UTC.
 */
export function startOfZonedHour(ms: number, timeZone: string): number {
  const hour = zonedParts(ms, timeZone).hour;
  // Walk back to the day boundary first, then add whole local hours. For a
  // fixed-offset zone (Asia/Aden) this is exact; for a DST zone it is exact
  // except within an hour of a transition, where the error is at most 1 h and
  // always lands on an hour boundary.
  return startOfZonedDay(ms, timeZone) + hour * 3_600_000;
}

/**
 * Short weekday label ("Mon") rendered through Intl with an explicit `en-US`
 * base plus an explicit `timeZone`, replacing the server-locale-dependent
 * `toLocaleDateString("en-US", { weekday: "short" })`.
 */
export function zonedWeekdayLabel(ms: number, timeZone: string): string {
  return formatter(timeZone, { weekday: "short" }).format(new Date(ms));
}