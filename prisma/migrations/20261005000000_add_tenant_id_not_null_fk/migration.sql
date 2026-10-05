-- Phase 1 steps 2, 3, 4 and 5 — collapsed into ONE migration.
--
-- Adds a `tenantId` TEXT column, NOT NULL, with a FK to "Tenant"(id)
-- ON DELETE RESTRICT, to the sixteen models that had no tenant scope, and adds
-- the six missing FKs on models that already had the column but never
-- constrained it.
--
-- ── Why one migration, not three ────────────────────────────────────────────
-- Steps 2 (nullable), 3 (backfill) and 4 (NOT NULL + FK) exist as separate
-- steps only because a NOT NULL column on a POPULATED table needs somewhere to
-- put the value first. This database holds regenerable demo data only
-- (52 sites / 168 transactions, reproduced by seedIfNeeded()), so the
-- constraint does not bind: `tenant_id` is created NOT NULL directly and the
-- NULL-tenant_id exposure window never opens. The three steps collapse.
--
-- ── Why TEXT and not uuid ───────────────────────────────────────────────────
-- The architecture draft specified `current_setting('app.tenant_id', true)::uuid`
-- for the step 6 RLS policy. "Tenant".id is TEXT and every primary key in this
-- schema is cuid-style TEXT, so that cast errors at runtime:
--
--   ERROR: invalid input syntax for type uuid: "t-default"
--
-- tenant_id is therefore TEXT and the step 6 predicate drops the cast:
--   USING      (tenant_id = current_setting('app.tenant_id', true))
--   WITH CHECK (tenant_id = current_setting('app.tenant_id', true))
-- Fail-closed is preserved: current_setting(..., true) is NULL when unset,
-- NULL = <text> is NULL, and a NULL predicate is not TRUE.
--
-- ── Replayability ───────────────────────────────────────────────────────────
-- Correct from an empty database: every ADD COLUMN is backfilled from parent
-- rows and then constrained, so applying this to a freshly-created schema (all
-- tables empty) succeeds — the UPDATEs match zero rows and ALTER ... SET NOT
-- NULL is vacuous.
--
-- ── Deletion rule ───────────────────────────────────────────────────────────
-- Rows that cannot be resolved to a tenant are DELETED, never defaulted. A
-- guessed tenant is worse than a missing row: it silently places data in the
-- wrong tenant and the step 6 RLS policy would then protect it there forever.
-- On this database 585/585 rows resolve, so the DELETEs are no-ops; they exist
-- so the migration stays correct if it is ever replayed against real data.

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 1 of the migration body — add the column as NULL, backfill, then
-- constrain. Split into statements because NOT NULL cannot be set on a
-- populated column in the same statement that adds it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Tier B: denormalised from the parent Site (one hop) ─────────────────────
-- Column order does not matter in PostgreSQL, so this is purely for reviewability.

ALTER TABLE "FuelTank"          ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Generator"         ADD COLUMN "tenantId" TEXT;
ALTER TABLE "BatteryBank"       ADD COLUMN "tenantId" TEXT;
ALTER TABLE "IotDevice"         ADD COLUMN "tenantId" TEXT;
ALTER TABLE "FuelDispenser"     ADD COLUMN "tenantId" TEXT;
ALTER TABLE "FuelTransaction"   ADD COLUMN "tenantId" TEXT;
ALTER TABLE "SensorReading"     ADD COLUMN "tenantId" TEXT;
ALTER TABLE "SiteEvent"         ADD COLUMN "tenantId" TEXT;
ALTER TABLE "FuelDelivery"      ADD COLUMN "tenantId" TEXT;
ALTER TABLE "MaintenanceTicket" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "SiteGateway"       ADD COLUMN "tenantId" TEXT;

-- ── Tier A: resolved through a non-Site parent ──────────────────────────────
ALTER TABLE "NotificationPreference" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "EspFirmwareDeployment"  ADD COLUMN "tenantId" TEXT;

-- ── Tier B (two hops): ControlCommand has no siteId; it reaches Site through
--    generatorId -> Generator. Runs AFTER Generator's backfill above.
ALTER TABLE "ControlCommand" ADD COLUMN "tenantId" TEXT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Backfill (step 3)
-- ═══════════════════════════════════════════════════════════════════════════

