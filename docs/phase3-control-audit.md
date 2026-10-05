# Phase 3 — control entry point audit (cross-tenant control gap)

Audit of every code path that mutates a physical asset from an issued command.
Question asked of each: **when the asset cannot be resolved, is the result a
DENIAL or a silent no-op SUCCESS?** A silent success is a defect, because the
operator is told the command was issued while nothing reached the device.

## Summary

| Entry point | Unresolvable asset | Tenant match asserted? | Verdict |
|---|---|---|---|
| `applyCommand` (generator) | `{ok:false}` | NO | **defect — silent success** |
| `controlDispenser` | `{ok:false}` + `resolveControlSite` | via site | deny, adequate |
| `applyEspReboot` | `{ok:false}` | NO | **defect — silent success** |
| `applyFirmwareDeployment` | `{ok:false}` | NO | **defect — silent success** |
| `applyGatewayReboot` | `{ok:false}` | NO | **defect — silent success** |

## The four defects

### 1. `applyCommand` — writes a command row with NO tenant context
```ts
const cmd = await db.controlCommand.create({
  data: { tenantId: site.tenantId, ... }
});
```
Under FORCE RLS an INSERT whose `WITH CHECK` has no `app.tenant_id` in scope is
rejected outright. So the create **throws**, and `applyCommand` propagates the
exception rather than returning `{ok:false}`. The route catches it via
`errorResponse(err)`, which yields a 500. That is at least *not* a silent
success — but it is an unhandled crash on the most safety-relevant path in the
product, and the error text leaks a raw PostgreSQL policy message to the
operator.

It also writes `tenantId: site.tenantId` taken from ENGINE state, never from
the authenticated user. If the engine holds the wrong tenant, the row is
attributed to that tenant rather than the caller's.

### 2. `applyEspReboot` / `applyGatewayReboot` — DB write failure is swallowed
```ts
db.fuelDispenser.update({ ... }).catch(() => {});
...
return { ok: true, status: "OFFLINE", message: `Reboot initiated on ${d.label}` };
```
Under RLS that `update` **always fails** (no tenant context), and `.catch(() => {})`
discards it. The function still returns `ok: true` and the route reports a
successful reboot to the operator while **nothing was persisted**. This is the
exact silent-success defect: in-memory state flips, the database does not.

### 3. `applyFirmwareDeployment` — same class, worse
```ts
const release = await db.espFirmwareRelease.findUnique(...)   // no ctx -> null
if (!release) return { ok: false, message: "Firmware release not found" };
```
`EspFirmwareRelease` is one of three tables deliberately EXCLUDED from RLS (a
global catalogue), so the read does work. But `db.espFirmwareDeployment.create`
carries `tenantId` and has no context, so it **throws** — again a crash, not a
clean denial.

### 4. No entry point asserts the asset's tenant matches the caller's tenant
`controlDispenser` is the only one that calls `resolveControlSite`, and even
that checks the SITE is resident rather than that it belongs to the tenant the
command was authorised for. An engine holding tenant A can never find tenant B's
asset, so the denial happens by accident of loading rather than by
construction. The invariant is not asserted anywhere.

## Why this matters even though a cross-tenant command is currently denied

The denial is a **side effect** of which tenants the process loaded, not a
control. Any of these makes it cross-tenant ALLOW:
- the engine later loading all tenants, or a different tenant per request
- `ensureInit()` being called with the request's tenant before resolving the asset
- a future change that resolves the asset from the DATABASE rather than memory,
  where an unscoped `findUnique` returns the row only because the id was known

So the gap is real and must be closed by construction, not left to a
convention that is currently holding by accident.

## The fix

A single `assertControlScope()` helper that takes the AUTHORISED tenant, the
resolved asset, and refuses when they differ or when the asset's tenant cannot
be determined. It is called at the top of every entry point, before any state
mutation. `applyEspReboot` and `applyGatewayReboot` additionally stop
discarding their DB errors.