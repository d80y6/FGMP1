# FGMP1 PostgreSQL connection architecture assessment

**Assessment date:** 2026-10-24 (Asia/Aden) · **Branch:** `arena/ea5864e5-fgmp1` · **Starting commit:** `c19c2cff77051285a0c7815dfc7101866b1e5e76`
**Status:** Repository and isolated-database assessment complete; live provider verification and staged rollout remain blocked.

## Executive findings

1. **No material performance improvement was measured.** With the same isolated PostgreSQL workload and a three-connection app-pool cap, throughput was effectively flat at concurrency 6 and 18. Latency at those levels reflects queued work. This change set does **not** justify raising or lowering the pool cap.
2. **The actual application pool is now observable and the configured acquisition deadline is effective.** The regression ran through the real `PrismaPg`/`pg.Pool`: it saturated at 3/3 checked-out clients with queued work, published saturation `1`, rejected a queued checkout at about 1 second for a 1-second pool timeout, and served a follow-up query successfully.
3. **Tenant isolation passed on real PostgreSQL as `fgmp_app`.** The isolated PostgreSQL 16.2 test cluster authenticated `fgmp_app` with neither superuser nor `BYPASSRLS`; all 39 tenant tables had RLS enabled and forced. Concurrent tenant contexts, rollback, error recovery, and smoke checks passed.
4. **The production platform, database provider, endpoint, pooler, limits, and HTTP metrics scrape are not verified.** `render.yaml` describes a Render Docker target; the repository also contains an optional OpenNext/Cloudflare path. Neither establishes the live deployment. No production metrics or credentials were available.
5. **Hyperdrive is not eligible on the evidence available.** No Wrangler Hyperdrive binding is configured, the active runtime is unknown, and the locked OpenNext/Next versions do not currently establish a supported Cloudflare target. Do not add a binding to the Node/Bun app or migrate platforms as part of this work.

The changes preserve the existing `fgmp_app` ordinary-query path, RLS, and three-connection long-lived cap. They improve timeout wiring, process-local observability, regression coverage, and declarative deployment separation. They do not change schema or claim a throughput gain.

## Scope, evidence, and limits

This assessment distinguishes repository/configuration evidence from live-provider evidence. No Render account/environment group, production database endpoint, provider dashboard, deployment log, or authorized production metrics scrape was available. The real PostgreSQL evidence below comes from an isolated local PostgreSQL 16.2 cluster. Its roles, endpoint, connection limit, and workload are **not** production evidence.

The test cluster's 25 ordered migration SQL files were applied manually because Prisma migration initialization failed on a PostgreSQL catalog `name` type. The Prisma migration history was therefore not established in that cluster. Tests exercised the resulting schema and policies; they do **not** prove that `prisma migrate deploy` succeeds against the production provider.

## Runtime and provider assessment

### What repository configuration establishes

- `render.yaml` declares a Docker web service (`fgmp-app`), a one-shot migration job (`fgmp-migrate`), and an API-only IoT bridge.
- `Dockerfile` builds a standalone Next.js app and runs it with Bun in a long-lived container. `src/instrumentation.ts` declares the Node.js runtime.
- `render.yaml` is a declared target, not proof that the live service currently runs on Render. Its environment-group contents and effective service variables were not available.
- `docker-compose.yml` is the local stack and provisions a TimescaleDB/PostgreSQL image. CI also defines a TimescaleDB PostgreSQL service. The hosted database provider is not established by either.
- The repository also includes `open-next.config.ts` and `wrangler.jsonc`. That is a separate optional Cloudflare build path. `wrangler.jsonc` has no Hyperdrive binding and runtime code has no binding access. The lock resolves Next.js 16.1.3, while the locked OpenNext Cloudflare package declares a supported Next.js 16.4.1-or-later or supported 15.x range; the resolved pair does not establish a supported target.

### What remains unknown

- Active runtime/deployment target and number of app instances.
- Hosted PostgreSQL provider, endpoint type, direct-vs-pooled URL, pooler mode, TLS behavior, connection allowance, current/peak sessions, database CPU/memory, and provider-side queueing.
- Whether the live Render environment group contains any legacy or privileged database variables and whether the updated Blueprint has been applied.
- Whether an external scrape can reach `GET /api/fgmp/metrics` with the required `ALARM_OPS` authorization.

No production provider or connection limit is inferred from sample URLs or deployment documentation.

## Connection architecture and security boundary

### Ordinary application client

