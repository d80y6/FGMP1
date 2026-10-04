import { promises as fs } from "fs";
import path from "path";

/**
 * FGMP platform-wide settings store (Task 2-e)
 * ────────────────────────────────────────────────────────────────────────────
 * A small JSON-on-disk key/value store for global platform configuration
 * (alarm thresholds, escalation timers, branding). Persisted to
 * `<cwd>/.fgmp-settings.json` so we can add global tunables without a Prisma
 * schema migration.
 *
 * Server-side only: this module imports `fs` and must never be pulled into a
 * client component bundle. API routes in `/app/api/fgmp/settings/route.ts`
 * are the only caller.
 *
 * An in-process cache (`cache`) avoids re-reading the file on every GET —
 * the platform is single-instance so a memory cache is sufficient. The cache
 * is invalidated (overwritten) on every save.
 */

const SETTINGS_FILE = path.join(process.cwd(), ".fgmp-settings.json");

export interface PlatformSettings {
  // Alarm thresholds
  fuelLowPct: number;          // e.g. 25 (%)
  fuelCriticalPct: number;     // e.g. 10 (%)
  genOvertempC: number;        // e.g. 95 (°C)
  battLowVoltagePct: number;   // e.g. 88 (% of nominal)
  // Escalation timers
  l1ToL2Minutes: number;       // e.g. 15
  l2ToL3Minutes: number;       // e.g. 30
  autoResolveHours: number;    // e.g. 72
  // Branding / platform
  platformName: string;        // e.g. "FGMP"
  supportEmail: string;        // e.g. "support@example.com"
  timezone: string;            // e.g. "Asia/Aden"
  pollingIntervalSec: number;  // e.g. 5
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  fuelLowPct: 25,
  fuelCriticalPct: 10,
  genOvertempC: 95,
  battLowVoltagePct: 88,
  l1ToL2Minutes: 15,
  l2ToL3Minutes: 30,
  autoResolveHours: 72,
  platformName: "FGMP",
  supportEmail: "noc@fgmp.ye",
  timezone: "Asia/Aden",
  pollingIntervalSec: 5,
};

let cache: PlatformSettings | null = null;

/**
 * Load the current platform settings. Returns a defensive merge of the
 * stored JSON over DEFAULT_SETTINGS so callers always get a complete
 * `PlatformSettings` object even if the file is missing or partially
 * populated. The merge is cached for subsequent reads.
 */
export async function getSettings(): Promise<PlatformSettings> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PlatformSettings>;
    cache = { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

/**
 * Persist the supplied settings to disk and refresh the in-process cache.
 * The caller is responsible for zod-validation; we trust the input shape
 * here. Atomicity is "best effort" — `writeFile` truncates + writes in one
 * syscall; a crash mid-write could leave a partial file, in which case the
 * next `getSettings()` falls back to DEFAULT_SETTINGS (acceptable for
 * platform tunables).
 */
export async function saveSettings(s: PlatformSettings): Promise<void> {
  cache = s;
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2), "utf-8");
}
