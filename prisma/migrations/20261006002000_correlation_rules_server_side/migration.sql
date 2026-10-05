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
