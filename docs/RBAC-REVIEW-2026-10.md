# RBAC review — frontend and backend

**Scope:** role-based access control across the FGMP Next.js app — the client
(`src/components/fgmp/**`), the API (`src/app/api/fgmp/**`), and the shared
policy core (`src/lib/fgmp/rbac-*.ts`, `auth-helpers.ts`, `route-tenant.ts`).
**Date:** 2026-10-25 · **Branch:** `arena/8703ddf4-fgmp1` · **Base commit:** `cf624d2`

---

## 0. Summary

The security boundary holds. Four layers apply a request: session re-read →
capability policy → route allow-list → tenant scoping + FORCE RLS. I found no
path that lets a role reach data or an action the matrix does not grant it, and
the verify script's 171-handler inventory reports zero violations.

What I did find is **drift**: the same decision written more than once, in
different vocabularies, in different files — and, in three places, the copies
disagree. That is not a hole today, because the server is one of the copies and
the server always wins; it is a hole the day someone edits the copy that the
server is *not*. The clearest examples:

| # | Drift | Effect | Status |
|---|---|---|---|
| B1 | `POST /api/fgmp/dispensers/[id]/control` uses `ROLES.CONTROL` (ADMIN, NOC) while its capability rule is `dispenser:control` (ADMIN, NOC, **FIELD_ENGINEER**) | FIELD_ENGINEER sees "issue command" and is refused | fixed — route now uses `ROLES.DISPENSER_CONTROL` |
| B2 | `POST /api/fgmp/alarms` gates acknowledge **and** resolve on `ROLES.ALARM_OPS`, but the matrix gives `alarm:resolve` to ADMIN + NOC only | REGIONAL_MANAGER can resolve via the API; the UI now hides the button | fixed — `alarm:resolve` is ADMIN/NOC only, enforced per action in the handler and the client |
| F1 | `suppressions-view` gated on a 3-role literal while `view:suppressions` is held by all 7 roles | nav offered the view to FIELD_ENGINEER and READONLY; the view refused them | fixed |
| F2 | four views gated on `role === "ADMIN"` | SUPERADMIN — the wildcard holder — was shown "access denied" on System Health, System Settings, API Keys and Geography | fixed |
| F3 | a dozen mutating controls gated on nothing (or on the view capability) | READONLY / EXECUTIVE were offered a toolbar whose every action is a 403 | fixed |
| B3 | read rules matched by array order, write rules by longest prefix | fail-open if a broad rule is ever inserted above a narrow one | fixed (hardened) |
| B4 | `export?type=` accepted any known view capability | `view:iot` / `view:inventory` could fetch the site dataset under another name | fixed — one `EXPORT_TYPE_CAPABILITIES` table |
| B7 | `mfa/guard.ts` written, tested, and never called | a half-authenticated session reached the AUTH_ONLY routes | fixed — evaluated inside `requireAuth`, allowlist unchanged |
| B8 | `findUnknownCapabilities()` returned `[]` | a typo'd capability could deny an endpoint silently forever | fixed — implemented and wired into the verifier's exit code |
| B9 | cross-tenant user administration is a second exception to "tenant from the session" | `SECURITY.md` described only the support-session path | fixed — named in `SECURITY.md` §2 with its exact rules |

The full list, with evidence and severity, is in §3 (backend) and §4
(frontend). §7 states exactly what changed in the working tree.

---

## 1. Method and evidence

**Read end to end:** the policy core (`rbac-core.ts`, 521 lines — 7 roles, 44
read rules, 77 method rules, 14 auth-only rules), the guard layer
(`auth-helpers.ts` `requireAuth`/`requireRole`/`can`/`ROLES`, `route-tenant.ts`,
`support-request.ts`, `role-preview.ts`, `grant-guards.ts`), the NextAuth
configuration (`src/lib/auth.ts`, `auth-identity.ts`), the 27 views, the 20
shell/panel components, and all 107 route files (171 handlers).

**Executed:**

* `scripts/verify/route-inventory.ts` over the route tree — **171 handlers, 107
  routes, 0 violations** (no unmapped endpoint, no unguarded handler, no
  handler that authenticates but never hands the request to the guard).