- `src/lib/db.ts` exposes one lazy Prisma client shared through `globalThis` within a process. It connects through `@prisma/adapter-pg` and node-postgres; ordinary queries use `DATABASE_URL`, which must identify `fgmp_app` when `FGMP_REQUIRE_RLS=1`.
- The long-lived process pool remains capped at **3** per Prisma client. Detected serverless/workerd clients remain capped at **1** (and use `maxUses=1`). The configured URL limit cannot raise those hard caps. No pool-size change was made.
- `pool_timeout` and `connect_timeout` are both parsed from the normalized URL and mapped to node-postgres's single `connectionTimeoutMillis` as the stricter deadline. `FGMP_DB_POOL_TIMEOUT` is in seconds. This bounds both socket establishment and queued acquisition because the adapter exposes one setting for both.
- `PrismaPg`'s connected adapter exposes its underlying `pg.Pool`; the app client retains that same pool for process-local stats. This is observation only: it does not create a second connection or change the query path.
- **Code-level budget, not a production total:** for `N` long-lived processes, budget up to `3N` ordinary app connections plus up to `min(configured limit, 3)` for each distinct privileged DSN used per process (default one when no explicit limit is present), plus one-shot jobs/other services. Pools are lazy and actual usage is workload-dependent. The active `N` and provider limit are unknown. The Compose app URL includes `connection_limit=10`, but this adapter path caps the actual pool at 3.

### Privileged clients

- `src/lib/fgmp/owner-db.ts` caches privileged clients per normalized DSN and requests a default pool size of one when the URL has no explicit limit. The adapter still caps any long-lived client at three. These clients are not the ordinary tenant query client.
- `getOpsDb()` currently prefers `FGMP_OPS_DATABASE_URL`, then legacy `FGPS_OPS_DATABASE_URL`, then `FGMP_MIGRATE_DATABASE_URL` for narrowly scoped cross-tenant system work. This is an explicit privileged-operation path, not a fallback from the ordinary `db` client when `DATABASE_URL` fails. Keep it distinct from normal tenant queries; validate whether the legacy/migration-URL fallback is acceptable for each deployed system operation.
- `FGMP_MIGRATE_DATABASE_URL` is for a migration/seed job. `FGMP_OPS_DATABASE_URL` is for explicitly privileged operations such as the documented backup/support work. Neither is the ordinary application URL.

### Tenant context and RLS

`withTenant()` validates the tenant ID and runs a parameterized, transaction-local `set_config('app.tenant_id', ..., true)` inside the interactive transaction used for the protected query. It does not use session-global `SET`. Tests verify concurrent contexts do not bleed across transactions and that rollback/error paths do not poison the next transaction.

In the isolated PostgreSQL 16.2 cluster, catalog inspection returned:

| Role | `rolsuper` | `rolbypassrls` | Use in this assessment |
|---|---:|---:|---|
| `fgmp_app` | false | false | Ordinary app-role checks and reads |
| `fgmp_ops` | false | true | Privileged test/deployment role; not ordinary queries |
| `fgmp_migrate` | true | false | Migration/fixture role in this local cluster only |

A PostgreSQL superuser bypasses RLS even when `rolbypassrls` is false. The `fgmp_migrate` role flags above describe only this isolated cluster; hosted role flags must be verified independently. The application regression authenticated as `fgmp_app`, not as a privileged role.

## Changes made and rationale

Pool limits were intentionally left unchanged because the measured workload did not show a throughput improvement or evidence supporting a different cap.

| Files | Change and reason |
|---|---|
| `src/lib/db.ts`, `src/lib/db.test.ts` | Map the stricter pool/connect timeout to the adapter's actual `pg.Pool` deadline; retain the existing pool caps; capture the real connected app pool for process-local stats; test timeout configuration. |
| `src/lib/observability/metrics.ts`, `src/lib/fgmp/alerting/metrics-wiring.ts`, `src/app/api/fgmp/metrics/route.ts`, `src/lib/fgmp/__tests__/alerting-fires.test.ts` | Publish process-local saturation and total/idle/in-use/waiting/max gauges from the real pool at authorized scrape time; assert saturation behavior. The metrics route remains gated by `ALARM_OPS`. |
| `scripts/verify/db-connection-regression.ts`, `package.json` | Add `test:db-connections`: check the live app role and actual pool, saturate it with read-only concurrent tenant transactions, validate the published gauges, prove the one-second queued-checkout deadline, and prove recovery. |
| `scripts/verify/rls-regression.ts`, `scripts/verify/smoke-postgres.ts` | Use adapter-backed real PostgreSQL clients, check role/catalog values, support concurrent tenant-context checks, and cover rollback/error recovery. Catalog names are cast to text for the installed `pg` decoder. |
| `docker-compose.yml`, `render.yaml`, `scripts/docker-entrypoint.mjs`, `Dockerfile`, `docs/DEPLOYMENT.md` | Keep migration and app credentials separate in declared jobs; add `FGMP_MIGRATE_ONLY=1` for the Render one-shot entrypoint; set the web service to skip migrations and clear an inherited migration URL; clear database URLs from the API-only bridge; avoid connection-string logging. The live Render behavior remains unverified. |
| `docs/DB-CONNECTION-ASSESSMENT.md`, `TASK_LEDGER.md` | Record architecture, results, gaps, changed files, rollout/rollback, and outstanding operator evidence. |

