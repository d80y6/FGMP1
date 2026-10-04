# TI-2b — Tenant Isolation: LIST Endpoint Fixes

**Task ID:** TI-2b
**Agent:** full-stack-developer (tenant-isolation list-endpoint fixes)
**Scope:** Make SUPERADMIN see all tenants' data on LIST endpoints while preserving tenant admin/operator isolation. Do NOT touch single-record `[id]` routes (TI-2a) or state/snapshot/analytics/export/reports/forecast/patterns (TI-2c).

## Files Modified (22 total)

### Group A — Direct `tenantId` column models (use `tenantWhereOrAll`)

1. `src/app/api/fgmp/audit/route.ts` — GET: replaced `where.tenantId = me.tenantId` with `{ ...tenantWhereOrAll(me) }`.
2. `src/app/api/fgmp/notifications/route.ts` — GET: same pattern; POST `markAllSent` branch: `where: { status: "QUEUED", ...tenantWhereOrAll(me) }`. POST role gate expanded from `ROLES.NOTIFICATION` to `[...ROLES.NOTIFICATION, "SUPERADMIN"]` so SUPERADMIN can actually reach the code. `markSent` branch (single-record, uses `assertTenantOwned`) left untouched.
3. `src/app/api/fgmp/shift-handover/route.ts` — GET list filter + openCount count filter + POST flagged-sites validation filter all switched to `tenantWhereOrAll(user)`. POST role gate expanded to include `"SUPERADMIN"`. The `tenantId: user.tenantId` stamp on the new row is intentionally left as-is (a handover is authored BY the user → own-tenant stamp).
4. `src/app/api/fgmp/suppressions/route.ts` — GET: added `where: tenantWhereOrAll(user)` (previously NO `where` clause at all — critical cross-tenant data leak). POST handler left untouched per spec (inline `site.tenantId !== user.tenantId` check belongs to inline-check subagent).
5. `src/app/api/fgmp/geography/route.ts` — GET: added `where: tenantWhereOrAll(user)` (previously NO `where` clause — critical cross-tenant leak). Removed `void user;` (no longer needed — `user` is now consumed by the filter).
6. `src/app/api/fgmp/geography/regions/route.ts` — POST: role gate changed from `ROLES.ADMIN_ONLY` → `ROLES.SUPER_OR_ADMIN`. Added SUPERADMIN guard: if caller is not super-admin AND `parsed.data.tenantId` is provided AND differs from `user.tenantId`, return 403 `CROSS_TENANT_FORBIDDEN`. SUPERADMIN can still pass any tenantId.
7. `src/app/api/fgmp/geography/governorates/route.ts` — POST: role gate → `ROLES.SUPER_OR_ADMIN`. Added inline tenant check: after fetching the parent region, if `region.tenantId !== user.tenantId && !isSuperAdminUser(user)` return 403. (Governorate model has no direct `tenantId`; isolation is enforced via its parent Region.)
8. `src/app/api/fgmp/geography/districts/route.ts` — POST: role gate → `ROLES.SUPER_OR_ADMIN`. Added inline tenant check: after fetching the parent governorate (with `region.tenantId`), if `gov.region.tenantId !== user.tenantId && !isSuperAdminUser(user)` return 403. (District model has no direct `tenantId`; isolation via Governorate → Region.)

### Group B — Child models with `site.tenantId` (use `siteTenantWhereOrAll`)

9. `src/app/api/fgmp/deliveries/route.ts` — GET: replaced `where.site = { tenantId: me.tenantId }` with `{ ...siteTenantWhereOrAll(me) }`.
10. `src/app/api/fgmp/maintenance/route.ts` — GET: same pattern.
11. `src/app/api/fgmp/iot/route.ts` — GET: changed `{ ...siteTenantWhere(user) }` → `{ ...siteTenantWhereOrAll(user) }`. Removed now-unused `siteTenantWhere` from imports.
12. `src/app/api/fgmp/generators/route.ts` — GET: same fix.
13. `src/app/api/fgmp/batteries/route.ts` — GET: same fix.
14. `src/app/api/fgmp/tanks/route.ts` — GET: same fix.
15. `src/app/api/fgmp/dispensers/route.ts` — GET: same fix.
16. `src/app/api/fgmp/edge/gateways/route.ts` — GET: changed `where: siteTenantWhere(auth.user)` → `where: siteTenantWhereOrAll(auth.user)`.

### Special — Firmware + Deployments (platform-level resources)

17. `src/app/api/fgmp/edge/firmware/route.ts` — GET: NO `where` clause added; `EspFirmwareRelease` has NO `tenantId` column (firmware releases are platform-level shared resources — every tenant flashes the same signed binary). Added a clarifying comment explaining why no tenant filter is applied.
18. `src/app/api/fgmp/edge/firmware/deployments/route.ts` — GET: EspFirmwareDeployment has NO direct tenantId, but the existing inline filter `where.dispenser = { site: { tenantId: auth.user.tenantId } }` was restricting SUPERADMIN. Wrapped the filter in `if (!isSuperAdminUser(auth.user))` so SUPERADMIN sees cross-tenant deployments; non-super-admins continue to see only their own tenant's deployments.
19. `src/app/api/fgmp/edge/firmware/deploy/route.ts` — POST (single-record mutation): NO change needed. Already correctly uses `assertSiteTenantOwned(dispenser?.site, user)` which bypasses for SUPERADMIN. (Note: pre-existing bug — `ROLES.DISPENSER_CONTROL` is undefined in `auth-helpers.ts`. This is out of scope for TI-2b; flagged for a future task.)

### Special — Backups (direct `tenantId`)

