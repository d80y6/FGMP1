# Phase 2 — edge, protocol, control, and the tenant-context defect

Status: **substantially delivered; three items outstanding.** This document records
what shipped, what was proven, and what is still missing. It is written to be
adversarial about its own phase.

## What shipped

### Simulated telemetry removed (`e452f6c`)

`engine.tick()` fabricated tank levels, generator temperatures, battery SoC and
fuel transactions from 44 `Math.random()` calls. It is now an explicitly opt-in
development facility that **cannot run in a production process**.

Two conditions must both hold: `NODE_ENV ≠ production` **and** `FGMP_SIMULATION`
enabled. Either alone is insufficient — a stray `FGMP_SIMULATION=1` cannot switch
it on in production. Enforced in two places: `engine.tick()` asserts before doing
anything (covers non-HTTP callers), and `/api/fgmp/tick` returns 503. The route
guard runs *before* `requireRole` so production gets the real reason rather than a
misleading 403.

All 44 calls replaced with seeded streams. One stream per subsystem — a single
shared sequence would mean changing how often a generator event fires silently
rewriting every later tank value. `mulberry32` was extracted from the existing
`seed.ts` implementation rather than reinvented, and a test pins the output to
`seed.ts`'s actual values so the two cannot drift.

**Verified:** `NODE_ENV=production` → `SimulationDisabledError`, `rlsEnforced=true`.
`Math.random()` in `engine.ts`: 0 functional (2 grep hits are comments).

### Edge buffering (`e452f6c`)

Ingest previously stamped every row with **server** time, so a reading that
arrived an hour late was indistinguishable from a fresh one and a replay was
indistinguishable from a new one. For fuel telemetry that means a stale tank
level silently overwriting a fresh one — theft figures wrong, with nothing able
to detect it.

Readings are now judged against a per-site watermark **before** any in-memory or
database mutation: `REJECT_STALE`, `REJECT_DUPLICATE`, `REJECT_FUTURE`,
`REJECT_TOO_OLD`, with distinct codes so an operator can distinguish a flaky link
from a clock problem. Body size is bounded before parsing; non-finite numbers are
refused (`JSON.parse("1e400")` yields `Infinity`, which passes a naive range
check and would put `Infinity` in a numeric column).

The ordering is deliberate: once `tank.current` has been overwritten by a stale
level, refusing the database write afterwards still leaves the dashboard and the
theft figures reflecting an hour-old reading.

### Modbus RTU + MQTT (`62a5586`, `a353136`)

CRC-16/MODBUS anchored to the **canonical conformance vector**: CRC of
`"123456789"` must be `0x4B37`. That single value pins polynomial, reflection, init
and output together. Cross-checked against two implementations written in
different styles over a 200-case corpus.

This was not ceremony — it caught three real bugs: `decodeRegister` **dividing**
by scale (47800 mV → 47,800,000 V), `buildReadRequest` allocating 7 bytes for a
6-byte request and putting a stray zero inside every CRC, and misremembered
"published" frame vectors.

**MQTT tenant isolation is NOT enforced.** `tenantAclPattern()` builds the string
`fgmp/<tenant>/#`; there is no broker client and no ACL. The agent correctly
retracted an earlier claim that this was an enforced control. It is a
*precondition* for isolation, not isolation. Proving it needs a live broker.

### Control interlocks (`03f6b22`, `4777d69`)

13 rules as **data**, split HARD (refuse) / SOFT (warn). Enforcement runs
**before** `engine.applyCommand()` — after, the command would already be at the
generator and the interlock would be decoration.

`EMERGENCY_STOP` is unblockable by construction: an interlock that can veto an
emergency stop is itself a hazard. Self-approval is refused outright, so the
two-person rule cannot be satisfied by one person typing twice.

**Mutation-tested**, because green proves nothing unproven: removing
`COOLDOWN_ACTIVE` → 3 failures; flipping fuel `<` to `<=` → 1 failure; disabling
the emergency-stop bypass → 1 failure; dropping RLS from `InterlockOverride` →
155 PASS/5 FAIL.

