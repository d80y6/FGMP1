# Testing FGMP in a browser

Everything below was run against this checkout, so the expected values are what
the system actually returns, not what it should.

## 0. Start it

```bash
cd /home/ubuntu/FGMP1
./scripts/dev-server.sh          # production build on http://127.0.0.1:3210
```

That is `bun run start` against the **already-built** app, not the dev server.
If you have changed code, rebuild first — it takes 8–9 minutes on this host:

```bash
bun run build && ./scripts/dev-server.sh
```

Check it is up:

```bash
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3210/
# 200
```

## 1. Open it

Go to **<http://127.0.0.1:3210>** and sign in.

| Role | Email | Password |
|---|---|---|
| ADMIN (start here) | `admin@fgmp.telecom` | `Admin@2026` |
| SUPERADMIN | `superadmin@fgmp.telecom` | `Super@2026` |
| NOC_OPERATOR | `noc.operator@fgmp.telecom` | `Admin@2026` |
| REGIONAL_MANAGER | `regional.manager@fgmp.telecom` | `Admin@2026` |
| FIELD_ENGINEER | `field.engineer@fgmp.telecom` | `Admin@2026` |

All six exist and are active. There is no `/signin` route — `/` is a
client-side app that prompts for credentials in place, so a 404 on `/signin` is
correct, not a bug.

## 2. The views you can click through

25 implemented: dashboard, sites, generators, batteries, dispensers, inventory,
fuel, fuel-forecast, consumption-patterns, analytics, alarms, suppressions,
maintenance, iot, geography, edge-firmware, asset-registry, reports, audit,
users, roles, api-keys, tenants, tenant-isolation, system-health,
system-settings, preferences.

**Start with these four — they prove the most.**

### A. Dashboard — tenant scoping is real
Expect **52 sites, 84 tanks, 76 generators**. Sign in as SUPERADMIN and the
counts change, because it spans tenants.

The check that matters: sign in as `admin@fgmp.telecom`, note a site ID, then
open **Tenant Isolation** — a foreign-tenant ID must not appear anywhere. That
view exists specifically to show the RLS boundary holding.

### B. Generators → issue a control command — *this is the important one*
Pick any generator, issue **START** or **STOP**, and read the response.

You will get:

> **NO_TRANSPORT: simulated: No generator transport is configured, and simulated
> control is off. Set FGMP_ENABLE_SIMULATED_CONTROL=1 only in a demo environment —
> it does not start a real engine.**

**That is the correct result, not a failure.** No hardware is attached, and the
platform refuses to pretend otherwise. A green "command sent" here would mean the
system is lying about a safety-critical action — which is the specific defect
this phase spent its length removing.

If you want to see the demo path, restart with `FGMP_ENABLE_SIMULATED_CONTROL=1`.
It still returns NO_TRANSPORT, deliberately: the flag enables the simulated
*behaviour*, never a false `EXECUTED`.

### C. System Health → alert rules
Evaluates 12 declarative rules against live metrics. On a fresh server expect:

```
posture: unknown    0 firing, 6 unknown, 5 ok / 11 total
```

**`unknown` is the honest answer.** Six metrics have never reported, and the
platform refuses to read an absent metric as zero. Specifically:

> theft_detector_silent → UNKNOWN — *"The series has never reported, so its value
> is unknown rather than zero… deliberately NOT reported as healthy — a monitor
> that is green because it received nothing is trusted in exactly the situation
> where it is useless."*

That is the trap this project kept falling into, held correctly. A green monitor
here would mean theft detection is being reported as working when nothing has
reported.

### D. MFA — the whole flow works now, and it was broken in two places

**Verified end to end against a production build:**

| Step | Result |
|---|---|
| `POST /api/fgmp/mfa/enrol` | 200, returns a secret |
| `POST /api/fgmp/mfa/verify-enrol` (correct code) | 200, ten one-time backup codes |
| `POST /api/fgmp/mfa/challenge-request` | 200, returns a challenge token |
| `POST /api/fgmp/mfa/challenge` (correct code) | 200 `{"verified":true,"method":"totp"}` |
| `POST /api/fgmp/mfa/challenge` (wrong code) | 401 `INVALID_CODE` |

**Both halves were broken, and neither was visible to the type checker.**

