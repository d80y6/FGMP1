# Phase 5 — final close

## The gate

```
tsc --noEmit          0 errors        (was 207 at the start of the sweep)
bun test              712 pass, 0 fail, 35 files
RLS regression        238 pass, 0 fail   (was 214)
production build      NpToeMzAU7lnGnzAJPR29
E2E route sweep       70/70, 0 problems, no cross-tenant leak
migrate status        up to date, 22 migrations
```

58 commits across 8 agents.

## Verified against the built image

Not "the Dockerfile looks right" — the image was built and booted:

| Check | Result |
|---|---|
| Migrations enabled | 22 migrations, "No pending migrations to apply", Ready in 2.7s |
| `/api/fgmp/health` through the container | **401** `UNAUTHENTICATED`; root 200 |
| Empty DB + `FGMP_SKIP_MIGRATE=1` | preflight refuses, exit 1 |
| Least privilege, `fgmp_app` | `CREATE TABLE` → 42501; `CREATE INDEX`/`DISABLE RLS`/`DROP TABLE` → must be owner |
| Escalation to `fgmp_migrate` | was reachable; now closed |

The production scheduler also refused to fabricate telemetry, unprompted:
*"Simulated telemetry is disabled in production … would be reporting fiction as
fact."* Nobody asked it to. That is the assertion-of-honesty working.

## The finding that mattered most

p0-impl was verifying least privilege and found the credential check came back
**PRESENT**. Rather than report the green result they wanted, they reproduced the
consequence from inside the running container:

```
escalate to: {"u":"fgmp_migrate"}
DDL SUCCEEDED as {"u":"fgmp_migrate"}
```

`fgmp_migrate` is the schema owner and a SUPERUSER. Every RLS policy in this
project is bypassed by it. And the trigger was innocent — passing the variable in
to test migrations, exactly as a reasonable person would.

The boundary had been resting on documentation ("compose never gives the app the
owner URL") rather than enforcement. The server now runs with the credential
deleted from its environment; it is needed for exactly one `spawnSync` and has no
reason to exist for the lifetime of the process serving traffic.

**A documented boundary is not a boundary.** That is the whole lesson of this
phase, and it took a boot failure to demonstrate rather than a type error.

## And the guard that passed for the wrong reason

In the same file:

```js
process.env.FGAP_MIGRATE_DATABASE_URL || process.env.DATABASE_URL
//                              ^^^^^ not FGMP_
```

The preflight fell through to the app's own RLS-enforced credential. The
empty-database test still passed — against an empty database even the app role
sees no `Tenant` table, so the refusal happened for an entirely wrong reason.

No assertion shaped like *"refuses to start on an empty database"* would ever have
distinguished the two. **A guard that passes for the wrong reason is not a
guard**, and this project has now produced that mistake in five distinct
guises: an absent metric reading as zero, a bypassed rate limiter, `NaN` from
`??` on a Decimal, an `as string` hiding a missing select field, and a preflight
using the wrong credential.

## Three more real defects, found by execution

1. **Ambiguous tenant resolution made every control command reload the world.**
   `ensureInit()` resolved tenants from query results — 34 tenant fixtures left by
   test runs meant 15,867 ms per command against 629 ms for one. Now no request
   path can resolve ambiently; `ensureAllTenants()` is the one named exception.

2. **The dedup guarantee was a fiction for undated readings.**
   `new Date(deviceTs ?? nowMs)` — a device omitting `ts` got server time, so a
   retry got a *different* server time and was accepted as new data. Now recorded
   as `tsSource=SERVER`, with the guarantee explicitly not claimed for those rows:
   `{"deviceRetryRefused":true,"serverRetriesAccepted":2,"hypertableStillWorks":true}`.
   The blind spot became measurable rather than invisible.

3. **A `migrate dev --create-only` would have silently reverted the hypertable**,
   regenerating `PRIMARY KEY (id)`. Caught, hand-written migration committed
   instead, and a test now fails if any migration regresses it — one that passed
   against exactly the SQL it exists to forbid until its pattern was corrected.

## What is deliberately still not built

1. **Real hardware.** `EXECUTED` is unreachable by design: no shipped dispatch
   implementation contacts a device. Modbus write codes and control registers are
   not shipped because no controller manual was ever supplied, and a plausible
   unwired implementation would be assumed to have been run.
2. **MFA UI.** The API is complete and enforced; enrolment UI and backup-code
   regeneration are not built. MFA stays off unless an encryption key is present.
3. **Frontend Tasks 5–8** — palette collision, error UI for 9 views,
   `asset-registry-view.tsx` split, dead code.
4. **Observability consumer.** `/metrics`, alert rules and a preview endpoint
   exist; nothing scrapes them or pages anyone.