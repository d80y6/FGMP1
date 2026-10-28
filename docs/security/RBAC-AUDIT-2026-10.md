# FGMP1 SaaS authorization audit and remediation report

**Audit date:** 2026-10-28  
**Scope:** repository source, Prisma schema/migrations, App Router API handlers, session/authentication code, authorization policy, UI gates, scheduler/service entry points, tests, and deployment configuration.  
**Reference matrix:** [`RBAC-REFERENCE-MATRIX.md`](./RBAC-REFERENCE-MATRIX.md) — generated from the role catalog and all 171 exported API handlers.  
**Existing evidence reviewed:** [`AUTHZ.md`](../AUTHZ.md), [`SECURITY.md`](../SECURITY.md), [`SUPERADMIN.md`](../SUPERADMIN.md), [`RBAC-REVIEW-2026-10.md`](../RBAC-REVIEW-2026-10.md), [`RBAC-LIVE-WALK-2026-10.md`](../RBAC-LIVE-WALK-2026-10.md), and `TASK_LEDGER.md` Part B.

## Executive result

FGMP1 already contains a substantially developed authorization stack: seven persisted enum roles; a capability allow-list; API path/method policies; per-handler role/capability gates; database-revalidated sessions; tenant-scoped Prisma helpers; PostgreSQL FORCE RLS migrations; and UI permission gates. The current tree exposes **171 API handler methods across 107 route files**. The route inventory and capability/role conformance tests pass with **zero static policy-contract violations**.

This execution found and fixed four authorization-boundary weaknesses that were not covered by the earlier static route contract:

1. **The server revalidated a session and then many handlers fetched the JWT principal again.** `requireAuth()` returned a fresh role/tenant and applied the role-preview overlay, but `bootstrap()` independently called `getCurrentUser()` against NextAuth's signed session. That second identity could be stale and ignore a current preview. The 89 request-side `bootstrap()` call sites now pass `auth.user` (the principal that actually passed server authorization) through a fail-closed typed narrowing function. A generated-source regression test prevents reintroducing an unbound bootstrap identity.
2. **The capability typo checker treated SUPERADMIN's `*` as evidence that every arbitrary permission identifier was valid.** This made the closed-vocabulary check ineffective for misspellings. FGMP now has a canonical typed `CAPABILITIES` catalog (52 identifiers, including five platform-only keys); role grants and read/write policies use the `Capability` type; the route verifier checks against the catalog without treating `*` as a capability. Runtime checks now reject unknown identifiers for all roles. A negative test proves that `view:sitez` is invalid even though SUPERADMIN has a wildcard.
3. **The cross-tenant bridge endpoint exposed more data than its service needed.** It returned the complete global operational snapshot although the IoT bridge only consumes site IDs and tenant IDs. It also compared the token with ordinary string equality and the bridge retained the publicly known legacy token fallback. The endpoint now returns a minimal RLS-scoped site directory, rejects that legacy secret, compares digests with `timingSafeEqual`, and marks every response private/no-store; the bridge fails fast when its explicit secret is missing or invalid.
4. **Unauthenticated ingest attempts could trigger a full engine load before API-key validation.** The bounded request body was parsed, but the handler then loaded all tenant operational state to resolve the submitted site before verifying the tenant API key. It now uses the cached ID-only directory to identify the tenant, verifies the current site and key in that tenant's RLS transaction, applies the per-key rate limit before writing `lastUsedAt`, and only then loads operational engine state.

No schema migration was needed: no database role/permission tables are used, and the existing persisted `Role` enum and role assignments remain unchanged. This report is **not a claim of production readiness**: full TypeScript/build checks and live PostgreSQL/RLS/API/E2E verification could not be completed in this sandbox. See §9 and the residual-risk register.

## 1. Repository and architecture findings

### Runtime and application

