# Task 4 — Backend SUPERADMIN API enforcement

**Agent:** full-stack-developer (backend superadmin API)
**Task:** Update FGMP backend API routes (users, tenants, me, reset-password) to enforce the SUPERADMIN vs tenant-ADMIN model.

## What I changed

Six API route files under `src/app/api/fgmp/`. Foundation files (types.ts, rbac.ts, auth-helpers.ts, seed.ts, i18n.ts) were left untouched per the orchestrator's instruction.

### 1. `users/route.ts`
- **GET**: `tenantWhere(auth.user)` → `tenantWhereOrAll(auth.user)` so SUPERADMIN sees all users cross-tenant.
- **POST**: `ROLES.ADMIN_ONLY` → `ROLES.SUPER_OR_ADMIN`. Added `SUPERADMIN` to `VALID_ROLES`. Added optional `tenantId` to the Zod schema.
  - `CANNOT_ASSIGN_SUPERADMIN` (403) when ADMIN caller requests `role=SUPERADMIN`.
  - Tenant resolution: ADMIN → always `me.tenantId`; SUPERADMIN → required `tenantId` for non-SUPERADMIN roles (400 if missing), defaults to `t-platform` for SUPERADMIN role, validates tenant exists.
  - Kept bcrypt + audit log.

### 2. `users/[id]/route.ts`
- All four handlers (GET/PUT/PATCH/DELETE): `ROLES.ADMIN_ONLY` → `ROLES.SUPER_OR_ADMIN`.
- Added a shared `guardSuperAdminTarget(target, me)` helper invoked right after each `assertTenantOwned` check (which already bypasses for super-admins). Returns 403 `CANNOT_MODIFY_SUPERADMIN` if the target is a SUPERADMIN and the caller is NOT a super-admin.
- PUT also adds the `CANNOT_ASSIGN_SUPERADMIN` (403) guard when caller is ADMIN and the new `role` is `SUPERADMIN` — checked BEFORE fetching the existing record so the request never reaches the DB.
- Added `SUPERADMIN` to `VALID_ROLES`. Kept the "cannot deactivate self" guard.

### 3. `users/[id]/reset-password/route.ts`
- `ROLES.ADMIN_ONLY` → `ROLES.SUPER_OR_ADMIN`.
- Added the `CANNOT_MODIFY_SUPERADMIN` (403) guard inline (target.role === "SUPERADMIN" && caller not super-admin) after `assertTenantOwned`.
- Kept the "cannot reset own password" guard.

### 4. `tenants/route.ts`
- GET: replaced `user.role === "ADMIN" ? {} : tenantWhere(user)` with `tenantWhereOrAll(user)`. Swapped the import.
- POST (create tenant): `ROLES.ADMIN_ONLY` → `ROLES.SUPERADMIN_ONLY`. Now ONLY super-admins can create tenants. Kept Zod validation, unique-name/code pre-check, rate-limit, and audit.

### 5. `tenants/[id]/route.ts`
- GET: replaced `user.role !== "ADMIN"` with `!isSuperAdminUser(user)`. SUPERADMIN can read any tenant; everyone else only their own.
- PATCH: `ROLES.ADMIN_ONLY` → `ROLES.SUPERADMIN_ONLY`. Removed the dead `existing.id !== user.tenantId` own-tenant check (only SUPERADMIN reaches this handler now). Kept unique-name/code validation + audit.
- DELETE: `ROLES.ADMIN_ONLY` → `ROLES.SUPERADMIN_ONLY`. Removed the dead own-tenant check. Kept the "refuse to delete tenants with users/sites" safety check + audit.

### 6. `me/route.ts`
- GET: `roles: role === "ADMIN" ? ALL_ROLES : [role]` → `roles: (role === "ADMIN" || role === "SUPERADMIN") ? ALL_ROLES : [role]` so SUPERADMIN can also switch roles in the UI.
- PATCH (role switch): `ROLES.ADMIN_ONLY` → `[...ROLES.SUPER_OR_ADMIN]`.

## Guard summary

| Endpoint | Caller | Target / Action | Result |
|---|---|---|---|
| POST /users | ADMIN | role=SUPERADMIN | 403 CANNOT_ASSIGN_SUPERADMIN |
| POST /users | SUPERADMIN | non-SUPERADMIN role, no tenantId | 400 "tenantId is required..." |
| POST /users | SUPERADMIN | SUPERADMIN role, no tenantId | default tenantId = `t-platform` |
| PUT /users/[id] | ADMIN | new role=SUPERADMIN | 403 CANNOT_ASSIGN_SUPERADMIN |
| GET/PUT/PATCH/DELETE /users/[id] | ADMIN | target.role=SUPERADMIN | 403 CANNOT_MODIFY_SUPERADMIN |
| POST /users/[id]/reset-password | ADMIN | target.role=SUPERADMIN | 403 CANNOT_MODIFY_SUPERADMIN |
| POST /tenants | ADMIN (non-super) | — | 403 INSUFFICIENT_ROLE |
| PATCH/DELETE /tenants/[id] | ADMIN (non-super) | — | 403 INSUFFICIENT_ROLE |
| GET /tenants | SUPERADMIN | — | sees ALL tenants |
| GET /tenants/[id] | SUPERADMIN | any id | allowed |

## Lint result
`bun run lint` → PASS (0 errors, no output).

## Notes for downstream agents
- The error `seedSuperAdmin is not defined` that appeared earlier in `dev.log` was a stale-compile artifact from before seed.ts had the function defined at line 457; recent log entries show `/api/fgmp/alarms`, `/api/fgmp/state`, and `/api/fgmp/tick` all returning 200, which means `bootstrap() → seedIfNeeded() → seedSuperAdmin()` is now working. I did NOT modify seed.ts.
- All guards use `isSuperAdminUser(me)` (from auth-helpers) consistently rather than re-implementing the role check, so a future rename of the SUPERADMIN role only needs one edit.
- The `CANNOT_ASSIGN_SUPERADMIN` and `CANNOT_MODIFY_SUPERADMIN` codes are documented in the response body alongside the human-readable `error` field, so frontend agents can switch on the code if desired.
