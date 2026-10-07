-- Phase 4 — Solar domain + Battery cycle/cell imbalance columns
--
-- ── SOLAR ────────────────────────────────────────────────────────────────────
-- A site can have multiple arrays on different roofs, at different tilts, with
-- different inverters. The child-table design is the only way to express that
-- without forcing every array on a site to share one rating — which would be
-- wrong for the multi-roof case the domain exists to describe.
--
-- Telemetry for output kW, daily yield kWh and irradiance follows the EXISTING
-- sensor/telemetry pattern (IotDevice + SensorReading) rather than inventing a
-- parallel one. These models hold the static inventory; the live readings come
-- from the same ingestion pipeline that already handles fuel sensors and
-- battery sensors.

-- SolarSite: one per site, aggregated capacity and site-level notes
CREATE TABLE IF NOT EXISTS "SolarSite" (
    "id"            TEXT        NOT NULL,
    "siteId"        TEXT        NOT NULL,
    "tenantId"      TEXT        NOT NULL,
    "capacityKwp"   DOUBLE PRECISION NOT NULL,
    "installedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes"         TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- DEFAULT is required, not decorative. Prisma's @updatedAt is applied by
    -- the client on write, but the column must still satisfy NOT NULL for any
    -- write that does not go through Prisma — including a raw fixture insert.
    -- Omitting it here produced exactly the failure the RLS suite caught for
    -- InterlockThreshold: P2011 null constraint on updatedAt.
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolarSite_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SolarSite_siteId_key" UNIQUE ("siteId"),
    CONSTRAINT "SolarSite_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SolarSite_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "SolarSite_tenantId_idx" ON "SolarSite" ("tenantId");

-- SolarArray: one array per roof/inverter
CREATE TABLE IF NOT EXISTS "SolarArray" (
    "id"              TEXT        NOT NULL,
    "solarSiteId"     TEXT        NOT NULL,
    "tenantId"        TEXT        NOT NULL,
    "label"           TEXT        NOT NULL,
    "ratedKwp"        DOUBLE PRECISION NOT NULL,
    "orientation"     TEXT,
    "tiltDegrees"     INTEGER,
    "azimuthDegrees"  INTEGER,
    "inverterSerial"  TEXT,
    "inverterModel"   TEXT,
    "installedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- See the note on SolarSite.updatedAt: the DEFAULT is load-bearing.
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolarArray_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SolarArray_solarSiteId_fkey" FOREIGN KEY ("solarSiteId") REFERENCES "SolarSite"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SolarArray_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "SolarArray_tenantId_idx" ON "SolarArray" ("tenantId");
CREATE INDEX IF NOT EXISTS "SolarArray_solarSiteId_idx" ON "SolarArray" ("solarSiteId");

-- ── BATTERY ───────────────────────────────────────────────────────────────────
-- Two columns the existing model was missing:
--   cycleCount   - total charge/discharge cycles since install (nullable)
--   cellBalanceMv - signed cell imbalance in millivolts (nullable)
-- Both are nullable because an existing bank has no history recorded; inventing 0
-- would assert a measurement nobody made.

ALTER TABLE "BatteryBank"
  ADD COLUMN IF NOT EXISTS "cycleCount" INTEGER,
  ADD COLUMN IF NOT EXISTS "cellBalanceMv" INTEGER;

-- ── RLS FOR SOLAR TABLES ──────────────────────────────────────────────────────
-- Both tables carry tenantId and MUST have ENABLE + FORCE ROW LEVEL SECURITY.
-- fgmp_migrate owns these tables and an owner bypasses RLS without FORCE, which
-- leaves the policy binding nobody. Model on 20261008002000_geography_rls_write_path.

ALTER TABLE "SolarSite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SolarSite" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SolarArray" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SolarArray" FORCE ROW LEVEL SECURITY;

-- SolarSite: direct tenantId
CREATE POLICY solarsite_tenant_select ON "SolarSite"
  FOR SELECT
  USING ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY solarsite_tenant_write ON "SolarSite"
  FOR INSERT
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY solarsite_tenant_update ON "SolarSite"
  FOR UPDATE
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY solarsite_tenant_delete ON "SolarSite"
  FOR DELETE
  USING ("tenantId" = current_setting('app.tenant_id', true));

-- SolarArray: direct tenantId
CREATE POLICY solararray_tenant_select ON "SolarArray"
  FOR SELECT
  USING ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY solararray_tenant_write ON "SolarArray"
  FOR INSERT
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY solararray_tenant_update ON "SolarArray"
  FOR UPDATE
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY solararray_tenant_delete ON "SolarArray"
  FOR DELETE
  USING ("tenantId" = current_setting('app.tenant_id', true));

-- Privileges for app role
GRANT SELECT, INSERT, UPDATE, DELETE ON "SolarSite" TO fgmp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "SolarArray" TO fgmp_app;

COMMENT ON POLICY solarsite_tenant_select ON "SolarSite" IS
  'Direct tenantId filter. Tenant owns the row.';
COMMENT ON POLICY solararray_tenant_select ON "SolarArray" IS
  'Direct tenantId filter. Tenant owns the row.';