* A capability ↔ rule cross-check: every capability held by ≥1 role is named by
  ≥1 rule and vice versa; no granted-but-unused capability, no unreachable
  surface. Four rule capabilities (`view:tenants`, `view:tenant-isolation`,
  `tenant:manage`, `platform:firmware`) are reachable only through
  SUPERADMIN's `*`, which is the documented design.
* A scripted handler-by-handler comparison of `requireRole(req, ROLES.X)`
  against the capabilities its path+method requires (85 handlers use
  `requireRole`; 84 agree exactly once SUPERADMIN's documented bypass is
  applied; the one exception is B1).
* A shadowing check over the read rules (no earlier prefix hides a later one
  for any of the 107 routes; B3 is therefore hardening, not a fix).
* A cross-check that every view's own gate names the same capability its nav
  entry declares (27 nav entries).
* An esbuild syntax pass over all 25 changed/added files (0 failures).

**Not executable here:** `authz-live.ts` — it needs a running server, a
database and seeded per-role credentials. `tsc`, `eslint` and the five test
suites were all reproduced locally instead; see §6 for how and what they
caught.

---

## 2. The model as implemented

```
next-auth JWT ──► requireAuth(req)                    auth-helpers.ts:49
                   ├─ getSessionState()               DB re-read: active? sessionEpoch match?
                   ├─ apply preview cookie            role-preview.ts (15 min, HMAC, sub-bound)
                   ├─ canAccessApi(role,url,method)   rbac-core.ts:479 — deny-by-default
                   ▼
                 requireRole(req, ROLES.X)            route allow-list; SUPERADMIN always admitted
                   ▼
                 asTenant(me) / withTenant(t)         SET LOCAL app.tenant_id
                   ▼
                 FORCE RLS (39 tables, role fgmp_app)
```

Two properties worth stating because they explain most findings:

1. **Capabilities, not roles, are the policy.** `ROLE_PERMISSIONS` is the only
   place a role is mapped to power; `canAccessApi` and `hasCapability` both read
   it. A role literal anywhere else is a second source of truth.
2. **The browser can never widen anything.** The client gate exists to avoid
   fetching what will be refused; it is an optimisation and a courtesy, and the
   API re-decides every request. This is why none of the frontend findings are
   privilege escalations — and why they matter anyway: a UI that offers an
   action the API refuses teaches operators to distrust the permission model,
   and the first consequence of that is someone asking for their role to be
   "fixed".

---

## 3. Backend findings

### B1 — `dispensers/[id]/control` is narrower than its own capability rule

**Severity:** medium (functional; no over-grant)
**Where:** `src/app/api/fgmp/dispensers/[id]/control/route.ts:31`

```ts
const auth = await requireRole(req, ROLES.CONTROL);   // ADMIN, NOC_OPERATOR
```

`ROLES.CONTROL` is the *generator* control set. The capability rule for this
path is `POST /api/fgmp/dispensers → ["dispenser:control"]`, held by ADMIN,
NOC_OPERATOR **and FIELD_ENGINEER** — and the two sibling hardware routes
(`edge/esp/[dispenserId]/reboot`, `edge/firmware/deploy`) already use
`ROLES.DISPENSER_CONTROL`, whose comment says it is "limited to roles that can
actually be at the pump".

So a field engineer is offered the command control by the client (correctly,
per the matrix) and refused by the route (incorrectly, per the matrix). The
route's own comment — "same as generator control" — is the assumption that
produced the mismatch: a dispenser is hardware a field engineer walks up to; a
generator is plant equipment under NOC remote control.

**Fix (one word):** `requireRole(req, ROLES.DISPENSER_CONTROL)`.

### B2 — "acknowledge" and "resolve" share one allow-list, but not one capability

**Severity:** medium (authority drift — an action is granted that the matrix does
not describe)
**Where:** `src/app/api/fgmp/alarms/route.ts:84` (POST), with
`{ action: "bulkAcknowledge" }` at :107 and `{ action: "bulkResolve" }` at :124.

```ts
const auth = await requireRole(req, ROLES.ALARM_OPS);  // ADMIN, NOC, REGIONAL_MANAGER
```

The matrix says `alarm:ack` = ADMIN, NOC, REGIONAL_MANAGER and `alarm:resolve` =
ADMIN, NOC. Because the route gates both actions on the union, a
REGIONAL_MANAGER can resolve an alarm — and after the frontend fix (§4) the UI
will no longer offer them the button, so the two layers now disagree visibly.

