# Deployment

How to run FGMP with Docker Compose or Render, how migrations and seeding are
split from the app, and how to back up and restore. Commands below target the
checked-in configuration; the Render environment and a live Docker deployment
are not available in this connection assessment.

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

Compose migration/seed jobs keep the normal `DATABASE_URL` set to `fgmp_app`,
but scope `DATABASE_URL="$FGMP_MIGRATE_DATABASE_URL"` to the `db:deploy`
child process because Prisma's migration CLI reads that name. The shell requires
`FGMP_MIGRATE_DATABASE_URL` explicitly and does not fall back to the app role.
The seed script consumes the separately named migration URL; ordinary app
queries remain on `DATABASE_URL`/`fgmp_app`.

The app starts with `FGMP_SKIP_MIGRATE=1` and **never receives the owner URL**.
At boot, `scripts/docker-entrypoint.mjs` discards any accidentally inherited
migration URL, then runs `scripts/db-preflight.mjs`, a SELECT-only check that
the expected tables exist, using only `DATABASE_URL` as `fgmp_app`. If that URL
is missing or the schema is missing, the container exits instead of trying a
migration/ops credential or serving a half-configured platform. Migration
credentials are not needed for this check.

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

`.env.example` documents each variable. Required values have no safe default; optional values are marked explicitly below.

| Variable | Requirement / purpose |
|---|---|
| `PGMIGRATE_PASSWORD`, `PGAPP_PASSWORD`, `PGOPS_PASSWORD` | Three distinct roles: owner/migrate, app (RLS), ops (BYPASSRLS). The compose DB refuses to start without them. |
| `DATABASE_URL` | Ordinary web/API traffic only; must authenticate as `fgmp_app` so RLS applies. |
| `FGMP_MIGRATE_DATABASE_URL` | Separate one-shot migration/seed credential. Never a runtime app fallback; migration jobs fail if it is absent. |
| `FGMP_OPS_DATABASE_URL` | Separate `fgmp_ops` credential for approved backup/support operations; never ordinary tenant queries. |
| `FGMP_REQUIRE_RLS` | Defaults to `1`; app refuses a configured URL that is not recognized as `fgmp_app`. |
| `FGMP_SKIP_MIGRATE` | Set to `1` on the web service when a separate one-shot migration job owns schema changes; startup performs a SELECT-only preflight, not DDL. |
| `FGMP_MIGRATE_ONLY` | Set to `1` on a migration-job container; applies migrations and exits without seeding or starting the server. Mutually exclusive with `FGMP_SKIP_MIGRATE=1`. |
| `FGMP_DB_CONNECTION_LIMIT` | Optional per-client default override. Keep the current cap unless the live provider's connection budget is verified. |
| `FGMP_DB_POOL_TIMEOUT` | Optional pool-acquisition deadline in seconds. The adapter uses the stricter of it and `connect_timeout` because `pg.Pool` has one shared timeout. |
| `NEXTAUTH_SECRET` | Signs session JWTs. `openssl rand -base64 32`. |
| `NEXTAUTH_URL` | Canonical origin; callback URLs depend on it. |
| `IOT_API_KEYS` | Optional bridge-only JSON map of `tenantId` to raw tenant API keys. Create keys in the API-key manager with `write` scope; the app validates them against each submitted site's tenant. |
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
scoped ops/auth clients. For example, if a hosted database were capped at 15 concurrent
connections, a few simultaneous function instances and several `new
PrismaClient()` call sites could consume the whole allowance before the dashboard
loads. **The 15-connection figure is illustrative, not a verified provider limit
for this deployment.** Confirm the actual provider, endpoint/pooler mode, and
connection allowance before sizing concurrency.

The app now adds bounded Prisma URL parameters unless explicitly supplied:

- Netlify / AWS Lambda / Vercel: app `connection_limit=1`; shared privileged
  client `connection_limit=1`.
