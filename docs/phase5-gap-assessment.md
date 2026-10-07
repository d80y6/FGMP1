# Phase 5 — gap assessment

Answers "what remains?" by checking the Phase 0.5 audit (`REVIEW.md`) against the
code as it stands now, rather than against what the audit said in October.

Four agents verified in parallel, split by surface. Findings below are the ones
confirmed by direct inspection afterwards — where agents disagreed, the
conflict was resolved by recomputing rather than by picking a side.

---

## The honest headline

**The control path is simulated.** `applyCommand` writes no hardware: no Modbus
register write, no MQTT publish, no serial or socket I/O. It creates a
`ControlCommand` row, then mutates in-process memory.

This is the single most important thing in this document, because the platform
presents itself as remotely controlling generators and it does not. Nothing is
damaged today precisely because nothing is connected — but an operator reading
the `ControlCommand` table would believe an engine had been started when no
signal ever left the process.

---

## Critical

### 1. `Dockerfile` is a SQLite artifact and will refuse to boot

```dockerfile
CMD ["sh", "-c", "bun ./scripts/docker-init-db.js && exec bun server.js"]
```

```js
// scripts/docker-init-db.js:22-27
if (!raw || !raw.startsWith("file:")) {
  console.error(`[init-db] DATABASE_URL must be a file: URL ...`);
  process.exit(1);
}
```

Deployed against the PostgreSQL that `docker-compose.yml` actually provisions,
the container hard-exits on boot. This survived the entire SQLite →
PostgreSQL migration. **Effort: ~1h.** Nothing else can be verified on a real
deploy until this is fixed.

### 2. The `EXECUTED` lifecycle is documented in three places and implemented in none

`engine.ts:1842-1855` creates the row with `status:"SENT"`,
`executedAt: new Date(this.now)` and `result:"OK"` **at issue time** — before
anything could have happened.

- `src/app/api/fgmp/generators/[id]/control/[commandId]/route.ts:18` — claims a
  `PENDING → SENT → EXECUTED | FAILED | TIMEOUT` lifecycle
- `prisma/schema.prisma:1006` — same claim in the model doc

`grep -rn '"EXECUTED"' src/` returns **zero hits**. The enum has five members;
the code only ever writes `SENT` and `FAILED`.

This is worse than having no comment. A comment asserting a safety lifecycle
that does not exist tells an auditor the control is verified when it is not.

### 3. Per-tenant thresholds are stored but never read at runtime

I built the `InterlockThreshold` table and its API in Phase 4 and treated the
table as live without tracing the enforcement path end to end. That was my
error.

`buildInterlockContext` (`interlock-state.ts:105-121`) builds the context object
and never sets `thresholds`. `thresholdsOf(ctx)` therefore falls through to the
hardcoded constants.

**Proven, not inferred.** A row was written to the live table
(`coolantMaxC = 120`, `source OEM_DATASHEET`) and a generator evaluated at
88 °C:

```
DB row actually stored:  [{"thresholdKey":"coolantMaxC","value":120,...}]
ctx.thresholds:          undefined          <- table not loaded
verdict.allowed = false -> COOLANT_HOT_AT_ASSUME_LOAD   (at the 85 °C default)
```

The operator's confirmed OEM limit was ignored. The audit trail records the
hardcoded 85, so a denial is recorded against a limit the operator may have
overridden in the UI — an audit-integrity problem, not just a missing feature.

### 4. Unknown tank capacity permits cranking on an empty tank (fail-open)

```ts
// interlock-rules.ts:269
if (!tankCapacityLitres || tankCapacityLitres <= 0) return null;
```

`null` means the rule does not fire, so the action is permitted:

```
fuel = 0.1 L, capacity UNKNOWN -> allowed = TRUE   <- permits
fuel = 0.1 L, capacity = 0      -> allowed = TRUE   <- permits
fuel = 0.1 L, capacity = 500    -> allowed = false  (correctly denied)
```

