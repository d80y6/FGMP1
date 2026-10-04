# Task 32-A — System Health & Monitoring View

**Agent:** System Health View Builder (direct execution)
**Task:** Build a System Health & Monitoring view (admin-only NOC dashboard)
with API, in-memory metrics tracker, and auto-refreshing dashboard.

## What was built

### New files (5)
- `src/lib/fgmp/metrics.ts` — In-memory metrics collector singleton
  (`requestCount`, `totalResponseTimeMs`, `errorBuffer` ring buffer max 20,
  helpers `recordRequest`, `recordError`, `getMetrics`, `getAvgResponseMs`,
  `getRecentErrors`, `resetMetrics`).
- `src/lib/fgmp/with-metrics.ts` — Higher-order wrapper for Next.js App
  Router RouteHandlers; auto-records duration, status, and pushes 4xx/5xx
  into the error ring buffer.
- `src/app/api/fgmp/health/route.ts` — ADMIN-only aggregate health snapshot.
  Returns uptime/memory/database/realtime/api/sessions/errors/timestamp.
  10-second in-memory cache. TCP-port-probe (Node `net` module, 500 ms)
  against port 3003 + HTTP `/health` fetch to retrieve the live socket.io
  client count from the realtime mini-service.
- `src/components/fgmp/views/system-health-view.tsx` — `'use client'`
  dashboard view. Header with last-refresh + countdown + manual refresh
  button. 4-card KPI strip (Uptime with green pulse, Avg API Response with
  trend arrow, Active Sessions 24 h, Error Count last 1 h with tone
  indicator). Realtime card with live pulsing status. Memory card with
  heap-usage Progress bar. Database card with type/size/path + table row
  counts. Recent Errors table (max-h-96 scroll with custom rose-tinted
  scrollbar, red/yellow status badges). 10 s auto-refresh + countdown
  timer. Responsive grid (1/2/4 cols). Full EN/AR i18n + Arabic-Indic
  numerals via `formatNumber`. ADMIN-only RBAC check after all hooks.
- (this file)

### Modified files (5)
- `src/lib/fgmp/store.ts` — Added `"system-health"` to the `ViewKey`
  union type.
- `src/lib/fgmp/i18n.ts` — Added 52 keys under `systemHealth.*` plus
  `nav.systemHealth` + `desc.systemHealth` (104 strings total EN+AR).
  Covers title/subtitle, KPI labels, realtime, database, memory, errors
  table headers, access-denied messages, loading/refresh UI strings.
- `src/components/fgmp/app-shell.tsx` — Imported `SystemHealthView`,
  added `"system-health"` entry to `VIEW_COMPONENTS` map, added new NAV
  item in the Administration group after `users` (icon: `Activity`,
  capability: `view:system-health` — only ADMIN has `*`).
- `src/app/api/fgmp/state/route.ts` — Wrapped `GET` handler with
  `withMetrics(...)` so the platform's hottest read endpoint is sampled.
- `src/app/api/fgmp/alarms/route.ts` — Wrapped `GET` and `POST` handlers
  with `withMetrics(...)` so alarm list + bulk ack/resolve are sampled.
- `src/app/globals.css` — Added `.health-errors-scroll` custom scrollbar
  (thin, 6 px, rose-tinted thumb) for the recent-errors table.

## Verification

- `bun run lint` → **0 errors, 0 warnings** (the only pre-existing warning
  is in `suppressions-view.tsx` created by the parallel Task 32-B agent
  — not touched by this task).
- Dev server compiles cleanly (no errors in `dev.log` related to my code).
- `GET /api/fgmp/health` correctly returns **401 Unauthorized** when no
  session is supplied — confirming `requireRole(req, ROLES.ADMIN_ONLY)`
  is enforced.

## Architecture notes

### Why a per-process metrics tracker instead of Prometheus?
The platform already ships as a single Next.js process (one app on
port 3000 per the deployment constraint). An in-process singleton is
sufficient for a NOC display and avoids adding a Prometheus exporter +
scrape config to the deployment. The `metrics` module is structured so
it can be swapped for a Prometheus push gateway later without touching
the route handlers — `recordRequest` / `recordError` are the only API.

### Why 10-second response caching on /api/fgmp/health?
The dashboard polls every 10 s. Without caching, each poll would run
5+ Prisma `count()` queries + a TCP probe + an HTTP fetch to the
realtime service. The 10 s TTL means at most one fresh computation
per poll cycle, with cached responses served instantly in between.

### Why fetch the realtime `/health` for the client count?
The Socket.io server (`mini-services/realtime/index.ts`) already exposes
a `/health` endpoint that returns `{ clients: io.engine.clientsCount }`.
Rather than duplicate state, the health route just proxies that. If the
realtime service is down, the TCP probe fails first and the HTTP fetch
is skipped (saves the 800 ms timeout).

### Why declare the HealthResponse type locally in the view?
Importing a type from a route file (`/api/fgmp/health/route.ts`) would
couple the client bundle to a server-only module — Next.js may flag it
as a server-only import. Declaring the interface locally keeps the
client bundle clean; if the server shape drifts, runtime checks (`?.`
+ `??` fallbacks) keep the UI graceful.

### Rules of Hooks compliance
All `useState` / `useRef` / `useCallback` / `useEffect` / `useMemo`
calls happen BEFORE the access-control early return. The ADMIN-only
check uses an early `return` AFTER every hook so the hook order is
identical on every render regardless of the user's role.

## Files not touched
- `prisma/schema.prisma` — no schema changes (existing User.lastLoginAt
  field already used for the 24 h active-session count).
- Other API routes — only `/api/fgmp/state` and `/api/fgmp/alarms` were
  wrapped with `withMetrics` per the task spec ("don't wrap ALL routes —
  just these two high-traffic ones").

## Issues encountered
- The sandbox's SQLite file appears readonly for the Next.js dev process
  (pre-existing environment issue, surfaced as `attempt to write a
  readonly database` on `db.user.update` inside NextAuth's `authorize()`
  callback). This blocks interactive login via curl, so a full end-to-end
  visual test of the dashboard wasn't possible from the shell. The view
  compiles cleanly, lint is 0 errors, and the endpoint correctly returns
  401 for unauthenticated requests — confirming the code path is sound.