### Server-side clock and correlation (`94e5609`, `50eb361`, `5112f5c`, `52e18f2`)

The tick endpoint was driven by whoever was looking at the dashboard — state
advanced only while a browser tab was open. Replaced by a wall-clock scheduler
using `pg_try_advisory_xact_lock` (multi-instance-safe, not an in-process boolean).

**Proven:** 4 concurrent lock attempts → exactly 1 winner; 4 concurrent advances
→ 1 acquired; the loop advanced on wall-clock time with zero HTTP requests.

Correlation evaluation moved server-side and client-side evaluation was
**deleted**, not merely unused. Rule storage also moved server-side — rules were
being authored in localStorage while evaluation ran on the server, so a rule
created in one browser could never fire. The server-side work was inert for its
only real input path.

`encodeAlarmIds` originally joined ids on `,` without rejecting a comma inside an
id. That string **is** the idempotency key, so a collision would have made the
UNIQUE constraint silently discard a real escalation as a duplicate. Now throws.

## The defect that mattered most

Phase 1 shipped RLS. It did not audit what RLS did to application code.

```
db.site.count()                                     -> 0
db.site.count({ where: { tenantId: "t-default" } }) -> 0
withTenant("t-default", tx => tx.site.count())      -> 52
```

A query with no tenant context returns zero rows — **and an explicit
`where: { tenantId }` does not help either**, because the policy's `USING` clause
is ANDed with it and `current_setting('app.tenant_id')` is still NULL.

Therefore `assertTenantOwned()`, `tenantWhere()` and `siteTenantWhereOrAll()` —
all post-fetch, in-memory filters — were comparing `record.tenantId` on rows the
database never returned. **Phase 0's application-level defence was intact and
completely inert.** Every route relying on it was getting 404/null regardless.

Scale: **309 unscoped `db.*` calls across 80 route files.** It survived a full
phase because nothing exercised a real end-to-end login, and because an empty
result is indistinguishable from real empty data.

Two specific silent failures:

- **`audit()` resolved successfully and wrote 0 rows.** Its own `catch` swallowed
  the RLS violation. The compliance trail for 80+ mutating routes was destroyed
  with no error anywhere. Fixed with an owner-path fallback plus
  `auditFailureCount()`, because an audit subsystem must not be able to corrupt
  the operation it records (throwing would 500 a completed mutation and invite a
  retry that re-applies it) — but silent loss is now impossible and countable.
- **`suppression-check.ts` failed OPEN**, so suppressed alarms kept firing — a
  safety function silently inert, on a fuel site. The 30s cache then held that
  empty list, and the cache was global rather than per-tenant. Now fails closed
  with a per-tenant cache.

Login was one symptom: `auth.ts` looked up the user by email with no context, so
**every login returned null**. The failure was silent — 302 with no Set-Cookie, so
it looked like success followed by 401s everywhere. Email→user is inherently
cross-tenant (that is how authentication works), so it is a deliberate,
documented owner-path lookup in `src/lib/auth-identity.ts`, which exposes only
`findUserByEmail` / `findUserIdentity` / `updateAuthUser` — no generic escape
hatch — plus user-enumeration resistance.

### The durable fix

`no-restricted-imports` scoped to `src/app/**` bans importing `db`. This converts
a silent runtime wrong-answer into a compile error and makes the **next** route
fail the build rather than the next deployment.

The first version banned only `@/lib/db` and flagged 4 violations in 2 files — a
**false green**. The dominant import path is the `@/lib/fgmp` barrel (77 files),
which re-exports `db`. Banning only the direct path would have left 77 broken
routes passing. After adding the barrel: **81 violations, 307 calls**, which is
the real work queue.

A runtime guard was deliberately **not** built. With Prisma, a query extension
intercepts model operations but not reliably `$queryRaw`/`$executeRaw` or nested
relation paths — a guard loud on 90% of paths is worse than none, because the
silent 10% is indistinguishable from correct behaviour.

## Test integrity

The RLS suite grew 160 → **191 assertions, 30/30 tables**, exit 0. Two coverage
gaps were closed, both of which had been silently passing:

