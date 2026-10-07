# Phase 4 — end-to-end HTTP verification

## What this phase actually established

Nothing, until it didn't.

Three defects in this programme were invisible to `tsc`, `eslint`, and a fully
green RLS suite — 191 passing assertions at the time:

- `POST /api/fgmp/iot/ingest` returned 500 for every request, because a
  sessionless route called `bootstrap()`.
- `GET /api/fgmp/realtime/snapshot` had the identical bug.
- `GET /api/fgmp/sites` returned 500, because it read tables whose SELECT
  privilege had been revoked on purpose.

All three compiled. Only issuing a request found them. That is the argument for
this phase existing at all, and the argument is not theoretical — the third
defect was found *by* this harness, minutes after it was fixed into working
order.

## The harness had five defects of its own

The first sweep reported `61 routes, 61 failures`. That output is
indistinguishable from a total outage, and it was in fact a harness that could
not authenticate and was calling URLs that do not exist. Every one of these
fails *loudly enough to look like a product bug*, which is what makes them
worth writing down.

### 1. Forged JWTs cannot authenticate

`sessionCookieFor` minted a NextAuth token locally with `jose`, on the stated
grounds that it was "hermetic" and "avoids a login round-trip". It was worth
nothing, because reproducing a session requires three things to match exactly —
and all three were wrong:

| Thing | Harness used | Server used |
|---|---|---|
| Signing algorithm | `HS256` | `EdDSA` |
| Issuer | `http://127.0.0.1:3080` | `http://localhost:3000` |
| Secret | exported env | `.env`, loaded at runtime, **overrides exported env** |

A JWT signed with the wrong algorithm family cannot be verified at any secret,
so no amount of secret-matching would have worked. The `.env` override is the
worst of the three: it is invisible from inside the harness, and no error
anywhere distinguishes "wrong secret" from "wrong algorithm".

The replacement is one HTTP round-trip:

```
GET  /api/auth/csrf
POST /api/auth/callback/credentials   (csrfToken, email, password)
```

### 2. The CSRF cookie is not the CSRF token

The cookie's value is a `value|hash` pair whose first half matches the
`csrfToken` in the JSON body. Reconstructing the cookie from the body token is
the obvious implementation and the one written first here. It makes NextAuth
answer `302 → /api/auth/signin?csrf=true`.

The dangerous part is the status code: **302, not 4xx**. A harness checking only
`res.ok` sees a successful login, then reports 61 unauthenticated requests
against 61 routes. The harness now detects that specific redirect and aborts
rather than reporting a sweep it knows is invalid.

### 3. `json=true` suppresses the session cookie

With `json: "true"`, NextAuth returns a JSON body instead of issuing the session
cookie. Another success-looking failure. Removed.

### 4. The `/api` prefix was dropped

`dir.replace(root, "")` on `src/app/api` yields `/fgmp/sites`. `/api` is part
of the route. All 61 requests went to URLs that do not exist.

### 5. Dynamic segments received placeholder ids

`e2e-site-00000000` is not a cuid, so Zod rejected it at the route boundary and
every dynamic route returned 400 before its handler ran — the sweep was
measuring its own placeholder.

That was the easy half. The subtle half: after switching to real ids, `[id]` was
mapped to a **site** id, so `/api/fgmp/tanks/<siteId>` returned a correct-looking
404. A 404 is *indistinguishable from a legitimate refusal*, so the handler
never ran and the sweep reported "gated — fine". Every `[id]` route now resolves
an id of the correct entity type per route:

| Route | Entity |
|---|---|
| `/tanks/[id]` | FuelTank |
| `/generators/[id]` | Generator |
| `/batteries/[id]` | BatteryBank |
| `/alarms/[id]` | Alarm |
| `/deliveries/[id]` | FuelDelivery |
| `/dispensers/[id]` | FuelDispenser |
| `/maintenance/[id]` | MaintenanceTicket |
| `/users/[id]` | User |
| `/sites/[id]`, `/shift-handover/[id]` | Site |

This is the general lesson: **a coverage sweep that passes tells you little
unless a wrong input is loud.** A placeholder id produced a 400, which was
visible. A wrong-type id produced a 404, which was not. Anything that can fail
"cleanly" needs its failure counted explicitly.

## What the sweep now proves

67/67 routes respond with no server error, against live PostgreSQL 17 and a
real session obtained by a real login.

```
/api/fgmp/sites        200   52 items
/api/fgmp/tanks        200   84 items
/api/fgmp/generators   200   76 items
```

### The assertion that matters most

> A list route returning **200 with an empty array** for a tenant that owns 52
> sites is a FAILURE.

This is the check no static analysis performs. RLS is fail-closed: an unscoped
query returns zero rows rather than an error. So a route that forgets
`asTenant(...)` returns `200 []` — byte-identical to a correct response for a
tenant with no data, and completely invisible to `tsc`. Only a known quantity of
seeded data distinguishes them.

A cross-tenant leak check walks the response tree for the seeded foreign
tenant's site, tank and generator ids and fails if any appear.

## Correct refusals are not failures

Three routes answer 4xx/5xx by design. The sweep classifies them explicitly
rather than treating any 5xx as a fault:

| Route | Status | Why it is correct |
|---|---|---|
| `/api/fgmp/tick` | 503 | Refuses to fabricate telemetry. This endpoint's entire purpose is to invent data, so it is the one place a production deployment must say no. |
| `/api/fgmp/iot/ingest` | 401 | Authenticates with a service token, not a browser session. |
| `/api/fgmp/realtime/snapshot` | 401 | Same. |

Both service-token routes were built in Phase 2 *specifically* so that a
sessionless endpoint would refuse an authenticated browser. A 401 there is the
security property working.

