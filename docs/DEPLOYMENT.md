# Deployment

FGMP deploys to **Cloudflare Workers** through OpenNext (`wrangler.jsonc`,
`open-next.config.ts`, `npm run build`). Everything else in this document —
Docker Compose, the migration/seed/backup jobs — exists either for local work or
as the **operator path**: one-shot jobs that touch the database directly, because
a Worker has no filesystem, no `pg_dump` and no way to run DDL.

The application is hosted in exactly one place. Netlify, Vercel and Render were
retired; their configuration has been deleted rather than left to rot, because a
stale `render.yaml` is a deploy target that looks supported and is not. If you
find yourself looking for one of those files, stop: the answer is Cloudflare.

| What | Where | Why |
|---|---|---|
| Web app + API | Cloudflare Worker `fgmp1` | `npm run deploy` |
| Static assets | Worker `ASSETS` binding | `.open-next/assets` |
| Database | Hosted PostgreSQL (Supabase pooler) | reached over TCP by the Worker |
| Migrations / seed | Operator machine or CI | Workers cannot run DDL |
| Backups | Operator machine (Compose profile) | needs `pg_dump` |
| Realtime | Apinator (hosted) | browsers connect directly |

A live Worker was not reachable from the environment that wrote this document, so
the Cloudflare statements below describe the **checked-in configuration**, not an
observed production run. §4 says exactly what to confirm on the first deploy.

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
every `PrismaClient`. That is a poor default for Workers: each isolate can keep
its own pool open, and this app also has narrowly scoped ops/auth clients. For
example, if a hosted database were capped at 15 concurrent connections, a few
simultaneous isolates and several `new PrismaClient()` call sites could consume
the whole allowance before the dashboard loads. **The 15-connection figure is
illustrative, not a verified provider limit for this deployment.** Confirm the
actual endpoint/pooler mode and connection allowance before sizing concurrency.

The app now adds bounded Prisma URL parameters unless explicitly supplied:

- Edge/serverless runtimes (Cloudflare Workers): app `connection_limit=1`;
  shared privileged client `connection_limit=1`.
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

## 4. Cloudflare Workers — the production target

The Worker runs the Next.js app and the API routes. The database is reached over
TCP from the Worker; there is no server process to keep alive, so the old
"long-running app" table applies only to Compose.

### Build and deploy

```bash
bun install --frozen-lockfile
bun run build        # opennextjs-cloudflare build → .open-next/worker.js + assets
bun run deploy       # opennextjs-cloudflare deploy (build + wrangler deploy)
```

`bun run build` is `opennextjs-cloudflare build` — the same command Cloudflare
Workers Builds runs. It generates Prisma Client, runs the Next.js build, and
emits the Worker bundle. The Docker path uses `bun run build:standalone`
instead; nothing else needs to change for either.

`wrangler.jsonc` is the manifest and is deliberately explicit:

| Key | Value | Why it is set |
|---|---|---|
| `name` | `fgmp1` | the Worker name; `WORKER_SELF_REFERENCE` must match it |
| `main` | `.open-next/worker.js` | OpenNext output |
| `compatibility_flags` | `nodejs_compat` | Prisma's `pg` adapter needs Node built-ins |
| `assets.binding` | `ASSETS` | serves `.open-next/assets` |
| `services` | `WORKER_SELF_REFERENCE` → `fgmp1` | self-referencing service binding |
| `keep_vars` | `true` | runtime variables live in the dashboard, not in Wrangler |

Secrets are **encrypted Worker secrets**, never `vars` and never committed:

```bash
bunx wrangler secret put DATABASE_URL       # fgmp_app role, RLS enforced
bunx wrangler secret put NEXTAUTH_SECRET
bunx wrangler secret put NEXTAUTH_URL
bunx wrangler secret put APINATOR_APP_ID   # and the other APINATOR_* values
```

`NEXT_PUBLIC_*` values are inlined at **build** time. Changing
`NEXT_PUBLIC_APINATOR_APP_KEY` or `NEXT_PUBLIC_APINATOR_CLUSTER` requires a
rebuild — setting them at runtime produces a bundle with an empty key and
realtime silently disabled.

### Migrations and seeding are not Worker work

The Worker must never receive the schema-owner credential and never runs DDL. Run
the two one-shot jobs from an operator machine that can reach the database:

