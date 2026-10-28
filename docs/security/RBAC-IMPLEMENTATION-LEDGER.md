# RBAC audit implementation ledger

**Implementation PR:** [#32](https://github.com/d80y6/FGMP1/pull/32), merged to `master` on 2026-10-28.
**Current continuation branch:** `arena/6f6818ed-fgmp1`
**Last verified:** 2026-10-28
**Current phase:** PR #33 (`9db6a14`) adds fail-closed inconclusive handling and a fresh-server seven-role API walk. CI run [40724629338](https://github.com/d80y6/FGMP1/actions/runs/40724629338) completed the API walk successfully (exit 0) and uploaded its Markdown/JSON artifact; all other jobs except the long-running UI browser suite had passed at last status check. The artifact download returned EOF from the external Actions blob host, so the raw per-role report was not independently read in this sandbox; a successful walk exit means its current checks found no mismatch or inconclusive probes. Remaining work: confirm final browser-suite status, inspect the report artifact, verify broader live cross-tenant/IDOR and escalation cases, validate deployment pooler/secrets, and decide Regional Manager scope. Do not claim production readiness.

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
- [x] Full `npx bun test`: 1,115 pass / 13 skipped / 0 fail across 76 files (19,499 expectations). A local walk against an intentionally unreachable loopback port generated all seven role records and exited 2 with an explicit inconclusive summary, confirming offline failures cannot pass silently.
- [x] Local sandbox `npx next build` passes; its OpenNext run required temporarily skipping the already-completed Prisma generation pre-step because the sandbox cannot reach Prisma's engine CDN.
- [x] GitHub Actions CI run [40708733488](https://github.com/d80y6/FGMP1/actions/runs/40708733488) for PR head `93fff2542c7ecdf28e028e55e24d5a8be21d4a2` passed all six jobs: `verify`, `mini-services (iot-bridge)`, `provisioning`, `docker`, `rls`, and `ui`.
- [x] The CI `verify` job successfully ran frozen-lockfile install, standard `bun run db:generate`, root typecheck, full lint, Prisma validation, full unit tests, and `bun run build`.
- [x] The CI `rls` job provisioned `fgmp_app`/ops/migration roles, applied migrations, seeded, passed the RLS-enforcing smoke test, strict database-backed suites, the RLS regression suite, and the direct-endpoint control for the pooler RLS proof.
- [x] Earlier PR #32 CI run [40708733488] `ui` job generated Prisma Client, migrated/seeded PostgreSQL, built and started the server, and passed the real Playwright browser suite; its Docker boot and hosted provisioning jobs passed.
- [x] Corrected the seven-role HTTP walk: 429/timeouts/network/server failures are explicitly inconclusive and yield exit code 2; authorization mismatches yield exit 1. Added verdict tests and a fresh-server CI step.
- [x] CI run [40724629338](https://github.com/d80y6/FGMP1/actions/runs/40724629338), PR #33: the fresh seeded seven-role API walk completed successfully (exit 0), and its Markdown/JSON artifact uploaded. The aggregate success demonstrates no current walk mismatch/inconclusive probes. Raw artifact download from the Actions blob host returned EOF in this sandbox, so the per-role rows remain for human review; the UI browser suite was still running at last check.

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
- `scripts/verify/rbac-live-walk.ts`, `scripts/verify/rbac-live-walk-logic.ts`, and `scripts/verify/rbac-live-walk-logic.test.ts` (rate-limit outcomes now fail closed as inconclusive; per-role API walk added to CI)
- `.github/workflows/ci.yml` (live seven-role API walk step after fresh server startup)
- `docs/RBAC-LIVE-WALK-2026-10.md` and `docs/RBAC-REVIEW-2026-10.md` (historical 429 results clearly labeled inconclusive)
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
| CI gates (run 40708733488, PR head 93fff25) | PASS | All six jobs passed; `verify` includes standard Prisma generate, typecheck, lint, Prisma schema validation, full unit tests, and production build. |
| Full lint | PASS in CI; local toolchain mismatch unresolved | The locked Bun CI `Lint` step passes; local `npx eslint .` after npm install reported 25 errors / 3 warnings. The dependency/toolchain discrepancy is not yet isolated. |
| Standard Prisma Client generation | PASS in CI | `bun run db:generate` passed in verify, RLS, and UI jobs; local sandbox downloader still fails TLS against `binaries.prisma.sh`. Local nonstandard generation produced all 44 models and adapter instantiation passed. |
| Typecheck | PASS | Root typecheck passed both locally and in the CI verify job. |
| Full `bun test` | PASS | Local non-DB suite: 1,115 passed / 13 skipped / 0 failed, 76 files, 19,499 expectations. Prior CI verify unit step passed; CI strict database-backed test step passed with skips treated as failures. |
| RLS regression | PASS in CI | Real PostgreSQL job passed role provisioning, migrations, RLS-enforcing smoke test, strict DB suites, RLS regression, and direct endpoint pooler-proof control. A live run against the actual deployment pooler is still required. |
| UI browser tests | PASS in CI | Real seeded PostgreSQL + server + Playwright public/authenticated suite passed. The separate seven-role API walk remains inconclusive because its existing report records many rate-limited control probes. |
| Next/OpenNext build | PASS in CI | Standard `bun run build` passed with generated Prisma Client; local `next build` also passed. Local OpenNext run needed a temporary skip of Prisma generation because of the sandbox CDN TLS restriction. |

## Pending / blocking actions

- [ ] Run the newly gated seven-role API walk in CI; review all role reports and fix any authorization mismatches. The script now exits inconclusive on 429/unavailable probes instead of reporting them as a pass; the checked-in 2026 report remains historical and inconclusive until regenerated.
- [ ] Run the pooler RLS proof against the actual deployment provider/pooler; CI only validated the direct PostgreSQL endpoint control.
- [ ] Verify production database roles, FORCE RLS state, trusted proxy/rate-limit settings, and service-token secrets in the deployment environment (without exposing credentials in chat or reports).
- [ ] Decide whether Regional Manager is tenant-wide or region-scoped; implement a safe assignment model only if product/security requires region separation.
- [ ] Resolve the local npm-vs-frozen-Bun ESLint discrepancy if local developer lint parity is required; CI locked Bun lint currently passes.
- [ ] Review audit-log write privileges and off-box immutability as separate defense-in-depth hardening.

## Next action

Push the fail-closed live-walk changes through CI, inspect the seven-role API walk and regenerate its report only if every required probe has an observable authorization result. Then validate the actual deployment pooler and deployed role/secret configuration. Do not claim production readiness until those deployment-specific checks and the Regional Manager scope decision are recorded with evidence.
