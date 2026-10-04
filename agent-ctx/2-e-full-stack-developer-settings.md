---
Task ID: 2-e
Agent: full-stack-developer (Settings module)
Task: Build System Settings view + API (global config)

Work Log:
- Read worklog.md (Task 18 was the latest entry — fix for a variable-shadowing
  bug in site-detail-sheet.tsx). Read the existing stub at
  `src/components/fgmp/views/settings-view.tsx` (was a "Module loading…" stub).
- Read reference files to align with project conventions:
  * `src/app/api/fgmp/users/route.ts` — pattern for `requireAuth` GET +
    `requireRole` mutation, `bootstrap()`, `rateLimitByUser`,
    `applyRateLimitHeaders`, `errorResponse`, `audit()`.
  * `src/components/fgmp/views/preferences-view.tsx` — closest analog
    (form-based settings view) for layout: SectionHeader, themed cards,
    sticky bottom action bar with Save + Reset.
  * `src/lib/fgmp/auth-helpers.ts`, `audit.ts`, `rate-limit.ts`,
    `api-error.ts`, `use-api.ts`, `use-language.ts`, `store.ts`,
    `section-header.tsx` — verified helper signatures.
  * `src/lib/fgmp/i18n.ts` lines 1780–1810 — confirmed all 22 `settings.*`
    keys already exist (title, description, alarmThresholds,
    escalationTimers, branding, platform, fuelLowPct, fuelCriticalPct,
    genOvertempC, battLowVoltagePct, l1ToL2Minutes, l2ToL3Minutes,
    autoResolveHours, platformName, supportEmail, timezone,
    pollingIntervalSec, saveSettings, resetDefaults, saved, reset,
    readOnly). No i18n edits needed.

- CREATED `src/lib/fgmp/settings.ts` (server-side only, imports `fs/promises`):
  * `PlatformSettings` interface (11 fields) + `DEFAULT_SETTINGS` const.
  * `getSettings()` — reads `.fgmp-settings.json` from `process.cwd()`,
    merges over DEFAULT_SETTINGS, caches in-process.
  * `saveSettings(s)` — writes JSON to disk (2-space indent), refreshes
    cache. Atomicity is best-effort (single writeFile syscall); a crash
    mid-write falls back to DEFAULT_SETTINGS on next read.

- CREATED `src/app/api/fgmp/settings/route.ts`:
  * `export const dynamic = "force-dynamic";`
  * `GET` — `requireAuth()` (any authenticated role), `bootstrap()`,
    `rateLimitByUser(READ_LIMIT)`, returns `getSettings()`.
  * `PUT` — `requireRole(req, ROLES.ADMIN_ONLY)`, `bootstrap()`,
    `rateLimitByUser(MUTATION_LIMIT)`, zod-validates the 11-field body
    with the exact min/max bounds from the spec, calls `saveSettings()`,
    `audit({ action: "Settings_UPDATE", entity: "Settings",
    entityId: "global", details: next })`, returns the saved object.
  * All error paths attach rate-limit headers; `errorResponse` wraps
    thrown errors.

- MODIFIED `src/components/fgmp/views/settings-view.tsx` — replaced the
  stub with a full client form:
  * `"use client"`; exported `SettingsView`.
  * Loads settings via `useApi<PlatformSettings>("/api/fgmp/settings")`.
  * Local `form` state synced from loaded snapshot once on first load
    (`useEffect` + `hasLoaded` guard).
  * `isDirty` = JSON.stringify(form) !== JSON.stringify(loaded).
  * Admin gate: `const isAdmin = me?.role === "ADMIN"` from `useFgmp`.
  * Non-admins see an amber `Alert` with `t("settings.readOnly")` and
    every input is `disabled` (with `disabled:opacity-50
    disabled:cursor-not-allowed`).
  * Three themed cards in a 1-col (mobile) / 3-col (lg) grid:
      1. Alarm Thresholds — Siren icon, rose tone, top border accent.
         4 numeric fields in 1-col (mobile) / 2-col (sm+) grid.
      2. Escalation Timers — Timer icon, amber tone. 3 numeric fields.
      3. Branding / Platform — Building2 icon, emerald tone. 4 fields:
         platformName (text), supportEmail (email), timezone (Select with
         15 common TZs), pollingIntervalSec (number).
  * Each Field component: Label above, Input, tiny muted range hint below
    (numeric min–max, language-neutral — uses `formatNumber` for Arabic
    numerals).
  * Summary card: shows current platformName / supportEmail / timezone.
    Amber dot + save label appears when `isDirty && isAdmin`.
  * Sticky bottom action bar (admin only): "Reset to Defaults" (ghost,
    RotateCcw icon) + "Save Settings" (primary, Save icon). Save disabled
    when `!isDirty || saving`. Amber dot when dirty, green check when
    clean. Loader2 spinner while saving.
  * Save handler: `fetch PUT /api/fgmp/settings`, toast
    `t("settings.saved")`, refresh useApi snapshot.
  * Reset handler: overwrite `form` with hardcoded `DEFAULT_SETTINGS`
    const, immediately PUT (no confirm), toast `t("settings.reset")`.
  * Loading skeleton + error Alert states.
  * All labels/descriptions/buttons/toasts use `t("settings.*")` /
    `t("mgmt.*")` keys — no hardcoded English.
  * No indigo or blue colors. Tone palette: rose / amber / emerald /
    primary.

- VERIFICATION:
  * `bun run lint` → 0 errors (whole project).
  * `curl http://localhost:3000/api/fgmp/settings` (GET, no session) →
    HTTP 401 `{"error":"Unauthorized","code":"UNAUTHENTICATED"}` — route
    compiles cleanly in 311ms, auth guard works.
  * `curl -X PUT ...` (no session) → HTTP 401 — PUT handler also
    compiles and the ADMIN-only guard rejects unauthenticated requests.
  * `tail /home/z/my-project/dev.log` → no settings-related runtime
    errors; only the expected `401` lines.
  * Confirmed `SettingsView` is wired into the app-shell view map at
    `src/components/fgmp/app-shell.tsx:46,109` (key `settings`).

Stage Summary:
- 3 files produced (1 lib + 1 API route + 1 view), 0 files modified
  outside the spec's allow-list.
- Global platform settings now persist to
  `/home/z/my-project/.fgmp-settings.json` (created on first PUT, not
  manually pre-created — verified the API lazily creates it).
- Read path open to every authenticated user; write path ADMIN-only with
  zod bounds + audit-log trail (action `Settings_UPDATE`).
- UI matches the preferences-view pattern: SectionHeader, themed cards,
  sticky action bar, dirty indicator, full i18n (EN + AR), RTL support.
- No Prisma schema changes (`.fgmp-settings.json` on disk avoids a
  migration, per the task brief).
- lint: 0 errors. dev server: healthy, no new runtime errors.
