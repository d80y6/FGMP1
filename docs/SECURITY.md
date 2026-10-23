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

No role bypasses tenant isolation. `SUPERADMIN` is a capability, not a tenant
context: every tenant-scoped route — including one serving a super-admin — runs
inside `withTenant()`, and a super-admin's own session is scoped to the platform
tenant like anybody else's. Cross-tenant *content* requires an explicit,
time-boxed support session that names one tenant, records a reason, and is
visible in that tenant's audit log (`docs/SUPERADMIN.md`). Cross-tenant *numbers*
(counts on the health endpoint) are read on the ops connection and never joined
into a row set.

Everywhere else the tenant comes from the session, never from the request body
or query. The one exception is a super-admin naming a tenant explicitly on the
user-administration routes (`?tenant=`), which goes through
`asTenantForAnotherTenant()` — a named, runtime-checked capability.

## 3. Tenant isolation (RLS)

39 tenant-carrying tables carry a policy on `tenant_id` (51 policies in total,
counting the SECURITY DEFINER helper on the MFA challenge table). The app connects as
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

## 5. Boot-time validation

The server refuses to start on an invalid environment (`src/lib/env.ts`,
`FGMP_REQUIRE_RLS=0` in production, short secrets, partial realtime
credentials) and exits non-zero rather than serving a half-configured platform.
`bun run check:env` applies the same rules before a deploy. Problem reports name
variables, never values.

## 6. Secrets

* Device ingest uses tenant-scoped `ApiKey` records with `write` or `admin`
  scope. The raw key is hashed at rest, expiry and revocation are enforced, and
  the site owner determines the only tenant whose credential can authorize a
  write. There is no global ingest key or shared dev fallback.
* `.env` is excluded from the Docker image and from git. Only `.env.example`
  (placeholders) is tracked.
* The bridge holds a tenant-to-key mapping in `IOT_API_KEYS` and a separate
  service token for snapshot polling. Rotate tenant API keys independently in
  the tenant API-key manager; never reuse the service token as an ingest key.
* `NEXT_PUBLIC_*` values are public by definition; they are limited to the
  Apinator app key and cluster.

## 7. Rate limiting

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

## 8. Input handling and injection

* Every mutating route validates its body with Zod. Unknown fields are stripped
  by the schema, not passed through.
* Prisma parameterises queries; raw SQL is limited to `pg_database_size` and
  advisory-lock calls with no user input.
* CSV export quotes per RFC 4180 and prefixes formula-triggering cells
  (`=`, `+`, `-`, `@`) so a spreadsheet cannot execute exported data.
* Error responses do not echo database or exception text to non-admins; the
  health endpoint redacts exception messages and is ADMIN-only.

## 9. Transport and headers

`next.config.ts` sets a CSP plus `Referrer-Policy`, `X-Content-Type-Options`,
`X-DNS-Prefetch-Control`, `Permissions-Policy` and HSTS in production.
`X-Powered-By` is disabled.

The CSP is **environment-aware**:

| Directive | Production | Development |
|---|---|---|
| `script-src` | `'self' 'unsafe-inline'` | adds `'unsafe-eval'` (HMR) |
| `connect-src` | `'self' https://*.apinator.io wss://*.apinator.io` | `'self' ws: wss: http://localhost:*` |
| `object-src` | `'none'` | — |
| `base-uri` / `form-action` | `'self'` | — |

`'unsafe-inline'` remains because the App Router emits inline bootstrap scripts;
a nonce-based policy needs middleware on every route. `'unsafe-eval'` is gone
from production. `frame-ancestors 'self' https:` is still deliberately
permissive — see the note in `next.config.ts` (preview iframes; the app requires
a session regardless).

TLS terminates at the reverse proxy (`Caddyfile`), which also terminates mTLS for
device traffic on `127.0.0.1:8443` and requires a client certificate from a
private CA.

**Probe disclosure.** `/api/health/live` and `/api/health/ready` are
unauthenticated by necessity — an orchestrator has no session. They return a
status and a coarse reason code only: no driver, host, schema name, stack trace
or exception text. The detailed view stays ADMIN-only.

## 10. Backups and download surface

There is no HTTP backup endpoint. The removed `/api/fgmp/backup*` route served a
full cross-tenant dump to any tenant ADMIN; backups now run as a one-shot
container with the ops role (see
[DEPLOYMENT.md](DEPLOYMENT.md#5-backups)). No authenticated user of any role can
trigger, download or restore a dump over HTTP.

## 11. Known gaps

| Gap | Impact | Mitigation |
|---|---|---|
| `render.yaml` deployments may lack a non-owner role | RLS cannot be enforced | Create `fgmp_app` and keep `FGMP_REQUIRE_RLS=1`; the app refuses to start otherwise |
| `SensorReading` has no retention policy | Dumps and tables grow without bound | Plan a TimescaleDB retention policy |
| Recovery-code + password policy is configurable, not prescribed | Weak operator choices | Documented defaults; review in code review |
| Audit log is append-only in the app, not in the database | A compromised app role could rewrite it | Restrict `fgmp_app` to INSERT/SELECT on `AuditLog`; export logs off-box |
| No WAF / DDoS layer in front of the app | Availability | Terminate at a proxy with rate limits (Caddy) |

Security-relevant changes should update this page in the same commit.
