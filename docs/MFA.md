# MFA — DECISION: build it, with recovery built first

**Status: DECIDED. This supersedes the earlier assessment, which surveyed the
problem instead of deciding it.**

Decision owner: Phase 5 integrator · Endorsed by the Phase 5 lead
Date: 2026-08-07

---

## The decision

**MFA will ship.** Specifically: TOTP, with hashed single-use backup codes
generated and shown **before** enrolment completes, and a two-person break-glass
reset. Recovery is a prerequisite, not a follow-up.

**MFA is OFF by default and can only be enabled when it is fully configured.**
If the encryption key is absent, enrolment is refused. A control that can be
half-enabled is a control that will be.

---

## Why the earlier "no" was wrong

The earlier assessment reached a correct observation and drew the wrong
conclusion from it.

The observation: *an operator who loses their authenticator is locked out, and at
03:00 with a theft alarm that is an outage.*

The conclusion drawn: *therefore MFA cannot ship.*

That conflates **MFA being risky** with **MFA being unavailable**. The lockout
risk is real, but it is a *recovery design* problem with a known solution —
hashed single-use backup codes, which is exactly what every serious deployment
uses. Declaring a feature impossible because one of its sub-problems is hard is
not caution; it is refusing to do the work.

The lead's challenge was correct: the blockers I named were scoped, not
fundamental.

---

## Answers to the three questions put to me

### 1. Backup codes — are there reasons to reject them here?

**No. They are the right answer, and they are buildable today.**

- `bcryptjs` is already a dependency and is already the password hash in this
  codebase, so recovery uses one hash function for every credential — a
  compromise of the hash store does not reveal a code.
- Codes are generated from a CSPRNG, not a word list, so there is no dictionary
  to attack.
- They are consumed **atomically** and **single use**, so a replay cannot reuse
  one.
- Ten codes is enough for a realistic loss rate. When they run low, the operator
  regenerates — which is itself an audited action.

The objection worth recording: backup codes in the same drawer as the phone
weaken the second factor. That is a deployment-hygiene matter (printed and
stored in the site safe, which is where fuel-platform operators keep site
access), not a reason to omit the mechanism.

### 2. A break-glass reset — theatre, or acceptable?

**Acceptable, and required — because the platform already has this exact
control working.**

`InterlockOverride` carries `requestedById` **and** `approvedById` plus a
mandatory `justification`. A safety bypass on this platform already requires two
people and writes an audit record naming both.

MFA reset reuses that shape rather than inventing a second pattern:

- A reset REQUEST is created by one authorised operator with a justification.
- A second, different operator APPROVES it.
- `mfaResetRequestedById` and `mfaResetApprovedById` are recorded permanently.
- A reset **disables** MFA and forces re-enrolment; it does not silently clear
  to "no second factor" and leave it there.

Why two people is not theatre here: a single-operator reset is exactly the
social-engineering attack — "I'm locked out, it's urgent, I'm the superadmin."
Requiring a second person to countersign converts a convincing conversation into
a logged, attributable request. On a platform where one role can read every
tenant and another can start generators, that is the difference between a control
and a checkbox.

### 3. Which roles first — SUPERADMIN, or NOC_OPERATOR?

**SUPERADMIN first. The lead's framing was right and my earlier ordering was
under-argued.**

- SUPERADMIN can obtain access to **any tenant's** data — but only one tenant at
  a time, through an explicit, time-boxed support session that records a reason
  and is visible in that tenant's own audit log (see `docs/SUPERADMIN.md`).
  Because the reachable blast radius is the whole platform, it is still the
  credential whose compromise is worst. It is **not** true that a super-admin's
  ordinary session spans tenants: every tenant-scoped route runs in the caller's
  own tenant context, and `SUPERADMIN` is no exception.
- It is the **smallest population** — usually one or two people. So a mistake in
  the enrolment or recovery flow has a tiny blast radius while it is being
  shaken out in production.
- MFA is not required for NOC_OPERATOR to be *safe* in the same way: they are
  already gated by role and by the interlock layer on the commands they can
  issue.

Order: **SUPERADMIN → NOC_OPERATOR → (later, opt-in) everyone else.**

Enrolment is **mandatory** for SUPERADMIN once enabled. Optional MFA is skipped
by precisely the people who need it.

---

## What was built, and what is verified

Implemented in `src/lib/fgmp/mfa/`:

| Piece | File | Verified by |
|---|---|---|
TOTP (RFC 6238) | `totp.ts` | **All six published Appendix B vectors** |
Base32 (RFC 4648) | `base32.ts` | RFC 4648 vectors + round-trip |
Envelope encryption | `crypto.ts` | Round-trip, tamper detection, wrong-key rejection |
Pending challenge | `challenge.ts` | Token hashing, TTL, single-use consumption |

