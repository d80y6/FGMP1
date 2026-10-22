# FGMP — Production Deployment Guide

This document explains how to deploy the **Fuel & Generator Monitoring Platform**
(FGMP) to production using Docker and Docker Compose.

---

## 1. Overview

FGMP is a Next.js 16 application that monitors fuel tanks, generators, and
batteries across a national telecom network. The production stack has three
services:

| Service         | Container        | Port | Role                                         |
|-----------------|------------------|------|----------------------------------------------|
| Next.js web app | `fgmp-app`       | 3000 | Web UI + REST API + auth                     |
| Realtime        | Apinator (hosted)| —    | Managed WebSocket channels; browsers connect directly |
| IoT bridge      | `fgmp-iot-bridge`| —    | Ingests field-device telemetry → app (app pushes to Apinator) |

A SQLite database (mounted as a Docker volume) stores users, sites, alarms,
tickets, deliveries, and audit logs.

---

## 2. Prerequisites

- **Docker** 20.10+ (with BuildKit)
- **Docker Compose** v2 (the `docker compose` CLI plugin or the legacy
  `docker-compose` binary — both are supported)
- ~2 GB free disk for images + the SQLite volume
- A public hostname (e.g. `fgmp.your-telco.ye`) if you intend to expose the
  platform beyond localhost

Verify with:

```bash
docker --version
docker compose version   # or: docker-compose --version
```

---

## 3. Quick start

```bash
git clone <repo> fgmp && cd fgmp
cp .env.example .env
# (edit .env — set NEXTAUTH_SECRET to a strong random value)
docker compose up -d --build
```

Wait ~60 seconds for the build + healthcheck, then open
<http://localhost:3000>.

### First-time login

The platform ships with **no users** — the database is empty. Create the
initial ADMIN user by running the seed script inside the running container:

```bash
docker compose exec fgmp-app bun run seed:admin
```

Default credentials (shown in the seed script output):

| Field   | Value           |
|---------|-----------------|
| Email   | `admin@fgmp.ye` |
| Password| `Admin@2026`    |

**Change the password immediately** via the User Management view (top-right
"More actions" → "Reset Password").

To customize the seeded admin (e.g. different email/password):

```bash
docker compose exec fgmp-app \
  bash -c 'ADMIN_EMAIL=ops@fgmp.ye ADMIN_PASSWORD="..." bun run seed:admin'
```

### Initialize the schema

The Docker image runs `bun run db:generate` at build time, but the SQLite
file itself is created on first request. To force the schema to be applied
explicitly:

```bash
docker compose exec fgmp-app bun run db:push
```

---

## 4. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         Host (Docker)                              │
│                                                                    │
│  ┌─────────────────────┐  trigger events + channel auth            │
│  │   fgmp-app          │ ──────────────────────────► Apinator      │
│  │   Next.js 16        │                     (hosted realtime:     │
│  │   port 3000         │                      wss://ws-<cluster>   │
│  │                     │                      .apinator.io)        │
│  │  - Web UI           │                                    ▲      │
│  │  - REST API         │                                    │      │
│  │  - NextAuth (JWT)   │      browsers subscribe directly           │
│  └──────────┬──────────┘      over WebSocket (no container)        │
│             │                                                      │
│             │  /api/fgmp/iot/ingest (x-api-key)                    │
│             ▲            ┌────────────────────┐                    │
│             │            │   fgmp-iot-bridge  │                    │
│             └────────────┤   Bun service      │                    │
│                          │   (no exposed port)│                    │
│                          └────────────────────┘                    │
│                                                                    │
│  ┌──────────────────────────────────────────────┐                  │
│  │   Named volume: fgmp-db                      │                  │
│  │   → /app/db/fgmp.db (SQLite)                 │                  │
│  └──────────────────────────────────────────────┘                  │
└────────────────────────────────────────────────────────────────────┘
            ▲
            │  HTTPS (terminate at reverse proxy)
            │
       Public users + field devices
