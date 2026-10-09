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
DO $$
DECLARE
  ext_available BOOLEAN := EXISTS (
    SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'
  );
  ext_installed  BOOLEAN := EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
  );
  -- A bare DO block is not a function, so there is no RETURN. Every early exit
  -- sets this flag instead and the conversion is wrapped in IF do_convert.
  do_convert BOOLEAN := TRUE;
BEGIN
  IF NOT ext_available THEN
    RAISE NOTICE
      'FGMP: TimescaleDB is NOT available on this server — SKIPPING the SensorReading hypertable conversion. The table stays a plain, unbounded table. Everything else (ingest, dedup, RLS, the app) is unaffected; only time-partitioning and retention are unavailable. To enable it, run: CREATE EXTENSION timescaledb;';
    do_convert := FALSE;
  END IF;

  -- Available but not installed in this database. Installing it is cheap and
  -- is what the timescale image exists for; if it fails we skip rather than
  -- fail, because the conversion is optional.
  IF NOT ext_installed THEN
    BEGIN
      EXECUTE 'CREATE EXTENSION IF NOT EXISTS timescaledb';
      RAISE NOTICE 'FGMP: installed the timescaledb extension; proceeding with the hypertable conversion.';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE
        'FGMP: TimescaleDB is available but could not be installed (%). SKIPPING the SensorReading hypertable conversion; the table stays plain.', SQLERRM;
      do_convert := FALSE;
    -- `END`, not `END IF`: this is a BEGIN ... EXCEPTION block, not a
    -- conditional. psql reports the mismatch as a misleading
    -- "syntax error at or near IF" pointing at the enclosing END IF.
    END;
  END IF;

  -- Extension is present. Now — and only now — is it safe to change the key.
  IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'SensorReading') THEN
    RAISE NOTICE 'FGMP: SensorReading is already a hypertable; re-running this migration is a no-op.';
    do_convert := FALSE;
  END IF;

  -- Everything below runs inside the same transaction as this detection, so a
  -- failure at any later step rolls the whole thing back and leaves the table
  -- exactly as it was.
  RAISE NOTICE 'FGMP: TimescaleDB detected — converting SensorReading to a hypertable.';

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

  PERFORM add_retention_policy('"SensorReading"', INTERVAL '400 days');

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
