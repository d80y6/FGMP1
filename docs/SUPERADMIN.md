# Platform administration (SUPERADMIN)

How a multi-tenant installation is administered without giving anybody standing
access to every tenant's data.

This document describes what the system does **today**, what it deliberately
does not do, and why. It also corrects four claims elsewhere in the repository
that were false — they are listed at the end so a reader who remembers them can
see exactly what changed.

---

## 1. The shape of the problem

FGMP is a single deployment serving several tenants. Isolation is enforced by
PostgreSQL Row Level Security: 39 tables carry a `tenantId`, have **FORCE ROW
LEVEL SECURITY**, and are filtered by

```sql
tenant_id = current_setting('app.tenant_id', true)
```

The application connects as `fgmp_app`, which does not own the tables and does
not have `BYPASSRLS`. Every tenant-scoped request runs inside
`withTenant(tenantId, …)`, which issues `SET LOCAL app.tenant_id`. There is no
ambient cross-tenant capability in the request path.

That leaves one hard question: **who can act across tenants, and how?**

Three answers are common in multi-tenant SaaS, and only one of them is safe:

| model | what it means | verdict |
| --- | --- | --- |
| **A. Super-user with standing cross-tenant access** | an admin account or a `BYPASSRLS` connection on the request path | rejected: one missed check is a full breach, and no tenant can see what happened |
| **B. Control plane** | platform operators see tenants, plans, limits and *aggregates* — never customer rows | adopted for fleet administration |
| **C. Per-tenant fan-out** | every platform screen reads each tenant separately | dropped: it is not a security model, just a slow way to build the same capability |

The design is **B plus a just-in-time, single-tenant exception for support
work**. Customer content is reachable only while an operator holds an explicit,
time-boxed grant that names one tenant, states a reason, and is recorded in that
tenant's own audit trail. Numbers (counts, health, usage) do not require it:
they come from scoped per-tenant reads and are never joined into a cross-tenant
row set.

---

## 2. What a SUPERADMIN can do

### 2.1 Control plane — no customer rows

| capability | route | notes |
| --- | --- | --- |
| list tenants with per-tenant counts | `GET /api/fgmp/tenants` | counts are read **inside each tenant's context**, one short transaction per tenant, so a tenant's figure is that tenant's figure |
| create a tenant | `POST /api/fgmp/tenants` | SUPERADMIN only |
| create users in any tenant | `POST /api/fgmp/users?tenant=t-…` | the tenant must be **named**; it is never inferred |
| read/update/deactivate users in any tenant | `/api/fgmp/users/[id]?tenant=t-…` | same rule |
| grant inventory / access review | `GET /api/fgmp/platform/grants?format=csv` | every user in every tenant, with role and state |
| platform audit trail | `GET /api/fgmp/platform/audit` | who did what, to which tenant, when |
| open a support session | `POST /api/fgmp/platform/support-sessions` | see §3 |
| end a support session | `DELETE /api/fgmp/platform/support-sessions/current` | also the banner's button |
| orient inside one tenant | `GET /api/fgmp/platform/support/{tenant}/summary` | requires an open session for that tenant |

The control plane reads `Tenant` (the registry), `SystemSetting` and
`EspFirmwareRelease` — the three global tables — plus the two platform tables
this work added. It never returns rows from a tenant's operational tables.

**Where a super-admin account lives.** `t-platform`, always. Every rule in this
document assumes a super-admin's session context is the platform tenant; that is
a property of the `User.tenantId` column, not of the role, so
`src/lib/fgmp/platform-identity.ts` enforces it on the only two paths that could
break it: creating a super-admin (a customer `tenantId` is refused with
`SUPERADMIN_TENANT_FIXED`, and the default is the platform tenant) and promoting
an existing user (refused unless the account is already in the platform tenant —
promotion does not move the row, so promoting a customer-tenant user would give
it standing access to that customer, which is option "A" in
`support-session.ts`). The user editor hides the role for a user outside the
platform tenant, using `platformTenantId` from `GET /api/fgmp/me`.

### 2.2 Support sessions — customer content

A support session is the only way to read a tenant's data as somebody other
than that tenant's own user. It is:

* **explicit** — the operator names the tenant; there is no "all tenants" value
  in the schema and no wildcard in the API;