The in-code rationale — *"uncomputable, so the rule declines rather than
guess"* — is sound reasoning about not **inventing a number**, and wrong about
what the rule should **do**. Declining the *check* is the opposite of fail-safe.
This is the one finding that would let a genuinely unsafe command through the
moment real hardware exists.

### 5. Control events are never persisted

```ts
// engine.ts:2150
db.siteEvent.create({ data: { tenantId: site.tenantId, ... } }).catch(() => {});
```

The bare client, no tenant context. Under `FORCE` RLS this **always** fails, and
`.catch(() => {})` discards the error. `REMOTE START` / `REMOTE STOP` events
exist only in memory until restart.

Same silent-success pattern already fixed twice elsewhere in this codebase.

---

## High

| # | Gap | Evidence |
|---|---|---|
| 6 | **No backups at all.** `lib/fgmp/backup.ts` and `/api/fgmp/backup*` were removed in Phase 0 (correctly — it leaked full DB copies) and nothing replaced them. `fgmp_ops` is provisioned for `pg_dump` and never invoked; the `fgmp-backups` volume is mounted and unwritten. | `docker-compose.yml:21` |
| 7 | **Fuel volumes are still `Float`.** Money moved to `Decimal` (4 columns), but `FuelTank.capacityLitres/currentLitres`, `FuelTransaction.volumeLitres`, `FuelDispenser.totalizerLitres` and the delivery volumes did not. `totalizerLitres` is a lifetime accumulator — float drift is what a fuel-dispute hinges on. | `schema.prisma` |
| 8 | **Engine state is never persisted.** Zero `fuelTank`/`generator`/`batteryBank` writes from the engine; state is read once at init. Every restart resets assets to seeded values, and two replicas diverge silently. | `engine.ts:178-189` |
| 9 | **Rate limiter is per-replica** — `const buckets = new Map(...)` at module level. Five login attempts/IP becomes 5×N. The IoT ingest limiter has no DB backing at all. | `rate-limit.ts:28` |
| 10 | **No notification transport.** No SMTP/webhook/SMS anywhere. The `NO_TRANSPORT` enum added in `20261008003000` is **never set by any application code**, so a queued row still reads as deliverable. | `grep NO_TRANSPORT src/` → nothing |
| 11 | **Theft detection does not exist.** `engine.ts:768` still *injects* theft via the seeded PRNG. There is no measurement-derived detection anywhere; `forecast/route.ts:289` detects unexplained *rises*, the inverse case. | verified |
| 12 | **Zero tests in CI.** 10 test files and a `bun test` script exist; `ci.yml` runs typecheck/lint/validate/build and no test step. Nothing mechanically prevents regression — the exact failure mode that produced this codebase. | `.github/workflows/ci.yml` |
| 13 | **RBAC inversions**, confirmed exactly: `READONLY` has `view:roles` (can see role management), `EXECUTIVE` lacks `view:sites`/`view:fuel`/`view:generators`, `FIELD_ENGINEER` lacks `view:suppressions`. | `rbac.ts` |

---

## Medium

| # | Gap |
|---|---|
| 14 | No observability: zero `pino`/`prom-client`/otel/Sentry deps, no metrics export, no tracing. You cannot alert on fuel-theft alarms. |
| 15 | TimescaleDB image runs but `create_hypertable` appears nowhere; `SensorReading` is a plain unbounded table. |
| 16 | No session `maxAge`/rotation, no MFA. For remote-start capability that is a real risk. |
| 17 | 4 divergent site-health formulas — not one formula in three places but three genuinely different weightings. `site-health-badge.tsx:64`, `site-health-trend.tsx:90`, `region-detail-sheet.tsx:71`. |
| 18 | 97 of 100 routes duplicate the `requireAuth` + rate-limit boilerplate; no HOF. The IDOR class recurs by copy-paste. |
| 19 | 39 selector-less `useFgmp()` calls against a vanilla Zustand store → re-render every 5s tick. |
| 20 | 7 native `window.confirm` for destructive actions (no focus trap, no RTL). |
| 21 | Command palette hardcoded English (`next-intl` not installed), `G R` shortcut collision. |
| 22 | 9 of 27 views lack error UI. |
| 23 | `asset-registry-view.tsx` is 2,239 lines — past the point where contrast and focus order can be reviewed reliably. |
| 24 | 7-day forecast is one number repeated seven times. `analytics/route.ts:289-290`. |
| 25 | Export is CSV-only; `docx` is a dead dependency. |
| 26 | Correlation rules record matches but never raise or escalate an alarm. |
| 27 | TOCTOU: `enforceInterlock` and `applyCommand` are separate awaits with no lock and no re-check. |
| 28 | No command idempotency; rows accumulate in `SENT` forever, which will eventually make `COMMAND_ALREADY_IN_FLIGHT` refuse *all* commands to that generator. |

