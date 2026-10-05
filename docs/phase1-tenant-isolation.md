# Phase 1 — Database-Level Tenant Isolation

Ground truth for the migration. Written before touching the schema so the
sequencing is auditable rather than reconstructed from commit messages.

## Why the order matters

Steps 2→4 exist as separate steps only because a migration that adds a
`NOT NULL` column to a populated table needs somewhere to put the value first.
On a database holding no production data, that constraint does not bind: a new
column can be created `NOT NULL` directly because there are no rows to violate
it.

**Verified:** the FGMP deployment has demo/seed data only (52 sites, 168
transactions, all regenerable by `seedIfNeeded()`). `scripts/smoke-postgres.ts`
and a full `seedIfNeeded()` run both pass against PostgreSQL 17. So steps 2, 3
and 4 are **collapsed into a single migration** that adds `tenantId` as
`NOT NULL` with an FK, and the `NULL tenantId` exposure window never opens.

The collapsed migration is applied to a database that is recreated, never to
one holding rows that need preserving.

## The 19 models without `tenantId`

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

### Tier A — add a direct `tenantId` column + FK

Reached directly, not through a parent:

`NotificationPreference`, `EspFirmwareDeployment`

### Tier B — inherit tenancy through the parent `Site`

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

### `ControlCommand` is the exception — it has no `siteId`

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

## Backfill rule (was step 3, now part of the collapsed migration)

Every existing row is assigned the tenant of its parent `Site`:

    UPDATE "FuelTank" t SET tenantId = s.tenantId FROM "Site" s WHERE t.siteId = s.id;

`NotificationPreference` and `EspFirmwareDeployment` are resolved via
`User.tenantId` and `FuelDispenser.siteId` respectively.

Any row that cannot be resolved is **deleted, not defaulted**. A guessed
tenant is worse than a missing row: it silently places data in the wrong
tenant, and RLS would then protect it there forever.

## Constraint decisions

| Constraint | Value | Rationale |
|---|---|---|
| `NOT NULL` | yes | Required for RLS; `NULL = <tenant>` is never true, so a NULL row would be invisible to every tenant — a silent data-loss mode. |
| FK | `REFERENCES "Tenant"(id) ON DELETE RESTRICT` | The spec says RESTRICT. Note this differs from `Site`'s existing `ON DELETE CASCADE`; RESTRICT is correct for the tenant boundary — a tenant with assets must not be deletable. |
| Index | leading with `tenantId` | The policy adds a predicate per query; the index makes it cheap. Benchmarked for `SensorReading` in step 10. |

