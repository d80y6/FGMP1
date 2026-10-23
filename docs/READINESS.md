# Production-readiness record

What was broken, what was changed, how it was verified, and what remains
external. This is a record of an audit and a remediation pass, not a marketing
claim: every item below was executed in this checkout, and the items under
§8 — plus the last paragraph of §10 — are genuinely not done.

## 1. The build did not work

| Defect | Why it mattered | Fix |
|---|---|---|
| `next/font/google` downloaded Geist, Geist Mono and Cairo from `fonts.googleapis.com` during `next build` | The production build failed offline, in an air-gapped runner, or whenever Google was slow — and the error looked like a code failure (`Turbopack build failed`) | Fonts vendored under `src/app/fonts/` (woff2, ~270 KB) and declared in `src/app/fonts.css`. Cairo ships per-subset files, so `unicode-range` keeps Arabic and Latin glyphs in their own faces |
| `config/alerts.json` is read with `fs` at request time; standalone output traces modules, not data files | `/api/fgmp/ops/alerts/preview` would throw **in the container** while working in dev | `outputFileTracingIncludes` in `next.config.ts` **and** an explicit `COPY config` in the Dockerfile (they cover different build paths) |
| The tracer pulled the whole repository into the standalone output because of that `readFileSync` | Oversized image and a build warning pointing at a real problem | `turbopackIgnore` on the call, with the file shipped explicitly |

**Verified:** `next build` completes; `.next/standalone/config/alerts.json`
exists; fonts are emitted into `.next/static/media/*.woff2`.

## 2. The process did not fail closed

There was no environment validation at all. A missing `NEXTAUTH_SECRET` surfaced
as `JWEDecryptionFailed` at login; a missing `IOT_API_KEY` rejected every device
telemetry silently; a `DATABASE_URL` pointing at the owner role disabled every
RLS policy while the UI stayed green.

`src/lib/env.ts` now validates at boot (`instrumentation.ts`):

* **errors** stop the process — missing/invalid `DATABASE_URL`, missing or short
  `NEXTAUTH_SECRET`, short `IOT_API_KEY`/`FGMP_MFA_ENCRYPTION_KEY`,
  `FGMP_REQUIRE_RLS=0` in production, partially configured Apinator credentials;
* **warnings** are printed and the server starts — no realtime credentials, no
  MFA key, no service token. Each degrades one feature; none is unsafe;
* **no value is ever printed**, only names and verdicts.

The first implementation threw from `register()`. That is **not** fail-closed:
Next logs "Failed to prepare server", marks the hook failed and keeps the port
open, so an orchestrator sees a healthy socket on a process that will 500 every
request. The hook now calls `process.exit(1)`.

**Verified:** booting the standalone server without a secret exits 1 with a
readable list; booting with a valid environment logs 4 warnings and serves.

## 3. Nothing could health-check it

`/api/fgmp/health` is ADMIN-only (process memory, table counts, error ring
buffer) — correctly so. But the compose healthcheck probed it and treated *any*
response as success, the Render blueprint had `healthCheckPath` commented out,
and the CI boot test used `wget ... || true`, which cannot fail.

Two unauthenticated probes now exist:

| Route | Answers | Status |
|---|---|---|
| `/api/health/live` | is the process serving HTTP (no database) | always 200 while alive |
| `/api/health/ready` | can it reach PostgreSQL **and** has the schema been migrated | 200 / 503 with a coarse reason |

The readiness body carries only `{status, reason}`. It is wired into the
Dockerfile `HEALTHCHECK`, the compose healthcheck, `render.yaml`
(`healthCheckPath`) and the CI container boot test, which now asserts
`"status":"ready"`.

**Verified:** against a real standalone server — `live` 200,
`ready` 503 `db_unreachable` with no database, `fgmp/health` 401 unauthenticated.

## 4. The web surface had no failure UI

There was no `error.tsx`, `global-error.tsx`, `not-found.tsx` or `loading.tsx`,
so a render failure showed Next's bare "Application error" page with no retry and
no correlation id. All four are added; the route error logs the digest, which is
the only identifier that ties a browser render to a server stack trace.

## 5. Two charts were drawing numbers nobody measured

`site-health-trend.tsx` rendered a "7-Day Trend" line whose last point was the
real score and whose previous six were `Math.sin(seed)` noise around it — and
then summarised that invented series as **7-Day Avg**, **Trend (Δ)** and **Best
Day**. `region-performance-trend.tsx` did the same per region, and reported
**Most Improved +N pts** and **Declining −N pts** from the difference between
today's score and an invented D-6.

