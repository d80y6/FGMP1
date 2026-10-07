-- Correct the solar tables' updatedAt columns, as a SEPARATE migration.
--
-- ── WHY THIS IS NOT AN EDIT OF 20261008004000_solar_battery_phase4 ────────────
-- Commit 5946c47 fixed a boot-breaking bug by adding a DEFAULT to updatedAt
-- DIRECTLY IN the solar migration — which had already been applied. Prisma
-- treats an applied migration as immutable and records its checksum, so editing
-- it afterwards makes `prisma migrate dev` fail for every developer with
-- "the migration was modified after it was applied", offering to RESET a shared
-- database. That is worse than the original defect: it blocks all migration
-- work, not just this one.
--
-- The fix itself was correct and necessary — POST /api/fgmp/solar-sites was
-- returning 500 with `Null constraint violation on the fields: (updatedAt)`
-- because Prisma's @updatedAt is applied by the client, leaving the raw column
-- unable to satisfy NOT NULL for any non-Prisma write.
--
-- So: the as-applied migration has been restored to the content that was
-- actually executed, and the correction lives here, where a fresh database
-- replaying from empty will pick it up in the right order.
--
-- ── IDEMPOTENT ────────────────────────────────────────────────────────────────
-- SET DEFAULT is a no-op when the default already exists, so this is safe to
-- run against a database that received the fix via the edited file, or via a
-- manual ALTER, or not at all.

ALTER TABLE "SolarSite"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "SolarArray"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- Fail loudly rather than silently leaving a NOT NULL column with no default,
-- which is the defect this migration exists to close. Without this check the
-- migration would report success on a database where the columns were dropped
-- or renamed, and the P2011 would simply reappear later.
DO $$
DECLARE
  missing_default TEXT;
BEGIN
  SELECT string_agg(c.relname || '.' || a.attname, ', ')
    INTO missing_default
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('SolarSite', 'SolarArray')
    AND a.attname = 'updatedAt'
    AND a.atthasdef = false;

  IF missing_default IS NOT NULL THEN
    RAISE EXCEPTION 'updatedAt still has no DEFAULT on: %', missing_default;
  END IF;
END $$;