- Next.js App Router (Next 16), TypeScript/React, Prisma 6, PostgreSQL, with Cloudflare/OpenNext deployment configuration.
- Authentication is NextAuth Credentials with bcrypt-backed accounts and JWT sessions (`src/lib/auth.ts`). A pending MFA login has no role or tenant. Account role, active state, tenant, and `sessionEpoch` are re-read by `getSessionState()` for protected requests (`src/lib/fgmp/auth-helpers.ts`, `src/lib/auth-identity.ts`).
- The ordinary application database role is expected to be `fgmp_app`; owner/ops credentials are separate and used by limited identity/control-plane modules. FORCE RLS migrations and transaction-local tenant context are present (`src/lib/tenant-context.ts` equivalent under `src/lib/fgmp/tenant-context.ts`, `src/lib/db-rls.ts`, `prisma/migrations/*enable_rls*`). Deployment configuration sets `FGMP_REQUIRE_RLS` in the container path; production environment values were not available for this audit.
- There is no Next middleware and no `"use server"` server action surface in `src`. The principal interactive server boundary is the API route tree. There are 107 route modules and 171 exported methods.
- The only export endpoint in the route tree is the tenant-aware CSV endpoint (`/api/fgmp/export`); no independent upload/download/file-serving API was found. Device ingress (`/api/fgmp/iot/ingest`) uses an API key, and realtime service snapshot uses a service token; these are explicit non-session identities.
- A scheduler/background engine exists (`src/lib/fgmp/scheduler.ts`). It is a service/ops execution context, not a browser role. Scheduled operations and database enforcement were not live-exercised without a configured database.

### Identity, roles, and persistence