```

- The **Next.js app** serves the UI, the REST API, and NextAuth. It uses
  the standalone output (`output: "standalone"` in `next.config.ts`) so
  the production image is small.
- **Realtime is hosted (Apinator)**, not self-hosted: the app triggers
  events to Apinator server-side after persisting data, and signs
  private-channel subscriptions for browsers via its realtime auth
  routes. Browsers open their WebSocket straight to
  `wss://ws-<cluster>.apinator.io` — no realtime container exists, and
  nothing in the stack listens on the old :3003.
- The **IoT bridge** is a Bun service that listens for field-device
  telemetry (e.g. via MQTT or HTTP), and POSTs it to the Next.js app's
  `/api/fgmp/iot/ingest` endpoint. That route persists the reading and
  pushes the event to Apinator itself, so the bridge holds no socket
  connection.
- The **SQLite volume** persists the database across container restarts.

---

## 5. Environment variables

See [`.env.example`](./.env.example) for the full list. The most important:

| Variable                  | Required | Default              | Description                            |
|---------------------------|----------|----------------------|----------------------------------------|
| `DATABASE_URL`            | yes      | `file:.../custom.db` | SQLite path (in Docker: `/app/db/fgmp.db`) |
| `NEXTAUTH_SECRET`         | **YES**  | dev fallback         | JWT signing secret — **must override** |
| `NEXTAUTH_URL`            | yes      | `http://localhost:3000` | Public URL of the deployment        |
| `IOT_API_KEY`             | yes      | `fgmp-iot-dev-key`   | Shared secret for IoT bridge → app    |
| `REALTIME_SERVICE_TOKEN`  | yes      | —                    | IoT bridge → `/api/fgmp/realtime/snapshot` polling token |
| `APINATOR_APP_ID`         | **YES**  | —                    | Apinator dashboard app id (hosted realtime) |
| `APINATOR_KEY`            | **YES**  | —                    | Apinator API key (from the dashboard) |
| `APINATOR_SECRET`         | **YES**  | —                    | Apinator API secret — signs triggers + channel auth |
| `APINATOR_CLUSTER`        | **YES**  | —                    | Apinator region: `eu` or `us`         |
| `NEXT_PUBLIC_APINATOR_APP_KEY` | **YES** | —               | Public app key for the browser client (build-time) |
| `NEXT_PUBLIC_APINATOR_CLUSTER` | **YES** | —               | Browser client region (build-time)    |

> ⚠️ The dev fallback for `NEXTAUTH_SECRET` is deliberately weak so the
> platform boots locally without env setup. **Never deploy to production
> without overriding it** — and note that the `APINATOR_*` credentials have
> no dev fallback at all: compose refuses to start without them. The former
> `REALTIME_URL` / `REALTIME_SERVER_SECRET` / `REALTIME_TOKEN_SECRET` were
> removed together with the self-hosted realtime service.

---

## 6. Security notes

1. **Change `NEXTAUTH_SECRET`** to a strong random value before exposing
   the platform to the internet:
   ```bash
   openssl rand -base64 32
   ```
2. **Change the default admin password** immediately after first login.
3. **Terminate HTTPS** at a reverse proxy (Caddy, Nginx, Traefik). The
   container only listens on plain HTTP — let the proxy manage TLS
   certificates.
4. **Restrict the IoT bridge port** — the bridge does not expose a public
   port; only the Next.js app does. If you need to ingest telemetry from
   outside the host, do it via the Next.js app's `/api/fgmp/iot` endpoint
   (with `IOT_API_KEY` auth), not by exposing the bridge directly.
5. **Rotate `IOT_API_KEY`** periodically. The same key must be set on both
   `fgmp-app` and `fgmp-iot-bridge`.
6. **Audit log** — all user-management actions (create / update / activate /
   deactivate / reset-password) are recorded in the audit log with the
   acting admin's id + email. Review the Audit Log view regularly.

---

## 7. Backup & restore

The entire state lives in the SQLite file inside the `fgmp-db` volume.

### Backup

```bash
# Stop the app so the DB is not being written to (optional but safer)
docker compose stop fgmp-app

# Copy the SQLite file out of the volume
docker run --rm -v fgmp-db:/data -v "$PWD":/backup alpine \
  cp /data/fgmp.db /backup/fgmp-$(date +%Y%m%d).db

# Restart the app
docker compose start fgmp-app
```

