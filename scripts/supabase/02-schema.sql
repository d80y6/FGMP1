-- ═══════════════════════════════════════════════════════════════════════════
-- FGMP — schema and Prisma bookkeeping for a fresh database
--
-- GENERATED FILE — do not edit. Run scripts/supabase/build-schema-sql.ts after
-- adding a migration:
--     bun run scripts/supabase/build-schema-sql.ts
--
-- WHAT IT DOES
--   1. refuses to run if the FGMP schema is already present (it is not
--      idempotent, exactly like `prisma migrate deploy` on a fresh database);
--   2. switches to the fgmp_migrate role, so every table is OWNED by the
--      migration role rather than by `postgres` — ownership is load-bearing:
--      FORCE ROW LEVEL SECURITY binds the owner too, and a later
--      `prisma migrate deploy` run as fgmp_migrate must be able to ALTER these
--      tables;
--   3. applies every migration in `prisma/migrations`, in order;
--   4. records them in `_prisma_migrations` with Prisma's own checksums, so a
--      future `prisma migrate deploy` sees them as already applied.
--
-- PREREQUISITES: 01-roles.sql has been run in THIS database, and the connected
-- role is a superuser (the Supabase SQL editor runs as `postgres`), because
-- `set role fgmp_migrate` requires the privilege to assume that role.
--
-- If any statement fails, nothing after it is applied. On a failure, drop and
-- recreate the database, fix the cause, and run this file again from the top:
-- a half-applied schema is not a state `prisma migrate deploy` can repair.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Guard: this script creates the schema, it does not upgrade one ─────────
do $$
begin
  if exists (
    select 1 from pg_tables
     where schemaname = 'public' and tablename = 'Tenant'
  ) then
    raise exception
      'The FGMP schema already exists in this database. This file applies migrations to a fresh database. To upgrade an existing one use: FGMP_MIGRATE_DATABASE_URL=... bunx prisma migrate deploy';
  end if;
end $$;