The README states the platform does not fabricate telemetry, and the analytics
forecast had already been fixed for exactly this (it multiplied by
`0.9 + Math.random() * 0.2`). An operator had no way to tell these three numbers
from measurements — which is the definition of the thing the README promises not
to do.

Both are gone. `site-health-card.tsx` replaces the site widget with what is
measurable: the canonical score (the same function the badge, the region sheet
and the dashboard call) plus its five weighted factors, each labelled with the
weight that produced the number. The region trend card was deleted outright —
its only real content was today's score per region, which the leaderboard
directly below it already ranks, with the same scorer.

Two i18n keys were added (`detail.health`, `detail.healthLive`) so the
"no history is stored" statement is translated rather than English-only.

## 6. Security hardening

* **CSP is now environment-aware.** Production no longer allows
  `script-src 'unsafe-eval'`, and `connect-src` is limited to the app origin plus
  `*.apinator.io` instead of `ws:`/`wss:` wildcards. Dev keeps the permissive
  policy HMR needs. `object-src 'none'`, `base-uri 'self'` and
  `form-action 'self'` added.
* `X-Powered-By` disabled.
* CI's container assertions were checking for **24** FORCE-RLS tables when the
  migrations create **36**, so that check failed (or would have passed only by
  accident had it been `-ge`). It now asserts `>= 36`.
* `render.yaml` no longer gives the web service the schema-owner URL; migrations
  run in a `fgmp-migrate` job, and `FGMP_REQUIRE_RLS` is `1` instead of `0`.

## 7. Quality gates

| Gate | Before | After |
|---|---|---|
| `next build` | **fails** (Google Fonts) | passes, standalone output verified |
| `npx tsc --noEmit` | 0 errors | 0 errors |
| `npx eslint .` | 24 errors / 443 warnings | **0 errors / 0 warnings** |
| `bun test` | 699 pass / 14 fail | **747 pass / 0 fail** (13 skipped without a database) |
| Dependency count | 78 production | **47** production, lockfile regenerated |

The 14 failures were not flaky: they were database-backed suites (RLS row
hiding, MFA challenge resolution, command persistence) failing on a machine with
no PostgreSQL. They now skip with a loud banner when `DATABASE_URL` is absent,
and `FGMP_REQUIRE_DB_TESTS=1` turns that skip into an error — CI sets it in the
job that provisions PostgreSQL, and `bun test` now actually runs there. A
1000-package supply chain (416 transitive packages from unused UI libraries:
`@mdxeditor`, CodeMirror, `@tanstack/*`, `framer-motion`, `next-intl`, `sharp`,
`uuid`, `z-ai-web-dev-sdk`, …) was removed from `package.json` and `bun.lock`;
`bun install --frozen-lockfile --dry-run` accepts the result and a static scan
confirms every bare import resolves to a declared dependency.

One real test bug was fixed: a metrics assertion assumed a fresh registry, so it
failed whenever another suite had already incremented the `login/degraded_closed`
series. It now uses a label pair unique to that test.

Two more defects were found by making the gates trustworthy rather than green:

* **A test suite that re-imported the module under test.** The session-lifetime
  tests called `import("./auth?cfg=" + Math.random())` and relied on Bun
  re-evaluating the module. Run alone they passed; in the full suite a stale
  evaluation leaked `updateAge === maxAge` into the next case and failed for a
  configuration nobody had set. The configuration now lives in
  `src/lib/auth-session.ts` and is a pure function of an env object.
* **Importing the database layer could fail.** `new PrismaClient()` starts
  loading the query-engine binary in the background; when that binary is absent
  the load rejects asynchronously. In practice it aborted an entire 45-test file
  at import (reported as "0 pass", with no failing test) and printed a
  PrismaClientInitializationError during `next build`. `db` is now a Proxy over
  a client constructed on first USE, so importing is inert and a process that
  never queries never opens a pool.

All four rule families that carried the original 302 warnings are now at zero
and enforced as **errors** in CI:

