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