No schema migration, production seed, destructive reset, or production database operation was performed. `bun run db:seed` was run only against the isolated local test database to satisfy existing fixture-dependent tests.

## Before/after controlled load evidence

**Workload:** isolated PostgreSQL 16.2; `fgmp_app`; `FGMP_REQUIRE_RLS=1`; app pool max 3; 180 requests at each concurrency; each request issued a read-only query with a 12 ms PostgreSQL sleep. The same scratch harness/settings were used before and after. After measurements additionally sampled the real app pool. These are controlled local results, not production traffic or a representative application-query mix.

| Concurrent requests | Before req/s | Before p50 / p95 / p99 ms | Before max total / active DB connections | After req/s | After p50 / p95 / p99 ms | After max app connections | After max pool in-use / waiting | After max sampled saturation |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 70.8 | 13.89 / 15.58 / 16.87 | 1 / 1 | 70.6 | 13.93 / 15.33 / 16.69 | 1 | 1 / 0 | 0.333 |
| 6 | 218.1 | 27.15 / 28.24 / 33.12 | 3 / 3 | 214.1 | 27.41 / 29.71 / 34.47 | 3 | 3 / 3 | 1.000 |
| 18 | 219.2 | 81.16 / 84.23 / 85.45 | 3 / 3 | 217.4 | 82.17 / 83.80 / 84.53 | 3 | 3 / 15 | 1.000 |

**Interpretation:** throughput plateaus near the three-connection cap for concurrency 6 and 18. The small before/after differences are inconsistent and not statistically established as gains; they are treated as noise. High-concurrency latency and the waiting-client counts show queuing. There is **no measured material performance improvement** and no evidence to increase the cap. Provider-side connection totals, CPU, and production latency are unknown.

## Real PostgreSQL regression results

| Check | Result |
|---|---|
| `test:db-connections` | Passed on isolated PostgreSQL 16.2 as `fgmp_app`; `rolsuper=false`, `rolbypassrls=false`; 39 FORCE-RLS tables. Initial pool snapshot: total 1, idle 1, in-use 0, waiting 0, max 3. |
| Saturation under concurrent tenant transactions | Passed: actual pool 3/3 in-use, 3 waiting, saturation ratio 1; the exported gauge matched the pool snapshot. No query writes were used. |
| Timeout and recovery | Passed: one-connection pool with `pool_timeout=1s`, `connect_timeout=5s`; a real queued `pg.Pool.connect()` rejected after 1001 ms while PostgreSQL held the sole connection; a follow-up Prisma query succeeded. |
| `test:rls` | 246 passed, 0 failed, 0 blocked. 39 tenant-ID tables had RLS enabled and forced; no tenant tables were missing FORCE. Includes concurrent tenant context, cross-tenant denial, rollback, post-error recovery, and geography/view checks. |
| `test:smoke` | Passed after test-only seeding. Temporary fixture cleanup left the seeded-site count unchanged at 52. The test emitted a `pg@8` warning about `client.query()` while another query was executing through `@prisma/adapter-pg`. |
| Full `bun test` | 863 passed, 0 failed across 49 files, after seeding only the isolated local test DB. |
| `bun test src/lib/db.test.ts` | 22 passed, 0 failed. |

The actual application role and test results above are real PostgreSQL evidence. They do not prove production provider configuration, production role flags, or production migration-history state.

## Build, configuration, and deployment verification