* **`react-hooks/exhaustive-deps` (25 → 0).** Every site was either a genuine
  missing dependency or an unstated one. The `const sites = snapshot?.sites ?? []`
  pattern rebuilt a fresh array on every render and invalidated every downstream
  `useMemo`, so those now derive from one memo; `effect` sites that read a value
  they deliberately did not key on either gained the dependency (a no-op when it
  agrees) or, in the five asset-registry dialogs, carry an explicit
  `eslint-disable-next-line` that states why re-seeding on the 5 s poll would
  wipe the operator's typing.
* **`react-hooks/purity` (13 → 0).** `Date.now()` in a render body or a `useMemo`
  makes the same inputs produce different output depending on when React runs.
  All 13 now read the shared clock in `src/lib/fgmp/use-now.ts` (`useSyncExternalStore`
  over one interval per cadence, 30 s for coarse labels and 5 s for the
  suppression countdown that replaced its own timer, idle when nothing subscribes,
  server snapshot `0` so hydration matches).
* **`@typescript-eslint/no-non-null-assertion` (184 → 0).** 81 were `arr[i]!`
  on an array, which `tsc` does not even need without `noUncheckedIndexedAccess`
  — verified by deleting them and compiling. The rest were real: `map.get(k)!`
  after `has()`, `process.env.X!`, a session fetched from the registry it was
  just written to, six engine lookups that would have thrown a `TypeError` on an
  orphaned asset. Each is now a `let` bound to the lookup, or an explicit guard
  that skips the asset with a comment rather than crashing the tick. Test files
  and `scripts/verify/` are exempted in `eslint.config.mjs`: a non-null assertion
  on a fixture is a statement about the test's own data, and a wrong one fails
  the test.

* **`@typescript-eslint/no-explicit-any` (77 → 0).** Every remaining site was a
  view consuming a `useApi<any>` payload and then re-annotating each callback
  parameter as `any`. The payloads are now declared in `src/lib/fgmp/types.ts`
  (`AlarmRow`, `AnalyticsPayload`, `SiteDetailPayload`, `DeliveryRow`,
  `MaintenanceTicketRow`, `AuditLogRow`, `ReportsPayload`, …) and read from the
  route handlers rather than guessed. This was not cosmetic: typing
  `SiteDetailPayload` immediately exposed a live defect — the battery trend
  chart summed `h.c` from history rows that only carry `soc`, and the `?? 0`
  swallowed it, so the charge line had been a flat zero for every battery for
  as long as the chart has existed. `bun test` could not see it; the type gate
  could, once the array stopped being `any[]`.

`eslint .` now prints nothing at all: no errors, no warnings, on the whole
repository, and CI runs it that way. Rules that are off are off on purpose and
say so in the config.

## 8. Not reproducible on this machine, and deliberately not decided here

The first two rows are executed by CI on every push and are currently green.
They are listed because they cannot be reproduced in the development sandbox
that wrote this document, not because they are unverified.

| Item | Why it is not done |
|---|---|
| **The Prisma query path, locally** | PostgreSQL itself turned out to be obtainable in this sandbox (see §10), but `prisma generate` cannot download a query engine (`binaries.prisma.sh` is unreachable), so no Prisma client here can execute a query. CI executes that instead, against `timescale/timescaledb:latest-pg17`, and the `rls` job is green: 24 migrations applied, seed written as the owner role, smoke test, database-backed suites with `FGMP_REQUIRE_DB_TESTS=1`, and the RLS regression suite. The Dockerfile also **fails the build** if `prisma generate` produced no engine, because that image would build cleanly and then fail on its first query. |
| **Docker image build/boot, locally** | No Docker daemon here. CI's `docker` job builds the image, boots it against PostgreSQL, and asserts `/api/health/ready` is 200, at least 36 tables are FORCE-RLS, the container is non-root and no `.env` was baked in. Green.|
| **Real device transports** | No Modbus/MQTT hardware is configured; `NO_TRANSPORT` is the honest answer. Wiring serial/TCP gateways is a deployment decision, not a code fix. |
| **`SensorReading` retention** | TimescaleDB retention/compression policy is a capacity decision (how long telemetry is kept) and must be agreed, not guessed. |
| **Object storage for exports/backups** | Backups currently land in a volume. Off-host storage needs a bucket and credentials. |
| **Alert delivery** | `notification-dispatch.ts` encodes the correct status model but is not wired into `POST /api/fgmp/notifications`, which writes `SENT` directly. Wiring it changes operator-visible notification semantics, so it is a product decision. |
| **MFA encryption key** | Must be generated per deployment (`openssl rand -base64 48`) and kept stable; the app warns, it cannot invent one. |
| **Redis** | Optional. A `fgmp-redis` service is in compose; without it the limiter degrades to per-process counters and reports `fgmp_rate_limit_degraded=1`. |

