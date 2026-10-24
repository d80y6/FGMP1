# Provisioning a hosted PostgreSQL (Supabase, Neon, RDS) by hand

The normal path is `bunx prisma migrate deploy` followed by `bun run db:seed`.
This directory exists for the case where that is not possible: a machine with no
route to the database, no Docker, and no way to download Prisma's query engine —
which is also the situation in which a hosted database is the only one you have.

The scripts reproduce, in order, exactly what Prisma and the seeder do:

| File | What it does | Run as | Re-runnable |
|---|---|---|---|
| `01-roles.sql` | creates `fgmp_app`, `fgmp_ops` (BYPASSRLS), `fgmp_migrate`; grants; default privileges; makes the connecting role a member of all three | the **database owner** (Supabase: `postgres`) — **not** a superuser | yes |
| `02-schema.sql` | **generated**; applies all migrations as `fgmp_migrate`, then writes `_prisma_migrations` | same role as 01 | no — fresh database only |
| `03-seed.sql` | two tenants, six users, geography, 8 sites and their assets, alarms, deliveries, tickets, transactions | **`fgmp_ops`** (see below) | yes |
| `04-verify.sql` | asserts isolation as each role; changes nothing | same role as 01 | yes |

> **"Run as the database owner, not a superuser" is not a soft preference.**
> Supabase's `postgres` is `CREATEROLE` + `BYPASSRLS` but **not** `SUPERUSER`; the
> only superuser is `supabase_admin`, which neither the dashboard nor the pooler
> gives you. Every privilege these files need is arranged explicitly, and the
> provisioning contract (below) runs them as a non-superuser for that reason.

`02-schema.sql` is generated from `prisma/migrations` and must never be edited by
hand. Regenerate after adding a migration:

```bash
bun run scripts/supabase/build-schema-sql.ts
```

A test (`src/lib/fgmp/__tests__/supabase-schema-sql.test.ts`) fails when the
committed file no longer matches the migrations, so a forgotten regeneration is
caught by `bun test` rather than by a missing column in production.

## Order of operations

```bash
# ADMIN_URL must point at the TARGET database — the one in DATABASE_URL, i.e. the
# project database you land in from the SQL editor. "Direct connection" is
# db.<ref>.supabase.co:5432; the pooler aws-<n>-<region>.pooler.supabase.com:5432
# works for admin work with username postgres.<ref>.
#
# NOT .../postgres: schema grants and default privileges are per-database, so
# running 01 against the maintenance database reports success and changes nothing
# that matters.
export ADMIN_URL='postgresql://postgres.<ref>:PASSWORD@aws-<n>-<region>.pooler.supabase.com:5432/<db>'

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f 01-roles.sql
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f 02-schema.sql

# 03 is the ONE step that runs as a different role. Its guard refuses to run
# unless the session is a superuser or has BYPASSRLS, and a hosted `postgres`
# may not carry BYPASSRLS: the seed writes two tenants' rows while every tenant
# table is FORCE RLS, so a plain role fails its WITH CHECK on the first insert.
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "set role fgmp_ops;" -f 03-seed.sql

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f 04-verify.sql
```

In the Supabase SQL editor, run `01`, `02` and `04` one at a time, in that order
(the editor executes as `postgres`). For `03`, prepend the same line:

```sql
set role fgmp_ops;
```

…then paste the body of `03-seed.sql` into the same query — the `SET ROLE` must
be in the **same session** as the inserts.

Before running, edit the three `CHANGE_ME` passwords in `01-roles.sql`
(`openssl rand -hex 24` — hex avoids URL-encoding problems). Nothing else needs
editing.

Expected output — note the last line of 01, which is the check that used to be
missing:

```
NOTICE:  FGMP roles ready in database <db>.
NOTICE:    fgmp_app — login=t, superuser=f, bypassrls=f, postgres can assume it: set=t, usage=t
NOTICE:    fgmp_migrate — login=t, superuser=f, bypassrls=f, postgres can assume it: set=t, usage=t
NOTICE:    fgmp_ops — login=t, superuser=f, bypassrls=t, postgres can assume it: set=t, usage=t
NOTICE:  Next: 02-schema.sql (as postgres), then 03-seed.sql as fgmp_ops.
NOTICE:  FGMP schema applied: 45 tables, 40 with FORCE RLS, 55 policies, 4 DML grants on "User" for fgmp_app.
NOTICE:  FGMP seed ready: 2 tenants, 6 users, 8 sites, 8 tanks, 8 generators, 8 dispensers, 5 alarms, 12 fuel transactions.
NOTICE:  OK: fgmp_app sees 0 sites with no tenant context.
NOTICE:  FGMP deployment verified.
```

Any `WARNING` from 01 is a real problem — read it; it names the GRANT to run. If
`fgmp_migrate` cannot be assumed, 01 now **raises** instead of continuing, because
`02` would fail three minutes later with a message that looks like a broken schema
script rather than a provisioning step that did not take effect.