- **No FORCE coverage.** Disabling `FORCE` on a table left the suite at 153 PASS,
  because it runs as `fgmp_app` (a non-owner) and a policy binds a non-owner with
  or without FORCE. Now asserts `pg_class.relforcerowsecurity` directly. Verified
  both directions: dropped → `FAIL force-rls-coverage`, exit 1; restored → pass.
- **No per-table exercise coverage.** Five Phase 2 tables carried live policies
  and zero assertions. The suite now fails if any protected table lacks a fixture.

A third: `isMissingObject()`'s broad `/does not exist/` regex downgraded a real
defect (`column "bus" does not exist`) to "BLOCKED on step 6" — reporting an
infrastructure dependency when the cause was the suite's own SQL. BLOCKED
assertions are now named rather than merely counted.

Three consecutive suite runs once produced three different results because
concurrent agents were mutating one shared database. All three were worthless.
This is recorded because **a suite result is only evidence when you were the only
party touching the database**, and "ran it twice and it passed" is not evidence.

## Outstanding — not done

1. **81 lint violations / 307 calls across 79 route files.** The work queue the
   new rule produces. In progress.
2. **Cross-tenant CONTROL gap.** If the engine holds tenant A and a command
   arrives for a tenant B asset, the interlock read returns null and the command
   is **denied** — safe — but nothing *detects* the wrong-tenant request, and
   `applyCommand` / `controlDispenser` / `applyEspReboot` /
   `applyFirmwareDeployment` / `applyGatewayReboot` were never individually
   audited for silent no-op success. A cross-tenant denial is safe; a cross-tenant
   **allow** is not. In progress.
3. **MQTT tenant isolation unenforced.** Needs a live broker to prove.

## Known limits, not hidden

- **Ingest watermark is process-local.** Across replicas a device retry routed to
  another replica will not see it. Durable fix needs a unique index on
  `(entityId, metric, ts)` plus Redis (already a dependency).
- **Undated readings are accepted** and reported as undated — field firmware
  often has no RTC, and rejecting them would push operators to disable the check.
- **`SensorReading` has no `receivedAt`** (schema was out of scope when written).
  Uplink delay is returned in the response instead.
- **Interlock thresholds are inferred, not sourced.** Coolant 85 °C, oil 150 kPa,
  12 L cranking fuel, 3 min cooldown, 10 min fault backoff, 500 h overdue-service
  are placeholders in `NEEDS_OPERATOR_CONFIRMATION`. They all fail toward
  **refusal**, never toward permitting an unsafe action, which is why they are
  shippable as a gate — but they are not engineering standards. The cranking fuel
  figure is the weakest: real practice expresses it as a tank percentage or
  minutes of cranking load, both of which scale with engine displacement, so a
  flat litre count cannot be right for every engine.
- **`SHED_BELOW_SITE_REQUIREMENT` cannot fire** — `protectedLoadKw` is not
  modelled. The rule is correct and tested; the input does not exist.
  `CRITICAL_LOAD_SHED` works and covers the dangerous case.
- **Login enumeration timing is jitter, not signal.** Measured 1.48x–2.65x
  across runs on this machine. The meaningful comparison is the old behaviour,
  which skipped bcrypt entirely for an absent user (~300 ms vs ~0 ms) — a
  different order of magnitude.
- **RLS is a backstop, not the primary control.** It catches a missing tenant
  context. It does not catch a *wrong* one: `app.tenant_id` is an ordinary session
  GUC, so any process holding the `fgmp_app` credential can set it to any tenant.
  RLS protects against forgetting the context and against a missing WHERE clause
  — not against a compromised or malicious application process.
- **Not production-ready.** The user's precondition was that Phase 1's RLS suite
  passes and Phase 2's simulated telemetry is gone. Both are true. Neither makes
  the platform production-ready with 81 unscoped route queries outstanding.
## Addendum — a test route that reported success without measuring anything

`src/app/api/fgmp/admin/tenant-isolation-test/route.ts` exists to assert tenant
isolation. Under Phase 1's RLS it asserted nothing, and reported that isolation
was intact.

