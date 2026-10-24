-- ═══════════════════════════════════════════════════════════════════════════
-- FGMP — database roles
--
-- Run ONCE, first, in the TARGET database — the one in DATABASE_URL. On
-- Supabase that is the project database (the one you land in from the SQL
-- editor), NOT the maintenance `postgres` database: schema grants and default
-- privileges are per-database, so applying them to the wrong one looks like a
-- success and changes nothing.
-- From a shell:
--     psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f 01-roles.sql
--
-- ── WHAT "ADMIN" MEANS HERE ─────────────────────────────────────────────────
-- You do not need a superuser. You need the role that owns this database and
-- that created the three FGMP roles below — on Supabase that is `postgres`.
-- Supabase's `postgres` is CREATEROLE + BYPASSRLS but NOT a superuser (the only
-- superuser is `supabase_admin`, which the dashboard and the pooler do not give
-- you), so every privilege this file needs is arranged explicitly rather than
-- assumed. The one requirement that cannot be faked is membership in the roles
-- it manages; see "Membership for the connecting role" below.
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

-- ── Membership for the connecting role ─────────────────────────────────────
-- Three later statements act AS these roles rather than merely on them:
--     alter default privileges for role fgmp_migrate   (below) — needs USAGE
--     set role fgmp_migrate              (02-schema.sql, line 42) — needs SET
--     set local role fgmp_app / fgmp_ops (04-verify.sql)          — needs SET
-- Role membership supplies both. A non-superuser may grant membership in a role
-- it created (PostgreSQL 16 records the creator as an ADMIN of the new role), so
-- a first run — and any re-run, since these roles were created by this same
-- role — succeeds without superuser rights.
--
-- WITH INHERIT, deliberately: `alter default privileges for role x` checks
-- USAGE (inherited membership), not just SET, so `with inherit false` produces
-- "permission denied to change default privileges" while `set role` still
-- works. That exact pair of symptoms is what a hosted deployment hit; do not
-- "tighten" this back to INHERIT FALSE.
--
-- BYPASSRLS is not inherited through membership (only the role itself bypasses
-- RLS), so granting fgmp_ops to the admin does not quietly exempt the admin's
-- own queries from row-level security.
do $$
declare
  r text;
begin
  foreach r in array array['fgmp_app', 'fgmp_ops', 'fgmp_migrate'] loop
    begin
      execute format('grant %I to %I with inherit true, set true', r, current_user);
    exception when insufficient_privilege then
      raise warning 'Cannot grant % to %: those roles were created by a different role. Run this as that role, or have a superuser run: grant % to % with inherit true, set true;  (Without it, 02-schema.sql fails at "set role fgmp_migrate".)',
        r, current_user, r, current_user;
    end;
  end loop;
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
-- Both creators are handled inside one guarded block. A missing default
-- privilege must never abort provisioning: 02-schema.sql re-creates the
-- fgmp_migrate defaults from inside that role (migration
-- 20261004203149_grant_role_privileges) and grants explicitly on everything it
-- creates, so the end state is identical — only the window between 01 and 02
-- differs. That is why these are warnings, not exceptions.
do $$
begin
  -- The normal path: fgmp_migrate creates the schema during 02.
  begin
    execute 'alter default privileges for role fgmp_migrate in schema public
               grant select, insert, update, delete on tables to fgmp_app, fgmp_ops';
    execute 'alter default privileges for role fgmp_migrate in schema public
               grant usage, select on sequences to fgmp_app, fgmp_ops';
  exception when insufficient_privilege then
    raise warning 'Could not set default privileges for fgmp_migrate: % lacks USAGE on it. Run the GRANT from the "Membership" warning above. 02-schema.sql applies the same defaults from inside fgmp_migrate, so this is not fatal.',
      current_user;
  end;

  -- The hand-created path: a table made in the SQL editor is still usable by
  -- the application instead of failing with "permission denied" at runtime.
  --
  -- Deliberately CURRENT_USER rather than the literal 'postgres': the point is
  -- "tables the person operating this database creates by hand", and that role
  -- is only called `postgres` on Supabase and RDS. A self-hosted cluster whose
  -- admin is named something else would fail here with `role "postgres" does
  -- not exist` — an undefined_object error, not insufficient_privilege, so the
  -- handler below would not catch it and the whole script would abort at this
  -- purely optional step.
  begin
    execute format('alter default privileges for role %I in schema public
                      grant select, insert, update, delete on tables to fgmp_app, fgmp_ops',
                   current_user);
    execute format('alter default privileges for role %I in schema public
                      grant usage, select on sequences to fgmp_app, fgmp_ops',
                   current_user);
  exception when insufficient_privilege then
    raise notice 'Could not set default privileges for the % role (not a member of it). Tables created by hand will need an explicit GRANT.', current_user;
  end;
end $$;

-- ── Report ─────────────────────────────────────────────────────────────────
do $$
declare
  r record;
begin
  raise notice 'FGMP roles ready in database %.', current_database();
  for r in
    select rolname, rolsuper, rolbypassrls, rolcanlogin,
           pg_has_role(current_user, rolname, 'set')   as can_set,
           pg_has_role(current_user, rolname, 'usage') as can_use
      from pg_roles
     where rolname in ('fgmp_app', 'fgmp_ops', 'fgmp_migrate')
     order by rolname
  loop
    raise notice '  % — login=%, superuser=%, bypassrls=%, % can assume it: set=%, usage=%',
      r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls,
      current_user, r.can_set, r.can_use;
  end loop;
  -- ── Hard stop, not a warning ─────────────────────────────────────────────
  -- 02-schema.sql's first act is `set role fgmp_migrate`. If this role cannot
  -- assume it, 02 WILL fail — so failing here, with the remedy, is the only
  -- honest outcome. The alternative (warn and continue) produces a green run
  -- followed by `permission denied to set role "fgmp_migrate"` three minutes
  -- later, which reads like a broken schema script rather than a provisioning
  -- step that did not take effect.
  if not pg_has_role(current_user, 'fgmp_migrate', 'set') then
    raise exception 'fgmp_migrate cannot be assumed by % — 02-schema.sql would fail at "set role fgmp_migrate". These roles were created by a different role. Re-run this file connected as that role, or have a superuser run: grant fgmp_app, fgmp_ops, fgmp_migrate to % with inherit true, set true;',
      current_user, current_user;
  end if;
  raise notice 'Next: 02-schema.sql (as %), then 03-seed.sql as fgmp_ops.', current_user;
end $$;
