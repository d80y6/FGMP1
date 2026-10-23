-- ═══════════════════════════════════════════════════════════════════════════
-- FGMP — database roles
--
-- Run ONCE, first, in the target database, connected as a superuser.
-- On Supabase: SQL editor (which runs as `postgres`) on the project's database.
-- From a shell:
--     psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f 01-roles.sql
--
-- This file is plain SQL — no psql meta-commands, no client variables — so it
-- runs verbatim in a web SQL editor as well as in psql.
--
-- Safe to re-run: roles are created only when absent and every GRANT is
-- idempotent. It does NOT change an existing role's password; rotate
-- deliberately with:
--     alter role fgmp_app password '…';
--
-- ── THE THREE ROLES, AND WHY EACH ONE EXISTS ────────────────────────────────
--   fgmp_app      the web application. DML only. NOT the owner, NOT BYPASSRLS,
--                 no CREATE. This is what makes FORCE ROW LEVEL SECURITY bind:
--                 a query with a missing or wrong tenant filter is filtered by
--                 the database, not merely by the application.
--   fgmp_migrate  owns the schema and holds DDL. Used by migrations and by
--                 deploy-time seeding. On a hosted database it is a plain role
--                 (no superuser), which means FORCE RLS applies to IT as well —
--                 see the seeding note in README.md.
--   fgmp_ops      BYPASSRLS, for deliberate cross-tenant platform work:
--                 tenant enumeration, health census, pg_dump. Never given to
--                 the web app's DATABASE_URL.
--
-- ── BEFORE YOU RUN ──────────────────────────────────────────────────────────
-- Replace the three CHANGE_ME values below, in place. Generate each with:
--     openssl rand -base64 32
-- If a password contains URL-special characters (@ : / ? # & %), percent-encode
-- it in the connection string, or use a hex password:
--     openssl rand -hex 24
-- ═══════════════════════════════════════════════════════════════════════════

-- >>> EDIT THESE THREE LITERALS (they appear again below, in the DO block) <<<
--   fgmp_app      'CHANGE_ME_app_password'
--   fgmp_ops      'CHANGE_ME_ops_password'
--   fgmp_migrate  'CHANGE_ME_migrate_password'

-- ── Roles ──────────────────────────────────────────────────────────────────
-- PostgreSQL has no CREATE ROLE IF NOT EXISTS. A DO block with a duplicate
-- handler is idempotent without masking other errors, and — unlike a
-- SELECT ... \gexec loop — needs no psql meta-commands.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fgmp_app') then
    execute format('create role fgmp_app login password %L', 'CHANGE_ME_app_password');
  end if;

  if not exists (select 1 from pg_roles where rolname = 'fgmp_ops') then
    execute format('create role fgmp_ops login bypassrls password %L', 'CHANGE_ME_ops_password');
  end if;

  if not exists (select 1 from pg_roles where rolname = 'fgmp_migrate') then
    execute format('create role fgmp_migrate login password %L', 'CHANGE_ME_migrate_password');
  end if;
end $$;

-- ── Posture, asserted rather than assumed ──────────────────────────────────
-- A role that can CREATE in `public` can also DROP the policies; a role with
-- BYPASSRLS has no isolation at all. Both are asserted here so a role that was
-- created by hand, earlier, with the wrong attributes fails loudly now instead
-- of quietly widening the blast radius later.
do $$
declare
  v_bypass boolean;
  v_super  boolean;
begin
  select rolbypassrls, rolsuper into v_bypass, v_super
    from pg_roles where rolname = 'fgmp_app';
  if v_bypass or v_super then
    raise exception 'fgmp_app has BYPASSRLS or SUPERUSER — refusing. The application role must be subject to row-level security.';
  end if;

  select rolbypassrls into v_bypass from pg_roles where rolname = 'fgmp_ops';
  if not v_bypass then
    raise exception 'fgmp_ops is missing BYPASSRLS — the platform census and pg_dump would silently see zero rows.';
  end if;

  select rolsuper into v_super from pg_roles where rolname = 'fgmp_migrate';
  if v_super then
    raise notice 'fgmp_migrate is a SUPERUSER on this server (normal in docker compose). It therefore also bypasses RLS, so seeding works — but the role is more powerful than the docs describe. Fine for a single-tenant dev box; never give it to the web app.';
  else
    raise notice 'fgmp_migrate is not a superuser: migrations work, but a seed that writes rows for several tenants fails its WITH CHECK unless it runs as a superuser or the role is granted BYPASSRLS — see README.md.';
  end if;
end $$;

-- ── Database and schema access ─────────────────────────────────────────────
-- Scoped to the CURRENT database on purpose: CONNECT on another database in
-- the same cluster is not this script's business.
do $$
begin
  execute format('grant connect on database %I to fgmp_app, fgmp_ops, fgmp_migrate', current_database());
end $$;

grant usage on schema public to fgmp_app, fgmp_ops;
-- The migration role creates the tables, so it needs CREATE here. This is the
-- grant that is missing by default on PostgreSQL 15+ (the schema is owned by
-- pg_database_owner) and the reason `prisma migrate deploy` fails on a hosted
-- database with "permission denied for schema public".
grant create, usage on schema public to fgmp_migrate;

-- The application and ops roles never create objects.
revoke create on schema public from fgmp_app, fgmp_ops;

-- ── Default privileges ─────────────────────────────────────────────────────
-- Applied for BOTH creators: fgmp_migrate (the normal path — the migration
-- 20261004203149_grant_role_privileges does the same for its own future
-- objects) and postgres (so a table created from the SQL editor by hand is
-- still usable by the application instead of failing with "permission denied"
-- at runtime).
alter default privileges for role fgmp_migrate in schema public
  grant select, insert, update, delete on tables to fgmp_app, fgmp_ops;
alter default privileges for role fgmp_migrate in schema public
  grant usage, select on sequences to fgmp_app, fgmp_ops;

do $$
begin
  begin
    execute 'alter default privileges for role postgres in schema public
               grant select, insert, update, delete on tables to fgmp_app, fgmp_ops';
    execute 'alter default privileges for role postgres in schema public
               grant usage, select on sequences to fgmp_app, fgmp_ops';
  exception when insufficient_privilege then
    raise notice 'Could not set default privileges for the postgres role (connected role is not a member). Tables created by hand as postgres will need an explicit GRANT.';
  end;
end $$;

-- ── Report ─────────────────────────────────────────────────────────────────
do $$
declare
  r record;
begin
  raise notice 'FGMP roles ready in database %.', current_database();
  for r in
    select rolname, rolsuper, rolbypassrls, rolcanlogin
      from pg_roles
     where rolname in ('fgmp_app', 'fgmp_ops', 'fgmp_migrate')
     order by rolname
  loop
    raise notice '  % — login=%, superuser=%, bypassrls=%',
      r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls;
  end loop;
end $$;
