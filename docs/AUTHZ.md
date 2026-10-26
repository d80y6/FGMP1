# Authorization in FGMP1

How a request is authorized, where each decision lives, and how to prove the
boundaries still hold. Read `TASK_LEDGER.md` for the audit that produced the
current state, and `docs/SUPERADMIN.md` for the platform/support-session model.

---

## 1. The model

FGMP1 uses **role-based capabilities with deny-by-default endpoint policies**.
There is no permissions table, no per-user grant, no custom roles, and no
wildcard outside SUPERADMIN.

```
NextAuth session (JWT)
        │
        │  requireAuth(req)                        src/lib/fgmp/auth-helpers.ts
        ├─ 1. re-read the account from the DB     getSessionState()
        ├─ 2. refuse an MFA-pending session       mfa/guard.ts evaluatePendingSession()
        ├─ 3. apply the signed preview cookie     role-preview.ts
        ├─ 4. endpoint capability policy          rbac-core.ts canAccessApi()
        ▼
    requireRole(req, ROLES.X)                     the route's own allow-list
        ▼
    withTenant(tenant.id) / tenantWhere(me)       src/lib/fgmp/route-tenant.ts
        ▼
    PostgreSQL FORCE RLS                          tenantId = current_setting('app.tenant_id')
```

Four independent layers, in this order. Each is sufficient to refuse; none is
sufficient to authorize.

### 1.1 Identity is revalidated on every request

`requireAuth` re-reads the user row and uses the **database** role and tenant,
not the token's. A JWT is a claim about the past: without this, a demoted,
deactivated or password-reset account keeps its old authority until the token
expires. `sessionEpoch` provides explicit revocation.

### 1.1.1 An MFA-pending session reaches nothing but the challenge

A session that has passed the password but not the second factor carries
`mfaPending` and **no role and no tenant**. `requireAuth` evaluates
`evaluatePendingSession(pathname)` (`src/lib/fgmp/mfa/guard.ts`) before it looks
at any capability, and the answer is an **allowlist**: only
`/api/fgmp/mfa/*` and `/api/auth/*` are reachable. A route added tomorrow is
refused for such a session by default.

The allowlist is what makes this fail closed. The earlier arrangement relied on
the *absence* of a role: `canAccessApi` denies an undefined role, which covers
every capability-checked route but not the `AUTH_ONLY_API_RULES` ones
(`GET /api/fgmp/me`, `/api/fgmp/preferences`, `/api/fgmp/proposal`). Those were
readable by a half-authenticated session. The decision is asserted against the
call site — `requireAuth` must contain the check, before `canAccessApi` — not
just against the guard, because the original defect was precisely that a correct
guard had no caller.

### 1.2 Layer 1 — role → capability

`src/lib/fgmp/rbac-core.ts: ROLE_PERMISSIONS`. Seven roles, each an explicit
allow-list. Only `SUPERADMIN` holds `"*"`. An unrecognised capability is denied.

The full matrix is generated in `TASK_LEDGER.md` §5; run
`bun run scripts/verify/route-inventory.ts` for the endpoint side.

### 1.3 Layer 2 — endpoint → required capability

`apiReadCapabilities()` (GET) and `API_WRITE_RULES` (mutations) map a path prefix
to the capabilities that may reach it. Rules are matched longest-prefix-first.

Two deliberate properties:

* **An unmapped `/api/fgmp/**` path is denied.** A new route fails closed until
  somebody writes its policy.
* **`NO_SESSION_ROLE`** (an empty capability list) means "no session role, ever".
  It exists for device-facing routes that authenticate with their own credential
  (per-tenant API key, `REALTIME_SERVICE_TOKEN`). The contract test asserts the
  sentinel never appears on a browser route.

### 1.4 Layer 3 — the route's own allow-list

`requireRole(req, ROLES.ALARM_OPS)`. This is the intersection with Layer 2: a
role reaches a handler only when both admit it. SUPERADMIN is admitted to every
`requireRole` route by the platform-role bypass, which is consistent because it
also holds `*` in Layer 2.

### 1.5 Layer 4 — row scope (RLS)

The web app connects as `fgmp_app`: not the table owner, no `BYPASSRLS`, no
`CREATE`. Every tenant-carrying table has `FORCE ROW LEVEL SECURITY` with
`tenantId = current_setting('app.tenant_id')`. Handlers additionally apply
`tenantWhere()` / `assertTenantOwned()`, so cross-tenant access returns **404,
not 403** — no existence disclosure.

`FGMP_MIGRATE_DATABASE_URL` and `FGMP_OPS_DATABASE_URL` are never used for
ordinary request processing. `resolveOwnerDbUrl()` falls back **downward** to
`DATABASE_URL` (the least-privileged role), never upward.

