# Deploying FGMP to Render.com

This guide explains how to deploy the **Fuel & Generator Monitoring Platform** (FGMP) to [Render.com](https://render.com).

---

## Architecture Overview

The platform consists of four primary components:

1. **`fgmp-db` (PostgreSQL Database)**: Managed PostgreSQL instance for persisting platform data and running Prisma schema migrations.
2. **`fgmp-app` (Next.js Web Service)**: The primary application container serving the web UI, REST API, NextAuth authentication, and telemetry processing.
3. **`fgmp-realtime` (Socket.io Web Service)**: Bun-based Socket.io server delivering realtime telemetry updates to browsers.
4. **`fgmp-iot-bridge` (Private Service)**: Background worker ingesting field device telemetry and forwarding updates to the web app and realtime service.

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
   - `REALTIME_ORIGIN`: Set this to your web service URL (e.g. `https://fgmp-app.onrender.com`).
6. Click **Apply**. Render will create the database and build/deploy all three services.

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
  - `REALTIME_URL`: `http://fgmp-realtime:3003` (or `https://<fgmp-realtime>.onrender.com`)
  - `REALTIME_SERVER_SECRET`: Random hex string (`openssl rand -hex 32`)
  - `REALTIME_SERVICE_TOKEN`: Random hex string (`openssl rand -hex 32`)
  - `REALTIME_TOKEN_SECRET`: Random base64 string (`openssl rand -base64 32`)

### 3. Create Web Service for Realtime (`fgmp-realtime`)
- **Environment**: Docker
- **Dockerfile Path**: `mini-services/realtime/Dockerfile`
- **Docker Context**: `mini-services/realtime`
- **Health Check Path**: `/health`
- **Environment Variables**:
  - `NEXT_API_BASE`: `http://fgmp-app:3000` (or internal URL of `fgmp-app`)
  - `REALTIME_ORIGIN`: `https://<your-fgmp-app-name>.onrender.com`
  - `REALTIME_SERVER_SECRET`: Same value as `fgmp-app`
  - `REALTIME_SERVICE_TOKEN`: Same value as `fgmp-app`
  - `REALTIME_TOKEN_SECRET`: Same value as `fgmp-app`

### 4. Create Private Service for IoT Bridge (`fgmp-iot-bridge`)
- **Environment**: Docker
- **Dockerfile Path**: `mini-services/iot-bridge/Dockerfile`
- **Docker Context**: `mini-services/iot-bridge`
- **Environment Variables**:
  - `NEXT_API_BASE`: `http://fgmp-app:3000` (or internal URL of `fgmp-app`)
  - `IOT_API_KEY`: Same value as `fgmp-app`
  - `REALTIME_SERVER_SECRET`: Same value as `fgmp-app`

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
2. **WebSocket & CORS Configuration**: Ensure `REALTIME_ORIGIN` matches the public HTTPS domain of `fgmp-app` so browser WebSocket connections work seamlessly.
3. **Health Check Timing**: Next.js cold boots on Render free/starter tiers may take ~30-60 seconds on initial deployment. Health checks are configured to retry automatically.
