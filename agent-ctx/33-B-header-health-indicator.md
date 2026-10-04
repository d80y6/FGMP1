# Task 33-B — Header Health Indicator Builder

**Task**: Add live system health mini-indicator to app header with pulse
animation and tooltip.

## Work Log

- **Read worklog.md** — understood platform state: 15 views, NextAuth auth,
  Socket.io realtime, RBAC, System Health API at `/api/fgmp/health`, and
  a System Health view added by Task 32-A. The metrics tracker
  (`metrics.ts`) and `withMetrics` HOC were already in place, exposing
  `requestCount`, `avgResponseMs`, and a 20-entry error ring buffer.
- **Read existing files** to understand patterns:
  - `src/lib/fgmp/use-api.ts` — `useApi<T>(url, { interval })` hook with
    `credentials: "include"` for NextAuth session. On 401/403/network:
    `data` stays null, `error` is set — exactly the "unknown" case the
    indicator needs to fall back to.
  - `src/components/fgmp/mini-status-indicator.tsx` — reference for
    header pill widget styling (border + bg + text color per tone).
  - `src/app/api/fgmp/health/route.ts` — HealthResponse shape includes
    `realtime`, `api.avgResponseMs`, `errors[]` with ISO timestamps —
    matches the `HealthSnapshot` interface required by the task spec.
  - `src/lib/fgmp/use-language.ts` — `useT`, `useDir`, `useArabicNumerals`,
    `formatNumber` for i18n + Arabic-Indic numeral localization.
  - `src/components/ui/tooltip.tsx` — shadcn Tooltip primitives available.
- **Created `src/lib/fgmp/compute-health.ts`** — pure function
  `computeHealthStatus(data: HealthSnapshot | null): HealthStatus`.
  - 4-tier classification: healthy / degraded / critical / unknown.
  - Critical rule (most-severe): `!realtimeOk && (errorsLastHour > 5 ||
    !responseDegraded)` — i.e. realtime down AND (lots of errors OR
    response >= 500ms).
  - Degraded rule: any single signal off (realtime disconnected,
    >5 errors, response >= 500ms, 1+ errors, response >= 200ms).
  - Healthy: realtime connected + 0 errors last hour + response < 200ms.
  - Unknown: `data == null` (initial load, fetch error, 401/403).
  - Filters errors to the last hour using `Date.now()` at call time so
    the bucket slides forward naturally as the indicator polls.
- **Created `src/components/fgmp/system-health-indicator.tsx`** — the
  compact header widget.
  - `'use client'` directive at the top.
  - `useApi<HealthSnapshot>("/api/fgmp/health", { interval: 30_000 })`
    polls every 30s (lighter than the full view's 10s, per spec).
  - `useRef` mirrors `data` + `status` on each render to avoid stale
    closures in any future callback (manual refresh, keyboard handler).
  - Status → visual mapping via `STATUS_VISUALS` lookup table:
    - healthy → emerald dot + `health-dot-green` (2s pulse)
    - degraded → amber dot + `health-dot-amber` (1.5s pulse)
    - critical → rose dot + `health-dot-red` (0.8s pulse)
    - unknown → muted-foreground dot, no animation
  - Loading fallback: when `loading && !data`, shows a pulsing Lucide
    `Activity` icon instead of the dot (per spec).
  - Tooltip uses shadcn `<Tooltip>` / `<TooltipTrigger>` / `<TooltipContent>`
    with a `<button>` trigger (clickable + keyboard-accessible).
  - Tooltip content: header row with Activity icon + "System Health"
    title; three metric rows (Realtime: Connected/Disconnected, Errors
    (1h): N, Avg response: Xms); "View details →" hint at the bottom.
  - Each metric row's value is color-coded by severity (emerald/amber/
    rose) for at-a-glance readability.
  - `formatNumber(num, numLang)` localizes numerals to Arabic-Indic when
    AR is active (consistent with the rest of the platform).
  - `aria-label` includes both "System Health" and the current status
    label for screen readers.
  - Width `w-[120px]`, height `h-8`, `hover:bg-muted/50` rounded hover
    background per spec.
