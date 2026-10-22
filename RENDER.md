# Deploying FGMP to Render.com

This guide explains how to deploy the **Fuel & Generator Monitoring Platform** (FGMP) to [Render.com](https://render.com).

---

## Architecture Overview

The platform consists of three primary components plus one hosted service:

1. **`fgmp-db` (PostgreSQL Database)**: Managed PostgreSQL instance for persisting platform data and running Prisma schema migrations.
2. **`fgmp-app` (Next.js Web Service)**: The primary application container serving the web UI, REST API, NextAuth authentication, and telemetry processing. It triggers realtime events to Apinator and signs private-channel subscriptions for browsers.
3. **`fgmp-iot-bridge` (Private Service)**: Background worker ingesting field device telemetry and POSTing it to the web app's ingest endpoint, which persists it and pushes the update to Apinator.
4. **Apinator (hosted, external)**: Managed realtime WebSocket channels. Browsers subscribe directly to `wss://ws-<cluster>.apinator.io` — there is **no** realtime container to deploy.

---

## Option 1: Quick Deployment using `render.yaml` (Blueprint)

Render supports Infrastructure-as-Code via `render.yaml`. Using a Blueprint automatically provisions all services, links databases, and wires environment variables.

### Steps:

1. **Push your repository** to GitHub or GitLab.
2. Log in to [Render Dashboard](https://dashboard.render.com).
3. Click **New +** and select **Blueprint**.
4. Connect your repository and select the branch to deploy.
5. Render will automatically parse `render.yaml` and prompt you for required sync variables:
   - `NEXTAUTH_URL`: Set this to your web service URL (e.g. `https://fgmp-app.onrender.com`).
   - `APINATOR_APP_ID` / `APINATOR_KEY` / `APINATOR_SECRET` / `APINATOR_CLUSTER`: From your Apinator dashboard (`eu` or `us`).
6. Click **Apply**. Render will create the database and build/deploy the services.

---

## Option 2: Manual Service Setup

If you prefer setting up services individually in the Render Dashboard:

### 1. Create Managed PostgreSQL Database
- **Name**: `fgmp-db`
- **Database**: `fgmp`
- **User**: `fgmp`
- **Plan**: Starter or higher
- Copy the internal **Connection String** once created.

### 2. Create Web Service for Next.js App (`fgmp-app`)
- **Environment**: Docker
- **Dockerfile Path**: `Dockerfile`
- **Docker Context**: `.`
- **Health Check Path**: `/api/fgmp/health`
- **Environment Variables**:
  - `DATABASE_URL`: Internal Connection String of `fgmp-db`
  - `FGMP_MIGRATE_DATABASE_URL`: Internal Connection String of `fgmp-db`
  - `FGMP_REQUIRE_RLS`: `0` (for standard managed Postgres setup)
  - `NEXTAUTH_SECRET`: Random 32-byte base64 string (`openssl rand -base64 32`)
  - `NEXTAUTH_URL`: `https://<your-fgmp-app-name>.onrender.com`
  - `IOT_API_KEY`: Random hex string (`openssl rand -hex 32`)
  - `REALTIME_SERVICE_TOKEN`: Random hex string (`openssl rand -hex 32`) — the IoT bridge presents it on snapshot polling
  - `APINATOR_APP_ID`: From the Apinator dashboard
  - `APINATOR_KEY`: From the Apinator dashboard
  - `APINATOR_SECRET`: From the Apinator dashboard
  - `APINATOR_CLUSTER`: `eu` or `us` (the dashboard app's region)

### 3. Create Private Service for IoT Bridge (`fgmp-iot-bridge`)
- **Environment**: Docker
- **Dockerfile Path**: `mini-services/iot-bridge/Dockerfile`
- **Docker Context**: `mini-services/iot-bridge`
- **Environment Variables**:
  - `NEXT_API_BASE`: `http://fgmp-app:3000` (or internal URL of `fgmp-app`)
  - `IOT_API_KEY`: Same value as `fgmp-app`
  - `REALTIME_SERVICE_TOKEN`: Same value as `fgmp-app`

There is no step for a realtime service: the self-hosted socket.io mini-service was retired and realtime is hosted by Apinator. Browsers connect to `wss://ws-<cluster>.apinator.io` directly using the public `NEXT_PUBLIC_APINATOR_APP_KEY` / `NEXT_PUBLIC_APINATOR_CLUSTER` pair (set those at **build** time — `NEXT_PUBLIC_` vars are inlined into the client bundle).

---

## Post-Deployment: Database Initialization and Seeding

Once the database and services are up, run initial database migrations and seed default data.

### Option A: Using Render Shell (Recommended)

1. Open the **`fgmp-app`** web service in Render Dashboard.
2. Click **Shell** in the left sidebar.
3. Run schema migration:
   ```bash
   bun run db:deploy
   ```
4. Seed initial database data & admin account:
   ```bash
   bun run db:seed
   ```

### Default Login Credentials

After seeding, initial login details:
- **Email**: `admin@fgmp.ye`
- **Password**: `Admin@2026`

*Note: Change the default password immediately upon first login in the User Management view.*

---

## Troubleshooting & Important Notes

1. **Database Migrations on Startup**: The Docker container automatically executes `bun run db:deploy` via `scripts/docker-entrypoint.mjs` on boot if `FGMP_MIGRATE_DATABASE_URL` is set.
2. **Realtime connectivity**: Browsers connect straight to Apinator (`wss://ws-<cluster>.apinator.io`), not through your Render service. Ensure `APINATOR_CLUSTER` matches the dashboard app's region, the public `NEXT_PUBLIC_APINATOR_APP_KEY` / `NEXT_PUBLIC_APINATOR_CLUSTER` pair was present at **build** time, and the private-channel auth route (`/api/fgmp/realtime/auth`) is reachable — subscriptions for `private-tenant-*` channels are signed server-side.
3. **Health Check Timing**: Next.js cold boots on Render free/starter tiers may take ~30-60 seconds on initial deployment. Health checks are configured to retry automatically.
