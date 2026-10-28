# RBAC audit implementation ledger

**Branch:** `arena/75c8f4d2-fgmp1`
**Last verified:** 2026-10-28
**Current phase:** credential-boundary hardening complete; local Prisma Client generation, full unit suite, root typecheck, and Next/OpenNext build are now verified. Standard Prisma CLI generation and live database/authorization validation remain blocked, so the task is not production-complete.

## Completed

- [x] Repository architecture discovery: Next.js App Router, NextAuth credentials/JWT, Prisma/PostgreSQL, role enum, API routes, RLS migrations, UI gates, background scheduler and external-service routes.
- [x] Existing role and permission discovery: seven persisted roles, explicit capability role matrix, platform-only capability boundaries, 107 route files / 171 exported handlers.
- [x] Tenant model inspection: one tenant ID per User, FORCE RLS/transaction tenant context, no region/site membership model, no server actions/middleware/file upload API.
- [x] Canonical `CAPABILITIES` catalog introduced with 52 typed stable identifiers; role grants and endpoint policies use `Capability`.
- [x] `findUnknownCapabilities()` and runtime `hasCapability()` no longer treat SUPERADMIN `*` as a valid arbitrary permission; unknown identifiers fail closed for all roles and regression tests cover both paths.
- [x] Request identity flow refactored: route `bootstrap` requires `auth.user`; 89 actual API call sites pass the same principal returned by `requireAuth`/`requireRole`.
- [x] Fail-closed principal narrowing added; stale JWT identity re-resolution removed from bootstrap; `getCurrentUser()` checks active/session epoch and DB role/tenant.
- [x] Complete role catalog, permission catalog, 7 × 52 matrix and 171-handler inventory generated in `RBAC-REFERENCE-MATRIX.md`.
- [x] Evidence-based audit and remediation report written in `RBAC-AUDIT-2026-10.md`.
- [x] Security-specific test package script extended to cover route contracts, platform parity, role conformance and principal flow.
- [x] `hasCapability()` rejects unknown capabilities for every role, including SUPERADMIN; `*` remains a role-matrix marker only.
- [x] Global bridge endpoint hardened: rejects the known legacy token, constant-time digest comparison, bounded token config, private/no-store responses, minimal site/tenant ID response, and per-tenant RLS-scoped site lookup.
- [x] IoT bridge no longer has a committed service-token fallback and refuses to start without a valid explicit token; it now consumes only the minimal site directory.
- [x] IoT ingest no longer loads global operational state before API-key validation and per-key rate limiting; it uses the minimal cached directory, confirms site ownership plus key scope under tenant RLS, and writes `lastUsedAt` only after the limit permits the request.
- [x] `npx bun run test:authz`: exit 0; route inventory 171 handlers / 107 files, 0 violations; 120 pass / 0 fail / 492 expectations.
- [x] Focused UI/platform/support-session suite: 149 pass / 0 fail across eight files (overlaps the authz target).
- [x] Focused ESLint on changed credential, route, engine, bridge, store, app-shell, and contract-test files; exit 0. Bridge TypeScript project check exits 0. `git diff --check` passes.
- [x] Prisma Client generated locally for all 44 schema models using the matching Prisma schema-WASM engine commit plus Prisma 6.19.3's published client generator; `PrismaClient` import and `PrismaPg` adapter instantiation verified. The generated output is ignored under `node_modules/.prisma/client`; standard Prisma CLI generation still cannot reach the engine CDN.
- [x] Root `npm run typecheck` passes after the store permission envelope was typed as readonly to match the catalog.
- [x] Full `npx bun test`: 1,110 pass / 13 skipped / 0 fail across 75 files.
- [x] `npx next build` passes; OpenNext Cloudflare build passes when the already-completed Prisma generation pre-step is temporarily skipped. The ordinary build script remains blocked at Prisma's CDN fetch.

## Findings and decisions

1. **Stale principal after revalidation (high potential impact):** route auth established fresh authority, but `bootstrap()` re-resolved signed JWT role/tenant. Fixed by requiring and using the same authorized principal for bootstrap and domain identity. Current HTTP user-management API does not offer tenant reassignment; no current client-reachable tenant-move exploit is claimed.
2. **Wildcard masked policy typos:** verifier used SUPERADMIN wildcard as unknown-permission validation. Fixed with a canonical catalog and negative test.
3. **Regional boundary absent:** `REGIONAL_MANAGER` is tenant-wide because the schema has no region/site membership relation. No assumed migration/grants were made; product decision remains open.
4. **Bridge overexposure and credential hygiene:** the service route returned the entire cross-tenant operational snapshot while the bridge needed only site/tenant IDs; the bridge also had the published fallback token and the app used string equality. Replaced with a minimal per-tenant RLS-scoped directory, bounded/constant-time credential checks, explicit bridge configuration, and no-store responses. Still requires live DB/API verification.
5. **Unauthenticated ingest work ordering:** the IoT route loaded all tenant engine state before validating the tenant key. It now performs minimal ID resolution and site/key/scope checks under RLS, rate-limits the credential, and loads operational state only after success.
6. **No DB migrations added:** existing enum roles, user accounts, tenant IDs and data remain untouched.