For online backups (no downtime) use the SQLite `.backup` command via the
`sqlite3` CLI inside the container:

```bash
docker compose exec fgmp-app \
  sqlite3 /app/db/fgmp.db ".backup '/tmp/fgmp-backup.db'"
docker cp fgmp-app:/tmp/fgmp-backup.db ./fgmp-backup.db
```

### Restore

```bash
docker compose stop fgmp-app
docker run --rm -v fgmp-db:/data -v "$PWD":/backup alpine \
  cp /backup/fgmp-YYYYMMDD.db /data/fgmp.db
docker compose start fgmp-app
```

---

## 8. Operations

### View logs

```bash
docker compose logs -f fgmp-app        # web app
docker compose logs -f fgmp-iot-bridge # iot bridge
```

### Restart a service

```bash
docker compose restart fgmp-app
```

### Rebuild after a code change

```bash
docker compose up -d --build
```

### Run a one-off command inside the app container

```bash
docker compose exec fgmp-app bun run db:push
docker compose exec fgmp-app bun run scripts/seed-admin.ts
```

### Scale (warning)

SQLite does **not** support multiple concurrent writers. Do not scale
`fgmp-app` beyond 1 replica. For HA, migrate the database to Postgres
(update `prisma/schema.prisma` provider + `DATABASE_URL`).

---

## 9. Troubleshooting

### `Cannot find module '@prisma/client'` after rebuild

The Prisma client is generated at build time. Force a clean rebuild:

```bash
docker compose build --no-cache fgmp-app
docker compose up -d
```

### Login fails with "invalid credentials" after seeding

1. Confirm the seed ran successfully — `docker compose logs fgmp-app | grep "admin seeded"`.
2. Verify the user exists — `docker compose exec fgmp-app bun -e "const {db}=require('./src/lib/db'); db.user.findMany().then(u=>console.log(u.map(x=>x.email)))"`.
3. The account may be locked — re-run `bun run seed:admin` (it resets the
   `failedLoginAttempts` and `lockedUntil` counters).

### Realtime push doesn't reach the browser

Realtime is hosted by Apinator — there is no realtime container to check.
1. Confirm the `APINATOR_*` env vars are set on `fgmp-app` and that
   `APINATOR_CLUSTER` matches the region the dashboard app was created in.
2. The browser subscribes directly to `wss://ws-<cluster>.apinator.io`
   using the public `NEXT_PUBLIC_APINATOR_APP_KEY` / `NEXT_PUBLIC_APINATOR_CLUSTER`
   pair — these are inlined at **build** time, so a rebuild is required
   after changing them.
3. Private `private-tenant-*` channel subscriptions are authorized by the
   app's realtime auth route; check its logs for signing/auth errors.
4. The System Health view (`/api/fgmp/health`) shows `realtime.connected`
   — `false` with valid config means the channels API call failed or
   timed out (credentials, region, or provider outage).

### IoT telemetry isn't appearing

1. Confirm the IoT bridge is running — `docker compose logs fgmp-iot-bridge`.
2. Verify `IOT_API_KEY` matches between the bridge and the app.
3. The bridge POSTs to `${NEXTJS_URL}/api/fgmp/iot` — verify the URL is
   reachable from the bridge container:
   ```bash
   docker compose exec fgmp-iot-bridge \
     curl -s -o /dev/null -w "%{http_code}\n" http://fgmp-app:3000/api/fgmp/iot
   ```
   (Expect 401 without a body — that's fine, it means the route is reachable.)

### Database is locked / "SQLITE_BUSY"

This happens if the app is restarted while a write transaction is in
flight. The Prisma client retries automatically; if errors persist:

```bash
docker compose down
docker compose up -d
```

If the volume is corrupted, restore from the latest backup (see §7).

---

## 10. Updating

To update to a new FGMP release:

```bash
git pull
docker compose up -d --build
docker compose exec fgmp-app bun run db:push   # apply any schema changes
```

Always review `CHANGELOG.md` (if present) for breaking changes before
updating. Take a fresh backup first (see §7).