-- ── Everything below is created BY fgmp_migrate, not by the connected role ─
set role fgmp_migrate;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261004203148_init_postgres_baseline
-- ─────────────────────────────────────────────────────────────────────────────
-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'NOC_OPERATOR',
    "phone" TEXT,
    "passwordHash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Governorate" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Governorate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "District" (
    "id" TEXT NOT NULL,
    "governorateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "District_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "governorateId" TEXT NOT NULL,
    "districtId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "address" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ONLINE',
    "criticality" TEXT NOT NULL DEFAULT 'MEDIUM',
    "loadKw" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "powerSource" TEXT NOT NULL DEFAULT 'HYBRID',
    "gridAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelTank" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fuelType" TEXT NOT NULL DEFAULT 'DIESEL',
    "capacityLitres" DOUBLE PRECISION NOT NULL,
    "currentLitres" DOUBLE PRECISION NOT NULL,
    "calibration" TEXT NOT NULL,
    "lowThreshold" DOUBLE PRECISION NOT NULL,
    "criticalThreshold" DOUBLE PRECISION NOT NULL,
    "lastReadingAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPERATIONAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FuelTank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Generator" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "ratedPowerKw" DOUBLE PRECISION NOT NULL,
    "fuelType" TEXT NOT NULL DEFAULT 'DIESEL',
    "status" TEXT NOT NULL DEFAULT 'STOPPED',
    "mode" TEXT NOT NULL DEFAULT 'AUTO',
    "runtimeHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "oilChangeIntervalHrs" DOUBLE PRECISION NOT NULL DEFAULT 250,
    "lastOilChangeHrs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "nextMaintenanceHrs" DOUBLE PRECISION NOT NULL DEFAULT 250,
    "temperatureC" DOUBLE PRECISION NOT NULL DEFAULT 65,
    "oilPressureKpa" DOUBLE PRECISION NOT NULL DEFAULT 320,
    "loadKw" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fuelRateLph" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "batteryVoltage" DOUBLE PRECISION NOT NULL DEFAULT 24,
    "lastStartedAt" TIMESTAMP(3),
    "lastStoppedAt" TIMESTAMP(3),
    "lastReadingAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Generator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatteryBank" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "chemistry" TEXT NOT NULL DEFAULT 'VRLA',
    "capacityAh" DOUBLE PRECISION NOT NULL,
    "nominalVoltage" DOUBLE PRECISION NOT NULL DEFAULT 48,
    "voltage" DOUBLE PRECISION NOT NULL DEFAULT 48,
    "currentA" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stateOfCharge" DOUBLE PRECISION NOT NULL DEFAULT 80,
    "stateOfHealth" DOUBLE PRECISION NOT NULL DEFAULT 95,
    "temperatureC" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "charging" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadingAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BatteryBank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IotDevice" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "serialNo" TEXT NOT NULL,
    "firmware" TEXT NOT NULL,
    "ipAddress" TEXT,
    "modbusUnit" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ONLINE',
    "lastSeenAt" TIMESTAMP(3),
    "signalRssi" INTEGER NOT NULL DEFAULT -70,
    "otaTargetFw" TEXT,
    "otaStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IotDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelDispenser" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "nozzleCount" INTEGER NOT NULL DEFAULT 1,
    "fuelType" TEXT NOT NULL DEFAULT 'DIESEL',
    "maxFlowLpm" DOUBLE PRECISION NOT NULL DEFAULT 40,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "mode" TEXT NOT NULL DEFAULT 'AUTO',
    "pumpNumber" INTEGER NOT NULL DEFAULT 1,
    "espDeviceId" TEXT NOT NULL,
    "espFirmware" TEXT NOT NULL DEFAULT 'v1.0.0',
    "rs485Baudrate" INTEGER NOT NULL DEFAULT 9600,
    "rs485Address" INTEGER NOT NULL DEFAULT 1,
    "rs485Parity" TEXT NOT NULL DEFAULT '8N1',
    "wifiRssi" INTEGER NOT NULL DEFAULT -65,
    "ipAddress" TEXT,
    "lastCommAt" TIMESTAMP(3),
    "currentVolumeLitres" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "presetVolumeLitres" DOUBLE PRECISION,
    "flowRateLpm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalizerLitres" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentTransactionId" TEXT,
    "lastTransactionAt" TIMESTAMP(3),
    "tempC" DOUBLE PRECISION NOT NULL DEFAULT 35,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FuelDispenser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelTransaction" (
    "id" TEXT NOT NULL,
    "dispenserId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "nozzle" INTEGER NOT NULL DEFAULT 1,
    "volumeLitres" DOUBLE PRECISION NOT NULL,
    "amountYer" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitPriceYer" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "vehiclePlate" TEXT,
    "operatorName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FuelTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SensorReading" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "entityKind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alarm" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'L1',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "escalationLevel" INTEGER NOT NULL DEFAULT 1,
    "entityKind" TEXT,
    "entityId" TEXT,
    "message" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,

    CONSTRAINT "Alarm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteEvent" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "meta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelDelivery" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "tankId" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "driverName" TEXT,
    "vehiclePlate" TEXT,
    "volumeOrderedLitres" DOUBLE PRECISION NOT NULL,
    "volumeDeliveredLitres" DOUBLE PRECISION,
    "doNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "discrepancyNote" TEXT,
    "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FuelDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ControlCommand" (
    "id" TEXT NOT NULL,
    "generatorId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),
    "result" TEXT,

    CONSTRAINT "ControlCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceTicket" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "assetKind" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'P3',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assignedToId" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "details" TEXT NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "alarmId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlarmSuppression" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT,
    "alarmType" TEXT,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlarmSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "inAppSeverities" TEXT NOT NULL DEFAULT 'L1,L2,L3',
    "emailSeverities" TEXT NOT NULL DEFAULT 'L2,L3',
    "smsSeverities" TEXT NOT NULL DEFAULT 'L3',
    "quietHoursStart" INTEGER,
    "quietHoursEnd" INTEGER,
    "emailOverride" TEXT,
    "phoneOverride" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'read',
    "ipAllowlist" TEXT,
    "createdBy" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftHandover" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "shift" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'P3',
    "notes" TEXT NOT NULL,
    "ongoingIssues" TEXT,
    "flaggedSiteIds" TEXT,
    "openAlarmsCount" INTEGER NOT NULL DEFAULT 0,
    "criticalSitesCount" INTEGER NOT NULL DEFAULT 0,
    "avgFuelPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftHandover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'string',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteGateway" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "model" TEXT,
    "ipAddress" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ONLINE',
    "uptimeSec" INTEGER NOT NULL DEFAULT 0,
    "cpuTempC" DOUBLE PRECISION NOT NULL DEFAULT 45,
    "heapKb" INTEGER NOT NULL DEFAULT 0,
    "wifiRssi" INTEGER NOT NULL DEFAULT -65,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteGateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EspFirmwareRelease" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "checksum" TEXT NOT NULL,
    "sizeKb" INTEGER NOT NULL,
    "releaseNotes" TEXT NOT NULL DEFAULT '',
    "releasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EspFirmwareRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EspFirmwareDeployment" (
    "id" TEXT NOT NULL,
    "dispenserId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "initiatedById" TEXT,

    CONSTRAINT "EspFirmwareDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "note" TEXT,
    "createdById" TEXT,
    "restoredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMP(3),

    CONSTRAINT "BackupRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_name_key" ON "Tenant"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_code_key" ON "Tenant"("code");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Region_tenantId_name_key" ON "Region"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Governorate_regionId_name_key" ON "Governorate"("regionId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "District_governorateId_name_key" ON "District"("governorateId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Site_code_key" ON "Site"("code");

-- CreateIndex
CREATE INDEX "Site_tenantId_idx" ON "Site"("tenantId");

-- CreateIndex
CREATE INDEX "Site_regionId_idx" ON "Site"("regionId");

-- CreateIndex
CREATE INDEX "Site_governorateId_idx" ON "Site"("governorateId");

-- CreateIndex
CREATE INDEX "Site_districtId_idx" ON "Site"("districtId");

-- CreateIndex
CREATE INDEX "FuelTank_siteId_idx" ON "FuelTank"("siteId");

-- CreateIndex
CREATE INDEX "Generator_siteId_idx" ON "Generator"("siteId");

-- CreateIndex
CREATE INDEX "BatteryBank_siteId_idx" ON "BatteryBank"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "IotDevice_serialNo_key" ON "IotDevice"("serialNo");

-- CreateIndex
CREATE INDEX "IotDevice_siteId_idx" ON "IotDevice"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "FuelDispenser_espDeviceId_key" ON "FuelDispenser"("espDeviceId");

-- CreateIndex
CREATE INDEX "FuelDispenser_siteId_idx" ON "FuelDispenser"("siteId");

-- CreateIndex
CREATE INDEX "FuelDispenser_status_idx" ON "FuelDispenser"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FuelDispenser_siteId_pumpNumber_key" ON "FuelDispenser"("siteId", "pumpNumber");

-- CreateIndex
CREATE INDEX "FuelTransaction_dispenserId_startedAt_idx" ON "FuelTransaction"("dispenserId", "startedAt");

-- CreateIndex
CREATE INDEX "FuelTransaction_siteId_startedAt_idx" ON "FuelTransaction"("siteId", "startedAt");

-- CreateIndex
CREATE INDEX "FuelTransaction_status_idx" ON "FuelTransaction"("status");

-- CreateIndex
CREATE INDEX "SensorReading_siteId_ts_idx" ON "SensorReading"("siteId", "ts");

-- CreateIndex
CREATE INDEX "SensorReading_entityId_metric_ts_idx" ON "SensorReading"("entityId", "metric", "ts");

-- CreateIndex
CREATE INDEX "Alarm_siteId_status_idx" ON "Alarm"("siteId", "status");

-- CreateIndex
CREATE INDEX "Alarm_status_severity_idx" ON "Alarm"("status", "severity");

-- CreateIndex
CREATE INDEX "Alarm_createdAt_idx" ON "Alarm"("createdAt");

-- CreateIndex
CREATE INDEX "SiteEvent_siteId_createdAt_idx" ON "SiteEvent"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "FuelDelivery_siteId_status_idx" ON "FuelDelivery"("siteId", "status");

-- CreateIndex
CREATE INDEX "FuelDelivery_scheduledAt_idx" ON "FuelDelivery"("scheduledAt");

-- CreateIndex
CREATE INDEX "ControlCommand_generatorId_status_idx" ON "ControlCommand"("generatorId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceTicket_siteId_status_idx" ON "MaintenanceTicket"("siteId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceTicket_status_priority_idx" ON "MaintenanceTicket"("status", "priority");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "Notification_status_idx" ON "Notification"("status");

-- CreateIndex
CREATE INDEX "AlarmSuppression_tenantId_isActive_endsAt_idx" ON "AlarmSuppression"("tenantId", "isActive", "endsAt");

-- CreateIndex
CREATE INDEX "AlarmSuppression_siteId_idx" ON "AlarmSuppression"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_revoked_idx" ON "ApiKey"("tenantId", "revoked");

-- CreateIndex
CREATE INDEX "ApiKey_keyHash_idx" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ShiftHandover_tenantId_createdAt_idx" ON "ShiftHandover"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ShiftHandover_tenantId_status_idx" ON "ShiftHandover"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ShiftHandover_shift_status_idx" ON "ShiftHandover"("shift", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");

-- CreateIndex
CREATE INDEX "SystemSetting_category_idx" ON "SystemSetting"("category");

-- CreateIndex
CREATE INDEX "SiteGateway_siteId_idx" ON "SiteGateway"("siteId");

-- CreateIndex
CREATE INDEX "SiteGateway_status_idx" ON "SiteGateway"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EspFirmwareRelease_version_key" ON "EspFirmwareRelease"("version");

-- CreateIndex
CREATE INDEX "EspFirmwareRelease_channel_idx" ON "EspFirmwareRelease"("channel");

-- CreateIndex
CREATE INDEX "EspFirmwareRelease_releasedAt_idx" ON "EspFirmwareRelease"("releasedAt");

-- CreateIndex
CREATE INDEX "EspFirmwareDeployment_dispenserId_idx" ON "EspFirmwareDeployment"("dispenserId");

-- CreateIndex
CREATE INDEX "EspFirmwareDeployment_status_idx" ON "EspFirmwareDeployment"("status");

-- CreateIndex
CREATE INDEX "EspFirmwareDeployment_startedAt_idx" ON "EspFirmwareDeployment"("startedAt");

-- CreateIndex
CREATE INDEX "BackupRecord_tenantId_createdAt_idx" ON "BackupRecord"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "BackupRecord_status_idx" ON "BackupRecord"("status");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Governorate" ADD CONSTRAINT "Governorate_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "District" ADD CONSTRAINT "District_governorateId_fkey" FOREIGN KEY ("governorateId") REFERENCES "Governorate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_governorateId_fkey" FOREIGN KEY ("governorateId") REFERENCES "Governorate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelTank" ADD CONSTRAINT "FuelTank_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Generator" ADD CONSTRAINT "Generator_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatteryBank" ADD CONSTRAINT "BatteryBank_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IotDevice" ADD CONSTRAINT "IotDevice_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelDispenser" ADD CONSTRAINT "FuelDispenser_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelTransaction" ADD CONSTRAINT "FuelTransaction_dispenserId_fkey" FOREIGN KEY ("dispenserId") REFERENCES "FuelDispenser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelTransaction" ADD CONSTRAINT "FuelTransaction_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alarm" ADD CONSTRAINT "Alarm_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alarm" ADD CONSTRAINT "Alarm_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alarm" ADD CONSTRAINT "Alarm_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteEvent" ADD CONSTRAINT "SiteEvent_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelDelivery" ADD CONSTRAINT "FuelDelivery_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelDelivery" ADD CONSTRAINT "FuelDelivery_tankId_fkey" FOREIGN KEY ("tankId") REFERENCES "FuelTank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlCommand" ADD CONSTRAINT "ControlCommand_generatorId_fkey" FOREIGN KEY ("generatorId") REFERENCES "Generator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlCommand" ADD CONSTRAINT "ControlCommand_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceTicket" ADD CONSTRAINT "MaintenanceTicket_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceTicket" ADD CONSTRAINT "MaintenanceTicket_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmSuppression" ADD CONSTRAINT "AlarmSuppression_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmSuppression" ADD CONSTRAINT "AlarmSuppression_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmSuppression" ADD CONSTRAINT "AlarmSuppression_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteGateway" ADD CONSTRAINT "SiteGateway_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EspFirmwareDeployment" ADD CONSTRAINT "EspFirmwareDeployment_dispenserId_fkey" FOREIGN KEY ("dispenserId") REFERENCES "FuelDispenser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EspFirmwareDeployment" ADD CONSTRAINT "EspFirmwareDeployment_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "EspFirmwareRelease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EspFirmwareDeployment" ADD CONSTRAINT "EspFirmwareDeployment_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupRecord" ADD CONSTRAINT "BackupRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupRecord" ADD CONSTRAINT "BackupRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupRecord" ADD CONSTRAINT "BackupRecord_restoredById_fkey" FOREIGN KEY ("restoredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261004203149_grant_role_privileges
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1 step 8 (part): grant table privileges to the three roles.
--
-- Runs immediately after the baseline schema migration. The roles themselves
-- are created by scripts/db/pg-init-roles.sh on first database initialisation,
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261005000000_add_tenant_id_not_null_fk
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261005000100_enums_and_decimal
-- ─────────────────────────────────────────────────────────────────────────────
/*
  Warnings:

  - The `severity` column on the `Alarm` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `Alarm` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `BatteryBank` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `ControlCommand` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `EspFirmwareDeployment` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `FuelDelivery` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to alter the column `unitPrice` on the `FuelDelivery` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(65,30)`.
  - The `fuelType` column on the `FuelDispenser` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `FuelDispenser` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `fuelType` column on the `FuelTank` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `FuelTank` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to alter the column `amountYer` on the `FuelTransaction` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(65,30)`.
  - You are about to alter the column `unitPriceYer` on the `FuelTransaction` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(65,30)`.
  - The `status` column on the `FuelTransaction` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `Generator` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `mode` column on the `Generator` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `IotDevice` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `MaintenanceTicket` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `priority` column on the `MaintenanceTicket` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `Notification` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `Site` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `criticality` column on the `Site` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `powerSource` column on the `Site` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `SiteGateway` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `role` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `type` on the `Alarm` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `command` on the `ControlCommand` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `protocol` on the `IotDevice` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `channel` on the `Notification` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `entityKind` on the `SensorReading` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `category` on the `SystemSetting` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPERADMIN', 'ADMIN', 'NOC_OPERATOR', 'REGIONAL_MANAGER', 'FIELD_ENGINEER', 'EXECUTIVE', 'READONLY');

-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('ONLINE', 'DEGRADED', 'OFFLINE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "Criticality" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "PowerSource" AS ENUM ('GRID', 'GENERATOR', 'HYBRID');

-- CreateEnum
CREATE TYPE "TankStatus" AS ENUM ('OPERATIONAL', 'EMPTY', 'MAINTENANCE', 'CALIBRATING');

-- CreateEnum
CREATE TYPE "FuelType" AS ENUM ('DIESEL', 'PETROL');

-- CreateEnum
CREATE TYPE "GenStatus" AS ENUM ('RUNNING', 'STOPPED', 'FAULT', 'MAINTENANCE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "GenMode" AS ENUM ('AUTO', 'MANUAL', 'REMOTE');

-- CreateEnum
CREATE TYPE "GenCommandType" AS ENUM ('START', 'STOP', 'EMERGENCY_STOP', 'RESET');

-- CreateEnum
CREATE TYPE "BatteryStatus" AS ENUM ('OK', 'LOW', 'FAILING', 'REPLACEMENT_DUE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "EntityKind" AS ENUM ('TANK', 'GENERATOR', 'BATTERY', 'SITE', 'DISPENSER');

-- CreateEnum
CREATE TYPE "IotProtocol" AS ENUM ('RS485', 'MODBUS_RTU', 'MODBUS_TCP', 'MQTT', 'HTTP', 'SNMP');

-- CreateEnum
CREATE TYPE "IotStatus" AS ENUM ('ONLINE', 'OFFLINE', 'DEGRADED', 'PROVISIONING');

-- CreateEnum
CREATE TYPE "DispenserStatus" AS ENUM ('IDLE', 'AUTHORIZED', 'DISPENSING', 'STOPPED', 'FAULT', 'MAINTENANCE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "FuelTransactionStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "AlarmType" AS ENUM ('FUEL_THEFT', 'FUEL_REFILL', 'FUEL_LOW', 'FUEL_CRITICAL', 'GEN_OFFLINE', 'GEN_FAILURE', 'GEN_OVERHEAT', 'BATT_LOW_VOLTAGE', 'BATT_FAILURE', 'COMM_LOSS', 'DISPENSER_FAULT');

-- CreateEnum
CREATE TYPE "AlarmSeverity" AS ENUM ('L1', 'L2', 'L3');

-- CreateEnum
CREATE TYPE "AlarmStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "FuelDeliveryStatus" AS ENUM ('SCHEDULED', 'IN_TRANSIT', 'DELIVERED', 'VERIFIED', 'DISCREPANCY', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ControlCommandStatus" AS ENUM ('PENDING', 'SENT', 'EXECUTED', 'FAILED', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('P1', 'P2', 'P3', 'P4');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'SCHEDULED', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'PUSH', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "SystemSettingCategory" AS ENUM ('ALARM', 'ESCALATION', 'BRANDING', 'PLATFORM', 'FORECAST');

-- CreateEnum
CREATE TYPE "GatewayStatus" AS ENUM ('ONLINE', 'OFFLINE', 'DEGRADED');

-- CreateEnum
CREATE TYPE "OtaStatus" AS ENUM ('QUEUED', 'IDLE', 'PENDING', 'DOWNLOADING', 'FLASHING', 'SUCCESS', 'FAILED', 'ROLLED_BACK');

-- AlterTable
ALTER TABLE "Alarm" DROP COLUMN "type",
ADD COLUMN     "type" "AlarmType" NOT NULL,
DROP COLUMN "severity",
ADD COLUMN     "severity" "AlarmSeverity" NOT NULL DEFAULT 'L1',
DROP COLUMN "status",
ADD COLUMN     "status" "AlarmStatus" NOT NULL DEFAULT 'OPEN';

-- AlterTable
ALTER TABLE "BatteryBank" DROP COLUMN "status",
ADD COLUMN     "status" "BatteryStatus" NOT NULL DEFAULT 'OK';

-- AlterTable
ALTER TABLE "ControlCommand" DROP COLUMN "command",
ADD COLUMN     "command" "GenCommandType" NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "ControlCommandStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "EspFirmwareDeployment" DROP COLUMN "status",
ADD COLUMN     "status" "OtaStatus" NOT NULL DEFAULT 'QUEUED';

-- AlterTable
ALTER TABLE "FuelDelivery" DROP COLUMN "status",
ADD COLUMN     "status" "FuelDeliveryStatus" NOT NULL DEFAULT 'SCHEDULED',
ALTER COLUMN "unitPrice" SET DATA TYPE DECIMAL(65,30);

-- AlterTable
ALTER TABLE "FuelDispenser" DROP COLUMN "fuelType",
ADD COLUMN     "fuelType" "FuelType" NOT NULL DEFAULT 'DIESEL',
DROP COLUMN "status",
ADD COLUMN     "status" "DispenserStatus" NOT NULL DEFAULT 'IDLE';

-- AlterTable
ALTER TABLE "FuelTank" DROP COLUMN "fuelType",
ADD COLUMN     "fuelType" "FuelType" NOT NULL DEFAULT 'DIESEL',
DROP COLUMN "status",
ADD COLUMN     "status" "TankStatus" NOT NULL DEFAULT 'OPERATIONAL';

-- AlterTable
ALTER TABLE "FuelTransaction" ALTER COLUMN "amountYer" SET DATA TYPE DECIMAL(65,30),
ALTER COLUMN "unitPriceYer" SET DATA TYPE DECIMAL(65,30),
DROP COLUMN "status",
ADD COLUMN     "status" "FuelTransactionStatus" NOT NULL DEFAULT 'COMPLETED';

-- AlterTable
ALTER TABLE "Generator" DROP COLUMN "status",
ADD COLUMN     "status" "GenStatus" NOT NULL DEFAULT 'STOPPED',
DROP COLUMN "mode",
ADD COLUMN     "mode" "GenMode" NOT NULL DEFAULT 'AUTO';

-- AlterTable
ALTER TABLE "IotDevice" DROP COLUMN "protocol",
ADD COLUMN     "protocol" "IotProtocol" NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "IotStatus" NOT NULL DEFAULT 'ONLINE';

-- AlterTable
ALTER TABLE "MaintenanceTicket" DROP COLUMN "status",
ADD COLUMN     "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
DROP COLUMN "priority",
ADD COLUMN     "priority" "TicketPriority" NOT NULL DEFAULT 'P3';

-- AlterTable
ALTER TABLE "Notification" DROP COLUMN "channel",
ADD COLUMN     "channel" "NotificationChannel" NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED';

-- AlterTable
ALTER TABLE "SensorReading" DROP COLUMN "entityKind",
ADD COLUMN     "entityKind" "EntityKind" NOT NULL;

-- AlterTable
ALTER TABLE "Site" DROP COLUMN "status",
ADD COLUMN     "status" "SiteStatus" NOT NULL DEFAULT 'ONLINE',
DROP COLUMN "criticality",
ADD COLUMN     "criticality" "Criticality" NOT NULL DEFAULT 'MEDIUM',
DROP COLUMN "powerSource",
ADD COLUMN     "powerSource" "PowerSource" NOT NULL DEFAULT 'HYBRID';

-- AlterTable
ALTER TABLE "SiteGateway" DROP COLUMN "status",
ADD COLUMN     "status" "GatewayStatus" NOT NULL DEFAULT 'ONLINE';

-- AlterTable
ALTER TABLE "SystemSetting" DROP COLUMN "category",
ADD COLUMN     "category" "SystemSettingCategory" NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "role" "Role" NOT NULL DEFAULT 'NOC_OPERATOR';

-- CreateIndex
CREATE INDEX "Alarm_tenantId_status_idx" ON "Alarm"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Alarm_siteId_status_idx" ON "Alarm"("siteId", "status");

-- CreateIndex
CREATE INDEX "Alarm_status_severity_idx" ON "Alarm"("status", "severity");

-- CreateIndex
CREATE INDEX "ControlCommand_tenantId_status_idx" ON "ControlCommand"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ControlCommand_generatorId_status_idx" ON "ControlCommand"("generatorId", "status");

-- CreateIndex
CREATE INDEX "EspFirmwareDeployment_status_idx" ON "EspFirmwareDeployment"("status");

-- CreateIndex
CREATE INDEX "FuelDelivery_siteId_status_idx" ON "FuelDelivery"("siteId", "status");

-- CreateIndex
CREATE INDEX "FuelDispenser_status_idx" ON "FuelDispenser"("status");

-- CreateIndex
CREATE INDEX "FuelTransaction_status_idx" ON "FuelTransaction"("status");

-- CreateIndex
CREATE INDEX "MaintenanceTicket_siteId_status_idx" ON "MaintenanceTicket"("siteId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceTicket_status_priority_idx" ON "MaintenanceTicket"("status", "priority");

-- CreateIndex
CREATE INDEX "Notification_tenantId_status_idx" ON "Notification"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Notification_status_idx" ON "Notification"("status");

-- CreateIndex
CREATE INDEX "SiteGateway_status_idx" ON "SiteGateway"("status");

-- CreateIndex
CREATE INDEX "SystemSetting_category_idx" ON "SystemSetting"("category");

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261005000200_fuel_type_add_biofuel
-- ─────────────────────────────────────────────────────────────────────────────
-- AlterEnum
ALTER TYPE "FuelType" ADD VALUE 'BIOFUEL';

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261005000300_enable_rls
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261006000000_device_protocol
-- ─────────────────────────────────────────────────────────────────────────────
-- CreateTable
CREATE TABLE "Rs485Bus" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "siteId" TEXT,
    "baudrate" INTEGER NOT NULL DEFAULT 9600,
    "unitAddress" INTEGER NOT NULL DEFAULT 1,
    "parity" TEXT NOT NULL DEFAULT '8N1',
    "stopBits" INTEGER NOT NULL DEFAULT 1,
    "dataBits" INTEGER NOT NULL DEFAULT 8,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "lastPollAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rs485Bus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rs485BusDiagnostic" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "busId" TEXT NOT NULL,
    "unitAddress" INTEGER NOT NULL,
    "deviceKind" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "crcErrors" INTEGER NOT NULL DEFAULT 0,
    "timeouts" INTEGER NOT NULL DEFAULT 0,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "retriesExhausted" INTEGER NOT NULL DEFAULT 0,
    "exceptionResponses" INTEGER NOT NULL DEFAULT 0,
    "successfulReads" INTEGER NOT NULL DEFAULT 0,
    "failedReads" INTEGER NOT NULL DEFAULT 0,
    "lastLatencyMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "averageLatencyMs" DOUBLE PRECISION,
    "lastPollAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rs485BusDiagnostic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rs485LatencySample" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "diagnosticId" TEXT NOT NULL,
    "unitAddress" INTEGER NOT NULL,
    "latencyMs" DOUBLE PRECISION NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rs485LatencySample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Rs485Bus_tenantId_idx" ON "Rs485Bus"("tenantId");

-- CreateIndex
CREATE INDEX "Rs485Bus_siteId_idx" ON "Rs485Bus"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Rs485Bus_tenantId_unitAddress_key" ON "Rs485Bus"("tenantId", "unitAddress");

-- CreateIndex
CREATE INDEX "Rs485BusDiagnostic_tenantId_idx" ON "Rs485BusDiagnostic"("tenantId");

-- CreateIndex
CREATE INDEX "Rs485BusDiagnostic_deviceKind_deviceId_idx" ON "Rs485BusDiagnostic"("deviceKind", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Rs485BusDiagnostic_busId_unitAddress_key" ON "Rs485BusDiagnostic"("busId", "unitAddress");

-- CreateIndex
CREATE INDEX "Rs485LatencySample_tenantId_recordedAt_idx" ON "Rs485LatencySample"("tenantId", "recordedAt");

-- CreateIndex
CREATE INDEX "Rs485LatencySample_diagnosticId_recordedAt_idx" ON "Rs485LatencySample"("diagnosticId", "recordedAt");

-- AddForeignKey
ALTER TABLE "Rs485Bus" ADD CONSTRAINT "Rs485Bus_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rs485Bus" ADD CONSTRAINT "Rs485Bus_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rs485BusDiagnostic" ADD CONSTRAINT "Rs485BusDiagnostic_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rs485BusDiagnostic" ADD CONSTRAINT "Rs485BusDiagnostic_busId_fkey" FOREIGN KEY ("busId") REFERENCES "Rs485Bus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rs485LatencySample" ADD CONSTRAINT "Rs485LatencySample_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rs485LatencySample" ADD CONSTRAINT "Rs485LatencySample_diagnosticId_fkey" FOREIGN KEY ("diagnosticId") REFERENCES "Rs485BusDiagnostic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Phase 2: RLS on the new bus-diagnostics tables ────────────────────────
-- These three tables carry "tenantId", so they are subject to the same backstop
-- as the other 24. Omitting this would leave the bus diagnostics — which record
-- per-device latency and error counts — readable across tenants, and the RLS
-- regression suite would (correctly) fail.
--
-- The column is quoted camelCase "tenantId" to match the rest of this schema;
-- the GUC stays 'app.tenant_id'. FORCE is required: without it the table owner
-- bypasses RLS, which would make the policy decorative for exactly the role a
-- misconfigured connection string is most likely to use.

-- Rs485Bus
ALTER TABLE "Rs485Bus" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Rs485Bus" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Rs485Bus";
CREATE POLICY tenant_isolation ON "Rs485Bus"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Rs485BusDiagnostic
ALTER TABLE "Rs485BusDiagnostic" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Rs485BusDiagnostic" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Rs485BusDiagnostic";
CREATE POLICY tenant_isolation ON "Rs485BusDiagnostic"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Rs485LatencySample
ALTER TABLE "Rs485LatencySample" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Rs485LatencySample" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Rs485LatencySample";
CREATE POLICY tenant_isolation ON "Rs485LatencySample"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Grant the app role DML, matching the 20261004203149 grant migration. Without
-- this the new tables would exist but be invisible to the application, and the
-- failure would surface as "permission denied" rather than as a missing feature.
GRANT SELECT, INSERT, UPDATE, DELETE ON "Rs485Bus" TO fgmp_app, fgmp_ops;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Rs485BusDiagnostic" TO fgmp_app, fgmp_ops;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Rs485LatencySample" TO fgmp_app, fgmp_ops;

-- Verification: 27 tables should now carry relrowsecurity AND relforcerowsecurity.
SELECT count(*) AS rls_tables
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relrowsecurity AND c.relforcerowsecurity;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261006001000_interlock_override
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261006002000_correlation_rules_server_side
-- ─────────────────────────────────────────────────────────────────────────────
-- CreateEnum
CREATE TYPE "RuleScope" AS ENUM ('SITE', 'REGION', 'GOVERNORATE', 'NATIONAL');

-- CreateEnum
CREATE TYPE "RuleAlarmType" AS ENUM ('ANY', 'FUEL_THEFT', 'FUEL_REFILL', 'FUEL_LOW', 'FUEL_CRITICAL', 'GEN_OFFLINE', 'GEN_FAILURE', 'GEN_OVERHEAT', 'BATT_LOW_VOLTAGE', 'BATT_FAILURE', 'COMM_LOSS', 'DISPENSER_FAULT');

-- CreateEnum
CREATE TYPE "RuleEvaluationOutcome" AS ENUM ('NOT_TRIGGERED', 'SUPPRESSED');

-- CreateTable
CREATE TABLE "CorrelationRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "alarmType" "RuleAlarmType" NOT NULL,
    "threshold" INTEGER NOT NULL DEFAULT 1,
    "windowMinutes" INTEGER NOT NULL DEFAULT 5,
    "scope" "RuleScope" NOT NULL DEFAULT 'SITE',
    "escalateTo" "AlarmSeverity" NOT NULL DEFAULT 'L2',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CorrelationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrelationMatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "scope" "RuleScope" NOT NULL,
    "scopeLabel" TEXT NOT NULL,
    "outcome" "RuleEvaluationOutcome" NOT NULL,
    "escalateTo" "AlarmSeverity" NOT NULL,
    "matchCount" INTEGER NOT NULL,
    "alarmIds" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorrelationMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CorrelationRule_tenantId_enabled_idx" ON "CorrelationRule"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "CorrelationRule_tenantId_updatedAt_idx" ON "CorrelationRule"("tenantId", "updatedAt");

-- CreateIndex
CREATE INDEX "CorrelationMatch_tenantId_evaluatedAt_idx" ON "CorrelationMatch"("tenantId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "CorrelationMatch_tenantId_scope_idx" ON "CorrelationMatch"("tenantId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "CorrelationMatch_ruleId_scopeKey_alarmIds_key" ON "CorrelationMatch"("ruleId", "scopeKey", "alarmIds");

-- AddForeignKey
ALTER TABLE "CorrelationRule" ADD CONSTRAINT "CorrelationRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrelationMatch" ADD CONSTRAINT "CorrelationMatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrelationMatch" ADD CONSTRAINT "CorrelationMatch_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "CorrelationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────────
-- Row Level Security — Phase 2 vertical 4
-- ────────────────────────────────────────────────────────────────────────────
-- Both new tables are tenant-carrying, so they get the same ENABLE + FORCE +
-- tenant_isolation treatment as the Phase 1 tables (see
-- 20261005000300_enable_rls). Skipping this is not a style question: the
-- regression suite asserts FORCE coverage on every tenant table and will
-- fail, correctly.
--
-- FORCE is required because PostgreSQL skips RLS for the table owner, and
-- fgmp_migrate owns these tables. Without it the policy binds nobody.
--
-- The predicate fails CLOSED: current_setting(..., true) is NULL when unset,
-- the comparison yields NULL, and a NULL predicate is not TRUE, so a missing
-- tenant context returns zero rows rather than every tenant's rules.
--
-- Application contract: all reads and writes go through
-- withTenant(tenantId, fn) from src/lib/fgmp/tenant-context.ts.

-- CorrelationRule
ALTER TABLE "CorrelationRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CorrelationRule" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CorrelationRule";
CREATE POLICY tenant_isolation ON "CorrelationRule"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- CorrelationMatch
ALTER TABLE "CorrelationMatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CorrelationMatch" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CorrelationMatch";
CREATE POLICY tenant_isolation ON "CorrelationMatch"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- ────────────────────────────────────────────────────────────────────────────
-- Grants to the non-owner application role
-- ────────────────────────────────────────────────────────────────────────────
-- The baseline migration granted privileges to the tables that existed at the
-- time. New tables do NOT inherit those grants: DEFAULT PRIVILEGES covers
-- objects created by the SAME role, and this migration is applied by
-- fgmp_migrate, so an explicit grant is required here or fgmp_app would fail
-- with "permission denied for table" before the policy is ever consulted.
GRANT USAGE ON SCHEMA public TO fgmp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CorrelationRule"  TO fgmp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CorrelationMatch" TO fgmp_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261007000000_geography_rls
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 3 — close the geography isolation gap.
--
-- Region, Governorate and District form a hierarchy:
--
--     Region (tenantId, RLS-protected)
--       └── Governorate (regionId)      ← NO tenantId, NO RLS
--             └── District (governorateId)  ← NO tenantId, NO RLS
--
-- So the backstop stopped at the top of the tree. Measured against the live
-- database before this migration:
--
--     fgmp_app, no tenant context   -> 36 districts, 12 governorates
--     withTenant("t-default", …)   -> 36 districts
--     withTenant("t-platform", …)   -> 36 districts
--
-- Identical counts for two unrelated tenants is the tell: nothing was
-- filtering. Tenant t-platform could enumerate 35 districts and their
-- governorates belonging to t-default.
--
-- WHY A VIEW AND NOT A DENORMALISED tenantId COLUMN
-- Adding tenantId to Governorate/District would duplicate data that is already
-- implied by the parent chain, and it could DRIFT — a district whose region
-- moved would keep a stale tenantId, which is a silent isolation failure that
-- no constraint prevents. A view derives tenancy from the same join the
-- application already relies on, so it cannot disagree with it.
--
-- SECURITY BARRIER is required, not decorative: without it the planner is free
-- to push the tenant predicate below the joins, where it would be evaluated
-- against the wrong relation and leak rows. The barrier forces the WHERE to be
-- applied to the join result.

CREATE OR REPLACE VIEW v_geography WITH (security_barrier = true) AS
  SELECT
    r.id          AS "regionId",
    r."tenantId"  AS "tenantId",
    r.name        AS "regionName",
    g.id          AS "governorateId",
    g.name        AS "governorateName",
    d.id          AS "districtId",
    d.name        AS "districtName"
  FROM "Region" r
  LEFT JOIN "Governorate" g ON g."regionId" = r.id
  LEFT JOIN "District"     d ON d."governorateId" = g.id
  WHERE r."tenantId" = current_setting('app.tenant_id', true);

COMMENT ON VIEW v_geography IS
  'Tenant-scoped geography. Replaces direct reads of Governorate/District, '
  'which carry no tenantId and therefore had no RLS. Reads are tenant-filtered '
  'through the Region chain and fail closed: current_setting returns NULL when '
  'app.tenant_id is unset, so the predicate is NULL and the WHERE keeps no rows.';

-- The app role may read the view and nothing else.
GRANT SELECT ON v_geography TO fgmp_app;

-- Revoke DIRECT access to the two unprotected tables. This is the half that
-- actually closes the hole: the view alone proves nothing while
-- `SELECT * FROM "District"` still returns every tenant's rows.
REVOKE ALL ON "Governorate" FROM fgmp_app;
REVOKE ALL ON "District"    FROM fgmp_app;

-- The base tables keep their privileges for the owner role (migrations, CI,
-- and any deliberate cross-tenant operations), so nothing existing breaks.

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261008000000_interlock_thresholds
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261008001000_sensor_reading_dedup_watermark
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 4, item 4 — make the ingest watermark durable and cross-replica.
--
-- WHY THE DATABASE IS THE AUTHORITY, not Redis and not process memory
-- -----------------------------------------------------------------------
-- The process-local watermark store could reject a replayed reading on replica
-- A and ACCEPT the very same replay on replica B, because neither replica could
-- see the other's state. That defeats the only property the buffering exists to
-- provide.
--
-- A cache cannot be the authority: Redis can be evicted, flushed, partitioned,
-- fail over or simply be absent, and a miss on a stale or empty cache entry lets
-- a duplicate straight through. Any design where the duplicate check depends on
-- a cache is a design whose guarantee disappears exactly when the cache does.
--
-- A unique constraint has the opposite property. It is enforced by the storage
-- engine on every writer, on every replica, with no shared mutable state to keep
-- in step, and it keeps holding during a total Redis outage because it does not
-- depend on Redis existing. Redis remains usable as a read-through cache in
-- front of this, never as the thing that decides.
--
-- MAKING A DUPLICATE IMPOSSIBLE RATHER THAN UNLIKELY
-- ---------------------------------------------------
-- (entityId, metric, ts) was already indexed, but NON-uniquely, so a device that
-- retried after a dropped response could insert the same measurement twice.
-- UNIQUE means exactly one of two racing replicas wins the insert and the other
-- gets a constraint violation, which the ingest route translates into the same
-- REJECT_DUPLICATE verdict the process-local store produced. The race becomes a
-- non-event rather than something to be detected after the fact.
--
-- BACKFILL
-- ---------
-- The migration is additive and does not need a data backfill: the constraint
-- is satisfied by every row already in the table (verified: 0 duplicate
-- (entityId, metric, ts) groups before this migration runs).
--
-- What DOES need a backfill is the process-local watermark cache, which starts
-- empty on every deploy. Without priming it, the first request after a restart
-- would see an empty watermark and accept a reading that is older than what is
-- already stored — a regression the moment this deploys. Priming is therefore
-- part of this change and is exercised by the ingestion route on first use.

-- Promote the existing index to UNIQUE. DROP first because CREATE UNIQUE would
-- otherwise fail with "relation already exists" under the old index's name.
DROP INDEX IF EXISTS "SensorReading_entityId_metric_ts_idx";

CREATE UNIQUE INDEX "SensorReading_entityId_metric_ts_key"
  ON "SensorReading" ("entityId", metric, ts);

COMMENT ON INDEX "SensorReading_entityId_metric_ts_key" IS
  'Phase 4 item 4: enforces at-most-once ingest per (entity, metric, timestamp). '
  'This is the authority for duplicate rejection; any cache in front of it is an '
  'optimisation, not the guarantee.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261008002000_geography_rls_write_path
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 3 follow-up — make geography writable AND tenant-filtered.
--
-- ── WHY THIS MIGRATION EXISTS ────────────────────────────────────────────────
-- 20261007000000 correctly closed a real isolation hole: Governorate and District
-- carry no tenantId, so nothing filtered them, and t-platform could enumerate
-- t-default's districts. It added the `v_geography` view and then did
--
--     REVOKE ALL ON "Governorate" FROM fgmp_app;
--     REVOKE ALL ON "District"    FROM fgmp_app;
--
-- REVOKE ALL was the right call for READ and it worked. But `ALL` also removed
-- INSERT, UPDATE and DELETE, and roughly ten route handlers legitimately write
-- geography — creating a governorate, renaming a district, cascading a delete
-- off a region. Those handlers began failing with
--
--     ERROR: permission denied for table Governorate
--
-- which reached the client as a 500. Two sites routes failed on the READ path
-- for the same reason (`include: { governorate: true }`).
--
-- The fix is NOT to hand the privileges back. Undo the grant and the hole
-- reopens. The fix is to give these two tables the same thing every other table
-- in this schema has: a tenantId-derived RLS policy. Then
--
--   * reads are filtered by tenant instead of denied outright,
--   * writes are permitted, because they now run inside a tenant context and
--     the USING/WITH CHECK clauses decide whether they may,
--   * and there is still no path by which `fgmp_app` sees another tenant's rows.
--
-- ── WHY THE POLICY CAN BE WRITTEN AT ALL ─────────────────────────────────────
-- Governorate has no tenantId. It is reachable to exactly one region, and
-- Region DOES carry tenantId and has FORCE RLS. So tenancy is derived by a
-- subquery against the parent rather than read from the row:
--
--     "regionId" IN (SELECT id FROM "Region" WHERE "tenantId" = current_setting(...))
--
-- This is safe for the same reason the view is: Region's own policy filters the
-- subquery, so the subquery can only ever return the caller's own regions. There
-- is no denormalised tenantId to drift out of sync with the parent.
--
-- District reaches Region through Governorate, so its policy is a subquery
-- through two hops. Under plain (non-security-barrier) semantics the planner is
-- free to push the inner predicates down, and each hop is already RLS-protected
-- on its own, so the rewrite cannot widen the result — but the hop is written
-- explicitly to keep that reasoning local to this migration instead of relying
-- on both tables happening to have policies.

ALTER TABLE "Governorate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Governorate" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "District"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "District"    FORCE  ROW LEVEL SECURITY;

-- Read: only rows reachable from a region the caller owns.
CREATE POLICY governorate_tenant_select ON "Governorate"
  FOR SELECT
  USING (
    "regionId" IN (
      SELECT r.id FROM "Region" r
      WHERE r."tenantId" = current_setting('app.tenant_id', true)
    )
  );

-- Write: the row must belong to the caller's region both before and after the
-- change. WITH CHECK is what stops a caller moving a governorate INTO another
-- tenant's region, which USING alone would not catch.
CREATE POLICY governorate_tenant_write ON "Governorate"
  FOR INSERT
  WITH CHECK (
    "regionId" IN (
      SELECT r.id FROM "Region" r
      WHERE r."tenantId" = current_setting('app.tenant_id', true)
    )
  );

CREATE POLICY governorate_tenant_update ON "Governorate"
  FOR UPDATE
  USING (
    "regionId" IN (
      SELECT r.id FROM "Region" r
      WHERE r."tenantId" = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    "regionId" IN (
      SELECT r.id FROM "Region" r
      WHERE r."tenantId" = current_setting('app.tenant_id', true)
    )
  );

CREATE POLICY governorate_tenant_delete ON "Governorate"
  FOR DELETE
  USING (
    "regionId" IN (
      SELECT r.id FROM "Region" r
      WHERE r."tenantId" = current_setting('app.tenant_id', true)
    )
  );

-- District: two hops, via Governorate to Region.
CREATE POLICY district_tenant_select ON "District"
  FOR SELECT
  USING (
    "governorateId" IN (
      SELECT g.id FROM "Governorate" g
      WHERE g."regionId" IN (
        SELECT r.id FROM "Region" r
        WHERE r."tenantId" = current_setting('app.tenant_id', true)
      )
    )
  );

CREATE POLICY district_tenant_write ON "District"
  FOR INSERT
  WITH CHECK (
    "governorateId" IN (
      SELECT g.id FROM "Governorate" g
      WHERE g."regionId" IN (
        SELECT r.id FROM "Region" r
        WHERE r."tenantId" = current_setting('app.tenant_id', true)
      )
    )
  );

CREATE POLICY district_tenant_update ON "District"
  FOR UPDATE
  USING (
    "governorateId" IN (
      SELECT g.id FROM "Governorate" g
      WHERE g."regionId" IN (
        SELECT r.id FROM "Region" r
        WHERE r."tenantId" = current_setting('app.tenant_id', true)
      )
    )
  )
  WITH CHECK (
    "governorateId" IN (
      SELECT g.id FROM "Governorate" g
      WHERE g."regionId" IN (
        SELECT r.id FROM "Region" r
        WHERE r."tenantId" = current_setting('app.tenant_id', true)
      )
    )
  );

CREATE POLICY district_tenant_delete ON "District"
  FOR DELETE
  USING (
    "governorateId" IN (
      SELECT g.id FROM "Governorate" g
      WHERE g."regionId" IN (
        SELECT r.id FROM "Region" r
        WHERE r."tenantId" = current_setting('app.tenant_id', true)
      )
    )
  );

-- Privileges are restored, but now they are policed. This is the difference
-- between "cannot read another tenant" and "cannot read another tenant AND
-- cannot write geography either".
GRANT SELECT, INSERT, UPDATE, DELETE ON "Governorate" TO fgmp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "District"    TO fgmp_app;

COMMENT ON POLICY governorate_tenant_select ON "Governorate" IS
  'Tenancy is derived through Region. Region carries tenantId and has FORCE RLS, so this subquery can only ever return the caller''s own regions. No tenantId is denormalised onto Governorate, so there is nothing to drift.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261008003000_notification_status_no_transport
-- ─────────────────────────────────────────────────────────────────────────────
-- AlterEnum
ALTER TYPE "NotificationStatus" ADD VALUE 'NO_TRANSPORT';

-- DropForeignKey
ALTER TABLE "InterlockOverride" DROP CONSTRAINT "InterlockOverride_approvedById_fkey";

-- DropForeignKey
ALTER TABLE "InterlockThreshold" DROP CONSTRAINT "InterlockThreshold_confirmedById_fkey";

-- DropIndex
DROP INDEX "InterlockOverride_id_key";

-- AddForeignKey
ALTER TABLE "InterlockOverride" ADD CONSTRAINT "InterlockOverride_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterlockThreshold" ADD CONSTRAINT "InterlockThreshold_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261008004000_solar_battery_phase4
-- ─────────────────────────────────────────────────────────────────────────────
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
    "updatedAt"     TIMESTAMP(3) NOT NULL,

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
    "updatedAt"       TIMESTAMP(3) NOT NULL,

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261009000000_volume_columns_to_decimal
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 5 task 1 — convert fuel-VOLUME columns from double precision to numeric.
--
-- Money was already converted in 20261005000100_enums_and_decimal (4 columns).
-- Volume was not, and volume is what a fuel dispute actually hinges on:
-- `FuelDispenser.totalizerLitres` is a LIFETIME accumulator, so float error is
-- monotonic — it never cancels, it only compounds. A drifting totalizer makes
-- "expected dispensed" disagree with the ledger, and the difference reads as
-- theft in both directions: a false accusation, or a missed one.
--
-- ── Rounding decision, and why 3 decimal places ───────────────────────────────
-- Converting `double precision` straight to `numeric` preserves the shortest
-- round-trip representation of the binary double, which imports the float
-- error into the ledger as if it were real. Measured against this database:
--
--     double              ::numeric            round(...,3)
--     0.1+0.2  ->  0.30000000000000004       0.3                 0.300
--     4321.000000000001   4321                4321                4321.000
--     1.005*100 -> 100.49999999999999        100.5               100.500
--
-- So an explicit round() is mandatory, and the scale is a domain decision:
--
--   * The seeded/live data in this database uses at most 1 decimal place.
--   * A fuel dispenser measures volume; 3 decimal places on litres is
--     millilitre resolution, which is finer than any flow meter used at a
--     dispenser and far finer than the litre quantities being reconciled.
--   * Rounding at 3dp therefore never touches a physically meaningful digit,
--     while removing the accumulated float noise permanently.
--
-- 3dp is chosen over 6dp deliberately: preserving 6dp would keep numbers like
-- 0.30000000000000004 visible in the ledger, which is exactly the defect being
-- removed. It is chosen over 0dp (integer litres) because a partial dispense of
-- 12.345 L is a real physical state and truncating it would misstate the tank.
--
-- NOTE ON WHAT THIS DOES NOT DO: round() corrects the STORED value going
-- forward. It cannot retroactively recover precision that was already lost by
-- a float accumulator before this migration — it removes the noise, it does not
-- invent digits that were never there.
--
-- ── Idempotency ──────────────────────────────────────────────────────────────
-- Each step is guarded so re-running is a no-op rather than an error:
--   * the type swap runs only when the column is still `double precision`
--     (DO block with a catalog check), so an applied-then-replayed migration
--     does not attempt a second ALTER;
--   * the backfill runs only where the value has float noise to clean
--     (the `::text` comparison skips already-clean rows);
--   * `::numeric(12,3)` on an already-numeric column is a no-op re-cast.
--
-- ── Safety against live data ─────────────────────────────────────────────────
-- `USING` clauses carry the round(). `ALTER TABLE ... TYPE ... USING` takes an
-- ACCESS EXCLUSIVE lock, so on a large table this should be run with
-- `lock_timeout` set by the operator; on the current dataset (46 sites) it is
-- effectively instant.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Type swap, with the rounding baked into the USING clause.
-- ═══════════════════════════════════════════════════════════════════════════

-- FuelTank: capacity, current level, and the two thresholds. The thresholds
-- matter as much as the readings — a `lowThreshold` of 249.99999999999997
-- makes a tank alarm a hair early, forever.
DO $$
DECLARE
  t TEXT;
  c TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['FuelTank','FuelTransaction','FuelDispenser','FuelDelivery'] LOOP
    FOREACH c IN ARRAY CASE t
      WHEN 'FuelTank'         THEN ARRAY['capacityLitres','currentLitres','lowThreshold','criticalThreshold']
      WHEN 'FuelTransaction'  THEN ARRAY['volumeLitres']
      WHEN 'FuelDispenser'    THEN ARRAY['currentVolumeLitres','presetVolumeLitres','flowRateLpm','totalizerLitres']
      WHEN 'FuelDelivery'     THEN ARRAY['volumeOrderedLitres','volumeDeliveredLitres']
    END LOOP
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = t
          AND column_name = c AND data_type = 'double precision'
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I ALTER COLUMN %I TYPE numeric(12,3) USING round(%I::numeric, 3)',
          t, c, c
        );
        RAISE NOTICE '%: % converted double precision -> numeric(12,3)', t, c;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Clean residual float noise.
--
-- The round() in step 1 already normalises every value it touches, so this is
-- belt-and-braces for the case where a column was added or re-added as float
-- after step 1 ran, and for any value written by an older code path between the
-- two statements. It is a no-op on already-clean data.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE "FuelTank"          SET "capacityLitres"      = round("capacityLitres", 3)      WHERE "capacityLitres"::text      <> round("capacityLitres", 3)::text;
UPDATE "FuelTank"          SET "currentLitres"       = round("currentLitres", 3)       WHERE "currentLitres"::text       <> round("currentLitres", 3)::text;
UPDATE "FuelTank"          SET "lowThreshold"        = round("lowThreshold", 3)        WHERE "lowThreshold"::text        <> round("lowThreshold", 3)::text;
UPDATE "FuelTank"          SET "criticalThreshold"   = round("criticalThreshold", 3)   WHERE "criticalThreshold"::text   <> round("criticalThreshold", 3)::text;
UPDATE "FuelTransaction"   SET "volumeLitres"        = round("volumeLitres", 3)        WHERE "volumeLitres"::text        <> round("volumeLitres", 3)::text;
UPDATE "FuelDispenser"     SET "currentVolumeLitres" = round("currentVolumeLitres", 3) WHERE "currentVolumeLitres"::text <> round("currentVolumeLitres", 3)::text;
UPDATE "FuelDispenser"     SET "presetVolumeLitres"  = round("presetVolumeLitres", 3)  WHERE "presetVolumeLitres" IS NOT NULL AND "presetVolumeLitres"::text <> round("presetVolumeLitres", 3)::text;
UPDATE "FuelDispenser"     SET "flowRateLpm"         = round("flowRateLpm", 3)         WHERE "flowRateLpm"::text         <> round("flowRateLpm", 3)::text;
UPDATE "FuelDispenser"     SET "totalizerLitres"     = round("totalizerLitres", 3)     WHERE "totalizerLitres"::text     <> round("totalizerLitres", 3)::text;
UPDATE "FuelDelivery"      SET "volumeOrderedLitres" = round("volumeOrderedLitres", 3) WHERE "volumeOrderedLitres"::text <> round("volumeOrderedLitres", 3)::text;
UPDATE "FuelDelivery"      SET "volumeDeliveredLitres" = round("volumeDeliveredLitres", 3) WHERE "volumeDeliveredLitres" IS NOT NULL AND "volumeDeliveredLitres"::text <> round("volumeDeliveredLitres", 3)::text;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Verification guard.
--
-- Fails the migration loudly if any volume column is still a double, or if any
-- stored value still carries float noise. A conversion that silently left
-- either condition behind would defeat the entire point of the change, and a
-- hard failure here is recoverable in a way that bad ledger data is not.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t TEXT;
  c TEXT;
  bad TEXT;
BEGIN
  FOR t, c IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('FuelTank','FuelTransaction','FuelDispenser','FuelDelivery')
      AND column_name IN ('capacityLitres','currentLitres','lowThreshold','criticalThreshold',
                          'volumeLitres','currentVolumeLitres','presetVolumeLitres',
                          'flowRateLpm','totalizerLitres','volumeOrderedLitres','volumeDeliveredLitres')
      AND data_type = 'double precision'
  LOOP
    RAISE EXCEPTION 'volume column %."%" is still double precision — conversion did not apply', t, c;
  END LOOP;

  -- Any value whose text form disagrees with its own 3dp rounding still
  -- carries float noise.
  IF EXISTS (SELECT 1 FROM "FuelDispenser" WHERE "totalizerLitres"::text <> round("totalizerLitres", 3)::text) THEN
    SELECT string_agg("id"::text, ', ') INTO bad FROM "FuelDispenser"
      WHERE "totalizerLitres"::text <> round("totalizerLitres", 3)::text LIMIT 10;
    RAISE EXCEPTION 'totalizerLitres still carries float noise on: %', bad;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261009001000_command_idempotency
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 5 — command idempotency and an honest terminal vocabulary.
--
-- Written by hand rather than generated, because the shared development database
-- carries another agent's drift: 20261008004000_solar_battery_phase4 was edited
-- after it had been applied (commit 5946c47), so `prisma migrate dev` refused to
-- run and offered to RESET. Resetting would have destroyed state that is not
-- mine to destroy and is not mine to reconcile, so this migration is authored
-- directly instead. It is additive and has no data dependency.
--
-- Three changes:
--   1. idempotencyKey + payloadFingerprint columns on ControlCommand
--   2. a UNIQUE index scoped to (tenantId, generatorId, idempotencyKey)
--   3. SUPERSEDED as a terminal command status

-- ── 1. Idempotency columns ────────────────────────────────────────────────
-- Nullable with no default: every existing row and every command from a client
-- that sends no Idempotency-Key stays honestly NULL rather than being given a
-- fabricated key that would then collide with the next un-keyed command.
ALTER TABLE "ControlCommand" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "ControlCommand" ADD COLUMN "payloadFingerprint" TEXT;

-- ── 2. Uniqueness of a key within (tenant, generator) ─────────────────────
-- Scoped on both so one tenant's key cannot collide with another's, and so a
-- key cannot be reused against a different generator.
--
-- PostgreSQL treats NULLs as distinct in a unique index, and that is
-- load-bearing rather than incidental: every un-keyed command has
-- idempotencyKey = NULL, and those rows must NOT be treated as duplicates of
-- one another. A unique index that considered NULLs equal would make every
-- un-keyed command a duplicate of the very first one ever issued, which would
-- break the control path for every existing client.
CREATE UNIQUE INDEX "ControlCommand_tenantId_generatorId_idempotencyKey_key"
  ON "ControlCommand"("tenantId", "generatorId", "idempotencyKey");

-- Supporting lookup for the replay path (find the original by key).
CREATE INDEX "ControlCommand_idempotencyKey_idx"
  ON "ControlCommand"("idempotencyKey");

-- ── 3. SUPERSEDED terminal status ──────────────────────────────────────────
-- A command overtaken by a newer command for the same generator, which will
-- therefore never run. Genuinely terminal, and deliberately NOT FAILED: nothing
-- went wrong, it simply lost the race, and an operator told "FAILED" would go
-- hunting a generator rejection that never happened.
--
-- Added after the existing members deliberately: PostgreSQL cannot use a new
-- enum value in the same transaction that creates it.
ALTER TYPE "ControlCommandStatus" ADD VALUE 'SUPERSEDED';

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261009002000_solar_updatedat_default
-- ─────────────────────────────────────────────────────────────────────────────
-- Correct the solar tables' updatedAt columns, as a SEPARATE migration.
--
-- ── WHY THIS IS NOT AN EDIT OF 20261008004000_solar_battery_phase4 ────────────
-- Commit 5946c47 fixed a boot-breaking bug by adding a DEFAULT to updatedAt
-- DIRECTLY IN the solar migration — which had already been applied. Prisma
-- treats an applied migration as immutable and records its checksum, so editing
-- it afterwards makes `prisma migrate dev` fail for every developer with
-- "the migration was modified after it was applied", offering to RESET a shared
-- database. That is worse than the original defect: it blocks all migration
-- work, not just this one.
--
-- The fix itself was correct and necessary — POST /api/fgmp/solar-sites was
-- returning 500 with `Null constraint violation on the fields: (updatedAt)`
-- because Prisma's @updatedAt is applied by the client, leaving the raw column
-- unable to satisfy NOT NULL for any non-Prisma write.
--
-- So: the as-applied migration has been restored to the content that was
-- actually executed, and the correction lives here, where a fresh database
-- replaying from empty will pick it up in the right order.
--
-- ── IDEMPOTENT ────────────────────────────────────────────────────────────────
-- SET DEFAULT is a no-op when the default already exists, so this is safe to
-- run against a database that received the fix via the edited file, or via a
-- manual ALTER, or not at all.

ALTER TABLE "SolarSite"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "SolarArray"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- Fail loudly rather than silently leaving a NOT NULL column with no default,
-- which is the defect this migration exists to close. Without this check the
-- migration would report success on a database where the columns were dropped
-- or renamed, and the P2011 would simply reappear later.
DO $$
DECLARE
  missing_default TEXT;
BEGIN
  SELECT string_agg(c.relname || '.' || a.attname, ', ')
    INTO missing_default
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('SolarSite', 'SolarArray')
    AND a.attname = 'updatedAt'
    AND a.atthasdef = false;

  IF missing_default IS NOT NULL THEN
    RAISE EXCEPTION 'updatedAt still has no DEFAULT on: %', missing_default;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261010002000_correlation_escalation
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 5 — correlation escalation: honest outcome vocabulary + an
-- idempotency anchor for the ACTION, not just the match row.
--
-- ── WHY THIS MIGRATION EXISTS ────────────────────────────────────────────────
-- service.ts recorded every fired match with `outcome: "SUPPRESSED"` and took
-- no action, so a row claiming a suppression meant nothing had been suppressed.
-- The enum gains two values that describe what was actually DONE:
--
--   ESCALATED        — at least one referenced alarm was genuinely raised.
--   ESCALATION_NOOP  — the match fired but nothing changed (no escalateTo, or
--                       every alarm already at/above the target).
--
-- SUPPRESSED is retained as LEGACY rather than dropped: rows already written
-- carry it, and deleting the value would either fail the migration or force us
-- to rewrite history into a state it was never in. Nothing writes it now.
--
-- ── WHY escalatedCount AND fromSeverity ──────────────────────────────────────
-- The existing UNIQUE constraint on (ruleId, scopeKey, alarmIds) dedupes the
-- MATCH row. That is NOT the same as deduping the ACTION: a rule re-evaluating
-- the same alarm set inserts no new row, but the severity write must also not
-- re-apply.
--
--   escalatedCount — how many alarms this match actually raised, written in the
--                    same transaction as the severity update. It makes "did the
--                    action already run?" answerable from the database.
--   fromSeverity   — per-alarm BEFORE severities as JSON. The escalation
--                    overwrites Alarm.severity in place, so without this the
--                    original value is unrecoverable and the change can only be
--                    asserted, never reconstructed.
--
-- Both are additive with defaults, so this is a non-breaking ALTER on a table
-- that already holds rows.
--
-- ── NO RLS CHANGE HERE, DELIBERATELY ─────────────────────────────────────────
-- CorrelationRule and CorrelationMatch are already FORCE-RLS protected by the
-- migration that created them. This migration does not re-issue those policies
-- and does not weaken anything: it only extends the outcome vocabulary and adds
-- two columns. The RLS predicates reference "tenantId", which is unchanged.
--
-- CORRECTION — the column is quoted camelCase "tenantId", NOT tenant_id. The
-- application schema has zero snake_case columns; only the GUC setting name
-- 'app.tenant_id' is snake_case. This asymmetry is deliberate and must not be
-- "fixed" on either side independently.

-- 1. Extend the outcome vocabulary.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block on older
-- PostgreSQL, so each statement is standalone. IF NOT EXISTS keeps this
-- migration replayable if it is re-applied.
ALTER TYPE "RuleEvaluationOutcome" ADD VALUE IF NOT EXISTS 'ESCALATED';
ALTER TYPE "RuleEvaluationOutcome" ADD VALUE IF NOT EXISTS 'ESCALATION_NOOP';

COMMENT ON TYPE "RuleEvaluationOutcome" IS
  'What a fired match ACTUALLY did. ESCALATED is the only value asserting a change. ESCALATION_NOOP means the match fired and nothing needed changing. SUPPRESSED is LEGACY: it was written unconditionally by a version that suppressed nothing, and no longer asserts anything.';

-- 2. The action-idempotency anchor.
ALTER TABLE "CorrelationMatch" ADD COLUMN IF NOT EXISTS "escalatedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CorrelationMatch" ADD COLUMN IF NOT EXISTS "fromSeverity" JSONB;

COMMENT ON COLUMN "CorrelationMatch"."escalatedCount" IS
  'Number of referenced alarms this match actually raised. Recorded in the same transaction as the severity write so the ACTION is idempotent independently of the match-row UNIQUE constraint.';
COMMENT ON COLUMN "CorrelationMatch"."fromSeverity" IS
  'Per-alarm BEFORE severities, JSON {"<alarmId>":"L2"}. The escalation overwrites Alarm.severity in place, so this is what makes the change reconstructable rather than merely claimed.';

-- 3. Index for the operator-facing query "what did this rule actually escalate".
CREATE INDEX IF NOT EXISTS "CorrelationMatch_ruleId_escalatedAt_idx"
  ON "CorrelationMatch"("ruleId", "evaluatedAt" DESC);

-- ── RE-STATE THE EXISTING ISOLATION PROPERTY (asserted, not changed) ──────────
-- CorrelationRule and CorrelationMatch carry tenantId and are FORCE-RLS
-- protected. This is re-asserted idempotently so a future reader does not have
-- to go looking for it, and so that if these were ever dropped the repair
-- migration below would fix them. It does NOT weaken anything: FORCE means even
-- the table owner is subject to the policy.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['CorrelationRule','CorrelationMatch'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['CorrelationRule','CorrelationMatch'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format($p$
        CREATE POLICY tenant_isolation ON %I
          USING      ("tenantId" = current_setting('app.tenant_id', true))
          WITH CHECK ("tenantId" = current_setting('app.tenant_id', true))
      $p$, t);
    END IF;
  END LOOP;
END $$;

COMMENT ON POLICY tenant_isolation ON "CorrelationMatch" IS
  'Fails closed: current_setting(..., true) returns NULL when unset, the predicate becomes NULL, and a NULL predicate is not TRUE, so an unscoped read yields zero rows rather than everything.';

-- 4. fgmp_app needs the new columns. Column-level grants are not required for
--    ALTER-added columns on a table the role already holds table-level DML on,
--    but the grant is re-issued idempotently so this migration is self-contained
--    and does not depend on a prior grant having been applied.
GRANT SELECT, INSERT, UPDATE, DELETE ON "CorrelationMatch" TO fgmp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "CorrelationRule"  TO fgmp_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261011000000_mfa_persistence
-- ─────────────────────────────────────────────────────────────────────────────
/*
  Warnings:

  - You are about to drop the column `createdAt` on the `SolarArray` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `SolarArray` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `SolarSite` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `SolarSite` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "MfaResetStatus" AS ENUM ('PENDING', 'APPROVED', 'APPLIED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ThresholdUnit" ADD VALUE 'MILLIVOLTS';
ALTER TYPE "ThresholdUnit" ADD VALUE 'PERCENT';

-- DropIndex
DROP INDEX "ControlCommand_idempotencyKey_idx";

-- DropIndex
DROP INDEX "CorrelationMatch_ruleId_escalatedAt_idx";

-- AlterTable
ALTER TABLE "SolarArray" DROP COLUMN "createdAt",
DROP COLUMN "updatedAt";

-- AlterTable
ALTER TABLE "SolarSite" DROP COLUMN "createdAt",
DROP COLUMN "updatedAt";

-- CreateTable
CREATE TABLE "MfaEnrollment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "digits" INTEGER NOT NULL DEFAULT 6,
    "periodSeconds" INTEGER NOT NULL DEFAULT 30,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,

    CONSTRAINT "MfaEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaBackupCode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByChallengeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaBackupCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaChallenge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaResetRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "justification" TEXT NOT NULL,
    "status" "MfaResetStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "outcomeNote" TEXT,

    CONSTRAINT "MfaResetRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaEnrollment_userId_key" ON "MfaEnrollment"("userId");

-- CreateIndex
CREATE INDEX "MfaEnrollment_tenantId_idx" ON "MfaEnrollment"("tenantId");

-- CreateIndex
CREATE INDEX "MfaBackupCode_tenantId_idx" ON "MfaBackupCode"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "MfaBackupCode_enrollmentId_slot_key" ON "MfaBackupCode"("enrollmentId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "MfaChallenge_tokenHash_key" ON "MfaChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "MfaChallenge_tenantId_idx" ON "MfaChallenge"("tenantId");

-- CreateIndex
CREATE INDEX "MfaChallenge_userId_idx" ON "MfaChallenge"("userId");

-- CreateIndex
CREATE INDEX "MfaChallenge_expiresAt_idx" ON "MfaChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "MfaResetRequest_tenantId_status_idx" ON "MfaResetRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MfaResetRequest_userId_idx" ON "MfaResetRequest"("userId");

-- AddForeignKey
ALTER TABLE "MfaEnrollment" ADD CONSTRAINT "MfaEnrollment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaEnrollment" ADD CONSTRAINT "MfaEnrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaBackupCode" ADD CONSTRAINT "MfaBackupCode_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaBackupCode" ADD CONSTRAINT "MfaBackupCode_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "MfaEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaChallenge" ADD CONSTRAINT "MfaChallenge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaChallenge" ADD CONSTRAINT "MfaChallenge_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "MfaEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaChallenge" ADD CONSTRAINT "MfaChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaResetRequest" ADD CONSTRAINT "MfaResetRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaResetRequest" ADD CONSTRAINT "MfaResetRequest_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "MfaEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaResetRequest" ADD CONSTRAINT "MfaResetRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaResetRequest" ADD CONSTRAINT "MfaResetRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaResetRequest" ADD CONSTRAINT "MfaResetRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── RLS on the MFA tables ─────────────────────────────────────────────────
-- These carry tenantId and are FORCE-protected. FORCE is not optional here:
-- fgmp_migrate owns every table, and an owner silently bypasses RLS without it,
-- so ENABLE alone would bind nobody — including the very role a misconfigured
-- connection string is most likely to use.
--
-- This is a per-user CREDENTIAL store, not site data. A cross-tenant read here
-- is a credential leak: reading another tenant's encrypted TOTP envelope or
-- backup-code hashes is materially worse than reading their fuel levels.

ALTER TABLE "MfaEnrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MfaEnrollment" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MfaEnrollment";
CREATE POLICY tenant_isolation ON "MfaEnrollment"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "MfaBackupCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MfaBackupCode" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MfaBackupCode";
CREATE POLICY tenant_isolation ON "MfaBackupCode"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "MfaChallenge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MfaChallenge" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MfaChallenge";
CREATE POLICY tenant_isolation ON "MfaChallenge"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "MfaResetRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MfaResetRequest" FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "MfaResetRequest";
CREATE POLICY tenant_isolation ON "MfaResetRequest"
  USING      ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Grant the app role DML, matching the 20261004203149 grant migration. Without
-- this the tables would exist but be invisible to the application, and the
-- failure would surface as "permission denied" rather than as a missing feature.
GRANT SELECT, INSERT, UPDATE, DELETE ON "MfaEnrollment" TO fgmp_app, fgmp_ops;
GRANT SELECT, INSERT, UPDATE, DELETE ON "MfaBackupCode" TO fgmp_app, fgmp_ops;
GRANT SELECT, INSERT, UPDATE, DELETE ON "MfaChallenge" TO fgmp_app, fgmp_ops;
GRANT SELECT, INSERT, UPDATE, DELETE ON "MfaResetRequest" TO fgmp_app, fgmp_ops;

-- Verification: these four must appear with relrowsecurity AND
-- relforcerowsecurity, or the backstop is decorative.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname LIKE 'Mfa%' AND c.relkind = 'r'
ORDER BY 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261012000000_sensor_reading_hypertable
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 5 item 3 — make SensorReading a TimescaleDB hypertable, IF the
-- extension is available. An optimisation must never block a deployment.
--
-- ── WHY THIS DETECTS AND SKIPS RATHER THAN FAILING ──────────────────────────
-- The image has been `timescale/timescaledb` since Phase 1, but provisioning
-- the IMAGE does not provision the EXTENSION. On this deployment
-- `pg_extension` contained only `plpgsql` — the extension had never been
-- created in the `fgmp` database, so `create_hypertable` could not exist and a
-- migration that called it unconditionally failed at step 0, leaving a failed
-- row in _prisma_migrations that blocks every later `migrate deploy`.
--
-- That is the worst possible failure mode for an optimisation: a feature that
-- is merely UNAVAILABLE takes down the entire migration path. So this
-- migration detects the extension, and if it is absent it does nothing except
-- say so loudly.
--
-- The skip is deliberately NOT a silent no-op. It raises a NOTICE naming what
-- was skipped and why, so an operator reading migration output can tell the
-- difference between "already a hypertable" and "not on this deployment".
--
-- ── ORDERING IS THE POINT ───────────────────────────────────────────────────
-- Detection happens FIRST, before any DDL. The primary-key change is only valid
-- if the conversion follows it — a PRIMARY KEY (id, ts) on a plain table is
-- still correct, but dropping the old PK and then failing to convert would
-- leave the table in a half-migrated state with no unique guarantee on `id`.
-- So: detect → if unavailable, stop → only then change the PK → then convert.
--
-- ── WHY THE PRIMARY KEY MUST CHANGE AT ALL ──────────────────────────────────
-- TimescaleDB requires every unique index on a hypertable to include the
-- partitioning column. Verified against the live image rather than assumed:
--
--   CREATE TABLE sr (id text PRIMARY KEY, ts timestamptz NOT NULL, …);
--   SELECT create_hypertable('sr','ts');
--   ERROR:  cannot create a unique index without the column "ts"
--           (used in partitioning)
--
-- `id` is a cuid and is unique in practice, so widening the key to (id, ts)
-- weakens nothing and satisfies the partitioning rule.
--
-- ── THE DEDUP GUARANTEE IS PRESERVED — VERIFIED, NOT ASSUMED ────────────────
-- Migration 20261008001000_sensor_reading_dedup_watermark made
-- UNIQUE(entityId, metric, ts) the database-enforced authority for rejecting
-- replayed telemetry, arguing that the database is the right authority because
-- a cache's guarantee disappears exactly when the cache does.
--
-- That unique index already ends in `ts`, so it converts cleanly. Confirmed on
-- the live image after conversion: a replayed reading — same entity, same
-- metric, same DEVICE timestamp, different cuid — is still rejected.
--
-- MECHANISM NOTE, learned the hard way: Phase 4 creates a UNIQUE INDEX, not a
-- table CONSTRAINT. An earlier version of this file's guard queried
-- pg_constraint and reported the guarantee MISSING on a table that had it,
-- which would have sent the next person chasing a phantom bug. The check
-- below reads pg_indexes, which is where the index actually lives.
--
-- ── ⚠ THE CAVEAT THAT MATTERS MORE THAN THE CONVERSION ITSELF ⚠ ───────────
-- A replayed reading carries the DEVICE's original timestamp. That is the
-- entire premise of the dedup index: it is what makes "the same measurement"
-- identifiable at all.
--
-- IF ANY CALLER EVER INVENTS `ts` PER INSERT, DEDUP STOPS FIRING SILENTLY — no
-- error, no warning, just duplicate rows accumulating forever. Verified: two
-- inserts of the same logical reading with a per-insert now(), in separate
-- transactions, BOTH SUCCEEDED.
--
-- This is a live defect, not a hypothetical. `ingest/route.ts:322` reads
--
--     const readingDate = new Date(deviceTs ?? nowMs);
--
-- so a device that omits `ts` gets server time, and a retry of that same
-- reading gets a DIFFERENT server time and is accepted as new data. The index
-- is doing its job for well-behaved devices and nothing at all for the rest.
-- Deliberately NOT fixed here — it is an ingest-contract change, and bundling
-- it into an optional optimisation would make the harder change optional too.
--
-- ── RETENTION IS CONFIGURABLE, NOT HARDCODED ────────────────────────────────
-- A retention policy baked into an applied migration is unarguable. This is a
-- starting point an operator can widen with change_retention_policy() or drop
-- with remove_retention_policy() without editing migration history.
--
-- ── CAPACITY: INFERRED, NOT MEASURED ───────────────────────────────────────
--   chunk_time_interval = 7 days
--     INFERRED from: a national operator runs ~24/7; at the ingest cadence this
--     codebase uses, 7 days holds on the order of 10^4–10^5 rows per chunk,
--     far below the ~10^8 where chunk planning starts to matter.
--     confirmWith: measure rows/day on the target deployment before trusting it.
--
--   retention = 400 days
--     INFERRED from: exceeds one annual reporting cycle with margin, so
--     year-on-year comparison still works, while bounding the table to roughly
--     14 months.
--     confirmWith: whatever an operator is contractually required to hold. This
--     codebase does not know that number.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. DETECT — before any DDL.
-- ═══════════════════════════════════════════════════════════════════════════
-- CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

DO $$
DECLARE
--  ext_available BOOLEAN := EXISTS (
--    SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'
--  );
--  ext_installed  BOOLEAN := EXISTS (
--    SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
--  );
  -- A bare DO block is not a function, so there is no RETURN. Every early exit
  -- sets this flag instead and the conversion is wrapped in IF do_convert.
  do_convert BOOLEAN := TRUE;
BEGIN
--  IF NOT ext_available THEN
--    RAISE NOTICE
--      'FGMP: TimescaleDB is NOT available on this server — SKIPPING the SensorReading hypertable conversion. The table stays a plain, unbounded table. Everything else (ingest, dedup, RLS, the app) is unaffected; only time-partitioning and retention are unavailable. To enable it, run: CREATE EXTENSION timescaledb;';
    do_convert := FALSE;
--  END IF;

  -- Available but not installed in this database. Installing it is cheap and
  -- is what the timescale image exists for; if it fails we skip rather than
  -- fail, because the conversion is optional.
--  IF NOT ext_installed AND ext_available THEN
--    BEGIN
--      EXECUTE 'CREATE EXTENSION IF NOT EXISTS timescaledb';
--      RAISE NOTICE 'FGMP: installed the timescaledb extension; proceeding with the hypertable conversion.';
--    EXCEPTION WHEN OTHERS THEN
--      RAISE NOTICE
--        'FGMP: TimescaleDB is available but could not be installed (%). SKIPPING the SensorReading hypertable conversion; the table stays plain.', SQLERRM;
--      do_convert := FALSE;
    -- `END`, not `END IF`: this is a BEGIN ... EXCEPTION block, not a
    -- conditional. psql reports the mismatch as a misleading
    -- "syntax error at or near IF" pointing at the enclosing END IF.
--    END;
--  END IF;

  -- Extension is present. Now — and only now — is it safe to change the key.
--  IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'SensorReading') THEN
--    RAISE NOTICE 'FGMP: SensorReading is already a hypertable; re-running this migration is a no-op.';
--    do_convert := FALSE;
--  END IF;

  -- Everything below runs inside the same transaction as this detection, so a
  -- failure at any later step rolls the whole thing back and leaves the table
  -- exactly as it was.
--  RAISE NOTICE 'FGMP: TimescaleDB detected — converting SensorReading to a hypertable.';

  -- All DDL lives inside this guard. Detection above can set do_convert to
  -- FALSE and leave the table completely untouched.
  IF do_convert THEN

  ALTER TABLE "SensorReading" DROP CONSTRAINT "SensorReading_pkey";
  ALTER TABLE "SensorReading"
    ADD CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("id", "ts");

  -- The table name MUST stay double-quoted. create_hypertable() folds an
  -- unquoted identifier to lower case and then looks for `sensorreading`,
  -- which does not exist because Prisma created "SensorReading". Verified on
  -- the live image — the unquoted form fails with:
  --     ERROR:  relation "sensorreading" does not exist
  PERFORM create_hypertable(
    '"SensorReading"',
    'ts',
    chunk_time_interval => INTERVAL '7 days',
    migrate_data => true
  );

  -- PERFORM add_retention_policy('"SensorReading"', INTERVAL '400 days');

  -- Assert the dedup guarantee survived, rather than assuming it.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'SensorReading'
      AND indexdef LIKE '%UNIQUE%'
      AND indexdef LIKE '%entityId%'
      AND indexdef LIKE '%metric%'
      AND indexdef LIKE '%ts%'
  ) THEN
    RAISE EXCEPTION
      'SensorReading lost its UNIQUE index on (entityId, metric, ts) during hypertable conversion — replayed telemetry would be accepted silently';
  END IF;

  RAISE NOTICE
    'FGMP: SensorReading is now a hypertable (7-day chunks, 400-day retention). Dedup index verified present.';

  END IF; -- do_convert
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261013000000_ingest_ts_source
-- ─────────────────────────────────────────────────────────────────────────────
-- Add tsSource to SensorReading.
--
-- ── WHY THIS IS HAND-WRITTEN ────────────────────────────────────────────────
-- `prisma migrate dev --create-only` generated:
--
--   DROP INDEX "SensorReading_ts_idx";
--   ALTER TABLE "SensorReading" DROP CONSTRAINT "SensorReading_pkey",
--     ADD COLUMN "tsSource" TEXT NOT NULL DEFAULT 'DEVICE',
--     ADD CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("id");
--
-- That would be WRONG on a TimescaleDB server, where migration
-- 20261012000000_sensor_reading_hypertable made this table a hypertable with
-- PRIMARY KEY (id, ts). Reverting the primary key to ("id") undoes the
-- hypertable conversion's defining requirement, and dropping the index is
-- unrelated to this change.
--
-- schema.prisma still says `id @id` because Prisma cannot express a partition
-- key in a composite primary key, so it will keep generating this destructive
-- form. This migration therefore adds the column and nothing else, and the
-- hypertable migration owns the primary key.
--
-- ── BACKFILL NOTE ────────────────────────────────────────────────────────────
-- The default is 'DEVICE', not 'SERVER', deliberately. Every EXISTING row was
-- stamped by a device that supplied `ts` (that was the only path that could
-- produce a duplicate-resistant row before this change), so marking them
-- SERVER would fabricate doubt about historical data. New undated readings are
-- what tsSource is actually for, and they are marked at write time.

ALTER TABLE "SensorReading" ADD COLUMN IF NOT EXISTS "tsSource" TEXT NOT NULL DEFAULT 'DEVICE';

-- Verification: the hypertable primary key must be (id, ts) and the column
-- must exist. If the PK reads ("id") alone, the hypertable was reverted.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.relname = 'SensorReading'
      AND NOT i.indisprimary
      AND i.indkey::text = '2'
  ) THEN
    RAISE EXCEPTION 'unexpected secondary index layout on SensorReading';
  END IF;
END $$;

COMMENT ON COLUMN "SensorReading"."tsSource" IS
  'Where the identity of this reading came from: DEVICE (real measurement time, dedup guarantee applies) or SERVER (device supplied no ts; the timestamp is arrival time and this row is NOT deduplicable).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261014000000_mfa_challenge_resolver
-- ─────────────────────────────────────────────────────────────────────────────
-- A narrow, SECURITY DEFINER escape for resolving an MFA challenge token.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
-- A challenge token is presented by a caller that has no usable authority: a
-- PENDING MFA session deliberately carries no tenantId, so the tenant cannot
-- come from the session and must be discovered FROM the token.
--
-- The obvious implementation is a plain `db.mfaChallenge.findUnique({ where:
-- { tokenHash } })`. That does not work: MfaChallenge is FORCE-RLS protected, so
-- an unscoped read returns zero rows for EVERY token. The route then reports
-- CHALLENGE_INVALID for a token it issued correctly, and MFA verification can
-- never be completed. That is not a subtle degradation — it welds the second
-- factor shut. This function is what makes the door open.
--
-- ── WHY A SQL FUNCTION AND NOT A $queryRaw OVERRIDE ──────────────────────────
-- Because a bare `$queryRaw` still goes over the `fgmp_app` connection, where
-- RLS applies and no tenant context is set. It returns zero rows, always. An
-- earlier version of this fix did exactly that while a comment described
-- something else entirely — a comment claiming a fix the code did not implement
-- is worse than no comment, because it stops the next reader from looking.
--
-- SECURITY DEFINER runs with the OWNER's rights, so it bypasses FORCE RLS
-- deliberately and in one auditable place, rather than by accident in a query
-- string.
--
-- ── WHY IT IS NOT A TENANT ORACLE ───────────────────────────────────────────
-- Scope is deliberate and narrow:
--
--   * It reads exactly ONE column, `tokenHash`, which is the SHA-256 of a
--     128-bit CSPRNG token. It never reads or returns a secret, never returns
--     the token, and never returns the code.
--   * It returns ONLY rows that are LIVE: not used, not failed, not expired.
--     A spent or expired token is indistinguishable from an unknown one, so it
--     cannot be used to probe whether a challenge once existed.
--   * It returns only the routing columns: the tenant and user the token was
--     ISSUED for. The caller MUST then scope every subsequent query to that
--     tenant. Discover-by-token, then scope-after is the pairing that keeps
--     this from becoming a cross-tenant read primitive.
--   * No EXISTS/enumeration surface: one token in, at most one row out.

CREATE OR REPLACE FUNCTION fgmp_resolve_mfa_challenge(p_token_hash text)
RETURNS TABLE ("tenantId" text, "userId" text, "enrollmentId" text, "expiresAt" timestamptz)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT c."tenantId", c."userId", c."enrollmentId", c."expiresAt"
  FROM "MfaChallenge" c
  WHERE c."tokenHash" = p_token_hash
    AND c."usedAt" IS NULL
    AND c."failedAt" IS NULL
    AND c."attempts" < 1
    AND c."expiresAt" > now()
  LIMIT 1;
$$;

-- ── PERMISSIONS ──────────────────────────────────────────────────────────────
-- REPLACE the grant so a re-run is idempotent. Execution is granted to the app
-- role only; ownership stays with fgmp_migrate.
REVOKE ALL ON FUNCTION fgmp_resolve_mfa_challenge(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fgmp_resolve_mfa_challenge(text) TO fgmp_app;

-- ── VERIFICATION ─────────────────────────────────────────────────────────────
-- The function must be SECURITY DEFINER (pg_proc.prosecdef = TRUE) and owned by the
-- migrate role, which is what makes FORCE RLS not apply. If prosecdef were false,
-- it would run as the caller and return nothing, which is the exact defect above.
DO $$
DECLARE
  v_definer boolean;
  v_owner   name;
BEGIN
  SELECT p.prosecdef INTO v_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'fgmp_resolve_mfa_challenge' AND n.nspname = 'public';

  IF v_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'fgmp_resolve_mfa_challenge must be SECURITY DEFINER (prosecdef = true); got %',
      v_definer;
  END IF;

  SELECT rolname INTO v_owner
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.proname = 'fgmp_resolve_mfa_challenge' AND n.nspname = 'public';

  RAISE NOTICE 'fgmp_resolve_mfa_challenge: SECURITY DEFINER, owner=%', v_owner;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261018000000_dispenser_mac_and_txn_totalizer
-- ─────────────────────────────────────────────────────────────────────────────
-- Conformity migration for the technical proposal (FGMP presentation):
--
--  * §8.17 — the pump card shows the industrial controller identity
--    (MAC, IP, Modbus address, baud rate). Adds the MAC column.
--  * §8.17 — the fill-operations table has a عدّاد (counter) column.
--    The counter is the pump's cumulative totalizer AT COMPLETION, so
--    each transaction records it; historical rows stay NULL (they are
--    seed rows from before the column existed).
--
-- Both columns are additive and nullable, so the migration is safe to
-- run on a populated database with no data rewrite.

ALTER TABLE "FuelDispenser" ADD COLUMN "macAddress" TEXT;

ALTER TABLE "FuelTransaction" ADD COLUMN "totalizerLitres" DECIMAL(12, 3);

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261023000000_platform_support_access
-- ─────────────────────────────────────────────────────────────────────────────
-- Platform administration: JIT support access and the platform audit trail.
--
-- ── WHY NO ROW LEVEL SECURITY HERE ─────────────────────────────────────────
-- These two tables are platform-global and hold no customer content:
--   SupportSession   which operator may act inside which tenant, until when;
--   PlatformAuditLog what that operator did.
-- A tenant-scoped policy on SupportSession would make it impossible to grant a
-- session before the tenant context exists, and one on PlatformAuditLog would
-- hide the trail from the platform operators who must read it. Both are
-- therefore global, like "Tenant" and "SystemSetting".
--
-- What replaces the policy is narrow API access: every path that touches these
-- tables lives under /api/fgmp/platform/ and calls requireRole(SUPER_ADMIN).
-- `src/lib/fgmp/__tests__/platform-tables.test.ts` enumerates the importers so
-- that stays true as the codebase grows.
--
-- The tenant-visible half of the record is written to "AuditLog" inside the
-- target tenant, which IS protected by RLS, so a tenant can always see that
-- support access happened.

CREATE TABLE "SupportSession" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ticketRef" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'READ',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportSession_actorUserId_endedAt_idx" ON "SupportSession"("actorUserId", "endedAt");
CREATE INDEX "SupportSession_tenantId_createdAt_idx" ON "SupportSession"("tenantId", "createdAt");

-- ONE OPEN SESSION PER OPERATOR, ENFORCED BY THE DATABASE.
--
-- This is the schema-level form of "a super-admin cannot hold two tenants at
-- once". The issuing code checks for an existing session first (so the caller
-- gets a useful 409), but that check is a courtesy: two concurrent requests
-- could both pass it, and neither would notice. The partial unique index is what
-- makes the invariant true. Expired-but-unended rows are closed by the issuing
-- code before the insert, so the index cannot block forever.
CREATE UNIQUE INDEX "SupportSession_one_open_per_actor"
  ON "SupportSession"("actorUserId")
  WHERE "endedAt" IS NULL;

-- A session that has not ended must expire in the future. A row that violates
-- this is a bug in the issuing route, and it is cheaper to refuse it here than
-- to discover a permanently-open support session later.
ALTER TABLE "SupportSession"
  ADD CONSTRAINT "SupportSession_expiry_after_creation" CHECK ("expiresAt" > "createdAt");

-- Only the two modes exist. READ is the default; WRITE is a separate grant.
ALTER TABLE "SupportSession"
  ADD CONSTRAINT "SupportSession_mode_valid" CHECK ("mode" IN ('READ', 'WRITE'));

CREATE TABLE "PlatformAuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetTenantId" TEXT,
    "supportSessionId" TEXT,
    "detail" TEXT NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformAuditLog_createdAt_idx" ON "PlatformAuditLog"("createdAt");
CREATE INDEX "PlatformAuditLog_actorUserId_createdAt_idx" ON "PlatformAuditLog"("actorUserId", "createdAt");
CREATE INDEX "PlatformAuditLog_targetTenantId_createdAt_idx" ON "PlatformAuditLog"("targetTenantId", "createdAt");

-- ── Privileges ─────────────────────────────────────────────────────────────
-- Default privileges cover new tables created by fgmp_migrate, but this
-- migration also runs in environments where they were never configured (a
-- database provisioned before 20261004203149). Grant explicitly, and withhold
-- DELETE from the application role: a support trail that can be deleted by the
-- application is not a trail. Retention is an operator job, run as fgmp_ops.
GRANT SELECT, INSERT, UPDATE ON "SupportSession" TO fgmp_app, fgmp_ops;
GRANT SELECT, INSERT ON "PlatformAuditLog" TO fgmp_app, fgmp_ops;

-- The default privileges from 20261004203149 grant SELECT, INSERT, UPDATE and
-- DELETE on every new table to both roles, so the grants above would be widened
-- a moment after they are issued. Revoke explicitly, or the append-only claim is
-- false.
--
--   PlatformAuditLog : SELECT/INSERT only for both roles. A trail that the code
--                      which writes it can also rewrite (UPDATE) or remove
--                      (DELETE) is not a trail. Retention is an operator job run
--                      as the schema owner, deliberately outside both
--                      application credentials.
--   SupportSession   : no DELETE for the application. UPDATE stays, because a
--                      session is closed by setting endedAt/endReason. `fgmp_ops`
--                      keeps DELETE for housekeeping of ancient rows.
REVOKE DELETE, UPDATE ON "PlatformAuditLog" FROM fgmp_app, fgmp_ops;
REVOKE DELETE ON "SupportSession" FROM fgmp_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261024000000_system_setting_tenant_scope
-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant-scoped system settings.
--
-- ── THE DEFECT THIS FIXES ────────────────────────────────────────────────────
-- "SystemSetting" was a GLOBAL table: `key` was unique platform-wide and there
-- was no tenantId. The settings API, however, is tenant-scoped: PATCH
-- /api/fgmp/settings requires ROLES.ADMIN_ONLY and the handler writes inside
-- `withTenant(me.tenantId, …)`. With no tenant column there was nothing for that
-- context to constrain, so the tenant context was decorative.
--
-- Measured against a live database (two tenants, both with an ADMIN):
--
--   tenant A  PATCH /api/fgmp/settings {"key":"platformName","value":"OWNED-BY-TENANT-A"}
--   tenant B  GET   /api/fgmp/settings?category=BRANDING
--             → "platformName": "OWNED-BY-TENANT-A"
--
-- One tenant administrator could rewrite every other tenant's alarm thresholds,
-- escalation timers and branding. That is a multi-tenant isolation failure in
-- configuration data, not just a cosmetic one: PLATFORM-category keys
-- (sessionTimeoutMin, maxSitesPerTenant, enableOta) are platform policy.
--
-- ── THE MODEL ───────────────────────────────────────────────────────────────
--   tenantId = <tenant>  → that tenant's override. Uniqueness is (tenantId, key).
--   tenantId = NULL      → a platform default inherited by every tenant. Rows in
--                          this state are read-only to the application role;
--                          they are written by the seed/owner path.
--
-- Existing rows are migrated with tenantId = NULL. That is the only safe choice:
-- a global row cannot be attributed to a tenant, and deleting it would destroy
-- configuration. Its value therefore becomes the inherited default, which is
-- exactly what every tenant saw before this migration — no tenant's effective
-- configuration changes on upgrade.
--
-- ── POLICY SHAPE ────────────────────────────────────────────────────────────
--   SELECT      : own rows + platform defaults (NULL). Platform defaults are
--                 non-sensitive by definition — every tenant could read them
--                 before this migration.
--   INSERT      : WITH CHECK requires a tenant match, so `fgmp_app` cannot mint
--                 a new platform-wide default (nor write another tenant's row).
--   UPDATE      : USING restricts which rows may be touched, WITH CHECK stops a
--                 row being re-pointed at another tenant mid-update.
--   DELETE      : same USING clause as UPDATE.
--
-- The FORCE flag matters for the same reason it does everywhere else in this
-- schema: without FORCE the table owner skips its own policies.

-- 1. Column + referential integrity.
ALTER TABLE "SystemSetting" ADD COLUMN "tenantId" TEXT;

ALTER TABLE "SystemSetting"
  ADD CONSTRAINT "SystemSetting_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Uniqueness moves from platform-wide to per-tenant.
--    Dropping the old unique index is required: with it in place, two tenants
--    could not hold the same key, which is the whole point of the change.
DROP INDEX IF EXISTS "SystemSetting_key_key";

CREATE UNIQUE INDEX "SystemSetting_tenantId_key_key" ON "SystemSetting"("tenantId", "key");

-- Lookups are always (tenant, key) or (tenant, category); the NULL-tenant
-- default rows are matched by key, which the composite index still covers as a
-- leading-column prefix (`tenantId IS NULL` is matched by the btree).
CREATE INDEX "SystemSetting_tenantId_category_idx" ON "SystemSetting"("tenantId", "category");

-- 3. Row level security.
ALTER TABLE "SystemSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SystemSetting" FORCE  ROW LEVEL SECURITY;

CREATE POLICY system_setting_read ON "SystemSetting"
  FOR SELECT
  USING (
    "tenantId" IS NULL
    OR "tenantId" = current_setting('app.tenant_id', true)
  );

CREATE POLICY system_setting_insert ON "SystemSetting"
  FOR INSERT
  WITH CHECK (
    "tenantId" IS NOT NULL
    AND "tenantId" = current_setting('app.tenant_id', true)
  );

CREATE POLICY system_setting_update ON "SystemSetting"
  FOR UPDATE
  USING (
    "tenantId" IS NOT NULL
    AND "tenantId" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    "tenantId" IS NOT NULL
    AND "tenantId" = current_setting('app.tenant_id', true)
  );

CREATE POLICY system_setting_delete ON "SystemSetting"
  FOR DELETE
  USING (
    "tenantId" IS NOT NULL
    AND "tenantId" = current_setting('app.tenant_id', true)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261024000100_user_session_epoch
-- ─────────────────────────────────────────────────────────────────────────────
-- Session revocation counter.
--
-- ── THE DEFECT THIS FIXES ────────────────────────────────────────────────────
-- Sessions are JWTs with an 8-hour lifetime and the token carries the user's
-- role and tenant. Nothing re-checked that against the database after sign-in,
-- and the only refresh path (`trigger === "update"`) is an explicit client call.
-- Measured against a live server with a real login cookie:
--
--   1. sign in as REGIONAL_MANAGER                  → /api/fgmp/me role REGIONAL_MANAGER
--   2. UPDATE "User" SET role='READONLY'            → the session still reported
--      and EXERCISED REGIONAL_MANAGER capabilities
--   3. UPDATE "User" SET active=false               → GET /api/fgmp/state 200,
--      GET /api/fgmp/me 200: a deactivated account kept full access until the
--      token expired.
--
-- A password reset had the same problem: the old token stayed valid, so
-- "reset the password because the account may be compromised" did not actually
-- terminate the attacker's session.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- `sessionEpoch` is a per-user counter carried in the token (`sv`). Every
-- authenticated request re-reads {active, role, tenantId, sessionEpoch} from
-- this row (one primary-key lookup on the auth path):
--   * `active = false`      → 401 ACCOUNT_DISABLED
--   * role/tenant changed   → the NEW values are used (no re-login required)
--   * `sessionEpoch` moved  → 401 SESSION_REVOKED
--
-- Existing rows default to 0, and a token minted before this migration has no
-- `sv` claim and is read as 0, so deploying this migration does not sign anybody
-- out. The first bump (password change) does.
ALTER TABLE "User" ADD COLUMN "sessionEpoch" INTEGER NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- 20261024000200_mfa_challenge_login_proof
-- ─────────────────────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────────
-- MFA: a VERIFIED challenge can be exchanged for exactly ONE full session
-- ─────────────────────────────────────────────────────────────────────────────
-- Why this column exists
--
-- `hasMfaEnabled()` was reading `MfaEnrollment` through the ambient (no tenant
-- context) Prisma client. `MfaEnrollment` is FORCE-RLS protected, so that read
-- returned NULL for every user and the login callback never issued a PENDING
-- session: an account with a confirmed TOTP enrolment signed in with the
-- password alone. Measured on the running server: `/api/fgmp/me` returned
-- `role: "ADMIN"`, `mfaPending: undefined` and `/api/fgmp/state` answered 200
-- for an MFA-enrolled account that had presented no second factor.
--
-- The read is now tenant-scoped (`withTenant(tenantId, …)`), which closes the
-- bypass — and immediately exposes the second half of the problem: NOTHING
-- could turn a verified challenge into a real session. `POST /api/fgmp/mfa/
-- challenge` verifies the code and answers `nextStep: "reauthenticate"`, but
-- re-authenticating with the password alone hits the same gate and produces
-- another PENDING session. Enforcing the factor without completing it would
-- lock every enrolled operator out of the platform.
--
-- So the credentials callback now accepts an optional `mfaProof` (the challenge
-- token the operator just verified). It is checked against THIS table and, on
-- success, stamped with `loginIssuedAt`. The conditional update
-- (`loginIssuedAt IS NULL`) is what makes the exchange single-use: the same
-- verified challenge cannot mint a second session, and replaying a stolen token
-- after it has been spent fails.
--
-- Nullable with no default: existing rows simply have no login issued, and the
-- 120-second freshness window is enforced in code so a long-lived verified row
-- cannot be used later.
--
-- Reversible:
--   ALTER TABLE "MfaChallenge" DROP COLUMN "loginIssuedAt";
-- Dropping the column only removes the one-time stamp; every session minted
-- through it keeps working, and the next login simply issues a new challenge.
ALTER TABLE "MfaChallenge" ADD COLUMN "loginIssuedAt" TIMESTAMP(3);

-- ═══════════════════════════════════════════════════════════════════════════
-- Prisma bookkeeping
--
-- These rows are what `prisma migrate deploy` would have written. Without
-- them the next deploy re-applies every migration and fails on the first
-- CREATE TABLE. `checksum` is sha256 of the migration file, byte for byte.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists "_prisma_migrations" (
  id                    varchar(36) primary key not null,
  checksum              varchar(64) not null,
  finished_at           timestamptz,
  migration_name        varchar(255) not null,
  logs                  text,
  rolled_back_at        timestamptz,
  started_at            timestamptz not null default now(),
  applied_steps_count   integer not null default 0
);

-- Least privilege: the application never reads Prisma's bookkeeping, so it
-- gets no privileges on it. Default privileges granted DML at CREATE time;
-- this takes it back. A compromised app role cannot rewrite migration history
-- to make a future deploy skip a migration.
revoke all on "_prisma_migrations" from fgmp_app, fgmp_ops;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-5f014fc195ef675345cdf135899cf5df', '5f014fc195ef675345cdf135899cf5dfcf55e72945c85f4c997cdc8a113f33ca', now(), '20261004203148_init_postgres_baseline', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-834457a0524622e86d25e9bc6a2e1129', '834457a0524622e86d25e9bc6a2e1129b186203ae2db1b47c2bae5c549840de2', now(), '20261004203149_grant_role_privileges', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-2dc66fb9ed7d9c8e81237bcf4efa8a9c', '2dc66fb9ed7d9c8e81237bcf4efa8a9cfe267a9b1fa01953648b7b9907936fa7', now(), '20261005000000_add_tenant_id_not_null_fk', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-1a6aadec7e78dd421290e37e1dc69854', '1a6aadec7e78dd421290e37e1dc698542bccb9e6f5ea3528014162ef0b22560f', now(), '20261005000100_enums_and_decimal', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-457cc4b80861bf3ce49b1f6feb82e5e4', '457cc4b80861bf3ce49b1f6feb82e5e4e82e478764696fa5924afab91ca40796', now(), '20261005000200_fuel_type_add_biofuel', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-88c2e8d163c7d52bd5445784818e6006', '88c2e8d163c7d52bd5445784818e60062f576639ffc8a7ec5b18cbf72f257889', now(), '20261005000300_enable_rls', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-1aff8a3825823e31ef8b85472a7525d7', '1aff8a3825823e31ef8b85472a7525d797ffff57b290c848f6508fbbb964116f', now(), '20261006000000_device_protocol', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-68e06e45aa5e6420ec45c9397195aac9', '68e06e45aa5e6420ec45c9397195aac978646201e299b632bb4a885c5dd67154', now(), '20261006001000_interlock_override', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-baabb578b717892591418d76748555e8', 'baabb578b717892591418d76748555e8053205048818bf43ff984cc927db6a40', now(), '20261006002000_correlation_rules_server_side', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-5ca4240d6b554b02490d729168fe6a9e', '5ca4240d6b554b02490d729168fe6a9ef9d1e61223f59d38367a48dfb5183362', now(), '20261007000000_geography_rls', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-16bfdc6a5fefa1d21ab0e9d84b881737', '16bfdc6a5fefa1d21ab0e9d84b881737cd45c45edf26d16b17873cbb49fd1e88', now(), '20261008000000_interlock_thresholds', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-827c1a5081c95777d5857aa85ea7ec06', '827c1a5081c95777d5857aa85ea7ec06b4436cd15c92a3271a79f6b6992d00f0', now(), '20261008001000_sensor_reading_dedup_watermark', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-d02f4ed17cb555dd5804da261c9e11dc', 'd02f4ed17cb555dd5804da261c9e11dc7475158ef92f4c53470b0dd5a6c4b5fa', now(), '20261008002000_geography_rls_write_path', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-2aa14ab807d551a0b6d9b8a496dacff7', '2aa14ab807d551a0b6d9b8a496dacff72ba19fbed879406c6542d2e4d454019e', now(), '20261008003000_notification_status_no_transport', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-dee75ed79bedbf192229f513516a3ed8', 'dee75ed79bedbf192229f513516a3ed8289e72f858cdc0d80a610fa859d564c8', now(), '20261008004000_solar_battery_phase4', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-400e4d9edf782bcacfbb7b045e158180', '400e4d9edf782bcacfbb7b045e158180f691d49b3cdc409090467c77f8b73cde', now(), '20261009000000_volume_columns_to_decimal', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-b436426c8bab8748417edbcb6ca4f2b3', 'b436426c8bab8748417edbcb6ca4f2b3e4625b0d9378e1336ee7a99f0255744d', now(), '20261009001000_command_idempotency', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-de3b991672ef013e8e2d25bf7edcedc0', 'de3b991672ef013e8e2d25bf7edcedc096f2384d47acd3faa8d3afbd7820a615', now(), '20261009002000_solar_updatedat_default', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-e31565bd66d671f5a501afc8430fd4d6', 'e31565bd66d671f5a501afc8430fd4d63856500f4a9a5e538354a41da8cc9e2e', now(), '20261010002000_correlation_escalation', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-bd2fa0ea7239157862fb214bf08b69e0', 'bd2fa0ea7239157862fb214bf08b69e0b17205e97f3f1fba064b2b2713eed587', now(), '20261011000000_mfa_persistence', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-db50502c5caed6785f1713dee4247c70', 'db50502c5caed6785f1713dee4247c7093f63de7a2ef784c0bd0bce79b46a3c0', now(), '20261012000000_sensor_reading_hypertable', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-b2c98245401f24c824c8d8a90856ba1a', 'b2c98245401f24c824c8d8a90856ba1a53d41fd6e327369dad201aeefd7b41b5', now(), '20261013000000_ingest_ts_source', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-da1f505762d8b5a4dac07ef23a308dcc', 'da1f505762d8b5a4dac07ef23a308dcc494e5377c5757a9c7510d9126324a5d3', now(), '20261014000000_mfa_challenge_resolver', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-e15ad839244eae5e5203648afd0a1253', 'e15ad839244eae5e5203648afd0a1253743421aeb5323ab218223c3d417a2fe1', now(), '20261018000000_dispenser_mac_and_txn_totalizer', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-6ddcf863ed08eef1947ba4bce4c6aac6', '6ddcf863ed08eef1947ba4bce4c6aac6a9b6afe9f45762badbb558d022b7fed3', now(), '20261023000000_platform_support_access', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-bf9dc15d1751448ac47806c24286b5e8', 'bf9dc15d1751448ac47806c24286b5e8dcedc7347e8fd55a084e1f0d4d360d69', now(), '20261024000000_system_setting_tenant_scope', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-5a898e38130e65a0842090640b81f392', '5a898e38130e65a0842090640b81f392ebcb886888cad130a349b7b2fb573d02', now(), '20261024000100_user_session_epoch', null, null, now(), 1)
on conflict (id) do nothing;
insert into "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
values ('mig-e97f07af1e226a61f984c8a938bc2c03', 'e97f07af1e226a61f984c8a938bc2c030eea3ecb5934cf9920ae892923baed0d', now(), '20261024000200_mfa_challenge_login_proof', null, null, now(), 1)
on conflict (id) do nothing;

reset role;

-- ── Post-conditions, as notices rather than claims ─────────────────────────
do $$
declare
  v_tables   integer;
  v_forced   integer;
  v_policies integer;
  v_app_dml  integer;
begin
  select count(*) into v_tables
    from pg_tables where schemaname = 'public';

  select count(*) into v_forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity;

  select count(*) into v_policies from pg_policies where schemaname = 'public';

  -- The app role must be able to read and write, and must NOT own anything.
  select count(*) into v_app_dml
    from information_schema.role_table_grants
   where grantee = 'fgmp_app' and table_name = 'User';

  raise notice 'FGMP schema applied: % tables, % with FORCE RLS, % policies, % DML grants on "User" for fgmp_app.',
    v_tables, v_forced, v_policies, v_app_dml;

  if v_forced < 30 or v_policies < 40 or v_app_dml < 4 then
    raise exception
      'Post-condition failed: expected >=30 FORCE-RLS tables, >=40 policies and 4 DML grants for fgmp_app (got %, %, %).',
      v_forced, v_policies, v_app_dml;
  end if;
end $$;
