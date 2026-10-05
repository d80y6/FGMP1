-- Phase 2 vertical 3 — generator control safety interlocks.
--
-- Creates InterlockOverride: the audit record for every two-person override of
-- a refused control command.
--
-- WHY A SEPARATE TABLE RATHER THAN A FIELD ON ControlCommand
-- An override is not a control command. It is a record that a command was
-- REFUSED and a human chose to proceed anyway, signed by two people. Storing it
-- on ControlCommand would conflate "we issued this" with "we bypassed a safety
-- control", which is exactly the distinction an audit has to be able to make.
-- Keeping them apart also means a refused command can never be mistaken for an
-- executed one by a query that forgets to filter on status.
--
-- RLS
-- InterlockOverride carries tenantId, so it is covered by the same
-- tenant_isolation policy as the other 24 tenant tables. FORCE is mandatory —
-- fgmp_migrate owns the table, and PostgreSQL skips RLS for the owner without
-- it, which would make the policy bind nobody.
--
-- The table list is enumerated from information_schema at migration time, like
-- the step-6 migration, so it cannot drift from the schema.

-- ── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE "InterlockOverride" (
    "id"             TEXT        NOT NULL,
    "tenantId"       TEXT        NOT NULL,
    "generatorId"    TEXT        NOT NULL,
    "command"        "GenCommandType" NOT NULL,
    "ruleId"         TEXT        NOT NULL,
    "requestedById"  TEXT        NOT NULL,
    "approvedById"   TEXT,
    "justification"  TEXT        NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterlockOverride_pkey" PRIMARY KEY ("id")
);

-- ── Foreign keys ─────────────────────────────────────────────────────────────
-- onDelete: Restrict on Tenant matches every other tenant-carrying table: a
-- tenant that owns safety-override history must not be silently deletable.
-- Cascade on Generator is deliberate — an override is meaningless without the
-- asset it was taken against, and ControlCommand already cascades the same way.

CREATE UNIQUE INDEX "InterlockOverride_id_key" ON "InterlockOverride"("id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'InterlockOverride_tenantId_fkey'
  ) THEN
    ALTER TABLE "InterlockOverride"
      ADD CONSTRAINT "InterlockOverride_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'InterlockOverride_generatorId_fkey'
  ) THEN
    ALTER TABLE "InterlockOverride"
      ADD CONSTRAINT "InterlockOverride_generatorId_fkey"
      FOREIGN KEY ("generatorId") REFERENCES "Generator"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'InterlockOverride_requestedById_fkey'
  ) THEN
    ALTER TABLE "InterlockOverride"
      ADD CONSTRAINT "InterlockOverride_requestedById_fkey"
      FOREIGN KEY ("requestedById") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'InterlockOverride_approvedById_fkey'
  ) THEN
    ALTER TABLE "InterlockOverride"
      ADD CONSTRAINT "InterlockOverride_approvedById_fkey"
      FOREIGN KEY ("approvedById") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- Matches the index shape the other tenant tables use.

CREATE INDEX "InterlockOverride_tenantId_idx" ON "InterlockOverride"("tenantId");
CREATE INDEX "InterlockOverride_tenantId_createdAt_idx" ON "InterlockOverride"("tenantId", "createdAt");
CREATE INDEX "InterlockOverride_generatorId_idx" ON "InterlockOverride"("generatorId");

-- ── Grants ───────────────────────────────────────────────────────────────────
-- fgmp_app is a non-owner role and needs DML; it does NOT need to create roles
-- or own anything, which is what keeps FORCE RLS binding.

GRANT SELECT, INSERT, UPDATE, DELETE ON "InterlockOverride" TO fgmp_app;

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Applied to every table in the schema that carries a "tenantId", matching the
-- step-6 migration. Enumerated rather than hardcoded so this stays correct as
-- the schema grows.

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN information_schema.columns col
      ON col.table_schema = ns.nspname AND col.table_name = c.relname
    WHERE ns.nspname = 'public'
      AND c.relkind = 'r'
      AND col.column_name = 'tenantId'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.tablename);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING      ("tenantId" = current_setting(''app.tenant_id'', true))
         WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))',
      t.tablename
    );
  END LOOP;
END $$;