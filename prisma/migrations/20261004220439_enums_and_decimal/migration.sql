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