```
tenants found unscoped: 2
totalTests: 0   passed: 0   failed: 0
summary.isolationIntact = true
```

Two independent flaws, both reproduced rather than inferred:

**Flaw 1 — vacuous pass from the aggregation.** `isolationIntact: failed === 0`
(line 317). All eight sample queries (lines 140–167) are unscoped
`db.*.findFirst(...)`, so under FORCE RLS every one returns null. Each assertion
sits behind `if (sampleX)`, so all are skipped, `allTests` is empty, and
`failed === 0` on an empty array is `true`. The guard was written to skip absent
resources — which, once RLS makes every resource absent, skips everything.

This is worse than a route returning empty data, because empty data looks broken
while this looks authoritative. **A test suite whose "0 failures" means "0 tests
ran" is the most misleading artefact a codebase can contain.**

**Flaw 2 — a null record passes for the wrong reason.** `pass: denied !== null
&& saAccess === null` (line 189). `assertTenantOwned(null, …)` returns 404 for an
ordinary user and `null` for SUPERADMIN, so a null sample scores `pass: true`.
`assertTenantOwned` cannot distinguish "belongs to another tenant" from "does not
exist" — both are `record == null`. Even a fully-loaded version of this route
could report PASS while the RLS policy hid every row, which is precisely the
failure mode that concealed the original defect.

Note why the route got far enough to produce a report at all: `db.tenant.findMany`
still returns rows because `Tenant` has no `tenantId` column and so is not
RLS-protected. Cross-tenant enumeration worked; per-tenant sampling did not.

**The generalisable lesson.** `failed === 0` is not a pass. Any summary that
aggregates over a possibly-empty set must distinguish *nothing failed* from
*nothing ran*, and must refuse to claim success when it measured nothing. The
same shape appears in the RLS suite itself, which is why it now names BLOCKED
assertions and asserts per-table coverage rather than only counting outcomes.

## Addendum — "this table has no tenantId" does not mean "this route is safe"

The most easily missed variant of the tenant-context defect, found while fixing
`GET /api/fgmp/tenants`.

`Tenant` is keyed by its own `id` and carries **no `tenantId` column**, so it is
not RLS-protected and its own row reads perfectly well unscoped. It looks safe on
a glance — and is not. Its `_count` relations are resolved by Prisma through
nested queries on the ambient client, and `users`, `sites` and `suppressions` all
carry `tenantId` and are FORCE-protected.

Measured against the live database:

```
UNSCOPED: [{"id":"t-default","_count":{"sites":0,"users":0}}]    <- lies
SCOPED:   [{"id":"t-default","_count":{"sites":52,"users":5}}]   <- truth
```

So the route returned **HTTP 200 reporting that a 52-site tenant had no users and
no sites**. Not an error, not an empty state — a confident falsehood, and the
part most likely to be screenshotted into a status page.

**The generalisation:** scoping the top-level query is not sufficient. Every
nested `include`, every `_count`, and every relation traversal in a route must
also be inside the tenant context, because Prisma resolves them independently.
A parent-scoped fix that leaves one unscoped relation read is still a false 200.

This is the same shape as the audit-log defect: the parent operation succeeds, so
nothing looks wrong, while the nested part silently reports nothing.

## Addendum — a `Promise.all` trap for tenant-scoped reads

`Promise.all` returns a **tuple**. Destructuring it by property name type-checks
(TS sees a property access on a tuple type) and fails at runtime:

```ts
// type-checks, then throws at runtime
const { sampleSite } = await withTenant(t, () => Promise.all([q1, q2, q3]));
// correct: destructure positionally
const [sampleSite, sampleAlarm] = await withTenant(t, () => Promise.all([q1, q2]));
```

Neither `tsc` nor `eslint` catches this, so it is worth stating explicitly in
any code that batches multiple tenant-scoped reads.

## Addendum — the same defect gating a DESTRUCTIVE operation

`tenants/[id]` DELETE refuses to remove a tenant that still owns users or sites.
That refusal reads `_count` over two FORCE-protected relations.