- **Added CSS pulse animations** to `src/app/globals.css`:
  - `@keyframes health-pulse-green` — box-shadow 0→6px emerald, 2s loop.
  - `@keyframes health-pulse-amber` — box-shadow 0→6px amber, 1.5s loop.
  - `@keyframes health-pulse-red` — box-shadow 0→8px rose, 0.8s loop.
  - `.health-dot-green`, `.health-dot-amber`, `.health-dot-red` utility
    classes that the indicator component applies conditionally.
  - Inserted between `.health-errors-scroll { ... }` opening block and
    the existing `::-webkit-scrollbar` pseudo-element rules (no overlap
    with existing styles).
- **Added `healthIndicator.*` i18n keys** to `src/lib/fgmp/i18n.ts`:
  - 10 keys × 2 languages = 20 new strings (EN + AR):
    `healthy`, `degraded`, `critical`, `checking`, `realtime`, `connected`,
    `disconnected`, `errorsLastHour`, `avgResponse`, `viewDetails`.
  - Inserted right after the `systemHealth.*` namespace (line 1388) and
    before the `suppressions.*` namespace (Task 32-B), keeping related
    health-related keys grouped together.
- **Wired into `src/components/fgmp/app-shell.tsx`**:
  - Added import: `import { SystemHealthIndicator } from "@/components/fgmp/system-health-indicator";`
    (line 45, after `MiniStatusIndicator` import).
  - Placed `<SystemHealthIndicator onClick={() => navigate("system-health")} />`
    in the header between the Clock and the NotificationCenter (lines
    354-360) — i.e. between the search box and the notification bell,
    per spec.
  - Wrapped in `{role === "ADMIN" && (...)}` so non-admins don't see a
    forever-"Checking…" pill (they can't access `/api/fgmp/health`).
  - Used `navigate("system-health")` instead of `setView("system-health")`
    — `navigate` calls `setView` AND syncs the URL `?view=` param AND
    closes the mobile nav drawer, matching how every sidebar nav item
    works. Functionally equivalent to the spec's example, better UX.
- **Lint check**: `bun run lint` → exit 0, 0 errors, 0 warnings.

## Stage Summary

### NEW FILES (2)
- `src/lib/fgmp/compute-health.ts` — pure 4-tier health status classifier
  (healthy / degraded / critical / unknown). No React deps; trivially
  unit-testable.
- `src/components/fgmp/system-health-indicator.tsx` — compact ~120px
  header widget with pulsing dot, status text, hover tooltip, click-
  to-navigate. Polls every 30s. ADMIN-only.

### MODIFIED FILES (3)
- `src/app/globals.css` — added 3 `@keyframes` (`health-pulse-green`,
  `health-pulse-amber`, `health-pulse-red`) and 3 utility classes.
- `src/lib/fgmp/i18n.ts` — added 10 `healthIndicator.*` keys (EN+AR).
- `src/components/fgmp/app-shell.tsx` — added import + ADMIN-gated
  `<SystemHealthIndicator />` in the header between Clock and
  NotificationCenter.

### LINT: 0 errors, 0 warnings
### DEV SERVER: compiles cleanly (✓ Compiled in 197ms)
### Issue noted (NOT mine): Another agent's parallel work added an
    `import { PreferencesView }` for a file that doesn't exist
    (`src/components/fgmp/views/preferences-view.tsx`), causing
    /api/fgmp/health and other routes to 500 with `Module not found`.
    This is independent of Task 33-B — my files compile and lint
    cleanly. The broken import is in lines 40 / 74 / 93 of
    app-shell.tsx and needs Task 33-A's owner to either create the
    missing view file or revert those three lines.
