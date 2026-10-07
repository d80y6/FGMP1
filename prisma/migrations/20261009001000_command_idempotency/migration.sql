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