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
