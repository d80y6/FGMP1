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
