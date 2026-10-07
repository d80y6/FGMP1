# Phase 5 — remediation close

## The gate

```
tsc --noEmit          0 errors        (was 207 at the start of the sweep)
bun test              516 pass, 0 fail, 24 files
RLS regression        214 pass, 0 fail
production build      BUILD_ID anLb854TSA7gw_OCGesWW
E2E route sweep       68/68, 0 problems
```

37 commits. Verified by execution, not inspection.

The route count went from 61 to 68 — the solar and threshold surfaces added in
Phase 4 are now covered, and the tenant-scoped checks still return real data
(52 sites / 84 tanks / 76 generators) with no cross-tenant leak.

## What the 207 errors actually were

Worth recording, because the shape of them is the lesson and not any individual
one:

| Count | Cause | Whose |
|---|---|---|
| 164 | `Cannot find name 'useState'` — a selector conversion replaced `import … from "react"` instead of adding alongside it | p2-telemetry |
| 21 | `Prisma.Decimal` not assignable to `number`, after the `numeric(12,3)` conversion | p1-schema, p2-telemetry, me |
| 6 | `Number.isFinite(decimal)` always false; `?? 0` yielding `NaN` in a reduce | p1-schema |
| 3 | A `createdAt` column that does not exist on `ControlCommand` | p2-interlocks |
| 3 | `.reason` read off an unnarrowed union | p2-protocol |
| 3 | Missing React import / stale generated validator | mixed |

### The ones that were not type errors

Five of them compiled cleanly and were quietly wrong. These are the ones that
would have shipped:

1. **Rate limiting silently disabled** on `/api/fgmp/users/[id]`. `limitFor()`
   became `async` when the limiter moved to Redis; the call sites were not
   awaited, so `limited.success` was `undefined` and `if (!limited.success)` was
   always false. Every request returned 200. No log, no crash, no test failure —
   and the helper's own doc comment says it exists to stop exactly that.

2. **Delivery-discrepancy detection comparing the wrong volume.**
   `Number.isFinite(decimal)` is always false because a Decimal is an object, so
   the ternary took the fallback on every row — reconciling short and over
   deliveries against the **ordered** volume instead of the **delivered** one.
   Precisely the case that endpoint exists to catch.

3. **A total reporting `NaN`** because `(d.volumeDeliveredLitres ?? 0)` in a
   reduce does not fire on an object, giving `0 + DecimalObject`.

4. **`ReferenceError` on cancelling a deletion.** `settle` referenced itself
   from inside the object literal it was defined in. The most safety-relevant
   interaction in the new confirmation dialog — the one that must NOT perform the
   action — was the broken one.

5. **Idempotency doing nothing.** `idempotencyKey` was missing from a Prisma
   `select`, and an `as string` cast silenced the error, so the replay branch
   could never match. 55 unit tests over the decision core passed throughout:
   the pure core was handed the right value by a cast at the integration seam.

### Three lessons, stated so they survive

**A guard written when a column was Float stops meaning anything once it is
not, and keeps compiling.** `?? 0`, `Number.isFinite`, a bare `+`, an `as
number`. Four separate defects, one shape.

**A cast at a module boundary converts a type error into a silent no-op**, and
no amount of testing the pure side notices. 55 green tests could not see a
missing `select` field; the typecheck found it in seconds.

**ESLint is a style check, not a correctness check, for TypeScript.**
`no-undef` is disabled in every TS-targeted config, so 16 files that did not
compile reported 0 lint errors. That gap was mine: I suggested eslint as the
cheap per-file check without saying plainly that it cannot see a missing import.

## Critical items closed

| Item | Status |
|---|---|
| Dockerfile could not boot (SQLite init, hard-exit on Postgres) | rewritten; `migrate deploy`, no DDL in the app process. **Image build + boot still unverified** — needs one run on a quiet machine |
| Backups | verified both directions: 236 KB dump + SHA-256, restored into a probe DB, row counts matched the live database |
| Thresholds stored but never read | `loadThresholdsForInterlock()` reads inside `withTenant`; proven: DB row `coolantMaxC=120` now allows 110 °C where the 85 default denied it |
| Fail-open on unknown tank capacity | now DENIES with an actionable message; verified `fuel=0.1L, capacity UNKNOWN → allowed=false` |
| False `EXECUTED` lifecycle | `executedAt: null`, `result: "SIMULATED_DISPATCH_APPLIED_NO_HARDWARE"`; the three comments claiming a lifecycle no longer claim one |
| `pushEvent` silently failing under RLS | runs in `withTenant`, logs on failure; third instance of the silent-success pattern |
| TOCTOU between interlock and dispatch | re-evaluated inside a per-generator critical section |
| Fake `EXECUTED` never written | correct states now |
| Correlation matches recorded but not acted on | raises `Alarm.severity`, idempotent, mutation-tested |
| Theft injected then reported | now derived from measured level vs runtime-predicted consumption |
| Invented FX rate | `null` with `NO_FX_RATE_CONFIGURED` |
| Fabricated delivery-order number | removed |
| CSV-only export | CSV + XLSX + DOCX |
| Forecast repeating one number 7× | least-squares projection with explicit direction and R² |
| In-memory rate limiter | Redis, per-endpoint failure policy |
| No notification transport | real SMTP + webhook + Twilio SMS; three outcomes distinguishable |

## Still open, honestly

1. **Dockerfile image build and boot — unverified.** The entrypoint is verified
   by execution against live Postgres (migrated → starts; empty → refuses;
   unreachable → refuses with a different message). The image itself is not.
2. **Engine state is not persisted.** Two agents independently concluded the
   real fix is moving telemetry to `SensorReading`, which is the same task as
   the hypertable work and touches the RLS hot path. Not started, deliberately,
   with the reasoning recorded.
3. **`create_hypertable` conflicts with `SensorReading`'s cuid primary key** —
   converting it means changing that table's PK strategy.
4. **Remote generator control is still simulated.** Interlocks, idempotency,
   reconciliation and locking are all real now, but nothing writes to hardware.
5. **MFA assessed, not implemented** — `docs/mfa-assessment.md`. A half-built MFA
   produces a condition its users cannot distinguish from a locked-out platform.
6. **Frontend Tasks 5–8** (palette, error UI, `asset-registry-view` split, dead
   code) and 5 of 7 `window.confirm` conversions.
7. **No observability consumer** — `/metrics` and structured logs exist; nothing
   scrapes them or alerts.
