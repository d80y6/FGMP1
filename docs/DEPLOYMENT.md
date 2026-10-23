# Deployment

How to run FGMP with Docker Compose or Render, how migrations and seeding are
split from the app, and how to back up and restore. Every command here was run
against this repository's compose files.

## 1. The deployment model: three one-shot jobs, one long-running app

The app connects as `fgmp_app`, which is deliberately **not** the schema owner.
If the app process could run DDL it would effectively be the owner, and every
row-level-security policy would be decorative. Migrations, seeding and backups
therefore run as separate one-shot containers with their own credentials.

| Job | Profile | Role used | Runs |
|---|---|---|---|
| `fgmp-migrate` | `migrate` | `fgmp_migrate` (owner) | `prisma migrate deploy` |
| `fgmp-seed` | `seed` | `fgmp_migrate` (owner) | `bun run db:seed` (idempotent) |
| `fgmp-backup` | `backup` (in `docker-compose.backup.yml`) | `fgmp_ops` (`BYPASSRLS`) | `pg_dump` + checksum |
| `fgmp-app` | — | `fgmp_app` (non-owner, RLS enforced) | Next.js standalone server |

The app starts with `FGMP_SKIP_MIGRATE=1` and **never receives the owner URL**.
At boot, `scripts/docker-entrypoint.mjs` runs `scripts/db-preflight.mjs`, a
SELECT-only check that the expected tables exist. If the schema is missing the
container exits with an explanation instead of serving a half-configured
platform. Migration credentials are not needed for this check.

## 2. First deployment (Compose)

```bash
cp .env.example .env
# fill in every REQUIRED variable — see §3

# 0. Check the environment before starting anything. Same rules as boot:
#    [error] would stop the server, [warn] degrades one feature.
bun run check:env

# 1. Apply the committed migrations
docker compose --profile migrate run --rm fgmp-migrate

# 2. Create the demo topology / first tenant (idempotent)
docker compose --profile seed run --rm fgmp-seed

# 3. Start the stack
docker compose up -d --build
```

The UI is on <http://localhost:3151>. The broker is on `127.0.0.1:1885`, and
PostgreSQL is reachable only on `127.0.0.1:5433` for local tooling.

Seeding is a deploy-time step, not something the web app does on first request:
it spans tenants and creates them, so it needs the owner role. Keeping it out of
`bootstrap()` is why the app can run without that credential. (Platform
administration at runtime — the tenant list, support sessions, grants — does NOT
need that role: it runs as `fgmp_app` and reads one tenant at a time. See
`docs/SUPERADMIN.md`.)

### Creating the first administrator

`fgmp-seed` creates demo users, but a fresh production tenant usually needs one
explicit admin:

```bash
docker compose exec fgmp-app bun run seed:admin
# defaults to admin@fgmp.ye with a well-known password — change it immediately
ADMIN_EMAIL=ops@example.ye ADMIN_PASSWORD='…' docker compose exec \
  -e ADMIN_EMAIL -e ADMIN_PASSWORD fgmp-app bun run seed:admin
```

The script is idempotent: it creates the user or repairs the hash/role/active
flag. It never deletes a user.

### Subsequent deployments

```bash
docker compose --profile migrate run --rm fgmp-migrate
docker compose up -d --build
```

`migrate deploy` applies exactly the committed migrations in order and is a
no-op when they are current. Do **not** use `prisma db push`: it reconciles the
live schema without recording anything, so environments drift from the migration
history and two deployments then disagree for reasons nobody can reconstruct.

**Budget a window for large migrations.** A `CREATE INDEX` that is not
`CONCURRENTLY` holds `ACCESS EXCLUSIVE` and blocks reads for its duration. Do not
put a migration in the app's start path: a container that blocks on boot trips
orchestrator health probes and looks like a crash loop.

## 3. Required configuration

`.env.example` documents each variable. The ones with no safe default:

| Variable | Why it is required |
|---|---|
| `PGMIGRATE_PASSWORD`, `PGAPP_PASSWORD`, `PGOPS_PASSWORD` | Three distinct roles: owner/migrate, app (RLS), ops (BYPASSRLS). The compose DB refuses to start without them. |
| `NEXTAUTH_SECRET` | Signs session JWTs. `openssl rand -base64 32`. |
| `NEXTAUTH_URL` | Canonical origin; callback URLs depend on it. |
| `IOT_API_KEY` | Shared secret for device ingest. Minimum 16 characters; the route returns 503 when absent. `openssl rand -hex 32`. |
| `REALTIME_SERVICE_TOKEN` | Authenticates the IoT bridge on `/api/fgmp/realtime/snapshot`. |
| `APINATOR_APP_ID`, `APINATOR_KEY`, `APINATOR_SECRET`, `APINATOR_CLUSTER` | Hosted realtime channels (server-side emit + channel auth). |
| `NEXT_PUBLIC_APINATOR_APP_KEY`, `NEXT_PUBLIC_APINATOR_CLUSTER` | Browser subscription. `NEXT_PUBLIC_*` values are baked at build time — changing them requires a rebuild. In Docker they are passed as **build args** (the Dockerfile declares the ARGs and compose forwards them from `.env`); supplying them only at runtime produces a bundle with an empty app key and realtime silently disabled. |
| `FGMP_MFA_ENCRYPTION_KEY` | Encrypts TOTP secrets at rest. Changing it invalidates every enrolment. The app starts without it but MFA enrolment is refused (reported at boot). |
| `REDIS_URL` | Optional. Shared rate-limit store. Without it limits are per-process and the app reports `fgmp_rate_limit_degraded=1`. Compose provides `fgmp-redis`. |