* **justified** — a reason of at least 10 characters is required and is written
  into the tenant's audit log, where the customer can read it;
* **ticketed** — write mode additionally requires a ticket/case reference;
* **time-boxed** — 60 minutes read-only, 30 minutes for write, hard ceiling four
  hours, checked on every request against the row, not against a cookie;
* **single-tenant** — one open session per operator, enforced by a partial
  unique index (`SupportSession_one_open_per_actor`), not merely by a check in
  the handler;
* **read-only by default** — `mode` defaults to `READ`, and the only write the
  support surface offers is appending a note to the tenant's own audit log;
* **visible** — a persistent banner shows the tenant, the mode, the reason and
  the remaining time, and the operator cannot dismiss it without ending the
  session;
* **attributable** — the actor is recorded in the platform trail and in the
  tenant's trail; there is no shared "support" account.

### 2.3 What a SUPERADMIN cannot do

* Read another tenant's data through the ordinary tenant routes. Those run in
  the caller's own tenant context, and `SUPERADMIN` is not special there. This
  is intentional: it means the ~80 existing handlers do not each need a
  support-aware branch, which is where a mistake would hide.
* Hold two tenants at once. The database refuses it.
* Read a tenant after the session expires, even with a valid cookie — the row is
  the authority.
* Modify or delete the platform audit trail: `fgmp_app` has `SELECT`/`INSERT`
  only on `PlatformAuditLog`. Retention is an owner-role job.
* Change their own role, or remove the last active administrator/super-admin
  (see §5).

---

## 3. The support-session lifecycle

```
operator            POST /api/fgmp/platform/support-sessions
                    { tenantId, reason, ticketRef?, mode?, ttlSec? }
                        │
                        ├─ requireSuperAdmin()            (role, from the session JWT)
                        ├─ validate: reason ≥ 10 chars; WRITE ⇒ ticketRef
                        ├─ close expired rows for this actor ("EXPIRED")
                        ├─ refuse if another session is open     → 409
                        ├─ INSERT SupportSession (+ partial unique index)
                        ├─ INSERT PlatformAuditLog  SUPPORT_SESSION_START
                        └─ INSERT AuditLog (inside the target tenant)
                                 SUPPORT_ACCESS_STARTED  ← the tenant can see this
                        │
                        ▼
                    signed cookie fgmp_support_session
                    { sid, sub=operator, tid, mode, exp }, HMAC-SHA256,
                    httpOnly, SameSite=Strict, path=/api/fgmp/platform
                        │
                        ▼
reading             GET /api/fgmp/platform/support/{tenant}/summary
                        ├─ verify token (signature, expiry, sub == caller)
                        ├─ load the row; reject if ended, expired, or tid mismatch
                        ├─ assertSupportTenant(session, pathTenant)
                        └─ withTenant(session.tenantId) ← RLS still applies
                        │
                        ▼
ending              DELETE …/support-sessions/current  (or [id])
                        ├─ UPDATE … SET endedAt, endReason  (compare-and-set)
                        ├─ PlatformAuditLog  SUPPORT_SESSION_END  (+ duration)
                        ├─ AuditLog (tenant) SUPPORT_ACCESS_ENDED
                        └─ clear cookie
```

The database side of this was exercised as `fgmp_app` on a clean PostgreSQL 16.2:

```
insert SupportSession …                     -- allowed
update SupportSession set endedAt = now()   -- allowed (that is how a session closes)
insert PlatformAuditLog …                   -- allowed
delete from SupportSession …                -- ERROR: permission denied
update PlatformAuditLog …                   -- ERROR: permission denied
```

Expiry needs no scheduler: `resolveActiveSupport()` refuses a row whose
`expiresAt` has passed, and the next attempt to open a session marks stale rows
`EXPIRED` before inserting.

### Why the cookie is signed *and* backed by a row

The row is the authority and can be revoked centrally. The signature exists so
that a session id seen in the audit log cannot be pasted into somebody else's
browser: the token's `sub` must equal the authenticated operator, and the HMAC
uses `NEXTAUTH_SECRET`, so it cannot be minted for another user. A missing or
short secret disables the feature with a 503 rather than falling back to
unsigned tokens.

---

## 4. Threat model

