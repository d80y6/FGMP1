-- Phase 1 step 8 (part): grant table privileges to the three roles.
--
-- Runs immediately after the baseline schema migration. The roles themselves
-- are created by scripts/pg-init-roles.sh on first database initialisation,
-- but that script cannot grant on tables that do not exist yet — so the grants
-- live here, where they are applied after every table creation and re-applied
-- whenever a later migration adds one.
--
-- ── The privilege split that makes RLS mean anything ───────────────────────
--   fgmp_app     : DML only (SELECT/INSERT/UPDATE/DELETE).
--                  No CREATE/DROP/ALTER, and crucially NOT the table owner —
--                  an owner silently bypasses RLS unless FORCE ROW LEVEL
--                  SECURITY is set (applied in the step 6 migration). Keeping
--                  the app off the owner list is what makes the step 6 policy a
--                  real backstop rather than decoration.
--   fgmp_ops     : same DML, but the role holds BYPASSRLS, so internal ops can
--                  see across tenants for support work and pg_dump.
--                  It must never be present in the web app's environment.
--   fgmp_migrate : owns the schema (created the tables), so it needs nothing
--                  further for DDL.
--
-- USAGE on the schema is required in addition to table privileges.

GRANT USAGE ON SCHEMA public TO fgmp_app, fgmp_ops;

-- Default privileges cover tables created by later migrations, so a new table
-- does not silently ship without grants. ALTER DEFAULT PRIVILEGES applies to
-- objects created by the role that runs it — here, fgmp_migrate.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fgmp_app, fgmp_ops;
-- Existing tables (the 29 baseline models).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fgmp_app, fgmp_ops;

-- Sequences back SERIAL/BIGSERIAL identity columns; without USAGE an INSERT
-- that relies on a default nextval() fails at runtime.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fgmp_app, fgmp_ops;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO fgmp_app, fgmp_ops;
