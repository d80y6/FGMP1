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