- `bun run typecheck` passed after the final TypeScript change (wiring the saturation test into `main()`). A current-workspace rerun could not start because the temporary Bun binary and `node_modules` were no longer present; the subsequent changes were JavaScript, YAML, Dockerfile comments, and documentation.
- `bun run lint` last failed with 28 errors and 3 warnings; it was not rerun after the final integration/deployment edits. Lint is not reported as passing.
- `bun run build` and its temporary Prisma-config retry failed while fetching the Prisma schema engine/checksum due TLS. A direct Next build compiled, but the TypeScript worker was SIGKILLed after about 423 seconds. No successful build is claimed.
- `bun run check:env` failed because `DATABASE_URL` and `NEXTAUTH_SECRET` were not set in that environment; optional-variable warnings were also emitted.
- Frozen Bun installs failed with TLS/connection errors. An npm fallback supplied the temporary test dependencies, but lockfile consistency was not proven; the installed Prisma/adapter versions were inspected. The temporary Bun binary and dependencies are no longer in the current workspace.
- The final `render.yaml` and `docker-compose.yml` parse as YAML, and static assertions passed for the Render role boundaries. `node --check scripts/docker-entrypoint.mjs` and temporary dispatch checks passed: migration-only mode remaps then exits; skip-migrate fails closed without `DATABASE_URL` even if a migration credential is present. These do not substitute for a live container/Render deployment or real migration run.

## Metrics and observability status

- `GET /api/fgmp/metrics` samples the real app-process `pg.Pool` counters only after its existing `ALARM_OPS` authorization. The sample issues no SQL and opens no additional connection.
- `fgmp_db_pool_saturation_ratio` and `fgmp_db_pool_connections{state=total|idle|in_use|waiting|max}` are process-local gauges. They are refreshed on an authorized scrape; the service has not been externally scraped in this assessment. Scrape each instance and aggregate outside the process for a deployment-level view.
- The real saturation regression confirmed the gauge reached `1` with three checkouts and queued clients.
- These gauges are not database-wide connection counts and are not a query-latency histogram. `fgmp_db_query_errors_total` remains declared but is not wired to a verified query-error source. Production acquisition wait, P2024/adapter timeout rate, HTTP latency, and database CPU are not measured here.

## Hyperdrive decision

**No Hyperdrive implementation is warranted or eligible now.** The configured Render Docker/Node path has no Cloudflare binding. The optional Cloudflare Worker path is not confirmed active, declares no `HYPERDRIVE` binding in `wrangler.jsonc`, and has a locked Next/OpenNext support mismatch. Do not inject a Cloudflare binding into Node, route ordinary queries through a new pooler, or migrate infrastructure on this evidence. Reassess only after the active runtime, database endpoint, provider-supported adapter, and RLS transaction-context behavior are verified.

## Verified setup and environment-variable purposes

### Safe role split

| Variable | Purpose and boundary |
|---|---|
| `DATABASE_URL` | Ordinary web/API Prisma client only; must authenticate as `fgmp_app` with RLS enforced. No privileged fallback if it is absent or fails. |
| `FGMP_MIGRATE_DATABASE_URL` | Schema migrations and explicit seed jobs only. It must not be the ordinary app URL. Render's migration job receives this URL; its entrypoint maps it to `DATABASE_URL` only for Prisma's migration subprocess and exits. |
| `FGMP_OPS_DATABASE_URL` | Explicitly privileged system operations that require cross-tenant access; do not use it for ordinary tenant queries. The current code also recognizes legacy `FGPS_OPS_DATABASE_URL`. |
| `FGMP_REQUIRE_RLS=1` | Fail closed when the configured ordinary DB URL is not recognized as `fgmp_app`; real PostgreSQL regression also checks the authenticated role attributes. |
| `FGMP_DB_CONNECTION_LIMIT` | Optional per-client URL cap override; runtime hard cap remains 3 for long-lived processes or 1 for detected serverless/workerd. Do not raise without a measured provider budget. |
| `FGMP_DB_POOL_TIMEOUT` | Optional pool acquisition deadline in seconds; mapped with `connect_timeout` to the stricter `pg.Pool` deadline. |
| `FGMP_SKIP_MIGRATE=1` | Web-service mode after a separate migration job. Discards any inherited migration URL, then runs schema preflight with the app URL only; does not apply DDL or fall back to a privileged URL. |
| `FGMP_MIGRATE_ONLY=1` | One-shot migration-job mode. Applies migrations through the dedicated URL, then exits without seeding or starting the web server. Mutually exclusive with `FGMP_SKIP_MIGRATE=1`. |

