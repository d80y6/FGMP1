# TASK_LEDGER

This file is durable across agent sessions and context limits. It holds **four** task records: three
complete, one in progress. Read the part for the task you are resuming; do not delete a part when
you finish a new task — add one.

| Part | Task | Outcome |
|---|---|---|
| [A](#part-a--postgresql-connection-assessment) | PostgreSQL connection assessment (pooling, runtime, Hyperdrive eligibility) | Complete except Phase 7a/7b, blocked on a live provider |
| [B](#part-b--rbac-api-authorization-and-ui-enforcement) | RBAC, API authorization, UI permission enforcement | Complete; 4 defects fixed and verified, 2 blocked, 2 decisions open |
| [C](#part-c--hosted-supabase-provisioning) | Hosted (Supabase/Neon/RDS) provisioning path | Defect fixed and verified as a non-superuser; CI gate added; 2 operator findings |
| [D](#part-d--uiux-audit-and-remediation) | UI/UX audit, remediation and browser verification | Shell defects fixed and proven by a real Chromium run; authenticated views blocked in-sandbox, covered by CI |

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
- [ ] Phase 7 — validate effective production/staging provider configuration and perform a staged rollout/rollback. Blocked: no live provider, **Cloudflare** environment, or authorized metrics scrape is available. *(Amended 2026-10-25: this line said "Render environment"; Render was retired in D-18 and Cloudflare Workers is the only target. The blocker itself is unchanged — no credentials for any provider are available to this audit.)*

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

#### D-2 · `store.init()/refresh()` issued the state request with no session check of their own — **MEDIUM** — FIXED, VERIFIED
*Brief §6.1 — do not initiate the request when permission is absent.*

**Precisely what was and was not true.** At `424ed2c` the AppShell poll was **already** gated on
`status === "authenticated"`, and `useRealtime` on the same condition. So no *currently reachable*
path in this commit fired the request without a session — the 401 storm observed in the browser
console came from an older deployed build whose `setInterval` had no such check. That is evidence
for the failure mode, not a claim about this tree.

The defect here is narrower and still real: the guard lived entirely in the **callers**.
`store.refresh()` and `store.init()` are public Zustand actions that fetch `/api/fgmp/state` with
no identity or capability check whatsoever, so correctness depended on every present and future
caller remembering to gate first — `sites-view` pulls `refresh` straight out of the store, and
`use-realtime` holds a reference to it, which is exactly how such a guard gets lost.

*Fix:* both actions now refuse to issue the request unless `identityKey(me)` is resolved **and**
`canAccessApi(role, "/api/fgmp/state", "GET")` holds.
*Proof:* `store-identity.test.ts` — "no session ⇒ no request at all", "a role that cannot read
view:dashboard ⇒ no request"; verified by disabling the guard and watching both fail.

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

### 5b. Role assignments: none changed, and why that is the finding

The brief asks for corrected role assignments with justification. **Nothing was granted, revoked,
or moved between roles in this task**, and that is a conclusion rather than an omission:

- Every capability in `ROLE_PERMISSIONS` already mapped to a route that permits it and to a view
  that renders it. The drift detector (§3 A-3) found no route whose allow-list disagreed with its
  policy, in either direction.
- No route needed a new capability to work. Nothing here was "granted so the page loads".
- The two assignments that *look* questionable from the outside — `EXECUTIVE` holding
  `view:maintenance`/`view:iot`, and `DELETE /suppressions/[id]` being ADMIN-only — are both cases
  where changing them would **widen** access on the strength of a guess. They are recorded as
  open decisions (B-3, B-4), not silently altered. The brief's rule is explicit: never resolve an
  ambiguous entitlement by granting.
- No role was given the wildcard, and `SUPERADMIN` remains the only holder (asserted by a test).

What *did* change is where the client asks: the browser now refuses to issue a request the
effective role could not make, and the guards are covered by tests that fail when they regress.
The permission model is unchanged; its enforcement is not.

---

## 6. Files changed

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

## Part C — Hosted (Supabase) provisioning

**Branch** `arena/592458ff-fgmp1` · **Base** `8b51e3a` (merge of PR #17) · owner: agent

The `scripts/supabase/01-roles.sql → 04-verify.sql` chain is the path a customer runs against a
managed PostgreSQL (Supabase, Neon, RDS) where Prisma's engine cannot be used. It had never been
executed against the role a hosted provider actually gives you — the database owner, which on
Supabase is `postgres`: `CREATEROLE` + `BYPASSRLS`, **not** `SUPERUSER`. It failed on the first
statement of consequence.

### 1. The defect

| | |
|---|---|
| **Symptom** (reported from the real deploy) | `psql -v ON_ERROR_STOP=1 -f 01-roles.sql` → `ERROR: permission denied to change default privileges`, line 117 |
| **Consequence** | 02 then fails on `set role fgmp_migrate`, 04 fails on `set local role fgmp_app`. The half-applied run leaves `CHANGE_ME_*` passwords in place, so the app cannot connect either. |
| **Root cause** | `ALTER DEFAULT PRIVILEGES … FOR ROLE fgmp_migrate` requires **USAGE** on that role. A non-superuser that merely *creates* a role receives ADMIN, not membership — and `SET ROLE` alone is not enough for a default-privileges check. |
| **Fix** | `grant fgmp_app, fgmp_ops, fgmp_migrate to current_user with inherit true, set true;` — `INHERIT` is the part that matters. `with inherit false` reproduces the exact production error while `set role` still succeeds, which is why the first attempt looked correct. |
| **Failure mode removed** | `01` now ends with a `pg_has_role(…, 'set')`/`'usage'` report and raises if `fgmp_migrate` cannot be assumed. The next failure, if any, is a sentence that names the cause. |
| **Also fixed** | A literal `postgres` role inside a `DO` block → `role "postgres" does not exist` on any cluster whose superuser is named otherwise (`undefined_object`, so an `insufficient_privilege` handler does not catch it). Now `current_user` + `format(%I)`. |

Status: **VERIFIED** (see §3) — reproduced first, then fixed, then proven by a negative control.

### 2. Why it reached a customer

Nothing ran these files. CI's `rls` job provisions the *docker* path (`scripts/db/pg-init-roles.sql`
+ `prisma migrate deploy`) as a superuser — a different set of statements, executed with privileges
the hosted path does not have. The two paths could disagree indefinitely, and did.

### 3. Proof

`scripts/verify/supabase-provisioning.ts` (`bun run test:provisioning`) reproduces the hosted shape
end to end: it creates a **non-superuser** `CREATEROLE BYPASSRLS` role, gives it a database it owns,
runs `01 → 04` as that role, and asserts 22 things — including that the running role is *not* a
superuser, that default privileges are actually recorded (2 rows for `fgmp_migrate`), that `01`
re-runs silently (idempotent), and that `fgmp_app` still sees `0 sites with no tenant context` and
`cannot create tables` afterwards.

| Run | Result |
|---|---|
| Fixed `01-roles.sql` | `Provisioning contract: OK — the hosted/admin path works as a non-superuser.` — **22 ✓, exit 0** |
| Pre-fix `01-roles.sql` (negative control) | **15 assertions failed, exit 1** — the harness is not passing by accident |
| Chain output as a non-superuser | `45 tables, 40 with FORCE RLS, 55 policies`; `2 tenants, 6 users, 8 sites, 8 tanks, 8 generators, 8 dispensers, 5 alarms, 12 fuel transactions`; `FGMP deployment verified.` |

The harness exits **2**, not 0, when the cluster already holds the FGMP roles in another database:
a "first run" that is really a re-run measures a different scenario, and pretending otherwise would
be a green tick on the wrong fact.

CI now has a `provisioning` job that runs exactly this against `postgres:17` (plain PostgreSQL — the
schema's Timescale block is commented out and the hosted path must work on stock PG).

### 4. Two things an operator must do that the scripts cannot

1. **`FGMP_OPS_DATABASE_URL` is required for sign-in.** The email → user lookup cannot be
   tenant-scoped, so it cannot run as `fgmp_app`; `"User"` is `FORCE ROW LEVEL SECURITY` and an
   unscoped `SELECT` matches zero rows. Without an ops credential every login returns **401** —
   with no server error and nothing in the response to distinguish it from a wrong password.
   `src/lib/auth-identity.ts` had claimed since the 2026-10 fix that "the boot-time warning in
   `src/lib/env.ts` tells the operator why". There was no such check. There is now: an **error**
   in production (the server refuses to start with a message that names the cause), a warning
   elsewhere, and `FGMP_MIGRATE_DATABASE_URL` is accepted as a substitute — which is what
   `owner-db.ts` already does at runtime. Three tests in `src/lib/env.test.ts`; two of them fail
   against the previous `env.ts` (checked by restoring it and re-running).
2. **Rotate the passwords.** `01-roles.sql` creates roles with `CHANGE_ME_*` literals and does not
   rotate them, and the seeders publish demo account passwords in this repository. Leaving both is
   how a deployment becomes reachable with credentials anyone can read. Rotation SQL is in
   `scripts/supabase/README.md`.

### 5. What changed

- `scripts/supabase/01-roles.sql` — membership block; default privileges via `current_user` +
  `format(%I)`; guarded; fatal if the migration role cannot be assumed.
- `scripts/supabase/README.md` — run-as table (each file, and as whom), the `ADMIN_URL` warning,
  `set role fgmp_ops;` for the seed, expected NOTICE output, rotation SQL. A stale bullet claiming
  the seed "keeps working only because it runs as a superuser" was corrected: it runs as `fgmp_ops`
  (`BYPASSRLS`), and `FORCE RLS` is precisely why ownership does not help.
- `scripts/verify/supabase-provisioning.ts` — new.
- `.github/workflows/ci.yml` — new `provisioning` job.
- `package.json` — `test:provisioning` script.
- `src/lib/env.ts` + `src/lib/env.test.ts` — the identity-credential check described above.
- `.env.example` — why the ops URL is not optional, and the demo-credential policy.
- `render.yaml` — the web service now declares `FGMP_OPS_DATABASE_URL` (`sync: false`, so
  Render prompts for it). It previously declared the variable only as *empty* on the IoT
  bridge, which documents the shape of the credential without ever supplying the one the
  web container needs. `FGMP_MIGRATE_DATABASE_URL` stays blanked there: that one *is* the
  schema owner and must not reach a request-serving container.

### 6. Not claimed

- The scripts were **not** run against the user's Supabase project from this sandbox (egress to
  Supabase is blocked). They were run against PostgreSQL 16/17 clusters as a role with the same
  privilege set as Supabase's `postgres`; the production failure was reproduced exactly first.
- The CI job has not yet run on GitHub at the time of writing — it is added here, and its first
  result is reported separately.
- No role, grant or policy was invented to make anything pass: the membership tuple exists because
  PostgreSQL requires it to evaluate `ALTER DEFAULT PRIVILEGES`, and it is asserted rather than
  assumed.

## Part D — UI/UX audit and remediation

**Branch** `arena/592458ff-fgmp1` · **Base** `8b51e3a`/PR #18 · owner: agent

The application is **not** a multi-page site. It is one route (`/`) that hosts a shell and 27
lazy-loaded views, plus `/login` (a redirect alias) and 171 API handlers. "Routing" therefore means
`?view=<key>` handled by `AppShell`, not a file per page. Any audit that assumes one page per
directory will find two pages and miss the product.

### 0. How this was verified, and what could not be

A real Chromium (Playwright, headless) renders the built app; nothing in the browser runs against a
mock. But two sandbox limits shape what is proven here, and they are stated up front rather than
buried:

| Limit | Consequence |
|---|---|
| `binaries.prisma.sh` is unreachable, so `prisma generate` cannot run. `@prisma/client` is the 2 KB "did not initialize" stub. | No API route can query the database. `next build` fails its type gate on the missing Prisma types. **No authenticated view can be exercised in this sandbox.** |
| `cdn.playwright.dev` and `deb.debian.org` are unreachable. | Playwright's own browser download fails. The suite runs here against a Chromium unpacked from npm (`@sparticuz/chromium`) with two stub system libraries; in CI it uses the real Playwright build. |

So the evidence splits in two, and the ledger does not blur it:

* **Verified here, now** — the public sign-in surface, in Chromium, at 8 viewports, in LTR and RTL,
  with a WCAG 2.2 AA scan, keyboard traversal and dialog focus containment. Plus every static
  invariant below (typecheck, lint, unit suites, i18n dictionary contract).
* **Verified in CI** — everything behind the session: the sign-in transition itself, navigation
  history, link semantics, the mobile nav dialog, role-dependent navigation, "no unauthorized
  request is issued", and the dashboard's WCAG 2.2 AA scan. The `ui` job provisions real
  PostgreSQL, applies the real migrations, seeds, builds the standalone server and runs the same
  spec with `FGMP_E2E_AUTH=1`.

**Result of the first green run** (`ui` job, 6m41s): `9 passed`. The four authenticated tests were
the ones that found D-11, D-12 and D-13 — none of which any amount of reading had produced.

A test that cannot run says so: the authenticated tests **skip**, they do not pass.

### 1. Findings

Severity is about the operator, not the code: `Critical` = cannot work safely, `High` = a core task
is broken or a status is misleading, `Medium` = friction or an accessibility barrier with a
workaround, `Low` = polish.

| ID | Where | Problem | Severity | Status |
|---|---|---|---|---|
| D-01 | `app-shell.tsx` navigation | Every sidebar destination was a `<button>` that called `router.replace`. Back left the application instead of returning to the previous view; no URL per view was reachable except by editing it; cmd/ctrl-click, middle-click and "open in new tab" did nothing. | High | **VERIFIED** (CI) |
| D-02 | `app-shell.tsx` mobile nav | The trigger was a `ChevronRight` — a "next/expand" glyph for a control that opens a left drawer, and it points the wrong way under RTL. Its accessible name was hardcoded English. The sheet it opens is a Radix dialog with no title, so it was announced as an unnamed "dialog". | High | **VERIFIED** (CI: trigger name + named dialog) |
| D-03 | header controls | Eight accessible names were hardcoded English (`Open navigation`, `Keyboard shortcuts`, `Switch language`, `Switch theme`, `Notifications`, …) while every visible label was translated. In Arabic the UI reads correctly but a screen reader announces English. | Medium | **FIXED** (8 of 8; the tree now contains **zero** English `aria-label` literals, enforced by test) |
| D-04 | `app-shell.tsx` alarm badge | The open-alarm count sat inside a nav item that carried an `aria-label`, so the label replaced the content and the count was announced as a bare digit, or not at all. | Medium | **VERIFIED** (CI) |
| D-05 | sign-in surface | *No defect found.* Rendering, labels, focus containment, viewport fit and contrast were measured rather than assumed — see §2. | — | **VERIFIED** (local Chromium) |
| D-06 | authenticated views (27) | Not exercised in this sandbox: no Prisma client ⇒ no data ⇒ no session. Their layout, forms, tables and states are **unaudited**, not "fine". | High | **BLOCKED** (sandbox) / **covered by CI** |
| D-07 | 6 view components + `error-boundary` | Same untranslated-accessible-name class as D-03: `api-keys-view` (Actions), `geography-view` (Edit, Delete), `tenants-view` (More actions, Filter by country), `maintenance-gantt` (Timeline range), `error-boundary` (Error message). | Medium | **FIXED** — six new dictionary keys, both languages; the guard test fails on a regression |
| D-08 | views | 7 call sites used `window.confirm`/native `confirm` instead of the shared `ConfirmDestructive`. Native confirms block the event loop, cannot be styled or translated, and ignore the app's destructive-action copy. | Medium | **FIXED** — the last one (`shift-handover-panel`) converted to `useDestructiveConfirm`; a source grep for `window.confirm(` now returns only comments |
| D-09 | whole app | Only 3 `aria-live` regions. Connection loss, a failed refresh and a role change are visible but not announced. | Medium | **FIXED, pending sweep** — `role="status"`/`aria-live="polite"` on the header connection pill and `system-status-banner`; **role change** now announced by a new `sr-only` polite, atomic live region in `app-shell.tsx`, driven by a pure rule (`role-announcement.ts`) that stays silent on the first resolution (the sign-in the user just performed), on unchanged polls, and on a transient `null` that would otherwise re-announce a role nobody lost — 6 tests pin those boundaries. Was PARTIAL, and the earlier note that the shell "cannot narrate" a re-render was wrong: the value being announced is the role, not the render |
| D-14 | 20 components | **The Arabic UI was only partly Arabic.** 145 English strings were JSX text nodes with no `t()` at all — the fuel-delivery timeline, the API-key table, the tenant support dialog, the maintenance toolbar — plus 5 components that never imported the translate hook. In Arabic mode they rendered left-to-right English inside an RTL layout. | High | **FIXED** — 179 keys added in both languages; measured count of English JSX prose in `src/components` is now **0**, enforced by `untranslated-text.test.ts` |
| D-15 | 15 files | English literals in props that RENDER text: `title`/`placeholder` (the first estimate, 33) but also `label`, `description`, `message`, `submitLabel`, `text`, `hint`, `heading` — `<EmptyState title=…>`, `<KpiCard label=…>`, every geography dialog. 89 in total. | Medium | **FIXED** — 80 keys added; the guard now covers all ten props at ceiling **0** (a value with no run of three lowercase letters is a format example, not language) |
| D-16 | `geography-view.tsx` | **CRITICAL, latent data loss.** The delete guard was `countLabel.includes("sites") && !countLabel.includes("0 sites")`. `"10 sites"` contains `"0 sites"`, so a governorate with **10 sites** was classified as empty: the warning was hidden and the button — disabled only when that flag is true — was enabled, cascading the delete through its districts and sites. Translating `countLabel` would have broken the guard for **every** count. | Critical | **FIXED** — the target carries `siteCount: number` and the guard compares it; covered by `rendered-text-as-data.test.ts` |
| D-10 | whole app | 509 occurrences of 9–10px type. Density is a product decision, not a bug to sweep; it needs per-view judgement against the operator's real screen. | Low | **DISCOVERED** |
| D-11 | `app-shell.tsx` sign-in | **CRITICAL.** `signIn({redirect:false})` resolves when the cookie is set, but nothing pushed the new session into `<SessionProvider>`, which still held the "nobody" it fetched at mount. The dialog stayed on top of an authenticated session; the server log recorded six successful sign-ins while the browser still showed the form. `LoginDialog` had an `onSuccess` hook that `AppShell` never passed. | Critical | **VERIFIED** (CI: 4 authenticated tests reach the shell) |
| D-12 | shell / dashboard | Six colour-contrast failures (WCAG 1.4.3, serious) on the rendered dashboard: sidebar group headings at 60% opacity (4), the KPI chip label at 70% (1), the 8px EN/AR badge (white on `emerald-500` = 2.3:1) (1). | High | **VERIFIED** (CI: axe 6 → 0) |
| D-13 | docs + seed | The README (Part C) told operators to rotate "readonly@fgmp.telecom"; **no seeder creates that account**. The suite proved it by failing to sign in. | Medium | **FIXED** (README lists the five real accounts; test uses `field.engineer@`) |
| D-17 | 30 rendered views | **The first browser sweep of every view returned 19 findings, all accessibility.** `button-name` (critical) on 8 views — up to **102 nodes** on `iot` alone, because a Radix Select trigger is `<button role="combobox">` and a combobox is named by `aria-label`, never by the value it displays (69 triggers, all unnamed); `aria-valid-attr-value` (critical) on 3 views — `<TabsTrigger>` with no `<TabsContent>` of the same value, so `aria-controls` pointed at nothing; `color-contrast` (serious) on 5 views / 56 nodes — `text-*-600` at **2.9:1** against the **default dark** card; `aria-prohibited-attr` on the dashboard (an `aria-label` on a non-focusable `<div>`, so its tooltip was unreachable by keyboard); `svg-img-alt` on 2 views (Recharts hard-codes `role="img"` on every pie sector with no name); `scrollable-region-focusable` on `edge-firmware` (a max-height box with nothing focusable inside). | High | **FIXED** — `Select` now requires `label` and forwards it to the trigger (69 sites, enforced by `tsc`); 3 filter controls became a `FilterTabs` segmented control (`role="radiogroup"`); 228 `text-*-600` → `text-*-700 dark:text-*-400`; the sparkline is a `<button>`; 4 doughnuts wrapped in `DecorativeChart` because their legends are already text; 12 scroll boxes made focusable and named. `a11y-guards.test.ts` fails on each shape at the file and line that introduces it |
| D-18 | `render.yaml`, docs, `.env.example` | **Three retired platforms were still described as deploy targets.** `render.yaml` (102 lines: web service, migration job, IoT bridge, shared environment group) sat in the tree after the move to Cloudflare, and DEPLOYMENT/ARCHITECTURE/SECURITY/READINESS all pointed at it. A blueprint that looks deployable but is not is what an operator reads when they need to ship. | Medium | **FIXED** — `render.yaml` deleted; DEPLOYMENT.md §4 rewritten around Cloudflare Workers (manifest key-by-key, `wrangler secret put`, the `NEXT_PUBLIC_*` rebuild trap, migrations as operator jobs, per-isolate connection caps, the pooler/RLS caveat, a first-deploy checklist, rollback); DB-CONNECTION-ASSESSMENT marked superseded on the deployment question only; `deployment-target.test.ts` fails if any retired manifest reappears, if the build script stops being OpenNext, if `WORKER_SELF_REFERENCE` stops naming the Worker, or if a doc heading names a retired platform |
| D-19 | `untranslated-text.test.ts` + 37 components | **The guard against hardcoded English could not see the strings it existed to find.** `>[^<>{}]*<` excludes braces, so every heading shaped `Tank Refuel Forecast ({n})` — and every count-bearing title in the app — was invisible. Three rounds of "0 untranslated strings" were a property of the regex, not the product. Re-parsing the JSX with TypeScript surfaced **37** English strings, including a whole table header in `fuel-forecast-view` and the tenant-delete support text. | High | **FIXED** — guard rewritten as a `ts.createSourceFile`/`isJsxElement` walk that joins the literal children of each element; ~45 keys added in `en`/`ar`; 37 sites converted; ceiling **0**. `patterns.heatmapTitle`, `tenants.deleteHasDependents` etc. now translate |
| D-20 | `ui/table.tsx`, `ui/scroll-region.tsx`, 30 charts, `dashboard-view`, 4 contrast causes | **Fifteen findings on the third sweep, eleven of them new shapes.** `scrollable-region-focusable` ×2 on fuel-forecast; `nested-interactive` on geography (and **latently** on the dashboard, invisible while the alarm list is empty); `aria-progressbar-name`; `button-name` on unlabelled switches; `svg-img-alt` ×52; `color-contrast` ×30 from four different causes — `opacity-50` dimming, `text-muted-foreground/70`, white text on `*-500` Gantt bars, and a tinted chip inside a muted filter tab. | High | **FIXED, pending sweep.** New `ScrollRegion` primitive joins the tab order only while content overflows (and names itself); 30 chart roots at `tabIndex={-1}`; the dashboard row is a real `<button>` with Ack as a sibling; `Progress.label` and `Select.label` are both compiler-enforced; the four contrast causes corrected at the source, not by nudging one shade. `a11y-guards` is 11 tests and each new one was proven against a deliberately broken probe. **Not VERIFIED** — contrast and focus order need the browser sweep |
| D-21 | 9 views: `sites` `batteries` `fuel` `generators` `iot` `dispensers` `reports` `audit` `analytics` | **Nine lists were silently capped, and three had no empty state.** `sites` cut at 100 rows, `batteries` and `fuel` at 60, `generators` at 40, `iot` at 100, `dispensers` at 100/200, `reports` at 50 per table, `audit` at 200 — all `slice(0, N)` with no indication. On a tenant with 140 sites, row 100 looks exactly like the last row there is, and an operator who filters for a site sorting past the cap concludes it does not exist: a rendering decision producing a data-integrity impression. Separately `batteries`, `fuel` and `generators` rendered an empty grid under a heading reading `(0)` — on a freshly provisioned tenant, the first thing an operator sees, indistinguishable from a failed load. | Medium | **FIXED** — `TruncationNote` now covers **all 10 capped lists** in the 27 views — the first pass wired 5 and a mechanical check (cap 20+ rows without the import ⇒ fail) caught the other 5. It renders "Showing {shown} of {total}…" and nothing when the list fits (5 views wired); the three empty grids now render "Nothing here yet.". Found by the per-view audit (`docs/UI-UX-AUDIT-VIEWS.md`), which the earlier rounds did not have |
| D-22 | `bun.lock`, `docs/DEPLOYMENT.md` | **The only deployment target is paired outside its adapter's declared Next range.** `@opennextjs/cloudflare@1.20.13` supports `>=15.5.28 <16 || >=16.4.1`; the lockfile pins Next **16.1.3**. `package.json` (`^16.1.1`) permits a supported version — the lock is what is wrong. Not a cosmetic note: OpenNext is the only way this app reaches production now, and a declared-range mismatch is exactly the class of defect this audit exists to surface before an operator hits it. | High (tracked) | **DOCUMENTED, not fixed.** `opennextjs-cloudflare build` does succeed on 16.1.3 in CI `verify`, and the standalone server boots in `docker` — so this is a *declared-range* mismatch, not a proven runtime failure, and claiming otherwise would be the unverified assertion this audit forbids. Remediation is `bun update next` (stays inside `^16.1.1`). It could not be run here: registry tarball downloads fail in this sandbox (`ConnectionClosed`), and hand-editing `bun.lock` would desynchronise the `@next/swc-*` integrity pins. Written up in DEPLOYMENT.md with the exact commands and the expected diff |
| D-23 | `scripts/verify/pooler-rls-proof.ts`, CI `rls` job, DEPLOYMENT.md | **The Hyperdrive decision was blocked on a question nobody had an instrument for.** Tenant isolation depends on `SET LOCAL app.tenant_id` inside an explicit transaction; a pooler is safe exactly when it preserves that, and no script in the repository had ever connected through one — `rls-regression.ts` proves the semantics on a *direct* connection. | High (decision unblocked, evidence still external) | **INSTRUMENT ADDED + self-tested.** The proof asserts four properties against whatever URL it is given: `SET LOCAL` visible in its transaction, gone after COMMIT, two concurrently-open transactions each seeing only their own context (the actual bleed), and `ENABLE`+`FORCE` RLS with an unset context returning **0** rows. It writes nothing. A `rls` job step now runs it against the direct endpoint as a **control** — if it fails on a database CI just migrated and seeded, the script is wrong and any operator would get a false verdict. It still cannot prove the operator's pooler: no route, no credentials. The decision stays open until someone runs it there and records the host with the result | **And the control earned its keep immediately:** on its first run it failed — not on the database, but on a bug in the proof itself. PostgreSQL keeps a placeholder once a custom GUC has been SET, so after `COMMIT` the value reverts to `''`, not `NULL`; the assertion demanded `NULL` exactly. Both are safe, so an operator running that version against a healthy pooler would have been told their infrastructure was unsafe. Corrected (`d5459f3`) to require only that the previous tenant is gone. |
| D-24 | `decorative-chart.tsx`, `maintenance-gantt.tsx`, `tenant-isolation-view.tsx` | **The sweep went 15 → 4, and the four survivors had three distinct causes.** (a) `aria-hidden-focus` on the dashboard and on fuel — the two views with a doughnut — where `aria-hidden` wrapped a Recharts subtree that contains a focusable node whose exact position moves with the chart and the data; (b) one Gantt bar at `bg-amber-700` carrying white 10px text = **4.4:1**, caught on a past-due bar whose rose ring does not lighten the fill; (c) `tenant-isolation`'s two raw `<div className="overflow-x-auto">` tables, which never went through the `Table` component and so never got a `ScrollRegion`. | High | **VERIFIED in CI** — run `40219118625`, job `121247141590`: **14 passed, 0 axe violations across all 30 rendered views**. Sweep trajectory 34 → 19 → 15 → 4 → **0**. **FIXED** by: The hidden wrapper is now three-way — `aria-hidden` for assistive tech, `inert` for the tab order, and an effect that strips a non-negative `tabindex` from any descendant Recharts adds back — because chasing the node inside Recharts' internals would break on the next minor release. Bars moved to `sky-700` / `amber-800` / `violet-700` with the measured ratios written next to them. Both isolation tables now use `ScrollRegion`. Guard 13 tests: DecorativeChart cannot lose `inert` or the sweep |
| D-25 | `.github/workflows/deploy.yml`, `docs/DEPLOYMENT.md` | **The only deployment target had no CI path at all.** Every deploy was an engineer's laptop: no record of which commit shipped, no check that it had passed CI, no readiness probe afterwards, and nothing preventing two people deploying at once. On a single-environment product, that is a release process held in someone's memory. | Medium | **ADDED.** `workflow_dispatch` only (never on push), requiring: `confirm == DEPLOY`, both Cloudflare secrets present, the commit to already have a **green `CI` run** (checked via the API on the exact SHA), and a non-cancelling concurrency group so a deploy cannot be interrupted into a half-published Worker. It builds with `--frozen-lockfile` — the same graph CI verified — then probes `/api/health/ready`. Migrations stay an operator step on purpose. **Cannot be VERIFIED here**: no Cloudflare credentials, so the job has never executed; the YAML is parsed and its steps asserted, which is not the same thing |

### 2. What was measured (public surface, Chromium 153, real server)

Eight viewports — 320×568, 375×812, 390×844, 768×1024, 1024×768, 1366×768, 1440×900, 1920×1080:

* horizontal overflow: **none** at any viewport (`scrollWidth == clientWidth`);
* the sign-in dialog stays inside the viewport at every size, including 320 px;
* axe-core, WCAG 2.0/2.1/2.2 A+AA rules: **0 violations**;
* focus is placed inside the dialog on load and **does not escape** it after six Tab presses;
* Arabic (`fgmp:lang=ar`) sets `dir="rtl"`, keeps zero overflow and keeps the dialog on screen.

Reproduce (this sandbox):

```bash
# Chromium from npm + two stub libs, since cdn.playwright.dev is blocked here
cd /tmp/browser && npm i playwright-core @sparticuz/chromium
export CHROMIUM_PATH=$(node -e 'import("@sparticuz/chromium").then(async c=>console.log(await c.default.executablePath()))')
export LD_LIBRARY_PATH=/tmp/nssstub3      # see §6 for how it is built
LD_LIBRARY_PATH=$LD_LIBRARY_PATH npx playwright test      # in CI: no CHROMIUM_PATH needed
```

### 3. The corrections, and why they are shaped this way

**D-01 — navigation became navigation.** Each sidebar item is now an `<a href="/?view=…">` with a
click handler that calls `preventDefault()` only for an unmodified left click. Modifier and
middle clicks are left to the browser, so the affordances users expect from a link work. `navigate()`
uses `router.push`, so history is recorded. The *denial* path still uses `router.replace` — that is a
correction of a URL the user is not allowed to see, and it must not become a Back-button trap. The
visible label is the accessible name (the previous `aria-label` duplicated it and suppressed the
alarm count), and the count now has a localized spoken form in an `sr-only` span.

**D-02 — the trigger and the sheet.** `Menu` replaces `ChevronRight`; label and title come from the
dictionary; the sheet's side follows `dir` (right in Arabic); `SheetTitle` gives the dialog its name
without adding visual noise.

**D-03 — the eight names.** Five are fixed by adding keys to both dictionaries (the existing i18n
test fails the build if a `t()` key is missing, so this is a contract, not a convention). The three
in view files are recorded as D-07 rather than half-fixed, because those views are unaudited and
editing them blind is how a "translation pass" introduces regressions nobody looked at.

No component was rewritten, no style was replaced, no permission was touched, and no data was
fabricated to make a screen look complete.

### 4. The regression suite

`tests/e2e/ui.e2e.ts` (Playwright), split by what it needs:

| Test | Needs | Asserts |
|---|---|---|
| sign-in renders with labelled fields | server | dialog, both labelled inputs, submit, zero page errors |
| focus containment + keyboard | server | focus inside dialog on load; still inside after six Tabs |
| 8 viewports | server | no horizontal overflow; dialog within the viewport |
| Arabic / RTL | server | `dir="rtl"`; no overflow; dialog on screen |
| WCAG 2.2 AA | server | axe violations = 0 |
| nav is links; Back returns | DB + session | >20 links, `href="/?view=…"`, `aria-current`, Back leaves the view |
| mobile nav dialog | DB + session | trigger name; dialog has a name; it closes on navigation |
| READONLY | DB + session | no Users/Tenants/API-keys link **and** no request to those endpoints |
| dashboard a11y | DB + session | axe violations = 0 |

The **unit** half of the same defence is `src/lib/fgmp/__tests__/untranslated-text.test.ts`, which reads
`src/components` and fails on: English prose in a JSX text node (ceiling **0**), an English `aria-label`
literal (ceiling **0**), or growth in English `title`/`placeholder` literals (ceiling **33**, D-15). It
scans with a small JSX-aware pass rather than a regex on raw text, because the naive regex also matched
code that happened to sit between two angle brackets (`>= 3; return (`) — 376 false hits against 127
real ones. Comments are blanked but newlines preserved, so the reported line numbers point at the file.

`testMatch: "**/*.e2e.ts"` is deliberate: `bun test` globs `*.spec.ts` and would otherwise try to run
Playwright's `test()` inside bun's runner — which is exactly what happened once, and it showed up as a
17th failure in the unit baseline.

The `ui` CI job (`.github/workflows/ci.yml`) installs Playwright into `.pw/` rather than into
`package.json`: ~40 MB of browser automation belongs to one job, not to every `bun install` or to the
application image.

### 5. State of the audit

| Area | Result |
|---|---|
| Route inventory | 27 views + `/` + `/login` alias + 171 API handlers; each view has a `view:*` capability and is filtered by `hasCapability` |
| Public surface | audited in a browser; **0** defects found; 5 tests green |
| Shell (nav, header, footer) | 5 defects found (D-01, D-02, D-03, D-04, D-11), all fixed; proven by the CI half of the suite |
| Authenticated views | Shell, navigation and the dashboard's a11y are **VERIFIED in CI**. All 27 views are rendered by the axe sweep (0 page errors, 0 overflow at 1440/390 in the last full run) and were **audited individually** in round 5 — `docs/UI-UX-AUDIT-VIEWS.md`: 9 silently-capped lists and 3 empty grids found and fixed (D-21). |
| RTL | login surface verified in a browser; every view rendered in the sweep, but the RTL *rendering* of the 27 views is inspected statically (dir/RTL utilities), not exercised at width |
| Performance | **not measured** — a dev server with no database cannot produce a meaningful number, and reporting one would be dishonest. No view has a measured render cost |
| i18n | **0** English JSX prose, **0** English `aria-label` literals and **0** English `title`/`placeholder`/`label`/`description` literals remain in `src/components`; the guard is a TypeScript JSX parse, all three ceilings are **0** |
| Remaining defects | **D-06 closed** (round 5 audits every view). **D-09 closed** (role change announced). **D-10 bounded** (10px floor enforced; 10/11px density is a product decision, deliberately not overridden). **D-15 closed** (ceiling 0). Open and tracked: **D-22** (Next pinned outside the OpenNext range — documented, remediation needs registry egress) and **D-23** (pooler proof passes its CI control run; the operator's own pooler run is still outstanding, because this audit has no route to it). **D-25** is added but has never executed (no Cloudflare credentials) |

### 6. Round 2 — the bilingual sweep (D-14, D-15) and the last native confirm

The first round stopped at the shell. This round audited the components and views against the code and
against the running app, and the largest finding was not a bug in any single one: **the Arabic UI was
only partly Arabic.**

**How it was measured.** Not by reading files. A scan of every `.tsx` under `src/components` looked for
English prose sitting in a JSX text node — text between `>` and `<` that never passes through `t()`.
Measured against `a0aadf0` (the commit before the sweep) it returns **145**; against `e725fb2` it returns
**0**. The figure moved while the rule was being tightened — an earlier, narrower rule (capitalised
start, no sentence punctuation) found 76 — and 145 is the number to quote because it is what the
committed test counts. A first naive regex found 376, because `>= 3; return (` is also "text between two
angle brackets"; the scan therefore blanks comments, keeps newlines (so line numbers point at the file),
rejects code punctuation, and requires two or more word-shaped tokens.

**What they were.** Whole panels, not stray labels:

| Where | Example |
|---|---|
| `fuel-delivery-tracking.tsx` | `Active Deliveries`, every status label, `ETA: … (in …)`, `Overdue by …` |
| `views/api-keys-view.tsx` | all nine column headers, the create dialog, the revoke confirmation, the one-time-key warning |
| `views/tenants-view.tsx` | `Add Tenant`, `Edit Tenant`, `Delete Tenant`, the support-session dialog end to end |
| `maintenance-gantt.tsx`, `alarm-correlation-panel.tsx`, `region-leaderboard.tsx` | card titles and summary labels |
| `views/edge-firmware-view.tsx`, `views/fuel-forecast-view.tsx`, `views/asset-registry-view.tsx` | tabs, table headers, empty states, form labels |

Five components (`fuel-delivery-tracking`, `keyboard-help-dialog`, `remote-control-dialog`,
`site-comparison-tool`, `support-session-banner`) had **never imported the translate hook**, so no
amount of adding keys would have helped them.

**Two shapes needed care.** Module-scope tables (`STATUS_META`, `ALL_SCOPES`) cannot call a hook, so
their `label` strings became `labelKey` fields resolved at render. And where a sentence had emphasis in
the middle (`This immediately disables the key <span>{prefix}…</span> ({name})`) the markup could not
survive translation at all — word order differs in Arabic — so those became `tFmt()` templates with the
values interpolated, losing the `<span>` and keeping the meaning.

**Result.** 179 keys added in both languages. English JSX prose in `src/components`: **145 → 0**.
English `aria-label` literals: **12 → 0**.

**The guards, because a sweep without one regrows.** `src/lib/fgmp/__tests__/untranslated-text.test.ts`
fails on English prose in a JSX text node (ceiling **0**), on an English `aria-label` (ceiling **0**),
and on growth in `title`/`placeholder` literals (ceiling **33** — the remaining D-15 inventory is
printed by the failing assertion). The existing key scanner also gained `tFmt()`/`translateFmt()`
coverage, plus a test that fails if a `useT()`/`useTF()` binding is named something the scanner does not
recognise: `const tf = useTF()` used to compile, render, and escape every key check.

**D-08 finished.** `shift-handover-panel` was the last `window.confirm`. It is now
`useDestructiveConfirm`, with ask/perform split so the confirm handler runs after the dialog closes —
the same shape every other destructive action already used. A grep for `window.confirm(` now matches
only comments that explain why it is gone.

**D-09 partly closed.** The header connection pill and the platform status banner are
`role="status"` + `aria-live="polite"`; a feed that stops is no longer silent. A role change is still
narrated by nothing — that is one atom of state, not a region, and faking an announcement would be
worse than the gap.

**Verification of this round**

| Check | Command | Result |
|---|---|---|
| Unit + contract | `bun test` | **879 pass**, 13 skip, 16 fail — the 16 are the pre-existing Prisma-Decimal failures, unchanged |
| Types | `npx tsc --noEmit` | 516 `error TS` — identical to the baseline; **zero** in the touched files |
| Lint | `npx eslint src tests scripts --ext .ts,.tsx` | 0 errors, 1 pre-existing warning (`use-realtime.ts`) |
| Public surface | Playwright, real Chromium | **5 passed** (dialog, focus trap, 8 viewports, RTL, axe 0) |
| Authenticated surface | skipped locally — no database in this sandbox | covered by CI |
| CI, run `40141945829` @ `e725fb2` | `gh pr checks 18` | `verify` pass · **`ui` pass (step "Browser suite (public + authenticated)", `FGMP_E2E_AUTH=1` → the authenticated tests ran, not skipped)** · `rls` pass 10m54s · `docker` pass 2m30s · `provisioning` pass · `mini-services` pass · Netlify preview pass |

**What is still not claimed.** D-06 is now measured, not closed: 30 views render, none crashes, none
returns a 5xx and none overflows at either viewport — but "renders without error" is not "the layout is
right". What each screen *looks like* still needs a human on a real screen (D-10 is the same question in
pixels). D-09 is partial. The 16 Prisma-Decimal test failures are a local toolchain artefact (the schema
engine cannot be downloaded in this sandbox), not a passing suite.

### 6b. Round 3 — the first sweep of all 30 views, and the platform move

Round 3 changed how the browser suite reports. The previous round could only assert the *public* surface
plus five authenticated shell tests, because a failing authenticated test produced a log line the
sandbox could not read: Actions logs and artifacts are served from `productionresultssa*.blob.core.windows.net`,
which is unreachable here. The fix was to stop needing that host — the sweep now runs as **one** test that
visits every view, keeps going past a broken one, and fails once with the complete list of defects, which
the Playwright `github` reporter turns into a check-run **annotation**. Annotations come from
`api.github.com`, which is reachable. That is how the 19 findings below were read at all.

**The result, which is the honest headline:** 34 problems across 30 rendered views — **zero** page errors,
**zero** 5xx, **zero** horizontal overflow at 1440 or 390, and 19 distinct accessibility findings (D-17).
The views are not broken; the controls in them were not properly *described*. That is a different kind of
defect from the ones in rounds 1–2 and it needed a browser to see, which is why D-06 sat open for two
rounds.

Two findings are worth naming because neither is an "a11y ticket":

* **102 unnamed buttons on one screen.** Not 102 mistakes — one component shape (`<SelectTrigger>`) used 69
  times, plus table row buttons, where the accessible name is taken from `aria-label` and never from the
  visible value. Fixing it site-by-site would have left the next Select broken within a week, so `Select`
  now *requires* a `label` and the compiler is the guard.
* **`text-*-600` at 2.9:1 in the default theme.** The light theme passed; the dark theme — the one the app
  ships with — did not. Red "EMERGENCY STOP" text on a rose-tinted card was the least readable string in
  the product. Contrast had been checked on the dashboard only (D-12), where these classes did not appear.

**Platform move.** Deployment consolidated to **Cloudflare Workers** (D-18). Netlify, Vercel and Render are
retired; `render.yaml` is deleted and every document that treated it as the target is corrected. The build
path did not change — `npm run build` was already `opennextjs-cloudflare build` — so this is a paperwork
defect, not a runtime one, but it was actively misleading: three of the four deploy documents described a
platform that no longer receives a push. A guard test now fails if a retired manifest reappears.

**Verification for this round.** The 19 a11y findings are **FIXED** and locally proven by
`a11y-guards.test.ts`; they are **not yet VERIFIED** in the browser — that requires the next CI run of the
sweep, which is the only place all 30 views can be rendered. Nothing in this round is marked VERIFIED on
the strength of a static test.

### 6c. Round 4 — the sweep says 15, and a guard that could not see what it was guarding

**Where the number stood.** CI `40209855462` (commit `04b9f2e`) ran the axe sweep over all 30 views and
reported **15 problems**: 34 → 19 → 15 across three rounds. Eleven of the fifteen were new *kinds* of
defect that only appear once the obvious ones are gone, which is the normal shape of this work.

**The finding that mattered most was in the test, not the product.** The guard that was supposed to stop
hardcoded English (`untranslated-text.test.ts`) had reported **0** for three rounds. It was a regex over
text nodes — `>[^<>{}]*<` — and that character class excludes a brace. The ordinary shape of a heading is
`Tank Refuel Forecast ({n})`, prose glued to an expression, so the guard could not see the very strings it
existed to find, including a whole table header in `fuel-forecast-view` and every count-bearing title in the
app. Replacing it with a TypeScript **JSX parse** (`ts.createSourceFile` + `ts.isJsxElement`, joining the
literal children of each element) surfaced **37 English strings**. All 37 are now `t()`/`tFmt()` and the
ceiling is 0. The lesson is recorded in the test's own header: a guard whose subject is syntax must read
syntax.

**What else changed.**

* **A scroll container that only joins the tab order when it scrolls** (`ui/scroll-region.tsx`).
  `scrollable-region-focusable` fired twice on fuel-forecast: the capped table body and the table's own
  overflow wrapper. `tabIndex={0}` on every wrapper is the wrong fix — a table that fits becomes an empty
  tab stop announced as a nameless group, and this app has hundreds of tables. The new primitive measures
  overflow (container, first child, and DOM mutation) and sets `tabIndex`/`role="region"`/`aria-label` only
  while content actually overflows.
* **No chart root in the tab order.** Recharts puts `tabindex="0"` on its `<svg>`; without
  `accessibilityLayer` (used nowhere in this app) that stop does nothing. 30 chart roots now carry
  `tabIndex={-1}` and are announced, once, by their wrapper — named if the graphic carries information
  that is not printed as text, `aria-hidden` if it does not.
* **`nested-interactive` on the dashboard.** A `role="button"` alarm row wrapped an Ack `<Button>`; the
  row's `stopPropagation` hid the problem from the pointer, not from a screen reader. The row is now
  layout only: a real `<button>` for the main area, Ack as its sibling. This one was **latent** — the
  sweep never saw it, because that list is empty on an empty database.
* **Contrast, four distinct causes.** (a) Whole cards dimmed with `opacity-50` to mean "disabled" — the
  labels inside are not the disabled control, so WCAG's inactive-component exemption does not apply and
  the text measured ~2.4:1; the state is now carried by a dashed border and the existing "Disabled" text.
  (b) `text-muted-foreground/70`, which is ~2.7:1 in light and ~4.0:1 in dark, replaced by the full token
  in seven components. (c) Gantt bars: white 9px text on `*-500` (amber 2.1:1); bars moved to `*-700`
  (5.5:1). (d) Count chips tinted `bg-foreground/10` inside a muted filter tab, 3.8:1; the chip now sets
  its own `text-foreground`.
* **Guards: 6 → 11 tests, and every one is proven.** New cases: every `<Switch>` is named (aria-label, or
  an id an `htmlFor` points at, or `FormControl`), every `<Progress>` is named and the `label` prop stays
  required, no control inside a `role="button"`, no chart root in the tab order. A guard that has only
  ever passed has not been tested, so each was checked against a deliberately broken probe component:
  all four failed on it and passed once it was removed. Writing them also found a bug in the guard
  itself — `src.indexOf(">")` truncates a JSX tag at the arrow in `onChange={() => …}`, hiding every
  prop after it, which is exactly how an `aria-label` "went missing".

**Verification status.** Everything above is **FIXED** and locally proven (`tsc` 516 = baseline,
`eslint` 0 errors, 900 pass / 13 skip / 16 fail where the 16 are the pre-existing `Decimal` failures,
`a11y-guards` 11/11, `untranslated-text` 3/3 at ceiling 0). It is **not VERIFIED**: that requires the next
sweep, which renders all 30 views with a seeded database and is the only instrument that can see contrast
ratios and focus order. Round 4 dispositions are therefore *fixed, pending sweep* — not *done*.

### 6c-bis. The sweep result on #18's merge commit — 15 → 4

Run `40216192291` rendered all 30 surfaces after round 4. It reported **4 problems**, down from 15, and the
eleven that disappeared are exactly the classes round 4 attacked:

| Rule (round 3 count) | After round 4 |
|---|---|
| `button-name` ×3 (unnamed preference switches) | **gone** |
| `aria-progressbar-name` ×1 | **gone** |
| `nested-interactive` ×4 (geography) | **gone** |
| `svg-img-alt` ×52 (analytics scatter) | **gone** |
| `scrollable-region-focusable` ×2 (fuel-forecast) | **gone** |
| `color-contrast` ×30 (preferences, maintenance, sites, alarms, analytics, generators) | **1 left** |
| `aria-hidden-focus` ×2 (dashboard, fuel) | **2 left** |
| `scrollable-region-focusable` ×1 (tenant-isolation) | **1 left** |

So round 4 is **VERIFIED**, and the four survivors are D-24 — each with a distinct cause that round 4's
guard could not have caught: a focusable node inside a Recharts subtree whose position moves with the data,
one Gantt bar at 4.4:1 (amber-700, below the 4.5 threshold by a hair), and two tables in `tenant-isolation`
that bypassed the `Table` component entirely.

This is the value of running the instrument rather than trusting the guard: three of the four were things a
static scan cannot see, and one of them (`tenant-isolation`) was created by the same refactor that fixed the
other tables.

### 6e. The sweep reaches zero — round 6

Run `40219118625`, job `121247141590`:

```
14 passed (7.1m)
[chromium-desktop] › tests/e2e/views.e2e.ts took 6.8m
0 problems across 30 rendered views
```

**The trajectory of the whole audit is 34 → 19 → 15 → 4 → 0.** Nothing was suppressed, no rule was
disabled, no view was excluded and no assertion was loosened: the sweep asserts a deep-equal against `[]`,
and it now receives `[]`.

That closes every accessibility and i18n defect this audit opened:

| | Status |
|---|---|
| D-12 dashboard contrast | VERIFIED |
| D-14 / D-15 / D-19 hardcoded English (145 → 0) | VERIFIED (ceilings 0, three guards) |
| D-17 button-name, dangling tabs, contrast, prohibited aria | VERIFIED |
| D-20 scroll regions, nested interactive, chart tab stops, 4 contrast causes | VERIFIED |
| D-21 capped lists / empty grids | FIXED (not an axe rule — no sweep can see it) |
| D-24 the last four | VERIFIED |

**What "zero" does not mean.** axe checks rules, not judgement. The sweep cannot see a list silently
capped at 100 rows (D-21), an empty grid that looks like a failed load, or a 10px label that is *readable*
but tight. Those were found by reading the code, and they are recorded as FIXED rather than VERIFIED
because nothing in CI can promote them. Zero violations means no *rule* is broken — that is the ceiling of
what a linter can promise, and this ledger does not inflate it.

**One more thing the round produced.** The new pooler proof failed its own control run in CI — on a bug in
the instrument (PostgreSQL reverts a custom GUC to `''`, not `NULL`, after `COMMIT`). An operator would
have been told their healthy pooler was unsafe. The control run exists precisely to catch that, and did,
before the script was ever pointed at real infrastructure.

### 6d. Round 5 — the 27 views, audited individually

Rounds 2–4 swept. A sweep renders every view and asks axe whether a *rule* is broken; it cannot see
whether a view tells the operator what they need in the state they are actually in. Three defects of that
second kind were found by reading all 27 view files and published as `docs/UI-UX-AUDIT-VIEWS.md`:

* **Nine silently capped lists** (D-21). `sites` stopped at 100 rows with no count anywhere. On a tenant
  with 140 sites, row 100 is indistinguishable from the last row that exists, so filtering for a site that
  sorts past the cap returns "no results" for a site that is there. Fixed with `TruncationNote`:
  "Showing 100 of 140. Narrow the filters to see the rest." It renders nothing when the list fits.
* **Three empty grids** (D-21). `batteries`, `fuel` and `generators` drew an empty container under a
  heading reading `(0)`. On a newly provisioned tenant — the first screen a new operator sees — an empty
  grid is indistinguishable from a failed load. Each now says "Nothing here yet."
* **D-09 closed.** Role changes are announced. The earlier note that the shell "cannot narrate" the change
  was wrong: the value worth announcing is the role, not the render.

Two things this round deliberately did **not** do. It did not touch the 682 occurrences of 10px/11px type:
that density is a product decision about the operator's real screen, and only the unreadable 8px/9px band
was raised (D-10, now enforced at 10px). And it did not claim a single finding as VERIFIED — every one of
these is **FIXED**, and the sweep in Chromium remains the only instrument that can promote any of them.

### 7. Environment note (worth knowing, not a product defect)

Loaded over `http://127.0.0.1:3000` the app sits on "Signing in…" forever; over `http://localhost:3000`
it renders immediately. Next 16 blocks cross-origin dev resources (`⚠ Blocked cross-origin request to
Next.js dev resource /_next/hmr from "127.0.0.1"`), and the client bundle never finishes. Production
is unaffected. Fix if it ever matters: `allowedDevOrigins: ["127.0.0.1"]` in `next.config.ts`.

The stub libraries, for the record: `libnss3.so`, `libnssutil3.so` and `libnspr4.so` were generated
with `gcc -shared` from the undefined-symbol list of the unpacked Chromium (32 NSS + 6 NSPR symbols),
because the sandbox has no package manager access. TLS inside that browser does not work; every test
here is plain HTTP against localhost.
