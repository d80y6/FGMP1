# Provisioning a hosted PostgreSQL (Supabase, Neon, RDS) by hand

The normal path is `bunx prisma migrate deploy` followed by `bun run db:seed`.
This directory exists for the case where that is not possible: a machine with no
route to the database, no Docker, and no way to download Prisma's query engine —
which is also the situation in which a hosted database is the only one you have.

The scripts reproduce, in order, exactly what Prisma and the seeder do:

| File | What it does | Run as | Re-runnable |
|---|---|---|---|
| `01-roles.sql` | creates `fgmp_app`, `fgmp_ops` (BYPASSRLS), `fgmp_migrate`; grants; default privileges | superuser | yes |
| `02-schema.sql` | **generated**; applies all migrations as `fgmp_migrate`, then writes `_prisma_migrations` | superuser | no — fresh database only |
| `03-seed.sql` | two tenants, six users, geography, 8 sites and their assets, alarms, deliveries, tickets, transactions | superuser | yes |
| `04-verify.sql` | asserts isolation as each role; changes nothing | superuser | yes |

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
export ADMIN_URL='postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres'
# On Supabase, "Direct connection" is db.<ref>.supabase.co:5432.
# The pooler on aws-0-<region>.pooler.supabase.com:5432 also works for admin
# work, with username postgres.<ref>; port 6543 (transaction mode) does not,
# because these scripts use SET ROLE and multi-statement DO blocks.

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f 01-roles.sql
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f 02-schema.sql
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f 03-seed.sql
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f 04-verify.sql
```

In the Supabase SQL editor, run the four files one at a time, in that order. The
editor executes as `postgres`; `02-schema.sql` needs exactly that, because it
does `set role fgmp_migrate` so the tables are **owned by the migration role**.

Before running, edit the three `CHANGE_ME` passwords in `01-roles.sql`
(`openssl rand -hex 24` — hex avoids URL-encoding problems). Nothing else needs
editing.

Expected output:

```
NOTICE:  FGMP roles ready in database postgres.
NOTICE:  FGMP schema applied: 45 tables, 39 with FORCE RLS, 51 policies, 4 DML grants on "User" for fgmp_app.
NOTICE:  FGMP seed ready: 2 tenants, 6 users, 8 sites, 8 tanks, 8 generators, 8 dispensers, 5 alarms, 12 fuel transactions.
NOTICE:  OK: fgmp_app sees 0 sites with no tenant context.
NOTICE:  FGMP deployment verified.
```

## What the schema contains

45 tables. 39 of them carry a `tenantId` and have **FORCE ROW LEVEL SECURITY**
with one `tenant_isolation` policy each (51 policies in total, counting the
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
* `03-seed.sql`'s `TRUNCATE`-free inserts keep working only because it runs as a
  superuser.

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

`03-seed.sql` runs as `postgres`, so RLS does not apply and it can write rows for
two tenants. That is deliberate.

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

## After provisioning

1. Sign in as `superadmin@fgmp.telecom` / `Super@2026` and **change the password**,
   or delete the account and create your own. The same applies to the five demo
   users (`Admin@2026`): they exist so RBAC can be reviewed, not so they can be
   deployed. `select email, role from "User";` should show only accounts you own.
2. Set `NEXTAUTH_SECRET` (≥32 chars), `NEXTAUTH_URL`, `IOT_API_KEY`,
   `FGMP_MFA_ENCRYPTION_KEY`. `bun run check:env` lists what is missing and
   whether it is fatal.
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
