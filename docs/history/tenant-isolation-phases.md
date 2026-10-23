# Tenant isolation — phase record (archived)

Historical engineering record of the multi-tenant isolation work (Phases 1–5) and the MQTT tenant-isolation defect. Kept for provenance: it documents defects, verification runs and decisions as they were made. Paths and status statements reflect the tree at the time of writing; see `docs/SECURITY.md` and `docs/ARCHITECTURE.md` for the current, normative description.

## Contents

1. [Phase 1 — Database-Level Tenant Isolation](#phase-1--database-level-tenant-isolation) — `docs/phase1-tenant-isolation.md`
2. [Phase 2 — working agreement (added by Lead)](#phase-2--working-agreement-added-by-lead) — `docs/phase2-working-agreement.md`
3. [Phase 2 — edge, protocol, control, and the tenant-context defect](#phase-2--edge-protocol-control-and-the-tenant-context-defect) — `docs/phase2-tenant-context-defect.md`
4. [Phase 3 — control entry point audit (cross-tenant control gap)](#phase-3--control-entry-point-audit-cross-tenant-control-gap) — `docs/phase3-control-audit.md`
5. [Phase 4 — end-to-end HTTP verification](#phase-4--end-to-end-http-verification) — `docs/phase4-e2e-verification.md`
6. [Phase 5 — gap assessment](#phase-5--gap-assessment) — `docs/phase5-gap-assessment.md`
7. [Phase 5 — engine state persistence, and the hypertable blocker](#phase-5--engine-state-persistence-and-the-hypertable-blocker) — `docs/phase5-engine-state-persistence.md`
8. [Phase 5 — remediation close](#phase-5--remediation-close) — `docs/phase5-remediation-close.md`
9. [Phase 5 — final close](#phase-5--final-close) — `docs/phase5-final-close.md`
10. [MQTT tenant isolation — two defects that looked healthy](#mqtt-tenant-isolation--two-defects-that-looked-healthy) — `docs/mqtt-tenant-isolation-defect.md`

---


<!-- source: docs/phase1-tenant-isolation.md -->

## Phase 1 — Database-Level Tenant Isolation

Ground truth for the migration. Written before touching the schema so the
sequencing is auditable rather than reconstructed from commit messages.

### Why the order matters

Steps 2→4 exist as separate steps only because a migration that adds a
`NOT NULL` column to a populated table needs somewhere to put the value first.
On a database holding no production data, that constraint does not bind: a new
column can be created `NOT NULL` directly because there are no rows to violate
it.

**Verified:** the FGMP deployment has demo/seed data only (52 sites, 168
transactions, all regenerable by `seedIfNeeded()`). `scripts/verify/smoke-postgres.ts`
and a full `seedIfNeeded()` run both pass against PostgreSQL 17. So steps 2, 3
and 4 are **collapsed into a single migration** that adds `tenantId` as
`NOT NULL` with an FK, and the `NULL tenantId` exposure window never opens.

The collapsed migration is applied to a database that is recreated, never to
one holding rows that need preserving.

### The 19 models without `tenantId`

Ten models already have `tenantId`: `User`, `Region`, `Site`, `Alarm`,
`AuditLog`, `Notification`, `AlarmSuppression`, `ApiKey`, `ShiftHandover`,
`BackupRecord`.

Of the remaining nineteen, two are **deliberately global and get no
`tenantId`**:

| Model | Why it stays global |
|---|---|
| `Tenant` | It is the isolation boundary itself. A tenant row cannot belong to a tenant. |
| `SystemSetting` | Platform-wide configuration (escalation thresholds, platform toggles). Tenant-scoped settings would let one tenant change another's alarm timing. |
| `EspFirmwareRelease` | A firmware artifact is a platform resource. `EspFirmwareDeployment` is the tenant-scoped instance of it. |

That leaves **sixteen** models that receive `tenantId`.

#### Tier A — add a direct `tenantId` column + FK

Reached directly, not through a parent:

`NotificationPreference`, `EspFirmwareDeployment`

#### Tier B — inherit tenancy through the parent `Site`

These already have a `siteId` FK, so `tenantId` is **denormalised** onto them
to make the RLS policy in step 6 directly enforceable on each table. Without a
local column, a policy on e.g. `FuelTank` would have to reach through a join to
`Site`, which is both slower and impossible to express as the simple
`tenantId = current_setting('app.tenant_id')` predicate the architecture
decision specifies.

`FuelTank`, `Generator`, `BatteryBank`, `IotDevice`, `FuelDispenser`,
`FuelTransaction`, `SensorReading`, `SiteEvent`, `FuelDelivery`,
`ControlCommand`, `MaintenanceTicket`, `SiteGateway`

Denormalisation is safe here only because `Site.tenantId` is itself
enforced, and because `ON DELETE CASCADE` from `Site` removes children with
their parent. Step 11's regression suite asserts a row cannot exist whose
`tenantId` disagrees with its site's.

#### `ControlCommand` is the exception — it has no `siteId`

Eleven of the twelve Tier B models reach `Site` directly through `siteId`.
`ControlCommand` does not; it reaches it via
`generatorId → Generator.siteId`:

    ControlCommand(id, generatorId, command, status, reason, issuedById, …)

It therefore takes a **two-hop** backfill rather than the one-hop
`SET tenantId = s.tenantId FROM Site` the others use:

    UPDATE "ControlCommand" c
       SET tenantId = g."tenantId"
      FROM "Generator" g
     WHERE c."generatorId" = g.id;

A direct `siteId` column was considered and rejected. `ControlCommand` has
zero rows, so there is no data-preservation argument either way, but adding a
column would duplicate a relationship the schema already expresses through the
generator FK. A two-hop path costs one migration; a redundant column costs
forever. If step 11 later demonstrates that `ControlCommand.tenantId` can
diverge from its generator's site tenant, revisit — though the FK chain makes
divergence unreachable in practice.

Because this depends on `Generator.tenantId` existing first, the backfill
must run in topological order within the migration: assets (`FuelTank`,
`Generator`, `BatteryBank`, `IotDevice`, `FuelDispenser`) → their children
(`FuelTransaction`, `FuelDelivery`, `SiteEvent`, `SensorReading`) →
`ControlCommand`.

### Backfill rule (was step 3, now part of the collapsed migration)

Every existing row is assigned the tenant of its parent `Site`:

    UPDATE "FuelTank" t SET tenantId = s.tenantId FROM "Site" s WHERE t.siteId = s.id;

`NotificationPreference` and `EspFirmwareDeployment` are resolved via
`User.tenantId` and `FuelDispenser.siteId` respectively.

Any row that cannot be resolved is **deleted, not defaulted**. A guessed
tenant is worse than a missing row: it silently places data in the wrong
tenant, and RLS would then protect it there forever.

### Constraint decisions

| Constraint | Value | Rationale |
|---|---|---|
| `NOT NULL` | yes | Required for RLS; `NULL = <tenant>` is never true, so a NULL row would be invisible to every tenant — a silent data-loss mode. |
| FK | `REFERENCES "Tenant"(id) ON DELETE RESTRICT` | The spec says RESTRICT. Note this differs from `Site`'s existing `ON DELETE CASCADE`; RESTRICT is correct for the tenant boundary — a tenant with assets must not be deletable. |
| Index | leading with `tenantId` | The policy adds a predicate per query; the index makes it cheap. Benchmarked for `SensorReading` in step 10. |

### RLS mechanics (step 6, recorded here for reference)

    ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
    ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON <t>
      USING      ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

`FORCE` is mandatory. RLS is skipped by the table owner, and the app role is
deliberately not the owner — but `FORCE` means the policy holds even if that
is ever changed by accident, which is the entire point of a backstop.

#### The predicate is TEXT, not uuid — correction

The original architecture note specified
`current_setting('app.tenant_id', true)::uuid`. **That predicate cannot work in
this schema and was removed.** `Tenant.id` is `String @default(cuid())`, which
PostgreSQL stores as `TEXT`, and real tenant ids are `t-default` and
`t-platform`. The cast fails outright:

    ERROR:  invalid input syntax for type uuid: "t-default"

Every RLS-protected query would have errored at runtime.

Converting the tenant PK to a native `UUID` was rejected: all 29 primary keys
in this schema are cuid-style `String`, so a UUID tenant PK would be
inconsistent with every other table and would cascade a PK-type change through
every foreign key — for no security benefit, since RLS compares values rather
than types. `tenantId` is therefore `TEXT` and the cast is dropped.

The fail-closed property is unaffected by removing the cast:
`current_setting(..., true)` returns NULL when the setting is absent,
`NULL = <text>` evaluates to NULL, and a NULL predicate is not TRUE. An unset
context still returns zero rows rather than everything. Verified in step 11.

### Roles (provisioned in step 1)

| Role | RLS | Used by |
|---|---|---|
| `fgmp_app` | Enforced (`FORCE`) | Web app. Not the table owner. DML only. |
| `fgmp_ops` | `BYPASSRLS` | Internal ops: `pg_dump`, cross-tenant support. **Never in the web app env.** |
| `fgmp_migrate` | Owns the schema | Migrations, CI only. |

### Steps 8 and 9 as applied

27 native enum types replaced the free-text columns. Several enum labels were
not present in the model's own documentation and were reconciled against the
real write sites in the application rather than guessed:

| Enum | Value added | Why |
|---|---|---|
| `Role` | `SUPERADMIN` | The platform-level role existed in `rbac.ts` and in the seeded super-admin account, but the model comment listed only six roles. |
| `NotificationChannel` | `EMAIL`, `WHATSAPP` | The escalation path writes `EMAIL` below L3 and `WHATSAPP` at L3; neither was in the documented label set. |
| `TicketStatus` | `DONE` | The maintenance workflow completes tickets into `DONE`, which the documented set (`OPEN`/`CANCELLED`) omitted. |
| `OtaStatus` | `QUEUED` | Firmware deployments are created in `QUEUED` before moving through the OTA lifecycle. |

Getting these wrong fails loudly at the first write rather than silently, but
each one cost a failed migration or a failed seed before it was reconciled.

Money is `numeric(65,30)` rather than `Float`, so litre and rial accounting is
exact binary-independent decimal arithmetic:

- `FuelTransaction.amountYer`
- `FuelTransaction.unitPriceYer`
- `FuelDelivery.unitPrice`

The theft/discrepancy logic compares delivered against ordered volume, so
float error there would have been indistinguishable from a real discrepancy.

### Step ledger

Status reflects what is actually applied to the database, verified against the
live instance — not what is planned.

| Step | Status | Evidence |
|---|---|---|
| 1. SQLite → PostgreSQL | done | `20261004203148_init_postgres_baseline`, `20261004203149_grant_role_privileges` |
| 2. Add nullable `tenantId` | done | `20261005000000_add_tenant_id_not_null_fk` |
| 3. Backfill from parent `Site` | done | `20261005000000_add_tenant_id_not_null_fk` |
| 4. `NOT NULL` + FK RESTRICT | done | `20261005000000_add_tenant_id_not_null_fk` |
| 5. `tenantId`-leading indexes | done | `20261005000000_add_tenant_id_not_null_fk` |
| 6. RLS ENABLE + FORCE + policy | done — 24/24 tables | `20261005000300_enable_rls` |
| 7. Per-request tenant context | done | `src/lib/fgmp/tenant-context.ts`, `src/lib/db.ts` |
| 8. Native enums | done — 27 enum types | `20261005000100_enums_and_decimal` |
| 9. Money columns → `numeric(65,30)` | done | `20261005000100_enums_and_decimal` |
| 10. TimescaleDB hypertables | **NOT DONE** | see below |
| 11. RLS regression suite | done — 153 assertions, 24/24 tables, exit 0 | `scripts/verify/rls-regression.ts`, `src/lib/fgmp/__tests__/` |

#### Step 10 is outstanding

`SensorReading` is still an ordinary unpartitioned table. The TimescaleDB
extension is not installed in the database at all — `timescaledb_information`
does not exist — so there is nothing to convert. What remains:

- `CREATE EXTENSION IF NOT EXISTS timescaledb;`
- `SELECT create_hypertable('"SensorReading"', 'ts', ...)`
- A retention policy. `SiteEvent` and `AuditLog` grow without bound and need
  the same treatment.
- Decide chunk interval against real telemetry volume; 288 points/site/day in
  the seeded data is not representative of production cadence.

Until then, telemetry history is bounded only by disk, and every query over it
is a full scan of the table.

### Step 6 as applied

All 24 tables that carry a `tenantId` column, enumerated from
`information_schema` at migration time so the migration cannot drift from the
schema:

    ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
    ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON <t>
      USING      ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

The six tables without the column are deliberately excluded: `Tenant` (the
tenant table itself), `SystemSetting` and `EspFirmwareRelease` (global
configuration/catalogue), `Governorate` and `District` (reach tenancy through
`Region`), and `_prisma_migrations` (Prisma bookkeeping).

`FORCE` is what makes the policy bind. PostgreSQL skips RLS for the table
owner, and `fgmp_migrate` owns these tables — without `FORCE` the policy would
constrain nobody. Verified: a non-superuser owner sees 0 rows with no context
and its own rows once the context is set.

`WITH CHECK` is not optional. `USING` alone governs reads and updates to
existing rows; only `WITH CHECK` rejects an INSERT, which is the cross-tenant
write path.

### Decisions a future maintainer will want to second-guess

#### Migration ordering is lexicographic, and that is load-bearing

Prisma orders migrations by DIRECTORY NAME, not by any declared dependency. The
timestamp prefix is therefore the only thing expressing order, and three
mistakes came out of it during this phase:

- enums were added in a migration sorted BEFORE the one that used them;
- `FuelType` gained `BIOFUEL` in a directory sorting BEFORE the migration that
  created the enum;
- RLS was initially written against `tenant_id` while the schema actually used
  `"tenantId"`.

Rule: read the whole migration directory listing before adding a migration, and
encode dependencies in the timestamp.

#### `FGMP_REQUIRE_RLS=1` refuses to boot on a misconfigured connection

`src/lib/db.ts` exposes `assertRlsEnforced()`, called at module load on the
server runtime. With the flag set, a `DATABASE_URL` that does not use
`fgmp_app` makes the process throw at import rather than serve traffic with
isolation silently disabled. It reuses the existing `rlsEnforced` role
detection rather than re-parsing the URL.

Default is OFF, so local development without PostgreSQL still boots. The guard
is skipped during `next build`, which imports every route module without
runtime secrets — the same constraint `auth.ts` documents for its placeholder
secret. A build is not a serving process.

#### The web app never holds the owner credential

Seeding spans tenants and creates the tenants themselves, so it cannot run
inside `withTenant()` and needs the owner role. It used to run inside
`bootstrap()`, which is called by 86 files — so the web container had to be
given a superuser connection purely to serve a request. That contradicted the
premise of the backstop.

Seeding is now deploy-time only:

    bun run db:seed                          # idempotent, exits non-zero if 0 sites
    docker compose --profile seed run --rm fgmp-seed
    POST /api/fgmp/seed                      # ADMIN-only, rate-limited, audited

`FGMP_MIGRATE_DATABASE_URL` exists solely in the one-shot `fgmp-seed` service,
behind `profiles: ["seed"]` so it never starts with a normal `docker compose up`.

### Limitations

This phase added a backstop. It did not make the application correct, and the
following are real and outstanding.

#### Governorate and District have no RLS backstop at all

**This is the one geography hierarchy is NOT protected by the database, and any
future work on districts or governorates must assume the application is the only
thing standing between tenants.**

`Region` carries a `tenantId` column and is RLS-protected. `Governorate` and
`District` carry **no `tenantId` column and no policy at all** — they reach
tenancy only through their parents (`Governorate.regionId → Region.tenantId`,
`District.governorateId → Governorate.regionId → Region.tenantId`).

Measured against the live catalog as `fgmp_app`, the real application role:

```
SELECT count(*) FROM "Region";    -- no tenant context  ->  0
SELECT count(*) FROM "District";  -- no tenant context  ->  36
withTenant("t-platform")          -> District  ->  36   (belonging to t-default)
withTenant("t-default")           -> District  ->  36
```

`District` and `Governorate` are readable by `fgmp_app` with **no tenant context
at all**, and a superadmin-scoped transaction sees every tenant's rows. So the
isolation is inconsistent *within one hierarchy*: Region rows are hidden while
its own children are not.

Consequences a future maintainer must respect:

- Every query against `governorate` or `district` MUST carry the full parent
  path: `{ region: { tenantId } }` for a governorate, and
  `{ governorate: { region: { tenantId } } }` for a district. A `where: {
  tenantId }` on either matches nothing — the column does not exist.
- `findUnique({ where: { id } })` on these tables has **no tenant filter at all**
  and silently returns another tenant's row.
- There is no backstop. The moment any query, report, export, search, nested
  `include`, or background job touches these tables without the parent filter,
  nothing in the database stops it. This is precisely the failure mode that
  Phase 2 demonstrated for the Phase 0 application-level checks, which is why
  `assertTenantOwned` was inert for every `[id]` route until Phase 3 scoped the
  lookup in the query.
- The open fix is a schema decision: either denormalise `tenantId` onto both
  tables, or expose them through a `security_barrier` view joining to `Region`.
  Neither is done.

#### RLS is a backstop, not the primary control

`assertTenantOwned()` in `src/lib/fgmp/auth-helpers.ts` runs first and is what
actually scopes a request. RLS catches a MISSING tenant context and a missing
`WHERE` clause. It does not catch a WRONG one: a request that sets
`app.tenant_id` to another tenant's id is served that tenant's data, and RLS
will agree.

#### `app.tenant_id` is an ordinary session GUC

Any process holding the `fgmp_app` credential can `set` it to any tenant and
read or write that tenant's rows. RLS therefore protects against forgetting the
context and against unguarded queries — it does **not** protect against a
compromised or malicious application process. Treat the app role's credential
as tenant-wide read/write for the whole platform; the per-request scoping is a
property of the code, not of the database.

#### `FORCE` is not covered by the regression suite

The suite runs as `fgmp_app`, a non-owner. That is correct — it is the role the
application uses — but it means the suite cannot detect a missing `FORCE`, because
without `FORCE` the policy still binds the non-owner. Verified by mutation:
dropping `FORCE` from `FuelTank` left the suite at 153 PASS.

The owner-side consequence is caught elsewhere: the `docker` CI job asserts
`count(*) = 24` for tables with both `relrowsecurity` and `relforcerowsecurity`,
and a non-superuser owner was shown to read 0 rows with no context. Nothing in
the Bun suite covers it, so a regression there depends on CI's docker job running.

#### The in-memory engine is not tenant-aware (most important open item)

`engine.ensureInit()` reads tenant-scoped rows with NO tenant context. Under
RLS that correctly returns nothing, so the engine loads 0 sites and the app
reports an empty fleet. This is pre-existing and was **not** fixed by this
phase — the phase made it visible rather than causing it. Until the engine is
made tenant-aware, it cannot serve tenant data at all.

#### Rate limiting is per-process

`src/lib/fgmp/rate-limit.ts` keeps buckets in a module-level `Map`. It is
correct for a single instance and silently ineffective across replicas: the
effective limit is `limit × replicas`. Correct for the single-container
deployment this phase targets; it must move to shared storage before scaling.

#### `getClientIp()` collapses to `"anon"` without `TRUSTED_PROXY`

Without that variable every direct client shares one bucket, so the login rate
limiter groups all operators together. The default is the safe one — it refuses
to trust a client-supplied header — but it makes the per-IP limit a global one.

#### Non-constant-time secret comparison

`src/app/api/fgmp/iot/ingest/route.ts:107,341` and
`src/app/api/fgmp/realtime/snapshot/route.ts:71` compare secrets with `!==`.
`timingSafeEqual` is used correctly elsewhere (`realtime-token.ts`), so the
standard exists and was simply not applied at these three sites. Remote timing
attack is impractical in practice; the inconsistency is the real finding.

#### CSP permits `unsafe-eval` and frames any HTTPS origin

`next.config.ts` sets `script-src 'self' 'unsafe-inline' 'unsafe-eval'` and
`frame-ancestors 'self' https:`. The latter was for a preview platform; in
production it permits clickjacking of an authenticated NOC dashboard.

#### Secrets on disk

`.env` holds real credentials and is untracked (`.gitignore` `.env*`). The
template `.env.example` is committed. Rotate anything that has touched a shared
machine.

---


<!-- source: docs/phase2-working-agreement.md -->

## Phase 2 — working agreement (added by Lead)

All four verticals run **concurrently in one shared working tree**. Git branches do
NOT isolate a working directory, so the write scopes below are the only thing
keeping this safe. They are advisory to the filesystem but binding as a contract.

### Write scopes (disjoint by construction)

| Agent | Owns |
|---|---|
| `p2-telemetry` | `src/lib/fgmp/engine.ts` tick/simulation boundary, `/api/fgmp/tick`, ingest buffering (`src/app/api/fgmp/iot/ingest/**`) |
| `p2-protocol` | `src/lib/fgmp/protocol/**`, `/api/fgmp/edge/rs485`, `mini-services/iot-bridge/**`, new migration `20261006000000_*` |
| `p2-interlocks` | generator control routes, `src/lib/fgmp/interlocks/**`, new migration `20261006001000_*` |
| `p2-cron` | scheduler, server-side correlation (`src/lib/fgmp/correlation/**`), `20261006002000_*` |

`prisma/schema.prisma` is shared and additive-only. If two agents add models at
the same time, the later edit wins and may silently drop the other's block. That
is the one real collision risk — see "Schema edits" below.

### Rules

1. **No branch operations.** The Lead owns every `git checkout`, `merge`, `rebase`
   and `stash`. A branch switch rewrites files other agents are actively editing.
2. **`git add <explicit paths>` only.** Never `git add -A`, never `git add .`.
3. **Before editing any file outside your scope, send the Lead a message and wait
   for a reply.** Do not assume it is free.
4. **If you need something from another agent's scope**, message the Lead with the
   exact accessor or shape you need. Do not reach into their files.

### Schema edits

`prisma/schema.prisma` is the one genuinely shared file. To avoid losing work:

- Add models/fields **append-only at the end of the file**, and do not reformat
  or reorder anything above your addition.
- Do not run `prisma format` or `prisma generate` against another agent's
  in-progress edit without telling the Lead — it will rewrite the whole file.
- If your change is rejected by `prisma validate` because of someone else's
  partial edit, **stop and report it** rather than "fixing" their model.

### Migration naming

Prisma orders migrations **lexicographically by directory name**, not by
creation time. Every new migration must sort after `20261005000300_enable_rls`.
Getting this wrong breaks replay-from-empty; it bit us three times in Phase 1.

Enum defaults are **unquoted**: `@default(OPEN)`, never `@default("OPEN")`.

### RLS

Enforced with `FORCE` on all 24 tenant tables. Any write outside a
`withTenant(tenantId, …)` context fails with "new row violates row-level security
policy". New tenant-carrying tables need `ENABLE` + `FORCE` + a `tenant_isolation`
policy, copied from `prisma/migrations/20261005000300_enable_rls/migration.sql`.

### Gates every agent must leave green

```
npx tsc --noEmit                    # 0 errors
npx eslint .                        # 0 errors
npx prisma validate                 # valid
bun run scripts/verify/rls-regression.ts   # exit 0
bun run scripts/verify/smoke-postgres.ts   # PASS
bun run db:seed                     # siteCount 52
```

with:

```
DATABASE_URL=postgresql://fgmp_app:testapp123@127.0.0.1:5433/fgmp?schema=public
FGMP_MIGRATE_DATABASE_URL=postgresql://fgmp_migrate:testmigrate123@127.0.0.1:5433/fgmp?schema=public
```

### The bar this phase has to clear

The user set the precondition explicitly: **do not claim production-ready until
Phase 1's RLS regression suite passes and Phase 2's simulated telemetry is gone.**

Phase 1's suite passes today. Phase 2's job is to make the second half true —
and to prove it rather than assert it. A green test run is not evidence on its
own; Phase 1's own review suite turned out to be unable to detect a missing
`FORCE`, which was only found by deliberately breaking things and watching it
fail. **Mutation-test your own work before you claim it works.**
### Scratch files outside the repo are shared state

An agent's authoritative work list was kept at `/tmp/myfiles.txt`. Another agent
overwrote it with a repo-wide list, and the first agent lost its own scope
silently — no error, just a batch that no longer matched what it was doing.

`/tmp` is not private between agents on this machine. Anything another agent
could reasonably need must live in the repo, or be reconstructible from the
tools.

**The rule that resolves this cleanly: derive the work queue from the gate's own
output.** The ESLint rule `no-restricted-imports` reports exactly which files still
violate, which is the queue by definition. A hand-maintained list is a cache of
that, and caches drift.

### Signature discipline

`asTenant` takes the authenticated user, not a tenant id:

```ts
asTenant(user, …)                        // the caller's own tenant
asTenantForAnotherTenant(user, tenantId, …)  // throws unless SUPERADMIN
```

`asTenant(user.tenantId, …)` is wrong and will not typecheck — which is the point.
The guarantee is narrow and worth stating precisely: a client-supplied value
cannot reach the tenant context, because a request body has no type that satisfies
it. An **in-code** mistake can still compile — a row has a `tenantId` field too,
and one mechanical pass did exactly that before review caught it.

---


<!-- source: docs/phase2-tenant-context-defect.md -->

## Phase 2 — edge, protocol, control, and the tenant-context defect

Status: **substantially delivered; three items outstanding.** This document records
what shipped, what was proven, and what is still missing. It is written to be
adversarial about its own phase.

### What shipped

#### Simulated telemetry removed (`e452f6c`)

`engine.tick()` fabricated tank levels, generator temperatures, battery SoC and
fuel transactions from 44 `Math.random()` calls. It is now an explicitly opt-in
development facility that **cannot run in a production process**.

Two conditions must both hold: `NODE_ENV ≠ production` **and** `FGMP_SIMULATION`
enabled. Either alone is insufficient — a stray `FGMP_SIMULATION=1` cannot switch
it on in production. Enforced in two places: `engine.tick()` asserts before doing
anything (covers non-HTTP callers), and `/api/fgmp/tick` returns 503. The route
guard runs *before* `requireRole` so production gets the real reason rather than a
misleading 403.

All 44 calls replaced with seeded streams. One stream per subsystem — a single
shared sequence would mean changing how often a generator event fires silently
rewriting every later tank value. `mulberry32` was extracted from the existing
`seed.ts` implementation rather than reinvented, and a test pins the output to
`seed.ts`'s actual values so the two cannot drift.

**Verified:** `NODE_ENV=production` → `SimulationDisabledError`, `rlsEnforced=true`.
`Math.random()` in `engine.ts`: 0 functional (2 grep hits are comments).

#### Edge buffering (`e452f6c`)

Ingest previously stamped every row with **server** time, so a reading that
arrived an hour late was indistinguishable from a fresh one and a replay was
indistinguishable from a new one. For fuel telemetry that means a stale tank
level silently overwriting a fresh one — theft figures wrong, with nothing able
to detect it.

Readings are now judged against a per-site watermark **before** any in-memory or
database mutation: `REJECT_STALE`, `REJECT_DUPLICATE`, `REJECT_FUTURE`,
`REJECT_TOO_OLD`, with distinct codes so an operator can distinguish a flaky link
from a clock problem. Body size is bounded before parsing; non-finite numbers are
refused (`JSON.parse("1e400")` yields `Infinity`, which passes a naive range
check and would put `Infinity` in a numeric column).

The ordering is deliberate: once `tank.current` has been overwritten by a stale
level, refusing the database write afterwards still leaves the dashboard and the
theft figures reflecting an hour-old reading.

#### Modbus RTU + MQTT (`62a5586`, `a353136`)

CRC-16/MODBUS anchored to the **canonical conformance vector**: CRC of
`"123456789"` must be `0x4B37`. That single value pins polynomial, reflection, init
and output together. Cross-checked against two implementations written in
different styles over a 200-case corpus.

This was not ceremony — it caught three real bugs: `decodeRegister` **dividing**
by scale (47800 mV → 47,800,000 V), `buildReadRequest` allocating 7 bytes for a
6-byte request and putting a stray zero inside every CRC, and misremembered
"published" frame vectors.

**MQTT tenant isolation is NOT enforced.** `tenantAclPattern()` builds the string
`fgmp/<tenant>/#`; there is no broker client and no ACL. The agent correctly
retracted an earlier claim that this was an enforced control. It is a
*precondition* for isolation, not isolation. Proving it needs a live broker.

#### Control interlocks (`03f6b22`, `4777d69`)

13 rules as **data**, split HARD (refuse) / SOFT (warn). Enforcement runs
**before** `engine.applyCommand()` — after, the command would already be at the
generator and the interlock would be decoration.

`EMERGENCY_STOP` is unblockable by construction: an interlock that can veto an
emergency stop is itself a hazard. Self-approval is refused outright, so the
two-person rule cannot be satisfied by one person typing twice.

**Mutation-tested**, because green proves nothing unproven: removing
`COOLDOWN_ACTIVE` → 3 failures; flipping fuel `<` to `<=` → 1 failure; disabling
the emergency-stop bypass → 1 failure; dropping RLS from `InterlockOverride` →
155 PASS/5 FAIL.

#### Server-side clock and correlation (`94e5609`, `50eb361`, `5112f5c`, `52e18f2`)

The tick endpoint was driven by whoever was looking at the dashboard — state
advanced only while a browser tab was open. Replaced by a wall-clock scheduler
using `pg_try_advisory_xact_lock` (multi-instance-safe, not an in-process boolean).

**Proven:** 4 concurrent lock attempts → exactly 1 winner; 4 concurrent advances
→ 1 acquired; the loop advanced on wall-clock time with zero HTTP requests.

Correlation evaluation moved server-side and client-side evaluation was
**deleted**, not merely unused. Rule storage also moved server-side — rules were
being authored in localStorage while evaluation ran on the server, so a rule
created in one browser could never fire. The server-side work was inert for its
only real input path.

`encodeAlarmIds` originally joined ids on `,` without rejecting a comma inside an
id. That string **is** the idempotency key, so a collision would have made the
UNIQUE constraint silently discard a real escalation as a duplicate. Now throws.

### The defect that mattered most

Phase 1 shipped RLS. It did not audit what RLS did to application code.

```
db.site.count()                                     -> 0
db.site.count({ where: { tenantId: "t-default" } }) -> 0
withTenant("t-default", tx => tx.site.count())      -> 52
```

A query with no tenant context returns zero rows — **and an explicit
`where: { tenantId }` does not help either**, because the policy's `USING` clause
is ANDed with it and `current_setting('app.tenant_id')` is still NULL.

Therefore `assertTenantOwned()`, `tenantWhere()` and `siteTenantWhereOrAll()` —
all post-fetch, in-memory filters — were comparing `record.tenantId` on rows the
database never returned. **Phase 0's application-level defence was intact and
completely inert.** Every route relying on it was getting 404/null regardless.

Scale: **309 unscoped `db.*` calls across 80 route files.** It survived a full
phase because nothing exercised a real end-to-end login, and because an empty
result is indistinguishable from real empty data.

Two specific silent failures:

- **`audit()` resolved successfully and wrote 0 rows.** Its own `catch` swallowed
  the RLS violation. The compliance trail for 80+ mutating routes was destroyed
  with no error anywhere. Fixed with an owner-path fallback plus
  `auditFailureCount()`, because an audit subsystem must not be able to corrupt
  the operation it records (throwing would 500 a completed mutation and invite a
  retry that re-applies it) — but silent loss is now impossible and countable.
- **`suppression-check.ts` failed OPEN**, so suppressed alarms kept firing — a
  safety function silently inert, on a fuel site. The 30s cache then held that
  empty list, and the cache was global rather than per-tenant. Now fails closed
  with a per-tenant cache.

Login was one symptom: `auth.ts` looked up the user by email with no context, so
**every login returned null**. The failure was silent — 302 with no Set-Cookie, so
it looked like success followed by 401s everywhere. Email→user is inherently
cross-tenant (that is how authentication works), so it is a deliberate,
documented owner-path lookup in `src/lib/auth-identity.ts`, which exposes only
`findUserByEmail` / `findUserIdentity` / `updateAuthUser` — no generic escape
hatch — plus user-enumeration resistance.

#### The durable fix

`no-restricted-imports` scoped to `src/app/**` bans importing `db`. This converts
a silent runtime wrong-answer into a compile error and makes the **next** route
fail the build rather than the next deployment.

The first version banned only `@/lib/db` and flagged 4 violations in 2 files — a
**false green**. The dominant import path is the `@/lib/fgmp` barrel (77 files),
which re-exports `db`. Banning only the direct path would have left 77 broken
routes passing. After adding the barrel: **81 violations, 307 calls**, which is
the real work queue.

A runtime guard was deliberately **not** built. With Prisma, a query extension
intercepts model operations but not reliably `$queryRaw`/`$executeRaw` or nested
relation paths — a guard loud on 90% of paths is worse than none, because the
silent 10% is indistinguishable from correct behaviour.

### Test integrity

The RLS suite grew 160 → **191 assertions, 30/30 tables**, exit 0. Two coverage
gaps were closed, both of which had been silently passing:

- **No FORCE coverage.** Disabling `FORCE` on a table left the suite at 153 PASS,
  because it runs as `fgmp_app` (a non-owner) and a policy binds a non-owner with
  or without FORCE. Now asserts `pg_class.relforcerowsecurity` directly. Verified
  both directions: dropped → `FAIL force-rls-coverage`, exit 1; restored → pass.
- **No per-table exercise coverage.** Five Phase 2 tables carried live policies
  and zero assertions. The suite now fails if any protected table lacks a fixture.

A third: `isMissingObject()`'s broad `/does not exist/` regex downgraded a real
defect (`column "bus" does not exist`) to "BLOCKED on step 6" — reporting an
infrastructure dependency when the cause was the suite's own SQL. BLOCKED
assertions are now named rather than merely counted.

Three consecutive suite runs once produced three different results because
concurrent agents were mutating one shared database. All three were worthless.
This is recorded because **a suite result is only evidence when you were the only
party touching the database**, and "ran it twice and it passed" is not evidence.

### Outstanding — not done

1. **81 lint violations / 307 calls across 79 route files.** The work queue the
   new rule produces. In progress.
2. **Cross-tenant CONTROL gap.** If the engine holds tenant A and a command
   arrives for a tenant B asset, the interlock read returns null and the command
   is **denied** — safe — but nothing *detects* the wrong-tenant request, and
   `applyCommand` / `controlDispenser` / `applyEspReboot` /
   `applyFirmwareDeployment` / `applyGatewayReboot` were never individually
   audited for silent no-op success. A cross-tenant denial is safe; a cross-tenant
   **allow** is not. In progress.
3. **MQTT tenant isolation unenforced.** Needs a live broker to prove.

### Known limits, not hidden

- **Ingest watermark is process-local.** Across replicas a device retry routed to
  another replica will not see it. Durable fix needs a unique index on
  `(entityId, metric, ts)` plus Redis (already a dependency).
- **Undated readings are accepted** and reported as undated — field firmware
  often has no RTC, and rejecting them would push operators to disable the check.
- **`SensorReading` has no `receivedAt`** (schema was out of scope when written).
  Uplink delay is returned in the response instead.
- **Interlock thresholds are inferred, not sourced.** Coolant 85 °C, oil 150 kPa,
  12 L cranking fuel, 3 min cooldown, 10 min fault backoff, 500 h overdue-service
  are placeholders in `NEEDS_OPERATOR_CONFIRMATION`. They all fail toward
  **refusal**, never toward permitting an unsafe action, which is why they are
  shippable as a gate — but they are not engineering standards. The cranking fuel
  figure is the weakest: real practice expresses it as a tank percentage or
  minutes of cranking load, both of which scale with engine displacement, so a
  flat litre count cannot be right for every engine.
- **`SHED_BELOW_SITE_REQUIREMENT` cannot fire** — `protectedLoadKw` is not
  modelled. The rule is correct and tested; the input does not exist.
  `CRITICAL_LOAD_SHED` works and covers the dangerous case.
- **Login enumeration timing is jitter, not signal.** Measured 1.48x–2.65x
  across runs on this machine. The meaningful comparison is the old behaviour,
  which skipped bcrypt entirely for an absent user (~300 ms vs ~0 ms) — a
  different order of magnitude.
- **RLS is a backstop, not the primary control.** It catches a missing tenant
  context. It does not catch a *wrong* one: `app.tenant_id` is an ordinary session
  GUC, so any process holding the `fgmp_app` credential can set it to any tenant.
  RLS protects against forgetting the context and against a missing WHERE clause
  — not against a compromised or malicious application process.
- **Not production-ready.** The user's precondition was that Phase 1's RLS suite
  passes and Phase 2's simulated telemetry is gone. Both are true. Neither makes
  the platform production-ready with 81 unscoped route queries outstanding.
### Addendum — a test route that reported success without measuring anything

`src/app/api/fgmp/admin/tenant-isolation-test/route.ts` exists to assert tenant
isolation. Under Phase 1's RLS it asserted nothing, and reported that isolation
was intact.

```
tenants found unscoped: 2
totalTests: 0   passed: 0   failed: 0
summary.isolationIntact = true
```

Two independent flaws, both reproduced rather than inferred:

**Flaw 1 — vacuous pass from the aggregation.** `isolationIntact: failed === 0`
(line 317). All eight sample queries (lines 140–167) are unscoped
`db.*.findFirst(...)`, so under FORCE RLS every one returns null. Each assertion
sits behind `if (sampleX)`, so all are skipped, `allTests` is empty, and
`failed === 0` on an empty array is `true`. The guard was written to skip absent
resources — which, once RLS makes every resource absent, skips everything.

This is worse than a route returning empty data, because empty data looks broken
while this looks authoritative. **A test suite whose "0 failures" means "0 tests
ran" is the most misleading artefact a codebase can contain.**

**Flaw 2 — a null record passes for the wrong reason.** `pass: denied !== null
&& saAccess === null` (line 189). `assertTenantOwned(null, …)` returns 404 for an
ordinary user and `null` for SUPERADMIN, so a null sample scores `pass: true`.
`assertTenantOwned` cannot distinguish "belongs to another tenant" from "does not
exist" — both are `record == null`. Even a fully-loaded version of this route
could report PASS while the RLS policy hid every row, which is precisely the
failure mode that concealed the original defect.

Note why the route got far enough to produce a report at all: `db.tenant.findMany`
still returns rows because `Tenant` has no `tenantId` column and so is not
RLS-protected. Cross-tenant enumeration worked; per-tenant sampling did not.

**The generalisable lesson.** `failed === 0` is not a pass. Any summary that
aggregates over a possibly-empty set must distinguish *nothing failed* from
*nothing ran*, and must refuse to claim success when it measured nothing. The
same shape appears in the RLS suite itself, which is why it now names BLOCKED
assertions and asserts per-table coverage rather than only counting outcomes.

### Addendum — "this table has no tenantId" does not mean "this route is safe"

The most easily missed variant of the tenant-context defect, found while fixing
`GET /api/fgmp/tenants`.

`Tenant` is keyed by its own `id` and carries **no `tenantId` column**, so it is
not RLS-protected and its own row reads perfectly well unscoped. It looks safe on
a glance — and is not. Its `_count` relations are resolved by Prisma through
nested queries on the ambient client, and `users`, `sites` and `suppressions` all
carry `tenantId` and are FORCE-protected.

Measured against the live database:

```
UNSCOPED: [{"id":"t-default","_count":{"sites":0,"users":0}}]    <- lies
SCOPED:   [{"id":"t-default","_count":{"sites":52,"users":5}}]   <- truth
```

So the route returned **HTTP 200 reporting that a 52-site tenant had no users and
no sites**. Not an error, not an empty state — a confident falsehood, and the
part most likely to be screenshotted into a status page.

**The generalisation:** scoping the top-level query is not sufficient. Every
nested `include`, every `_count`, and every relation traversal in a route must
also be inside the tenant context, because Prisma resolves them independently.
A parent-scoped fix that leaves one unscoped relation read is still a false 200.

This is the same shape as the audit-log defect: the parent operation succeeds, so
nothing looks wrong, while the nested part silently reports nothing.

### Addendum — a `Promise.all` trap for tenant-scoped reads

`Promise.all` returns a **tuple**. Destructuring it by property name type-checks
(TS sees a property access on a tuple type) and fails at runtime:

```ts
// type-checks, then throws at runtime
const { sampleSite } = await withTenant(t, () => Promise.all([q1, q2, q3]));
// correct: destructure positionally
const [sampleSite, sampleAlarm] = await withTenant(t, () => Promise.all([q1, q2]));
```

Neither `tsc` nor `eslint` catches this, so it is worth stating explicitly in
any code that batches multiple tenant-scoped reads.

### Addendum — the same defect gating a DESTRUCTIVE operation

`tenants/[id]` DELETE refuses to remove a tenant that still owns users or sites.
That refusal reads `_count` over two FORCE-protected relations.

Unscoped, those counts return 0 for a tenant that measurably has 5 users and 52
sites. The gate therefore read *"no users, no sites"* and **allowed the delete**.
The destructive statement then hit the FK layer instead of being refused cleanly
with a 409 — so data-loss semantics were decided by a query that had silently
stopped returning rows.

This is why the tenant-context defect is not merely a display problem:

> A read returning `[]` is **visibly** broken. A safety gate returning "nothing
> to worry about" is **invisibly** destructive.

Every other manifestation in this document produces an empty response that some
human eventually notices. This one produced a *passing* result. The counts are
now read inside the same transaction that performs the delete, so a row created
between the guard and the statement cannot slip a populated tenant through.

Proven without executing a destructive test, by reading the gate the way it now
reads:

```
t-default _count as the gate reads it: {"users":5,"sites":52}
gate would REFUSE delete: true
```

### Two more traps that typecheck cleanly

1. **A duplicated `where:` key silently overwrites the scoped one** with
   `where: { id }` and still passes `tsc`. Two independent agents hit this.
2. **A scoped top-level query with an unfiltered `include:`** returns a
   *populated* response carrying a null or foreign relation. That is worse than
   the original empty list, because it looks correct.

Both were caught by agents reading each other's diffs rather than by tooling.
Neither is detectable by `tsc` or `eslint`, which is the argument for reading
diff line-by-line when a mechanical transform touches authorisation code.

### Addendum — the tenant helper let a request body reach the transaction context

`asTenant(tenantId, fn)` took a **plain string**. Two routes passed it a value
resolved partly from the request body:

```ts
// src/app/api/fgmp/geography/regions/route.ts
const tenantId = parsed.data.tenantId || user.tenantId;
…
await asTenant(tenantId, async (tx) => { … });
```

It was safe only because an `if` statement ten lines earlier rejected a
non-superadmin who supplied someone else's tenantId. A tenant admin's entire
isolation rested on one `if`, ten lines from the call that opens the
transaction. That is a single point of failure, not a convention — one refactor
that moves the check, and a body field reaches the tenant context directly.

**The signature changed to take the user, not the id:** `asTenant(user, fn)`.

Proven unrepresentable rather than asserted — the original pattern compiled
against the new signature:

```ts
asTenant(parsed.data.tenantId, (tx) => tx.site.findMany())
// TS2345: Argument of type 'string | undefined' is not assignable to
//          parameter of type 'Pick<SessionUser, "tenantId">
```

79 mechanical substitutions, plus **two variables deleted rather than rewritten**
(`verifiedSiteTenantId` in suppressions, `site.tenantId` in batteries). Both were
derived from a row already scoped to the caller, so they always equalled the
caller's tenant and gated nothing. Deleting them removes the possibility instead
of fixing it — and in suppressions the row was written with `user.tenantId` while
the *context* came from the variable, so the two could disagree.

#### What the new type does and does not guarantee

Worth stating precisely, because the obvious summary overstates it:

- **Guaranteed:** a client-supplied value — request body, query string, path
  parameter — cannot reach the tenant context. None of them have this type.
- **Not guaranteed:** an in-code mistake still compiles. During the mechanical
  pass a regex rewrote one call to `asTenant(site, …)`, passing a **row** where a
  user was expected. It compiled, because a Site row happens to have a `tenantId`
  field. It was caught by review, not by tooling.

Requiring a full `SessionUser` would catch that row case, but would not stop a
deliberate in-code fabrication, so it buys a narrow accident class at the cost of
friction on every legitimate call site. The narrower, true claim is the one worth
making.

#### A mechanical pass that would have been a silent regression

Three call sites passed a body-supplied tenant for a legitimate superadmin
purpose, and were deliberately **not** converted:

```ts
asTenant(user, …)   // ← converting this SILENTLY redirects superadmin
                     //   provisioning into their OWN tenant instead of failing
```

It type-checks, and it does the wrong thing — which is worse than refusing. Those
sites moved to a separate `asTenantForAnotherTenant(user, targetTenantId, fn)`
whose SUPERADMIN assertion lives **inside** the helper, making the cross-tenant
capability named, greppable and runtime-checked rather than a string that happens
to be in the right variable.

#### The lesson, in the author's own words

> The `asTenant(string)` design was MY proposal. It made 60 call sites correct in
> one afternoon, and it also made a body-sourced tenantId compile cleanly in a
> route I wrote myself. A migration helper that is simultaneously the thing that
> makes 300 calls correct and the thing that cannot express "this tenant came
> from the user" is under-designed.

The same property that made the helper easy to adopt made the mistake invisible.
No amount of green testing would have caught it.

---

## Phase 3 — closing the tenant-context defect

Phase 2 identified the defect and refused to call itself done. This phase closed it.

### The queue, and its shape

A new ESLint rule banned importing `db` inside `src/app/**`, converting a silent
runtime wrong-answer into a compile error:

```
81 violations / 309 unscoped db.* calls / 79 route files   at phase start
 0 violations                                                   at phase end
```

The rule's first version banned only `@/lib/db` and flagged 4 violations in 2
files — a **false green**. The dominant import path is the `@/lib/fgmp` barrel
(77 files), which re-exports `db`. Banning only the direct path would have left
77 broken routes passing.

A runtime guard was deliberately **not** built. With Prisma, a query extension
intercepts model operations but not reliably `$queryRaw`/`$executeRaw` or nested
relation paths, so a guard loud on 90% of paths is worse than none.

### Defects found while fixing, all verified against the live database

**The engine had been holding an empty platform since Phase 1.** `ensureInit()`
aborted on `permission denied for table Governorate`, because geography was
loaded via nested `include:` on tables the geography migration had correctly
revoked. Prisma resolves each nested include as a *separate* query requiring its
own privilege, so a correct revocation silently emptied the engine:

```
sites 52 | tanks 84 | generators 76 | regions 4     (after)
engine.sites.length = 0                              (before)
```

**Two endpoints returned 500 for every request since Phase 0.**
`POST /api/fgmp/iot/ingest` and `/api/fgmp/realtime/snapshot` both opened with
`await bootstrap()`, which resolves the user and throws without a session —
correctly, that is the Phase 0.3 fail-closed work. But both authenticate by API
key or service token and have no session. In ingest it was invisible because the
handler never *read* the returned user, so nothing downstream referenced the
value `bootstrap()` threw over.

Found by actually issuing requests. Neither the type gate nor the RLS suite could
have found it: both exercise code that is correct in isolation.

**A cross-tenant cache key.** `analytics`' 7-day readings cache omitted the
tenant id while the superadmin path passed `tenantSiteIds: null` — one tenant's
result served to the next.

**`db.$transaction` is a transaction without a tenant context.** Delivery
cancel and deliver used it, so the guard read returned null and the
`auditLog.create` inside was rejected by `WITH CHECK` — the audit write could
never succeed on the path a cancellation takes.

**`delete` throws when a row is absent**, so a cross-tenant id produced a 500
that distinguished it from a nonexistent one — the exact enumeration oracle the
404 guards exist to prevent. Six routes now use `deleteMany`.

### The tenant helper, redesigned

`asTenant(tenantId, fn)` took a string, and two routes passed it a value resolved
partly from the **request body**. It was safe only because an `if` ten lines
earlier rejected a non-superadmin supplying another tenant's id.

```ts
asTenant(user, fn)                             // the caller's own tenant
asTenantForAnotherTenant(user, tenantId, fn)   // throws unless SUPERADMIN
```

Proven unrepresentable: `asTenant(parsed.data.tenantId, …)` is now `TS2345`.
The narrow, true guarantee: a **client-supplied** value cannot reach the tenant
context. An **in-code** mistake can still compile — a mechanical pass did exactly
that, passing a Site row where a user was expected, because the row has a
`tenantId` field. Review caught it; tooling did not.

Three sites were deliberately **not** converted: doing so would have silently
redirected superadmin provisioning into their own tenant — which type-checks and
does the wrong thing.

### Geography isolation

`Governorate` and `District` carry no `tenantId` and so could never have had a
policy. Measured before the fix:

```
no tenant context  -> 36 districts      withTenant t-default -> 36
withTenant t-platform -> 36                             (identical = nothing filtered)
```

Closed with a `security_barrier` view (`v_geography`) deriving tenancy from the
Region chain, plus a `REVOKE` — the revoke being the half that actually matters:

```
SELECT count(*) FROM "District"      -> ERROR: permission denied
v_geography as t-default             -> 35 districts
v_geography as t-platform            -> 0
v_geography, no context              -> 0
```

A view rather than a denormalised `tenantId`, because duplication can drift: a
district whose region moved would keep a stale tenant id, which no constraint
prevents.

### Verification

```
tsc --noEmit                   0 errors
eslint .                       0 errors  (310 pre-existing warnings)
prisma validate                valid
migrate reset (from empty)     10 migrations, exit 0
db:seed                        {"seeded":true,"siteCount":52}
smoke-postgres                 PASS
rls-regression                 191 PASS / 0 FAIL / 0 BLOCKED, 30/30 tables
engine.ensureInit(['t-default'])  sites 52 | tanks 84 | generators 76
POST /api/fgmp/iot/ingest      HTTP 200, reading persisted, correct tenant
```

### Still outstanding — stated plainly

- **MQTT tenant isolation is unenforced.** A topic *structure* exists; there is
  no broker ACL and no broker client. Proving it needs a live broker.
- **Interlock thresholds are inferred, not sourced** (`NEEDS_OPERATOR_CONFIRMATION`).
  They fail toward refusal, but they are not engineering standards.
- **`SHED_BELOW_SITE_REQUIREMENT` cannot fire** — `protectedLoadKw` is unmodelled.
- **Ingest watermarks are process-local** — a retry routed to another replica
  will not see them.
- **Not end-to-end tested for most routes.** Most proofs are query-layer. Only
  ingest has been driven through a real HTTP handler. A route that typechecks and
  lints is not a route that has been observed working.
- **`app.tenant_id` is a session GUC.** Any process holding the `fgmp_app`
  credential can set it to any tenant. RLS catches a *missing* context, not a
  *wrong* one.
- **Not production-ready.** The user's bar was Phase 1's suite passing and Phase
  2's simulated telemetry gone. Both hold. Neither makes this production-ready
  with MQTT isolation unproven and most routes never exercised end to end.

### Addendum — `tsc` passing does not mean the app builds

`npx tsc --noEmit` reported **0 errors** while `bun run build` failed:

```
Type error: Type 'typeof import("src/app/api/fgmp/correlation/evaluate/route")'
does not satisfy the constraint 'RouteHandlerConfig<"/api/fgmp/correlation/evaluate">'.
  The types returned by 'POST(...)' are incompatible between these types.
    Type 'Promise<unknown>' is not assignable to type 'void | Response | Promise<void | Response>'.
```

Next.js requires an exported route handler to return `Response | void`. A
handler resolving to `Promise<unknown>` satisfies the compiler's own rules and
fails the framework's contract, so plain `tsc` cannot see it.

This matters more than an ordinary type error, because the build is what
produces the artefact that gets deployed. A green type-check gate — which CI
runs, and which was green for most of this programme — did not mean the
application could be built at all.

#### The hierarchy of what actually verifies something

Established the hard way across this phase, and worth stating plainly because
each level was believed sufficient until a higher one found the defect:

| Level | Found | Missed |
|---|---|---|
| `tsc --noEmit` | type errors | Next.js route-handler contracts |
| `eslint` | import violations, syntax | everything behavioural |
| RLS suite | cross-tenant policy breaches | routes that were never invoked |
| `bun run build` | framework contracts | anything that compiles but 500s |
| **real HTTP request** | 500s, empty-200s, wrong tenant | rendering, browser reachability |

Every defect in this programme that mattered was invisible to the level above
it: unscoped reads returning empty were invisible to `tsc`; the ingest 500 was
invisible to the build; a list returning `[]` for a tenant owning 52 sites is
invisible to every check except issuing the request.

The E2E harness exists because of that table, not because HTTP tests are a
general good practice.

---


<!-- source: docs/phase3-control-audit.md -->

## Phase 3 — control entry point audit (cross-tenant control gap)

Audit of every code path that mutates a physical asset from an issued command.
Question asked of each: **when the asset cannot be resolved, is the result a
DENIAL or a silent no-op SUCCESS?** A silent success is a defect, because the
operator is told the command was issued while nothing reached the device.

### Summary

| Entry point | Unresolvable asset | Tenant match asserted? | Verdict |
|---|---|---|---|
| `applyCommand` (generator) | `{ok:false}` | NO | **defect — silent success** |
| `controlDispenser` | `{ok:false}` + `resolveControlSite` | via site | deny, adequate |
| `applyEspReboot` | `{ok:false}` | NO | **defect — silent success** |
| `applyFirmwareDeployment` | `{ok:false}` | NO | **defect — silent success** |
| `applyGatewayReboot` | `{ok:false}` | NO | **defect — silent success** |

### The four defects

#### 1. `applyCommand` — writes a command row with NO tenant context
```ts
const cmd = await db.controlCommand.create({
  data: { tenantId: site.tenantId, ... }
});
```
Under FORCE RLS an INSERT whose `WITH CHECK` has no `app.tenant_id` in scope is
rejected outright. So the create **throws**, and `applyCommand` propagates the
exception rather than returning `{ok:false}`. The route catches it via
`errorResponse(err)`, which yields a 500. That is at least *not* a silent
success — but it is an unhandled crash on the most safety-relevant path in the
product, and the error text leaks a raw PostgreSQL policy message to the
operator.

It also writes `tenantId: site.tenantId` taken from ENGINE state, never from
the authenticated user. If the engine holds the wrong tenant, the row is
attributed to that tenant rather than the caller's.

#### 2. `applyEspReboot` / `applyGatewayReboot` — DB write failure is swallowed
```ts
db.fuelDispenser.update({ ... }).catch(() => {});
...
return { ok: true, status: "OFFLINE", message: `Reboot initiated on ${d.label}` };
```
Under RLS that `update` **always fails** (no tenant context), and `.catch(() => {})`
discards it. The function still returns `ok: true` and the route reports a
successful reboot to the operator while **nothing was persisted**. This is the
exact silent-success defect: in-memory state flips, the database does not.

#### 3. `applyFirmwareDeployment` — same class, worse
```ts
const release = await db.espFirmwareRelease.findUnique(...)   // no ctx -> null
if (!release) return { ok: false, message: "Firmware release not found" };
```
`EspFirmwareRelease` is one of three tables deliberately EXCLUDED from RLS (a
global catalogue), so the read does work. But `db.espFirmwareDeployment.create`
carries `tenantId` and has no context, so it **throws** — again a crash, not a
clean denial.

#### 4. No entry point asserts the asset's tenant matches the caller's tenant
`controlDispenser` is the only one that calls `resolveControlSite`, and even
that checks the SITE is resident rather than that it belongs to the tenant the
command was authorised for. An engine holding tenant A can never find tenant B's
asset, so the denial happens by accident of loading rather than by
construction. The invariant is not asserted anywhere.

### Why this matters even though a cross-tenant command is currently denied

The denial is a **side effect** of which tenants the process loaded, not a
control. Any of these makes it cross-tenant ALLOW:
- the engine later loading all tenants, or a different tenant per request
- `ensureInit()` being called with the request's tenant before resolving the asset
- a future change that resolves the asset from the DATABASE rather than memory,
  where an unscoped `findUnique` returns the row only because the id was known

So the gap is real and must be closed by construction, not left to a
convention that is currently holding by accident.

### The fix

A single `assertControlScope()` helper that takes the AUTHORISED tenant, the
resolved asset, and refuses when they differ or when the asset's tenant cannot
be determined. It is called at the top of every entry point, before any state
mutation. `applyEspReboot` and `applyGatewayReboot` additionally stop
discarding their DB errors.

---


<!-- source: docs/phase4-e2e-verification.md -->

## Phase 4 — end-to-end HTTP verification

### What this phase actually established

Nothing, until it didn't.

Three defects in this programme were invisible to `tsc`, `eslint`, and a fully
green RLS suite — 191 passing assertions at the time:

- `POST /api/fgmp/iot/ingest` returned 500 for every request, because a
  sessionless route called `bootstrap()`.
- `GET /api/fgmp/realtime/snapshot` had the identical bug.
- `GET /api/fgmp/sites` returned 500, because it read tables whose SELECT
  privilege had been revoked on purpose.

All three compiled. Only issuing a request found them. That is the argument for
this phase existing at all, and the argument is not theoretical — the third
defect was found *by* this harness, minutes after it was fixed into working
order.

### The harness had five defects of its own

The first sweep reported `61 routes, 61 failures`. That output is
indistinguishable from a total outage, and it was in fact a harness that could
not authenticate and was calling URLs that do not exist. Every one of these
fails *loudly enough to look like a product bug*, which is what makes them
worth writing down.

#### 1. Forged JWTs cannot authenticate

`sessionCookieFor` minted a NextAuth token locally with `jose`, on the stated
grounds that it was "hermetic" and "avoids a login round-trip". It was worth
nothing, because reproducing a session requires three things to match exactly —
and all three were wrong:

| Thing | Harness used | Server used |
|---|---|---|
| Signing algorithm | `HS256` | `EdDSA` |
| Issuer | `http://127.0.0.1:3080` | `http://localhost:3000` |
| Secret | exported env | `.env`, loaded at runtime, **overrides exported env** |

A JWT signed with the wrong algorithm family cannot be verified at any secret,
so no amount of secret-matching would have worked. The `.env` override is the
worst of the three: it is invisible from inside the harness, and no error
anywhere distinguishes "wrong secret" from "wrong algorithm".

The replacement is one HTTP round-trip:

```
GET  /api/auth/csrf
POST /api/auth/callback/credentials   (csrfToken, email, password)
```

#### 2. The CSRF cookie is not the CSRF token

The cookie's value is a `value|hash` pair whose first half matches the
`csrfToken` in the JSON body. Reconstructing the cookie from the body token is
the obvious implementation and the one written first here. It makes NextAuth
answer `302 → /api/auth/signin?csrf=true`.

The dangerous part is the status code: **302, not 4xx**. A harness checking only
`res.ok` sees a successful login, then reports 61 unauthenticated requests
against 61 routes. The harness now detects that specific redirect and aborts
rather than reporting a sweep it knows is invalid.

#### 3. `json=true` suppresses the session cookie

With `json: "true"`, NextAuth returns a JSON body instead of issuing the session
cookie. Another success-looking failure. Removed.

#### 4. The `/api` prefix was dropped

`dir.replace(root, "")` on `src/app/api` yields `/fgmp/sites`. `/api` is part
of the route. All 61 requests went to URLs that do not exist.

#### 5. Dynamic segments received placeholder ids

`e2e-site-00000000` is not a cuid, so Zod rejected it at the route boundary and
every dynamic route returned 400 before its handler ran — the sweep was
measuring its own placeholder.

That was the easy half. The subtle half: after switching to real ids, `[id]` was
mapped to a **site** id, so `/api/fgmp/tanks/<siteId>` returned a correct-looking
404. A 404 is *indistinguishable from a legitimate refusal*, so the handler
never ran and the sweep reported "gated — fine". Every `[id]` route now resolves
an id of the correct entity type per route:

| Route | Entity |
|---|---|
| `/tanks/[id]` | FuelTank |
| `/generators/[id]` | Generator |
| `/batteries/[id]` | BatteryBank |
| `/alarms/[id]` | Alarm |
| `/deliveries/[id]` | FuelDelivery |
| `/dispensers/[id]` | FuelDispenser |
| `/maintenance/[id]` | MaintenanceTicket |
| `/users/[id]` | User |
| `/sites/[id]`, `/shift-handover/[id]` | Site |

This is the general lesson: **a coverage sweep that passes tells you little
unless a wrong input is loud.** A placeholder id produced a 400, which was
visible. A wrong-type id produced a 404, which was not. Anything that can fail
"cleanly" needs its failure counted explicitly.

### What the sweep now proves

67/67 routes respond with no server error, against live PostgreSQL 17 and a
real session obtained by a real login.

```
/api/fgmp/sites        200   52 items
/api/fgmp/tanks        200   84 items
/api/fgmp/generators   200   76 items
```

#### The assertion that matters most

> A list route returning **200 with an empty array** for a tenant that owns 52
> sites is a FAILURE.

This is the check no static analysis performs. RLS is fail-closed: an unscoped
query returns zero rows rather than an error. So a route that forgets
`asTenant(...)` returns `200 []` — byte-identical to a correct response for a
tenant with no data, and completely invisible to `tsc`. Only a known quantity of
seeded data distinguishes them.

A cross-tenant leak check walks the response tree for the seeded foreign
tenant's site, tank and generator ids and fails if any appear.

### Correct refusals are not failures

Three routes answer 4xx/5xx by design. The sweep classifies them explicitly
rather than treating any 5xx as a fault:

| Route | Status | Why it is correct |
|---|---|---|
| `/api/fgmp/tick` | 503 | Refuses to fabricate telemetry. This endpoint's entire purpose is to invent data, so it is the one place a production deployment must say no. |
| `/api/fgmp/iot/ingest` | 401 | Authenticates with a service token, not a browser session. |
| `/api/fgmp/realtime/snapshot` | 401 | Same. |

Both service-token routes were built in Phase 2 *specifically* so that a
sessionless endpoint would refuse an authenticated browser. A 401 there is the
security property working.

Reporting the tick's 503 as a defect was the first thing this harness got wrong
once it started working. A sweep that cries wolf trains its reader to ignore it,
which costs far more than the bug it was meant to catch.

### Remaining 404s, individually verified

Not accepted on the sweep's word. Each was checked against the database:

| Route | Cause | Row count |
|---|---|---|
| `/alarms/[id]` | No alarms seeded | `Alarm` = 0 |
| `/api-keys/[id]` | No API keys seeded | `ApiKey` = 0 |
| `/shift-handover/[id]` | No handovers seeded | `ShiftHandover` = 0 |
| `/generators/[id]/control/[commandId]` | No commands issued | `ControlCommand` = 0 |
| `/history/[entityId]` | No readings to page over | `SensorReading` = 0 |
| `/dispensers/[id]/commands` | Ids that are not dispensers | — |
| `/tenants/[id]` | Given a site id, correctly refused | — |
| `/proposal` | Must be generated first | — |
| `/iot/[siteId]/ota-status` | No OTA record for that site | — |

### Defects only a request could find

Once the harness worked, it earned its keep. Every one of these passed
`tsc`, `eslint`, a green RLS suite, and `prisma migrate deploy`.

#### Geography writes were revoked along with geography reads

`GET /api/fgmp/sites` returned 500 with `permission denied for table
Governorate`. Migration 20261007000000 had correctly closed a real enumeration
hole by `REVOKE ALL`ing two tables that carry no `tenantId` — but `ALL` also
took away the INSERT/UPDATE/DELETE that ten geography handlers legitimately
need.

The fix was **not** to re-grant. Both tables now carry tenantId-derived RLS
(ENABLE + FORCE), with tenancy derived through the parent `Region` chain. The
revocation was never wrong; the routes had simply never been migrated with it.

Measured as `fgmp_app`, before and after:

| | before | after |
|---|---|---|
| no tenant context | 36 | **0** |
| `t-default` | 36 | 35 |
| `t-platform` | 36 | **0** ← the original defect |

#### A missing `updatedAt` DEFAULT survived a migration, a generate and a `tsc`

`POST /api/fgmp/solar-sites` returned 500 — `P2011`, null constraint on
`updatedAt`. Prisma's `@updatedAt` is applied by the client, so the schema looks
correct, but the column was `NOT NULL` with no `DEFAULT`, and the raw SQL table
had to stand on its own.

Nothing static can see this. It is the identical bug the RLS suite had already
caught once for `InterlockThreshold`, written again from scratch by a different
agent in a different migration.

#### `Promise.allSettled` discarded the database's duplicate verdict

`POST /api/fgmp/iot/ingest` answered **200** even when the write it had just
attempted had been rejected as a duplicate. The results were collected and
thrown away. That is the specific thing a durable uniqueness constraint was
added to prevent: the database adjudicates duplicates, and the handler then
ignored its answer.

Now a unique violation becomes 409 with `REJECT_DUPLICATE`, matching the
pre-write verdict so a device sees one answer regardless of which replica served
its retry. The check is deliberately narrow — a generic failure mislabelled as a
duplicate would tell a field device to stop retrying while its data was dropped.

#### A measurement was collected and thrown away

The Modbus reader parses a signed `cellBalanceMv`, and a threshold module
consumed it, but nothing stored it: read off the wire, held in a local, gone.
It could not be trended, alarmed on, or reviewed.

It is now stored twice on purpose — as a `SensorReading` (the trend, because
imbalance is diagnosed by how it *moves*) and on `BatteryBank.cellBalanceMv`
(current state, readable without scanning history). Verified over HTTP:

```
POST /api/fgmp/iot/ingest  {"battCellBalanceMv": -47}  -> 200
SensorReading  BATT_CELL_BALANCE_MV = -47
BatteryBank    cellBalanceMv       = -47
```

Signed, not absolute: the sign is the diagnosis. `+47 mV` and `-47 mV` point at
different cells to replace.

### Mutations, verified by hand

The sweep is GET-only. The new write surfaces were exercised directly against
the production build rather than left untested:

| Operation | Result |
|---|---|
| `POST /solar-sites` | 201 |
| `POST /solar-arrays` | 201 |
| `GET /solar-sites/[id]`, `/solar-arrays/[id]`, `/interlocks/thresholds/[id]` | 200 |
| `PATCH /solar-sites/[id]` | 200 |
| `POST /interlocks/thresholds` twice, same key | 201 both, same row id — updates in place |
| `DELETE /interlocks/thresholds/[id]` | 200 |

RLS on the new tables, as the non-owner app role:

| | no context | `t-default` | `t-platform` |
|---|---|---|---|
| `SolarSite` | 0 | 1 | **0** |
| `SolarArray` | 0 | 1 | **0** |
| `InterlockThreshold` | 0 | 1 | **0** |

### Running it

```bash
# Against a server already running (safe while other agents edit the tree)
E2E_SKIP_BUILD=1 E2E_BASE_URL=http://127.0.0.1:3210 \
  bun run scripts/verify/e2e/run-route-sweep.ts

# Self-contained: builds, boots on :3399, sweeps, tears down
bun run scripts/verify/e2e/run-route-sweep.ts
```

`E2E_SKIP_BUILD` exists because `next build` reads every source file in the
tree. In a shared worktree it picks up other agents' half-finished edits and
reports failures that belong to someone else's work in progress.

### What this still does not prove

- **Mutations.** The sweep is GET-only. Firing every POST at a live database
  needs a per-endpoint fixture story, and a generic POST that passes proves less
  than an honest gap.
- **The UI.** Nothing here shows a page renders, or that the browser can reach
  these endpoints. It shows the endpoints do what they claim.
- **Concurrency.** The multi-replica watermark and advisory-lock behaviour have
  dedicated scripts, not route coverage.

---


<!-- source: docs/phase5-gap-assessment.md -->

## Phase 5 — gap assessment

Answers "what remains?" by checking the Phase 0.5 audit (`REVIEW.md`) against the
code as it stands now, rather than against what the audit said in October.

Four agents verified in parallel, split by surface. Findings below are the ones
confirmed by direct inspection afterwards — where agents disagreed, the
conflict was resolved by recomputing rather than by picking a side.

---

### The honest headline

**The control path is simulated.** `applyCommand` writes no hardware: no Modbus
register write, no MQTT publish, no serial or socket I/O. It creates a
`ControlCommand` row, then mutates in-process memory.

This is the single most important thing in this document, because the platform
presents itself as remotely controlling generators and it does not. Nothing is
damaged today precisely because nothing is connected — but an operator reading
the `ControlCommand` table would believe an engine had been started when no
signal ever left the process.

---

### Critical

#### 1. `Dockerfile` is a SQLite artifact and will refuse to boot

```dockerfile
CMD ["sh", "-c", "bun ./scripts/db/docker-init-db.js && exec bun server.js"]
```

```js
// scripts/db/docker-init-db.js:22-27
if (!raw || !raw.startsWith("file:")) {
  console.error(`[init-db] DATABASE_URL must be a file: URL ...`);
  process.exit(1);
}
```

Deployed against the PostgreSQL that `docker-compose.yml` actually provisions,
the container hard-exits on boot. This survived the entire SQLite →
PostgreSQL migration. **Effort: ~1h.** Nothing else can be verified on a real
deploy until this is fixed.

#### 2. The `EXECUTED` lifecycle is documented in three places and implemented in none

`engine.ts:1842-1855` creates the row with `status:"SENT"`,
`executedAt: new Date(this.now)` and `result:"OK"` **at issue time** — before
anything could have happened.

- `src/app/api/fgmp/generators/[id]/control/[commandId]/route.ts:18` — claims a
  `PENDING → SENT → EXECUTED | FAILED | TIMEOUT` lifecycle
- `prisma/schema.prisma:1006` — same claim in the model doc

`grep -rn '"EXECUTED"' src/` returns **zero hits**. The enum has five members;
the code only ever writes `SENT` and `FAILED`.

This is worse than having no comment. A comment asserting a safety lifecycle
that does not exist tells an auditor the control is verified when it is not.

#### 3. Per-tenant thresholds are stored but never read at runtime

I built the `InterlockThreshold` table and its API in Phase 4 and treated the
table as live without tracing the enforcement path end to end. That was my
error.

`buildInterlockContext` (`interlock-state.ts:105-121`) builds the context object
and never sets `thresholds`. `thresholdsOf(ctx)` therefore falls through to the
hardcoded constants.

**Proven, not inferred.** A row was written to the live table
(`coolantMaxC = 120`, `source OEM_DATASHEET`) and a generator evaluated at
88 °C:

```
DB row actually stored:  [{"thresholdKey":"coolantMaxC","value":120,...}]
ctx.thresholds:          undefined          <- table not loaded
verdict.allowed = false -> COOLANT_HOT_AT_ASSUME_LOAD   (at the 85 °C default)
```

The operator's confirmed OEM limit was ignored. The audit trail records the
hardcoded 85, so a denial is recorded against a limit the operator may have
overridden in the UI — an audit-integrity problem, not just a missing feature.

#### 4. Unknown tank capacity permits cranking on an empty tank (fail-open)

```ts
// interlock-rules.ts:269
if (!tankCapacityLitres || tankCapacityLitres <= 0) return null;
```

`null` means the rule does not fire, so the action is permitted:

```
fuel = 0.1 L, capacity UNKNOWN -> allowed = TRUE   <- permits
fuel = 0.1 L, capacity = 0      -> allowed = TRUE   <- permits
fuel = 0.1 L, capacity = 500    -> allowed = false  (correctly denied)
```

The in-code rationale — *"uncomputable, so the rule declines rather than
guess"* — is sound reasoning about not **inventing a number**, and wrong about
what the rule should **do**. Declining the *check* is the opposite of fail-safe.
This is the one finding that would let a genuinely unsafe command through the
moment real hardware exists.

#### 5. Control events are never persisted

```ts
// engine.ts:2150
db.siteEvent.create({ data: { tenantId: site.tenantId, ... } }).catch(() => {});
```

The bare client, no tenant context. Under `FORCE` RLS this **always** fails, and
`.catch(() => {})` discards the error. `REMOTE START` / `REMOTE STOP` events
exist only in memory until restart.

Same silent-success pattern already fixed twice elsewhere in this codebase.

---

### High

| # | Gap | Evidence |
|---|---|---|
| 6 | **No backups at all.** `lib/fgmp/backup.ts` and `/api/fgmp/backup*` were removed in Phase 0 (correctly — it leaked full DB copies) and nothing replaced them. `fgmp_ops` is provisioned for `pg_dump` and never invoked; the `fgmp-backups` volume is mounted and unwritten. | `docker-compose.yml:21` |
| 7 | **Fuel volumes are still `Float`.** Money moved to `Decimal` (4 columns), but `FuelTank.capacityLitres/currentLitres`, `FuelTransaction.volumeLitres`, `FuelDispenser.totalizerLitres` and the delivery volumes did not. `totalizerLitres` is a lifetime accumulator — float drift is what a fuel-dispute hinges on. | `schema.prisma` |
| 8 | **Engine state is never persisted.** Zero `fuelTank`/`generator`/`batteryBank` writes from the engine; state is read once at init. Every restart resets assets to seeded values, and two replicas diverge silently. | `engine.ts:178-189` |
| 9 | **Rate limiter is per-replica** — `const buckets = new Map(...)` at module level. Five login attempts/IP becomes 5×N. The IoT ingest limiter has no DB backing at all. | `rate-limit.ts:28` |
| 10 | **No notification transport.** No SMTP/webhook/SMS anywhere. The `NO_TRANSPORT` enum added in `20261008003000` is **never set by any application code**, so a queued row still reads as deliverable. | `grep NO_TRANSPORT src/` → nothing |
| 11 | **Theft detection does not exist.** `engine.ts:768` still *injects* theft via the seeded PRNG. There is no measurement-derived detection anywhere; `forecast/route.ts:289` detects unexplained *rises*, the inverse case. | verified |
| 12 | **Zero tests in CI.** 10 test files and a `bun test` script exist; `ci.yml` runs typecheck/lint/validate/build and no test step. Nothing mechanically prevents regression — the exact failure mode that produced this codebase. | `.github/workflows/ci.yml` |
| 13 | **RBAC inversions**, confirmed exactly: `READONLY` has `view:roles` (can see role management), `EXECUTIVE` lacks `view:sites`/`view:fuel`/`view:generators`, `FIELD_ENGINEER` lacks `view:suppressions`. | `rbac.ts` |

---

### Medium

| # | Gap |
|---|---|
| 14 | No observability: zero `pino`/`prom-client`/otel/Sentry deps, no metrics export, no tracing. You cannot alert on fuel-theft alarms. |
| 15 | TimescaleDB image runs but `create_hypertable` appears nowhere; `SensorReading` is a plain unbounded table. |
| 16 | No session `maxAge`/rotation, no MFA. For remote-start capability that is a real risk. |
| 17 | 4 divergent site-health formulas — not one formula in three places but three genuinely different weightings. `site-health-badge.tsx:64`, `site-health-trend.tsx:90`, `region-detail-sheet.tsx:71`. |
| 18 | 97 of 100 routes duplicate the `requireAuth` + rate-limit boilerplate; no HOF. The IDOR class recurs by copy-paste. |
| 19 | 39 selector-less `useFgmp()` calls against a vanilla Zustand store → re-render every 5s tick. |
| 20 | 7 native `window.confirm` for destructive actions (no focus trap, no RTL). |
| 21 | Command palette hardcoded English (`next-intl` not installed), `G R` shortcut collision. |
| 22 | 9 of 27 views lack error UI. |
| 23 | `asset-registry-view.tsx` is 2,239 lines — past the point where contrast and focus order can be reviewed reliably. |
| 24 | 7-day forecast is one number repeated seven times. `analytics/route.ts:289-290`. |
| 25 | Export is CSV-only; `docx` is a dead dependency. |
| 26 | Correlation rules record matches but never raise or escalate an alarm. |
| 27 | TOCTOU: `enforceInterlock` and `applyCommand` are separate awaits with no lock and no re-check. |
| 28 | No command idempotency; rows accumulate in `SENT` forever, which will eventually make `COMMAND_ALREADY_IN_FLIGHT` refuse *all* commands to that generator. |

---

### Resolved and should be retracted from REVIEW.md

`REVIEW.md` is now actively misleading — it lists defects that no longer exist,
which is worse than not having audited.

| Claim | Reality |
|---|---|
| "Tests: zero" | 10 test files, `bun test` script. Correct criticism: *CI never runs them.* |
| "Migrations: none" | 16 versioned migrations incl. RLS, replayed from empty in CI. |
| "SQLite, not PostgreSQL" | `provider = "postgresql"`. |
| "41 Float, 0 Decimal" | 4 `Decimal`. Correct criticism: *monetary columns converted, fuel-volume columns are not.* |
| "No Modbus/RS485 driver in the repo" | Real protocol layer with CRC-16, Modbus RTU, MQTT, tests. |
| "`edge/rs485` returns hardcoded zeros" | Zeros are now a historical note; live values persisted. |
| "No safety interlocks" | `interlocks.ts` implements them, two-person approval, 2 migrations. |
| "`stolenValueUsd` fabricated" | `DEFAULT_FX_YER_PER_USD = null`. USD figures are null, not invented. |
| "9 views return null while loading" | 1 does. |
| "~44 `Math.random()` calls" | 2; the rest use a seeded PRNG. |
| "38 dead API routes" | 0 are dead; 100 exist. |
| "21 dead shadcn components" | 17 are unused, of 48. |
| "9,600 LOC dead" | Built on the dead-route premise. Codebase is 78.3k LOC. |
| "Monolith vs 15 services" | Factually unchanged; see below. |

#### On the monolith — the spec was wrong

The spec asked for 15 NestJS services with no stated consistency requirement.
The product's core operation is *"read tank level → compare against expected
consumption → raise theft alarm → page a human"* — a single transaction
boundary. Splitting it across services would put network hops inside the alarm
decision.

What is actually missing from the spec is **guarantees**, not service count:
RLS ✓, enums ✓, exact money ✓, migrations ✓. The two boundaries that genuinely
deserve separation already run as separate processes (`mini-services/realtime`,
`mini-services/iot-bridge`), alongside a real broker.

**The honest gap is not "too few services."** It is that simulated telemetry
still drives the numbers, and volume columns are float. Fixing those two yields
a defensible single deployable; splitting into 15 services first would multiply
the surface without fixing either.

---

### Recommended order

1. **Dockerfile** (~1h) — nothing deploys until this is fixed.
2. **Wire the threshold loader** into `buildInterlockContext` (~2h) — closes the
   fail-closed audit-integrity half of the gap I introduced.
3. **Make unknown capacity deny, or fall back to an absolute litres floor**
   (~1h) — the only finding that would let an unsafe command through.
4. **Stop the false `EXECUTED` record** — either write `PENDING` and have a real
   executor confirm, or rename the status so the table stops asserting an
   outcome that never happened.
5. **Fix `pushEvent`** (~1h) — control events must persist.
6. **Add `bun test` to CI** (~1h).
7. **Backups** (~4h) — cron + retention + a restore drill.
8. Fuel volumes → `Decimal` (~1 day).
9. Persist engine state, or move telemetry to `SensorReading` (~3 days).

Items 2 and 3 together are under three hours and close the only two findings
where the platform's *safety* claims are weaker than its documentation implies.

---


<!-- source: docs/phase5-engine-state-persistence.md -->

## Phase 5 — engine state persistence, and the hypertable blocker

Answers two questions that were previously left as judgement calls:
**is persisting engine state on tick viable?** and **what exactly blocks
`SensorReading` from becoming a hypertable?**

Both are answered with measurements and with the actual constraint text, so the
next person does not re-derive either.

---

### Part 1 — Engine state is loaded once and is NOT persisted

Stated plainly, because the harm is real and it is not visible from the code:

- The engine reads sites, tanks, generators, batteries, dispensers, gateways and
  IoT devices **once**, in `init()`.
- `tick()` mutates those **in-memory** objects.
- It does **not** write the live telemetry back to `FuelTank`, `Generator`,
  `BatteryBank` or `FuelDispenser`.

Two consequences:

1. **A restart reverts every asset to its seeded value.** A tank drawn down
   across a shift reads full again after a deploy.
2. **Two replicas diverge silently.** Replica A ticks its own copy and replica B
   ticks its own; neither reads the other. Only one replica advances the clock —
   the tick is guarded by `pg_try_advisory_xact_lock` in `scheduler.ts:286` — so
   the other replica's copy simply never moves rather than being overwritten.
   Two operators can look at the same site and see different levels, and neither
   is lying.

The persisted history is `SensorReading`, appended by the ingest path. That is
where a restart's telemetry is recoverable from. The denormalised "current
level" columns on the asset tables are **not** a record of anything the engine
produced.

This is now documented in code at both points that matter — `init()` and
`tick()` — as a greppable block, so nobody has to discover it by noticing a tank
that moved backwards.

#### Does writing on tick fit in the budget? — measured, not estimated

Live asset counts at the time of measurement: **53 sites, 85 tanks, 77
generators, 52 batteries, 24 dispensers = 238 assets**.

At a 5 s cadence that is **47.6 rows/sec, 14,280 rows/min, 857k rows/hour**.

Prototype: `scripts/verify/measure-tick-persistence.ts` — replays the exact UPDATE set
a persisting tick would issue, against the live database, holding the same
advisory lock the scheduler uses.

| Variant | Shape | ms/tick | % of the 5 s budget | Verdict |
|---|---|---|---|---|
| **A** | row-at-a-time, autocommit per statement | **24,451** | **489%** | **OVER BUDGET** |
| **B** | row-at-a-time, one transaction holding the lock | **29,896** | **598%** | **OVER BUDGET** |
| **C** | 4 set-based `UPDATE ... FROM (VALUES …)` per tick | **1,052** | **21%** | **OK** |

**The naive implementation is ~5x over budget** — a 5-second tick would take
24 seconds, and the tick would overlap itself. This is not a rounding concern; it
is the difference between a working monitor and one that wedges.

**Conclusion: persisting on tick is viable, but only in the batched form.** The
per-row round trip is what costs, not the rows: variant C writes the same 238
rows in a quarter of the time variant A does, because it is 4 statements instead
of 238 round trips.

If this is done, it must be variant C. Anything row-at-a-time is a
non-starter at this asset count, and the number to beat is 5,000 ms.

#### A measurement trap worth recording

The first version of variant C used `unnest($1::text[], $2::numeric[], …)` with
`$executeRawUnsafe`. That is **silently invalid under Prisma**: the driver
passes a JS array as a *single* parameter, so the query fails with
`incorrect number of parameters. Expected: 3, actual: 1`. Because the prototype
wrapped its work in a `catch`, that surfaced as `rows=0` — which reads exactly
like "the advisory lock was never acquired", and sent the investigation down the
wrong path twice.

The working form builds an explicit `VALUES` list with `Prisma.join`, giving one
bind parameter per element. It was verified to update 85/85 rows before being
timed.

Worth stating plainly: **a measurement that reports zero is not a measurement.**
The harness now distinguishes `FAILED:` from `VERDICT:` so this cannot be
mistaken for a result again.

#### Not done, deliberately

Variant C is proven viable and is *not* landed. Writing it into `tick()` means
deciding what happens when the write fails mid-tick — whether the tick aborts,
whether state diverges further, and how that is surfaced. That is a behavioural
decision about the monitoring path, not a performance one, and it belongs with
the Lead rather than inside a measurement commit.

---

### Part 2 — Why `SensorReading` is not a hypertable yet

`docker-compose.yml` runs the `timescale/timescaledb` image, but
`create_hypertable` appears nowhere in the repo. `SensorReading` is a plain,
unbounded table.

#### The blocker, precisely

A TimescaleDB hypertable requires that **every unique constraint and primary
key on the table includes the partitioning column**. `SensorReading` is
partitioned by time (`ts`), and its primary key is:

```prisma
model SensorReading {
  id          String   @id @default(cuid())
  // ...
  ts          DateTime @default(now())
}
```

`id` is a cuid and does **not** include `ts`, so `id PRIMARY KEY` cannot
coexist with `create_hypertable(..., partitioning_column => 'ts')`. Converting
the table therefore requires **changing the primary key strategy**, not just
adding an extension call.

#### Why that is not a small change

The primary key is load-bearing for duplicate protection.
Migration `20261008001000_sensor_reading_dedup_watermark` makes
`(entityId, metric, ts)` **UNIQUE** and documents, at length, why the database —
not Redis, not process memory — is the authority for rejecting replayed
telemetry. The reasoning depends on the storage engine enforcing the constraint
on every writer on every replica with no shared mutable state to keep in step.

Any hypertable migration must therefore preserve:

1. **The `(entityId, metric, ts)` unique constraint.** It already contains the
   partitioning column, so it survives the conversion — but it must be
   re-created as a hypertable-aware constraint, and on a partitioned table a
   unique constraint's behaviour with `NULL` and with concurrent inserts across
   chunks must be re-verified rather than assumed.
2. **The ingest watermark's assumption that a duplicate is a constraint
   violation.** The ingest route translates a unique violation into a
   `REJECT_DUPLICATE` verdict. If the constraint changes shape, that translation
   is what has to keep working — and it is covered by a test, so a regression
   would be caught, but it would be caught late.
3. **The `id` primary key.** Either it moves to `(ts, id)`, which changes every
   `findUnique({ where: { id } })` in the codebase, or `id` is dropped in favour
   of a natural key — which is a larger design change than it appears, because
   `id` is referenced from `history/[entityId]`-style routes.

#### The open question nobody should guess at

**Does `create_hypertable` reject a table whose primary key omits the
partitioning column, or silently drop/rewrite that constraint?**

The answer determines whether step 1 of the migration is "add a composite
primary key" or "drop the primary key". It is a one-line experiment against the
live TimescaleDB image, and it should be run before any migration is written —
not discovered halfway through one.

Until that is answered, the table stays as it is. It is a correct, ordinary,
unbounded table. It is not corrupt; it is simply not yet time-partitioned, and
the cost of that is storage growth rather than incorrect data.

---

### What is actually correct today

- Volume is `Decimal(12,3)`; money is `Decimal`. The Float/Decimal boundary is
  documented at the top of `schema.prisma` — the test is whether a value
  accumulates or participates in a reconciliation, not how important it looks.
- Telemetry history (`SensorReading`) is durable and is written by the ingest
  path. What is missing is the denormalised current-level cache, not the record.
- The RLS boundary is real: 24 tables with `tenant_id NOT NULL`, FKs to
  `Tenant(id) ON DELETE RESTRICT`, and no catch-all grants.

### How to reproduce the measurement

```bash
MEASURE_TICKS=10 bun scripts/verify/measure-tick-persistence.ts C   # batched    (~1.0 s/tick)
MEASURE_TICKS=3  bun scripts/verify/measure-tick-persistence.ts A   # row-at-a-time (~24.5 s/tick)
MEASURE_TICKS=3  bun scripts/verify/measure-tick-persistence.ts B   # row-at-a-time in a txn (~29.9 s/tick)
```

The prototype writes real values into the demo asset rows. The database holds
regenerable seed data only, but reset the levels if you care about the demo
looking plausible:

```sql
UPDATE "FuelTank" SET "currentLitres" =
  round(("capacityLitres" * (0.15 + (random() * 0.75)))::numeric, 3);
```

---


<!-- source: docs/phase5-remediation-close.md -->

## Phase 5 — remediation close

### The gate

```
tsc --noEmit          0 errors        (was 207 at the start of the sweep)
bun test              516 pass, 0 fail, 24 files
RLS regression        214 pass, 0 fail
production build      BUILD_ID anLb854TSA7gw_OCGesWW
E2E route sweep       68/68, 0 problems
```

37 commits. Verified by execution, not inspection.

The route count went from 61 to 68 — the solar and threshold surfaces added in
Phase 4 are now covered, and the tenant-scoped checks still return real data
(52 sites / 84 tanks / 76 generators) with no cross-tenant leak.

### What the 207 errors actually were

Worth recording, because the shape of them is the lesson and not any individual
one:

| Count | Cause | Whose |
|---|---|---|
| 164 | `Cannot find name 'useState'` — a selector conversion replaced `import … from "react"` instead of adding alongside it | p2-telemetry |
| 21 | `Prisma.Decimal` not assignable to `number`, after the `numeric(12,3)` conversion | p1-schema, p2-telemetry, me |
| 6 | `Number.isFinite(decimal)` always false; `?? 0` yielding `NaN` in a reduce | p1-schema |
| 3 | A `createdAt` column that does not exist on `ControlCommand` | p2-interlocks |
| 3 | `.reason` read off an unnarrowed union | p2-protocol |
| 3 | Missing React import / stale generated validator | mixed |

#### The ones that were not type errors

Five of them compiled cleanly and were quietly wrong. These are the ones that
would have shipped:

1. **Rate limiting silently disabled** on `/api/fgmp/users/[id]`. `limitFor()`
   became `async` when the limiter moved to Redis; the call sites were not
   awaited, so `limited.success` was `undefined` and `if (!limited.success)` was
   always false. Every request returned 200. No log, no crash, no test failure —
   and the helper's own doc comment says it exists to stop exactly that.

2. **Delivery-discrepancy detection comparing the wrong volume.**
   `Number.isFinite(decimal)` is always false because a Decimal is an object, so
   the ternary took the fallback on every row — reconciling short and over
   deliveries against the **ordered** volume instead of the **delivered** one.
   Precisely the case that endpoint exists to catch.

3. **A total reporting `NaN`** because `(d.volumeDeliveredLitres ?? 0)` in a
   reduce does not fire on an object, giving `0 + DecimalObject`.

4. **`ReferenceError` on cancelling a deletion.** `settle` referenced itself
   from inside the object literal it was defined in. The most safety-relevant
   interaction in the new confirmation dialog — the one that must NOT perform the
   action — was the broken one.

5. **Idempotency doing nothing.** `idempotencyKey` was missing from a Prisma
   `select`, and an `as string` cast silenced the error, so the replay branch
   could never match. 55 unit tests over the decision core passed throughout:
   the pure core was handed the right value by a cast at the integration seam.

#### Three lessons, stated so they survive

**A guard written when a column was Float stops meaning anything once it is
not, and keeps compiling.** `?? 0`, `Number.isFinite`, a bare `+`, an `as
number`. Four separate defects, one shape.

**A cast at a module boundary converts a type error into a silent no-op**, and
no amount of testing the pure side notices. 55 green tests could not see a
missing `select` field; the typecheck found it in seconds.

**ESLint is a style check, not a correctness check, for TypeScript.**
`no-undef` is disabled in every TS-targeted config, so 16 files that did not
compile reported 0 lint errors. That gap was mine: I suggested eslint as the
cheap per-file check without saying plainly that it cannot see a missing import.

### Critical items closed

| Item | Status |
|---|---|
| Dockerfile could not boot (SQLite init, hard-exit on Postgres) | rewritten; `migrate deploy`, no DDL in the app process. **Image build + boot still unverified** — needs one run on a quiet machine |
| Backups | verified both directions: 236 KB dump + SHA-256, restored into a probe DB, row counts matched the live database |
| Thresholds stored but never read | `loadThresholdsForInterlock()` reads inside `withTenant`; proven: DB row `coolantMaxC=120` now allows 110 °C where the 85 default denied it |
| Fail-open on unknown tank capacity | now DENIES with an actionable message; verified `fuel=0.1L, capacity UNKNOWN → allowed=false` |
| False `EXECUTED` lifecycle | `executedAt: null`, `result: "SIMULATED_DISPATCH_APPLIED_NO_HARDWARE"`; the three comments claiming a lifecycle no longer claim one |
| `pushEvent` silently failing under RLS | runs in `withTenant`, logs on failure; third instance of the silent-success pattern |
| TOCTOU between interlock and dispatch | re-evaluated inside a per-generator critical section |
| Fake `EXECUTED` never written | correct states now |
| Correlation matches recorded but not acted on | raises `Alarm.severity`, idempotent, mutation-tested |
| Theft injected then reported | now derived from measured level vs runtime-predicted consumption |
| Invented FX rate | `null` with `NO_FX_RATE_CONFIGURED` |
| Fabricated delivery-order number | removed |
| CSV-only export | CSV + XLSX + DOCX |
| Forecast repeating one number 7× | least-squares projection with explicit direction and R² |
| In-memory rate limiter | Redis, per-endpoint failure policy |
| No notification transport | real SMTP + webhook + Twilio SMS; three outcomes distinguishable |

### Still open, honestly

1. **Dockerfile image build and boot — unverified.** The entrypoint is verified
   by execution against live Postgres (migrated → starts; empty → refuses;
   unreachable → refuses with a different message). The image itself is not.
2. **Engine state is not persisted.** Two agents independently concluded the
   real fix is moving telemetry to `SensorReading`, which is the same task as
   the hypertable work and touches the RLS hot path. Not started, deliberately,
   with the reasoning recorded.
3. **`create_hypertable` conflicts with `SensorReading`'s cuid primary key** —
   converting it means changing that table's PK strategy.
4. **Remote generator control is still simulated.** Interlocks, idempotency,
   reconciliation and locking are all real now, but nothing writes to hardware.
5. **MFA assessed, not implemented** — `docs/mfa-assessment.md`. A half-built MFA
   produces a condition its users cannot distinguish from a locked-out platform.
6. **Frontend Tasks 5–8** (palette, error UI, `asset-registry-view` split, dead
   code) and 5 of 7 `window.confirm` conversions.
7. **No observability consumer** — `/metrics` and structured logs exist; nothing
   scrapes them or alerts.

---


<!-- source: docs/phase5-final-close.md -->

## Phase 5 — final close

### The gate

```
tsc --noEmit          0 errors        (was 207 at the start of the sweep)
bun test              712 pass, 0 fail, 35 files
RLS regression        238 pass, 0 fail   (was 214)
production build      NpToeMzAU7lnGnzAJPR29
E2E route sweep       70/70, 0 problems, no cross-tenant leak
migrate status        up to date, 22 migrations
```

58 commits across 8 agents.

### Verified against the built image

Not "the Dockerfile looks right" — the image was built and booted:

| Check | Result |
|---|---|
| Migrations enabled | 22 migrations, "No pending migrations to apply", Ready in 2.7s |
| `/api/fgmp/health` through the container | **401** `UNAUTHENTICATED`; root 200 |
| Empty DB + `FGMP_SKIP_MIGRATE=1` | preflight refuses, exit 1 |
| Least privilege, `fgmp_app` | `CREATE TABLE` → 42501; `CREATE INDEX`/`DISABLE RLS`/`DROP TABLE` → must be owner |
| Escalation to `fgmp_migrate` | was reachable; now closed |

The production scheduler also refused to fabricate telemetry, unprompted:
*"Simulated telemetry is disabled in production … would be reporting fiction as
fact."* Nobody asked it to. That is the assertion-of-honesty working.

### The finding that mattered most

p0-impl was verifying least privilege and found the credential check came back
**PRESENT**. Rather than report the green result they wanted, they reproduced the
consequence from inside the running container:

```
escalate to: {"u":"fgmp_migrate"}
DDL SUCCEEDED as {"u":"fgmp_migrate"}
```

`fgmp_migrate` is the schema owner and a SUPERUSER. Every RLS policy in this
project is bypassed by it. And the trigger was innocent — passing the variable in
to test migrations, exactly as a reasonable person would.

The boundary had been resting on documentation ("compose never gives the app the
owner URL") rather than enforcement. The server now runs with the credential
deleted from its environment; it is needed for exactly one `spawnSync` and has no
reason to exist for the lifetime of the process serving traffic.

**A documented boundary is not a boundary.** That is the whole lesson of this
phase, and it took a boot failure to demonstrate rather than a type error.

### And the guard that passed for the wrong reason

In the same file:

```js
process.env.FGAP_MIGRATE_DATABASE_URL || process.env.DATABASE_URL
//                              ^^^^^ not FGMP_
```

The preflight fell through to the app's own RLS-enforced credential. The
empty-database test still passed — against an empty database even the app role
sees no `Tenant` table, so the refusal happened for an entirely wrong reason.

No assertion shaped like *"refuses to start on an empty database"* would ever have
distinguished the two. **A guard that passes for the wrong reason is not a
guard**, and this project has now produced that mistake in five distinct
guises: an absent metric reading as zero, a bypassed rate limiter, `NaN` from
`??` on a Decimal, an `as string` hiding a missing select field, and a preflight
using the wrong credential.

### Verified after the credential fix (fgmp:boot3)

| Check | Result |
|---|---|
| Escalation to `fgmp_migrate` | **closed** — `/proc/1/environ` has the credential, the server's does not |
| Boot with the credential stripped | both branches, no regression; `/api/fgmp/health` → 401 |
| Preflight refuses for the *right* reason | proven by discrimination, see below |
| Hypertable ingest | 2 distinct readings persisted; replays refused; PK constraint live on the hypertable |

```
PID 1  (entrypoint)  FGMP_MIGRATE count: 1   ← for the one migration call
PID 63 (THE SERVER) FGMP_MIGRATE count: 0   ← gone
PID 63 DATABASE_URL=postgresql://fgmp_app:***@…
```

`DATABASE_URL` is deliberately NOT stripped — the app keeps its own credential.

**The preflight test was inverted rather than trusted.** "Refuses on an empty
database" cannot distinguish the two credentials, because both see no `Tenant`.
So: `DATABASE_URL` → the working database, `FGMP_MIGRATE_DATABASE_URL` → the
empty one. It refused. If it had fallen through to `DATABASE_URL` it would have
started. That is conclusive, and it is the only version of this test that means
anything.

**Which dedup guarantee is which.** The first replay was refused by the per-site
watermark (`REJECT_STALE`, older than newest), not by the database. Only the
second reached the constraint. So the watermark short-circuits an out-of-order
retry, and the database constraint is the backstop for the case the watermark
cannot cover — a cross-replica race, two instances accepting the same reading
simultaneously. That case is **not** exercised; it needs two live replicas.

**Residual, stated rather than hidden.** `/proc/1/environ` is world-readable
inside the container, so an RCE in the server could still read the owner URL from
PID 1. Far smaller than before — it requires RCE, and compose never passes the
variable to the app container — but not zero. Option (a), a separate one-shot
migration job, closes it entirely and is the right shape for a real deployment.

### Three more real defects, found by execution

1. **Ambiguous tenant resolution made every control command reload the world.**
   `ensureInit()` resolved tenants from query results — 34 tenant fixtures left by
   test runs meant 15,867 ms per command against 629 ms for one. Now no request
   path can resolve ambiently; `ensureAllTenants()` is the one named exception.

2. **The dedup guarantee was a fiction for undated readings.**
   `new Date(deviceTs ?? nowMs)` — a device omitting `ts` got server time, so a
   retry got a *different* server time and was accepted as new data. Now recorded
   as `tsSource=SERVER`, with the guarantee explicitly not claimed for those rows:
   `{"deviceRetryRefused":true,"serverRetriesAccepted":2,"hypertableStillWorks":true}`.
   The blind spot became measurable rather than invisible.

3. **A `migrate dev --create-only` would have silently reverted the hypertable**,
   regenerating `PRIMARY KEY (id)`. Caught, hand-written migration committed
   instead, and a test now fails if any migration regresses it — one that passed
   against exactly the SQL it exists to forbid until its pattern was corrected.

### What is deliberately still not built

1. **Real hardware.** `EXECUTED` is unreachable by design: no shipped dispatch
   implementation contacts a device. Modbus write codes and control registers are
   not shipped because no controller manual was ever supplied, and a plausible
   unwired implementation would be assumed to have been run.
2. **MFA UI.** The API is complete and enforced; enrolment UI and backup-code
   regeneration are not built. MFA stays off unless an encryption key is present.
3. **Frontend Tasks 5–8** — palette collision, error UI for 9 views,
   `asset-registry-view.tsx` split, dead code.
4. **Observability consumer.** `/metrics`, alert rules and a preview endpoint
   exist; nothing scrapes them or pages anyone.

---


<!-- source: docs/mqtt-tenant-isolation-defect.md -->

## MQTT tenant isolation — two defects that looked healthy

**Status:** closed, verified against a live broker.
**Found by:** `bun test src/lib/fgmp/protocol/mqtt-live.test.ts` failing against a broker
that reported `Up (healthy)` and was serving every connection correctly.

---

### Why this file exists

Every finding below was invisible from inside the application. The broker
authenticated users, accepted connections, published retained messages, and
reported no error. PostgreSQL RLS — which protects the other 30 tables — cannot
help here, because MQTT has no database. The tenant boundary has to be the broker
refusing an operation, so a silent failure in the broker's authorization is a
silent failure of tenant isolation everywhere on the telemetry path.

Nothing in the code diff would have revealed any of this. It was found only
because an assertion failed and the failure was investigated instead of retried.

---

### Defect 1 — the ACL file was not being enforced at all

`docker/mosquitto/config/acl` was bind-mounted into the container:

```yaml
- ./docker/mosquitto/config/acl:/mosquitto/config/acl:ro
```

A bind mount carries the **host** file's uid and gid into the container, so the
file is owned by the host user (uid 1000) rather than by `mosquitto` (uid 1883).

Mosquitto 2 does not reject this. It logs six warnings at startup:

```
Warning: File /mosquitto/config/acl has world readable permissions.
Warning: File /mosquitto/config/acl owner is not mosquitto.
Warning: File /mosquitto/config/acl group is not mosquitto.
```

…and then **keeps running with the ACL not enforced**.

The dangerous part is that this is a *half*-working security state.
`allow_anonymous false` was still honoured, because it is a config directive
rather than a file read by the same mechanism. So:

| Property | Expected | Actual |
|---|---|---|
| Anonymous refused | yes | **yes** |
| Wrong password refused | yes | **yes** |
| Own subtree readable | yes | yes |
| Cross-tenant subtree readable | **no** | **yes** |

Every visible signal said healthy. Every client authenticated correctly. The
healthcheck passed, because it tested authentication — which worked.

**Fix:** copy the files into a named volume at start-up and `chown` them to
`mosquitto`, rather than bind-mounting them read-only.

---

### Defect 2 — `topic readwrite fgmp/tenant-a/` is a malformed filter

The ACL granted, for each tenant:

```
topic readwrite fgmp/tenant-a/
```

That trailing `/` is not shorthand for the subtree. An MQTT topic filter matches
level by level, and a trailing `/` matches only the literal empty level that
follows it — so the grant covered `fgmp/tenant-a/` itself and nothing beneath it.

The effect was the **opposite** of what the file claimed:

```
user tenant-a
topic readwrite fgmp/tenant-a/#   →  read own subtree, publish own subtree
topic readwrite fgmp/tenant-a/    →  read own subtree, CANNOT publish
```

Every device upload failed:

```
ErrorWithReasonCode: Publish error: Not authorized
 code: 135,
```

This was invisible to the isolation suite, because the isolation suite only
asserted that one tenant cannot see another — a permission that was never
granted, so it never failed. Nothing in the tests published as a tenant into its
own subtree.

The same error hid the *absence* of a real signal: until a tenant tried to publish,
there was no test that could distinguish "ACL correctly denies cross-tenant" from
"ACL grants nothing to anyone".

**Fix:** `topic readwrite fgmp/tenant-a/#`.

---

### Defect 3 — the isolation tests asserted on a signal mosquitto does not send

The original assertions were:

```ts
const verdict = await subscribeAndReport(a, "fgmp/tenant-b/#", QOS.AT_LEAST_ONCE)
expect(verdict.granted).toBe(false)
```

On MQTT 3.1.1 a denied subscription is reported by the broker as a SUBACK reason
code of `0x80`. Mosquitto 2.1.2 does not do this. It returns success codes for
every filter and enforces the ACL when it **routes** each message:

```
$ mosquitto_sub -V 5 -u tenant-a -P ... -t 'fgmp/tenant-a/#' -t 'fgmp/tenant-b/#' -d -W 3
Subscribed (mid: 1): 0, 0        # own = granted, foreign = "granted"
```

So `verdict.granted` is `true` for a cross-tenant filter that is in fact correctly
refused. Those tests failed against a working ACL — and would have **passed**
against a completely broken one, which is the worst direction for a security test
to fail in.

**Fix:** assert on delivery. `canReceive()` publishes from a real second tenant and
reports whether the message arrived:

```ts
const received = await canReceive(a, b, "fgmp/tenant-b/tank/dev-secret/telemetry", payload)
expect(received).toBe(false)
```

Arrival is the thing that must not happen, and arrival is observable. Paired with a
same-tenant control test, so that "nothing arrived" cannot pass by a broker that
delivers nothing at all:

```ts
test("tenant A does receive its OWN subtree — the control for the tests above")
```

That control is what gives the denial tests meaning. Without it, a broker that
delivers zero messages to everyone satisfies every assertion in the file.

---

### Defect 4 — a healthcheck that can never pass

```yaml
test: ["CMD-SHELL", "mosquitto_sub ... -t 'fgmp/tenant-a/#' -C 1 -W 5 >/dev/null 2>&1 || exit 1"]
```

`-C 1` means "exit after 1 message". The probe waits for a message on a broker
nobody publishes to, so it timed out on every run:

```
"FailingStreak": 383
```

while the broker was in fact serving correctly. A healthcheck that cannot succeed is
worse than none — it trains everyone to read `unhealthy` as noise, and it would have
masked the genuine failure in defect 1.

**Fix:** assert the property that matters, in both directions — authenticate,
deliver own subtree, refuse cross-tenant.

---

### Verification

```bash
docker compose up -d --force-recreate fgmp-broker
bun test src/lib/fgmp/protocol/mqtt-live.test.ts
# 14 pass, 0 fail
```

Startup must be clean — any warning about ownership means the ACL is not enforced:

```bash
docker logs fgmp-broker 2>&1 | grep -icE 'warning|error'   # must be 0
```

---

### What generalises

1. **A security control that is present, greppable, and reviewed can still enforce
   nothing.** Only an assertion against live behaviour distinguishes them.
2. **Test the failure direction, not the mechanism.** "Tenant A cannot read tenant
   B" is the requirement. Whether the broker signals that via SUBACK, via routing,
   or by dropping the connection is an implementation detail that differed from the
   test's assumption and produced the wrong verdict in both directions.
3. **Every denial test needs a matching permission test.** Without the control, a
   deny-all broker passes the suite.
4. **A healthcheck that always fails is a disabled healthcheck.** It had been
   reporting unhealthy for 383 consecutive intervals, and nobody read it because it
   was always red.

---