```bash
# as the owner role
DATABASE_URL="$FGMP_MIGRATE_DATABASE_URL" bunx prisma migrate deploy

# idempotent demo topology / first tenant, also as owner
FGMP_MIGRATE_DATABASE_URL="$FGMP_MIGRATE_DATABASE_URL" bun run db:seed

# first administrator (idempotent; never deletes a user)
ADMIN_EMAIL=ops@example.ye ADMIN_PASSWORD='…' bun run seed:admin
```

`migrate deploy` applies exactly the committed migrations in order and is a no-op
when they are current. Do **not** use `prisma db push`: it reconciles the live
schema without recording anything, so environments drift from the migration
history and two deployments then disagree for reasons nobody can reconstruct.

Apply migrations **before** deploying the Worker. Two Worker versions that expect
different schemas against one database is the failure this ordering prevents.

### Connections: the Worker is a connection consumer

Prisma uses the `@prisma/adapter-pg` driver (`engineType = "client"`), because
the native Rust query engine cannot load in `workerd`. The adapter caps each pool
at one connection and Worker connections are retired after one checkout, which
keeps stale sockets from accumulating between requests. That is a **per-instance**
cap, not a global one: the deployment's aggregate Worker concurrency is what the
database actually sees.

The configured endpoint must accept TCP/TLS from Cloudflare. The project's
hosted PostgreSQL is reached through the provider's pooler; if the endpoint is
not directly reachable, put Cloudflare **Hyperdrive** in front of it — but only
after confirming that the pooler supports the transaction-local RLS context
(`SET LOCAL` on the tenant settings) the app relies on. A pooler that resets
session state between statements breaks tenant isolation in a way that looks like
missing data.

### A dependency pairing to know about before the first deploy

`@opennextjs/cloudflare@1.20.13` declares its Next.js support as
`>=15.5.28 <16 || >=16.4.1`. `package.json` asks for `^16.1.1`, and `bun.lock`
resolves that to **16.1.3** — which is *outside* the adapter's declared range.

What is known, and what is not:

* **Known:** `bun run build` (`opennextjs-cloudflare build`) completes on
  16.1.3 in CI's `verify` job, and the standalone server built from it boots in
  the `docker` job. So the pairing builds and runs as a Node server.
* **Not known:** that the Worker runtime path is correct on an unsupported
  Next. A declared range is the adapter author saying "not tested here", and
  this audit has no Cloudflare credentials, so it cannot become evidence.

**Remediation, on a machine with working registry egress:**

```
bun update next          # resolves within ^16.1.1 → 16.4.x, inside the range
bun run build            # must still succeed
git diff bun.lock        # expect only next + the @next/swc-* pins to move
```

Do not hand-edit `bun.lock`: the `@next/swc-*` optional dependencies are pinned
to the same version and have their own integrity hashes.

### First-deploy checklist (what to confirm, not assume)

1. `bunx wrangler deploy` succeeds and the Worker answers `/api/health/ready`
   (unauthenticated; it fails until the database is reachable and migrations are
   applied). Do **not** point a health check at `/api/fgmp/health` — that route is
   ADMIN-only by design and would 401, marking a healthy Worker down.
2. Sign-in works end to end. The email→user lookup is the one read that cannot be
   tenant-scoped, so it needs `FGMP_OPS_DATABASE_URL`; without it every login is
   a 401 that looks like a wrong password. The server refuses to start in
   production without it rather than serving an app nobody can sign in to.
3. `FGMP_REQUIRE_RLS=1` is set and the startup preflight accepts `DATABASE_URL`
   as `fgmp_app`. If it does not, the Worker exits instead of serving unscoped
   queries.
4. Realtime connects (browser → Apinator) and pauses when "Pause live" is used.
5. Logs: `observability` is configured (`issues` on, request logs off to stay
   inside the free tier). Turn `logs.enabled` on temporarily while debugging, and
   never log a connection string, cookie or token.

### Rollback

`bunx wrangler rollback` returns to the previous Worker version. Migrations are
forward-only, so a rollback that needs a down-migration is a manual SQL exercise,
planned before the deploy.

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

* **Application rollback** on Cloudflare is `bunx wrangler rollback` (previous
  Worker version); on Compose it is a redeploy of the previous image. Migrations
  are forward-only either way — a rollback that would need a down-migration is a
  manual SQL exercise, planned before the deploy.
* **Never** run two app versions that expect different schemas against one
  database. Apply migrations first, then roll the app.
* The IoT bridge (`mini-services/iot-bridge`) is stateless; restart it freely.
  It retries ingest on the next interval.
