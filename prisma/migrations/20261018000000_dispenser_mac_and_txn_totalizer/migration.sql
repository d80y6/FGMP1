-- Conformity migration for the technical proposal (FGMP presentation):
--
--  * §8.17 — the pump card shows the industrial controller identity
--    (MAC, IP, Modbus address, baud rate). Adds the MAC column.
--  * §8.17 — the fill-operations table has a عدّاد (counter) column.
--    The counter is the pump's cumulative totalizer AT COMPLETION, so
--    each transaction records it; historical rows stay NULL (they are
--    seed rows from before the column existed).
--
-- Both columns are additive and nullable, so the migration is safe to
-- run on a populated database with no data rewrite.

ALTER TABLE "FuelDispenser" ADD COLUMN "macAddress" TEXT;

ALTER TABLE "FuelTransaction" ADD COLUMN "totalizerLitres" DECIMAL(12, 3);
