-- Phase 1, step 6 — enable Row Level Security on every tenant-carrying table.
--
-- Generated from information_schema at the time of writing (24 tables that
-- actually have a "tenantId" column), so the migration cannot drift from the
-- schema. Tables without the column — Tenant, SystemSetting, EspFirmwareRelease,
-- Governorate, District, _prisma_migrations — are intentionally excluded:
-- they are either the tenant table itself, global configuration, a global
-- firmware catalogue, geography that reaches tenancy through Region, or
-- Prisma's own bookkeeping.
--
-- COLUMN NAMING (deliberate asymmetry, do not "fix"):
--   the COLUMN is quoted camelCase "tenantId" because that is this schema's
--   universal convention — siteId, createdAt, loadKw, and so on. There are
--   zero snake_case columns in the application schema.
--   the SETTING NAME 'app.tenant_id' stays snake_case because it is a free-form
--   PostgreSQL GUC identifier we own, not a schema object. Renaming either one
--   independently would break the pairing between policy and application.
--
-- NO ::uuid CAST. Tenant.id is String @default(cuid()), stored as TEXT, and real
-- ids are cuid-style ("t-default", "t-platform"). Casting to uuid throws
--     ERROR: invalid input syntax for type uuid: "t-default"
-- on every row access. The predicate is plain TEXT equality.
--
-- FAIL CLOSED. current_setting('app.tenant_id', true) returns NULL when the
-- setting is absent (missing_ok). The predicate becomes "tenantId" = NULL,
-- which is NULL, and SQL WHERE keeps a row only when its predicate is TRUE.
-- So an unset context returns ZERO rows rather than everything. This is what
-- makes a missing withTenant() call loud instead of a data leak.
--
-- NOTE (PostgreSQL 17): after COMMIT or ROLLBACK of a transaction-local
-- setting, current_setting('app.tenant_id', true) returns the EMPTY STRING,
-- not NULL — so "IS NULL" is false even though the context is gone. Still safe
-- (the predicate is always false against a NOT NULL column), but code that
-- branches on IS NULL to detect "no context" is wrong. tenant-context.ts
-- normalises both to null.
--
-- FORCE is mandatory. PostgreSQL skips RLS for the table owner, and
-- fgmp_migrate owns these tables. Without FORCE the policy would bind nobody;
-- with it the policy holds even for the owner, so a migration or a psql session
-- cannot read across tenants by accident. The web app additionally connects as
-- the non-owner fgmp_app role (see src/lib/db.ts).
--
-- Application contract: all tenant-scoped reads and writes must run inside
-- withTenant(tenantId, fn) from src/lib/fgmp/tenant-context.ts, which sets the
-- GUC with set_config(..., true) inside an interactive transaction. A pooled
-- global SET would leak one tenant's context into the next request that reuses
-- the connection.

-- Alarm
ALTER TABLE "Alarm" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Alarm" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Alarm";
CREATE POLICY tenant_isolation ON "Alarm"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- AlarmSuppression
ALTER TABLE "AlarmSuppression" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AlarmSuppression" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AlarmSuppression";
CREATE POLICY tenant_isolation ON "AlarmSuppression"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- ApiKey
ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ApiKey";
CREATE POLICY tenant_isolation ON "ApiKey"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- AuditLog
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditLog";
CREATE POLICY tenant_isolation ON "AuditLog"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- BackupRecord
ALTER TABLE "BackupRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BackupRecord" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BackupRecord";
CREATE POLICY tenant_isolation ON "BackupRecord"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- BatteryBank
ALTER TABLE "BatteryBank" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BatteryBank" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BatteryBank";
CREATE POLICY tenant_isolation ON "BatteryBank"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- ControlCommand
ALTER TABLE "ControlCommand" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ControlCommand" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ControlCommand";
CREATE POLICY tenant_isolation ON "ControlCommand"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- EspFirmwareDeployment
ALTER TABLE "EspFirmwareDeployment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EspFirmwareDeployment" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "EspFirmwareDeployment";
CREATE POLICY tenant_isolation ON "EspFirmwareDeployment"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- FuelDelivery
ALTER TABLE "FuelDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FuelDelivery" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "FuelDelivery";
CREATE POLICY tenant_isolation ON "FuelDelivery"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- FuelDispenser
ALTER TABLE "FuelDispenser" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FuelDispenser" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "FuelDispenser";
CREATE POLICY tenant_isolation ON "FuelDispenser"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- FuelTank
ALTER TABLE "FuelTank" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FuelTank" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "FuelTank";
CREATE POLICY tenant_isolation ON "FuelTank"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- FuelTransaction
ALTER TABLE "FuelTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FuelTransaction" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "FuelTransaction";
CREATE POLICY tenant_isolation ON "FuelTransaction"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Generator
ALTER TABLE "Generator" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Generator" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Generator";
CREATE POLICY tenant_isolation ON "Generator"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- IotDevice
ALTER TABLE "IotDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IotDevice" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "IotDevice";
CREATE POLICY tenant_isolation ON "IotDevice"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- MaintenanceTicket
ALTER TABLE "MaintenanceTicket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MaintenanceTicket" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MaintenanceTicket";
CREATE POLICY tenant_isolation ON "MaintenanceTicket"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Notification
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Notification";
CREATE POLICY tenant_isolation ON "Notification"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- NotificationPreference
ALTER TABLE "NotificationPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationPreference" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "NotificationPreference";
CREATE POLICY tenant_isolation ON "NotificationPreference"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Region
ALTER TABLE "Region" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Region" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Region";
CREATE POLICY tenant_isolation ON "Region"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- SensorReading
ALTER TABLE "SensorReading" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SensorReading" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SensorReading";
CREATE POLICY tenant_isolation ON "SensorReading"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- ShiftHandover
ALTER TABLE "ShiftHandover" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShiftHandover" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ShiftHandover";
CREATE POLICY tenant_isolation ON "ShiftHandover"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Site
ALTER TABLE "Site" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Site" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Site";
CREATE POLICY tenant_isolation ON "Site"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- SiteEvent
ALTER TABLE "SiteEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SiteEvent" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SiteEvent";
CREATE POLICY tenant_isolation ON "SiteEvent"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- SiteGateway
ALTER TABLE "SiteGateway" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SiteGateway" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SiteGateway";
CREATE POLICY tenant_isolation ON "SiteGateway"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- User
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "User";
CREATE POLICY tenant_isolation ON "User"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Verification: expect 24 rows with relrowsecurity = t AND
-- relforcerowsecurity = t, and 24 policies named tenant_isolation.
SELECT count(*) AS rls_tables
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relrowsecurity AND c.relforcerowsecurity;

SELECT count(*) AS policies
FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation';