Reporting the tick's 503 as a defect was the first thing this harness got wrong
once it started working. A sweep that cries wolf trains its reader to ignore it,
which costs far more than the bug it was meant to catch.

## Remaining 404s, individually verified

Not accepted on the sweep's word. Each was checked against the database:

| Route | Cause | Row count |
|---|---|---|
| `/alarms/[id]` | No alarms seeded | `Alarm` = 0 |
| `/api-keys/[id]` | No API keys seeded | `ApiKey` = 0 |
| `/shift-handover/[id]` | No handovers seeded | `ShiftHandover` = 0 |
| `/generators/[id]/control/[commandId]` | No commands issued | `ControlCommand` = 0 |
| `/history/[entityId]` | No readings to page over | `SensorReading` = 0 |
| `/dispensers/[id]/commands` | Ids that are not dispensers | — |
| `/tenants/[id]` | Given a site id, correctly refused | — |
| `/proposal` | Must be generated first | — |
| `/iot/[siteId]/ota-status` | No OTA record for that site | — |

## Defects only a request could find

Once the harness worked, it earned its keep. Every one of these passed
`tsc`, `eslint`, a green RLS suite, and `prisma migrate deploy`.

### Geography writes were revoked along with geography reads

`GET /api/fgmp/sites` returned 500 with `permission denied for table
Governorate`. Migration 20261007000000 had correctly closed a real enumeration
hole by `REVOKE ALL`ing two tables that carry no `tenantId` — but `ALL` also
took away the INSERT/UPDATE/DELETE that ten geography handlers legitimately
need.

The fix was **not** to re-grant. Both tables now carry tenantId-derived RLS
(ENABLE + FORCE), with tenancy derived through the parent `Region` chain. The
revocation was never wrong; the routes had simply never been migrated with it.

Measured as `fgmp_app`, before and after:

| | before | after |
|---|---|---|
| no tenant context | 36 | **0** |
| `t-default` | 36 | 35 |
| `t-platform` | 36 | **0** ← the original defect |

### A missing `updatedAt` DEFAULT survived a migration, a generate and a `tsc`

`POST /api/fgmp/solar-sites` returned 500 — `P2011`, null constraint on
`updatedAt`. Prisma's `@updatedAt` is applied by the client, so the schema looks
correct, but the column was `NOT NULL` with no `DEFAULT`, and the raw SQL table
had to stand on its own.

Nothing static can see this. It is the identical bug the RLS suite had already
caught once for `InterlockThreshold`, written again from scratch by a different
agent in a different migration.

### `Promise.allSettled` discarded the database's duplicate verdict

`POST /api/fgmp/iot/ingest` answered **200** even when the write it had just
attempted had been rejected as a duplicate. The results were collected and
thrown away. That is the specific thing a durable uniqueness constraint was
added to prevent: the database adjudicates duplicates, and the handler then
ignored its answer.

Now a unique violation becomes 409 with `REJECT_DUPLICATE`, matching the
pre-write verdict so a device sees one answer regardless of which replica served
its retry. The check is deliberately narrow — a generic failure mislabelled as a
duplicate would tell a field device to stop retrying while its data was dropped.

### A measurement was collected and thrown away

The Modbus reader parses a signed `cellBalanceMv`, and a threshold module
consumed it, but nothing stored it: read off the wire, held in a local, gone.
It could not be trended, alarmed on, or reviewed.

It is now stored twice on purpose — as a `SensorReading` (the trend, because
imbalance is diagnosed by how it *moves*) and on `BatteryBank.cellBalanceMv`
(current state, readable without scanning history). Verified over HTTP:

```
POST /api/fgmp/iot/ingest  {"battCellBalanceMv": -47}  -> 200
SensorReading  BATT_CELL_BALANCE_MV = -47
BatteryBank    cellBalanceMv       = -47
```

Signed, not absolute: the sign is the diagnosis. `+47 mV` and `-47 mV` point at
different cells to replace.

## Mutations, verified by hand

The sweep is GET-only. The new write surfaces were exercised directly against
the production build rather than left untested:

| Operation | Result |
|---|---|
| `POST /solar-sites` | 201 |
| `POST /solar-arrays` | 201 |
| `GET /solar-sites/[id]`, `/solar-arrays/[id]`, `/interlocks/thresholds/[id]` | 200 |
| `PATCH /solar-sites/[id]` | 200 |
| `POST /interlocks/thresholds` twice, same key | 201 both, same row id — updates in place |
| `DELETE /interlocks/thresholds/[id]` | 200 |

RLS on the new tables, as the non-owner app role:

| | no context | `t-default` | `t-platform` |
|---|---|---|---|
| `SolarSite` | 0 | 1 | **0** |
| `SolarArray` | 0 | 1 | **0** |
| `InterlockThreshold` | 0 | 1 | **0** |

## Running it

```bash
# Against a server already running (safe while other agents edit the tree)
E2E_SKIP_BUILD=1 E2E_BASE_URL=http://127.0.0.1:3210 \
  bun run scripts/e2e/run-route-sweep.ts

# Self-contained: builds, boots on :3399, sweeps, tears down
bun run scripts/e2e/run-route-sweep.ts
```

`E2E_SKIP_BUILD` exists because `next build` reads every source file in the
tree. In a shared worktree it picks up other agents' half-finished edits and
reports failures that belong to someone else's work in progress.

## What this still does not prove

- **Mutations.** The sweep is GET-only. Firing every POST at a live database
  needs a per-endpoint fixture story, and a generic POST that passes proves less
  than an honest gap.
- **The UI.** Nothing here shows a page renders, or that the browser can reach
  these endpoints. It shows the endpoints do what they claim.
- **Concurrency.** The multi-replica watermark and advisory-lock behaviour have
  dedicated scripts, not route coverage.