### The verification that mattered

The first version of `totp.ts` **passed every test written against it and was
wrong**. It fed raw Unix time into the HMAC instead of the time step
`T = floor(unixTime / 30)`. It produced well-formed six-digit codes that **no
authenticator app would ever accept**, and tests asserting the same
misunderstanding confirmed it.

This is the identical trap as the Modbus CRC in Phase 2, where misremembered
"published" vectors were the bug itself. It is why the vectors here were fetched
from RFC 6238 rather than written from memory:

```
time=59           T=1          got 94287082  expect 94287082  OK
time=1111111109   T=37037036   got 07081804  expect 07081804  OK
time=1111111111   T=37037037   got 14050471  expect 14050471  OK
time=1234567890   T=41152263   got 89005924  expect 89005924  OK
time=2000000000   T=66666666   got 69279037  expect 69279037  OK
time=20000000000  T=666666666  got 65353130  expect 65353130  OK
```

A conformance vector from an external document is the only thing that catches
that class of bug. A test comparing an implementation to itself proves nothing.

### A second bug the tests caught

`scrypt` at N=2^15 requires 32 MB, which exceeds OpenSSL's default `maxmem` and
throws `MEMORY_LIMIT_EXCEEDED` on **every call**. Lowered to N=2^14 (16 MB, under
the limit, ~50–100 ms). A happy-path smoke test would not have found this; the
tests did.

---

## Why secrets are encrypted at rest

A TOTP secret is a **bearer credential for the second factor**. Anyone who reads
it can generate valid codes forever. So a plaintext `mfaSecret` column is not MFA
with a weakness — it is MFA with the second factor removed, while still appearing
enabled.

AES-256-GCM (authenticated — tampering is detected, not silently decrypted), key
derived from `FGMP_MFA_ENCRYPTION_KEY` via scrypt, fresh IV per encryption,
stored as `v1.<iv>.<tag>.<ciphertext>`.

**The key lives outside the database.** Encryption without that provides no
protection against the threat it exists for — a database dump. MFA cannot be
enabled without it, which is how "never let a half-configured MFA lock anyone
out" is expressed in code rather than in a runbook.

---

## Why the second factor is a separate request

NextAuth's Credentials `authorize()` returns a user or `null` — no multi-step
return. So the challenge is a separate endpoint pair:

1. `POST /api/auth/mfa/challenge` — password verified, returns a challenge
   token, **issues no session**.
2. `POST /api/auth/mfa/verify` — challenge token + code → session.

The challenge token is the entire security boundary between the halves, so it is
treated as a credential: 128 bits of CSPRNG entropy, stored **hashed**,
single-use and consumed atomically, **5-minute** TTL, bound to the userId AND
tenantId, and invalidated by a failed attempt so guessing is bounded to one try.

A self-contained (JWT) challenge would be neither revocable nor single-use, and
both matter: revocation on password change is a real requirement, and single-use
is what stops an intercepted token being replayed after the legitimate login.

---

## For an operator on a live deployment today

1. **Set the encryption key first**, or do not enable MFA at all:
   ```bash
   openssl rand -hex 32        # -> FGMP_MFA_ENCRYPTION_KEY
   ```
   Changing it after enrolment makes every stored secret undecryptable. Recovery
   is re-enrolment through a second authorised operator — **never** a direct
   database write, because a row that can be rewritten by anyone with DB access is
   not a second factor.

2. **Enrol SUPERADMIN first.** Record the backup codes on paper and put them in
   the site safe. Ten codes.

3. **Then NOC_OPERATOR**, the same way.

4. **If you are locked out:** use a backup code. If those are gone, a second
   authorised operator approves a break-glass reset through the two-person flow,
   which writes an audit record naming both people. There is no third path, and
   there should not be.

5. **Keep NOC_OPERATOR and ADMIN sessions bounded** — they are 8h absolute,
   1h refresh — which is the interim control if MFA is not yet enabled.

---

## Status: what is now wired

**Wired and verified (part 2, `46b8c54`):**

| Piece | Where | State |
|---|---|---|
Persistence + FORCE RLS | `20261011000000_mfa_persistence` | 4 tables, `rls=true force=true` |
TOTP / base32 / encryption | `src/lib/fgmp/mfa/` | 37 tests, RFC vectors |
Pending challenge | `mfa/service.ts` | atomic, hashed, 5 min |
Backup codes | own rows | hashed, atomic single-use |
Enforcement guard | `mfa/guard.ts` | allowlist, mutation-tested, **called from `requireAuth`** |
Routes | `src/app/api/fgmp/mfa/**` | enrol, verify-enrol, challenge, disable, reset |
RLS fixtures | `scripts/verify/rls-regression.ts` | 39/39 tables covered |

