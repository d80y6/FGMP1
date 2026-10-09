-- Add tsSource to SensorReading.
--
-- ── WHY THIS IS HAND-WRITTEN ────────────────────────────────────────────────
-- `prisma migrate dev --create-only` generated:
--
--   DROP INDEX "SensorReading_ts_idx";
--   ALTER TABLE "SensorReading" DROP CONSTRAINT "SensorReading_pkey",
--     ADD COLUMN "tsSource" TEXT NOT NULL DEFAULT 'DEVICE',
--     ADD CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("id");
--
-- That would be WRONG on a TimescaleDB server, where migration
-- 20261012000000_sensor_reading_hypertable made this table a hypertable with
-- PRIMARY KEY (id, ts). Reverting the primary key to ("id") undoes the
-- hypertable conversion's defining requirement, and dropping the index is
-- unrelated to this change.
--
-- schema.prisma still says `id @id` because Prisma cannot express a partition
-- key in a composite primary key, so it will keep generating this destructive
-- form. This migration therefore adds the column and nothing else, and the
-- hypertable migration owns the primary key.
--
-- ── BACKFILL NOTE ────────────────────────────────────────────────────────────
-- The default is 'DEVICE', not 'SERVER', deliberately. Every EXISTING row was
-- stamped by a device that supplied `ts` (that was the only path that could
-- produce a duplicate-resistant row before this change), so marking them
-- SERVER would fabricate doubt about historical data. New undated readings are
-- what tsSource is actually for, and they are marked at write time.

ALTER TABLE "SensorReading" ADD COLUMN IF NOT EXISTS "tsSource" TEXT NOT NULL DEFAULT 'DEVICE';

-- Verification: the hypertable primary key must be (id, ts) and the column
-- must exist. If the PK reads ("id") alone, the hypertable was reverted.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.relname = 'SensorReading'
      AND NOT i.indisprimary
      AND i.indkey::text = '2'
  ) THEN
    RAISE EXCEPTION 'unexpected secondary index layout on SensorReading';
  END IF;
END $$;

COMMENT ON COLUMN "SensorReading"."tsSource" IS
  'Where the identity of this reading came from: DEVICE (real measurement time, dedup guarantee applies) or SERVER (device supplied no ts; the timestamp is arrival time and this row is NOT deduplicable).';
