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
        ├─ 2. apply the signed preview cookie     role-preview.ts
        ├─ 3. endpoint capability policy          rbac-core.ts canAccessApi()
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
| `hasCapability(role, "view:x")` | `app-shell.tsx` | navigation and view mounting |
| `identityKey(me)` | `store.ts` | binds cached payloads to `user\|role\|tenant` |

### 2.1 Why payloads are keyed by identity

`/api/fgmp/state` returns one tenant's data — or, for SUPERADMIN, every tenant's.
The same tab can change identity without unloading: logout, account switch, role
preview, demotion. So the cached snapshot carries `snapshotOwner`, is cleared the
moment `identityKey(me)` changes, is discarded when a response arrives for a
superseded identity, and `AppShell` renders no view until `me` resolves.

### 2.2 Adding a view

1. Add a `ViewKey` and a `view:<key>` capability to the roles that may see it.
2. Add the nav entry to `NAV` with `cap: "view:<key>"`.
3. Load data with `useApi` (never a raw `fetch`) and make sure the endpoint is in
   the policy map.
4. Gate every action with `hasCapability(role, "<action>")` **and** route the
   call through `apiPost/apiPatch/apiPut/apiDelete`.
5. Run `bun test` — the contract test fails if the endpoint is unmapped, if the
   route's allow-list disagrees with the policy, or if a guard is called without
   the request.

---

## 3. Verification

| Check | Command | What it proves | Needs a DB? |
|---|---|---|---|
| Contract | `bun test src/lib/fgmp/__tests__/route-authorization-contract.test.ts` | every handler is mapped, forwards its request to the guard, and its allow-list is a subset of the policy | no |
| Inventory | `bun run scripts/verify/route-inventory.ts` | human-readable table; exits 1 on any violation | no |
| Client gating | `bun test src/lib/fgmp/__tests__/store-identity.test.ts` | no request without an identity/permission; no cross-identity payload reuse | no |
| Matrix | `bun test src/lib/fgmp/__tests__/rbac-api-access.test.ts` | per-endpoint policy expectations | no |
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