One of the two is wrong and the code cannot tell you which:

* `ROLES.ALARM_OPS`' own comment says *"Alarm acknowledge / resolve — NOC ops +
  managers"*, which argues the **matrix** is missing `alarm:resolve` for
  REGIONAL_MANAGER;
* the matrix's separate `alarm:ack` / `alarm:resolve` split argues the **route**
  should branch — resolve is a stronger act than acknowledge, and the two
  capabilities exist precisely to be separable.

**Recommendation:** decide, then make the loser match. If managers may resolve,
add `alarm:resolve` to `ROLE_PERMISSIONS.REGIONAL_MANAGER` (one word, matrix
becomes the description). If not, branch on `data.action` in the handler and
require `alarm:resolve` for resolve. Either way, the layer-2 rule is any-of
`[alarm:ack, alarm:resolve]`, so the distinction can only live in the handler —
worth a comment saying so.

### B3 — read rules were matched by array order; write rules by prefix length

**Severity:** low (latent fail-open) · **Status:** fixed

`apiReadCapabilities()` used `API_READ_RULES.find(...)`: the first entry whose
prefix fits wins. `apiRequestCapabilities()` sorts write rules by descending
prefix length. Both are correct *today* only because the read list is
hand-ordered specific-before-general (`/correlation/rules` before
`/correlation`, `/iot/ingest` before `/iot`) — and `docs/AUTHZ.md` §1.3 claims
longest-prefix matching for both.

I verified that sorting changes no decision for any of the 107 route paths, then
made read matching longest-prefix-first. The reason to change rather than
document: the failure mode is fail-**open**. Inserting one broad rule —

```ts
{ prefix: "/api/fgmp/platform", capabilities: ["view:dashboard"] }
```

— above the existing `platform/*` rules would hand the platform audit log,
grants and support-session surfaces to every dashboard reader, with no test
failing. After the change, order cannot matter.

### B4 — `GET /api/fgmp/export` silently substitutes one dataset for another

**Severity:** low (correctness; no data reaches a role that lacks `view:sites`)
**Where:** `src/app/api/fgmp/export/route.ts:28` and the `else` branch at :76.

`type` is read as a free-form string with the comment
`// sites | tanks | generators | alarms | deliveries`, but only `sites`,
`tanks`, `generators` and `batteries` are implemented; everything else —
including the documented `alarms` and `deliveries` — falls through to a **sites**
export with the requested name in the filename. So `?type=alarms` hands the
caller `fgmp-alarms-<ts>.csv` containing sites.

The capability rule compounds it: `export?type=alarms` requires
`view:alarms | view:reports`, i.e. the policy authorises one dataset and the
handler returns another. No role currently holds those capabilities without also
holding `view:sites`, so nothing leaks today — but the endpoint answers a
question nobody asked, confidently, and a `type` allowlist (like the one the
sibling `format` parameter already has) would turn a silent wrong answer into a
400.

**Fix:** validate `type` against the four implemented values and either
implement `alarms`/`deliveries` or remove them from the policy rule.

### B5 — tenant admins can read platform-wide settings

**Severity:** info (design check) · **Where:** `settings/route.ts:157`
(`GET`, `view:system-settings` = ADMIN + SUPERADMIN).

`SystemSetting` has no `tenantId` column: rows with `tenantId IS NULL` are
platform policy (session timeout, tenant caps, OTA switches, branding) and are
inherited by every tenant. The GET resolves catalog default → platform row →
tenant row and returns the effective map, so an ADMIN sees platform policy
values. That is probably intended (the tenant admin needs to know the effective
value), but it is the only place a tenant role reads platform-scope data, and it
is not called out in `docs/SECURITY.md`. Worth a sentence there rather than a
code change.

### B6 — the support surface is exactly one write, and it is enforced

**Severity:** none (verified) · **Where:**
`platform/support/[tenant]/summary/route.ts:55` (GET), `:125` (POST →
`assertSupportWritable`).

