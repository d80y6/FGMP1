# The telemetry clock is server-side

A factual record of how platform time advances, and the evidence for it. This
is written down because "the tick runs on the server" is a load-bearing safety
claim — fuel-loss detection depends on it — and it should not live only in a
conversation or a code comment that can be refactored away.

## The claim

**Platform state advances because the server process advances it. No browser is
involved, and no operator needs to have a dashboard open.**

## The mechanism, with sources

| Step | Location | What it does |
|---|---|---|
| 1. Boot | `src/instrumentation.ts:33` — `register()` | Next.js calls this **once per server process**, after the runtime is ready and before the first request is served. |
| 2. Guard | `src/instrumentation.ts:42` | Returns early on the Edge runtime: no useful timers, no advisory-lock connection. The Node server owns the clock. |
| 3. Permission | `src/instrumentation.ts:48-60` | `simulationDecision()` decides whether simulation is permitted **here**. If not, the scheduler does not start and logs why once, at boot. |
| 4. Start | `src/instrumentation.ts:67` → `ensureScheduler()` (`src/lib/fgmp/scheduler.ts:471`) | Creates the interval and wires the advance callback. |
| 5. Lock | `src/lib/fgmp/scheduler.ts:286` — `SELECT pg_try_advisory_xact_lock(...)` | The lock is held by the **database**, so with N replicas exactly one wins. The others skip that iteration. |
| 6. Advance | `src/lib/fgmp/scheduler.ts:173` — `await engine.tick(seconds)` | Per tenant, after `engine.reload()`. |
| 7. Drain | `src/instrumentation.ts:94-109` | SIGTERM/SIGINT await the in-flight advance before exit, so a deploy cannot abandon a half-written transaction. |

## What it replaced

`app-shell.tsx` used to `POST /api/fgmp/tick` every 5 s. That made the
**browser** drive platform state, with two consequences that made it unusable
for anything safety-related:

- **The clock ran at the speed of attendance.** Two operators with dashboards
  open advanced the same tanks twice as fast; nobody watching meant an
  unattended platform generated no data at all.
- **The outcome depended on who was looking.** A fuel-loss threshold could go
  unevaluated for hours because the shift with the dashboard was off.

The removal is recorded at `src/components/fgmp/app-shell.tsx:247`.

## The route still exists, deliberately

`src/app/api/fgmp/tick/route.ts` is retained but is not the clock:

- `POST` and `GET` require `ROLES.TICK` (`route.ts:69`, `route.ts:104`) — it
  was previously gated on a bare `requireAuth()`, which let a READONLY user
  advance platform state.
- It consults `simulationDecision()` (`route.ts:54`), so it cannot be used to
  force simulated telemetry into an environment where simulation is refused.

## What would invalidate this

- A component or `useEffect` that POSTs the tick route on a timer.
- Removing the advisory lock, which would make N replicas each advance the clock.
- Starting the scheduler from a request handler rather than `register()`.

`grep -rn "api/fgmp/tick" src/components/` returning a hit other than the
removal comment is the canary for the first.

## Related

- Simulation policy and the `assertSimulationAllowed()` signal:
  `src/lib/fgmp/simulation.ts`.
- Telemetry generation itself: `src/lib/fgmp/engine.ts`, driven by
  `scheduler.ts`.