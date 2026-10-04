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
and 4 are **collapsed into a single migration** that adds `tenant_id` as
`NOT NULL` with an FK, and the `NULL tenant_id` exposure window never opens.

The collapsed migration is applied to a database that is recreated, never to
one holding rows that need preserving.

## The 19 models without `tenantId`

Ten models already have `tenantId`: `User`, `Region`, `Site`, `Alarm`,
`AuditLog`, `Notification`, `AlarmSuppression`, `ApiKey`, `ShiftHandover`,
`BackupRecord`.

Of the remaining nineteen, two are **deliberately global and get no
`tenant_id`**:

| Model | Why it stays global |
|---|---|
| `Tenant` | It is the isolation boundary itself. A tenant row cannot belong to a tenant. |
| `SystemSetting` | Platform-wide configuration (escalation thresholds, platform toggles). Tenant-scoped settings would let one tenant change another's alarm timing. |
| `EspFirmwareRelease` | A firmware artifact is a platform resource. `EspFirmwareDeployment` is the tenant-scoped instance of it. |

That leaves **sixteen** models that receive `tenant_id`.

### Tier A — add a direct `tenant_id` column + FK

Reached directly, not through a parent:

`NotificationPreference`, `EspFirmwareDeployment`

### Tier B — inherit tenancy through the parent `Site`

These already have a `siteId` FK, so `tenant_id` is **denormalised** onto them
to make the RLS policy in step 6 directly enforceable on each table. Without a
local column, a policy on e.g. `FuelTank` would have to reach through a join to
`Site`, which is both slower and impossible to express as the simple
`tenant_id = current_setting('app.tenant_id')` predicate the architecture
decision specifies.

`FuelTank`, `Generator`, `BatteryBank`, `IotDevice`, `FuelDispenser`,
`FuelTransaction`, `SensorReading`, `SiteEvent`, `FuelDelivery`,
`ControlCommand`, `MaintenanceTicket`, `SiteGateway`

Denormalisation is safe here only because `Site.tenantId` is itself
enforced, and because `ON DELETE CASCADE` from `Site` removes children with
their parent. Step 11's regression suite asserts a row cannot exist whose
`tenant_id` disagrees with its site's.

### `ControlCommand` is the exception — it has no `siteId`

Eleven of the twelve Tier B models reach `Site` directly through `siteId`.
`ControlCommand` does not; it reaches it via
`generatorId → Generator.siteId`:

    ControlCommand(id, generatorId, command, status, reason, issuedById, …)

It therefore takes a **two-hop** backfill rather than the one-hop
`SET tenant_id = s.tenantId FROM Site` the others use:

    UPDATE "ControlCommand" c
       SET tenant_id = g."tenantId"
      FROM "Generator" g
     WHERE c."generatorId" = g.id;

A direct `siteId` column was considered and rejected. `ControlCommand` has
zero rows, so there is no data-preservation argument either way, but adding a
column would duplicate a relationship the schema already expresses through the
generator FK. A two-hop path costs one migration; a redundant column costs
forever. If step 11 later demonstrates that `ControlCommand.tenant_id` can
diverge from its generator's site tenant, revisit — though the FK chain makes
divergence unreachable in practice.

Because this depends on `Generator.tenant_id` existing first, the backfill
must run in topological order within the migration: assets (`FuelTank`,
`Generator`, `BatteryBank`, `IotDevice`, `FuelDispenser`) → their children
(`FuelTransaction`, `FuelDelivery`, `SiteEvent`, `SensorReading`) →
`ControlCommand`.

## Backfill rule (was step 3, now part of the collapsed migration)

Every existing row is assigned the tenant of its parent `Site`:

    UPDATE "FuelTank" t SET tenant_id = s.tenant_id FROM "Site" s WHERE t.siteId = s.id;

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
| Index | leading with `tenant_id` | The policy adds a predicate per query; the index makes it cheap. Benchmarked for `SensorReading` in step 10. |

## RLS mechanics (step 6, recorded here for reference)

    ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
    ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON <t>
      USING      (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

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
than types. `tenant_id` is therefore `TEXT` and the cast is dropped.

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

## Step ledger

| Step | Status | Migration |
|---|---|---|
| 1. SQLite → PostgreSQL | done | `20261004203148_init_postgres_baseline`, `20261004203149_grant_role_privileges` |
| 2. Add nullable `tenant_id` | collapsed into 3 | — |
| 3. Backfill | collapsed into 3 | — |
| 4. `NOT NULL` + FK RESTRICT | in progress | pending |
| 5. `tenant_id`-leading indexes | pending | |
| 6. RLS enable + FORCE + policy | pending | |
| 7. Per-request `SET LOCAL` context | pending | |
| 8. Native enums | pending (roles already done) | |
| 9. `Float` → `Decimal` | pending | |
| 10. TimescaleDB hypertables | pending | |
| 11. RLS regression suite | pending | |