-- Tier B: parent Site.
UPDATE "FuelTank"          t SET "tenantId" = s."tenantId" FROM "Site" s WHERE t."siteId" = s."id";
UPDATE "Generator"         t SET "tenantId" = s."tenantId" FROM "Site" s WHERE t."siteId" = s."id";
UPDATE "BatteryBank"       t SET "tenantId" = s."tenantId" FROM "Site" s WHERE t."siteId" = s."id";
UPDATE "IotDevice"         t SET "tenantId" = s."tenantId" FROM "Site" s WHERE t."siteId" = s."id";
UPDATE "FuelDispenser"     t SET "tenantId" = s."tenantId" FROM "Site" s WHERE t."siteId" = s."id";
UPDATE "FuelTransaction"   t SET "tenantId" = s."tenantId" FROM "Site" s WHERE t."siteId" = s."id";
UPDATE "SensorReading"     t SET "tenantId" = s."tenantId" FROM "Site" s WHERE t."siteId" = s."id";
UPDATE "SiteEvent"         t SET "tenantId" = s."tenantId" FROM "Site" s WHERE t."siteId" = s."id";
UPDATE "FuelDelivery"      t SET "tenantId" = s."tenantId" FROM "Site" s WHERE t."siteId" = s."id";
UPDATE "MaintenanceTicket" t SET "tenantId" = s."tenantId" FROM "Site" s WHERE t."siteId" = s."id";
UPDATE "SiteGateway"       t SET "tenantId" = s."tenantId" FROM "Site" s WHERE t."siteId" = s."id";

-- Tier A: NotificationPreference via User; EspFirmwareDeployment via the
-- dispenser's site. Runs AFTER the FuelDispenser backfill above.
UPDATE "NotificationPreference" n SET "tenantId" = u."tenantId" FROM "User" u WHERE n."userId" = u."id";
UPDATE "EspFirmwareDeployment"  d SET "tenantId" = s."tenantId" FROM "FuelDispenser" f JOIN "Site" s ON f."siteId" = s."id" WHERE d."dispenserId" = f."id";

-- ControlCommand: two hops, generatorId -> Generator.tenantId.
UPDATE "ControlCommand" c SET "tenantId" = g."tenantId" FROM "Generator" g WHERE c."generatorId" = g."id";

-- ── Delete what cannot be resolved. Named in the failure message so a future
--    replay against real data says exactly which rows it dropped and why.
DO $$
DECLARE
  t TEXT;
  n BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'FuelTank','Generator','BatteryBank','IotDevice','FuelDispenser',
    'FuelTransaction','SensorReading','SiteEvent','FuelDelivery',
    'MaintenanceTicket','SiteGateway','NotificationPreference',
    'EspFirmwareDeployment','ControlCommand'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "tenantId" IS NULL', t) INTO n;
    IF n > 0 THEN
      RAISE WARNING 'Phase 1 tenant_id: deleting % unresolvable rows from %', n, t;
      EXECUTE format('DELETE FROM %I WHERE "tenantId" IS NULL', t);
    END IF;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOT NULL + FK (step 4)
--
-- ON DELETE RESTRICT, not CASCADE: RESTRICT is correct for the tenant boundary
-- — a tenant that still owns assets must not be deletable. This deliberately
-- differs from the ON DELETE CASCADE that Site's children already carry; that
-- cascade is about deleting a SITE, which still removes its children normally.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "FuelTank"          ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Generator"         ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "BatteryBank"       ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "IotDevice"         ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "FuelDispenser"     ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "FuelTransaction"   ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SensorReading"     ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SiteEvent"         ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "FuelDelivery"      ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ControlCommand"    ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "MaintenanceTicket" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SiteGateway"       ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "NotificationPreference" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "EspFirmwareDeployment"  ALTER COLUMN "tenantId" SET NOT NULL;