`render.yaml` now declares a separate `fgmp-migrate` job without the shared app environment group; the job receives only `FGMP_MIGRATE_DATABASE_URL` and `FGMP_MIGRATE_ONLY=1`. The `fgmp-app` web service sets `FGMP_SKIP_MIGRATE=1` and a service-level empty migration-URL value, which takes precedence over an identically named group variable. The API-only bridge clears `DATABASE_URL`, `FGMP_MIGRATE_DATABASE_URL`, `FGMP_OPS_DATABASE_URL`, and legacy `FGPS_OPS_DATABASE_URL`. YAML syntax and static variable-boundary assertions passed locally: the web service skips migration and clears the inherited migration URL, the migration job alone receives that URL, and the API-only bridge clears all database URLs. The Render account, effective environment values, image startup, and actual job completion were not available for verification.

For Compose, the checked-in `fgmp-migrate` and `fgmp-seed` commands require `FGMP_MIGRATE_DATABASE_URL` and scope `DATABASE_URL` to it only for the Prisma migration subprocess. The ordinary `fgmp-app` service remains on `fgmp_app`; no privileged URL fallback was added. A live Docker/Compose deployment was not run in this assessment.

## Controlled rollout and rollback

### Before a staged rollout

1. Confirm the active runtime, PostgreSQL provider, endpoint/pooler mode, connection allowance, instance count, TLS requirements, and real role attributes with the operator/provider. Do not infer these from this repository.
2. In staging, inspect **effective** Render environment variables (not only `render.yaml`): the web service must have `DATABASE_URL=fgmp_app` and no migration URL; only the one-shot migration job should receive `FGMP_MIGRATE_DATABASE_URL`; the API-only bridge should have no direct DB URLs. Give `FGMP_OPS_DATABASE_URL` only to a service that uses the explicit privileged helpers.
3. Run the one-shot migration job and verify it applies pending migrations (or no-ops when current) then exits, without starting the web server or running seeds. The code-path check used a temporary Prisma CLI stub to verify role remapping and exit behavior; it did **not** run real `prisma migrate deploy`.
4. Run the connection, RLS, and smoke regressions against an isolated/staging copy. Do not run test seeds or destructive checks against production.
5. Record a production/staging baseline for DB total/active sessions, pool saturation/waiting per instance, request latency percentiles, timeout/query errors, DB CPU, and workload/concurrency before changing any pool setting. `GET /api/fgmp/metrics` requires an authorized `ALARM_OPS` scrape.

### Rollout

- Use a staging/canary instance first. Keep the existing pool cap; the controlled test shows queueing but not a throughput gain from a pool-size change.
- Apply backward-compatible migrations with the migration job before the web deployment. Start the web service with `FGMP_SKIP_MIGRATE=1`, `FGMP_REQUIRE_RLS=1`, and only the app URL for ordinary queries.
- Scrape each instance and compare identical workload/measurement windows. Expand only if role/RLS checks pass, latency/error rates remain acceptable, and database/provider headroom is proven.

### Rollback

- This change set has no schema migration; application rollback is a redeploy of the prior image/configuration. Keep `DATABASE_URL` on `fgmp_app`; never “fix” a failed app connection by switching to ops/migrate/owner credentials or disabling RLS.
- If the new pool deadline causes unexpected timeout behavior, restore the previously known timeout configuration or redeploy the previous image, then investigate provider/network latency. Do not raise `connection_limit` blindly.
- A migration-job failure is a stop condition: leave the web service on the prior image and resolve the migration/job configuration. Do not start the web app against an unverified schema. Treat any future schema rollback as a separately reviewed forward-fix/manual recovery plan.

## Remaining risks and assumptions

1. Live platform/provider, database endpoint, pooler, provider limit, instance count, and production role flags remain unknown.
2. Before/after measurements are a single controlled local stress run with a simple sleeping query; not a statistically powered benchmark or production workload.
3. Metrics are process-local and have not been scraped over HTTP; query-error and latency metrics are not yet fully wired.
4. The test cluster's manual SQL application left no Prisma migration history; the normal migration engine's TLS download failed, so migration deployment remains unverified.
5. `getOpsDb()` still has legacy and migration-URL fallbacks for explicitly privileged system work. This is not the ordinary `db` fallback, but each such use must remain narrowly scoped and its production role needs verification.
6. Render environment-group contents and one-shot job behavior are not live-verified. The local entrypoint control-flow test did not run a real migration.
7. `bun run lint` is currently failing with 28 errors and 3 warnings from the last completed run; it was not rerun after the final integration-script/deployment edits. `bun run build` did not complete because Prisma engine downloads failed TLS; a direct Next build compiled but its TypeScript worker was SIGKILLed. See `TASK_LEDGER.md` for exact results.
8. The `pg@8` overlapping-query deprecation warning remains in the smoke path.

See [`TASK_LEDGER.md`](../TASK_LEDGER.md) for the ordered execution record and verification status.