### 1.6 The platform tier — the second role family

FGMP1 is a multi-tenant SaaS, so there are two role families and they must be
read separately:

| Family | Roles | What they are scoped to |
|---|---|---|
| Tenant | `ADMIN`, `NOC_OPERATOR`, `REGIONAL_MANAGER`, `FIELD_ENGINEER`, `EXECUTIVE`, `READONLY` | one tenant, enforced by RLS on every query |
| Platform | `SUPERADMIN` | the tenant **registry** and platform tables — not a tenant's rows |

`SUPERADMIN` is the only member of the platform family, and it is **not** a
tenant role with extra keys: its session carries a tenant like any other
(`t-platform`), every tenant-scoped query it makes is scoped to that tenant, and
`tenantWhereOrAll()` / `siteTenantWhereOrAll()` deliberately do **not** widen for
it. `docs/SUPERADMIN.md` describes the support-session path that grants
time-boxed access to one customer tenant at a time.

A platform surface is described in three places, and they must be one fact:

| Layer | Where | Question it answers |
|---|---|---|
| Matrix | `SUPERADMIN_ONLY_CAPABILITIES` in `rbac-core.ts` | may the client **show** the surface? |
| Policy | `API_READ_RULES` / `API_WRITE_RULES` | may `canAccessApi(role, url, method)` **issue** the request? |
| Handler | `requireSuperAdmin()` or `requireRole(…, ROLES.SUPERADMIN_ONLY)` | may the server **execute** it? |

Every platform route the repository serves is in this table, and each row's three
descriptions agree:

| Route | Policy capability | Handler |
|---|---|---|
| `GET /api/fgmp/tenants` | `view:tenants` | `requireAuth` + own-tenant branch |
| `POST /api/fgmp/tenants` | `tenant:manage` | `ROLES.SUPERADMIN_ONLY` |
| `PATCH`/`DELETE /api/fgmp/tenants/[id]` | `tenant:manage` | `ROLES.SUPERADMIN_ONLY` |
| `GET /api/fgmp/platform/audit` | `view:tenants` | `requireSuperAdmin` |
| `GET /api/fgmp/platform/grants` | `view:tenants` | `requireSuperAdmin` |
| `GET`/`POST /api/fgmp/platform/support-sessions` | `view:tenants` / `tenant:manage` | `requireSuperAdmin` |
| `GET`/`DELETE …/support-sessions/current`, `GET`/`DELETE …/[id]` | `view:tenants` / `tenant:manage` | `requireSuperAdmin` |
| `GET`/`POST /api/fgmp/platform/support/[tenant]/summary` | `view:tenants` / `tenant:manage` | `requireSuperAdmin` + an open session |
| `GET /api/fgmp/admin/tenant-isolation-test` | `view:tenant-isolation` | `requireAuth` + `isSuperAdminUser` |
| `POST /api/fgmp/edge/firmware`, `DELETE …/firmware/[id]` | `platform:firmware` | `ROLES.SUPERADMIN_ONLY` |

`platform-tier-parity.test.ts` derives this from the route tree on disk (it does
not trust a list), and fails on each of the four ways the triangle can break:

1. a platform capability held by any role other than `SUPERADMIN` — which is
   how the sidebar comes to offer a screen its own API refuses;
2. a route whose policy resolves to a platform capability but whose handler does
   not enforce the platform role (checked **per exported method**: one guarded
   sibling handler in the same file is not evidence);
3. a policy rule that mixes a platform capability with an ordinary one —
   `canAccessApi` is *any-of*, so `["view:tenants", "view:dashboard"]` would hand
   the registry, the audit trail and the support control plane to every dashboard
   reader. No such rule exists, and none may;
4. a platform route with no policy row, which would exist on the server and be
   unreachable from the browser for every role including `SUPERADMIN`.

**Cross-tenant access has exactly two shapes, and RBAC widens neither.**

* **Customer content** — only through an open, ticketed support session, on
  `/api/fgmp/platform/support/[tenant]/summary`, where the tenant in the URL is a
  claim the session must already match (`assertSupportTenant`). Reads run inside
  `withTenant(session.tenantId)`, so RLS still applies; writes additionally need
  `mode: "WRITE"`. The support cookie is path-limited to `/api/fgmp/platform`, so
  it cannot be replayed against the ~80 tenant routes.
* **User administration** — `GET/PUT/DELETE /api/fgmp/users[/:id]?tenant=…`
  resolves the target through `resolveTenantScope`, which refuses to leave the
  caller's own tenant for anyone but `SUPERADMIN` and, for `SUPERADMIN`, routes
  through `asTenantForAnotherTenant()` (which re-checks the role inside). This is
  registry administration — accounts and roles — not a read of a customer's
  operational data.

