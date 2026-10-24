# TASK_LEDGER

This file is durable across agent sessions and context limits. It holds **two** completed task
records. Read the part for the task you are resuming; do not delete a part when you finish a new
task — add one.

| Part | Task | Outcome |
|---|---|---|
| [A](#part-a--postgresql-connection-assessment) | PostgreSQL connection assessment (pooling, runtime, Hyperdrive eligibility) | Complete except Phase 7a/7b, blocked on a live provider |
| [B](#part-b--rbac-api-authorization-and-ui-enforcement) | RBAC, API authorization, UI permission enforcement | Complete; 4 defects fixed and verified, 2 blocked, 2 decisions open |

Status vocabulary used throughout: `DISCOVERED` → `CONFIRMED` → `IN_PROGRESS` → `FIXED` →
`VERIFIED` → `BLOCKED`. Nothing is `VERIFIED` on the strength of reading code: every VERIFIED line
names the test or command that proves it.

## Part A — PostgreSQL connection assessment

**Branch:** `arena/ea5864e5-fgmp1` (active) · **Starting commit:** `c19c2cff77051285a0c7815dfc7101866b1e5e76` · **Assessment date:** 2026-10-24 (Asia/Aden)
**Full report:** [`docs/DB-CONNECTION-ASSESSMENT.md`](docs/DB-CONNECTION-ASSESSMENT.md)

### Mission and constraints

Audit FGMP1's PostgreSQL connection architecture and improve only where evidence supports it. Preserve `fgmp_app` for ordinary queries, RLS/tenant isolation, data integrity, and deployment boundaries. Keep migration and ops credentials separate from ordinary app access; never fall back to a privileged URL when the app URL fails. Verify runtime/provider from evidence, do not assume Render or Cloudflare, do not introduce a Hyperdrive binding into Node, and do not use mocks in place of required real database tests. No production seed, reset, destructive operation, or unreviewed schema change is allowed.

### Status summary

- [x] Phase 1 — inspect repository/runtime/provider configuration and write the initial architecture report before implementation.
- [x] Phase 2 — collect controlled before measurements and real isolated-PostgreSQL evidence.
- [x] Phase 3 — fix the measured `pool_timeout` adapter-mapping defect and expose actual pool gauges. Pool size was not changed.
- [x] Phase 4 — evaluate Hyperdrive; not eligible on verified evidence because no active Cloudflare runtime/binding is established and the locked Cloudflare/Next versions do not establish compatibility.
- [x] Phase 5 — exercise tenant context, rollback/error recovery, real app role, timeout/recovery, and saturation against isolated PostgreSQL.
- [x] Phase 6 — run available regressions/typecheck, parse deployment YAML, and record lint/build limitations.
- [ ] Phase 7 — validate effective production/staging provider configuration and perform a staged rollout/rollback. Blocked: no live provider, Render environment, or authorized metrics scrape is available.

**Performance conclusion:** no material improvement. The app's three-connection pool plateaus under concurrency; high-concurrency latency reflects queueing. No cap change is recommended from these results.

### Architecture findings

- `render.yaml` declares a Render Docker web service, migration job, and IoT bridge. `Dockerfile` builds a standalone Next.js server run with Bun; `src/instrumentation.ts` declares Node.js. This describes a target, not a verified active deployment.
- An optional OpenNext/Cloudflare path also exists, but no Wrangler Hyperdrive binding is configured and the active runtime is unknown. The resolved Next.js 16.1.3 does not match the locked OpenNext Cloudflare package's declared supported range. No Cloudflare/Hyperdrive code was added.
- The live database provider, endpoint, pooler, provider limit, instance count, and production metrics are unknown.
- Ordinary application queries remain on the lazy process-shared Prisma client using `DATABASE_URL`/`fgmp_app`. Long-lived pools remain capped at 3 per client; serverless/workerd at 1. No pool size change was made.
- `pool_timeout`/`connect_timeout` now map to the stricter `connectionTimeoutMillis` supported by the locked `@prisma/adapter-pg`/`pg` stack. The actual app `pg.Pool` is retained for read-only, process-local metrics.
- `getOpsDb()` still supports `FGMP_OPS_DATABASE_URL`, a legacy ops alias, and then `FGMP_MIGRATE_DATABASE_URL` for explicit privileged system operations. This is not the ordinary app client fallback. Keep those uses scoped and verify whether the legacy/migration credential fallback is acceptable in each deployed service.

### Controlled before/after workload

**Setup:** isolated PostgreSQL 16.2; `fgmp_app`; `FGMP_REQUIRE_RLS=1`; pool cap 3; 180 read-only requests per concurrency level; 12 ms PostgreSQL sleep per request. Same scratch harness/settings before and after. After run sampled the actual app pool. This is local synthetic stress evidence, not production or a representative query mix.

| Concurrency | Before req/s; p50/p95/p99 ms | Before max total/active connections | After req/s; p50/p95/p99 ms | After max app connections | After max pool in-use/waiting; saturation |
|---:|---:|---:|---:|---:|---:|
| 1 | 70.8; 13.89/15.58/16.87 | 1/1 | 70.6; 13.93/15.33/16.69 | 1 | 1/0; 0.333 |
| 6 | 218.1; 27.15/28.24/33.12 | 3/3 | 214.1; 27.41/29.71/34.47 | 3 | 3/3; 1.000 |
| 18 | 219.2; 81.16/84.23/85.45 | 3/3 | 217.4; 82.17/83.80/84.53 | 3 | 3/15; 1.000 |

Differences are small/inconsistent and not statistically established as gains. Throughput plateaus near the configured cap at concurrency 6 and 18; queued clients and higher latency show pool wait. Do not claim an improvement or raise the cap based on this run.

### Real database/security evidence

The isolated cluster was PostgreSQL 16.2. Its 25 ordered migration SQL files were applied manually after `prisma migrate deploy` failed during initialization on PostgreSQL catalog type `name`; no Prisma migration history was established. Therefore this proves behavior against the applied schema/policies, not that the normal migration engine works on a hosted provider.

| Test/result | Evidence |
|---|---|
| `bun run test:db-connections` | Passed live app-role check: `current_user=fgmp_app`, `rolsuper=false`, `rolbypassrls=false`; 39 FORCE-RLS tables. Initial actual pool: total 1, idle 1, in-use 0, waiting 0, max 3. |
| Saturated pool metrics | Six concurrent read-only `withTenant()` transactions saturated the actual pool at 3/3, queued 3 clients, and published ratio `1`; Prometheus waiting gauge matched the actual pool snapshot. |
| Pool timeout/recovery | One-connection real adapter pool, `pool_timeout=1s`, `connect_timeout=5s`; queued checkout rejected after 1001 ms while a PostgreSQL query held the sole client; follow-up Prisma query succeeded. |
| `bun run test:rls` | 246 passed / 0 failed / 0 blocked; all 39 tenant-ID tables enabled and forced RLS; concurrent tenant contexts, cross-tenant denials, rollback, error recovery, and geography/view checks passed. |
| `bun run test:smoke` | Passed after test-only seed; fixture cleanup left seeded-site count unchanged at 52. `pg@8` overlapping-query deprecation warning remains. |
| Full `bun test` | 863 passed / 0 failed across 49 files, after seeding only the isolated local test DB. |
| `bun test src/lib/db.test.ts` | 22 passed / 0 failed. |
| Isolated role flags | `fgmp_app`: superuser false, bypass false; `fgmp_ops`: superuser false, bypass true; `fgmp_migrate`: superuser true, bypass false. These are local test-cluster roles only; production roles remain unknown. |

No production database was seeded or modified.

### Files changed and reasons

- `src/lib/db.ts`, `src/lib/db.test.ts`: wire the adapter's real pool timeout; retain existing caps; capture actual pool stats; test the timeout mapping.
- `src/lib/observability/metrics.ts`, `src/lib/fgmp/alerting/metrics-wiring.ts`, `src/app/api/fgmp/metrics/route.ts`, `src/lib/fgmp/__tests__/alerting-fires.test.ts`: add process-local pool saturation and connection-state gauges, sample them at authorized `ALARM_OPS` scrape time, and test alert behavior.
- `scripts/verify/db-connection-regression.ts`, `package.json`: add `test:db-connections` for actual-role, pool saturation, gauge publication, checkout timeout, and recovery checks.
- `scripts/verify/rls-regression.ts`, `scripts/verify/smoke-postgres.ts`: adapter-backed real-PG coverage, role/catalog checks, concurrent transaction context, rollback, and recovery.
- `docker-compose.yml`, `render.yaml`, `scripts/docker-entrypoint.mjs`, `Dockerfile`, `docs/DEPLOYMENT.md`: separate migration/app paths; add explicit Render migration-only and app skip-migrate modes; clear shared database URLs from non-DB bridge; avoid printing connection strings. Render behavior still needs staging verification.
- `docs/DB-CONNECTION-ASSESSMENT.md`: final evidence-based architecture/performance/security report.
- `TASK_LEDGER.md`: this execution record and pending work.

No schema migration, connection-limit increase, or production data change was made.

### Validation and limitations

| Check | Result |
|---|---|
| `bun run typecheck` | Passed after the final TypeScript integration-test edit was wired into `main()`. A current-workspace rerun could not start because the ephemeral Bun binary/dependencies were absent (`bun: command not found`); later edits were JavaScript, YAML, Dockerfile comments, and docs. |
| `bun run test:db-connections` | Passed after wiring the saturation check into `main()`; see real DB table above. |
| `bun test` | 863 pass / 0 fail / 49 files, using the isolated local PostgreSQL test seed only. |
| YAML syntax/boundaries | `docker-compose.yml` parsed (7 services); `render.yaml` parsed (3 services). Static assertions passed: web skips migration and blanks the inherited migrate URL, only the migration job receives it, and the API-only bridge has no DB URLs. |
| Entrypoint control flow | `node --check scripts/docker-entrypoint.mjs` passed. A temporary stub-CLI test confirmed `FGMP_MIGRATE_ONLY=1` passes the migration URL to Prisma's `DATABASE_URL`, exits successfully, does not seed/start the server, and logs no connection string. A fail-closed check confirmed `FGMP_SKIP_MIGRATE=1` refuses to start without `DATABASE_URL` even if a migration credential is present. These test dispatch only; they are not a real migration run. |
| `git diff --check` | Passed. |
| Temporary artifacts | Scratch benchmark source/log captures, temporary Prisma config, YAML parser, and entrypoint test directory were removed; no generated dataset or credential file is committed. |
| `bun run lint` | Last completed run failed: 28 errors and 3 warnings. It was not rerun after the latest integration/deployment edits; do not report lint as passing. |
| Dependency bootstrap | Frozen Bun installs failed TLS/connection errors. An npm fallback supplied temporary test dependencies, but Bun lockfile consistency was not proven; temporary tools/dependencies are no longer in the current workspace. |
| `bun run build` | Failed downloading Prisma schema-engine/checksum due TLS. Retry with a temporary Prisma config failed similarly. Direct Next build compiled, but the TypeScript worker was SIGKILLed after about 423 seconds. No successful build claim. |
| `bun run check:env` | Failed due missing `DATABASE_URL` and `NEXTAUTH_SECRET`; additional optional environment warnings were recorded. |
| `prisma migrate deploy` | Failed initialization on catalog type `name`; migrations were manually applied only to the disposable local test cluster for RLS/smoke tests. Hosted migration behavior remains unverified. |
| Authorized HTTP metrics scrape | Not performed; requires deployed service and an authorized `ALARM_OPS` identity. |
| Live Render/provider verification | Not available. The updated Blueprint was YAML-parsed, not deployed. |

### Deployment variables and boundaries

- `DATABASE_URL`: ordinary application traffic only; `fgmp_app`/RLS.
- `FGMP_MIGRATE_DATABASE_URL`: migration/seed jobs only; no ordinary query fallback.
- `FGMP_OPS_DATABASE_URL`: explicit privileged system operations only; not ordinary tenant queries.
- `FGMP_REQUIRE_RLS=1`: fail closed for an ordinary URL not recognized as `fgmp_app`.
- `FGMP_DB_CONNECTION_LIMIT`: optional cap override; keep current hard cap absent a provider budget.
- `FGMP_DB_POOL_TIMEOUT`: optional acquisition deadline in seconds, combined with `connect_timeout` using the stricter value.
- `FGMP_SKIP_MIGRATE=1`: web service after the migration job; entrypoint drops any inherited migration URL, preflights using `DATABASE_URL`/`fgmp_app` only, and starts without DDL or privileged fallback.
- `FGMP_MIGRATE_ONLY=1`: one-shot job; applies migrations, exits, does not seed/serve.

The Render web service now sets the app URL separately, clears the migration URL at service scope, and skips migration; the migration job no longer imports the shared `fgmp1` group and receives only the migration URL plus migration-only mode. The IoT bridge is API-only and clears all database URLs. Verify the effective live variables before deploying.

### Rollout / rollback plan

1. Before staging, establish the active runtime/provider, database endpoint/pooler, DB connection allowance, instance count, and hosted role flags. Capture production-like pre-change connection/latency/error/DB CPU metrics.
2. In staging, verify the effective role split and run the migration-only job; confirm it exits without seeding or starting the server. Run `test:db-connections`, `test:rls`, and smoke against an isolated/staging database.
3. Canary the web service with `FGMP_SKIP_MIGRATE=1`, `FGMP_REQUIRE_RLS=1`, and `DATABASE_URL=fgmp_app`. Keep the pool cap unchanged; scrape each process through the authorized metrics route and aggregate externally.
4. If role/RLS checks fail, timeouts/errors rise, or database headroom is insufficient, stop rollout and redeploy the previous app/configuration. Do not switch ordinary queries to ops/migrate/owner credentials or turn off RLS.
5. This change set has no schema migration. For future migration failures, leave the previous web image running and resolve forward; schema rollback requires its own reviewed recovery plan.

### Outstanding work / operator evidence needed

1. Confirm active runtime, provider, endpoint/pooler mode, connection limits, instance count, and actual role attributes.
2. Verify updated Render Blueprint behavior and effective environment variables in staging; confirm the app/bridge do not receive privileged database URLs and the migration job exits cleanly.
3. Run an authorized HTTP scrape on each deployed process and validate monitoring/aggregation.
4. Rerun lint and build in a functioning, lock-consistent toolchain with access to Prisma engines; review existing lint errors separately.
5. Compare a representative staged workload using the same before/after method. Current local measurements show no gain.
6. Decide in a separate security review whether `getOpsDb()`'s explicit legacy/migration credential fallbacks should be narrowed further.

Do not mark the task as a production performance success until the provider/runtime evidence, staged rollout, and authorized metrics are available.

---

## Part B — RBAC, API authorization and UI enforcement

**Branch** `arena/a6e56405-fgmp1` · **Base** `424ed2c` · owner: agent

Status values: `DISCOVERED` → `CONFIRMED` (reproduced) → `IN_PROGRESS` → `FIXED` (code done)
→ `VERIFIED` (a test proves it) → `BLOCKED` (needs an environment this sandbox lacks).

An item is never `VERIFIED` on the strength of reading code. Each VERIFIED line names the test
that proves it, and how to re-run it.

---

### 0. Baseline (reproduced)

| Check | Result |
|---|---|
| `bun test` | **831 pass / 13 skip / 16 fail / 860 tests** |
| The 16 failures | All in `decimal.test.ts`, at `new Prisma.Decimal(...)` — the Prisma client cannot be generated in this sandbox (`binaries.prisma.sh` is unreachable). Environmental and pre-existing, not an assertion about authorization. |
| Route inventory | **107 route files / 171 method handlers**, generated mechanically by `scripts/verify/route-inventory.ts` |

---

### 1. The authorization model as it actually exists (not as documented)

FGMP1 does **not** store permissions in the database. There is no `Permission` table, no join
table, no per-user grant, no custom roles. Authorization is a **two-layer, deny-by-default
capability model**, evaluated entirely from the *server-verified* role.

**Layer 1 — role → capability.** `src/lib/fgmp/rbac-core.ts: ROLE_PERMISSIONS`. Seven roles, each
an **explicit allow-list** of capability strings (`view:sites`, `alarm:ack`, `user:manage`, …).
Only `SUPERADMIN` holds `"*"`.

**Layer 2 — endpoint → required capability.** `apiReadCapabilities()` and `API_WRITE_RULES` in
the same file: declarative, per method, per path prefix. **An unmapped `/api/fgmp/**` path is
denied** — `canAccessApi()` returns false — so a newly added route fails closed until someone
writes its policy.

Both layers are evaluated inside `requireAuth()` (`src/lib/fgmp/auth-helpers.ts`), which every
session route calls. `requireAuth` additionally:

1. re-reads the account from the database on **every** request (`getSessionState()`) and lets the
   DB values replace the token's, so demotion, deactivation and a `sessionEpoch` bump take effect
   on the next request rather than the next login;
2. applies the signed, 15-minute, user-bound role-preview cookie **only** while the current DB role
   is still ADMIN or SUPERADMIN;
3. runs the Layer-2 policy check when the request object is passed in.

Row scoping is a third, orthogonal layer. Every tenant-carrying table has `FORCE ROW LEVEL
SECURITY` with `tenantId = current_setting('app.tenant_id')`; the runtime role is `fgmp_app`
(non-owner, no BYPASSRLS); and handlers additionally apply `tenantWhere()` / `assertTenantOwned()`
so a cross-tenant id yields **404, not 403** — no existence disclosure.

**So the brief's §4 is already satisfied by the existing design.** It is role-based,
identifier-stable, deny-by-default, and derived from trusted server-side identity. The brief's
example identifiers (`assets.read`, …) are explicitly illustrative and are **not** introduced —
that would create a second, competing model. §5 maps the brief's groups onto the capabilities that
already exist.

#### Effective permission = intersection of the two layers

`requireAuth` runs the capability check first, so a role reaches a handler only when **both** the
route's own allow-list and the capability policy admit it. Measured across all 171 handlers:
**zero divergence** (drift detector, §3 A-3).

---

### 2. Confirmed defects

#### D-1 · Stale cross-tenant snapshot after logout / account switch — **HIGH** — FIXED, VERIFIED
*Brief §6.4 — stale data from a previously authorized identity.*

`src/lib/fgmp/store.ts` keeps the whole `/api/fgmp/state` payload in a Zustand store. `setMe(null)`
— called on every logout — replaced `me` but left `snapshot` untouched, and fourteen components
read `useFgmp(s => s.snapshot)` directly. `AppShell` never consults `loading`.

**Repro:** sign in as ADMIN of tenant A → sign out → sign in as ADMIN of tenant B, same tab.
Between `status === "authenticated"` and the first `/api/fgmp/state` response, the shell renders
tenant A's sites, tanks, generators, KPIs and alarms to a tenant-B user. When the earlier session
was SUPERADMIN the stale payload is the **global cross-tenant** snapshot, so the leak spans
tenants the new user has no relationship with at all.

Server-side RLS is untouched by this — the exposure is entirely client-side, which is why no
server test could have caught it.

*Fix:* the snapshot is bound to the identity that fetched it (`snapshotOwner`), cleared the moment
the effective identity changes or disappears, and `AppShell` renders no view until the snapshot it
holds belongs to the current `me.id`.
*Proof:* `src/lib/fgmp/__tests__/store-identity.test.ts`.

#### D-2 · The 5-second state poll runs while unauthenticated — **MEDIUM** — FIXED, VERIFIED
*Brief §6.1 — do not initiate the request when permission is absent.*

`app-shell.tsx` started `setInterval(refresh, 5000)` unconditionally, and `store.refresh()` issued
`fetch("/api/fgmp/state")` with no session at all. A signed-out tab therefore produced **twelve
refused requests a minute, indefinitely** — the 401 storm in the browser console — and kept doing
it while the login dialog was on screen.

*Fix:* the poll is gated on `status === "authenticated"`, and `refresh()`/`init()` now refuse to
issue the request unless `canAccessApi(role, "/api/fgmp/state", "GET")` holds.
*Proof:* `store-identity.test.ts`.

#### D-3 · The state fetch bypassed the capability layer — **MEDIUM** — FIXED, VERIFIED
*Brief §5 — frontend and backend share one authoritative permission definition.*

`store.ts` used a raw `fetch()` for `/api/fgmp/state`, making the single largest tenant-data
response the one request not gated by `canAccessApi`. Latent today (all seven roles hold
`view:dashboard`) but it is precisely the bypass the layer exists to prevent.

*Fix:* the store consults `canAccessApi` before fetching, like `useApi()`.
*Proof:* `store-identity.test.ts`.

#### D-4 · View mutations and timer fetches used raw `fetch()` — **LOW** — FIXED, VERIFIED
*Brief §6 — indirect paths must not reach an unauthorized request.*

Fifteen raw `fetch()` calls under `src/components/**`. Nine were mutations (DELETE tanks /
generators / batteries / dispensers / users / tenants, PUT user, POST dispenser control) that
skipped `localApiDenial()` — the client-side mirror of the capability check — so a stale handler
or a keyboard shortcut reached the server and relied on it alone. Two more were *timer-driven*
reads (`/api/fgmp/health` polling on a countdown, `/api/fgmp/admin/tenant-isolation-test` on a
click) with no capability check at all: the view is nav-gated, but the fetch itself was not, so a
role change mid-session kept polling an endpoint the user had lost.

*Fix:* nine mutations → `apiDelete` / `apiPut` / `apiPost`; the two timer reads → explicit
`canAccessApi` gate. `use-api.ts` was refactored from three copy-pasted bodies into one gated
`apiRequest()`, and `apiPut` added, so a caller cannot choose an ungated path by accident.

The six remaining raw fetches are deliberate and are **not** defects: `/api/fgmp/me`,
`/api/fgmp/preferences` (GET and PUT) and the support-session `DELETE` are on
`AUTH_ONLY_API_RULES` — they gate on *being authenticated*, not on a capability, so there is
nothing for `canAccessApi` to add. `/api/fgmp/platform/support-sessions/current` is guarded by
`canManageSupport` immediately before the call and returned `null` as the `useApi` URL otherwise.
*Proof:* `route-authorization-contract.test.ts` (no unmapped route) plus `grep` — the contract
test is the durable half, because it fails when a *new* raw mutation appears on an unmapped path.

#### D-5 · Nothing proved the policy layer covers the route layer — **HIGH (process)** — FIXED, VERIFIED
*Brief §10 and §14 — every endpoint must have an explicit, tested authorization decision.*

Nothing failed when a new `/api/fgmp/**` route shipped without a capability entry, and nothing
failed when a route called `requireAuth()` **without** the request object — which silently skips
the capability check entirely. Both are fail-open-by-omission, and both would be invisible in
review of a 171-handler surface.

*Fix:* `scripts/verify/route-inventory.ts` walks the filesystem and asserts, for every handler:
(a) it is mapped in the capability policy or deliberately listed in `AUTH_ONLY_API_RULES`;
(b) it passes the request to its guard, unless it is an allowlisted non-session route;
(c) the roles its `ROLES.*` allow-list admits are a **subset** of what the capability policy admits.
*Proof:* `src/lib/fgmp/__tests__/route-authorization-contract.test.ts` — fails with a per-endpoint
message naming the offending route and the missing entry.

---

### 2b. Frontend request & content inventory

Every protected data source, how it is gated **before the request is issued**, and by what.

| Surface | Request(s) | Gate before the request | Server gate |
|---|---|---|---|
| App shell bootstrap | `GET /api/fgmp/state` | `identityKey(me)` + `canAccessApi(role, …, GET)` in `loadState()` | `requireAuth(req)` → `view:dashboard` |
| Dashboard / every view | `GET` per view via `useApi` | `useApi` returns a `null` URL when `canAccessApi` denies → no fetch, no timer | Layer 1 + Layer 2 |
| Notification bell (always mounted) | `GET /api/fgmp/notifications` | `useApi` (all seven roles hold `view:dashboard`) | `view:dashboard` |
| Support banner (always mounted) | `GET …/support-sessions/current` | `canManageSupport ? url : null` | `requireSuperAdmin` |
| System health view | `GET /api/fgmp/health`, 30 s timer | `canAccessApi` at the top of `doFetch` | `view:system-health` |
| Tenant isolation view | `GET /api/fgmp/admin/tenant-isolation-test` | render guard (`SUPERADMIN`) **and** `canAccessApi` in `runTest` | `view:tenant-isolation` |
| Tenant registry view | `GET/POST /api/fgmp/tenants` | nav `view:tenants` + extra `role === SUPERADMIN` filter | `view:tenants` / `tenant:manage` |
| Users view | `GET/POST/PUT/DELETE /api/fgmp/users*` | `useApi` + `apiPut`/`apiDelete` local denial | `view:users` / `user:manage` |
| Asset registry / dispensers | `GET` via `useApi`; DELETE via `apiDelete` | nav + `apiDelete` local denial | `view:*` / `asset:manage` |
| Edge firmware | PATCH `apiPatch`, POST `apiPost` | local denial per verb | `edge:manage` / `dispenser:control` |
| Shift handover | `GET` via `useApi`; POST `apiPost`, DELETE `apiDelete` | local denial | `view:dashboard` / `ticket:manage` / `settings:manage` |
| Command palette | no fetch — filters the same `NAV` by capability | `hasCapability` | n/a |
| Realtime | `GET /api/fgmp/realtime/channel` | `useRealtime({ enabled: status === "authenticated" })` | `requireAuth` |
| Login | `POST /api/auth/callback/credentials` | n/a — this *is* the auth boundary | rate-limited, lockout, demo-password policy |

**Content.** Views are mounted only when `hasCapability(role, "view:<key>")`; the URL is rewritten
to `dashboard` when it is not, so a direct link to `/?view=tenants` as a READONLY user never
mounts the component. No protected payload is serialised into HTML or an RSC payload: the shell is
`"use client"` with `dynamic(..., { ssr: false })` view imports, and every protected fetch happens
after `me` resolves.

---

### 3. Audited and found sound (evidence, not opinion)

| # | Requirement | Evidence |
|---|---|---|
| A-1 | Every session route maps to a capability, or is deliberately role-agnostic | D-5 test; 107 routes enumerated |
| A-2 | No route calls `requireAuth()` bare, skipping Layer 2 | D-5 test — one call site, `/api/fgmp/mfa/status`, which is on the auth-only list and holds no tenant data |
| A-3 | Two-layer drift | **zero** divergences over 171 handlers |
| A-4 | The preview overlay cannot escalate | `role-preview.ts`: HMAC-signed, `sub`-bound to the session user, 15-min TTL, `PREVIEW_ROLES` excludes SUPERADMIN; `requireAuth` re-checks the *current DB role* before honouring the cookie |
| A-5 | A tenant admin cannot touch a SUPERADMIN account | `users/[id]/route.ts: assertCanAdminister()`; the platform-role bypass applies only to SUPERADMIN callers |
| A-6 | Self-grant, last-admin and last-superadmin are blocked | `grant-guards.ts`, called from `users/[id]` PUT and DELETE |
| A-7 | Cross-tenant read needs a live support session | `platform/support/[tenant]/summary` → `currentSupport()` → `assertSupportTenant()`; the id in the path is a claim that must match, never a scope that widens |
| A-8 | Tenant registry and isolation views | SUPERADMIN-only in the matrix **and** an extra role filter in `app-shell` |
| A-9 | Deployment secrets | `/realtime/snapshot` requires `REALTIME_SERVICE_TOKEN` (≥16 chars, no default) and is not browser-facing; `/iot/ingest` requires a per-tenant API key |
| A-10 | Login is not an account-existence oracle | constant-time dummy-hash comparison on every failure path; the demo-credential refusal returns the same `null` |
| A-11 | Session revocation is immediate | `getSessionState()` on every request — `active=false`, a role change and a `sessionEpoch` bump all apply on the next request |
| A-12 | No privileged fallback in the request path | `resolveOwnerDbUrl()` prefers `FGMP_OPS_/FGMP_MIGRATE_DATABASE_URL` and falls back **downward** to `DATABASE_URL` (`fgmp_app`), never upward |

---

### 4. Open, blocked, and awaiting a decision

| # | Item | Status | Why |
|---|---|---|---|
| B-1 | DB-backed end-to-end authorization matrix (real sessions, real rows) | BLOCKED | The Prisma client cannot be generated here (`binaries.prisma.sh` unreachable) and there is no PostgreSQL instance in this sandbox. `scripts/verify/authz-live.ts` implements it and refuses to pretend to pass: it exits with a loud SKIP unless `FGMP_BASE_URL` and `FGMP_TEST_DB` are set. |
| B-2 | Playwright browser network-assertion suite | BLOCKED | No Playwright dependency and no browser binary. The request-gating assertions that do not need a browser are covered against the real store in `store-identity.test.ts`; the in-browser half is specified in `docs/AUTHZ.md` §Verification. |
| B-3 | Should `EXECUTIVE` hold `view:maintenance` and `view:iot`? | DECISION | Both were added by an earlier phase to fix a real inversion (an executive could read a national KPI but not trace it to the site behind it). No business rule in the repository settles whether an executive may read maintenance tickets. **Not changed** — flagged rather than guessed. |
| B-4 | Should `DELETE /suppressions/[id]` be ADMIN-only? | DECISION | Both layers currently require `settings:manage` (ADMIN) and agree. A NOC operator arguably needs to lift a suppression they themselves set, but changing it would *widen* access, so it is left alone pending a decision. |

---

### 5. Capability inventory (47 capabilities × 7 roles, as implemented)

| Capability | SA | AD | NOC | REG | FLD | EXE | RO |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `alarm:ack` | ✔ | ✔ | ✔ | ✔ | · | · | · |
| `alarm:configure` | ✔ | ✔ | · | ✔ | · | · | · |
| `alarm:resolve` | ✔ | ✔ | ✔ | · | · | · | · |
| `alarm:suppress` | ✔ | ✔ | ✔ | ✔ | · | · | · |
| `api-key:manage` | ✔ | ✔ | · | · | · | · | · |
| `asset:manage` | ✔ | ✔ | · | · | · | · | · |
| `delivery:approve` | ✔ | ✔ | · | ✔ | · | · | · |
| `delivery:manage` | ✔ | ✔ | · | ✔ | ✔ | · | · |
| `delivery:verify` | ✔ | ✔ | ✔ | · | ✔ | · | · |
| `dispenser:control` | ✔ | ✔ | ✔ | · | ✔ | · | · |
| `edge:manage` | ✔ | ✔ | · | · | · | · | · |
| `gen:control` | ✔ | ✔ | ✔ | · | · | · | · |
| `geography:manage` | ✔ | ✔ | · | · | · | · | · |
| `notification:manage` | ✔ | ✔ | ✔ | · | · | · | · |
| `role:preview` | ✔ | ✔ | · | · | · | · | · |
| `settings:manage` | ✔ | ✔ | · | · | · | · | · |
| `simul:tick` | ✔ | ✔ | ✔ | ✔ | · | · | · |
| `ticket:assign` | ✔ | ✔ | · | ✔ | · | · | · |
| `ticket:complete` | ✔ | ✔ | · | · | ✔ | · | · |
| `ticket:create` | ✔ | ✔ | ✔ | ✔ | · | · | · |
| `ticket:manage` | ✔ | ✔ | · | ✔ | ✔ | · | · |
| `user:manage` | ✔ | ✔ | · | · | · | · | · |
| `view:alarms` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `view:analytics` | ✔ | ✔ | · | ✔ | · | ✔ | ✔ |
| `view:api-keys` | ✔ | ✔ | · | · | · | · | · |
| `view:asset-registry` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `view:audit` | ✔ | ✔ | ✔ | ✔ | · | · | ✔ |
| `view:batteries` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `view:consumption-patterns` | ✔ | ✔ | ✔ | ✔ | · | ✔ | ✔ |
| `view:dashboard` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `view:dispensers` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `view:edge-firmware` | ✔ | ✔ | ✔ | ✔ | ✔ | · | ✔ |
| `view:fuel` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `view:fuel-forecast` | ✔ | ✔ | ✔ | ✔ | · | ✔ | ✔ |
| `view:generators` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `view:geography` | ✔ | ✔ | · | · | · | · | · |
| `view:inventory` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `view:iot` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `view:maintenance` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `view:preferences` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `view:reports` | ✔ | ✔ | · | ✔ | · | ✔ | ✔ |
| `view:roles` | ✔ | ✔ | · | · | · | · | · |
| `view:sites` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `view:suppressions` | ✔ | ✔ | ✔ | ✔ | ✔ | · | ✔ |
| `view:system-health` | ✔ | ✔ | · | · | · | · | · |
| `view:system-settings` | ✔ | ✔ | · | · | · | · | · |
| `view:users` | ✔ | ✔ | · | · | · | · | · |

47 capabilities, 7 roles. SA holds "*" and therefore every row.

Reading it: `SA` holds `"*"`, so every row is ✔ by construction. The interesting columns are
`AD` … `RO`, which are literal allow-lists. Mapping of the brief's illustrative groups onto what
actually exists:

| Brief's example | FGMP1 reality |
|---|---|
| `assets.read` | `view:sites`, `view:fuel`, `view:generators`, `view:batteries`, `view:inventory`, `view:asset-registry` |
| `assets.create` / `.update` / `.delete` | `asset:manage`, `geography:manage`, `edge:manage`, `dispenser:control`, `gen:control` |
| `reports.read` | `view:reports`, `view:analytics`, `view:consumption-patterns`, `view:fuel-forecast` |
| `reports.export` | no separate capability — export is authorized by the **data view** it exports (`apiReadCapabilities` maps `/api/fgmp/export?type=` per type) |
| `users.manage` | `user:manage` |
| `roles.manage` | none, deliberately — there is no roles API. Role changes go through `users` (`user:manage`) and are further constrained by `grant-guards.ts` |
| `permissions.manage` | none, and it should not exist: the matrix is code, so "editing permissions" would mean deploying. There is no runtime surface to protect |

---

### 6. Files changed

No migration, no schema change, no data change, no new environment variable.
`git diff --stat 424ed2c` = **14 files changed, 308 insertions(+), 145 deletions(-)**, plus 6 new
files.

**Changed**

| File | Why |
|---|---|
| `src/lib/fgmp/store.ts` | D-1/D-2/D-3 — identity-bound snapshot, `identityKey()`, gated `loadState()` with supersede checks |
| `src/components/fgmp/app-shell.tsx` | D-1 — no view renders before `me` resolves; `init()` waits for the identity |
| `src/lib/fgmp/use-api.ts` | D-4 — one gated `apiRequest()`, adds `apiPut`, removes three copy-pasted bodies |
| `src/components/fgmp/views/{asset-registry,dispensers,users,tenants,edge-firmware,system-health,tenant-isolation}-view.tsx` | D-4 — raw mutations → `apiDelete` / `apiPut` / `apiPost`; timer fetches gated |
| `src/components/fgmp/shift-handover-panel.tsx` | D-4 — DELETE → `apiDelete` |
| `src/lib/fgmp/rbac-core.ts` | D-5 — export `AUTH_ONLY_API_RULES`; named `NO_SESSION_ROLE` sentinel |
| `src/app/api/fgmp/mfa/status/route.ts` | D-5 — pass the request so Layer 1 runs |
| `package.json` | `test:authz`, `test:authz:live` |

**Added**

| File | What |
|---|---|
| `TASK_LEDGER.md` | this file |
| `docs/AUTHZ.md` | the model, the client-side contract, verification, rollback |
| `scripts/verify/route-inventory.ts` | static authorization-contract analyser + CLI |
| `scripts/verify/authz-live.ts` | real-session end-to-end matrix (needs a live deployment) |
| `src/lib/fgmp/__tests__/store-identity.test.ts` | 16 tests — D-1/D-2/D-3 |
| `src/lib/fgmp/__tests__/route-authorization-contract.test.ts` | 23 tests — D-5 |

---

### 7. Command results

| Command | Result |
|---|---|
| `bun test` (before) | 831 pass / 13 skip / **16 fail** / 860 tests |
| `bun test` (after) | **870 pass / 13 skip / 16 fail / 899 tests** — +39 tests, same 16 environmental failures |
| `bun run test:authz` | **60 pass / 0 fail / 302 expect()** across the four authorization suites |
| `bun run scripts/verify/route-inventory.ts` | `Authorization contract: OK` — 171 handlers, 107 route files — **0 violations** |
| `npx tsc --noEmit` | 515 errors, **all** pre-existing and caused by the ungenerated Prisma client (`Prisma.Decimal`, `Prisma.raw`, `OtaStatus`, and everything typed `unknown` as a consequence). **Zero** in any file touched here — verified by filtering the output for each changed path. |
| `npx eslint <changed files>` | **13 errors, identical before and after** (measured by stashing the work and re-running): all `react-hooks/set-state-in-effect` / `react-hooks/incompatible-library` in dialogs that pre-date this task. **Zero new.** |
| `bun run scripts/verify/authz-live.ts` | exit **2** — refuses to run without `FGMP_BASE_URL` rather than printing a false pass |

#### Negative controls (a test that cannot fail is theatre)

| Fix | Test disabled | Result |
|---|---|---|
| D-1 identity binding | `setMe` reverted to `set({ me })` | 3 tests fail |
| D-2/D-3 request gating | capability/identity guard disabled | 2 tests fail |
| arrival-order guard | the three `if (identityKey(...) !== requestedFor) return` removed | 1 test fails |
| D-5 contract | a `/api/fgmp/zz-temp-probe` route added that calls bare `requireAuth()` | **4 tests fail** + CLI exits 1 with `UNMAPPED_ENDPOINT` |

---

### Appendix A — Endpoint authorization inventory (mechanical, 171 handlers)

Generated by `bun run scripts/verify/route-inventory.ts`. **"Roles passing BOTH layers"** is the
effective gate: the intersection of the route's own allow-list and the capability policy.

| Endpoint | Guard | Capability policy | Roles passing BOTH layers |
|---|---|---|---|
| `GET /auth/[...nextauth]` | none **⚠** | **UNMAPPED** | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /auth/[...nextauth]` | none **⚠** | **UNMAPPED** | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/admin/tenant-isolation-test` | requireAuth | `view:tenant-isolation` | SUPERADMIN |
| `GET /fgmp/alarms/[id]` | requireAuth | `view:alarms` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/alarms` | requireAuth | `view:alarms` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/alarms` | requireRole | `alarm:ack`<br>`alarm:resolve` | ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, SUPERADMIN |
| `GET /fgmp/analytics` | requireAuth | `view:analytics` | SUPERADMIN, ADMIN, REGIONAL_MANAGER, EXECUTIVE, READONLY |
| `GET /fgmp/api-keys/[id]` | requireRole | `view:api-keys` | ADMIN, SUPERADMIN |
| `PATCH /fgmp/api-keys/[id]` | requireRole | `api-key:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/api-keys` | requireRole | `view:api-keys` | SUPERADMIN, ADMIN |
| `POST /fgmp/api-keys` | requireRole | `api-key:manage` | SUPERADMIN, ADMIN |
| `GET /fgmp/api-keys/stats` | requireRole | `view:api-keys` | SUPERADMIN, ADMIN |
| `GET /fgmp/audit` | requireAuth | `view:audit` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, READONLY |
| `GET /fgmp/batteries/[id]` | requireAuth | `view:batteries` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `PATCH /fgmp/batteries/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `DELETE /fgmp/batteries/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/batteries` | requireAuth | `view:batteries` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/batteries` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `POST /fgmp/correlation/evaluate` | requireRole | `alarm:configure` | ADMIN, REGIONAL_MANAGER, SUPERADMIN |
| `GET /fgmp/correlation/matches` | requireAuth | `alarm:configure` | SUPERADMIN, ADMIN, REGIONAL_MANAGER |
| `PATCH /fgmp/correlation/rules/[id]` | requireRole | `alarm:configure` | ADMIN, REGIONAL_MANAGER, SUPERADMIN |
| `DELETE /fgmp/correlation/rules/[id]` | requireRole | `alarm:configure` | ADMIN, REGIONAL_MANAGER, SUPERADMIN |
| `GET /fgmp/correlation/rules` | requireAuth | `alarm:configure` | SUPERADMIN, ADMIN, REGIONAL_MANAGER |
| `POST /fgmp/correlation/rules` | requireRole | `alarm:configure` | ADMIN, REGIONAL_MANAGER, SUPERADMIN |
| `POST /fgmp/deliveries/[id]/cancel` | requireRole | `delivery:manage` | ADMIN, REGIONAL_MANAGER, FIELD_ENGINEER, SUPERADMIN |
| `POST /fgmp/deliveries/[id]/deliver` | requireRole | `delivery:manage` | ADMIN, REGIONAL_MANAGER, FIELD_ENGINEER, SUPERADMIN |
| `GET /fgmp/deliveries/[id]` | requireAuth | `view:inventory` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/deliveries` | requireAuth | `view:inventory` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/deliveries` | requireRole | `delivery:manage` | ADMIN, REGIONAL_MANAGER, FIELD_ENGINEER, SUPERADMIN |
| `GET /fgmp/dispensers/[id]/commands` | requireAuth | `view:dispensers` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/dispensers/[id]/control` | requireRole | `dispenser:control` | ADMIN, NOC_OPERATOR, SUPERADMIN |
| `GET /fgmp/dispensers/[id]` | requireAuth | `view:dispensers` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `PATCH /fgmp/dispensers/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `DELETE /fgmp/dispensers/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/dispensers/reports` | requireAuth | `view:dispensers` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/dispensers` | requireAuth | `view:dispensers` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/dispensers` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/dispensers/transactions` | requireAuth | `view:dispensers` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/edge/esp/[dispenserId]/reboot` | requireRole | `dispenser:control` | ADMIN, NOC_OPERATOR, FIELD_ENGINEER, SUPERADMIN |
| `DELETE /fgmp/edge/firmware/[id]` | requireRole | `platform:firmware` | SUPERADMIN |
| `POST /fgmp/edge/firmware/deploy` | requireRole | `dispenser:control` | ADMIN, NOC_OPERATOR, FIELD_ENGINEER, SUPERADMIN |
| `GET /fgmp/edge/firmware/deployments` | requireAuth | `view:edge-firmware` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, READONLY |
| `GET /fgmp/edge/firmware` | requireAuth | `view:edge-firmware` | ADMIN, SUPERADMIN |
| `POST /fgmp/edge/firmware` | requireRole | `platform:firmware` | SUPERADMIN |
| `POST /fgmp/edge/gateways/[id]` | requireRole | `edge:manage` | ADMIN, SUPERADMIN |
| `PATCH /fgmp/edge/gateways/[id]` | requireRole | `edge:manage` | ADMIN, SUPERADMIN |
| `DELETE /fgmp/edge/gateways/[id]` | requireRole | `edge:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/edge/gateways` | requireAuth | `view:edge-firmware` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, READONLY |
| `GET /fgmp/edge/rs485` | requireAuth | `view:edge-firmware` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, READONLY |
| `GET /fgmp/export` | requireAuth | `view:sites`<br>`view:reports`<br>`view:iot`<br>`view:inventory` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/forecast` | requireAuth | `view:fuel-forecast` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, EXECUTIVE, READONLY |
| `GET /fgmp/fuel/runout-eta` | requireAuth | `view:dashboard`<br>`view:fuel-forecast` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/generators/[id]/control/[commandId]` | requireRole | `gen:control` | ADMIN, NOC_OPERATOR, SUPERADMIN |
| `POST /fgmp/generators/[id]/control` | requireRole | `gen:control`<br>`asset:manage` | ADMIN, NOC_OPERATOR, SUPERADMIN |
| `GET /fgmp/generators/[id]` | requireAuth | `view:generators` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `PATCH /fgmp/generators/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `DELETE /fgmp/generators/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/generators` | requireAuth | `view:generators` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/generators` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `PATCH /fgmp/geography/districts/[id]` | requireRole | `geography:manage` | ADMIN, SUPERADMIN |
| `DELETE /fgmp/geography/districts/[id]` | requireRole | `geography:manage` | ADMIN, SUPERADMIN |
| `POST /fgmp/geography/districts` | requireRole | `geography:manage` | SUPERADMIN, ADMIN |
| `PATCH /fgmp/geography/governorates/[id]` | requireRole | `geography:manage` | ADMIN, SUPERADMIN |
| `DELETE /fgmp/geography/governorates/[id]` | requireRole | `geography:manage` | ADMIN, SUPERADMIN |
| `POST /fgmp/geography/governorates` | requireRole | `geography:manage` | SUPERADMIN, ADMIN |
| `PATCH /fgmp/geography/regions/[id]` | requireRole | `geography:manage` | ADMIN, SUPERADMIN |
| `DELETE /fgmp/geography/regions/[id]` | requireRole | `geography:manage` | ADMIN, SUPERADMIN |
| `POST /fgmp/geography/regions` | requireRole | `geography:manage` | SUPERADMIN, ADMIN |
| `GET /fgmp/geography` | requireAuth | `view:geography` | SUPERADMIN, ADMIN |
| `GET /fgmp/health` | requireRole | `view:system-health` | ADMIN, SUPERADMIN |
| `GET /fgmp/history/[entityId]` | requireAuth | `view:sites`<br>`view:fuel`<br>`view:generators`<br>`view:batteries`<br>`view:asset-registry` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/interlocks/thresholds/[id]` | requireAuth | `view:system-settings` | SUPERADMIN, ADMIN |
| `PATCH /fgmp/interlocks/thresholds/[id]` | requireRole | `settings:manage` | ADMIN, SUPERADMIN |
| `DELETE /fgmp/interlocks/thresholds/[id]` | requireRole | `settings:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/interlocks/thresholds` | requireAuth | `view:system-settings` | SUPERADMIN, ADMIN |
| `POST /fgmp/interlocks/thresholds` | requireRole | `settings:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/iot/[id]/ota-status` | requireAuth | `view:iot` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/iot/ingest` | none **⚠** | NO_SESSION_ROLE | — |
| `POST /fgmp/iot/ingest` | service/api-key **⚠** | NO_SESSION_ROLE | — |
| `GET /fgmp/iot` | requireAuth | `view:iot` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/iot` | requireRole | `edge:manage` | ADMIN, SUPERADMIN |
| `PATCH /fgmp/iot` | requireRole | `edge:manage` | ADMIN, SUPERADMIN |
| `POST /fgmp/maintenance/[id]/assign` | requireRole | `ticket:manage` | ADMIN, REGIONAL_MANAGER, FIELD_ENGINEER, SUPERADMIN |
| `POST /fgmp/maintenance/[id]/progress` | requireRole | `ticket:manage` | ADMIN, REGIONAL_MANAGER, FIELD_ENGINEER, SUPERADMIN |
| `GET /fgmp/maintenance/[id]` | requireAuth | `view:maintenance` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/maintenance` | requireAuth | `view:maintenance` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/maintenance` | requireRole | `ticket:manage` | ADMIN, REGIONAL_MANAGER, FIELD_ENGINEER, SUPERADMIN |
| `POST /fgmp/me/preview-role` | requireAuth | `role:preview` | SUPERADMIN, ADMIN |
| `DELETE /fgmp/me/preview-role` | requireAuth | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/me` | requireRole | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/metrics` | requireRole | `alarm:ack` | ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, SUPERADMIN |
| `POST /fgmp/mfa/challenge-request` | requireAuth | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/mfa/challenge` | none **⚠** | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/mfa/disable` | requireAuth | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/mfa/enrol` | requireAuth | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/mfa/reset` | requireRole | `user:manage` | SUPERADMIN, ADMIN |
| `GET /fgmp/mfa/status` | requireAuth | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/mfa/verify-enrol` | requireAuth | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/notifications` | requireAuth | `view:dashboard` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/notifications` | requireRole | `notification:manage` | ADMIN, NOC_OPERATOR, SUPERADMIN |
| `GET /fgmp/ops/alerts/preview` | requireRole | `alarm:ack` | ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, SUPERADMIN |
| `GET /fgmp/patterns` | requireAuth | `view:consumption-patterns` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, EXECUTIVE, READONLY |
| `GET /fgmp/platform/audit` | requireSuperAdmin | `view:tenants` | SUPERADMIN |
| `GET /fgmp/platform/grants` | requireSuperAdmin | `view:tenants` | SUPERADMIN |
| `GET /fgmp/platform/support-sessions/[id]` | requireSuperAdmin | `view:tenants` | SUPERADMIN |
| `DELETE /fgmp/platform/support-sessions/[id]` | requireSuperAdmin | `tenant:manage` | SUPERADMIN |
| `GET /fgmp/platform/support-sessions/current` | requireSuperAdmin | `view:tenants` | SUPERADMIN |
| `DELETE /fgmp/platform/support-sessions/current` | requireSuperAdmin | `tenant:manage` | SUPERADMIN |
| `GET /fgmp/platform/support-sessions` | requireSuperAdmin | `view:tenants` | SUPERADMIN |
| `POST /fgmp/platform/support-sessions` | requireSuperAdmin | `tenant:manage` | SUPERADMIN |
| `DELETE /fgmp/platform/support-sessions` | requireSuperAdmin | `tenant:manage` | SUPERADMIN |
| `GET /fgmp/platform/support/[tenant]/summary` | requireSuperAdmin | `view:tenants` | SUPERADMIN |
| `POST /fgmp/platform/support/[tenant]/summary` | requireSuperAdmin | `tenant:manage` | SUPERADMIN |
| `GET /fgmp/preferences/[userId]` | requireRole | `view:users` | ADMIN, SUPERADMIN |
| `PUT /fgmp/preferences/[userId]` | requireRole | `user:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/preferences` | requireAuth | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `PUT /fgmp/preferences` | requireAuth | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/proposal` | requireAuth | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/realtime/auth` | requireAuth | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/realtime/channel` | requireAuth | auth-only | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /fgmp/realtime/snapshot` | service/api-key **⚠** | NO_SESSION_ROLE | — |
| `GET /fgmp/reports` | requireAuth | `view:reports`<br>`view:generators` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/seed` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/settings` | requireAuth | `view:system-settings` | SUPERADMIN, ADMIN |
| `PATCH /fgmp/settings` | requireRole | `settings:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/shift-handover/[id]` | requireAuth | `view:dashboard` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `PATCH /fgmp/shift-handover/[id]` | requireRole | `alarm:ack`<br>`delivery:manage`<br>`ticket:manage` | ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, SUPERADMIN |
| `DELETE /fgmp/shift-handover/[id]` | requireRole | `settings:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/shift-handover` | requireAuth | `view:dashboard` | ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, SUPERADMIN |
| `POST /fgmp/shift-handover` | requireRole | `alarm:ack`<br>`delivery:manage`<br>`ticket:manage` | ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, SUPERADMIN |
| `GET /fgmp/sites/[id]` | requireAuth | `view:sites` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `PATCH /fgmp/sites/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `DELETE /fgmp/sites/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/sites` | requireAuth | `view:sites` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/sites` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/solar-arrays/[id]` | requireAuth | `view:sites`<br>`view:asset-registry` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `PATCH /fgmp/solar-arrays/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `DELETE /fgmp/solar-arrays/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/solar-arrays` | requireAuth | `view:sites`<br>`view:asset-registry` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/solar-arrays` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/solar-sites/[id]` | requireAuth | `view:sites`<br>`view:asset-registry` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `PATCH /fgmp/solar-sites/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `DELETE /fgmp/solar-sites/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/solar-sites` | requireAuth | `view:sites`<br>`view:asset-registry` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/solar-sites` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/state` | requireAuth | `view:dashboard` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `PATCH /fgmp/suppressions/[id]` | requireRole | `alarm:suppress` | ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, SUPERADMIN |
| `DELETE /fgmp/suppressions/[id]` | requireRole | `settings:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/suppressions` | requireAuth | `view:suppressions` | ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, SUPERADMIN |
| `POST /fgmp/suppressions` | requireRole | `alarm:suppress` | ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, SUPERADMIN |
| `GET /fgmp/tanks/[id]` | requireAuth | `view:fuel`<br>`view:inventory` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `PATCH /fgmp/tanks/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `DELETE /fgmp/tanks/[id]` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/tanks` | requireAuth | `view:fuel`<br>`view:inventory` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `POST /fgmp/tanks` | requireRole | `asset:manage` | ADMIN, SUPERADMIN |
| `GET /fgmp/tenants/[id]` | requireAuth | `view:tenants` | SUPERADMIN |
| `PATCH /fgmp/tenants/[id]` | requireRole | `tenant:manage` | SUPERADMIN |
| `DELETE /fgmp/tenants/[id]` | requireRole | `tenant:manage` | SUPERADMIN |
| `GET /fgmp/tenants` | requireAuth | `view:tenants` | SUPERADMIN |
| `POST /fgmp/tenants` | requireRole | `tenant:manage` | SUPERADMIN |
| `GET /fgmp/tick` | requireAuth | `simul:tick` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER |
| `POST /fgmp/tick` | requireAuth | `simul:tick` | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER |
| `POST /fgmp/users/[id]/reset-password` | requireRole | `user:manage` | SUPERADMIN, ADMIN |
| `GET /fgmp/users/[id]` | requireRole | `view:users` | SUPERADMIN, ADMIN |
| `PUT /fgmp/users/[id]` | requireRole | `user:manage` | SUPERADMIN, ADMIN |
| `PATCH /fgmp/users/[id]` | requireRole | `user:manage` | SUPERADMIN, ADMIN |
| `DELETE /fgmp/users/[id]` | requireRole | `user:manage` | SUPERADMIN, ADMIN |
| `GET /fgmp/users` | requireRole | `view:users` | SUPERADMIN, ADMIN |
| `POST /fgmp/users` | requireRole | `user:manage` | SUPERADMIN, ADMIN |
| `GET /health/live` | none **⚠** | **UNMAPPED** | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |
| `GET /health/ready` | none **⚠** | **UNMAPPED** | SUPERADMIN, ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER, EXECUTIVE, READONLY |

171 handlers.
