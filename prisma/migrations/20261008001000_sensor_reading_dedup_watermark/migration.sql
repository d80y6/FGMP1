-- Phase 4, item 4 — make the ingest watermark durable and cross-replica.
--
-- WHY THE DATABASE IS THE AUTHORITY, not Redis and not process memory
-- -----------------------------------------------------------------------
-- The process-local watermark store could reject a replayed reading on replica
-- A and ACCEPT the very same replay on replica B, because neither replica could
-- see the other's state. That defeats the only property the buffering exists to
-- provide.
--
-- A cache cannot be the authority: Redis can be evicted, flushed, partitioned,
-- fail over or simply be absent, and a miss on a stale or empty cache entry lets
-- a duplicate straight through. Any design where the duplicate check depends on
-- a cache is a design whose guarantee disappears exactly when the cache does.
--
-- A unique constraint has the opposite property. It is enforced by the storage
-- engine on every writer, on every replica, with no shared mutable state to keep
-- in step, and it keeps holding during a total Redis outage because it does not
-- depend on Redis existing. Redis remains usable as a read-through cache in
-- front of this, never as the thing that decides.
--
-- MAKING A DUPLICATE IMPOSSIBLE RATHER THAN UNLIKELY
-- ---------------------------------------------------
-- (entityId, metric, ts) was already indexed, but NON-uniquely, so a device that
-- retried after a dropped response could insert the same measurement twice.
-- UNIQUE means exactly one of two racing replicas wins the insert and the other
-- gets a constraint violation, which the ingest route translates into the same
-- REJECT_DUPLICATE verdict the process-local store produced. The race becomes a
-- non-event rather than something to be detected after the fact.
--
-- BACKFILL
-- ---------
-- The migration is additive and does not need a data backfill: the constraint
-- is satisfied by every row already in the table (verified: 0 duplicate
-- (entityId, metric, ts) groups before this migration runs).
--
-- What DOES need a backfill is the process-local watermark cache, which starts
-- empty on every deploy. Without priming it, the first request after a restart
-- would see an empty watermark and accept a reading that is older than what is
-- already stored — a regression the moment this deploys. Priming is therefore
-- part of this change and is exercised by the ingestion route on first use.

-- Promote the existing index to UNIQUE. DROP first because CREATE UNIQUE would
-- otherwise fail with "relation already exists" under the old index's name.
DROP INDEX IF EXISTS "SensorReading_entityId_metric_ts_idx";

CREATE UNIQUE INDEX "SensorReading_entityId_metric_ts_key"
  ON "SensorReading" ("entityId", metric, ts);

COMMENT ON INDEX "SensorReading_entityId_metric_ts_key" IS
  'Phase 4 item 4: enforces at-most-once ingest per (entity, metric, timestamp). '
  'This is the authority for duplicate rejection; any cache in front of it is an '
  'optimisation, not the guarantee.';