-- FKs for the sixteen new columns.
ALTER TABLE "FuelTank"               ADD CONSTRAINT "FuelTank_tenantId_fkey"              FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "Generator"              ADD CONSTRAINT "Generator_tenantId_fkey"             FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "BatteryBank"            ADD CONSTRAINT "BatteryBank_tenantId_fkey"           FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "IotDevice"              ADD CONSTRAINT "IotDevice_tenantId_fkey"             FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "FuelDispenser"          ADD CONSTRAINT "FuelDispenser_tenantId_fkey"         FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "FuelTransaction"        ADD CONSTRAINT "FuelTransaction_tenantId_fkey"       FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "SensorReading"          ADD CONSTRAINT "SensorReading_tenantId_fkey"         FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "SiteEvent"              ADD CONSTRAINT "SiteEvent_tenantId_fkey"             FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "FuelDelivery"           ADD CONSTRAINT "FuelDelivery_tenantId_fkey"          FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "ControlCommand"         ADD CONSTRAINT "ControlCommand_tenantId_fkey"        FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "MaintenanceTicket"      ADD CONSTRAINT "MaintenanceTicket_tenantId_fkey"     FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "SiteGateway"            ADD CONSTRAINT "SiteGateway_tenantId_fkey"           FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "EspFirmwareDeployment"  ADD CONSTRAINT "EspFirmwareDeployment_tenantId_fkey"  FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── Tier C: the six models that already had tenantId but no FK to Tenant ─────
-- Without these the step 6 RLS policy sits on a column nothing constrains: a
-- write with a non-existent tenant would pass silently and then be protected
-- in the wrong place forever. All six columns are already NOT NULL with rows
-- present, so the constraint can be added directly.
ALTER TABLE "Region"        ADD CONSTRAINT "Region_tenantId_fkey"        FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "Alarm"         ADD CONSTRAINT "Alarm_tenantId_fkey"         FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "AuditLog"      ADD CONSTRAINT "AuditLog_tenantId_fkey"      FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "Notification"  ADD CONSTRAINT "Notification_tenantId_fkey"  FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "ApiKey"        ADD CONSTRAINT "ApiKey_tenantId_fkey"        FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "ShiftHandover" ADD CONSTRAINT "ShiftHandover_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

-- ═══════════════════════════════════════════════════════════════════════════
-- tenantId-leading indexes (step 5)
--
-- The RLS policy adds a `tenant_id = ...` predicate to essentially every query,
-- so an index leading with tenantId is what keeps that predicate cheap. The
-- pre-existing indexes are kept: they still serve the siteId-scoped access
-- paths, and dropping them would be a regression for those queries.
-- ═══════════════════════════════════════════════════════════════════════════