Unscoped, those counts return 0 for a tenant that measurably has 5 users and 52
sites. The gate therefore read *"no users, no sites"* and **allowed the delete**.
The destructive statement then hit the FK layer instead of being refused cleanly
with a 409 — so data-loss semantics were decided by a query that had silently
stopped returning rows.

This is why the tenant-context defect is not merely a display problem:

> A read returning `[]` is **visibly** broken. A safety gate returning "nothing
> to worry about" is **invisibly** destructive.

Every other manifestation in this document produces an empty response that some
human eventually notices. This one produced a *passing* result. The counts are
now read inside the same transaction that performs the delete, so a row created
between the guard and the statement cannot slip a populated tenant through.

Proven without executing a destructive test, by reading the gate the way it now
reads:

```
t-default _count as the gate reads it: {"users":5,"sites":52}
gate would REFUSE delete: true
```

## Two more traps that typecheck cleanly

1. **A duplicated `where:` key silently overwrites the scoped one** with
   `where: { id }` and still passes `tsc`. Two independent agents hit this.
2. **A scoped top-level query with an unfiltered `include:`** returns a
   *populated* response carrying a null or foreign relation. That is worse than
   the original empty list, because it looks correct.

Both were caught by agents reading each other's diffs rather than by tooling.
Neither is detectable by `tsc` or `eslint`, which is the argument for reading
diff line-by-line when a mechanical transform touches authorisation code.

## Addendum — the tenant helper let a request body reach the transaction context

`asTenant(tenantId, fn)` took a **plain string**. Two routes passed it a value
resolved partly from the request body:

```ts
// src/app/api/fgmp/geography/regions/route.ts
const tenantId = parsed.data.tenantId || user.tenantId;
…
await asTenant(tenantId, async (tx) => { … });
```

It was safe only because an `if` statement ten lines earlier rejected a
non-superadmin who supplied someone else's tenantId. A tenant admin's entire
isolation rested on one `if`, ten lines from the call that opens the
transaction. That is a single point of failure, not a convention — one refactor
that moves the check, and a body field reaches the tenant context directly.

**The signature changed to take the user, not the id:** `asTenant(user, fn)`.

Proven unrepresentable rather than asserted — the original pattern compiled
against the new signature:

```ts
asTenant(parsed.data.tenantId, (tx) => tx.site.findMany())
// TS2345: Argument of type 'string | undefined' is not assignable to
//          parameter of type 'Pick<SessionUser, "tenantId">
```

79 mechanical substitutions, plus **two variables deleted rather than rewritten**
(`verifiedSiteTenantId` in suppressions, `site.tenantId` in batteries). Both were
derived from a row already scoped to the caller, so they always equalled the
caller's tenant and gated nothing. Deleting them removes the possibility instead
of fixing it — and in suppressions the row was written with `user.tenantId` while
the *context* came from the variable, so the two could disagree.

### What the new type does and does not guarantee

Worth stating precisely, because the obvious summary overstates it:

- **Guaranteed:** a client-supplied value — request body, query string, path
  parameter — cannot reach the tenant context. None of them have this type.
- **Not guaranteed:** an in-code mistake still compiles. During the mechanical
  pass a regex rewrote one call to `asTenant(site, …)`, passing a **row** where a
  user was expected. It compiled, because a Site row happens to have a `tenantId`
  field. It was caught by review, not by tooling.

Requiring a full `SessionUser` would catch that row case, but would not stop a
deliberate in-code fabrication, so it buys a narrow accident class at the cost of
friction on every legitimate call site. The narrower, true claim is the one worth
making.

### A mechanical pass that would have been a silent regression

Three call sites passed a body-supplied tenant for a legitimate superadmin
purpose, and were deliberately **not** converted:

```ts
asTenant(user, …)   // ← converting this SILENTLY redirects superadmin
                     //   provisioning into their OWN tenant instead of failing
```

It type-checks, and it does the wrong thing — which is worse than refusing. Those
sites moved to a separate `asTenantForAnotherTenant(user, targetTenantId, fn)`
whose SUPERADMIN assertion lives **inside** the helper, making the cross-tenant
capability named, greppable and runtime-checked rather than a string that happens
to be in the right variable.

