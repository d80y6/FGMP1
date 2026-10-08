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