## 9. How to reproduce the verification

```bash
bun install --frozen-lockfile
bun run check:env          # expect errors in a bare checkout — that is the point
bunx prisma generate       # needs a query engine binary (see §8)
npx tsc --noEmit           # 0 errors
npx eslint .               # 0 errors, 0 warnings
bun test                   # 0 fail without a database (some suites skip)
bun run build              # standalone output
```

With PostgreSQL (compose or CI). Migrations and the seed both use the OWNER
credential; the app itself never receives it:

```bash
FGMP_MIGRATE_DATABASE_URL=postgresql://fgmp_migrate:… bun run db:deploy
FGMP_MIGRATE_DATABASE_URL=postgresql://fgmp_migrate:… bun run db:seed
FGMP_REQUIRE_DB_TESTS=1 bun test
bun run test:rls
bun run test:smoke
```

## 10. What was checked by hand, outside CI

CI is the authority for the database and container jobs, but two things turned
out to be checkable in a bare sandbox, and both found something.

**PostgreSQL 16.2, all migrations, and the RLS policies.** `pip install pgserver`
ships PostgreSQL binaries, so a cluster was started on port 5433, the three
roles were provisioned with `scripts/db/pg-init-roles.sh`, and every
`prisma/migrations/*/migration.sql` was applied in order with
`psql -v ON_ERROR_STOP=1`:

```
applied=24 failed=0
42 public tables, 51 policies
```

The policies were then exercised as `fgmp_app`, the role the web app uses:

```sql
-- no app.tenant_id in scope
select count(*) from "User";   -- 0
select count(*) from "Site";   -- 0
insert into "User" (…) values (…, 't1', …);
-- ERROR: new row violates row-level security policy for table "User"

-- with app.tenant_id set
begin; set local app.tenant_id = 't1';
insert into "User" (…) values (…, 't1', …);   -- passes the policy
rollback;
```

That is the property the architecture depends on, checked against a real
PostgreSQL rather than read off the migration text.

**The production server.** `bun run start` on the standalone output, with a real
`NEXTAUTH_SECRET` and the sandbox database:

| Request | Result |
|---|---|
| `/api/health/live` | `200 {"status":"live","uptimeSeconds":…}` |
| `/api/health/ready` | `503 {"status":"not_ready","reason":"db_unreachable"}` — correct here, the engine is missing (§8) |
| `/` | `200`, with CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` |
| every `/api/fgmp/*` route | `401 {"error":"Unauthorized"}` without a session |

The boot log also showed the two fail-closed behaviours working: the env
validator listed its warnings, and the scheduler refused to fabricate telemetry
because `NODE_ENV=production`.

**The defect this found.** `/api/fgmp/users`, `/api/fgmp/users/[id]` and
`/api/fgmp/users/[id]/reset-password` called `bootstrap()` *before*
`requireRole()`. Bootstrap runs `engine.ensureAllTenants()`, so when the
database is unreachable it throws — and an unauthenticated request to those
three routes returned `500` while every other route returned `401`, which reads
like a server fault rather than "log in". Authorisation now happens first, and
all three answer `401` (verified against the rebuilt server).

**The RLS gate was checked against a hosted-style connection string.** Pointing
`DATABASE_URL` at a pooler-shaped URL (`fgmp_app.<project-ref>@…`) with
`FGMP_REQUIRE_RLS=1` boots; pointing it at the same host with the owner role
exits 1 and prints the host and role. That check found two defects of its own:

* `assertRlsEnforced()` ran only when something imported the database layer. In
  a production process nothing does that at boot — the scheduler is the only
  boot-time consumer and it is disabled in production — so a bypassing
  `DATABASE_URL` produced a healthy socket, a working sign-in screen and a 500
  on the first data request. It is now also called from `instrumentation.ts`,
  which is what makes `FGMP_REQUIRE_RLS=1` mean "refuses to start".
* its failure message began with the raw `DATABASE_URL`. That message is printed
  at boot, i.e. into the container log — so the password went with it, one line
  above the `Detected role:` field that existed precisely to redact it. The
  message now names the host and the role only, and `db.test.ts` asserts that
  the credential cannot appear.

**Still not checked by hand:** anything that goes through Prisma — every
authenticated view, and the seed — for the engine reason above. The
authenticated UI therefore remains a CI-and-review claim, not an observed one.

## 11. Provisioning a hosted database, and platform administration

Two things were added after the sections above, both prompted by the question
"can this be made ready without access to the database from this sandbox?".

**A SQL provisioning path (`scripts/supabase/`).** Four scripts take a fresh
hosted PostgreSQL — Supabase, RDS, anything without Docker — to a working,
populated, tenant-isolated deployment:

| file | what it does |
|---|---|
| `01-roles.sql` | creates `fgmp_app` (DML only), `fgmp_ops` (`BYPASSRLS`), `fgmp_migrate` (owns the schema); grants `CREATE` on `public` (PostgreSQL 15+ makes it owned by `pg_database_owner`); sets default privileges for **both** `fgmp_migrate` and `postgres`; asserts the resulting posture |
| `02-schema.sql` | GENERATED from `prisma/migrations` (25 migrations); runs under `set role fgmp_migrate` so a later `prisma migrate deploy` as that role can `ALTER` the tables; records all 25 migrations in `_prisma_migrations` with Prisma's own sha256 checksums, so a subsequent `migrate deploy` is a no-op; revokes the bookkeeping table from both application roles |
| `03-seed.sql` | 2 tenants, 6 users, the Yemen geography tree, 8 sites with tanks/generators/batteries/dispensers/IoT devices, 5 alarms, 4 deliveries, 3 tickets, 12 fuel transactions. Idempotent |
| `04-verify.sql` | asserts, as each role: 0 rows without a context; the right rows inside it; no DDL; no writes to `_prisma_migrations`; platform tables global and the trail append-only |

Verified end-to-end on a clean PostgreSQL 16.2 (no TimescaleDB — the closest
reproduction of a hosted database available here), twice, from an empty
database:

```
FGMP roles ready in database fgmp5.
FGMP schema applied: 45 tables, 39 with FORCE RLS, 51 policies, 4 DML grants on "User" for fgmp_app.
FGMP seed ready: 2 tenants, 6 users, 8 sites, 8 tanks, 8 generators, 8 dispensers, 5 alarms, 12 fuel transactions.
OK: fgmp_app sees 0 sites with no tenant context.
OK: t-default -> 8 sites, 5 users; t-platform -> 0 sites; 2 tenant(s) resolvable.
OK: fgmp_app cannot create tables.
OK: fgmp_app cannot modify Prisma migration history.
OK: fgmp_ops (BYPASSRLS) sees 8 sites across all tenants.
OK: platform tables are global, and the platform audit trail is append-only for fgmp_app.
FGMP deployment verified.
```

Two findings from that work are fixed in the scripts rather than left for an
operator: a fresh role cannot `CREATE` in `public` on PostgreSQL 15+, and a
hosted database never grants `SUPERUSER`, so `fgmp_migrate` is subject to FORCE
RLS and a two-tenant seed fails its `WITH CHECK` (the README documents the three
ways out; the SQL seed sidesteps it).

`02-schema.sql` is generated and a test fails when it drifts from
`prisma/migrations`, so a new migration cannot silently leave the hosted path
behind.

**Platform administration (`docs/SUPERADMIN.md`).** `SUPERADMIN` no longer
implies standing cross-tenant reads — it never actually provided them, because
every tenant-scoped route runs inside `asTenant(me, …)` and the role's own tenant
is `t-platform`. The replacement is a control plane (tenants, grants, counts,
audit) plus just-in-time support sessions: one tenant, one reason, a ticket for
write mode, an expiry enforced against the row, a signed user-bound cookie, and
the access recorded both in the platform trail and in the tenant's own audit
log. A partial unique index makes "one operator cannot hold two tenants" a
database property rather than a code convention.

The four false claims this corrected are listed in `docs/SUPERADMIN.md` §8. The
most instructive: `/api/fgmp/audit` failed closed (a super-admin saw only their
own tenant) while its comment claimed the opposite — the code was safe, the
claim was not.

**Still unverified:** the Supabase instance itself (outbound access is blocked
from this sandbox, so the scripts were exercised against a local PostgreSQL
instead), the authenticated UI, and any Prisma query path (§8). The platform
routes are covered by invariant tests and a source-level authorisation scan, but
have not been exercised against a generated client here.