### The lesson, in the author's own words

> The `asTenant(string)` design was MY proposal. It made 60 call sites correct in
> one afternoon, and it also made a body-sourced tenantId compile cleanly in a
> route I wrote myself. A migration helper that is simultaneously the thing that
> makes 300 calls correct and the thing that cannot express "this tenant came
> from the user" is under-designed.

The same property that made the helper easy to adopt made the mistake invisible.
No amount of green testing would have caught it.

---

# Phase 3 — closing the tenant-context defect

Phase 2 identified the defect and refused to call itself done. This phase closed it.

## The queue, and its shape

A new ESLint rule banned importing `db` inside `src/app/**`, converting a silent
runtime wrong-answer into a compile error:

```
81 violations / 309 unscoped db.* calls / 79 route files   at phase start
 0 violations                                                   at phase end
```

The rule's first version banned only `@/lib/db` and flagged 4 violations in 2
files — a **false green**. The dominant import path is the `@/lib/fgmp` barrel
(77 files), which re-exports `db`. Banning only the direct path would have left
77 broken routes passing.

A runtime guard was deliberately **not** built. With Prisma, a query extension
intercepts model operations but not reliably `$queryRaw`/`$executeRaw` or nested
relation paths, so a guard loud on 90% of paths is worse than none.

## Defects found while fixing, all verified against the live database

**The engine had been holding an empty platform since Phase 1.** `ensureInit()`
aborted on `permission denied for table Governorate`, because geography was
loaded via nested `include:` on tables the geography migration had correctly
revoked. Prisma resolves each nested include as a *separate* query requiring its
own privilege, so a correct revocation silently emptied the engine:

```
sites 52 | tanks 84 | generators 76 | regions 4     (after)
engine.sites.length = 0                              (before)
```

**Two endpoints returned 500 for every request since Phase 0.**
`POST /api/fgmp/iot/ingest` and `/api/fgmp/realtime/snapshot` both opened with
`await bootstrap()`, which resolves the user and throws without a session —
correctly, that is the Phase 0.3 fail-closed work. But both authenticate by API
key or service token and have no session. In ingest it was invisible because the
handler never *read* the returned user, so nothing downstream referenced the
value `bootstrap()` threw over.

Found by actually issuing requests. Neither the type gate nor the RLS suite could
have found it: both exercise code that is correct in isolation.

**A cross-tenant cache key.** `analytics`' 7-day readings cache omitted the
tenant id while the superadmin path passed `tenantSiteIds: null` — one tenant's
result served to the next.

**`db.$transaction` is a transaction without a tenant context.** Delivery
cancel and deliver used it, so the guard read returned null and the
`auditLog.create` inside was rejected by `WITH CHECK` — the audit write could
never succeed on the path a cancellation takes.

**`delete` throws when a row is absent**, so a cross-tenant id produced a 500
that distinguished it from a nonexistent one — the exact enumeration oracle the
404 guards exist to prevent. Six routes now use `deleteMany`.

## The tenant helper, redesigned

`asTenant(tenantId, fn)` took a string, and two routes passed it a value resolved
partly from the **request body**. It was safe only because an `if` ten lines
earlier rejected a non-superadmin supplying another tenant's id.

```ts
asTenant(user, fn)                             // the caller's own tenant
asTenantForAnotherTenant(user, tenantId, fn)   // throws unless SUPERADMIN
```

Proven unrepresentable: `asTenant(parsed.data.tenantId, …)` is now `TS2345`.
The narrow, true guarantee: a **client-supplied** value cannot reach the tenant
context. An **in-code** mistake can still compile — a mechanical pass did exactly
that, passing a Site row where a user was expected, because the row has a
`tenantId` field. Review caught it; tooling did not.

Three sites were deliberately **not** converted: doing so would have silently
redirected superadmin provisioning into their own tenant — which type-checks and
does the wrong thing.

## Geography isolation

`Governorate` and `District` carry no `tenantId` and so could never have had a
policy. Measured before the fix:

