# Task: DISP-FW-GW — Edge & Firmware (ESP OTA, Site Gateways, RS485 Diagnostics, ESP Reboot)

**Agent:** full-stack-developer
**Date:** 2026-07-04
**Status:** ✅ COMPLETE

## Summary

Built the "Edge & Firmware" view (4 tabs) covering all 4 missing capabilities: ESP firmware OTA management, site gateway model + health, RS485 bus diagnostics, and ESP reboot command. All schema, engine, API, RBAC, seeder, frontend, nav, i18n, and status-badge work was already in place from a prior session; this session verified completeness, fixed a critical Prisma-client-in-browser bundling bug (cold-restart regression), reseeded deployments to match the spec (5–10 with 1 FAILED + 1 DOWNLOADING), made the seeder idempotent for deployments, and ran the end-to-end agent-browser smoke test across all 4 tabs.

## Files

### Created (10)
- `src/app/api/fgmp/edge/gateways/route.ts` — GET list (site join + live engine merge)
- `src/app/api/fgmp/edge/gateways/[id]/route.ts` — PATCH/DELETE (admin) + POST reboot action
- `src/app/api/fgmp/edge/firmware/route.ts` — GET releases + POST create (admin)
- `src/app/api/fgmp/edge/firmware/[id]/route.ts` — DELETE (admin, refuses if deployments exist)
- `src/app/api/fgmp/edge/firmware/deploy/route.ts` — POST deploy → engine.applyFirmwareDeployment, 202, RBAC dispenser:control
- `src/app/api/fgmp/edge/firmware/deployments/route.ts` — GET paginated deployments (joins dispenser+release+initiatedBy)
- `src/app/api/fgmp/edge/esp/[dispenserId]/reboot/route.ts` — POST reboot → engine.applyEspReboot, 202, RBAC dispenser:control
- `src/app/api/fgmp/edge/rs485/route.ts` — GET all dispensers' RS485 diagnostics (live engine merge)
- `src/components/fgmp/views/edge-view.tsx` — 948-line 4-tab view (Gateways / ESP Firmware / RS485 / ESP Reboot)
- `scripts/seed-edge.ts` — idempotent seeder (releases + gateways + dispenser firmware distribution + deployments)

### Modified (9)
- `prisma/schema.prisma` — added EspFirmwareRelease, EspFirmwareDeployment, SiteGateway models; extended FuelDispenser with rs485* fields + espFirmwareDeployments back-relation; added Site.gateway + User.espFirmwareDeployments back-relations
- `src/lib/fgmp/engine.ts` — gateways + firmwareReleases state arrays; rs485 diagnostics per tick (8–120ms baseline, 200–800ms spike in comm-loss, 0.5% CRC, +1 timeout in comm-loss); applyEspReboot (30s comm-loss); applyFirmwareDeployment (async QUEUED→DOWNLOADING→FLASHING→SUCCESS/FAILED over 5s, 5% fail rate); applyGatewayReboot (20s DEGRADED); gateway telemetry drift each tick; snapshot() includes gateways + firmwareReleases
- `src/lib/fgmp/types.ts` — GatewaySnapshotState, FirmwareReleaseSnapshotState interfaces; Snapshot.gateways + Snapshot.firmwareReleases; DispenserState.rs485* fields
- `src/lib/fgmp/rbac.ts` — view:edge capability on all 6 roles; **FIX**: converted static `import { db }` to dynamic `await import("@/lib/db")` inside getCurrentUser()/setCurrentRole() to prevent PrismaClient from being bundled into the client bundle (app-shell.tsx imports hasCapability/ALL_ROLES/ROLE_PERMISSIONS from rbac.ts → static db import pulled Prisma into browser → "PrismaClient is unable to run in this browser environment" on cold restart)
- `src/lib/fgmp/auth-helpers.ts` — ROLES.EDGE_MANAGE = ["ADMIN"]
- `src/lib/fgmp/i18n.ts` — 99 EN+AR keys (nav.edge, desc.edge, 97 edge.* keys covering tabs, KPIs, columns, dialogs, statuses, channels, reboot confirms)
- `src/components/fgmp/status-badge.tsx` — QUEUED/DOWNLOADING/FLASHING/SUCCESS/FAILED/ROLLED_BACK tones; "edge" added to LOOKUP_NAMESPACES
- `src/components/fgmp/app-shell.tsx` — nav item { key: "edge", icon: Router, cap: "view:edge", group: "Monitoring" } after dispensers; edge: EdgeView in VIEW_COMPONENTS
- `src/components/fgmp/command-palette.tsx` — "Edge & Firmware" in Navigate group

## DB State (after seed)
- 3 EspFirmwareRelease (v2.4.0 stable 6mo, v2.4.1 stable 2wk, v2.5.0-beta beta 3d)
- 29 SiteGateway (one per site with dispensers; ~85% ONLINE, 10% DEGRADED, 5% OFFLINE)
- 45 FuelDispenser with firmware distributed across v2.3.0/v2.3.1/v2.3.2/v2.4.0/v2.4.1
- 8 EspFirmwareDeployment (6 SUCCESS, 1 FAILED, 1 DOWNLOADING — in-progress)

## Key Fix: Prisma Client Bundling Bug
`rbac.ts` had a static `import { db } from "@/lib/db"` at module top level. Since `app-shell.tsx` (client component) imports `hasCapability`/`ALL_ROLES`/`ROLE_PERMISSIONS` from `rbac.ts`, Turbopack bundled the entire `rbac.ts` module — including the static `db` import — into the client bundle, causing `PrismaClient is unable to run in this browser environment` on every page load. This only manifested on a cold dev-server restart (warm incremental compilation had been tree-shaking it). Fixed by converting to `const { db } = await import("@/lib/db")` inside the two functions that use it (`getCurrentUser`, `setCurrentRole`), so the client bundle never pulls in Prisma.

## Verification
- `bun run lint` → EXIT 0 (0 errors)
- agent-browser smoke test (ADMIN role):
  - ✅ Page loads at `/` (FGMP app shell renders, nav includes "Edge & Firmware")
  - ✅ Tab 1 Gateways: 6 KPI cards (Total 29, Online 25, Degraded 0, Offline 4, Avg RSSI -60 dBm, Avg CPU 58.2°C) + 29-row table with all 12 columns
  - ✅ Tab 2 ESP Firmware: 3 releases (v2.5.0-beta/v2.4.1/v2.4.0) + Deployments table; "Deploy to…" dialog opens with dispenser select (filters out same-version dispensers), Cancel works
  - ✅ Tab 3 RS485 Diagnostics: 6 KPI cards (Total Buses 45, Avg Latency 79ms, CRC Errors 2, Timeouts 30, Comm-Loss 2, Worst 278ms) + top-15 bar chart + diagnostics table
  - ✅ Tab 4 ESP Reboot: 45 dispensers with ESP controller ID/firmware/IP/last-seen + "Reboot ESP" buttons; confirm dialog opens with dispenser details, Cancel works
  - ✅ Gateway "Reboot Gateway" admin action: confirm dialog opens with gateway details, Cancel works
- 5 screenshots saved to `download/qa-edge/`