## Files changed (implementation)

- `src/lib/fgmp/rbac-core.ts`
- `src/lib/fgmp/session-principal.ts` (new)
- `src/lib/fgmp/tenant-id.ts` (new)
- `src/lib/fgmp/route-tenant.ts`
- `src/lib/fgmp/rbac.ts`
- `src/lib/fgmp/index.ts`
- 89 actual `bootstrap(auth.user)` route call sites under `src/app/api/fgmp/**`
- `src/app/api/fgmp/users/route.ts` (unused import removed)
- `scripts/verify/route-inventory.ts`
- `scripts/verify/generate-rbac-reference.ts` (new)
- `package.json`
- `src/lib/fgmp/__tests__/route-authorization-contract.test.ts`
- `src/lib/fgmp/__tests__/rbac-matrix.test.ts`
- `src/lib/fgmp/__tests__/platform-tier-parity.test.ts`
- `src/lib/fgmp/__tests__/session-principal.test.ts` (new)
- `src/lib/fgmp/__tests__/bootstrap-principal-contract.test.ts` (new)
- `src/lib/fgmp/service-token.ts` and `src/lib/fgmp/__tests__/service-token.test.ts` (new)
- `src/app/api/fgmp/realtime/snapshot/route.ts`, `src/app/api/fgmp/iot/ingest/route.ts`, and `src/lib/fgmp/engine.ts` (minimal RLS-scoped bridge directory; ingest auth-before-engine-load ordering)
- `src/lib/fgmp/store.ts` (readonly capability list type aligned with the canonical role catalog so root typecheck passes)
- `mini-services/iot-bridge/service-token.ts`, bridge integration, and credential tests (new)
- `.env.example`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md`
- `docs/security/RBAC-REFERENCE-MATRIX.md` (generated)
- `docs/security/RBAC-AUDIT-2026-10.md` (new)

## Validation status

| Check | Status | Evidence / blocker |
|---|---|---|
| Authz test target | PASS | `npx bun run test:authz`; 120 passed, 0 failed / 492 expectations |
| Route inventory | PASS | 171 handlers across 107 route files, 0 violations |
| Focused UI/platform/support tests | PASS | 149 passed, 0 failed across eight files; overlaps authz target |
| Generated reference | PASS | Generator emits 7 roles, 52 capabilities, 171 handlers |
| Targeted lint / bridge tsc | PASS | Changed credential, route, engine and bridge files lint; IoT bridge project typecheck passes |
| Full lint | FAIL | 25 errors / 3 warnings, predominantly React hook/compiler diagnostics in UI components; details in audit report |
| Local Prisma Client | PASS (nonstandard generation route) | 44 schema models generated into ignored `node_modules/.prisma/client` using matching schema-WASM DMMF plus Prisma 6.19.3 client generator; adapter instantiation passes. Standard `prisma generate` remains blocked by CDN TLS failure. |
| Typecheck | PASS | `npm run typecheck` exits 0 after readonly capability type alignment. |
| Full `bun test` | PASS with skips | 1,110 passed / 13 skipped / 0 failed, 75 files, 19,472 expectations. Skips do not establish live DB/service behavior. |
| RLS script | BLOCKED | `test:rls` exits before assertions because `DATABASE_URL` is absent; runner warns to use `fgmp_app` so RLS is enforced. |
| Live authz / per-role walk | NOT RUN | No running app, seeded DB, or role credentials |
| Next/OpenNext build | PASS with qualification | `next build` passes; OpenNext bundle passes using the locally generated client after temporary removal of `prisma generate &&` from the script (restored). Standard unmodified build fails at CDN fetch. |

## Pending / blocking actions

- [ ] In CI or an environment with approved Prisma engine artifacts, verify standard `prisma generate` and the unmodified OpenNext build pipeline (the local workaround generated the client but does not prove fresh-install reproducibility).
- [ ] Rerun full lint and triage 25 React Compiler/hooks errors; confirm baseline vs introduced.
- [ ] Run a production runtime smoke test against the generated bundle.
- [ ] Run RLS regression against isolated PostgreSQL using `fgmp_app` and verify cross-tenant reads and writes, including reports/exports.
- [ ] Run live authorization matrix across all seven roles and negative direct-API/IDOR/escalation cases.
- [ ] Decide whether Regional Manager is tenant-wide or region-scoped; implement a safe assignment model only if required.
- [ ] Document current production database roles, FORCE RLS state, and secret/config evidence after deployment verification.

## Next action

Continue with standard Prisma CLI generation in a CI/runtime environment that can reach Prisma's engine CDN, then run the unmodified build pipeline and live PostgreSQL/RLS/role-walk checks. Do not mark production readiness or close the task as fully verified until the blocked checks above are recorded with actual outputs.
