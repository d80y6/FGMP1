/**
 * Build the "apply the schema" SQL for a database that is not reachable from a
 * machine able to run `prisma migrate deploy` (a hosted Postgres such as
 * Supabase, where the sandbox has no route to the database and no query-engine
 * binary).
 *
 * ── WHY GENERATED RATHER THAN HAND-WRITTEN ─────────────────────────────────
 * The schema is defined exactly once, in `prisma/migrations`. A hand-maintained
 * `schema.sql` would be a second definition that silently drifts: someone adds a
 * migration, forgets the SQL file, and the hosted database quietly lacks a
 * column until a query fails in production. This module concatenates the real
 * migration files in directory order, so the generated script cannot disagree
 * with what `prisma migrate deploy` would do.
 *
 * ── WHY IT ALSO WRITES `_prisma_migrations` ────────────────────────────────
 * Applying migrations by hand leaves Prisma's bookkeeping table empty, so the
 * next `prisma migrate deploy` — run from a developer laptop, CI, or a deploy
 * step — would try to apply all 24 migrations again and fail on the first
 * `CREATE TABLE`. Writing the same rows Prisma writes (name + sha256 checksum of
 * the file, one applied step) makes the two paths interchangeable: the deployed
 * schema and Prisma's view of it agree, and a subsequent deploy is a no-op.
 *
 * The checksum is `sha256(file bytes)` hex, which is what Prisma stores; it is
 * computed here rather than copied from a CI log, so a migration edited after
 * this file was generated is detected by the test in
 * `src/lib/fgmp/__tests__/supabase-schema-sql.test.ts` instead of by a failed
 * deploy months later.
 */

import { createHash } from "node:crypto";

export interface MigrationFile {
  /** Directory name, e.g. `20261004203148_init_postgres_baseline`. */
  name: string;
  /** Raw contents of `migration.sql`. */
  sql: string;
}

/** The checksum Prisma stores in `_prisma_migrations.checksum`. */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Deterministic row id: `mig-` plus the first 32 hex characters of the
 * checksum, which is exactly the 36 characters `varchar(36)` allows.
 *
 * Deterministic on purpose — regenerating the SQL must produce a byte-identical
 * file, or every build would show a spurious diff and the drift test would be
 * meaningless. Prisma does not read this column back; it is a primary key.
 */
