> **ARCHIVED — the procedures here were absorbed into
> [`../DEPLOYMENT.md`](../DEPLOYMENT.md).** Kept because it records what was
> measured (timings, restore outputs, PostgreSQL failure modes) at the time.
> Counts in it ("16 migrations") predate the current history.

# FGMP — deployment and backup runbook

Phase 5. Covers the migration-on-deploy model, the schema preflight, and the
backup/restore drill. Written after actually running each path — the numbers and
failure modes below were observed, not inferred.

---

## 1. Deployment model: migrations are a separate job

**The app container never runs migrations.** This is the single most important
operational rule, and it is a security boundary as much as a convenience one.

The web app connects as `fgmp_app`, which is deliberately **not** the schema
owner. If the app process could execute DDL, it would effectively be the owner,
and every row-level-security policy in the project would be decorative — one
injection bug anywhere would inherit owner rights and read every tenant's data.
Least privilege is the reason this is split at all.

### The order

```bash
# 1. Apply migrations (one-shot, owner role, exits non-zero on failure).
docker compose --profile migrate run --rm fgmp-migrate

# 2. Seed a fresh environment (one-shot, owner role). Existing environments
#    skip this — the seed is idempotent and reports {"seeded":false}.
docker compose --profile seed run --rm fgmp-seed

# 3. Start the app with migrations disabled.
FGMP_SKIP_MIGRATE=1 docker compose up -d fgmp-app
```

If step 1 is skipped, the app **refuses to start** (see §2). It never serves a
half-configured platform.

### Why not `prisma db push`

`db push` reconciles the live schema to `schema.prisma` and records nothing. It
can silently drift the database away from the committed migration history, and
two environments will then disagree for reasons nobody can reconstruct later.
The 16 committed migrations under `prisma/migrations/` are the authority;
`migrate deploy` applies exactly those, in order, and is a no-op when they are
already applied — which is what makes it safe on every boot.

### Cost of a migration run

**Measure the shape, not the absolute number.** On the low-CPU host used to
develop this, `prisma migrate deploy` took **~3m15s wall clock** while consuming
only **~9s of user CPU**. That ratio is the signal: essentially all of it is CLI
and engine startup, not network and not the migrations themselves. On production
hardware it will be far quicker, and it will vary with load.

Two consequences worth planning around:

- **Do not put a migration in the app's start path.** A container that blocks
  three minutes on boot trips orchestrator start-up probes and looks like a
  crash-loop. `FGMP_SKIP_MIGRATE=1` plus a separate job avoids this entirely.
- **Budget a migration window** when a migration touches large tables. A
  `CREATE INDEX` that is not `CONCURRENTLY` takes an `ACCESS EXCLUSIVE` lock
  and will block reads for its duration. None of the current 16 do this, but a
  future one might.

---

## 2. The schema preflight (`FGMP_SKIP_MIGRATE=1`)

With migrations delegated to another job, there is a specific dangerous case:
the credential was valid, migrations were skipped, and the target database turns
out to be **empty**. Without a check the container starts, reports healthy, and
the failure only appears on the first real request as
`relation "Site" does not exist` — the worst shape for an incident, because the
orchestrator reports green and the outage surfaces under traffic.

`scripts/db-preflight.mjs` runs `SELECT to_regclass('public."Tenant"')` before
the server starts. This is a **SELECT**, so it needs no owner rights and does
not weaken the boundary above. `Tenant` is created by the first baseline
migration and never dropped, so its absence means the schema genuinely is not
there.

Verified in three states:

| Database state | Result |
|---|---|
| Migrated | `[preflight] OK — schema marker "Tenant" is present` → starts |
| Empty | `table "Tenant" does not exist — this database has no schema…` → **refuses to start** |
| Unreachable | `cannot verify the schema — Can't reach database server at …` → **refuses to start** |

The unreachable case matters as much as the empty one, and produces a different
message on purpose: "no schema" and "cannot reach the database" need completely
different operator responses.

> Implementation note: the runtime image is `oven/bun:1-slim`, which ships **no
> PostgreSQL client binaries** — `psql` and `pg_dump` are both absent (verified).
> The preflight therefore uses the generated Prisma client, which is already in
> the image. A hand-rolled wire-protocol client was tried first and was not
> worth the fragility.

---

## 3. Backups

Phase 0 removed the `/api/fgmp/backup*` surface because it served a
byte-for-byte copy of the whole database to **any tenant ADMIN** — every
tenant's users, bcrypt password hashes, alarms and audit log in one file.
Removing that breach was correct, but it also removed the only backup path the
project had. This is the replacement.

### Two properties that make it safe

1. **The dump leaves the app network.** It runs as a separate one-shot container
   talking to `fgmp-db` over the internal compose network. There is no HTTP
   route, so no authenticated user — of any role — can trigger, download or
   restore a dump. That is the entire difference from what Phase 0 removed.