**Surfaces that are API-only today.** `GET /api/fgmp/platform/audit`,
`GET /api/fgmp/platform/grants` (its `?format=csv` form is an access-review
export), `POST`/`DELETE /api/fgmp/edge/firmware` (the global firmware catalogue)
and `GET /api/fgmp/platform/support/[tenant]/summary` have no view consuming them;
`tenants-view.tsx` opens and lists support sessions (`…/support-sessions`) but
does not yet render a tenant summary or a support note. That is a product gap,
not a policy gap — nothing is exposed to a role that may not see it. If a view is
added, it inherits two constraints: it gates on the same capability
(`view:tenants` / `tenant:manage`), and any tenant data it shows comes from
`…/support/[tenant]/summary` under an open session, never from a tenant route.

---

## 2. Client side

The browser mirrors Layer 2 so a request is never *issued* for something the user
cannot read. This is a UX and correctness measure, **never** the security
boundary.

| Mechanism | Where | What it guarantees |
|---|---|---|
| `canAccessApi(role, url, method)` | `rbac-core.ts`, shared with the server | one definition of who may call what |
| `useApi(url)` | `use-api.ts` | will not fetch without the capability; drops and clears data when the identity changes |
| `apiPost/apiPatch/apiPut/apiDelete` | `use-api.ts` | refuse locally with a 403 envelope, so no request leaves the tab |
| `NAV_ENTRIES` + `hasCapability(role, entry.cap)` | `navigation.ts`, `app-shell.tsx`, `command-palette.tsx` | **one** nav table; an entry exists on every surface or on none |
| `setView(view)` | `store.ts` | refuses a view the role cannot open, so a missed call site cannot mount a screen |
| `useCap` / `useCan` / `useCanView` | `use-access.ts` | one resolver for the effective role; `null` (unresolved) grants nothing |
| `identityKey(me)` | `store.ts` | binds cached payloads to `user\|role\|tenant` |

### 2.0 A control is tied to its ENDPOINT, not to its screen

The view capability decides whether a screen exists for a role. It says nothing
about what the role may *do* once there, and the two are different sets for
eleven of the twenty-two `view:*` capabilities. The rule the client follows:

> A control is rendered only if the role holds the capability its endpoint
> requires — `apiRequestCapabilities(method, url)` — never because the role
> reached the screen that hosts it.

`rbac-mutation-gates.test.ts` enforces it mechanically: for every component that
calls `apiPost/apiPatch/apiPut/apiDelete` with a literal URL, it asks the policy
core which capabilities that exact method+URL needs and fails if the component
never mentions one of them. It exists because the hand-written table in
`rbac-ui-gates.test.ts` caught only the screens somebody had written down, and
three live defects of exactly this shape survived it:

| Screen | Control | Needs | Was shown to |
|---|---|---|---|
| Dashboard | Ack an alarm | `alarm:ack` | FIELD_ENGINEER, EXECUTIVE, READONLY |
| IoT Devices | OTA / reboot | `edge:manage` | five roles without it |
| Edge & Firmware | OTA | `asset:manage` (dispenser row) or `edge:manage` (iot row) | NOC_OPERATOR, FIELD_ENGINEER |

Each was a button whose only possible outcome was a "denied" toast. The scan
skips template-built URLs (`/api/fgmp/tanks/${id}`) because the static prefix is
a different endpoint; those files are listed explicitly in the scan and covered
by `ACTION_GATES` instead, and the list is asserted so it cannot grow silently.

### 2.1 Why payloads are keyed by identity

`/api/fgmp/state` returns **one tenant's** data, for every role. It calls
`engine.snapshotForTenant(tenantIdOrThrow(me.tenantId))`, and a SUPERADMIN
session's tenant is the platform tenant (`t-platform`), so a platform operator
sees the platform tenant's operational data like anyone else. Cross-tenant
customer content exists in exactly one place — the audited support-session
surface (§1.6) — and never as an ambient property of a role.

The same tab can change identity without unloading: logout, account switch, role
preview, demotion. So the cached snapshot carries `snapshotOwner`, is cleared the
moment `identityKey(me)` changes, is discarded when a response arrives for a
superseded identity, and `AppShell` renders no view until `me` resolves. The key
includes the role as well as the tenant: today the payload is built from the
tenant alone, so the role is defence in depth — the cache belongs to the
authority that fetched it, and no future per-role projection can be served to a
narrower identity by surviving a role change.

### 2.2 Adding a view

1. Add a `ViewKey` and a `view:<key>` capability to the roles that may see it.
2. Add the nav entry to `NAV_ENTRIES` in `src/lib/fgmp/navigation.ts` with
   `cap: "view:<key>"`, and an icon in both `NAV_ICONS` (sidebar) and `ICONS`
   (palette). `rbac-nav-single-source.test.ts` fails if an entry is missing from
   either surface, if a `cap` is not exactly `view:<key>`, or if either component
   keeps a private list again.
