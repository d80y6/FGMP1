-- FGMP — PostgreSQL role bootstrap (Phase 1, step 8)
--
-- Runs ONCE, on first initialisation of the `fgmp-pgdata` volume
-- (via scripts/db/pg-init-roles.sh, mounted at
-- /docker-entrypoint-initdb.d/00-pg-init-roles.sh). Creates the three database
-- roles with the exact privileges the architecture decision calls for:
--
--   | Role         | Used by     | RLS              | Network                        |
--   |--------------|-------------|------------------|--------------------------------|
--   | fgmp_app     | Web app     | Enforced (FORCE) | App subnet only                |
--   | fgmp_ops     | Internal ops| BYPASSRLS        | Ops network only, never in app |
--   | fgmp_migrate | Migrations  | DDL only         | CI only                        |
--
-- ── Why three roles, and why it matters ────────────────────────────────────
-- Row Level Security is skipped by the table OWNER unless FORCE ROW LEVEL
-- SECURITY is set. That makes role separation load-bearing rather than
-- cosmetic:
--
--   * fgmp_app is NOT the owner and does NOT have BYPASSRLS, so every query it
--     runs is filtered by policy — including a query with a deliberately wrong
--     or missing WHERE clause. That is the guarantee the web app depends on.
--   * fgmp_ops holds BYPASSRLS because internal operations (a `pg_dump`
--     scheduled on the ops network, a cross-tenant support investigation) must
--     see the whole platform. It must NEVER appear in the web app's
--     environment — if it did, one injection bug anywhere would bypass
--     isolation entirely. Compose wires the two URLs separately, see
--     docker-compose.yml.
--   * fgmp_migrate owns the schema so it can run DDL, and is the only role
--     used by CI. The web app never holds it.
--
-- ── Why plain CREATE ROLE + \gexec, not DO $$ ... $$ ───────────────────────
-- psql's :'var' substitution is performed by the client while parsing each
-- statement, and it does NOT reach inside dollar-quoted bodies. A previous
-- revision wrapped CREATE ROLE in `DO $$ ... $$` for idempotency and failed
-- with `syntax error at or near ":"`. The SELECT-guarded \gexec below is
-- idempotent AND interpolates correctly.

\set ON_ERROR_STOP on

-- ── App role: DML only, no DDL, no BYPASSRLS ───────────────────────────────
SELECT 'CREATE ROLE fgmp_app LOGIN PASSWORD ' || quote_literal(:'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fgmp_app')
\gexec

-- ── Ops role: read/write across all tenants, bypasses RLS by design ────────
SELECT 'CREATE ROLE fgmp_ops LOGIN BYPASSRLS PASSWORD ' || quote_literal(:'ops_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fgmp_ops')
\gexec

-- ── Migrate role: DDL only, used by CI ─────────────────────────────────────
SELECT 'CREATE ROLE fgmp_migrate LOGIN PASSWORD ' || quote_literal(:'migrate_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fgmp_migrate')
\gexec

GRANT CONNECT ON DATABASE fgmp TO fgmp_app, fgmp_ops;

\echo 'FGMP roles provisioned: fgmp_app (RLS-enforced), fgmp_ops (BYPASSRLS), fgmp_migrate (DDL)'