2. **It uses `fgmp_ops`, which is `BYPASSRLS`.** A dump taken as `fgmp_app`
   would export only what the RLS policies let that role see, which is
   nothing — an RLS-scoped dump is *silently incomplete*, and restoring from it
   loses every other tenant's rows. Restoring tenant data requires bypassing
   RLS, so the dump must too. `fgmp_ops` exists for exactly this and is never
   given to the app.

### Running one

```bash
docker compose -f docker-compose.yml -f docker-compose.backup.yml \
  --profile backup run --rm fgmp-backup
```

Output is a timestamped custom-format dump plus a SHA-256 sidecar:

```
fgmp-backup: starting dump of fgmp as fgmp_ops (BYPASSRLS)
fgmp-backup: wrote /backups/fgmp-20261007T173010Z.dump (236022 bytes)
fgmp-backup: pruning dumps older than 14 days
fgmp-backup: done. Current contents of /backups:
-rw-r--r-- 1 root root 231K Oct  7 17:30 fgmp-20261007T173010Z.dump
-rw-r--r-- 1 root root   93 Oct  7 17:30 fgmp-20261007T173010Z.dump.sha256
```

`--format=custom` is deliberate: it is compressed, and `pg_restore --table` can
restore selectively instead of forcing a whole-database replace.
`--serializable-deferrable` takes a consistent snapshot without blocking writers.

Retention is 14 days by default (`BACKUP_RETENTION_DAYS`) and prunes on
mtime, so a restored-from-an-older-backup file is not deleted out from under you.

### Scheduling

The compose service is one-shot and does not schedule itself. Run it from the
host's scheduler — a systemd timer or cron entry such as:

```cron
17 2 * * *  cd /srv/fgmp && docker compose -f docker-compose.yml -f docker-compose.backup.yml --profile backup run --rm fgmp-backup >> /var/log/fgmp-backup.log 2>&1
```

Pick an off-peak minute, and monitor it: a backup job that fails silently for a
month is the failure mode this is meant to prevent.

---

## 4. The restore drill

**A backup that has never been restored is not a backup, it is a hope.** Run
this regularly — monthly is reasonable — against a throwaway database.

```bash
docker compose -f docker-compose.yml -f docker-compose.backup.yml \
  --profile backup run --rm fgmp-backup-restore
```

It takes the newest dump, **verifies its checksum first**, restores into
`fgmp_restore_probe`, reads back row counts, then drops the probe. Nothing
touches the live database.

### Verified output

```
fgmp-backup-restore: restoring /backups/fgmp-20261007T173010Z.dump into fgmp_restore_probe
fgmp-20261007T173010Z.dump: OK
fgmp-backup-restore: checksum OK
DROP DATABASE
CREATE DATABASE
GRANT
fgmp-backup-restore: verifying restored contents…
Tenant      9
Site        53
User        7
FuelTank    85
Alarm       0
AuditLog    10
SensorRead  23
DROP DATABASE
fgmp-backup-restore: PASS — dump restores and contains readable data. Probe database dropped.
```

Exit code 0. Those counts match the live database at the time of the dump, so
the restore is a verified claim rather than an exit code. `Alarm 0` is correct
here — no alarms had fired in that window.

### Two roles, on purpose

| Role | Used for | Why |
|---|---|---|
| `fgmp_ops` | the restore itself | `BYPASSRLS`, so tenant rows actually come back. Has **no** `CREATEDB` — it exists to dump and restore, never to create databases. |
| `fgmp_migrate` | create/drop the probe database | Is the owner and has `CREATEDB`. Never used for the dump, never in the app. |

### Two PostgreSQL behaviours that will bite you

Both were hit during verification, and both produce misleading errors if you do
not know about them:

1. **`GRANT CREATE ON SCHEMA public` is required before `pg_restore`.**
   PostgreSQL 15+ ships the `public` schema with `USAGE` only. Without the
   grant the restore emits ~70 × `permission denied for schema public`, followed
   by a cascade of ~365 × `relation "public.Site" does not exist` — because the
   *policies* are restored before the tables they reference exist. The symptom
   points at RLS; the cause is the missing schema privilege. The drill grants it
   on the throwaway database only.
2. **`COMMENT ON SCHEMA public` fails** with `must be owner of schema public`,
   because that object belongs to the migrate role. Harmless, so the drill uses
   `--no-comments`. This matters for more than tidiness: a drill that always
   prints a wall of expected errors trains you to ignore the output, and then
   it does not tell you when something real breaks.

---

## 5. Recovery objectives

Not yet agreed, and they should be, because they determine the retention window
and the schedule:

| Objective | Current | Comment |
|---|---|---|
| RPO | ≤ 24 h at the default daily schedule | A tighter objective needs more frequent runs or WAL archiving. |
| RTO | Unmeasured | Time to restore was not measured under load; the drill ran against a ~250 KB database. A production-sized restore will be slower, and `SensorReading` is the table that grows fastest. |

A `SensorReading` retention policy does not exist yet, so the dump grows without
bound between prunes. That is the most likely reason a future drill gets slow.