3. Load data with `useApi` (never a raw `fetch`) and make sure the endpoint is in
   the policy map.
4. Gate every action with `hasCapability(role, "<action>")` **and** route the
   call through `apiPost/apiPatch/apiPut/apiDelete`.
5. Run `bun test` — the contract test fails if the endpoint is unmapped, if the
   route's allow-list disagrees with the policy, or if a guard is called without
   the request. `rbac-link-surfaces.test.ts` additionally fails any component
   that navigates without first asking whether the role may go there.

---

## 3. Verification

| Check | Command | What it proves | Needs a DB? |
|---|---|---|---|
| Contract | `bun test src/lib/fgmp/__tests__/route-authorization-contract.test.ts` | every handler is mapped, forwards its request to the guard, and its allow-list is a subset of the policy | no |
| Inventory | `bun run scripts/verify/route-inventory.ts` | human-readable table; exits 1 on any violation | no |
| Client gating | `bun test src/lib/fgmp/__tests__/store-identity.test.ts` | no request without an identity/permission; no cross-identity payload reuse | no |
| Matrix | `bun test src/lib/fgmp/__tests__/rbac-api-access.test.ts` | per-endpoint policy expectations | no |
| Platform tier | `bun test src/lib/fgmp/__tests__/platform-tier-parity.test.ts` | matrix, policy and handler agree for every platform route, derived from the route tree on disk (§1.6) | no |
| Platform surface | `bun test src/lib/fgmp/__tests__/platform-surface.test.ts` | every `/platform/` route calls `requireSuperAdmin`, imports no raw Prisma, and reads tenant data only through `currentSupport()` | no |
| **Live matrix** | `bun run scripts/verify/authz-live.ts` | real sessions, real HTTP, real rows: 7 roles × 37 probes, plus an anonymous baseline | **yes** |
| RLS | `bun run test:rls` | policies bind for `fgmp_app`; cross-tenant reads/writes fail | **yes** |

### Running the live matrix

```bash
# local, seeded, development mode
FGMP_BASE_URL=http://localhost:3000 \
FGMP_AUTHZ_PASSWORD='Super@2026' \
bun run scripts/verify/authz-live.ts

# production: the seeded demo passwords are REFUSED unless explicitly allowed.
# Prefer rotating them, then:
FGMP_BASE_URL=https://app.example.com \
FGMP_AUTHZ_PASSWORD_SUPERADMIN='…' \
FGMP_AUTHZ_PASSWORD_ADMIN='…' \
… \
bun run scripts/verify/authz-live.ts
```

Exit codes: `0` all expectations met, `1` mismatch, `2` not configured,
`3` incomplete (a role had no credentials — **not** a pass).

Probes are non-destructive by construction: ids are a literal that cannot exist,
and POST bodies deliberately fail validation, so an authorized call stops at 404
or 400 and a denied call stops at 401/403. The status class is what is asserted.

### What is not automated yet

* **Browser network assertions** (Playwright). No Playwright dependency exists in
  this repository and no browser binary was available in the sandbox that
  produced this document. The store-level half of that requirement is covered by
  `store-identity.test.ts`; the in-browser half — "walk each role through the UI
  and assert no forbidden request appears in the network log" — is specified
  above and still to be written.
* **DB-backed route tests.** The Prisma client cannot be generated in the sandbox
  (`binaries.prisma.sh` unreachable), so the 16 `decimal.test.ts` failures are
  environmental. `authz-live.ts` is the substitute and is not a mock.

---

## 4. Deployment and rollback

Every change in this task is **source-only**. There is no migration, no schema
change, no data change, and no environment-variable change required.

To deploy: build and start as usual; nothing to run.

To roll back: revert the merge commit. Nothing outside the process is affected —
no rows are rewritten, so a rollback restores the previous client behaviour and
the previous guard set with no cleanup. If a rollback reintroduces the
`socket`-level defects, note that D-1 (cross-identity payload reuse) is
client-side and leaves no server-side trace.

The one behavioural change an operator could notice: the shell now shows a
spinner for one network round-trip after sign-in, instead of painting the
dashboard from a stale store. That is the fix, not a regression.

---

## 5. Open decisions

Recorded, not resolved — see `TASK_LEDGER.md` §4.

* **B-3** Should `EXECUTIVE` hold `view:maintenance` and `view:iot`? Added by an
  earlier phase to fix a genuine inversion; no business rule settles it.
* **B-4** Should `DELETE /api/fgmp/suppressions/[id]` be ADMIN-only? Both layers
  agree today; changing it would widen access.
