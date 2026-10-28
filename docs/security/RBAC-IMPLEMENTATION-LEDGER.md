# RBAC audit implementation ledger

**Branch:** `arena/17a4002c-fgmp1`
**Last verified:** 2026-10-28
**Current phase:** supplemental source-level fail-closed hardening and focused verification complete; acceptance-scope runtime/database validation remains blocked, so the task is not production-complete.

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
- [x] `npx bun run test:authz`: exit 0; route inventory 171 handlers / 107 files, 0 violations; 113 pass / 0 fail / 449 expectations.
- [x] Focused UI/platform/support-session suite: 146 pass / 0 fail across eight files (overlaps the authz target).
- [x] Targeted ESLint on verifier, RBAC, principal, tenant and related contract-test files after latest changes; exit 0. `git diff --check` passes.

## Findings and decisions

1. **Stale principal after revalidation (high potential impact):** route auth established fresh authority, but `bootstrap()` re-resolved signed JWT role/tenant. Fixed by requiring and using the same authorized principal for bootstrap and domain identity. Current HTTP user-management API does not offer tenant reassignment; no current client-reachable tenant-move exploit is claimed.
2. **Wildcard masked policy typos:** verifier used SUPERADMIN wildcard as unknown-permission validation. Fixed with a canonical catalog and negative test.
3. **Regional boundary absent:** `REGIONAL_MANAGER` is tenant-wide because the schema has no region/site membership relation. No assumed migration/grants were made; product decision remains open.
4. **No DB migrations added:** existing enum roles, user accounts, tenant IDs and data remain untouched.

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
- `docs/security/RBAC-REFERENCE-MATRIX.md` (generated)
- `docs/security/RBAC-AUDIT-2026-10.md` (new)

## Validation status

| Check | Status | Evidence / blocker |
|---|---|---|
| Authz test target | PASS | `npx bun run test:authz`; 113 passed, 0 failed |
| Route inventory | PASS | 171 handlers across 107 route files, 0 violations |
| Generated reference | PASS | Generator emits 7 roles, 52 capabilities, 171 handlers |
| Targeted lint | PASS | Changed identity/helper/test files passed initial targeted ESLint |
| Full lint | FAIL | 25 errors / 5 warnings, predominantly existing React hook/compiler diagnostics in UI components; details in audit report |
| Typecheck | BLOCKED/FAIL | Prisma-generated client missing; generation cannot reach `binaries.prisma.sh`; errors are dominated by absent generated Prisma types, so full type status unknown |
| Full `bun test` | BLOCKED/FAIL | 914 tests / 73 files: 904 pass, 10 Prisma-dependent module-load errors (`.prisma/client/default` missing) |
| RLS script | BLOCKED/FAIL | `test:rls` exits before assertions because generated Prisma client is missing; no DB URL/service |
| Live authz / per-role walk | NOT RUN | No running app, seeded DB, or role credentials |
| Production build | BLOCKED/FAIL | OpenNext invokes Prisma generation; schema-engine download from `binaries.prisma.sh` unavailable |

## Pending / blocking actions

- [ ] In an environment with approved Prisma engine artifacts, generate Prisma client and rerun `npm run typecheck`.
- [ ] Rerun full lint and triage 25 React Compiler/hooks errors; confirm baseline vs introduced.
- [ ] Run production build and runtime smoke test.
- [ ] Run RLS regression against isolated PostgreSQL using `fgmp_app` and verify cross-tenant reads and writes, including reports/exports.
- [ ] Run live authorization matrix across all seven roles and negative direct-API/IDOR/escalation cases.
- [ ] Decide whether Regional Manager is tenant-wide or region-scoped; implement a safe assignment model only if required.
- [ ] Document current production database roles, FORCE RLS state, and secret/config evidence after deployment verification.

## Next action

Continue with a Prisma-enabled CI/runtime validation environment. Do not mark production readiness or close the task as fully verified until the blocked checks above are recorded with actual outputs.
