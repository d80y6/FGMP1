-- Phase 4 — interlock thresholds become persisted, operator-visible DATA, and
-- site protected load becomes a real column.
--
-- WHY THRESHOLDS MOVE OUT OF CODE
-- Every interlock threshold shipped in Phase 2 (coolant 85 C, oil 150 kPa,
-- cranking fuel 12 L, cooldown 3 min, fault backoff 10 min, overdue-service
-- 500 h) was an INFERRED placeholder. That was flagged rather than hidden,
-- which is the right thing to have done at the time — but an inferred number
-- hard-coded in a module is not operable:
--
--   * An operator holding the OEM datasheet cannot correct it without editing
--     source and shipping a deploy.
--   * Nothing can answer "which of my limits are still guesses?" — the
--     information exists only as a comment in one file.
--   * A threshold is not universal. The same engine model across two tenants
--     can carry different service intervals, and one tenant may have sourced a
--     real datasheet while another has not.
--
-- So the values move here, per tenant, WITH their provenance. The code keeps
-- safe defaults for a tenant that has never configured anything; this table is
-- how an operator departs from them, visibly.
--
-- CRANKING FUEL IS NOW A FRACTION OF TANK CAPACITY, NOT A LITRE COUNT
-- The Phase 2 value was 12 L, chosen because a flat litre count cannot be
-- correct across engine displacements: a 6 kW standby set and a 2000 kW
-- prime set have usable tanks differing by an order of magnitude, so 12 L is
-- trivial for one and a rounding error for the other. Real practice expresses
-- this as a fraction of usable capacity (or as minutes of cranking load at a
-- specified current). PERCENT_OF_TANK is used here because it is
-- displacement-independent and needs only the tank capacity the platform
-- already models.
--
-- THE ENUM DEFAULTS ARE INFERRED
-- Not an oversight. A row written without a stated source is an unconfirmed
-- threshold, and the application surfaces that rather than presenting it as an
-- engineering standard. Confirming a value is a separate, deliberate act that
-- records WHO and WHEN.

-- ── Enums ───────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ThresholdSource') THEN
    CREATE TYPE "ThresholdSource" AS ENUM (
      'OEM_DATASHEET',
      'SITE_POLICY',
      'MAINTENANCE_SCHEDULE',
      'DERIVED',
      'INFERRED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ThresholdUnit') THEN
    CREATE TYPE "ThresholdUnit" AS ENUM (
      'CELSIUS',
      'KPA',
      'PERCENT_OF_TANK',
      'MINUTES',
      'HOURS',
      'LITRES_PER_MINUTE'
    );
  END IF;
END $$;

COMMENT ON TYPE "ThresholdSource" IS
  'Provenance of an interlock threshold value. INFERRED is the honest default: '
  'no number in this codebase was supplied by an OEM datasheet, a site policy or '
  'a maintenance schedule, and the application must not present one as though it were.';

-- ── Table ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "InterlockThreshold" (
    "id"           TEXT        NOT NULL,
    "tenantId"     TEXT        NOT NULL,
    "thresholdKey" TEXT        NOT NULL,
    "value"        DOUBLE PRECISION NOT NULL,
    "unit"         "ThresholdUnit" NOT NULL,
    "source"       "ThresholdSource" NOT NULL DEFAULT 'INFERRED',
    "confirmedById" TEXT,
    "confirmedAt"  TIMESTAMP(3),
    "sourceRef"    TEXT,
    "siteId"       TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterlockThreshold_pkey" PRIMARY KEY ("id")
);

-- siteId is nullable (NULL = the tenant-wide default) but the uniqueness has to
-- treat NULL as a real value, and a plain UNIQUE would let a tenant store any
-- number of tenant-wide defaults for the same key. PostgreSQL 15+ has NULLS NOT
-- DISTINCT for exactly this; PG17 is what this project targets.
CREATE UNIQUE INDEX IF NOT EXISTS "InterlockThreshold_tenantId_thresholdKey_siteId_key"
  ON "InterlockThreshold" ("tenantId", "thresholdKey", "siteId") NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS "InterlockThreshold_tenantId_idx" ON "InterlockThreshold" ("tenantId");
CREATE INDEX IF NOT EXISTS "InterlockThreshold_tenantId_siteId_idx" ON "InterlockThreshold" ("tenantId", "siteId");

-- ── Site.protectedLoadKw ────────────────────────────────────────────────────
-- The load that must stay energised whatever else is shed. Default 0 means
-- "nothing declared" and the interlock treats it as "no floor", NOT as
-- permission to shed everything: an undeclared floor must not become a licence
-- to black out a site.

ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "protectedLoadKw" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- ── Foreign keys ────────────────────────────────────────────────────────────
-- Tenant RESTRICT matches every other tenant table: a tenant holding safety
-- configuration must not be silently deletable. Site CASCADE because a
-- threshold for a removed site is meaningless. confirmedById RESTRICT so the
-- record of WHO confirmed a safety value cannot be deleted out from under it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InterlockThreshold_tenantId_fkey') THEN
    ALTER TABLE "InterlockThreshold"
      ADD CONSTRAINT "InterlockThreshold_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InterlockThreshold_siteId_fkey') THEN
    ALTER TABLE "InterlockThreshold"
      ADD CONSTRAINT "InterlockThreshold_siteId_fkey"
      FOREIGN KEY ("siteId") REFERENCES "Site"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InterlockThreshold_confirmedById_fkey') THEN
    ALTER TABLE "InterlockThreshold"
      ADD CONSTRAINT "InterlockThreshold_confirmedById_fkey"
      FOREIGN KEY ("confirmedById") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON "InterlockThreshold" TO fgmp_app;

-- ── Row Level Security ──────────────────────────────────────────────────────
-- FORCE is mandatory: fgmp_migrate owns this table and PostgreSQL skips RLS for
-- the owner without it, which would leave the policy binding nobody.
--
-- Enumerated from information_schema so this stays correct as the schema grows,
-- matching the step-6 and geography migrations.

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

COMMENT ON TABLE "InterlockThreshold" IS
  'Per-tenant interlock thresholds with their provenance. A threshold whose '
  'source is INFERRED has never been confirmed against an OEM datasheet, a site '
  'policy or a maintenance schedule; the application surfaces that to operators '
  'rather than presenting the number as an engineering standard.';