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

- SUPERADMIN can read **every tenant's** data. It is the highest-blast-radius
  credential in the system, and it spans tenants, so it is the one whose
  compromise is worst.
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
Enforcement guard | `mfa/guard.ts` | allowlist, mutation-tested |
Routes | `src/app/api/fgmp/mfa/**` | enrol, verify-enrol, challenge, disable, reset |
RLS fixtures | `scripts/rls-regression.ts` | 39/39 tables covered |

**Still NOT wired — and each item is deliberate:**

1. **The `mfaPending` marker is declared but not yet set by `authorize()`.**
   `src/lib/auth.ts` carries the flag on `JWT` and `Session`, and the guard
   consumes it, but the credentials callback does not yet set it when an enrolled
   user signs in. Until that line exists, MFA enrolment works but is not
   *enforced at login*.

   This is the one remaining gap between "MFA exists" and "MFA is on", and it is a
   two-line change in a file (`src/lib/auth.ts`) that is explicitly outside the
   MFA write scope because another agent owns it. **It must not be reported as
   done until that line exists and the login flow is tested end to end.**

2. **UI.** Enrolment, challenge and recovery screens are not built
   (`src/components/**` is another agent's scope).

3. **Status route.** No `GET /api/fgmp/mfa/status` for the UI to read enrolment
   state; the routes exist but nothing lists whether MFA is on.

## The honest one-line status

**MFA is implemented and verified but NOT YET ENFORCED.** The primitives, the
persistence, the guard and the routes are real and tested; the single line that
sets `mfaPending` during login is missing, so an operator with MFA enrolled is
not yet asked for a code. Do not treat this as a shipped security control.