`FGMP_REQUIRE_RLS` defaults to `1`. Leave it on: the startup check refuses a
connection whose role bypasses RLS, which is the last line of defence against a
misconfigured `DATABASE_URL` silently disabling tenant isolation.

### Hosted PostgreSQL connection budget

Prisma otherwise creates a pool sized from the host's reported CPU count for
every `PrismaClient`. That is a poor default for Netlify Functions: each warm
function instance can keep its own pool open, and this app also has narrowly
scoped ops/auth clients. With a hosted database capped at 15 concurrent
connections, a few simultaneous function instances and several `new
PrismaClient()` call sites can consume the whole allowance before the dashboard
loads.

The app now adds bounded Prisma URL parameters unless explicitly supplied:

- Netlify / AWS Lambda / Vercel: app `connection_limit=1`; shared privileged
  client `connection_limit=1`.
- Long-lived app server: app limit 3; shared privileged ops client limit 1.
- `FGMP_DB_CONNECTION_LIMIT` and `FGMP_DB_POOL_TIMEOUT` override defaults; URL
  values always take precedence.
- Auth, audit, scheduler, seed, health and the site→tenant realtime resolver
  reuse a process-wide privileged client per DSN instead of each opening its
  own Prisma pool.

This is a per-function/process cap, not a global cap across serverless
instances. Keep the deployment's aggregate function concurrency below the
provider's database connection allowance; if it must scale beyond that, place a
managed pooler in front of Postgres and confirm it supports the app's
transaction-local RLS context before switching the connection mode.

`FGMP_SIMULATION` enables synthetic telemetry and starts the scheduler. It is
ignored when `NODE_ENV=production`, and `assertSimulationAllowed()` is the single
gate. A deployment without field devices should look empty, not realistic.

## 4. Render

`render.yaml` defines the web service and the IoT bridge. There is deliberately
no realtime service: realtime is hosted by Apinator and browsers connect to it
directly.

1. Push the repository and create a Blueprint from `render.yaml`.
2. Set the `sync: false` variables in the dashboard.
3. Run the migration job once before the first deploy, and after every deploy
   that adds a migration.

The blueprint creates a **job** service for this. From the dashboard, open
`fgmp-migrate` → *Run job*. It executes `bun run db:deploy` with the owner URL,
which is supplied only to that job.

If you prefer a Render Shell, `bun run db:deploy` works there too — but only if
the shell's environment has the owner URL. Do not add it to the web service.

`healthCheckPath` is `/api/health/ready` — unauthenticated, and it fails until
the database is reachable and the migrations are applied. Do **not** point it at
`/api/fgmp/health`: that route is ADMIN-only by design (process and database
internals) and would 401, marking a healthy service down.

## 5. Backups

Phase 0 removed the `/api/fgmp/backup*` routes: they served a byte-for-byte copy
of the whole database to **any tenant ADMIN** — every tenant's users, password
hashes, alarms and audit log in one file. The replacement is a one-shot
container, not an HTTP endpoint.

```bash
docker compose -f docker-compose.yml -f docker-compose.backup.yml \
  --profile backup run --rm fgmp-backup
```

Output is a timestamped custom-format dump plus a SHA-256 sidecar in the
`fgmp-backups` volume; retention defaults to 14 days (`BACKUP_RETENTION_DAYS`).

Why the ops role: a dump taken as `fgmp_app` would export only what RLS lets
that role see — nothing — so it would be *silently incomplete*. `fgmp_ops`
exists to dump and restore, has `BYPASSRLS`, and is never given to the app.

Schedule it from the host, not from the app:

```cron
17 2 * * * cd /srv/fgmp && docker compose -f docker-compose.yml -f docker-compose.backup.yml --profile backup run --rm fgmp-backup >> /var/log/fgmp-backup.log 2>&1
```

Monitor the job. A backup that fails silently for a month is the failure mode
this exists to prevent.

### Restore drill

**A backup that has never been restored is not a backup.** Run this monthly:

```bash
docker compose -f docker-compose.yml -f docker-compose.backup.yml \
  --profile backup run --rm fgmp-backup-restore
```

It picks the newest dump, verifies the checksum, restores into a throwaway
`fgmp_restore_probe` database, reads back row counts and drops the probe. The
live database is never touched.

Two PostgreSQL behaviours that will otherwise confuse you:

* `GRANT CREATE ON SCHEMA public` is required before `pg_restore`. Without it
  the restore emits `permission denied for schema public` followed by hundreds
  of `relation "public.Site" does not exist` — the symptom points at RLS, the
  cause is the missing schema privilege.
* `COMMENT ON SCHEMA public` fails with `must be owner of schema public`.
  Harmless; the drill uses `--no-comments` so that real errors are visible.

### Recovery objectives

| Objective | Current |
|---|---|
| RPO | ≤ 24 h at the default daily schedule |
| RTO | Unmeasured; the drill ran against a small database |

`SensorReading` grows fastest and has no retention policy yet, so dumps grow
without bound between prunes. That is the most likely reason a future drill
gets slow.

## 6. Upgrades and rollbacks

* **Application rollback** is a redeploy of the previous image. Migrations are
  forward-only; a rollback that would need a down-migration is a manual SQL
  exercise, planned before the deploy.
* **Never** run two app versions that expect different schemas against one
  database. Apply migrations first, then roll the app.
* The IoT bridge (`mini-services/iot-bridge`) is stateless; restart it freely.
  It retries ingest on the next interval.