1. `totp.ts` passed the Base32 secret to HMAC un-decoded, so it hashed the ASCII
   of the base32 *text* rather than the key. **No code ever validated** — nobody
   could enrol at all. Now passes all six RFC 6238 SHA-1 vectors, including the
   year-2038 and year-2603 rows.
2. `MfaChallenge` is `FORCE ROW LEVEL SECURITY`, and the tenant lookup read it
   with an unscoped `db.$queryRaw`. That returns zero rows for every token, so
   the challenge route answered `CHALLENGE_INVALID` — *even with a correct code*.
   Enrolment worked; logging in was impossible. The second factor was welded
   shut. Now resolved through `fgmp_resolve_mfa_challenge`, a SECURITY DEFINER
   function owned by `fgmp_migrate`.

That second one is worth remembering: a comment above the broken function
described exactly this bug and stated it had been fixed. The escape it described
was never written, so the code looked correct and the comment confirmed it.

**A third defect, in the audit trail.** Every MFA audit row was being written
through the owner fallback — the rows landed with the correct `tenantId`, which
is exactly why it was easy to miss. But an owner-connection write proves nothing
about the caller's tenant scope, and it is indistinguishable from the hundreds of
route queries that silently return zero rows for the same reason. The security
audit trail — the thing relied on to *prove* the boundary held — was bypassing
the boundary.

`auditMfa` now writes inside the tenant context and **throws** on failure rather
than falling back, because for every MFA event the tenant is an explicit
parameter: a failure can only mean the context did not reach the INSERT. Verified
clean:

```
fallback / rejection count: 0

rows visible to fgmp_app without app.tenant_id: 0
rows visible to fgmp_app with    app.tenant_id: 4
```

That second pair is the real proof. An owner-written row is visible **both**
ways; a correctly-scoped one is visible only with the context set.

`FGMP_MFA_ENCRYPTION_KEY` must be set for any of this to run:

```bash
curl -s http://127.0.0.1:3210/api/fgmp/mfa/status -H "cookie: $COOKIE"
# {"error":"FGMP_MFA_ENCRYPTION_KEY is not set…"}
```

Correct: with no encryption key a TOTP secret would sit in the database as a
bearer credential with no protection.

**Keep the key stable.** Changing `FGMP_MFA_ENCRYPTION_KEY` after enrolment makes
the stored secret undecryptable, and the challenge route then returns 500 rather
than a usable message. That is deliberate — silently re-enrolling would let
anyone who can write the row bypass the second factor. Recovery needs a
second authorised operator.

## 3. Things that will look wrong and are not

| What you see | Why |
|---|---|
| `/signin` → 404 | No such route. `/` prompts in place. |
| `fgmp_theft_detections_total` never appears | Scheduler is disabled in production — it refuses to fabricate telemetry. Unprompted. |
| Control commands all return NO_TRANSPORT | No hardware attached. Deliberate. |
| Alert posture `unknown` | Metrics have not reported. Deliberate. |
| `/api/fgmp/tick` → 503 | Tick is refused without the required configuration. Correct. |

## 4. Confirm the boundaries yourself

```bash
# Unauthenticated access is refused
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3210/api/fgmp/generators
# 401

# MFA status refuses too
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3210/api/fgmp/mfa/status
# 401
```

Log in and re-check that the same routes return 200. Then sign in as
`field.engineer@fgmp.telecom` and confirm the control surface is reduced —
**Roles** shows the permission matrix.

## 5. Full automated suite

The browser is for the judgement calls. For coverage, the suite is faster:

```bash
bun test                                                   # 712 pass
npx tsc --noEmit                                           # 0 errors

DATABASE_URL="postgresql://fgmp_app:testapp123@127.0.0.1:5433/fgmp?schema=public" \
FGMP_MIGRATE_DATABASE_URL="postgresql://fgmp_migrate:testmigrate123@127.0.0.1:5433/fgmp?schema=public" \
bun run scripts/rls-regression.ts                          # 238 pass

E2E_BASE_URL=http://127.0.0.1:3210 E2E_SKIP_BUILD=1 \
bun run scripts/e2e/run-route-sweep.ts                     # 70/70
```

## 6. If the database is empty

```bash
DATABASE_URL="postgresql://fgmp_migrate:testmigrate123@127.0.0.1:5433/fgmp?schema=public" \
bun run scripts/seed.ts
```

Then restart the server. Expect 52 sites, 84 tanks, 76 generators.