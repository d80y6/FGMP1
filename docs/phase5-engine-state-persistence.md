# Phase 5 — engine state persistence, and the hypertable blocker

Answers two questions that were previously left as judgement calls:
**is persisting engine state on tick viable?** and **what exactly blocks
`SensorReading` from becoming a hypertable?**

Both are answered with measurements and with the actual constraint text, so the
next person does not re-derive either.

---

## Part 1 — Engine state is loaded once and is NOT persisted

Stated plainly, because the harm is real and it is not visible from the code:

- The engine reads sites, tanks, generators, batteries, dispensers, gateways and
  IoT devices **once**, in `init()`.
- `tick()` mutates those **in-memory** objects.
- It does **not** write the live telemetry back to `FuelTank`, `Generator`,
  `BatteryBank` or `FuelDispenser`.

Two consequences:

1. **A restart reverts every asset to its seeded value.** A tank drawn down
   across a shift reads full again after a deploy.
2. **Two replicas diverge silently.** Replica A ticks its own copy and replica B
   ticks its own; neither reads the other. Only one replica advances the clock —
   the tick is guarded by `pg_try_advisory_xact_lock` in `scheduler.ts:286` — so
   the other replica's copy simply never moves rather than being overwritten.
   Two operators can look at the same site and see different levels, and neither
   is lying.

The persisted history is `SensorReading`, appended by the ingest path. That is
where a restart's telemetry is recoverable from. The denormalised "current
level" columns on the asset tables are **not** a record of anything the engine
produced.

This is now documented in code at both points that matter — `init()` and
`tick()` — as a greppable block, so nobody has to discover it by noticing a tank
that moved backwards.

### Does writing on tick fit in the budget? — measured, not estimated

Live asset counts at the time of measurement: **53 sites, 85 tanks, 77
generators, 52 batteries, 24 dispensers = 238 assets**.

At a 5 s cadence that is **47.6 rows/sec, 14,280 rows/min, 857k rows/hour**.

Prototype: `scripts/measure-tick-persistence.ts` — replays the exact UPDATE set
a persisting tick would issue, against the live database, holding the same
advisory lock the scheduler uses.

| Variant | Shape | ms/tick | % of the 5 s budget | Verdict |
|---|---|---|---|---|
| **A** | row-at-a-time, autocommit per statement | **24,451** | **489%** | **OVER BUDGET** |
| **B** | row-at-a-time, one transaction holding the lock | **29,896** | **598%** | **OVER BUDGET** |
| **C** | 4 set-based `UPDATE ... FROM (VALUES …)` per tick | **1,052** | **21%** | **OK** |

**The naive implementation is ~5x over budget** — a 5-second tick would take
24 seconds, and the tick would overlap itself. This is not a rounding concern; it
is the difference between a working monitor and one that wedges.

**Conclusion: persisting on tick is viable, but only in the batched form.** The
per-row round trip is what costs, not the rows: variant C writes the same 238
rows in a quarter of the time variant A does, because it is 4 statements instead
of 238 round trips.

If this is done, it must be variant C. Anything row-at-a-time is a
non-starter at this asset count, and the number to beat is 5,000 ms.

### A measurement trap worth recording

The first version of variant C used `unnest($1::text[], $2::numeric[], …)` with
`$executeRawUnsafe`. That is **silently invalid under Prisma**: the driver
passes a JS array as a *single* parameter, so the query fails with
`incorrect number of parameters. Expected: 3, actual: 1`. Because the prototype
wrapped its work in a `catch`, that surfaced as `rows=0` — which reads exactly
like "the advisory lock was never acquired", and sent the investigation down the
wrong path twice.

The working form builds an explicit `VALUES` list with `Prisma.join`, giving one
bind parameter per element. It was verified to update 85/85 rows before being
timed.

Worth stating plainly: **a measurement that reports zero is not a measurement.**
The harness now distinguishes `FAILED:` from `VERDICT:` so this cannot be
mistaken for a result again.

### Not done, deliberately

Variant C is proven viable and is *not* landed. Writing it into `tick()` means
deciding what happens when the write fails mid-tick — whether the tick aborts,
whether state diverges further, and how that is surfaced. That is a behavioural
decision about the monitoring path, not a performance one, and it belongs with
the Lead rather than inside a measurement commit.