| threat | control | residual risk |
| --- | --- | --- |
| A super-admin account is compromised | separate support grant required; single-tenant; expiry; both trails | until expiry, the attacker reads **one** tenant, visibly. Rotate the account; the trail names everything it did |
| An operator acquires a session id from logs | signed, user-bound cookie; `sub` must match | none if the secret is strong; rotate `NEXTAUTH_SECRET` to invalidate every outstanding token |
| An operator is phished mid-session | `SameSite=Strict`, `httpOnly`, path-scoped cookie; write mode requires a ticket | a session riding in the same browser can be used until it expires — hence the short ceiling |
| An operator forgets the session | banner, hard ceiling, row-based expiry | up to the remaining minutes |
| A request body names another tenant | the support routes ignore the body; the tenant comes from the cookie/row | none: a mismatch is a 403 |
| A code path forgets the guard | `requireSuperAdmin()` in every platform route, checked by a source-scanning test; `no-restricted-imports` keeps raw `db` out of handlers | a new route pattern could evade the scanner; review the test when adding one |
| The tenant never learns it was accessed | `AuditLog` row written inside the tenant's own RLS context | a failed write is counted (`supportSessionFailures()`) and logged; alert on it |
| The audit trail is tampered with | append-only grants for `fgmp_app`; separate table; verified by `04-verify.sql` | an attacker with the migrate/owner credential can rewrite anything — out of scope for application-level controls |
| Two tenants at once | partial unique index on `(actorUserId) WHERE endedAt IS NULL` + 409 | none at the database level |

### What is deliberately **not** built

* **No `BYPASSRLS` on the request path.** `fgmp_ops` exists for migrations,
  dumps and the census, and the web app never uses it.
* **No "act as another user" login.** A support session acts as *the tenant*,
  not as one of its users; there is no impersonation token that a tenant's UI
  could mistake for a real user.
* **No cross-tenant search.** "Find site X across all tenants" would be a
  standing read of every tenant's rows. If it is ever needed, it should be a
  scoped index of IDs and names (metadata), not a query over customer content.

---

## 5. Grant hygiene

Privilege changes are the highest-value action in the system, so the rules are
in one pure function (`src/lib/fgmp/grant-guards.ts`) that all three mutation
routes call:

1. **No self-grant.** Nobody changes their own role — including a demotion. A
   self-change has no second party in it, so "X promoted X" is
   indistinguishable from an account compromise in review.
2. **No self-deactivation.** Already enforced by the routes; unchanged.
3. **Last administrator protection.** The last active `ADMIN` of a tenant cannot
   be demoted, deactivated or soft-deleted. Without one, nobody can manage users,
   settings or API keys for that tenant, and recovery needs database access.
4. **Last super-admin protection.** The same rule one level up, applied
   platform-wide (a per-tenant fan-out count, because there is no cross-tenant
   read).
5. **Reviewable.** `GET /api/fgmp/platform/grants?format=csv` exports every
   grant; the super-admin cannot read the platform audit trail without leaving an
   entry there for their own access.

What is **not** yet enforced, and should be before a regulated deployment:

* separation of duties for granting `SUPERADMIN` (today one super-admin can
  create another);
* periodic recertification (the export exists; the schedule does not);
* break-glass account handling (a second super-admin with hardware-key MFA is
  the recommended practice, and the MFA module supports the enrolment).

---

## 6. Operating it

### Open a session

```bash
curl -X POST https://…/api/fgmp/platform/support-sessions \
  -H 'content-type: application/json' \
  --cookie 'next-auth.session-token=…' \
  -d '{"tenantId":"t-default","reason":"Customer reports missing deliveries","ticketRef":"INC-1042"}'
```

Response: `201` plus `Set-Cookie: fgmp_support_session=…`.

### Read inside it

```bash
curl --cookie 'fgmp_support_session=…; next-auth.session-token=…' \
  https://…/api/fgmp/platform/support/t-default/summary
```

### End it

```bash
curl -X DELETE --cookie '…' \
  https://…/api/fgmp/platform/support-sessions/current
```

The banner in the UI does the same thing. Ending is idempotent.

### Rotate a seeded password

```bash
FGMP_MIGRATE_DATABASE_URL=… bun run scripts/set-password.ts admin@fgmp.telecom
```