### The passwords are not set for you on a re-run

`01-roles.sql` creates a role only when it is absent. If the roles already exist
with the `CHANGE_ME_*` literals — say a first run failed part-way, or you ran it
unedited — set them explicitly:

```sql
alter role fgmp_app     password '<hex>';
alter role fgmp_ops     password '<hex>';
alter role fgmp_migrate password '<hex>';
```

Every connection string below is unusable until you do.

## What the schema contains

45 tables. 40 of them carry a `tenantId` and have **FORCE ROW LEVEL SECURITY**
with one `tenant_isolation` policy each (55 policies in total, counting the
SECURITY DEFINER helper on the MFA challenge table). The remaining six are
platform-global and have no tenant column, deliberately:

| table | why it is global |
| --- | --- |
| `Tenant` | the registry itself |
| `SystemSetting` | installation-wide configuration |
| `EspFirmwareRelease` | firmware releases are shared by all tenants |
| `_prisma_migrations` | Prisma's bookkeeping; revoked from both application roles |
| `SupportSession` | which operator may act as which tenant, until when |
| `PlatformAuditLog` | the platform trail; must outlive the tenant it concerns |

The last two are the platform administration surface. Their access control is
the API (`/api/fgmp/platform/**`, SUPERADMIN only) rather than RLS, and the
verification script asserts the part the database can enforce: `fgmp_app` may
append to `PlatformAuditLog` but not update or delete it, and may not delete a
`SupportSession`.

## Why `set role fgmp_migrate` matters

PostgreSQL 15+ makes `public` owned by `pg_database_owner`, and a fresh role has
no `CREATE` there — the first migration fails with
`permission denied for schema public`. `01-roles.sql` grants it.

More importantly, whoever creates a table owns it. If the schema is created as
`postgres`:

* a later `prisma migrate deploy` run as `fgmp_migrate` cannot `ALTER` those
  tables;
* `ALTER DEFAULT PRIVILEGES` is attached per creating role, so tables created by
  `postgres` do not automatically carry the grants for `fgmp_app`;
* `03-seed.sql` inserts rows for two tenants in one transaction, and every
  tenant-carrying table is `FORCE ROW LEVEL SECURITY` — so the inserts are only
  accepted from a role with `BYPASSRLS` (`fgmp_ops`). Table ownership does not
  help here: `FORCE` is what makes the policy apply to the owner too. This is why
  the seed is run with `set role fgmp_ops;` and why its own guard refuses to
  continue as `postgres` unless that role carries `BYPASSRLS`.

`02-schema.sql` therefore switches role before the first `CREATE TABLE`, and
`01-roles.sql` sets default privileges for both `fgmp_migrate` **and** `postgres`
so an operator creating a table by hand does not have to remember the grants.

## Connection strings for the application

The role names above are the *database* roles. A hosted pooler wants them in the
username as `<role>.<project-ref>`:

```bash
# Web app — RLS enforced. Session mode (5432), NOT transaction mode (6543):
# the app opens interactive transactions and calls SET LOCAL, which a
# transaction-mode pooler cannot scope to one client connection.
DATABASE_URL="postgresql://fgmp_app.<ref>:<app-password>@aws-0-<region>.pooler.supabase.com:5432/<db>?schema=public&pgbouncer=true"

# Deploy-time only: migrations and seeding.
FGMP_MIGRATE_DATABASE_URL="postgresql://fgmp_migrate.<ref>:<migrate-password>@aws-0-<region>.pooler.supabase.com:5432/<db>?schema=public&pgbouncer=true"

# Platform census, tenant enumeration, pg_dump. Never given to the web app.
FGMP_OPS_DATABASE_URL="postgresql://fgmp_ops.<ref>:<ops-password>@aws-0-<region>.pooler.supabase.com:5432/<db>?schema=public&pgbouncer=true"

FGMP_REQUIRE_RLS=1
```

`pgbouncer=true` makes Prisma avoid prepared statements, which the pooler does
not support. `SET LOCAL` inside an explicit transaction is safe in session mode.

## The one step that behaves differently on a hosted database

`03-seed.sql` runs as **`fgmp_ops`** (BYPASSRLS), so RLS does not apply and it can
write rows for two tenants. That is deliberate, and it is why the line above is
`-c "set role fgmp_ops;"`. Running it as `postgres` works only where that role
carries BYPASSRLS, which is not guaranteed; running it as `fgmp_migrate` never
works, because a hosted `fgmp_migrate` is a plain role and `FORCE ROW LEVEL
SECURITY` binds it.

`bun run db:seed` on the other hand connects with `FGMP_MIGRATE_DATABASE_URL`.
On Docker compose and in CI that role is the container's superuser, so the seed
works. A hosted PostgreSQL never grants `SUPERUSER`, and because every tenant
table is `FORCE ROW LEVEL SECURITY`, the seed's first cross-tenant insert fails:

```
ERROR: new row violates row-level security policy for table "User"
```

That error reads like a policy bug and is not one. Three ways out, in order of
preference:

1. **Use this SQL path for seeding** (what `03-seed.sql` is for). Nothing else
   needs the owner connection at deploy time.
2. `alter role fgmp_migrate bypassrls;` — the same attribute `fgmp_ops` already
   carries, and equivalent to what compose/CI have by virtue of being superuser.
   Do this knowingly: it makes the migration credential a full cross-tenant
   read/write credential, so it must never reach the web app.
3. Seed as `postgres` from a machine that can reach the database, running the
   same `bun run db:seed` with `FGMP_MIGRATE_DATABASE_URL` pointing at the
   superuser URL.

Whatever you choose, `DATABASE_URL` must stay on `fgmp_app`. `FGMP_REQUIRE_RLS=1`
now refuses to boot otherwise, and the refusal names the host and role — never
the password.

## How this is tested (the provisioning contract)

```
bun run test:provisioning      # needs a psql on PATH and an admin URL, see below
```

`scripts/verify/supabase-provisioning.ts` reproduces the hosted shape instead of
describing it. It needs a **superuser** URL once, only to create the fixture:

```bash
FGMP_PG_ADMIN_URL=postgresql://<superuser>@<host>:5432/postgres bun run test:provisioning
```

(default `postgresql://pgroot@127.0.0.1:5435/postgres`). From that URL it creates a
**non-superuser** `CREATEROLE BYPASSRLS` role named `fgmp_provisioner` and a database
it owns — the Supabase `postgres` analogue — then runs `01 → 04` as that role and
asserts 22 facts, among them:

* the role running the scripts is **not** a superuser (otherwise everything below
  passes for the wrong reason);
* `01` records default privileges for `fgmp_migrate` (2 rows) and re-runs silently;
* `02` reports `45 tables, 40 with FORCE RLS, 55 policies`;
* `03` refuses to run as `fgmp_migrate` — the guard fires *before* any insert,
  rather than dying mid-transaction on a `FORCE RLS` violation;
* `03` then succeeds as `fgmp_ops`;
* `04` certifies, and `fgmp_app` still sees `0 sites with no tenant context` and
  `cannot create tables`.

It exits **2** — not 0 — when the cluster already holds the FGMP roles in another
database: that is a re-run of someone else's setup, not a first run, and the
assertions would be measuring the wrong scenario. Point it at a dedicated cluster.

The same script runs in CI as the `provisioning` job (`.github/workflows/ci.yml`)
against stock `postgres:17`. The `rls` job does not cover this path: it provisions
the Docker/Prisma route as a superuser, which is exactly the privilege level a
hosted database does not give you.

## After provisioning

1. Rotate the seeded passwords **before** the app is reachable. `NODE_ENV=production`
   refuses to log in with any password published in the seed data unless
   `FGMP_ALLOW_DEMO_CREDENTIALS=1` — the refusal is deliberate and looks exactly
   like a wrong password from the browser, with the reason only in the server log:

   ```bash
   bun run scripts/set-password.ts superadmin@fgmp.telecom '<new-password>'
   # …and the same for the five demo users (admin@, noc@, regional@, field@, exec@,
   # readonly@ — all seeded with Admin@2026).
   ```

   If that script cannot reach the database from where you are, rotate in SQL.
   Supabase ships pgcrypto, and bcryptjs verifies `$2a$` hashes:

   ```sql
   update "User"
      set "passwordHash" = extensions.crypt('<new-password>', extensions.gen_salt('bf', 10))
    where email = 'superadmin@fgmp.telecom';
   ```

   Do not delete the accounts: `AuditLog.userId`, `Alarm.acknowledgedById` and the
   rest reference them with `ON DELETE SET NULL`/`RESTRICT`, so deleting a seeded
   user mutates the demo history. Rotating the password is the supported move.
2. Set `NEXTAUTH_SECRET` (≥32 chars), `NEXTAUTH_URL`,
   `FGMP_MFA_ENCRYPTION_KEY`. Create tenant-scoped API keys with `write` scope for devices. `bun run check:env` lists what is missing and
   whether it is fatal.
   **`FGMP_OPS_DATABASE_URL` is not optional if you want to log in.** The login
   lookup is the one query that cannot be tenant-scoped ("email → user" predates
   any tenant), so `src/lib/auth-identity.ts` performs it on the BYPASSRLS
   connection. Without that variable it falls back to `fgmp_app`, `"User"` is
   FORCE RLS, the lookup returns zero rows **for every account**, and every login
   is a 401 that the browser cannot distinguish from a wrong password.
3. Start the app and confirm `/api/health/ready` returns 200.

## Regenerating after a schema change

```bash
bun run scripts/supabase/build-schema-sql.ts   # rewrites 02-schema.sql
```

An **existing** database should not be re-provisioned with `02-schema.sql` — it
refuses to run when `Tenant` exists. Apply the new migration normally:

```bash
FGMP_MIGRATE_DATABASE_URL="…fgmp_migrate…" bunx prisma migrate deploy
```
