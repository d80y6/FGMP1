# MFA assessment — what it would actually take, and why it is not implemented

Phase 5 task 4 asked for an assessment rather than an implementation, with an
explicit warning: *do not invent a half-working TOTP implementation*.

That warning is correct, and this document explains why the same principle that
governs every other Phase 5 task applies here. **A broken MFA control is worse
than no MFA control**, because it produces the exact condition its users cannot
distinguish from a locked-out platform: a fuel-theft alarm that nobody is
authorised to act on.

---

## What exists today

| Control | State |
|---|---|
Per-account lockout after N failures | **Present** — `lockedUntil` in `src/lib/auth.ts` |
Timing-equalising `DUMMY_HASH` | **Present** — `auth.ts:47`, so an unknown email costs the same time as a known one |
Login rate limit | **Present** — fails CLOSED when the shared store is unreachable |
Session lifetime | **Added this phase** — 8h absolute, 1h refresh, validated at boot |

The first three are genuinely good work and were kept untouched.

---

## What MFA would require

Not a feature list — the parts that are *load-bearing* and easy to get wrong.

### 1. Persistence (a migration I do not own)

No MFA fields exist on `User` today. Required:

- `mfaEnabled` (Boolean)
- `mfaSecretEncrypted` — **encrypted at rest**, not merely stored
- `mfaRecoveryCodesHash` — one hash per code
- `mfaEnrolledAt`, `mfaLastVerifiedAt`

The secret must be encrypted with a key held outside the database. A plaintext
TOTP secret in a table is a bearer credential for the second factor: anyone with
a read-only database dump bypasses MFA entirely, which is the scenario MFA exists
to blunt. There is no envelope-encryption utility in this codebase yet; that is
itself a piece of work.

### 2. Enrolment flow with a verification step

Enrolment must not be complete until the user proves they can generate a valid
code. A QR code shown and immediately marked `mfaEnabled = true` is enrolable by
an attacker who briefly controls the session.

### 3. Login challenge

NextAuth's Credentials `authorize()` returns a user or null — there is no
multi-step return. Implementing a challenge means either forking `authorize()`'s
control flow or introducing a short-lived, single-use, server-side "pending
challenge" record keyed to the login attempt. That second option is real
security design: the pending record must be unguessable, expire in minutes,
be single-use, and be invalidated on any subsequent attempt.

### 4. Recovery, or MFA is an outage generator

This is the part that decides the whole question.

An operator who loses their authenticator is locked out. In a fuel platform that
means a fuel-theft alarm at 03:00 cannot be acknowledged by the person who is
accountable for it. Recovery therefore **cannot** be "email the owner a link" —
the platform's threat model has not been written down and a compromised mailbox
is a normal compromise.

So recovery needs, at minimum, single-use backup codes shown once at enrolment,
stored hashed, with a real UI to regenerate them. If that is not built, MFA turns
every lost phone into an outage requiring manual database access.

### 5. A UI the operator can use under pressure

There is no MFA prompt component today. Building one is not the hard part; the
hard part is that it must be correct on first use, at 03:00, on a tablet, with a
countdown that does not silently log the user out mid-entry.

---

## Honest assessment

Roughly **3–5 days** of focused work, most of it in schema I do not own and
secret-management infrastructure that does not exist yet.

That is not the reason to defer it. The reasons are:

1. **I do not own `prisma/**`.** Steps 1 and the encryption work require schema
   changes that would need coordination with whoever does.
2. **A partial MFA is worse than none.** Enrolment without recovery, or a
   challenge without single-use pending records, converts a security control into
   an availability incident on a safety-relevant platform.
3. **It cannot be honestly verified here.** A TOTP implementation tested only
   against my own implementation proves nothing — the same lesson as the Modbus
   CRC, where the first thing the tests caught was a wrong known-answer vector.
   Real verification needs a second authenticator implementation and a
   time-skew test suite.

---

## Recommendation

**Ship it as a deliberate project, not as a task.** Concretely:

- **Enforce MFA for `SUPERADMIN` first.** It is the role that spans tenants and
  can provision other operators; it is the highest-value target and the smallest
  population, so the blast radius of a mistake is contained. Make it
  **mandatory** there — optional MFA is skipped by exactly the people who need
  it.
- **Then `NOC_OPERATOR`** — the role that can remote-start a generator.
- Defer `ADMIN` and below until the flow has run in production without incident.
- Build recovery before enrolment. Always.

---

## Interim mitigations already in place

None of these substitute for MFA, and none should be described as if they did:

- Sessions are now bounded (8h absolute), so a stolen token expires.
- Login rate limiting fails **closed**.
- The per-account lockout is database-backed and survives restarts.
- `DUMMY_HASH` removes the user-enumeration timing channel.
- Generator control is separately role-gated (`ROLES.CONTROL` = ADMIN +
  NOC_OPERATOR) and passes through safety interlocks.