# Architecture

How FGMP is put together, and why the boundaries are where they are. This is the
normative description of the current tree; historical design records live in
[`history/`](history/) and are not authoritative.

## 1. Request path

```
browser ─┬─ NextAuth session (JWT cookie)
         ├─ GET /api/fgmp/state        ─┐
         └─ private channel (Apinator) ─┘   every 5 s or on a realtime hint

route handler ─ requireAuth/requireRole ─ withTenant(tenantId) ─ Prisma ─ PostgreSQL
                                             │
                                             └─ SET LOCAL app.tenant_id  (RLS)
```

* **Authentication** — NextAuth with a JWT session. `getCurrentUser()` fails
  closed: with no session it throws, and routes that have not already passed
  `requireAuth()`/`requireRole()` return 401 rather than a default identity.
* **Authorisation** — `requireRole()` enforces the role set; `assertTenantOwned()`
  compares the row's `tenantId` with the caller's as defence in depth. It is not
  the tenant boundary — the database is.
* **Tenant scoping** — every query runs through `withTenant()`/`asTenant()`
  (`src/lib/fgmp/tenant-context.ts`), which opens a transaction and issues
  `SET LOCAL app.tenant_id`. `SET` without `LOCAL` would survive on a pooled
  connection and hand one tenant's rows to the next request; `withTenant` is the
  only supported entry point.
* **RBAC + tenant** — a SUPER_ADMIN may select another tenant explicitly; every
  other role is pinned to its own `tenantId`, which is read from the session, not
  from the request body.

## 2. Data layer

* PostgreSQL 17 with TimescaleDB. `SensorReading` is a hypertable; the rest are
  ordinary tables.
* Prisma 6 with native enums; decimal columns are `Decimal` (no floats for
  money or litres).
* 36 tenant-carrying tables have `FORCE ROW LEVEL SECURITY` and a `tenant_id`
  policy. The app connects as `fgmp_app`, which is **not** the owner, so policies
  apply to every query the app issues, including a query written without a
  tenant filter.
* `FGMP_REQUIRE_RLS=1` (default) makes the app refuse to start when the database
  role can bypass RLS. `render.yaml` and `.env.example` both set it.
* Migrations are committed SQL under `prisma/migrations/`; `migrate deploy` is
  the only supported application path. Schema changes never run from the app
  container (see [DEPLOYMENT.md](DEPLOYMENT.md)).

## 3. The engine and the clock

`src/lib/fgmp/engine.ts` is the domain core: it loads a tenant's sites, tanks,
generators, batteries, dispensers and devices into an in-memory snapshot and
exposes operations on them (command dispatch, delivery acceptance, loss
detection, KPI derivation).

**The clock is owned by the server, not by a browser tab.**
`src/lib/fgmp/scheduler.ts` advances state every 5 s from `instrumentation.ts`,
guarded by a PostgreSQL advisory lock (`pg_try_advisory_xact_lock`) so N replicas
advance exactly once per interval. It runs only when simulation is permitted
(`FGMP_SIMULATION` and not production), because a scheduler that starts anyway
would fabricate telemetry in production. `assertSimulationAllowed()` is the
single gate.

Persistence: engine state is written back to the database at a bounded cadence,
not on every tick, and the snapshot endpoints read the persisted state. The
`SensorReading` history window is 24 h at 5-minute resolution.

## 4. Telemetry path

Two producers, one consumer:

```
ESP32/ESP8266 ──MQTT──▶ mosquitto (per-tenant ACL) ──▶ mini-services/iot-bridge
                                                              │  POST /api/fgmp/iot/ingest
                                                              ▼
                                                    validation → engine update
                                                              │
                                                              ├─ SensorReading row
                                                              └─ Apinator event
```

* `mini-services/iot-bridge` (Bun) subscribes to broker topics / simulates field
  readings and posts them to the ingest route with `x-api-key`. It holds no
  socket to the app.
* `/api/fgmp/iot/ingest` authenticates the **device** (`IOT_API_KEY`, minimum 16
  chars, no committed default), validates the reading against the Prisma enums,
  and rejects unknown site/device identifiers rather than silently dropping them.
  A missing key is a 503, not an open door.
* `/api/fgmp/realtime/snapshot` exists for the bridge only: it presents
  `REALTIME_SERVICE_TOKEN` because the bridge cannot hold a browser session.

## 5. Protocol and control