## RLS mechanics (step 6, recorded here for reference)

    ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
    ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON <t>
      USING      ("tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

`FORCE` is mandatory. RLS is skipped by the table owner, and the app role is
deliberately not the owner — but `FORCE` means the policy holds even if that
is ever changed by accident, which is the entire point of a backstop.

### The predicate is TEXT, not uuid — correction

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

## Roles (provisioned in step 1)

| Role | RLS | Used by |
|---|---|---|
| `fgmp_app` | Enforced (`FORCE`) | Web app. Not the table owner. DML only. |
| `fgmp_ops` | `BYPASSRLS` | Internal ops: `pg_dump`, cross-tenant support. **Never in the web app env.** |
| `fgmp_migrate` | Owns the schema | Migrations, CI only. |

## Steps 8 and 9 as applied

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

## Step ledger

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
| 11. RLS regression suite | done — 153 assertions, 24/24 tables, exit 0 | `scripts/rls-regression.ts`, `src/lib/fgmp/__tests__/` |

### Step 10 is outstanding

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

## Step 6 as applied

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

## Decisions a future maintainer will want to second-guess

### Migration ordering is lexicographic, and that is load-bearing

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

### `FGMP_REQUIRE_RLS=1` refuses to boot on a misconfigured connection

`src/lib/db.ts` exposes `assertRlsEnforced()`, called at module load on the
server runtime. With the flag set, a `DATABASE_URL` that does not use
`fgmp_app` makes the process throw at import rather than serve traffic with
isolation silently disabled. It reuses the existing `rlsEnforced` role
detection rather than re-parsing the URL.

Default is OFF, so local development without PostgreSQL still boots. The guard
is skipped during `next build`, which imports every route module without
runtime secrets — the same constraint `auth.ts` documents for its placeholder
secret. A build is not a serving process.

### The web app never holds the owner credential

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

## Limitations

This phase added a backstop. It did not make the application correct, and the
following are real and outstanding.

### Governorate and District have no RLS backstop at all

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

### RLS is a backstop, not the primary control

`assertTenantOwned()` in `src/lib/fgmp/auth-helpers.ts` runs first and is what
actually scopes a request. RLS catches a MISSING tenant context and a missing
`WHERE` clause. It does not catch a WRONG one: a request that sets
`app.tenant_id` to another tenant's id is served that tenant's data, and RLS
will agree.

### `app.tenant_id` is an ordinary session GUC

Any process holding the `fgmp_app` credential can `set` it to any tenant and
read or write that tenant's rows. RLS therefore protects against forgetting the
context and against unguarded queries — it does **not** protect against a
compromised or malicious application process. Treat the app role's credential
as tenant-wide read/write for the whole platform; the per-request scoping is a
property of the code, not of the database.

### `FORCE` is not covered by the regression suite

The suite runs as `fgmp_app`, a non-owner. That is correct — it is the role the
application uses — but it means the suite cannot detect a missing `FORCE`, because
without `FORCE` the policy still binds the non-owner. Verified by mutation:
dropping `FORCE` from `FuelTank` left the suite at 153 PASS.

The owner-side consequence is caught elsewhere: the `docker` CI job asserts
`count(*) = 24` for tables with both `relrowsecurity` and `relforcerowsecurity`,
and a non-superuser owner was shown to read 0 rows with no context. Nothing in
the Bun suite covers it, so a regression there depends on CI's docker job running.

### The in-memory engine is not tenant-aware (most important open item)

`engine.ensureInit()` reads tenant-scoped rows with NO tenant context. Under
RLS that correctly returns nothing, so the engine loads 0 sites and the app
reports an empty fleet. This is pre-existing and was **not** fixed by this
phase — the phase made it visible rather than causing it. Until the engine is
made tenant-aware, it cannot serve tenant data at all.

### Rate limiting is per-process

`src/lib/fgmp/rate-limit.ts` keeps buckets in a module-level `Map`. It is
correct for a single instance and silently ineffective across replicas: the
effective limit is `limit × replicas`. Correct for the single-container
deployment this phase targets; it must move to shared storage before scaling.

### `getClientIp()` collapses to `"anon"` without `TRUSTED_PROXY`

Without that variable every direct client shares one bucket, so the login rate
limiter groups all operators together. The default is the safe one — it refuses
to trust a client-supplied header — but it makes the per-IP limit a global one.

### Non-constant-time secret comparison

`src/app/api/fgmp/iot/ingest/route.ts:107,341` and
`src/app/api/fgmp/realtime/snapshot/route.ts:71` compare secrets with `!==`.
`timingSafeEqual` is used correctly elsewhere (`realtime-token.ts`), so the
standard exists and was simply not applied at these three sites. Remote timing
attack is impractical in practice; the inconsistency is the real finding.

### CSP permits `unsafe-eval` and frames any HTTPS origin

`next.config.ts` sets `script-src 'self' 'unsafe-inline' 'unsafe-eval'` and
`frame-ancestors 'self' https:`. The latter was for a preview platform; in
production it permits clickjacking of an authenticated NOC dashboard.

### Secrets on disk

`.env` holds real credentials and is untracked (`.gitignore` `.env*`). The
template `.env.example` is committed. Rotate anything that has touched a shared
machine.
