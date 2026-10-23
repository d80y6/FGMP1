# Testing

Two kinds of verification: the automated suites (fast, run constantly) and the
browser walk-through (judgement calls the suites cannot make). Everything below
was run against this checkout; the expected values are what the system actually
returns.

## 1. Automated suites

```bash
bun test                 # unit + integration, no database required
npx tsc --noEmit         # 0 errors
npx eslint .             # errors block; warnings are a tracked backlog
```

`bun test` runs 727 assertions across 37 files. Three suites need PostgreSQL
(RLS row hiding, MFA challenge resolution, command persistence); they cannot be
mocked, because the property they pin belongs to the database session, not to the
code.

Without a database those suites **skip** and print one banner:

```
714 pass
13 skip
0 fail
```

That is a deliberate change from failing 14 assertions on every machine without
PostgreSQL: a permanently red suite trains people to ignore it, and a real
regression then hides in the noise. The skip is not silent and it is not the
default in CI:

```bash
FGMP_REQUIRE_DB_TESTS=1 bun test    # a skipped DB suite is an ERROR
```

CI sets that flag in the job that provisions PostgreSQL, so a broken pipeline
cannot quietly stop testing isolation.

### Database-backed suites

```bash
# RLS regression: asserts the policies actually hide rows from fgmp_app
DATABASE_URL="postgresql://fgmp_app:…@127.0.0.1:5433/fgmp?schema=public" \
FGMP_MIGRATE_DATABASE_URL="postgresql://fgmp_migrate:…@127.0.0.1:5433/fgmp?schema=public" \
bun run test:rls

# PostgreSQL smoke test: proves RLS is enforcing, not just configured
bun run test:smoke

# Scheduler / single-flight / watermark proofs (need the ops role)
bun run test:proof
```

| Script | Asserts |
|---|---|
| `scripts/verify/rls-regression.ts` | every tenant table returns rows only with a tenant context |
| `scripts/verify/smoke-postgres.ts` | schema present, RLS enforced, roles correct |
| `scripts/verify/scheduler-proof.ts` | one advance per interval across replicas |
| `scripts/verify/scheduler-singleflight.ts` | advisory lock excludes a second holder |
| `scripts/verify/scheduler-timing-proof.ts` | the clock is wall-clock, not request-driven |
| `scripts/verify/engine-tenant-*.ts` | the engine cannot load a foreign tenant's rows |
| `scripts/verify/correlation-*.ts` | escalation/idempotency behaviour |
| `scripts/verify/auth-login-proof.ts` | credentials + session gate |
| `scripts/verify/preferences-idor-proof.ts` | a user cannot read another tenant's preferences |
| `scripts/verify/mfa-live-check.ts` | enrolment → challenge → verify against a live server |
| `scripts/verify/e2e/run-route-sweep.ts` | every API route returns its expected auth status |
| `scripts/verify/env-check.ts` | the same environment rules the server applies at boot |

### End-to-end route sweep

```bash
# builds and boots its own server on :3399
bun run scripts/verify/e2e/run-route-sweep.ts

# or point it at a server that is already running
E2E_BASE_URL=http://127.0.0.1:3210 E2E_SKIP_BUILD=1 \
  bun run scripts/verify/e2e/run-route-sweep.ts
```

The sweep signs in as each role and asserts the auth boundary (401 when
anonymous, 403 when under-privileged, 200 when allowed) rather than response
payloads — payload shapes are covered by unit tests.

## 2. Browser walk-through

```bash
bun run build
./scripts/dev/dev-server.sh          # production build on http://127.0.0.1:3210
```

The script resolves the repository root itself and exports the same DB URLs the
suites use. Check it is up:

```bash
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3210/    # 200
```

### Demo accounts

| Role | Email | Password |
|---|---|---|
| ADMIN (start here) | `admin@fgmp.telecom` | `Admin@2026` |
| SUPERADMIN | `superadmin@fgmp.telecom` | `Super@2026` |
| NOC_OPERATOR | `noc.operator@fgmp.telecom` | `Admin@2026` |
| REGIONAL_MANAGER | `regional.manager@fgmp.telecom` | `Admin@2026` |
| FIELD_ENGINEER | `field.engineer@fgmp.telecom` | `Admin@2026` |

There is no `/signin` route: `/` prompts in place, so a 404 on `/signin` is
correct.

### Four checks that prove the most

**A. Dashboard — tenant scoping is real.** As ADMIN expect 52 sites, 84 tanks,
76 generators; as SUPERADMIN the counts change because that role spans tenants.
Open **Tenant Isolation**: a foreign-tenant ID must never appear.

**B. Generators → issue START/STOP.** The correct answer is `NO_TRANSPORT`:

> simulated: No generator transport is configured, and simulated control is off.

A green "command sent" here would mean the platform is lying about a
safety-critical action. `FGMP_ENABLE_SIMULATED_CONTROL=1` enables the simulated
behaviour but still never returns `EXECUTED`.

**C. System Health → alert rules.** On a fresh server the posture is `unknown`,
not `ok`: six metrics have never reported, and an absent metric is not zero. A
green monitor here would claim theft detection is working when nothing has
reported.

**D. MFA end to end.** `enrol` → `verify-enrol` (ten backup codes) →
`challenge-request` → `challenge` with a correct code (200
`{"verified":true,"method":"totp"}`) and a wrong code (401 `INVALID_CODE`).
Requires `FGMP_MFA_ENCRYPTION_KEY`; without it `mfa/status` returns an explicit
configuration error, which is the correct response — an unencrypted TOTP secret
is a bearer credential sitting in a table.

**Keep the key stable.** Changing it makes stored secrets undecryptable and the
challenge route returns 500 by design; silent re-enrolment would let anyone who
can write the row bypass the second factor.

## 3. Things that look wrong and are not

| What you see | Why |
|---|---|
| `/signin` → 404 | No such route; `/` prompts in place |
| Control commands return `NO_TRANSPORT` | No hardware attached; deliberate |
| Alert posture `unknown` | Metrics have not reported; an absent value is not zero |
| `fgmp_theft_detections_total` absent | Scheduler refuses to fabricate telemetry |
| Empty dashboard on a new environment | Honest state without devices; seed the demo topology |
| Backup job output is a small dump | It ran as `fgmp_app`; RLS-scoped dumps are silently incomplete |

## 4. Checking the boundary yourself

```bash
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3210/api/fgmp/generators   # 401
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3210/api/fgmp/mfa/status   # 401
```

Then sign in and re-check: the same routes return 200. Sign in as
`field.engineer@fgmp.telecom` and confirm the control surface is reduced —
**Roles** shows the permission matrix.

## 5. Seeding a test database

```bash
FGMP_MIGRATE_DATABASE_URL="postgresql://fgmp_migrate:…@127.0.0.1:5433/fgmp?schema=public" \
  bun run db:seed
```

Seeding needs the owner role and is idempotent (`{"seeded":false}` when the
topology exists). The variable is `FGMP_MIGRATE_DATABASE_URL`, not
`DATABASE_URL`: RLS is `FORCE`-enabled on every tenant-carrying table, so
`DATABASE_URL` (the `fgmp_app` role) is rejected on the first insert with
`new row violates row-level security policy`. The seeder refuses to start
rather than fall back. See [DEPLOYMENT.md](DEPLOYMENT.md).
