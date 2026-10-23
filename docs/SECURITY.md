# Security

The controls that are actually enforced, where they live in the code, and what
is still open. The 2026 penetration-style audit is archived at
[`history/security-audit-2026-10.md`](history/security-audit-2026-10.md); its
findings 1–5 are either fixed or obsolete because the code they described was
removed. This page describes today.

## 1. Identity and sessions

* NextAuth with JWT sessions; the cookie is `httpOnly`, `sameSite=lax`, and
  `secure` in production.
* `getCurrentUser()` **fails closed**: with no session it throws. It used to
  fall back to a hardcoded `mock` user, so every authenticated route had a valid
  identity even when authentication had failed. Any handler that needs a user
  must have passed `requireAuth()`/`requireRole()` first.
* `_current` is request-scoped state, not a process-global identity cache. A
  global cache would hand one request's user to the next.
* Session lifetime and password policy are configured in `src/lib/auth.ts`;
  passwords are bcrypt hashes with cost 10.

## 2. Authorisation

| Layer | Mechanism | Failure mode |
|---|---|---|
| Route | `requireRole(req, ROLES.…)` | 401/403, no handler body runs |
| Row | `assertTenantOwned(record, user)` | 404 (existence is not confirmed) |
| Database | `FORCE ROW LEVEL SECURITY` + `app.tenant_id` | 0 rows |
| Startup | `FGMP_REQUIRE_RLS=1` refuses a bypassing role | container exits |

The row check is **defence in depth, not the boundary**. Under FORCE RLS an
unscoped read returns nothing, so `assertTenantOwned` would never see a row —
which is why the geography by-id routes (the Phase 0 IDOR) also scope their
`where` clause. Both are kept.

SUPER_ADMIN bypasses tenant isolation by design (`*` capability). Everywhere
else the tenant comes from the session, never from the request body or query.

## 3. Tenant isolation (RLS)

24 tenant-carrying tables carry a policy on `tenant_id`. The app connects as
`fgmp_app`, which does not own the tables, so policies apply even to a query
written without a tenant filter.

`withTenant()` issues `SET LOCAL app.tenant_id` inside an explicit transaction.
`SET` without `LOCAL` is a session-scoped setting that survives on a pooled
connection and hands tenant A's rows to tenant B's next request — that is why
there is exactly one supported helper and why it takes the transaction client as
an argument (`asTenant`).

Three documented exceptions use a privileged connection, and each is narrow:

1. **Scheduler tick** — advances every tenant by design; no per-tenant
   authorisation and no request input.
2. **Health endpoint (SUPERADMIN)** — platform-wide counts.
3. **Realtime tenant resolution** — an ingest event carries only `siteId`, and
   the app client cannot read the site without the tenant id it is resolving.

Migrations and backups also use owner/ops roles; neither is reachable from HTTP.

## 4. MFA

TOTP with encrypted-at-rest secrets and single-use recovery codes. See
[MFA.md](MFA.md) for the design and operational notes. Key points:

* `FGMP_MFA_ENCRYPTION_KEY` encrypts TOTP secrets; rotating it invalidates every
  enrolment (users must re-enrol).
* The second factor is a separate request — the password step returns a challenge,
  not a session.
* Recovery codes are hashed; using one is recorded in the audit log.

## 5. Secrets

* No secret has a committed default. `IOT_API_KEY` is read lazily and refuses
  the request when absent or shorter than 16 characters; the old
  `fgmp-iot-dev-key` was hardcoded in both the route and the firmware.
* `.env` is excluded from the Docker image and from git. Only `.env.example`
  (placeholders) is tracked.
* Variable names alone do not authenticate: the bridge and the app share
  `IOT_API_KEY` / `REALTIME_SERVICE_TOKEN`, which must be rotated together.
* `NEXT_PUBLIC_*` values are public by definition; they are limited to the
  Apinator app key and cluster.

## 6. Rate limiting

`src/lib/fgmp/rate-limit.ts` uses Redis so limits are shared across replicas
(the previous in-process `Map` multiplied every budget by the replica count).
When Redis is unavailable the policy is chosen per call site, explicitly:

| Endpoint | Policy | Why |
|---|---|---|
| Login | **fail closed** | A limiter outage turns 5 attempts per IP into unlimited brute force. An outage is visible and recoverable; a compromised operator credential is not. |
| Ingest | **fail open** | Dropping field telemetry is worse than losing abuse protection: a missing theft window is unrecoverable. |
| MFA challenge | fail closed | Same reasoning as login. |

There is also a DB-backed per-account lockout, so the limiter is the first of
two layers, not the only one.

## 7. Input handling and injection

* Every mutating route validates its body with Zod. Unknown fields are stripped
  by the schema, not passed through.
* Prisma parameterises queries; raw SQL is limited to `pg_database_size` and
  advisory-lock calls with no user input.
* CSV export quotes per RFC 4180 and prefixes formula-triggering cells
  (`=`, `+`, `-`, `@`) so a spreadsheet cannot execute exported data.
* Error responses do not echo database or exception text to non-admins; the
  health endpoint redacts exception messages and is ADMIN-only.

## 8. Transport and headers

`next.config.ts` sets a CSP plus `X-Frame-Options`, `Referrer-Policy`,
`X-Content-Type-Options` and a permissions policy. `connect-src` allows the
Apinator WebSocket origins; `frame-ancestors` is restricted to the app's own
origin. TLS terminates at the reverse proxy (`Caddyfile`), which also terminates
mTLS for device traffic on `127.0.0.1:8443` and requires a client certificate
from a private CA.

## 9. Backups and download surface

There is no HTTP backup endpoint. The removed `/api/fgmp/backup*` route served a
full cross-tenant dump to any tenant ADMIN; backups now run as a one-shot
container with the ops role (see
[DEPLOYMENT.md](DEPLOYMENT.md#5-backups)). No authenticated user of any role can
trigger, download or restore a dump over HTTP.

## 10. Known gaps

| Gap | Impact | Mitigation |
|---|---|---|
| `render.yaml` deployments may lack a non-owner role | RLS cannot be enforced | Create `fgmp_app` and keep `FGMP_REQUIRE_RLS=1`; the app refuses to start otherwise |
| `SensorReading` has no retention policy | Dumps and tables grow without bound | Plan a TimescaleDB retention policy |
| Recovery-code + password policy is configurable, not prescribed | Weak operator choices | Documented defaults; review in code review |
| Audit log is append-only in the app, not in the database | A compromised app role could rewrite it | Restrict `fgmp_app` to INSERT/SELECT on `AuditLog`; export logs off-box |
| No WAF / DDoS layer in front of the app | Availability | Terminate at a proxy with rate limits (Caddy) |

Security-relevant changes should update this page in the same commit.