---

## Resolved and should be retracted from REVIEW.md

`REVIEW.md` is now actively misleading — it lists defects that no longer exist,
which is worse than not having audited.

| Claim | Reality |
|---|---|
| "Tests: zero" | 10 test files, `bun test` script. Correct criticism: *CI never runs them.* |
| "Migrations: none" | 16 versioned migrations incl. RLS, replayed from empty in CI. |
| "SQLite, not PostgreSQL" | `provider = "postgresql"`. |
| "41 Float, 0 Decimal" | 4 `Decimal`. Correct criticism: *monetary columns converted, fuel-volume columns are not.* |
| "No Modbus/RS485 driver in the repo" | Real protocol layer with CRC-16, Modbus RTU, MQTT, tests. |
| "`edge/rs485` returns hardcoded zeros" | Zeros are now a historical note; live values persisted. |
| "No safety interlocks" | `interlocks.ts` implements them, two-person approval, 2 migrations. |
| "`stolenValueUsd` fabricated" | `DEFAULT_FX_YER_PER_USD = null`. USD figures are null, not invented. |
| "9 views return null while loading" | 1 does. |
| "~44 `Math.random()` calls" | 2; the rest use a seeded PRNG. |
| "38 dead API routes" | 0 are dead; 100 exist. |
| "21 dead shadcn components" | 17 are unused, of 48. |
| "9,600 LOC dead" | Built on the dead-route premise. Codebase is 78.3k LOC. |
| "Monolith vs 15 services" | Factually unchanged; see below. |

### On the monolith — the spec was wrong

The spec asked for 15 NestJS services with no stated consistency requirement.
The product's core operation is *"read tank level → compare against expected
consumption → raise theft alarm → page a human"* — a single transaction
boundary. Splitting it across services would put network hops inside the alarm
decision.

What is actually missing from the spec is **guarantees**, not service count:
RLS ✓, enums ✓, exact money ✓, migrations ✓. The two boundaries that genuinely
deserve separation already run as separate processes (`mini-services/realtime`,
`mini-services/iot-bridge`), alongside a real broker.

**The honest gap is not "too few services."** It is that simulated telemetry
still drives the numbers, and volume columns are float. Fixing those two yields
a defensible single deployable; splitting into 15 services first would multiply
the surface without fixing either.

---

## Recommended order

1. **Dockerfile** (~1h) — nothing deploys until this is fixed.
2. **Wire the threshold loader** into `buildInterlockContext` (~2h) — closes the
   fail-closed audit-integrity half of the gap I introduced.
3. **Make unknown capacity deny, or fall back to an absolute litres floor**
   (~1h) — the only finding that would let an unsafe command through.
4. **Stop the false `EXECUTED` record** — either write `PENDING` and have a real
   executor confirm, or rename the status so the table stops asserting an
   outcome that never happened.
5. **Fix `pushEvent`** (~1h) — control events must persist.
6. **Add `bun test` to CI** (~1h).
7. **Backups** (~4h) — cron + retention + a restore drill.
8. Fuel volumes → `Decimal` (~1 day).
9. Persist engine state, or move telemetry to `SensorReading` (~3 days).

Items 2 and 3 together are under three hours and close the only two findings
where the platform's *safety* claims are weaker than its documentation implies.