---

## Part 2 — Why `SensorReading` is not a hypertable yet

`docker-compose.yml` runs the `timescale/timescaledb` image, but
`create_hypertable` appears nowhere in the repo. `SensorReading` is a plain,
unbounded table.

### The blocker, precisely

A TimescaleDB hypertable requires that **every unique constraint and primary
key on the table includes the partitioning column**. `SensorReading` is
partitioned by time (`ts`), and its primary key is:

```prisma
model SensorReading {
  id          String   @id @default(cuid())
  // ...
  ts          DateTime @default(now())
}
```

`id` is a cuid and does **not** include `ts`, so `id PRIMARY KEY` cannot
coexist with `create_hypertable(..., partitioning_column => 'ts')`. Converting
the table therefore requires **changing the primary key strategy**, not just
adding an extension call.

### Why that is not a small change

The primary key is load-bearing for duplicate protection.
Migration `20261008001000_sensor_reading_dedup_watermark` makes
`(entityId, metric, ts)` **UNIQUE** and documents, at length, why the database —
not Redis, not process memory — is the authority for rejecting replayed
telemetry. The reasoning depends on the storage engine enforcing the constraint
on every writer on every replica with no shared mutable state to keep in step.

Any hypertable migration must therefore preserve:

1. **The `(entityId, metric, ts)` unique constraint.** It already contains the
   partitioning column, so it survives the conversion — but it must be
   re-created as a hypertable-aware constraint, and on a partitioned table a
   unique constraint's behaviour with `NULL` and with concurrent inserts across
   chunks must be re-verified rather than assumed.
2. **The ingest watermark's assumption that a duplicate is a constraint
   violation.** The ingest route translates a unique violation into a
   `REJECT_DUPLICATE` verdict. If the constraint changes shape, that translation
   is what has to keep working — and it is covered by a test, so a regression
   would be caught, but it would be caught late.
3. **The `id` primary key.** Either it moves to `(ts, id)`, which changes every
   `findUnique({ where: { id } })` in the codebase, or `id` is dropped in favour
   of a natural key — which is a larger design change than it appears, because
   `id` is referenced from `history/[entityId]`-style routes.

### The open question nobody should guess at

**Does `create_hypertable` reject a table whose primary key omits the
partitioning column, or silently drop/rewrite that constraint?**

The answer determines whether step 1 of the migration is "add a composite
primary key" or "drop the primary key". It is a one-line experiment against the
live TimescaleDB image, and it should be run before any migration is written —
not discovered halfway through one.

Until that is answered, the table stays as it is. It is a correct, ordinary,
unbounded table. It is not corrupt; it is simply not yet time-partitioned, and
the cost of that is storage growth rather than incorrect data.

---

## What is actually correct today

- Volume is `Decimal(12,3)`; money is `Decimal`. The Float/Decimal boundary is
  documented at the top of `schema.prisma` — the test is whether a value
  accumulates or participates in a reconciliation, not how important it looks.
- Telemetry history (`SensorReading`) is durable and is written by the ingest
  path. What is missing is the denormalised current-level cache, not the record.
- The RLS boundary is real: 24 tables with `tenant_id NOT NULL`, FKs to
  `Tenant(id) ON DELETE RESTRICT`, and no catch-all grants.

## How to reproduce the measurement

```bash
MEASURE_TICKS=10 bun scripts/measure-tick-persistence.ts C   # batched    (~1.0 s/tick)
MEASURE_TICKS=3  bun scripts/measure-tick-persistence.ts A   # row-at-a-time (~24.5 s/tick)
MEASURE_TICKS=3  bun scripts/measure-tick-persistence.ts B   # row-at-a-time in a txn (~29.9 s/tick)
```

The prototype writes real values into the demo asset rows. The database holds
regenerable seed data only, but reset the levels if you care about the demo
looking plausible:

```sql
UPDATE "FuelTank" SET "currentLitres" =
  round(("capacityLitres" * (0.15 + (random() * 0.75)))::numeric, 3);
```
