# TASK_LEDGER — FGMP1 PostgreSQL connection assessment

**Branch:** `arena/ea5864e5-fgmp1` (active) · **Starting commit:** `c19c2cff77051285a0c7815dfc7101866b1e5e76` · **Assessment date:** 2026-10-24 (Asia/Aden)
**Full report:** [`docs/DB-CONNECTION-ASSESSMENT.md`](docs/DB-CONNECTION-ASSESSMENT.md)

## Mission and constraints

Audit FGMP1's PostgreSQL connection architecture and improve only where evidence supports it. Preserve `fgmp_app` for ordinary queries, RLS/tenant isolation, data integrity, and deployment boundaries. Keep migration and ops credentials separate from ordinary app access; never fall back to a privileged URL when the app URL fails. Verify runtime/provider from evidence, do not assume Render or Cloudflare, do not introduce a Hyperdrive binding into Node, and do not use mocks in place of required real database tests. No production seed, reset, destructive operation, or unreviewed schema change is allowed.

## Status summary

- [x] Phase 1 — inspect repository/runtime/provider configuration and write the initial architecture report before implementation.
- [x] Phase 2 — collect controlled before measurements and real isolated-PostgreSQL evidence.
- [x] Phase 3 — fix the measured `pool_timeout` adapter-mapping defect and expose actual pool gauges. Pool size was not changed.
- [x] Phase 4 — evaluate Hyperdrive; not eligible on verified evidence because no active Cloudflare runtime/binding is established and the locked Cloudflare/Next versions do not establish compatibility.
- [x] Phase 5 — exercise tenant context, rollback/error recovery, real app role, timeout/recovery, and saturation against isolated PostgreSQL.
- [x] Phase 6 — run available regressions/typecheck, parse deployment YAML, and record lint/build limitations.
- [ ] Phase 7 — validate effective production/staging provider configuration and perform a staged rollout/rollback. Blocked: no live provider, Render environment, or authorized metrics scrape is available.

**Performance conclusion:** no material improvement. The app's three-connection pool plateaus under concurrency; high-concurrency latency reflects queueing. No cap change is recommended from these results.

## Architecture findings

- `render.yaml` declares a Render Docker web service, migration job, and IoT bridge. `Dockerfile` builds a standalone Next.js server run with Bun; `src/instrumentation.ts` declares Node.js. This describes a target, not a verified active deployment.
- An optional OpenNext/Cloudflare path also exists, but no Wrangler Hyperdrive binding is configured and the active runtime is unknown. The resolved Next.js 16.1.3 does not match the locked OpenNext Cloudflare package's declared supported range. No Cloudflare/Hyperdrive code was added.
- The live database provider, endpoint, pooler, provider limit, instance count, and production metrics are unknown.
- Ordinary application queries remain on the lazy process-shared Prisma client using `DATABASE_URL`/`fgmp_app`. Long-lived pools remain capped at 3 per client; serverless/workerd at 1. No pool size change was made.
- `pool_timeout`/`connect_timeout` now map to the stricter `connectionTimeoutMillis` supported by the locked `@prisma/adapter-pg`/`pg` stack. The actual app `pg.Pool` is retained for read-only, process-local metrics.
- `getOpsDb()` still supports `FGMP_OPS_DATABASE_URL`, a legacy ops alias, and then `FGMP_MIGRATE_DATABASE_URL` for explicit privileged system operations. This is not the ordinary app client fallback. Keep those uses scoped and verify whether the legacy/migration credential fallback is acceptable in each deployed service.

## Controlled before/after workload

**Setup:** isolated PostgreSQL 16.2; `fgmp_app`; `FGMP_REQUIRE_RLS=1`; pool cap 3; 180 read-only requests per concurrency level; 12 ms PostgreSQL sleep per request. Same scratch harness/settings before and after. After run sampled the actual app pool. This is local synthetic stress evidence, not production or a representative query mix.

| Concurrency | Before req/s; p50/p95/p99 ms | Before max total/active connections | After req/s; p50/p95/p99 ms | After max app connections | After max pool in-use/waiting; saturation |
|---:|---:|---:|---:|---:|---:|
| 1 | 70.8; 13.89/15.58/16.87 | 1/1 | 70.6; 13.93/15.33/16.69 | 1 | 1/0; 0.333 |
| 6 | 218.1; 27.15/28.24/33.12 | 3/3 | 214.1; 27.41/29.71/34.47 | 3 | 3/3; 1.000 |
| 18 | 219.2; 81.16/84.23/85.45 | 3/3 | 217.4; 82.17/83.80/84.53 | 3 | 3/15; 1.000 |

Differences are small/inconsistent and not statistically established as gains. Throughput plateaus near the configured cap at concurrency 6 and 18; queued clients and higher latency show pool wait. Do not claim an improvement or raise the cap based on this run.