function rowId(checksum: string): string {
  return `mig-${checksum.slice(0, 32)}`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const HEADER = `-- ═══════════════════════════════════════════════════════════════════════════
-- FGMP — schema and Prisma bookkeeping for a fresh database
--
-- GENERATED FILE — do not edit. Run scripts/supabase/build-schema-sql.ts after
-- adding a migration:
--     bun run scripts/supabase/build-schema-sql.ts
--
-- WHAT IT DOES
--   1. refuses to run if the FGMP schema is already present (it is not
--      idempotent, exactly like \`prisma migrate deploy\` on a fresh database);
--   2. switches to the fgmp_migrate role, so every table is OWNED by the
--      migration role rather than by \`postgres\` — ownership is load-bearing:
--      FORCE ROW LEVEL SECURITY binds the owner too, and a later
--      \`prisma migrate deploy\` run as fgmp_migrate must be able to ALTER these
--      tables;
--   3. applies every migration in \`prisma/migrations\`, in order;
--   4. records them in \`_prisma_migrations\` with Prisma's own checksums, so a
--      future \`prisma migrate deploy\` sees them as already applied.
--
-- PREREQUISITES: 01-roles.sql has been run in THIS database, and the connected
-- role is a superuser (the Supabase SQL editor runs as \`postgres\`), because
-- \`set role fgmp_migrate\` requires the privilege to assume that role.
--
-- If any statement fails, nothing after it is applied. On a failure, drop and
-- recreate the database, fix the cause, and run this file again from the top:
-- a half-applied schema is not a state \`prisma migrate deploy\` can repair.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Guard: this script creates the schema, it does not upgrade one ─────────
do $$
begin
  if exists (
    select 1 from pg_tables
     where schemaname = 'public' and tablename = 'Tenant'
  ) then
    raise exception
      'The FGMP schema already exists in this database. This file applies migrations to a fresh database. To upgrade an existing one use: FGMP_MIGRATE_DATABASE_URL=... bunx prisma migrate deploy';
  end if;
end $$;

-- ── Everything below is created BY fgmp_migrate, not by the connected role ─
set role fgmp_migrate;
`;

const FOOTER_PREFIX = `
-- ═══════════════════════════════════════════════════════════════════════════
-- Prisma bookkeeping
--
-- These rows are what \`prisma migrate deploy\` would have written. Without
-- them the next deploy re-applies every migration and fails on the first
-- CREATE TABLE. \`checksum\` is sha256 of the migration file, byte for byte.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists "_prisma_migrations" (
  id                    varchar(36) primary key not null,
  checksum              varchar(64) not null,
  finished_at           timestamptz,
  migration_name        varchar(255) not null,
  logs                  text,
  rolled_back_at        timestamptz,
  started_at            timestamptz not null default now(),
  applied_steps_count   integer not null default 0
);

-- Least privilege: the application never reads Prisma's bookkeeping, so it
-- gets no privileges on it. Default privileges granted DML at CREATE time;
-- this takes it back. A compromised app role cannot rewrite migration history
-- to make a future deploy skip a migration.
revoke all on "_prisma_migrations" from fgmp_app, fgmp_ops;
`;

const FOOTER_SUFFIX = `
reset role;

-- ── Post-conditions, as notices rather than claims ─────────────────────────
do $$
declare
  v_tables   integer;
  v_forced   integer;
  v_policies integer;
  v_app_dml  integer;
begin
  select count(*) into v_tables
    from pg_tables where schemaname = 'public';

  select count(*) into v_forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity;

  select count(*) into v_policies from pg_policies where schemaname = 'public';

  -- The app role must be able to read and write, and must NOT own anything.
  select count(*) into v_app_dml
    from information_schema.role_table_grants
   where grantee = 'fgmp_app' and table_name = 'User';

  raise notice 'FGMP schema applied: % tables, % with FORCE RLS, % policies, % DML grants on "User" for fgmp_app.',
    v_tables, v_forced, v_policies, v_app_dml;

  if v_forced < 30 or v_policies < 40 or v_app_dml < 4 then
    raise exception
      'Post-condition failed: expected >=30 FORCE-RLS tables, >=40 policies and 4 DML grants for fgmp_app (got %, %, %).',
      v_forced, v_policies, v_app_dml;
  end if;
end $$;
`;

/**
 * Concatenate the migrations into one script. `migrations` must already be in
 * directory order; the caller reads them from disk, the test passes fixtures.
 */
export function buildSchemaSql(migrations: MigrationFile[]): string {
  if (migrations.length === 0) {
    throw new Error("buildSchemaSql(): no migrations — refusing to emit an empty schema.");
  }

  const parts: string[] = [HEADER];

  for (const migration of migrations) {
    parts.push(`
-- ─────────────────────────────────────────────────────────────────────────────
-- ${migration.name}
-- ─────────────────────────────────────────────────────────────────────────────
${migration.sql.trim()}
`);
  }

  parts.push(FOOTER_PREFIX);

  for (const migration of migrations) {
    const checksum = migrationChecksum(migration.sql);
    parts.push(
      `insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)\n` +
        `values (${quoteLiteral(rowId(checksum))}, ${quoteLiteral(checksum)}, now(), ${quoteLiteral(migration.name)}, null, null, now(), 1)\n` +
        `on conflict (id) do nothing;\n`,
    );
  }

  parts.push(FOOTER_SUFFIX);
  return parts.join("");
}