```
no tenant context  -> 36 districts      withTenant t-default -> 36
withTenant t-platform -> 36                             (identical = nothing filtered)
```

Closed with a `security_barrier` view (`v_geography`) deriving tenancy from the
Region chain, plus a `REVOKE` — the revoke being the half that actually matters:

```
SELECT count(*) FROM "District"      -> ERROR: permission denied
v_geography as t-default             -> 35 districts
v_geography as t-platform            -> 0
v_geography, no context              -> 0
```

A view rather than a denormalised `tenantId`, because duplication can drift: a
district whose region moved would keep a stale tenant id, which no constraint
prevents.

## Verification

```
tsc --noEmit                   0 errors
eslint .                       0 errors  (310 pre-existing warnings)
prisma validate                valid
migrate reset (from empty)     10 migrations, exit 0
db:seed                        {"seeded":true,"siteCount":52}
smoke-postgres                 PASS
rls-regression                 191 PASS / 0 FAIL / 0 BLOCKED, 30/30 tables
engine.ensureInit(['t-default'])  sites 52 | tanks 84 | generators 76
POST /api/fgmp/iot/ingest      HTTP 200, reading persisted, correct tenant
```

## Still outstanding — stated plainly

- **MQTT tenant isolation is unenforced.** A topic *structure* exists; there is
  no broker ACL and no broker client. Proving it needs a live broker.
- **Interlock thresholds are inferred, not sourced** (`NEEDS_OPERATOR_CONFIRMATION`).
  They fail toward refusal, but they are not engineering standards.
- **`SHED_BELOW_SITE_REQUIREMENT` cannot fire** — `protectedLoadKw` is unmodelled.
- **Ingest watermarks are process-local** — a retry routed to another replica
  will not see them.
- **Not end-to-end tested for most routes.** Most proofs are query-layer. Only
  ingest has been driven through a real HTTP handler. A route that typechecks and
  lints is not a route that has been observed working.
- **`app.tenant_id` is a session GUC.** Any process holding the `fgmp_app`
  credential can set it to any tenant. RLS catches a *missing* context, not a
  *wrong* one.
- **Not production-ready.** The user's bar was Phase 1's suite passing and Phase
  2's simulated telemetry gone. Both hold. Neither makes this production-ready
  with MQTT isolation unproven and most routes never exercised end to end.

## Addendum — `tsc` passing does not mean the app builds

`npx tsc --noEmit` reported **0 errors** while `bun run build` failed:

```
Type error: Type 'typeof import("src/app/api/fgmp/correlation/evaluate/route")'
does not satisfy the constraint 'RouteHandlerConfig<"/api/fgmp/correlation/evaluate">'.
  The types returned by 'POST(...)' are incompatible between these types.
    Type 'Promise<unknown>' is not assignable to type 'void | Response | Promise<void | Response>'.
```

Next.js requires an exported route handler to return `Response | void`. A
handler resolving to `Promise<unknown>` satisfies the compiler's own rules and
fails the framework's contract, so plain `tsc` cannot see it.

This matters more than an ordinary type error, because the build is what
produces the artefact that gets deployed. A green type-check gate — which CI
runs, and which was green for most of this programme — did not mean the
application could be built at all.

### The hierarchy of what actually verifies something

Established the hard way across this phase, and worth stating plainly because
each level was believed sufficient until a higher one found the defect:

| Level | Found | Missed |
|---|---|---|
| `tsc --noEmit` | type errors | Next.js route-handler contracts |
| `eslint` | import violations, syntax | everything behavioural |
| RLS suite | cross-tenant policy breaches | routes that were never invoked |
| `bun run build` | framework contracts | anything that compiles but 500s |
| **real HTTP request** | 500s, empty-200s, wrong tenant | rendering, browser reachability |

Every defect in this programme that mattered was invisible to the level above
it: unscoped reads returning empty were invisible to `tsc`; the ingest 500 was
invisible to the build; a list returning `[]` for a tenant owning 52 sites is
invisible to every check except issuing the request.

The E2E harness exists because of that table, not because HTTP tests are a
general good practice.