## Real database/security evidence

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

## Files changed and reasons

- `src/lib/db.ts`, `src/lib/db.test.ts`: wire the adapter's real pool timeout; retain existing caps; capture actual pool stats; test the timeout mapping.
- `src/lib/observability/metrics.ts`, `src/lib/fgmp/alerting/metrics-wiring.ts`, `src/app/api/fgmp/metrics/route.ts`, `src/lib/fgmp/__tests__/alerting-fires.test.ts`: add process-local pool saturation and connection-state gauges, sample them at authorized `ALARM_OPS` scrape time, and test alert behavior.
- `scripts/verify/db-connection-regression.ts`, `package.json`: add `test:db-connections` for actual-role, pool saturation, gauge publication, checkout timeout, and recovery checks.
- `scripts/verify/rls-regression.ts`, `scripts/verify/smoke-postgres.ts`: adapter-backed real-PG coverage, role/catalog checks, concurrent transaction context, rollback, and recovery.
- `docker-compose.yml`, `render.yaml`, `scripts/docker-entrypoint.mjs`, `Dockerfile`, `docs/DEPLOYMENT.md`: separate migration/app paths; add explicit Render migration-only and app skip-migrate modes; clear shared database URLs from non-DB bridge; avoid printing connection strings. Render behavior still needs staging verification.
- `docs/DB-CONNECTION-ASSESSMENT.md`: final evidence-based architecture/performance/security report.
- `TASK_LEDGER.md`: this execution record and pending work.

No schema migration, connection-limit increase, or production data change was made.

## Validation and limitations

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

## Deployment variables and boundaries

- `DATABASE_URL`: ordinary application traffic only; `fgmp_app`/RLS.
- `FGMP_MIGRATE_DATABASE_URL`: migration/seed jobs only; no ordinary query fallback.
- `FGMP_OPS_DATABASE_URL`: explicit privileged system operations only; not ordinary tenant queries.
- `FGMP_REQUIRE_RLS=1`: fail closed for an ordinary URL not recognized as `fgmp_app`.
- `FGMP_DB_CONNECTION_LIMIT`: optional cap override; keep current hard cap absent a provider budget.
- `FGMP_DB_POOL_TIMEOUT`: optional acquisition deadline in seconds, combined with `connect_timeout` using the stricter value.
- `FGMP_SKIP_MIGRATE=1`: web service after the migration job; entrypoint drops any inherited migration URL, preflights using `DATABASE_URL`/`fgmp_app` only, and starts without DDL or privileged fallback.
- `FGMP_MIGRATE_ONLY=1`: one-shot job; applies migrations, exits, does not seed/serve.

The Render web service now sets the app URL separately, clears the migration URL at service scope, and skips migration; the migration job no longer imports the shared `fgmp1` group and receives only the migration URL plus migration-only mode. The IoT bridge is API-only and clears all database URLs. Verify the effective live variables before deploying.

## Rollout / rollback plan

1. Before staging, establish the active runtime/provider, database endpoint/pooler, DB connection allowance, instance count, and hosted role flags. Capture production-like pre-change connection/latency/error/DB CPU metrics.
2. In staging, verify the effective role split and run the migration-only job; confirm it exits without seeding or starting the server. Run `test:db-connections`, `test:rls`, and smoke against an isolated/staging database.
3. Canary the web service with `FGMP_SKIP_MIGRATE=1`, `FGMP_REQUIRE_RLS=1`, and `DATABASE_URL=fgmp_app`. Keep the pool cap unchanged; scrape each process through the authorized metrics route and aggregate externally.
4. If role/RLS checks fail, timeouts/errors rise, or database headroom is insufficient, stop rollout and redeploy the previous app/configuration. Do not switch ordinary queries to ops/migrate/owner credentials or turn off RLS.
5. This change set has no schema migration. For future migration failures, leave the previous web image running and resolve forward; schema rollback requires its own reviewed recovery plan.

## Outstanding work / operator evidence needed

1. Confirm active runtime, provider, endpoint/pooler mode, connection limits, instance count, and actual role attributes.
2. Verify updated Render Blueprint behavior and effective environment variables in staging; confirm the app/bridge do not receive privileged database URLs and the migration job exits cleanly.
3. Run an authorized HTTP scrape on each deployed process and validate monitoring/aggregation.
4. Rerun lint and build in a functioning, lock-consistent toolchain with access to Prisma engines; review existing lint errors separately.
5. Compare a representative staged workload using the same before/after method. Current local measurements show no gain.
6. Decide in a separate security review whether `getOpsDb()`'s explicit legacy/migration credential fallbacks should be narrowed further.

Do not mark the task as a production performance success until the provider/runtime evidence, staged rollout, and authorized metrics are available.
