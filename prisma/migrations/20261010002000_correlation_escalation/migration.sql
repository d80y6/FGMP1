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