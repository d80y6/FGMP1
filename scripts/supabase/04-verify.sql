-- ═══════════════════════════════════════════════════════════════════════════
-- FGMP — verify the deployment, as the roles that will actually use it
--
-- Run last, connected as a superuser. It changes nothing; it asserts, and it
-- raises an exception on the first claim that does not hold. A green run is
-- evidence for exactly three properties:
--
--   1. the application role cannot see a single tenant row without a tenant
--      context (the database backstop, not an application convention);
--   2. inside a tenant context it sees that tenant's rows and only those;
--   3. it cannot perform DDL, and it cannot rewrite Prisma's migration history.
--
-- ── WHY THIS EXISTS SEPARATELY FROM THE SECURITY SUITE ─────────────────────
-- `bun run test:rls` proves the same properties from TypeScript, in CI, against
-- a database it provisions itself. This file proves them against the database
-- an operator actually deployed, where the roles, grants and policies were
-- created by these very scripts — the situation a CI run cannot vouch for. Run
-- it after 01–03, and again after any manual GRANT.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_sites_without_context integer;
  v_sites_in_tenant       integer;
  v_sites_other_tenant    integer;
  v_users_in_tenant       integer;
  v_tenants_visible       integer;
begin
  -- ── 1. Fail closed without a tenant context ─────────────────────────────
  set local role fgmp_app;

  select count(*) into v_sites_without_context from "Site";
  if v_sites_without_context <> 0 then
    raise exception 'RLS FAILURE: fgmp_app can see % rows of "Site" with no app.tenant_id set. Expected 0.', v_sites_without_context;
  end if;
  raise notice 'OK: fgmp_app sees 0 sites with no tenant context.';

  -- ── 2. Inside a context, only that tenant's rows ────────────────────────
  -- `set_config(..., true)` is transaction-local; in a DO block it is scoped to
  -- the block's transaction, which is exactly the lifetime this check needs.
  perform set_config('app.tenant_id', 't-default', true);

  select count(*) into v_sites_in_tenant from "Site";
  select count(*) into v_users_in_tenant from "User";
  -- The platform tenant owns the super-admin and no sites.
  perform set_config('app.tenant_id', 't-platform', true);
  select count(*) into v_sites_other_tenant from "Site";

  if v_sites_in_tenant = 0 then
    raise exception 'RLS FAILURE: fgmp_app sees no sites inside tenant t-default. The policy is over-restrictive or the seed did not run.';
  end if;
  if v_sites_other_tenant <> 0 then
    raise exception 'RLS FAILURE: fgmp_app sees % sites inside tenant t-platform, which owns none.', v_sites_other_tenant;
  end if;

  -- Tenant registry: the platform tenant must be visible, because resolving a
  -- tenant is not reading another tenant's operational data.
  select count(*) into v_tenants_visible from "Tenant";
  if v_tenants_visible = 0 then
    raise exception 'Tenant is not readable by fgmp_app — login cannot resolve a tenant.';
  end if;

  raise notice 'OK: t-default -> % sites, % users; t-platform -> 0 sites; % tenant(s) resolvable.',
    v_sites_in_tenant, v_users_in_tenant, v_tenants_visible;

  -- ── 3. No DDL, no migration-history writes ──────────────────────────────
  begin
    execute 'create table "rls_probe_should_fail" (id int)';
    raise exception 'PRIVILEGE FAILURE: fgmp_app was able to CREATE TABLE. It must be DML-only.';
  exception when insufficient_privilege then
    raise notice 'OK: fgmp_app cannot create tables.';
  end;

  begin
    delete from "_prisma_migrations";
    raise exception 'PRIVILEGE FAILURE: fgmp_app can write to "_prisma_migrations" — migration history is forgeable.';
  exception when insufficient_privilege then
    raise notice 'OK: fgmp_app cannot modify Prisma migration history.';
  end;
end $$;

-- ── 4. The bypassing roles are the ones that bypass ────────────────────────
do $$
declare
  v_ops_sees integer;
  v_ops_bypasses boolean;
begin
  select rolbypassrls into v_ops_bypasses from pg_roles where rolname = 'fgmp_ops';
  if not v_ops_bypasses then
    raise exception 'fgmp_ops lost BYPASSRLS — platform census and pg_dump will silently return zero rows.';
  end if;

  set local role fgmp_ops;
  select count(*) into v_ops_sees from "Site";
  if v_ops_sees = 0 then
    raise exception 'fgmp_ops sees no sites despite BYPASSRLS.';
  end if;
  raise notice 'OK: fgmp_ops (BYPASSRLS) sees % sites across all tenants.', v_ops_sees;
end $$;

do $$
begin
  raise notice 'FGMP deployment verified.';
end $$;