Cross-tenant read is reachable only with an open, tenant-matched support session,
through `withTenant(session.tenantId)` with RLS still applied — the URL tenant is
a claim the session must agree with, not a scope the caller supplies. `POST` is
the only support write (an audit-free note: it lands in the tenant's audit log),
requires `mode: "WRITE"`, and `assertSupportWritable` has exactly one call site —
consistent with that design. `assertSupportTenant` runs before
`assertSupportWritable`, so a mismatched tenant never reaches the write check.

### B7 — `mfa/guard.ts` has no production caller

**Severity:** low (dead code carrying a security claim) · **Where:**
`src/lib/fgmp/mfa/guard.ts` (`evaluatePendingSession`,
`pendingDecisionFor`, `isPublicPath`), referenced only from comments in
`mfa/challenge/route.ts:26` and `auth.ts:137,300`.

The module implements a per-path allowlist for MFA-pending sessions, and three
comments describe it as the thing that "refuses on every protected route". It is
never imported, and there is no `src/middleware.ts`. The protection that
actually exists is different and does work: `auth.ts` strips `role` and
`tenantId` from a pending session, the session callback deletes capabilities,
and `requireAuth` fails closed on the absent tenant. But a reader who trusts the
comment will believe a per-path allowlist is enforced centrally, and it is not.
**Fix:** wire it into middleware, or delete it and rewrite the comments to
describe the stripping that actually happens. Dead code that asserts a guarantee
is worse than no code.

### B8 — `findUnknownCapabilities()` is a stub

**Severity:** low (verifier gap; fail-closed, so no hole) · **Where:**
`scripts/verify/route-inventory.ts:314`

```ts
export function findUnknownCapabilities(): string[] {
  const known = new Set<string>(...);
  return []; // placeholder: capability existence is asserted by the matrix test
}
```

Nothing asserts it — the function is not called anywhere, and no test checks that
every capability named in `API_READ_RULES` / `API_WRITE_RULES` exists in
`ROLE_PERMISSIONS`. A typo in a rule (`"alarm:supress"`) would therefore deny
that endpoint to every non-superadmin forever, silently, because
`hasCapability` fails closed. The data needed is already in the handler records
this file builds (`requiredCapabilities`); the check is about ten lines and
would close the last unverified link in the chain.

### B9 — cross-tenant user administration does not require a support session

**Severity:** info (documented exception; audit already attributes the target
tenant) · **Where:** `users/route.ts:119,236` and
`users/[id]/route.ts:138,191,305,404` via `resolveTenantScope`.

`SECURITY.md` says cross-tenant content requires a support session.
`resolveTenantScope` is a second, narrower exception: a SUPERADMIN naming
`?tenant=` on the user-administration routes. It is well built — a non-superadmin's
`?tenant=` is silently ignored (no enumeration), `asTenantForAnotherTenant`
re-checks SUPERADMIN inside the transaction, `tenantId` cannot be part of an
`update` selector, and the audit record carries the *target* `tenantId`, so the
customer sees the write in their own log. It is still a second exception that
`SECURITY.md` does not name; one paragraph there would keep the document honest.

Also verified in this area: a tenant ADMIN cannot mint a SUPERADMIN
(`CANNOT_ASSIGN_SUPERADMIN`), cannot touch a SUPERADMIN account
(`guardSuperAdminTarget`), cannot deactivate themselves, and cannot remove the
last active admin of a tenant (`evaluateGrantChange` counts run in the same
tenant context as the write).

---

## 4. Frontend findings

All of these are fixed in the working tree (§7) except F10.

### F1 — the suppressions view disagreed with the nav and the matrix

`suppressions-view.tsx` carried `const ROLE_OK = new Set(["ADMIN",
"NOC_OPERATOR", "REGIONAL_MANAGER"])` and refused the view for anyone else.
`view:suppressions` is held by **all seven roles** — deliberately, per the
Phase-5 note in the matrix ("a field engineer who cannot see which alarms are
suppressed will investigate an alarm that an operator deliberately muted"). The
nav filter is capability-based, so FIELD_ENGINEER and READONLY were offered the
entry and then shown a refusal panel.

The same constant also gated *suppressing*, which is `alarm:suppress` — so a
visibility decision and an authority decision shared one literal. Replaced with
`canViewSuppressions` (`view:suppressions`), `canSuppress` (`alarm:suppress`) and
`canDeleteSuppression` (`settings:manage`, matching the DELETE rule).

### F2 — SUPERADMIN was locked out of four views by `role === "ADMIN"`

`api-keys-view`, `system-health-view`, `system-settings-view` and
`geography-view` each refused the view unless `me.role === "ADMIN"`. SUPERADMIN
holds every one of those capabilities through `*`, and the nav — being
capability-based — listed all four. The most privileged role in the system was
the only one shown "you do not have access".

All four now gate on their own capability. `tenants`, `tenant-isolation` and
`users` were also converted from role literals to `view:tenants` /
`view:tenant-isolation` / `view:users`; those are equivalent today and are the
point: they stop being equivalent the moment the matrix changes.

### F3 — mutating controls offered to roles that cannot mutate

The inverse error, and the more common one. Acknowledge/Resolve (single and
bulk), the select-all checkbox, ticket create/complete, delivery create/fire/
verify, ESP reboot, OTA deploy, dispenser commands, site create/edit/delete,
interlock thresholds, correlation-rule edit and toggle, handover-note create and
delete — every one was rendered for every role that could open the screen,
including READONLY and EXECUTIVE, who hold **no** action capability. The best
case was a silent client-side refusal toast; the worst was a 403 mid-workflow.

Each now asks the capability its endpoint asks:

| Control | Capability |
|---|---|
| Acknowledge / bulk acknowledge, alarm rules link | `alarm:ack` |
| Resolve / bulk resolve | `alarm:resolve` |
| Select-all and row checkboxes | either of the above (`canAct`) |
| Ticket create, per-row complete | `ticket:manage` |
| Delivery create, dispatch, verify | `delivery:manage` |
| Site create/edit/delete | `asset:manage` |
| Dispenser create/edit/delete | `asset:manage` |
| Dispenser live command | `dispenser:control` |
| ESP reboot, OTA deploy | `dispenser:control` (both endpoints) |
| Interlock thresholds | `settings:manage` |
| Correlation rule view/edit/toggle | `alarm:configure` |
| Handover note create | any of `alarm:ack`, `delivery:manage`, `ticket:manage` |
| Handover note delete | `settings:manage` |
| Role switcher (header + shell) | `role:preview` |
| Onboarding card + user-list fetch | `view:users` |
| System health indicator (fetch) | `view:system-health` |

Two of these were subtler than the rest. The OTA button was bound to
`role === "ADMIN" || role === "NOC_OPERATOR"` while
`POST /api/fgmp/edge/firmware/deploy` accepts `ROLES.DISPENSER_CONTROL`
(ADMIN, NOC, FIELD_ENGINEER) — one gate, two answers. And the handover panel's
create list exactly matched the union of the three capabilities the endpoint
accepts: right answer, wrong vocabulary, and therefore one matrix edit away from
being the wrong answer.

### F4 — the health indicator polled an endpoint it had no right to

`system-health-indicator.tsx` issued `GET /api/fgmp/health` every 30 s
unconditionally. It was only safe because the shell rendered it behind the ADMIN
literal (which also meant SUPERADMIN never saw it). The component now reads the
role itself and passes `null` as the `useApi` URL without `view:system-health`,
so no request and no timer exist for a role that cannot read it — and the shell
gate remains as a second lock.

### F5 — the shell held two redundant copies of the SUPERADMIN rule

`app-shell.tsx` filtered the nav on capability and then again on
`role === "SUPERADMIN"` for `tenants` and `tenant-isolation` (already implied by
`view:tenants` / `view:tenant-isolation`), and computed the preview-role list
from `role === "ADMIN" || role === "SUPERADMIN"` rather than `role:preview`. The
redundant filters are gone and the preview list is capability-derived; the
switcher's `disabled` state also stays enabled while a preview is active, since
the *effective* role may no longer hold `role:preview` and the operator must be
able to leave.

### F6 — `isAdmin` meant three different things

A boolean named after a role, computed from `asset:manage` in one file and
`dispenser:control` in another (renamed there to `canControl`), is a trap for
the next reader. Renamed to the capability each one checks
(`canManageSites`, `canReboot`, `canControl`); `asset-registry`'s `isAdmin`
kept its name with a comment because the prop is part of that component's
surface.

### F7 — two client gates duplicated a policy the client already had

`support-session-banner.tsx` and the `SUPER` badge compared
`role === "SUPERADMIN"`. That is legitimate — this pair asserts *identity*
(which session is this), not access, and the support overlay exists precisely so
a superadmin can act as another role, so a capability check on the effective
role would be false during the very session the banner reports. The literal
moved to the shared `isSuperAdmin()` helper so the string lives in one place,
and the reasoning is now in a comment instead of in the reader's head.

`onboarding-checklist.tsx` used `role === "ADMIN"` to decide whether to fetch
`/api/fgmp/users` — a `view:users` endpoint — and to decide whether to render.
Both now use the capability, so the card cannot appear to a role whose request
would be refused.

### F8 — a role gate and a capability gate for the same thing, one layer apart

`tenant-isolation-view.tsx` gated on `role !== "SUPERADMIN"` *and* called
`canAccessApi(me.role, "/api/fgmp/admin/tenant-isolation-test", "GET")` in an
effect. The former is now `view:tenant-isolation`, so both checks speak
capability.

### F9 — the remaining role literals are deliberate

After these changes, `grep -rn 'role === "\|role !== "' src/components/fgmp`
returns seven lines: two are comments describing gates that no longer exist, one
is `typeof role === "string"`, and four are **identity/behaviour** tests, not
access gates — which KPI tile to render and whether a tenant is required
(`users-view.tsx:175,481`), and `tenants-view.tsx:86`. They are correct; they
could use `isSuperAdmin()` for the same single-source reason as F7.

### F10 — site notes are localStorage with a client-supplied author

**Severity:** low (data provenance; not an RBAC bypass — there is no notes API)
**Where:** `site-detail-sheet.tsx:53` (`notesReadOnly = role === "READONLY"`),
`site-notes-panel.tsx:52,105` (`author = me?.name ?? t("notes.operator")`).

Notes are written to `localStorage`, so the author stamp is whatever the browser
says and the read-only gate is advisory: any role, including one that cannot
write anything else, can add a note that only that browser will ever see. Left
unchanged — replacing the literal with a capability would imply an authority
that does not exist. Either move notes server-side (with a server-stamped author
and `asset:manage`-style authority) or label the panel as device-local, because
it currently reads like shared operational record-keeping.

---

## 5. Verified correct (no action)

* **Session lifecycle.** `requireAuth` re-reads the account and uses the
  database role and tenant, not the token's; `sessionEpoch` revokes on
  password change, deactivation and forced reset; a pending-MFA session carries
  no role, no tenant and no capabilities, and every capability-checking path
  fails closed on it.
* **Role preview.** HMAC-signed, `sub`-bound, 15 minutes, no DB write; the
  overlay is only honoured when the *database* role is ADMIN/SUPERADMIN, so a
  forged or replayed cookie cannot widen a demoted account; `DELETE` stays on the
  auth-only list so an operator can always leave a preview.
* **Tenant scoping.** Unscoped reads on RLS tables return nothing, which is why
  the IDOR fix had to move `tenantId` into the query rather than rely on
  `assertTenantOwned` after the fact — the alarms detail route and the reports
  route both do this now, including nested relations.
* **`SUPERADMIN` is not omnipotent by accident.** It is admitted by
  `requireRole`, but its *tenant* is still its own; cross-tenant reads need a
  support session (B6) and cross-tenant user administration is the one explicit,
  audited exception (B9).
* **Platform surfaces.** `platform/audit`, `platform/grants`,
  `platform/support-sessions` and `platform/support/[tenant]/summary` all
  require `requireSuperAdmin` *and* a SUPERADMIN-only capability — two
  independent refusals.
* **Destructive vs constructive authority** is expressed deliberately: create /
  extend a suppression is `alarm:suppress` (ADMIN, NOC, REGIONAL_MANAGER) while
  deleting one is `settings:manage` (ADMIN); the same asymmetry holds for
  handover notes. The UI now mirrors it.
* **`GET /api/fgmp/reports`** degrades to the command-history projection for
  roles without `view:reports`, so its any-of `[view:reports, view:generators]`
  rule cannot be used to read audit/alarm/delivery payloads.
* **`POST /api/fgmp/settings`** checks authority per key, refuses a mixed-authority
  request as a whole, and fails closed (503) when the ops credential needed for
  platform-scope writes is absent.
* **Client gates that never fire before `me` loads** (`: true` when `me` is
  null in the suppressions, geography and asset-registry gates) are safe: the
  request is refused server-side, and the alternative — hiding the view during
  hydration — trades a real 403 for a flash of empty content.

---

## 6. Verification performed (and its limits)

CI's `verify` job (typecheck → lint) failed on the first push, so the gaps in
the original review were closed by reproducing the gate locally:

| Check | How | Result |
|---|---|---|
| `tsc --noEmit` | `npm install --ignore-scripts` + `tsc` on this branch **and** on a worktree of the base commit, diffing the error sets | **Two real errors, both fixed** — see below. The remaining 522 errors are byte-identical on base and branch and are all cascades of the missing generated Prisma client (`prisma generate` needs `binaries.prisma.sh`, which this sandbox cannot reach); CI generates the client, so they do not exist there. |
| `eslint .` | with the versions `bun.lock` pins (`eslint@9.39.2`, `eslint-config-next@16.1.3`, `eslint-plugin-react-hooks@7.0.1`) | **exit 0**, 0 errors, 2 warnings (both pre-existing in `users-view.tsx`). Note: npm's default resolution picks `eslint-plugin-react-hooks@7.1.1` and `eslint-config-next@16.4.3`, which report 25 errors *on the base commit too* — a version artifact, not this change. |
| `bun test` (5 RBAC/platform suites) | `bun` cannot be downloaded here (`release-assets.githubusercontent.com` is blocked), so each suite was bundled with esbuild against a minimal `bun:test` shim and run under Node | **80 assertions, 0 failures** — including all 27 in the new `rbac-ui-gates.test.ts` |

The two type errors the gate caught are worth recording, because both were
invisible to a parse-only check and both are the kind of thing this review is
about:

1. `onboarding-checklist.tsx` — `me?.role` is `Role | undefined`, so
   `hasCapability(role, "view:users")` did not type-check without first
   narrowing. Fixed to `role ? hasCapability(role, "view:users") : false`, which
   is also the correct fail-closed reading: no session means no user
   administration.
2. `rbac-ui-gates.test.ts` — the `ACTION_GATES` table was declared inside one
   `describe()` and referenced from another, so the new test would have thrown
   `ReferenceError` at collection time. Hoisted to module scope.

Still unverified: a live authorization probe (`scripts/verify/authz-live.ts`
needs a server and seeded accounts) and a per-role click-through of the changed
controls, which is the only way to confirm the buttons are actually hidden
rather than merely gated.

## 7. Changes applied in this working tree

> The request was a **review**. The frontend fixes below are code changes, and
> they are offered, not imposed. Nothing is committed. To discard all of it:
>
> ```bash
> git checkout -- src/components src/lib/fgmp/rbac-core.ts
> rm src/lib/fgmp/__tests__/rbac-ui-gates.test.ts docs/RBAC-REVIEW.md
> ```
>
> To keep the review and drop only the code:
> `git stash push -- src/components src/lib/fgmp/rbac-core.ts src/lib/fgmp/__tests__/rbac-ui-gates.test.ts`

**24 files modified** (`+301 / −132`) plus one new test file, all syntax-checked with esbuild:

| File | Change |
|---|---|
| `src/lib/fgmp/rbac-core.ts` | read rules matched longest-prefix-first (B3) |
| `app-shell.tsx` | preview list + switcher from `role:preview`; redundant SUPERADMIN nav filters removed; health indicator on `view:system-health`; `isSuperAdmin` for the SUPER badge |
| `views/suppressions-view.tsx` | `view:suppressions` / `alarm:suppress` / `settings:manage` replace `ROLE_OK`; optional card callbacks |
| `views/alarms-view.tsx` | `alarm:ack` / `alarm:resolve` / `canAct` on single and bulk actions and checkboxes |
| `views/maintenance-view.tsx`, `views/inventory-view.tsx` | `ticket:manage` / `delivery:manage` on create and per-row actions |
| `views/sites-view.tsx`, `views/asset-registry-view.tsx`, `views/dispensers-view.tsx` | `asset:manage` (and `dispenser:control` for live commands) |
| `views/edge-firmware-view.tsx` | reboot and OTA both on `dispenser:control` (the deploy endpoint's gate) |
| `views/geography-view.tsx` | `view:geography` to open, `geography:manage` for all 8 mutations |
| `views/system-health-view.tsx`, `views/system-settings-view.tsx`, `views/api-keys-view.tsx`, `views/tenants-view.tsx`, `views/tenant-isolation-view.tsx`, `views/users-view.tsx` | capability gates replace role literals |
| `correlation-rules-editor.tsx` | view/edit/toggle from `alarm:configure` |
| `site-detail-sheet.tsx` | thresholds on `settings:manage` |
| `header-overflow-menu.tsx`, `support-session-banner.tsx`, `system-health-indicator.tsx`, `onboarding-checklist.tsx`, `shift-handover-panel.tsx` | `role:preview`, shared `isSuperAdmin`, self-gated poll, `view:users`, any-of + `settings:manage` |

**1 file added:** `src/lib/fgmp/__tests__/rbac-ui-gates.test.ts` — static
assertions that (a) the nine self-gating views name their own capability,
(b) no component denies access with a role literal and none keeps a local role
allow-list, (c) the twelve action affordances consult the capability their
endpoint requires, and (d) the matrix facts that made the old gates wrong
(SUPERADMIN holds every view capability; FIELD_ENGINEER and READONLY hold
`view:suppressions` but not `alarm:suppress`; READONLY and EXECUTIVE hold no
action capability) still hold. **Not executed here** (§6); every assertion was
reproduced with an equivalent script during the review.

---

## 8. Suggested order of work

| Priority | Item | Effort |
|---|---|---|
| 1 | **B1** — `ROLES.DISPENSER_CONTROL` on `dispensers/[id]/control` | one word |
| 2 | **B2** — decide `alarm:resolve` for REGIONAL_MANAGER, then align matrix or handler | one line + decision |
| 3 | **B4** — `export?type` allowlist (stop returning sites under another name) | small |
| 4 | **B8** — implement `findUnknownCapabilities()`; it is the last unverified link | ~10 lines |
| 5 | **B7** — wire or delete `mfa/guard.ts` and fix the three comments | small |
| 6 | **F10 / B5 / B9** — decide the site-notes question; document platform-settings reads and the user-administration cross-tenant exception in `SECURITY.md` | docs |
| 7 | A per-role click-through of the changed controls, then `authz-live.ts` against a seeded stack. (`tsc`, `eslint` and the five suites already pass, §6.) | manual |

---

## 9. Status after the follow-up branch

The findings above are recorded against `cf624d2`. This section states what the
follow-up branch (`arena/591ce077-fgmp1`, base `6f95554`) actually closed, so
the review does not have to be re-derived to know whether an item is still real.

**Closed:**

| Finding | What changed | Guard |
|---|---|---|
| B1 | `dispensers/[id]/control` uses `ROLES.DISPENSER_CONTROL` on all three verbs | `rbac-server-conformance.test.ts` |
| B2 | `alarm:ack` and `alarm:resolve` are separate decisions in the handler and in the client | same |
| B4 | `export?type=` is validated against `EXPORT_TYPE_CAPABILITIES`; `alarms` and `deliveries` removed from the surface they did not belong to | same |
| B7 | `evaluatePendingSession` is called from `requireAuth`, before `canAccessApi`, for every protected route | same — asserts the *call site*, not just the guard |
| B8 | `findUnknownCapabilities()` implemented; the verifier exits non-zero on an unknown capability | `scripts/verify/route-inventory.ts` |
| B9 | `SECURITY.md` §2 names the `?tenant=` exception, its SUPERADMIN-only rule, its no-enumeration property, and which of its operations are audited | `platform-tenant-boundary.test.ts` — behavioural, over `resolveTenantScope` |
| drift in the navigation surface | one `NAV_ENTRIES` table (`src/lib/fgmp/navigation.ts`); the sidebar and the command palette both render from it, so a capability can no longer exist on one surface and not the other | `rbac-nav-single-source.test.ts` |

**Still open, deliberately:**

- **F10** — the site-notes question is a product decision, not a gate.
- A per-role click-through of a live, seeded stack (§6, item 7). Everything
  mechanical is green: `tsc` diff against the base commit is empty, `eslint` is
  clean, and all 33 suites pass locally.