In production, a login that still uses a **published** demo password is
**refused** (`src/lib/fgmp/demo-credentials.ts`) unless
`FGMP_ALLOW_DEMO_CREDENTIALS=1` is set explicitly. The published values are
`Admin@2026`, `Super@2026` and the legacy healer's `Fgmp@2026`; rotating from one
of them to another is also refused.

---

## 7. What is implemented, and what is next

Implemented in this change:

* `SupportSession` + `PlatformAuditLog` (migration `20261023000000`), including
  the single-open-session index and append-only grants;
* the support-session module, token signing, expiry and refusal rules;
* the platform routes (`support-sessions`, `support/{tenant}/summary`, `audit`,
  `grants`);
* the banner, and `/login`;
* grant hygiene (self-grant, last-admin, last-super-admin, review export);
* demo-credential rotation enforcement;
* the tenant registry and per-tenant counts moved out of `asTenant`;
* tests: 22 support-session invariant tests, 15 grant-guard tests, 6 platform
  surface tests, 8 demo-credential tests — plus the provisioning suite.

Next, in priority order:

1. **Step-up authentication for write mode and for opening a session at all** —
   today the session's age is not re-checked; a 30-minute-old JWT is enough. A
   fresh MFA assertion should be required.
2. **Entitlements and limits** in the control plane (plan, seat count, feature
   flags) — the schema exists for tenants; there is no billing model yet.
3. **Rollups** for fleet dashboards (per-tenant counters written on a schedule)
   so the control plane stops fanning out on every page load.
4. **Recertification workflow** on top of the grants export.
5. **Two-person approval** for `SUPERADMIN` grants.

---

## 8. Corrections to earlier claims

Four statements in the repository were false. They are corrected here and at
their source, because a wrong claim in a security document is worse than a
missing one: it is a control somebody believes they have.

| where | claim | truth |
| --- | --- | --- |
| `docs/MFA.md` §"Which roles first" | "SUPERADMIN can read every tenant's data" | A super-admin can *obtain* access to any tenant, one at a time, through an explicit time-boxed session. Their ordinary session is scoped to `t-platform` like any other session |
| `docs/TESTING.md` §"Four checks" | "as SUPERADMIN the counts change because that role spans tenants" | The dashboard shows `t-platform`'s figures (no sites). Cross-tenant figures are only reachable through a support session |
| `src/lib/fgmp/seed.ts` | "the SUPERADMIN role bypasses tenant isolation entirely" | The role bypasses nothing at the database level. `t-platform` is an ordinary tenant; cross-tenant access is the support-session mechanism |
| `src/app/api/fgmp/audit/route.ts` | "`isSuperAdminUser` still widens the tenant scope via `tenantWhereOrAll`" | `tenantWhereOrAll` returns a WHERE clause, not a tenant context. The query ran inside `asTenant(me, …)`, so it returned the super-admin's own tenant — 0 rows in a `t-platform`-only installation, with HTTP 200 |

The last one is the most instructive: the code was *safer* than its comment
(it failed closed), but the comment described a capability that did not exist
and would have been a vulnerability if it had. Comments about security
properties must be measured, not asserted.

---

## 9. Where to look in the code

| file | what it holds |
| --- | --- |
| `prisma/migrations/20261023000000_platform_support_access` | the two tables, the single-open-session index, the checks, the grants |
| `src/lib/fgmp/support-session.ts` | the invariants, token signing, start/end/resolve |
| `src/lib/fgmp/platform-audit.ts` | the platform trail and the tenant-visible notice |
| `src/lib/fgmp/platform-store.ts` | the only module allowed to read platform tables unscoped, and why |
| `src/lib/fgmp/support-request.ts` | request-side guards (SUPERADMIN, cookie, refusals) |
| `src/lib/fgmp/grant-guards.ts` | self-grant, last-admin, last-super-admin |
| `src/lib/fgmp/demo-credentials.ts` | which passwords are published, and the production refusal |
| `src/lib/fgmp/__tests__/support-session.test.ts` | one tenant at a time, expiry, mode, audit, token binding |
| `src/lib/fgmp/__tests__/platform-surface.test.ts` | every platform route is SUPERADMIN-gated |
| `scripts/supabase/04-verify.sql` | the database-side assertions, including append-only on the trail |