20. `src/app/api/fgmp/backups/route.ts` — GET: role gate `ROLES.ADMIN_ONLY` → `ROLES.SUPER_OR_ADMIN`. `where: { tenantId: me.tenantId }` → `where: tenantWhereOrAll(me)`. POST: role gate → `ROLES.SUPER_OR_ADMIN` (POST logic unchanged — still stamps `tenantId: me.tenantId` on create).
21. `src/app/api/fgmp/backups/[id]/*` routes — NOT TOUCHED. Per task spec: "Do NOT touch the single-record [id] routes — those are being fixed by another subagent (TI-2a)." TI-2a will apply `assertTenantOwned` to `backups/[id]/route.ts`, `backups/[id]/restore/route.ts`, `backups/[id]/download/route.ts`, `backups/[id]/verify/route.ts`.

### Special — API Keys (direct `tenantId`)

22. `src/app/api/fgmp/api-keys/route.ts` — GET: role gate `ROLES.ADMIN_ONLY` → `ROLES.SUPER_OR_ADMIN`. `where: { tenantId: user.tenantId }` → `where: tenantWhereOrAll(user)`. POST: role gate → `ROLES.SUPER_OR_ADMIN` (POST logic unchanged — still stamps `tenantId: user.tenantId` on create).
23. `src/app/api/fgmp/api-keys/stats/route.ts` — GET: role gate `ROLES.ADMIN_ONLY` → `ROLES.SUPER_OR_ADMIN`. Inline `const tenantWhere = { tenantId: me.tenantId }` pattern replaced with `const tenantFilter = tenantWhereOrAll(me)` (local var renamed to avoid shadowing the auth-helpers `tenantWhere` export). All 5 count queries updated.

## Routes NOT touched (per task spec IMPORTANT NOTES)

- All single-record `[id]` routes (TI-2a's scope): `alarms/[id]`, `audit/[id]`, `notifications/[id]`, `shift-handover/[id]`, `suppressions/[id]`, `geography/regions/[id]`, `geography/governorates/[id]`, `geography/districts/[id]`, `backups/[id]`, `api-keys/[id]`, `iot/[id]`, `generators/[id]`, `batteries/[id]`, `tanks/[id]`, `dispensers/[id]`, `edge/gateways/[id]`, `edge/firmware/[id]`, `edge/firmware/deploy`, `maintenance/[id]`, `deliveries/[id]`, `sites/[id]`, etc.
- Aggregation/state routes (TI-2c's scope): `/api/fgmp/state`, `/api/fgmp/realtime/snapshot`, `/api/fgmp/analytics`, `/api/fgmp/export`, `/api/fgmp/reports`, `/api/fgmp/forecast`, `/api/fgmp/patterns`.

## Schema Verification (Prisma)

Confirmed in `prisma/schema.prisma`:
- `Region` has `tenantId` ✓ — `tenantWhereOrAll` applies directly.
- `Governorate` has NO direct `tenantId` — scoped via `region.tenantId`.
- `District` has NO direct `tenantId` — scoped via `governorate.region.tenantId`.
- `EspFirmwareRelease` has NO `tenantId` — platform-level shared.
- `EspFirmwareDeployment` has NO direct `tenantId` — scoped via `dispenser.site.tenantId`.
- `BackupRecord` has `tenantId` ✓ — `tenantWhereOrAll` applies directly.
- `ApiKey`, `AuditLog`, `Notification`, `AlarmSuppression`, `ShiftHandover` all have `tenantId` ✓.

## Lint Result

`bun run lint` (eslint .) → exit 0, 0 errors, 0 warnings.

## Runtime Verification

Spot-checked via `dev.log`: `GET /api/fgmp/deliveries 200`, `GET /api/fgmp/notifications 200` — both routes responding 200 after the changes. No runtime errors visible in the most recent log entries.

## Notes / Edge Cases

- **Role gates**: For LIST endpoints that previously required `ROLES.ADMIN_ONLY` (backups, api-keys, api-keys/stats), the role gate was changed to `ROLES.SUPER_OR_ADMIN` so SUPERADMIN can actually reach the where-clause code (otherwise the where-clause fix would be dead code for SUPERADMIN). For mutation routes (shift-handover POST, notifications POST), `"SUPERADMIN"` was appended to the existing role allow-list to make the where-clause fix effective for SUPERADMIN without weakening tenant-admin access.
- **Where-clause pattern preserved**: Every change was a pure `tenantWhere` → `tenantWhereOrAll` (or `siteTenantWhere` → `siteTenantWhereOrAll`) substitution. Status filters, search-param parsing, rate-limit header application, audit log calls, Zod validation, response shapes — all preserved.
- **Cross-tenant data leak fix**: Two routes (`suppressions GET` and `geography GET`) had NO `where` clause at all — any authenticated user could read ALL tenants' suppressions/regions. Now both are tenant-scoped (with SUPERADMIN bypass).
- **Cross-tenant mutation guard added**: Three geography POST routes (`regions`, `governorates`, `districts`) now explicitly reject cross-tenant creation by non-super-admins (403 `CROSS_TENANT_FORBIDDEN`). Previously a tenant admin could create regions in another tenant by passing a foreign `tenantId` (regions POST) or by passing a foreign `regionId`/`governorateId` (governorates/districts POST).
- **Pre-existing bug flagged**: `ROLES.DISPENSER_CONTROL` is referenced in `edge/firmware/deploy/route.ts` and `edge/esp/[dispenserId]/reboot/route.ts` but is NOT defined in `auth-helpers.ts`. This causes a runtime TypeError (`Cannot read properties of undefined (reading 'includes')`). Out of scope for TI-2b but documented here for follow-up.