- Long-lived app server: app limit 3; shared privileged ops client limit 1.
- `FGMP_DB_CONNECTION_LIMIT` and `FGMP_DB_POOL_TIMEOUT` override defaults; URL
  values always take precedence. The pg adapter exposes one
  `connectionTimeoutMillis` for both new socket establishment and acquisition
  wait, so FGMP applies the stricter of `pool_timeout` and `connect_timeout`.
- Auth, audit, scheduler, seed, health and the site→tenant realtime resolver
  reuse a process-wide privileged client per DSN instead of each opening its
  own Prisma pool.
- `GET /api/fgmp/metrics` samples the real process-local `pg.Pool` counters
  (saturation and total/idle/in-use/waiting/max) after its existing ALARM_OPS
  authorization. Scrape each instance for per-process readings; the metric is
  not a database-wide or cross-replica connection total.

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

The blueprint declares a **job** service for this. It receives the separate
`FGMP_MIGRATE_DATABASE_URL` and `FGMP_MIGRATE_ONLY=1`; the image entrypoint
maps that URL to `DATABASE_URL` for Prisma and exits after migrations, without
seeding or starting the web server. The web service sets `FGMP_SKIP_MIGRATE=1`
and a service-level empty `FGMP_MIGRATE_DATABASE_URL` override so it runs only
the app-role schema preflight and cannot inherit that credential from the
shared `fgmp1` environment group. The API-only IoT bridge similarly clears
`DATABASE_URL`, `FGMP_MIGRATE_DATABASE_URL`, `FGMP_OPS_DATABASE_URL`, and the
legacy `FGPS_OPS_DATABASE_URL` rather than receiving unused database secrets.

The live Render environment is not available in this assessment. Before relying
on the manifest, verify the effective service variables and run the one-shot job
in staging; confirm the app process sees no migration URL and the job exits
without launching the web server. Do not route ordinary application queries
through the migration URL.

If you prefer a Render Shell, `bun run db:deploy` works there only when that
process is explicitly given the migration URL as `DATABASE_URL`. Keep the URL
out of the web service and never fall back to it when app access fails.

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

## 7. Cloudflare Workers (OpenNext) — optional, not runtime-verified

The repository has a Cloudflare build path, but this assessment did not establish
that production runs on Workers. The locked Next.js/OpenNext versions do not
currently establish a supported combination, and `wrangler.jsonc` has no
Hyperdrive binding. Do not treat the instructions below as evidence of a working
or active Cloudflare deployment; verify the platform and compatibility before
using them.

The Cloudflare build uses the tracked `wrangler.jsonc` and `open-next.config.ts`;
this avoids Wrangler's automatic migration deriving a self-reference service
name from the package name. The Worker name and `WORKER_SELF_REFERENCE` service
must both remain `fgmp1`.

For Cloudflare Workers Builds, use build command `bun run build` and deploy
command `npx wrangler deploy`. The build generates Prisma Client, runs the
Next.js build, and emits the OpenNext Worker bundle. The Docker/Render path uses
`bun run build:standalone` directly.

`wrangler.jsonc` sets `keep_vars: true` because runtime variables are managed in
the Cloudflare dashboard. Store credentials as encrypted Worker Secrets, not
plain-text `vars`; never commit `.dev.vars` or copy production secrets into build
logs. If credentials have appeared in deployment logs, rotate them immediately.

Prisma uses the JavaScript `@prisma/adapter-pg` driver (`engineType = "client"`)
instead of the native Rust query engine, which Cloudflare Workers cannot load.
The adapter caps each pool at one connection; Worker connections are retired
after one checkout. This preserves the tenant transaction/RLS setup while
avoiding stale pooled sockets between requests. Keep `nodejs_compat` enabled.
The configured PostgreSQL endpoint must accept TCP/TLS from Cloudflare; use a
Cloudflare Hyperdrive binding or the database provider's Worker-compatible
adapter if the endpoint is not directly reachable over PostgreSQL TCP.