`src/lib/fgmp/protocol/` is a transport-agnostic stack:

* `modbus.ts` — RTU framing and CRC (pure functions, no I/O).
* `transport/` — `Transport` interface with serial, TCP and MQTT implementations,
  plus an in-memory broker for tests.
* `interlock-*.ts` — hardware safety rules with provenance-carrying thresholds:
  a rule refuses an action and says why. Thresholds resolve from env →
  `SystemSetting` → default.
* `command-reconciliation.ts` — moves abandoned `ControlCommand` rows to a
  terminal state **with a reason**, so a dropped packet cannot permanently
  disable a generator (`COMMAND_ALREADY_IN_FLIGHT`).

Remote control is honest about what it cannot do. No configured transport means
`NO_TRANSPORT`; the platform never reports a simulated success as a real one.
`dispatch/simulated.ts` is the only dispatch implementation shipped, and it
returns `NO_TRANSPORT` by design.

## 6. Realtime

Realtime is **latency, not data**. The server publishes events (alarm raised,
delivery updated, command resolved) to a tenant-wide private channel on
Apinator; browsers subscribe and refresh through the tenant-scoped REST API.
A dropped emit is harmless: the 5-second poll reconciles. The server never pushes
whole snapshots and there is no `state:tick`.

Tenant resolution for an event is deliberately privileged: an ingest event
carries only a `siteId`, and under FORCE RLS the app client cannot read the site
without the tenant id it is trying to discover. `realtime-emitter.ts` resolves it
through the ops connection, and only for that lookup.

## 7. Domain modules

| Area | Location |
|---|---|
| Engine, scheduler, dispatch | `src/lib/fgmp/{engine,scheduler,dispatch}.ts` |
| Tenant context / RLS helpers | `src/lib/fgmp/{tenant-context,route-tenant}.ts` |
| Auth, RBAC, MFA | `src/lib/fgmp/{rbac,mfa/}` |
| Alarms, correlation, alerting | `src/lib/fgmp/{alarm-*,correlation*,alerting/}` |
| Interlocks and thresholds | `src/lib/fgmp/{interlock-*,thresholds-*}.ts` |
| Health scoring | `src/lib/health/site-health-score.ts` (single scorer, 5 bands) |
| Notifications | `src/lib/fgmp/notification-{transport,sms}.ts` |
| Export (CSV/XLSX/PDF/DOCX) | `src/lib/fgmp/export-render.ts`, `src/lib/fgmp/csv.ts` |
| i18n (AR/EN + RTL) | `src/lib/fgmp/i18n.ts`, `use-language.ts` |
| Observability | `src/lib/observability/` (`/api/fgmp/health`, `/api/fgmp/metrics`) |

## 8. Client structure

`src/components/fgmp/app-shell.tsx` owns navigation and the 5-second refresh.
Views under `views/` render one product area each and use `useApi()` for
fetching; shared presentational pieces (status colours, health bands, numeral and
CSV formatting) live in `src/lib/fgmp/{status,numerals,csv,format,labels}.ts` so
the same value cannot render two different ways.

## 9. Operational surface

| Route | Auth | Purpose |
|---|---|---|
| `/api/health/live` | none | liveness: the process serves HTTP, no dependency |
| `/api/health/ready` | none | readiness: database reachable and schema migrated (503 otherwise) |
| `/api/fgmp/health` | ADMIN | detailed view: memory, DB size, tenant-scoped counts, verdict |
| `/api/fgmp/metrics` | ALARM_OPS | Prometheus exposition |

Boot is gated twice before any request is served: `scripts/docker-entrypoint.mjs`
runs the schema preflight, and `instrumentation.ts` validates the environment
(`src/lib/env.ts`) and exits non-zero on an error rather than leaving a port open
on a process that cannot serve.

Static assets: fonts are vendored (`src/app/fonts/`) rather than fetched from
Google at build time; runtime data files (`config/alerts.json`) are declared in
`outputFileTracingIncludes` and copied into the image explicitly, because
standalone tracing follows module imports, not `fs` reads.

## 10. What is intentionally not built

* No write path from the web app to a physical dispenser: the Modbus and MQTT
  transports exist and are tested, but no deployment configures one.
* No self-hosted realtime service; the former socket.io mini-service is gone.
* No HTTP backup route: backups run as a one-shot container (see
  [DEPLOYMENT.md](DEPLOYMENT.md#backups)).
