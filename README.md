# FGMP — Fuel & Generator Monitoring Platform

National-scale monitoring for fuel tanks, generators, batteries, dispensers and
the sites that host them: telemetry ingestion, alarm correlation, maintenance,
deliveries and tenant-isolated operations in one Next.js application.

> **Status: working prototype, not a certified production system.** The platform
> does not fabricate telemetry: when no device data has arrived, screens show an
> empty/unknown state rather than plausible numbers. Remote control without a
> configured transport returns `NO_TRANSPORT` instead of a false success. See
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for what is wired and what is
> intentionally not, and [`docs/SECURITY.md`](docs/SECURITY.md) for the security
> model and residual risks.

## Stack

| Layer | Technology |
|---|---|
| App | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, shadcn/ui |
| Data | PostgreSQL 17 with TimescaleDB, Prisma 6, row-level security (RLS) enforced by the database |
| Auth | NextAuth (JWT sessions), role-based access control, TOTP MFA with recovery codes |
| Realtime | Apinator (hosted WebSocket channels); browsers subscribe directly, the server emits events |
| Field protocols | MQTT (mosquitto with per-tenant ACLs), Modbus RTU/TCP over a transport abstraction |
| Edge | `mini-services/iot-bridge` (Bun) and ESP32/ESP8266 dispenser firmware |
| Runtime | Bun for scripts/tests; Node-compatible Next.js standalone output for deployment |

## Quick start (Docker)

```bash
git clone <repo> fgmp && cd fgmp
cp .env.example .env

# Fill every required secret in .env. These are NOT optional:
#   NEXTAUTH_SECRET, IOT_API_KEY, REALTIME_SERVICE_TOKEN,
#   PGMIGRATE_PASSWORD, PGAPP_PASSWORD, PGOPS_PASSWORD,
#   APINATOR_APP_ID / KEY / SECRET / CLUSTER,
#   NEXT_PUBLIC_APINATOR_APP_KEY / CLUSTER
#
# Generate symmetric secrets with:
#   openssl rand -base64 32    # NEXTAUTH_SECRET
#   openssl rand -hex 32       # IOT_API_KEY, REALTIME_SERVICE_TOKEN
#   openssl rand -hex 24       # PG*_PASSWORD

# 1. Apply migrations and seed (one-shot; expects a fresh compose database)
docker compose --profile seed run --rm fgmp-seed

# 2. Start the stack (app on http://localhost:3151)
docker compose up -d --build
```

Migrations are a **separate job**. The app container starts with
`FGMP_SKIP_MIGRATE=1`, connects as the non-owner `fgmp_app` role, and refuses to
start if the schema is missing. To migrate without seeding:

```bash
docker compose --profile migrate run --rm fgmp-migrate
```

Create the first administrator if the seed did not create one:

```bash
docker compose exec fgmp-app bun run seed:admin
# default: admin@fgmp.ye / Admin@2026 — change it immediately
```

Full deployment, backup and restore instructions: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Local development

Prerequisites: Bun 1.x, Docker (for PostgreSQL and mosquitto), Node 22+.

```bash
bun install
cp .env.example .env                 # same variables as above

# Start only the database + broker
docker compose up -d fgmp-db fgmp-broker

# Generate the Prisma client and apply the committed migrations
bun run db:generate
FGMP_MIGRATE_DATABASE_URL="postgresql://fgmp_migrate:...@127.0.0.1:5433/fgmp?schema=public" \
  bun run db:deploy

# Seed demo topology (sites, tanks, generators, users)
FGMP_MIGRATE_DATABASE_URL="postgresql://fgmp_migrate:...@127.0.0.1:5433/fgmp?schema=public" \
  bun run db:seed

bun run dev                          # http://localhost:3000
```

Set `FGMP_SIMULATION=1` **only** for a demo; it is ignored when
`NODE_ENV=production`. The platform is designed to look empty without device
data — that is not a bug.

## Repository layout

```
src/
  app/                 Next.js routes and API handlers
    api/fgmp/          REST surface (tenant-scoped; see docs/ARCHITECTURE.md)
  components/fgmp/     Product UI (views, panels, shell)
  components/ui/       shadcn/ui primitives actually used by the app
  lib/fgmp/            Domain logic: engine, scheduler, RBAC, MFA, protocol,
                       alerting, correlation, CSV/PDF/DOCX export, i18n
  lib/health/          Canonical site-health scoring
  lib/observability/   Logging, health and Prometheus metrics
prisma/
  schema.prisma        Data model (25+ models, 24 tenant-scoped tables)
  migrations/          Committed, ordered migration history
scripts/
  db/                  Seed and database-role bootstrap scripts
  verify/              Proof/regression suites (RLS, E2E route sweep, scheduler)
  dev/                 Local tooling (dev server, certificates, bun test shims)
  docs-tools/          One-off generators for proposal/architecture documents
  docker-entrypoint.mjs, db-preflight.mjs, collect-prisma-cli-deps.ts  (runtime)
mini-services/iot-bridge/   Bun bridge: MQTT/RS485 → app ingest
firmware/dispenser-esp/     ESP32/ESP8266 reference firmware + register map
docker/                     mosquitto configuration and ACLs
docs/                       Current documentation (history/ is archived)
```

## Common commands

| Command | Purpose |
|---|---|
| `bun run dev` | Next.js dev server on :3000 |
| `bun run build` | Production build (standalone output) |
| `bun run start` | Run the built standalone server |
| `bun run typecheck` | `tsc --noEmit` (zero errors required) |
| `bun run lint` | ESLint (errors block; warnings are a tracked backlog) |
| `bun test` | Unit suites (DB-backed suites skip/fail without PostgreSQL) |
| `bun run test:rls` | RLS regression suite against a live database |
| `bun run test:smoke` | PostgreSQL smoke test (asserts RLS is enforcing) |
| `bun run db:generate` / `db:deploy` / `db:seed` | Prisma client, migrations, seed |
| `bun run seed:admin` | Create or repair the first ADMIN user |
| `docker compose up -d --build` | Full stack (app :3151) |

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Request path, engine/telemetry clock, tenancy, protocols, realtime |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Compose/Render deployment, migrations, backup and restore |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Auth, RBAC, RLS, MFA, secrets, residual risks |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Health, metrics, scheduler, MQTT, incident checks |
| [`docs/TESTING.md`](docs/TESTING.md) | Browser verification and automated suites |
| [`docs/MFA.md`](docs/MFA.md) | MFA design, recovery model and operational notes |
| [`docs/history/`](docs/history/) | Archived reviews, audits and phase records (not normative) |

## Multi-tenancy, in one paragraph

Every tenant-carrying table has `FORCE ROW LEVEL SECURITY`; the application
connects as `fgmp_app`, which is **not** the table owner, so policies apply even
to buggy queries. Routes wrap queries in `withTenant()`/`asTenant()` and every
list endpoint scopes by the caller's tenant. A deployment that points
`DATABASE_URL` at an owner or `BYPASSRLS` role is refused at startup
(`FGMP_REQUIRE_RLS=1`). See [`docs/SECURITY.md`](docs/SECURITY.md).