- The Prisma `Role` enum and application union both contain `SUPERADMIN`, `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, and `READONLY`.
- Users have a single `tenantId` and one enum role. There are no custom roles, permissions table, many-to-many memberships, role inheritance, user grants, per-site assignments, or region membership relation in the schema. A role grant is therefore a built-in capability set, not tenant-configurable RBAC.
- `SUPERADMIN` is a separate platform tier. It is pinned to the platform tenant for ordinary tenant-scoped queries. Cross-tenant customer content is intended to be reached through an explicit support session; tenant user-roster administration is a separately documented, tightly scoped exception.
- The `REGIONAL_MANAGER` role name and description imply geographic responsibility, but the current schema does not associate users with regions. Effective data scope is the **whole authenticated tenant**, not a subset of regions. This is a documented limitation, not a claim that geographic ABAC exists.

## 2. Reference authorization model

The application retains established stable permission identifiers instead of renaming them to a new dotted convention (which could silently break routes/UI and persisted role behavior). The canonical catalog is in `src/lib/fgmp/rbac-core.ts` as `CAPABILITIES`; identifiers currently use `view:<surface>` or `<domain>:<action>`.

### Authority and decision order

1. Authentication establishes the user from a signed NextAuth session.
2. `requireAuth(request)` revalidates the account against the database, rejects disabled/revoked accounts, applies MFA pending-session allowlisting, applies a valid role-preview overlay, then evaluates the request's capability policy.
3. `requireRole` / `requireSuperAdmin` and action-specific `can()` checks further narrow the request.
4. Tenant context must be created from the revalidated principal; row queries use tenant-scoped helpers and/or resource ownership constraints.
5. PostgreSQL FORCE RLS is the independent database backstop when connected as the configured non-owner app role.
6. UI navigation and action gates mirror the same capability decisions for usability only; they are not trusted for access control.

All authorization layers are intersections. A later check cannot widen a previous denial. Unknown FGMP endpoint paths fail closed. Export datasets and shared analytics/report projections have parameter-specific policy checks to prevent a broad screen permission from authorizing a different payload.

### Roles and intended responsibilities

The complete role identifiers, purpose, scope, and boundaries are in the generated reference matrix. In summary:

| Role | Scope | Intended duties and boundary |
|---|---|---|
| `SUPERADMIN` | Platform control plane; tenant content only through explicit support access | Platform tenant registry, platform audit/grants, support-session management, global firmware, and controlled tenant user administration. Wildcard does not disable tenant RLS. |
| `ADMIN` | One tenant | Tenant user administration, tenant configuration, asset/site/geography management, and operational control capabilities the current routes expose. Cannot create tenants or grant the platform role. |
| `NOC_OPERATOR` | One tenant | Monitoring, alarm handling, generator/dispenser operation, notification operations and simulation tick. No user/platform/asset administration. |
| `REGIONAL_MANAGER` | One tenant in current model | Operational oversight, reports, alarm configuration, delivery and maintenance workflows. Not region-filtered today. |
| `FIELD_ENGINEER` | One tenant | Field maintenance/delivery work and dispenser control; no tenant membership, platform, asset-admin or broad settings privileges. |
| `EXECUTIVE` | One tenant | Read-only operational/business visibility; no control actions. |
| `READONLY` | One tenant | Monitoring and audit visibility; no control or administrative actions. |

No inheritance is implemented. Ordinary roles use explicit allow-lists. SUPERADMIN alone has `*`, with platform-only capability boundaries independently checked by route-policy parity tests and platform handler guards.

## 3. Permission catalog and matrix

The full catalog includes **52 typed capabilities**. This comprises 47 capabilities explicitly represented in role permissions plus five reserved platform-only keys (`tenant:manage`, `view:tenants`, `view:tenant-isolation`, `platform:firmware`, `user:grant-superadmin`). The complete catalog includes scope, short purpose, related API handlers, and the full seven-role allow/deny matrix in [`RBAC-REFERENCE-MATRIX.md`](./RBAC-REFERENCE-MATRIX.md).

The catalog covers existing actual modules and workflows: dashboard, sites/geography, fuel/inventory, generators, batteries, dispensers, alarms/suppressions/correlation, edge/IoT, maintenance, deliveries, analytics/reports/exports, audit, users/preferences/MFA, API keys, settings/interlocks, simulation, tenants, platform audit/grants/support, and global firmware.

The catalog intentionally does not invent actions absent from the application. For example, there is no generic `roles.assign` API or arbitrary custom role editor. Role changes are user-administration operations protected by `user:manage`, the SUPERADMIN grant boundary, placement rules, grant guards, and audit logging. Delete, control, export and configuration actions are distinct where the application has distinct workflows; an ordinary `view:*` grant alone does not authorize mutations.

## 4. Declared, enforced, and effective access comparison

### Declared

- The application has an explicit seven-role `Role` enum and a shared role-to-capability allow-list in `ROLE_PERMISSIONS`.
- `CAPABILITIES` is now the closed typed vocabulary. The verifier checks that policies and export capabilities refer to a catalog key independently of SUPERADMIN's wildcard.
- Route policy rules map path/method to one or more capabilities. For multi-capability rules the existing convention is any-of; action-specific routes add tighter handler checks where a rule must distinguish operations (e.g. alarm acknowledge vs resolve).
- Role preview is a short-lived signed overlay, tied to the user and only available to the intended admin roles; it does not update persisted role assignments.

### Enforced

- The repository's route inventory found all 171 handlers. It reports no missing FGMP policy, no protected handler without a guard, no session guard that fails to pass the request into the policy check, no route allow-list broader than its policy, no unknown role identifiers, and (after this remediation) no unknown capability identifiers.
- Tenant-owned reads and mutations are designed to use direct `tenantId` or parent-site tenant constraints with transaction-local tenant context. Migrations establish FORCE RLS on tenant-carrying tables. The documented platform surface uses its dedicated platform stores and support-session path.
- Existing protection of user role assignment includes a fixed platform-tenant placement rule for SUPERADMIN, grant-change safeguards, and checks against tenant-admin self-promotion. These were already present and covered in `docs/RBAC-REVIEW-2026-10.md` and `platform-tier-parity.test.ts`.
- The full UI audit is already covered by shared navigation, mutation-gate, link-surface and view-gate tests. Frontend checks are supplemental only.

### Effective

The role-policy test matrix confirms the policy-side set for each route. Handler-level checks, support-session requirements, record ownership, tenant context and database RLS narrow effective access further. A live, database-backed cross-tenant request matrix was **not** executed in this turn. Therefore the audit can report the static route and query architecture plus existing repository test evidence, but cannot claim that the deployed database credentials/policies or every runtime row path were successfully exercised now.

## 5. Findings and remediation

### A-1 — Protected routes could re-resolve a stale JWT after authorization (HIGH potential impact; remediated)

**Evidence:** `src/lib/fgmp/auth-helpers.ts` constructs a revalidated user after `getSessionState()` and applies role-preview before policy evaluation. `src/lib/fgmp/index.ts` previously implemented `bootstrap()` by calling `getCurrentUser()` again, which used `getServerSession()` and the JWT role/tenant. A repository search found 89 request-handler call sites that invoked `bootstrap()` after their guard, including data handlers that used the returned user for tenant query scope. `auth.ts` refreshes JWT role/tenant on a client-triggered token update, not as the authorization result for every request.

**Expected:** authorization, role preview and tenant/resource queries in one request must use the same principal resolved at the guarded server boundary.

**Impact:** a role or tenant change between token refreshes could leave route policy using the new state but downstream bootstrap scoping using old signed claims. A valid role preview could likewise be ignored by downstream code. The current public user-edit route does not expose tenant reassignment, so this was a stale-principal architectural defect and escalation risk under account/tenant changes, not evidence of an existing client-reachable tenant-move exploit.

**Correction:** `bootstrap(sessionUser)` now requires the guarded principal and applies `toFgmpUser()` to that exact principal. All 89 actual API bootstrap call sites pass `auth.user`. `getCurrentUser()` independently revalidates active state, session epoch, role, and tenant before returning a principal; it is no longer used to derive request identity during bootstrap. The mapper rejects missing/invalid role or tenant values and preserves the previewed role.

**Verification:** `session-principal.test.ts`, `bootstrap-principal-contract.test.ts`, full static route-contract tests and `npm run test:authz` (invoked with `npx bun`) pass. Live mutation/reassignment scenarios remain for a DB-backed test environment.

### A-2 — SUPERADMIN wildcard defeated invalid-capability detection (MEDIUM correctness/security assurance; remediated)

**Evidence:** previous `findUnknownCapabilities()` collected `*` and skipped unknown identifiers whenever any role held it. Since SUPERADMIN always holds `*`, a misspelling in a route policy could pass the verifier and fail closed for every tenant role without a diagnostic.

**Impact:** accidental denial / authorization drift and a verifier that appeared to prove more than it did. Previously the wildcard also made `hasCapability(SUPERADMIN, unknownString)` return true, although it did not grant the typo to tenant roles.

**Correction:** introduced a canonical `CAPABILITIES` literal and `Capability` type, applied capability typing to role grants and endpoint/export rules, and changed the verifier to compare identifiers to the catalog. Runtime `hasCapability()` now rejects identifiers outside the catalog before applying SUPERADMIN's wildcard. `*` is a role grant marker, never a capability identifier.

**Verification:** regression tests assert unknown capability `view:misspelled-surface` is denied for every role (including SUPERADMIN), a known capability is authorized by its wildcard, and `*` itself is not a capability. The route inventory also rejects the typo `view:sitez` and currently reports no unknown capability.

### A-3 — Regional/organizational sub-tenant scope is not represented (MEDIUM product/security requirement risk; unresolved)

**Evidence:** `User` has `tenantId` and `role`; no Region membership, assigned-site, organizational-unit or scoped membership relation exists. `REGIONAL_MANAGER` routes therefore use tenant-level scoping like other tenant roles.

**Impact:** if customers expect a regional manager to see only assigned regions, current code does not enforce that requirement. No region isolation claim should be made from the role name.

**Disposition:** no schema migration or guessed assignment was made. Such a change requires a product decision, an assignment model, migration/default semantics and exhaustive query tests. It is explicitly called out in the generated matrix and residual register.

### A-4 — Bridge credential could authorize an oversized global response (MEDIUM exposure minimization; remediated in source)

**Evidence:** `/api/fgmp/realtime/snapshot` used ordinary string inequality for the service token and serialized `engine.snapshot()`, which contains operational data across tenants. The bridge's code only reads `sites` to obtain IDs, tenant IDs, names, and regions, and its source still supplied the historically published `fgmp-realtime-dev-token` when the environment value was absent. The app already failed closed when its own token was absent, so this is not evidence that an unauthenticated caller could reach the endpoint; the known value was dangerous if copied into the app's configured secret.

**Impact:** a compromised/misconfigured bridge credential received much more customer operational data than the bridge needed. Ordinary string equality also creates an avoidable timing side channel. A public fallback could silently make operators choose a known value and conceal missing secret configuration.

**Correction:** introduced bounded service-token configuration validation that rejects the historical value, digest-based `timingSafeEqual` comparison, and bridge startup validation with no fallback. The service endpoint now returns only `{ sites: [{ id, tenantId }] }`, queried per tenant under `withTenant`; it no longer calls the global engine snapshot. All responses receive `Cache-Control: private, no-store, max-age=0`.

**Verification:** unit tests cover valid, missing, short, oversized, legacy-default, exact-match, mismatch, and different-length credential cases. The route contract verifies credential-before-query ordering, RLS-scoped ID-only query shape, no snapshot call, and no-store behavior. Bridge TypeScript check passes. These are source/unit checks; live database RLS and an end-to-end bridge request were not available.

### A-5 — Invalid IoT ingest credentials could trigger global engine initialization (MEDIUM availability/data-minimization risk; remediated in source)

**Evidence:** after a bounded body was parsed, `/api/fgmp/iot/ingest` called `engine.ensureAllTenants()` and searched the global in-memory site list before checking whether the submitted API key belonged to that site's tenant. On a cold isolate, a request with an invalid key could trigger a database load of all tenant operational state.

**Impact:** unauthenticated requests could cause expensive global initialization and unnecessarily place cross-tenant operational state in process memory, increasing cold-start/database pressure. The route did not return that data to the caller; this was an authorization-order/resource-exhaustion concern, not evidence of an unauthenticated read.

**Correction:** resolve only opaque `{id, tenantId}` pairs through a 30-second single-flight directory cache; check the submitted site still belongs to that tenant and validate the API key/scopes within `withTenant`; rate-limit the authenticated key; only then call `ensureAllTenants()` for the authorized ingest operation. Invalid requests no longer trigger the full engine load.

**Verification:** route-contract regression asserts site/key validation and per-key rate limiting precede `ensureAllTenants()`. The directory query is explicitly tenant-scoped and selects only IDs. No PostgreSQL-backed runtime or load test was possible; do not claim deployed performance or RLS behavior from the static test.

### Existing audited issues in the repository

The preceding RBAC review documents many fixes already present at this base commit. These were corroborated by current source/tests, not re-implemented gratuitously: distinct alarm acknowledge/resolve checks; dispenser control route/capability parity; export type allow-list and data/capability pairing; MFA pending allowlist invocation; platform role placement; support-session scope; tenant-scoped user administration; role-to-view/action consistency; mutation/UI affordance gates; fail-closed unknown endpoints; and per-handler route inventory. See `docs/RBAC-REVIEW-2026-10.md` §§3–12, `docs/AUTHZ.md`, and the named tests for detailed original evidence.

## 6. Tenant isolation and entry-point audit

- **Tenant context:** application sessions carry one database-resolved tenant ID; `tenantIdOrThrow()` refuses an absent tenant. Tenant switching was not found as a user-facing operation; no arbitrary request tenant is accepted for ordinary tenant data.
- **Query enforcement:** `route-tenant.ts` exposes typed transaction-scoped `asTenant`, explicit cross-tenant `asTenantForAnotherTenant`, and scope resolution. Direct and parent-site tenant filters are used by route handlers, with FORCE RLS in migration SQL as the database backstop. A static route inventory does not prove every Prisma call's predicates; the repository's dedicated RLS regression suite exists for live verification.
- **Platform:** `SUPERADMIN` does not mean all-tenant row access. Tenant registry metadata and narrowly scoped aggregates use dedicated platform-store operations. Customer support reads require a valid support session for the named tenant and execute under that tenant context. The support cookie is constrained to the platform path, and write-mode access is separately constrained.
- **User administration:** tenant roster APIs are limited to SUPERADMIN/ADMIN. Tenant admins remain pinned to their tenant and cannot create/promote a platform superadmin; SUPERADMIN cross-tenant roster operations name a tenant explicitly and route through the privileged context helper.
- **Files/exports:** no generic file upload/download surface exists in the route tree. CSV export has an explicit dataset-to-capability catalog and tenant query scope. Generated reference enumerates it.
- **External services:** device ingest and realtime bridge directory have separate API-key/service-token checks; they are not authorized by a user role. Ingest keys are verified under the submitted site's tenant. The bridge token exposes only tenant-scoped site/tenant IDs, not a full global snapshot; the route contract asserts credential validation and the minimal payload boundary.
- **Pages/actions:** no App Router server actions or middleware files were found. UI access checks filter navigation, links and action controls but all protected APIs independently enforce their server-side policy.
- **Cross-tenant runtime cases:** not re-executed without PostgreSQL. Existing `test:rls`, platform boundary, tenant context and support-session tests cover related behavior; exact run status appears in §9.

## 7. Architecture and files changed

### Authorization refactor

- `src/lib/fgmp/rbac-core.ts`: authoritative 52-key typed capability catalog; role grant lists and API policy rules use `Capability`; known admin-only capability keys are included explicitly; runtime capability checks reject unknown keys before applying the SUPERADMIN wildcard; existing permission identifiers and role assignment behavior are retained.
- `src/lib/fgmp/session-principal.ts`: validates a guarded `SessionUser` and narrows it to a domain principal; uses the same canonical role set; rejects missing role/tenant and invalid role strings.
- `src/lib/fgmp/tenant-id.ts`: dependency-free tenant ID guard shared by route scoping and principal resolution, permitting tests without loading Prisma.
- `src/lib/fgmp/route-tenant.ts`: re-exports the shared tenant guard without changing the query-context behavior.
- `src/lib/fgmp/index.ts`: `bootstrap` now requires the authorized user and never fetches an independent request identity.
- `src/lib/fgmp/rbac.ts`: `getCurrentUser()` checks live session state before returning the database-backed principal.
- All 89 actual `bootstrap()` call sites in protected API routes now pass `auth.user`; the service-token/device paths retain their separate credential model and do not gain a user role.
- `scripts/verify/route-inventory.ts`: capability verification now uses the canonical vocabulary and rejects the previous wildcard-based false acceptance.
- `scripts/verify/generate-rbac-reference.ts` and `docs/security/RBAC-REFERENCE-MATRIX.md`: deterministic generation of role catalog, permission catalog, complete matrix and 171-handler route inventory.
- Tests added/extended: principal/bootstrap contracts, role matrix, platform parity, route authorization, and service-token/bridge credential configuration cases. `test:authz` includes server conformance, platform parity, principal flow, unknown-capability fail-closed behavior, and service-credential regressions.

### Database and migration status

No role/permission schema migration was introduced. The current schema stores built-in role enum values, user tenant IDs and business data; it does not persist a role-permission join table. Existing accounts, roles, memberships/tenant IDs, data and migrations are not rewritten. Existing RLS migrations were reviewed by source, but their deployed state was not validated against a live database in this environment.

## 8. Tests and validation evidence

### Passed in this execution

- `npx bun run test:authz` — **exit 0**. Route inventory: **171 handlers, 107 route files, 0 authorization contract violations**. Authorization suite: **120 passed, 0 failed, 492 expectations** across ten files, including capability, principal and external service-token regressions.
- Additional focused static/UI/platform suite run (`rbac-mutation-gates`, `rbac-ui-gates`, `rbac-link-surfaces`, `rbac-nav-single-source`, `platform-surface`, `support-session`, `route-authorization-contract`, `platform-tier-parity`) — **149 passed, 0 failed** across eight files. This distinct run overlaps some `test:authz` cases and adds UI mutation, navigation, platform, and support-session evidence.
- Focused ESLint on the changed service-token, route, engine, bridge and contract-test files — **exit 0**; `git diff --check` also passes. The IoT bridge TypeScript project check (`npx --no-install tsc --noEmit -p mini-services/iot-bridge/tsconfig.json`) — **exit 0**.
- `npx bun run scripts/verify/generate-rbac-reference.ts` — **exit 0**, generated all 7 roles, 52 capabilities and 171 API methods.

### Failed or blocked; not reported as passing

- `npm run typecheck` — **exit 2**, 518 TypeScript diagnostics. The Prisma client has not been generated: errors report missing `Prisma`/`PrismaClient`, Prisma model/enums and consequently untyped query results. Diagnostics in the engine/query code changed here cascade from those missing generated types; the independent bridge TypeScript project passes. `npx prisma generate` cannot download Prisma's schema/query engine because the sandbox cannot reach `binaries.prisma.sh`. Full app type status remains unverified.
- Full `npx eslint .` — **exit 1**, 25 errors and 3 warnings. Errors are predominantly React Compiler/hooks diagnostics in UI views (synchronous setState in effects, refs/impure render computations and memoization mismatches); the focused lint for changed authorization/credential files passes. Full lint remains failing and requires baseline confirmation/remediation.
- Full `npx bun test` — **exit 1**, 921 tests across 75 files; **911 passed, 10 failed with 10 module-load errors**. Prisma-dependent tests could not import `'.prisma/client/default'`; this is a missing generated-client setup, not a passing full suite.
- Database-backed `npx bun run test:rls` — **exit 1** at startup with `Cannot find module '.prisma/client/default'`. No database URL or generated client is available, so it did not exercise RLS assertions. This was rerun in the current environment; it failed before any assertions.
- `test:authz:live`, `test:rbac-walk`, and MFA live flow were not run: no `DATABASE_URL`, running application, seeded roles or live credentials are configured in this workspace. Their results are not claimed.
- `npx bun run build` — **exit 1**. OpenNext invoked `prisma generate`, which could not fetch Prisma's `schema-engine.gz.sha256` from `binaries.prisma.sh`; Next build did not start. Production build status is **unverified**.

## 9. Residual risk register

| ID | Risk | Severity | Component / evidence | Why unresolved | Required remediation / priority |
|---|---|---|---|---|---|
| R-1 | Regional managers have tenant-wide, not region-limited, visibility/actions | Medium; High if region privacy is contractual | `User` schema has no region/site membership; role is named regional | No product-approved mapping exists; inventing one would either deny existing users or grant broad access | Product/security decision, add explicit membership/region assignment, safe data migration, query-scope helpers and cross-region API/RLS tests. **Before region-restricted customer rollout.** |
| R-2 | Live PostgreSQL FORCE RLS and cross-tenant query behavior were not verified in this workspace | High until deployment evidence is current | `prisma/migrations/*enable_rls*`, `tenant-context`, RLS regression script | No DB URL/service or running DB was provided; external engine fetch unavailable | Run `bun run test:rls` against isolated Postgres with `fgmp_app`, then verify Tenant A read/update/delete/report/export/file/switch attempts against Tenant B; capture output in deployment evidence. **Before production sign-off.** |
| R-3 | Full typecheck and production build are unverified | Medium | `npm run typecheck`, `npm run build` | 518 diagnostics cascade from absent generated Prisma exports; Prisma engine downloads from `binaries.prisma.sh` fail in this environment | Run Prisma generation in CI with approved engine artifacts, then typecheck and production build. **Before merge/deploy.** |
| R-4 | Full repository lint has 25 React hook/compiler errors | Low/Medium quality gate | Full ESLint run; errors in UI view files | Full run fails; changed security/credential files pass focused lint | Baseline and remediate the UI diagnostics; rerun full lint. **Before required lint gate.** |
| R-5 | API and bridge credential checks have source/unit evidence, not live endpoint evidence | Medium | 171-handler analyzer, token unit tests, per-tenant directory query, route contracts | No live server/DB/role fixtures were available | Run live role walk, cross-tenant IDOR/escalation cases, and bridge-token/site-directory integration against isolated PostgreSQL. **Before production sign-off.** |
| R-6 | Audit log immutability is application-level; a compromised DB app principal may rewrite logs | Medium | `docs/SECURITY.md` §11 | Existing deployment gap; no DB grant changes made here | Restrict `fgmp_app` privileges to SELECT/INSERT on audit tables and ship audit events off-box. **Security hardening.** |

## 10. Completion status

- [x] Repository architecture, roles, route modules, schema, session code, authorization helpers, UI gate suites and deployment/test scripts inspected.
- [x] Existing seven roles and all 52 capability identifiers inventoried and typed.
- [x] Complete generated role, permission, scope and permission matrix produced.
- [x] 171 API handler methods enumerated with policy, guard and source references.
- [x] Stale principal re-resolution corrected; all 89 actual route bootstrap call sites pass the guarded principal.
- [x] Unknown capability identifiers fail closed in the verifier and runtime for every role, including SUPERADMIN; regression coverage treats `*` as a matrix declaration only.
- [x] Bridge credential boundary narrowed: legacy default rejected, comparison hardened, endpoint returns only per-tenant RLS-scoped site/tenant IDs with no-store headers.
- [x] Authz suite and generated matrix command executed successfully.
- [ ] Live cross-tenant PostgreSQL/RLS tests and real HTTP/E2E per-role walk verified in this environment.
- [ ] Typecheck, full lint, and production build are green.
- [ ] Regional scope requirement decided (tenant-wide vs region-level).

**Conclusion:** source-level authorization architecture and automated contract evidence materially improved. This audit is evidence-based but remains **conditionally incomplete for production assurance** until R-2, R-3 and R-5 are executed against the intended deployment stack.
