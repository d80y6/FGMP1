# Task 2-c — Asset Registry module

**Agent:** full-stack-developer (Assets module)
**Scope:** Full CRUD for FuelTanks, Generators, BatteryBanks, IotDevices

## Files created / modified

### API routes (9 new files)
- `src/app/api/fgmp/assets/route.ts` — GET returns `{ tanks, generators, batteries, iot, sites }` in one round-trip (4 findMany + 1 site list in `Promise.all`). Each asset includes `site: { name, code }`. ADMIN-only, READ_LIMIT.
- `src/app/api/fgmp/assets/tanks/route.ts` — POST create. Zod-validated. Defaults: currentLitres = 70% capacity, calibration="[]", status="OPERATIONAL". Audit `TANK_CREATE`.
- `src/app/api/fgmp/assets/tanks/[id]/route.ts` — PUT (all editable fields optional) + DELETE. Delete blocked with 409 `TANK_HAS_DELIVERIES` if any FuelDelivery references the tank (non-cascading FK).
- `src/app/api/fgmp/assets/generators/route.ts` — POST create. Defaults: status="STOPPED", mode="AUTO", runtimeHours=0, oilChangeIntervalHrs=250. Audit `GENERATOR_CREATE`.
- `src/app/api/fgmp/assets/generators/[id]/route.ts` — PUT + DELETE. Delete blocked with 409 `GENERATOR_HAS_COMMANDS` if any ControlCommand history exists.
- `src/app/api/fgmp/assets/batteries/route.ts` — POST create. Defaults: voltage=nominalVoltage, stateOfCharge=80, stateOfHealth=95, status="OK". Audit `BATTERY_CREATE`.
- `src/app/api/fgmp/assets/batteries/[id]/route.ts` — PUT + DELETE (no FK history → always succeeds; audit logs orphan warning).
- `src/app/api/fgmp/assets/iot/route.ts` — POST create. Defaults: status="ONLINE", signalRssi=-70. Friendly 409 `IOT_SERIAL_DUPLICATE` for duplicate serialNo. Audit `IOT_CREATE`.
- `src/app/api/fgmp/assets/iot/[id]/route.ts` — PUT (serialNo NOT editable — would break SensorReading history) + DELETE.

All 9 routes follow the canonical pattern from `users/[id]/route.ts`:
`force-dynamic` → `requireRole(req, ROLES.ADMIN_ONLY)` → `bootstrap()` →
`rateLimitByUser` → `applyRateLimitHeaders` on EVERY response →
zod `safeParse` → 400 on validation → 404 if not found → mutation →
`audit()` → outer `errorResponse(err)` catch.

### View (1 modified file)
- `src/components/fgmp/views/assets-view.tsx` — replaced the 13-line stub with a 2087-line full implementation:
  - `SectionHeader` (violet tone, Boxes icon)
  - 4-card KPI strip (Tanks/Generators/Batteries/IoT counts, with type-specific Lucide icons)
  - 4-tab `Tabs` (Tanks=Droplet/sky, Generators=Zap/amber, Batteries=BatteryCharging/emerald, IoT=Cpu/violet)
  - Each tab: `AssetCard` with header (title + count + search Input + Create button) and `max-h-96 overflow-y-auto overflow-x-auto` table container with sticky header
  - 4 type-specific tables with the exact columns specified
  - `StatusBadge` for status columns (maps OPERATIONAL/RUNNING/ONLINE/OK → emerald, MAINTENANCE/CALIBRATING/DEGRADED/LOW → amber, FAULT/OFFLINE/EMPTY/FAILING → rose, PROVISIONING/REPLACEMENT_DUE → sky/orange)
  - Custom `Badge` helper for non-status enums (fuelType/mode/iot type) — palette EXCLUDES indigo/blue
  - `SocPill` for battery state-of-charge (green ≥60%, amber 30-60%, rose <30%)
  - Per-row `RowActions` dropdown (Edit + Delete)
  - 4 create/edit Dialogs (TankDialog, GeneratorDialog, BatteryDialog, IotDialog) — each handles both modes; enum fields use shadcn Select; site field uses `SiteSelect` populated from the `sites` array returned by GET /assets
  - 4 `DeleteAlertDialog` confirmations — 409 errors toasted
  - All strings via `t("…")` — no hardcoded English. Keys from `assets.*`, `mgmt.*`, `status.*`, `generators.*`, `batteries.*`, `iot.*`, `fuel.*`.
  - Responsive: secondary columns collapse via `hidden md:table-cell` / `hidden lg:table-cell` / `hidden xl:table-cell`; `overflow-x-auto` as floor.

## Verification
- `bun run lint` → 0 errors, 0 warnings.
- All 13 new API endpoints respond with 401 (auth required) when hit without a session — confirms routes are wired correctly with `requireRole(ROLES.ADMIN_ONLY)`.
- `GET /?view=assets` → HTTP 200 (server-render of the page works).
- Dev server (port 3000) healthy; no new runtime errors in `dev.log` after the changes.

## Constraints respected
- Did NOT modify `prisma/schema.prisma`, `store.ts`, `rbac.ts`, `i18n.ts`, `app-shell.tsx`.
- Did NOT use indigo or blue colors (sky used sparingly per existing KpiCard "info" tone + StatusBadge sky slot).
- Used existing shadcn/ui components only.
- TypeScript strict, ES6+ imports, `"use client"` on the view, `force-dynamic` on API routes.
- All visible strings flow through `t("…")`.

## Reusable i18n keys (no new keys added)
- `assets.title`, `assets.description`, `assets.tanks/generators/batteries/iot`, `assets.totalTanks/Generators/Batteries/Iot`, `assets.create*/edit*`, `assets.site/label/capacity/fuelType/lowThreshold/criticalThreshold/manufacturer/model/ratedPowerKw/chemistry/nominalVoltage/capacityAh/vendor/serialNo/protocol/firmware/ipAddress/selectSite/noSitesAvailable/cannotDeleteWithHistory`
- `mgmt.create/edit/delete/save/cancel/confirm/search/noResults/loading/created/updated/deleted/deleteConfirm/name/code/status/type/actions/total`
- `status.*` (via StatusBadge), `generators.mode/runtime/nextMaint`, `batteries.charge`, `iot.currentLabel`, `fuel.noTanks`, `generators.noGenerators`, `batteries.noBanks`, `iot.noDevices`

## What an ADMIN can now do
1. Visit `/?view=assets` → see 4 KPI cards + 4-tab registry.
2. Switch tabs to focus on one asset type.
3. Search within a tab by label/name/site.
4. Click "Create [Type]" → dialog with type-specific fields → submit → row appears, toast confirms, audit log records `*_CREATE`.
5. Click row actions → Edit → change fields → save → toast confirms, audit `*_UPDATE`.
6. Click row actions → Delete → AlertDialog confirms → API deletes (or returns 409 with friendly message if blocked) → toast confirms, audit `*_DELETE`.