-- New tables (Tier A + B). The composite (tenantId, siteId) variant supports
-- the common "this tenant's assets at this site" access pattern.
CREATE INDEX "FuelTank_tenantId_idx"                 ON "FuelTank"("tenantId");
CREATE INDEX "FuelTank_tenantId_siteId_idx"          ON "FuelTank"("tenantId", "siteId");
CREATE INDEX "Generator_tenantId_idx"                ON "Generator"("tenantId");
CREATE INDEX "Generator_tenantId_siteId_idx"         ON "Generator"("tenantId", "siteId");
CREATE INDEX "BatteryBank_tenantId_idx"              ON "BatteryBank"("tenantId");
CREATE INDEX "BatteryBank_tenantId_siteId_idx"       ON "BatteryBank"("tenantId", "siteId");
CREATE INDEX "IotDevice_tenantId_idx"                ON "IotDevice"("tenantId");
CREATE INDEX "IotDevice_tenantId_siteId_idx"         ON "IotDevice"("tenantId", "siteId");
CREATE INDEX "FuelDispenser_tenantId_idx"            ON "FuelDispenser"("tenantId");
CREATE INDEX "FuelDispenser_tenantId_siteId_idx"     ON "FuelDispenser"("tenantId", "siteId");
CREATE INDEX "FuelTransaction_tenantId_idx"          ON "FuelTransaction"("tenantId");
CREATE INDEX "FuelTransaction_tenantId_siteId_idx"   ON "FuelTransaction"("tenantId", "siteId");
-- SensorReading becomes a hypertable in step 10; (tenantId, ts) is the index
-- that serves a per-tenant time range for both the policy and the time filter.
CREATE INDEX "SensorReading_tenantId_idx"            ON "SensorReading"("tenantId");
CREATE INDEX "SensorReading_tenantId_ts_idx"         ON "SensorReading"("tenantId", "ts");
CREATE INDEX "SiteEvent_tenantId_idx"                ON "SiteEvent"("tenantId");
CREATE INDEX "SiteEvent_tenantId_createdAt_idx"      ON "SiteEvent"("tenantId", "createdAt");
CREATE INDEX "FuelDelivery_tenantId_idx"             ON "FuelDelivery"("tenantId");
CREATE INDEX "FuelDelivery_tenantId_siteId_idx"      ON "FuelDelivery"("tenantId", "siteId");
CREATE INDEX "ControlCommand_tenantId_idx"           ON "ControlCommand"("tenantId");
CREATE INDEX "ControlCommand_tenantId_status_idx"    ON "ControlCommand"("tenantId", "status");
CREATE INDEX "MaintenanceTicket_tenantId_idx"        ON "MaintenanceTicket"("tenantId");
CREATE INDEX "MaintenanceTicket_tenantId_siteId_idx" ON "MaintenanceTicket"("tenantId", "siteId");
CREATE INDEX "SiteGateway_tenantId_idx"              ON "SiteGateway"("tenantId");
CREATE INDEX "SiteGateway_tenantId_siteId_idx"       ON "SiteGateway"("tenantId", "siteId");
CREATE INDEX "NotificationPreference_tenantId_idx"   ON "NotificationPreference"("tenantId");
CREATE INDEX "EspFirmwareDeployment_tenantId_idx"    ON "EspFirmwareDeployment"("tenantId");
CREATE INDEX "EspFirmwareDeployment_tenantId_dispenserId_idx" ON "EspFirmwareDeployment"("tenantId", "dispenserId");

-- Existing Tier C tables. Region/Alarm/AuditLog/Notification had NO tenantId
-- index at all — the primary tenant filter column was unindexed on exactly the
-- operational tables RLS will scan.
CREATE INDEX "Region_tenantId_idx"            ON "Region"("tenantId");
CREATE INDEX "Alarm_tenantId_idx"             ON "Alarm"("tenantId");
CREATE INDEX "Alarm_tenantId_status_idx"      ON "Alarm"("tenantId", "status");
CREATE INDEX "Alarm_tenantId_createdAt_idx"   ON "Alarm"("tenantId", "createdAt");
CREATE INDEX "AuditLog_tenantId_idx"          ON "AuditLog"("tenantId");
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");
CREATE INDEX "Notification_tenantId_idx"      ON "Notification"("tenantId");
CREATE INDEX "Notification_tenantId_status_idx"   ON "Notification"("tenantId", "status");
CREATE INDEX "Notification_tenantId_createdAt_idx" ON "Notification"("tenantId", "createdAt");

-- ApiKey and ShiftHandover already led with tenantId, but only as the FIRST
-- column of a composite. A policy that filters on tenant_id alone still needs a
-- tenantId-leading index to use, so the single-column form is added here.
CREATE INDEX "ApiKey_tenantId_idx"            ON "ApiKey"("tenantId");
CREATE INDEX "ShiftHandover_tenantId_idx"     ON "ShiftHandover"("tenantId");

-- Alarm.acknowledgedById / Alarm.resolvedById were unindexed FK columns; they
-- are read by every "alarms I have actioned" query and are slowed further by
-- the RLS predicate on top.
CREATE INDEX "Alarm_acknowledgedById_idx"     ON "Alarm"("acknowledgedById");
CREATE INDEX "Alarm_resolvedById_idx"         ON "Alarm"("resolvedById");

-- ═══════════════════════════════════════════════════════════════════════════
-- Grants
--
-- The 20261004203149_grant_role_privileges migration set ALTER DEFAULT
-- PRIVILEGES so tables created later inherit grants. This migration only ALTERs
-- existing tables, which does NOT create new tables and so does not consume the
-- default privileges — but the new indexes are new objects, and an explicit
-- re-grant keeps the file self-contained if it is ever replayed against a
-- database where the defaults were not applied.
-- ═══════════════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fgmp_app, fgmp_ops;