**Still NOT wired — and each item is deliberate:**

1. **UI.** Enrolment, challenge and recovery screens are not built
   (`src/components/**` is another agent's scope). No component submits
   `mfaProof`. The consequence is worth stating plainly, because it is now
   sharper than it was: a pending session is refused by `requireAuth` on every
   route except `/api/fgmp/mfa/*` and `/api/auth/*`, so an enrolled user whose
   client has no challenge screen can complete the login **only** through the
   API sequence below. That is the correct security answer — a half-authenticated
   session should reach nothing — but it means MFA must not be switched on for a
   tenant until the screen exists.

   ```
   POST /api/fgmp/mfa/challenge-request          → { challengeToken }
   POST /api/fgmp/mfa/challenge                  → { verified: true }   (code / backup code)
   signIn("credentials", { …, mfaProof: challengeToken })                (mints the session)
   ```

2. **No production caller of `isPublicPath()`.** The pending-session decision is
   wired; the "is this path public at all" helper is still only used by tests,
   because Next has no middleware in this app (Next 16.1) and every route
   authenticates itself.

**Corrected here (previously listed as gaps, no longer true):**

- `authorize()` **does** set `mfaPending` for an enrolled user
  (`src/lib/auth.ts`, the `hasMfaEnabled` branch), and it deliberately returns
  the user with **no `role` and no `tenantId`**.
- `GET /api/fgmp/mfa/status` **exists** (`src/app/api/fgmp/mfa/status/route.ts`)
  and is reachable while pending, so a client can discover enrolment state
  without a full session.
- The guard is wired. `requireAuth` evaluates `evaluatePendingSession(pathname)`
  **before** `canAccessApi`, so the decision is about the path, not a side effect
  of the missing role. Before that call site existed, `AUTH_ONLY_API_RULES`
  routes (`GET /api/fgmp/me`, `/api/fgmp/preferences`, `/api/fgmp/proposal`) were
  readable by a half-authenticated session; `rbac-server-conformance.test.ts`
  now asserts the call site itself.

## Status: ENFORCED

**MFA is enforced at login as of the login-flow commit.** `authorize()` returns a
PENDING session for an enrolled user, the guard refuses every protected route, and
completing the challenge issues a new, fully authoritative session.

The test that proves it: `src/lib/fgmp/mfa/mfa-login-flow.test.ts`
(13 tests / 42 assertions, mutation-confirmed).

### The three traps, and how each is closed

**1. A pending session must carry no capabilities.** If `mfaPending` were set
while `role` stayed `ADMIN`, every capability check running BEFORE the guard
would pass — the exact "protects the dashboard but not the control endpoint"
failure the allowlist exists to prevent.

So `authorize()` returns the user with **no `role` and no `tenantId` at all** —
absent keys, not empty strings or a sentinel like `"PENDING"`. An absent key is
falsy, so the ~80 existing `user.role === X` checks already deny it without
auditing any of them. Defence in depth: the guard refuses by path, and a pending
session also has nothing to be authorised WITH.

**2. A pending session could otherwise escalate via `useSession().update()`.**
The jwt callback's `trigger === "update"` branch re-reads role from the database
— which would hand straight back exactly what the login deliberately withheld,
to any client that calls `update()`.

The pending state is therefore **sticky**: that branch returns early for a
pending token and never reads role/tenant back. Only re-authentication after a
successful challenge (which mints a NEW session) clears the flag. Verified by
mutation: removing this guard fails the suite.

**3. It must be observable.** The session callback exposes `mfaPending` so the
login UI can prompt. A flag nobody can read from the client means the operator
sees a successful login and no prompt — which is the worst outcome, because it
looks like it worked.

### Still not built

- **UI.** Enrolment, challenge and recovery screens (`src/components/**` is
  another agent's scope). The API is complete and the session flag is exposed,
  so the client work is mechanical.
- **`GET /api/fgmp/mfa/status`** so the UI can read current enrolment state and
  backup-code count without guessing.

Neither blocks enforcement: an operator cannot be silently unprotected, because
`enabled` only becomes true after `verify-enrol` succeeds.

### Verified

| Claim | Evidence |
|---|---|
TOTP correctness | 6 RFC 6238 Appendix B vectors, fetched from the RFC |
Pending carries no capability | `mfa-login-flow.test.ts`, mutation-confirmed |
Cannot escalate via `update()` | mutation-confirmed |
Pending refuses every protected route | route-file enumeration, >20 asserted |
Loop closes (pending → completed) | both directions asserted |
Off costs nothing | non-enrolled user never blocked on any route |
RLS on all 4 MFA tables | `rls=true force=true`, 39/39 tables covered |
