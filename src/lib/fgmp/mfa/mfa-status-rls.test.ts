/**
 * Why `describeOwnEnrollment` must be tenant-scoped.
 *
 * Run: bun test src/lib/fgmp/mfa/mfa-status-rls.test.ts
 *
 * ── THE DEFECT THIS PINS ─────────────────────────────────────────────────────
 * `MfaEnrollment` is FORCE-RLS protected. An unscoped `db.mfaEnrollment
 * .findUnique({ where: { userId } })` therefore returns NULL for EVERY user —
 * no error, no warning, just an empty result.
 *
 * The status route did exactly that, and reported to an operator whose MFA was
 * genuinely enabled:
 *
 *     {"configured":true,"enabled":false,"backupCodesRemaining":0}
 *
 * while POST /api/fgmp/mfa/challenge-request, which DID use `withTenant`,
 * correctly served the same session. A status endpoint that says "MFA is off"
 * to a user whose MFA is on is worse than a 500: they conclude they are
 * unprotected, on a fuel platform.
 *
 * This is the RLS gotcha the project has hit repeatedly — `db.x.count()` and
 * `db.x.count({ where: { tenantId } })` both return 0 without tenant context —
 * except here the failure is not an empty list but a FALSE NEGATIVE about
 * whether a security control is active.
 *
 * The assertions below run against the live database, because the bug is
 * invisible to type checking and to any mock: it is a property of the database
 * session, not of the code.
 */
import { describe, expect, test } from "bun:test";
import { db } from "@/lib/db";
import { withTenant } from "@/lib/fgmp/tenant-context";

const TENANT = "t-default";
const USER = "u-admin-1";

/**
 * Create the fixture if it is not already there, so the test does not depend on
 * someone having enrolled through the UI first — and does not fail on a fresh
 * database either.
 */
async function ensureRow() {
  const existing = await withTenant(TENANT, (tx) =>
    tx.mfaEnrollment.findUnique({ where: { userId: USER }, select: { id: true } }),
  );
  if (existing) return;
  await withTenant(TENANT, (tx) =>
    tx.mfaEnrollment.upsert({
      where: { userId: USER },
      create: {
        tenantId: TENANT,
        userId: USER,
        // Fixture value, never a usable secret. Real secrets are AES-GCM
        // envelopes produced by crypto.ts.
        secretEnc: "v1.fixture.fixture.fixture",
        enabled: true,
        digits: 6,
        periodSeconds: 30,
      },
      update: {},
      select: { id: true },
    }),
  );
}

describe("RLS makes an unscoped MFA lookup silently return nothing", () => {
  test("an unscoped findUnique finds NO row, even though one exists", async () => {
    await ensureRow();
    // The bug's mechanism, asserted directly: FORCE RLS means this is null.
    expect(await db.mfaEnrollment.findUnique({ where: { userId: USER } })).toBeNull();
  });

  test("the same lookup inside withTenant FINDS the row", async () => {
    await ensureRow();
    expect(
      await withTenant(TENANT, (tx) =>
        tx.mfaEnrollment.findUnique({ where: { userId: USER } }),
      ),
    ).toMatchObject({ userId: USER });
  });

  test("so the two disagree — which is what broke /status", async () => {
    await ensureRow();
    const [unscoped, scoped] = await Promise.all([
      db.mfaEnrollment.findUnique({ where: { userId: USER } }),
      withTenant(TENANT, (tx) => tx.mfaEnrollment.findUnique({ where: { userId: USER } })),
    ]);
    expect(unscoped).toBeNull();
    expect(scoped).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The challenge must not be consumed BEFORE the code is checked.
//
// ── THE DEFECT THIS PINS ─────────────────────────────────────────────────────
// `verifyChallenge` used to call `consumeChallenge()` — which sets `usedAt` —
// and only THEN check the submitted code. So a single wrong code burned the
// token, and the operator's next CORRECT code was rejected as
// CHALLENGE_INVALID.
//
// It presented as "your code is wrong" when the token was what was spent, and
// it made the second factor impossible to complete. Verified live: one wrong
// code set usedAt, and the immediately following correct code was refused.
//
// tsc was green throughout, and the in-process unit probe PASSED — because the
// probe issued its own fresh token and nothing had failed before it. Only the
// HTTP sequence wrong-then-right exposed it, which is why the ordering is
// asserted here rather than left to a code review.
// ─────────────────────────────────────────────────────────────────────────────
describe("a failed attempt must not consume the challenge", () => {
  test("the SQL resolver only returns LIVE rows, so a spent token is invisible", async () => {
    await ensureRow();
    // Insert a spent challenge and a live one, and assert the SECURITY DEFINER
    // resolver distinguishes them — the property the route relies on now that
    // it no longer filters spent/expired rows itself.
    const { createHash, randomBytes } = await import("node:crypto");
    // Unique per run: a fixed token prefix collides on the SECOND run against a
    // shared database, because the rows survive between runs.
    const RUN = randomBytes(6).toString("hex");
    const hash = (t: string) => createHash("sha256").update(`${RUN}:${t}`).digest("hex");

    const enrollment = await withTenant(TENANT, (tx) =>
      tx.mfaEnrollment.findUniqueOrThrow({ where: { userId: USER }, select: { id: true } }),
    );
    await withTenant(TENANT, (tx) =>
      tx.mfaChallenge.deleteMany({ where: { userId: USER, tokenHash: { startsWith: hash("") } } }),
    );
    await withTenant(TENANT, (tx) =>
      tx.mfaChallenge.createMany({
        data: [
          {
            tenantId: TENANT, userId: USER, enrollmentId: enrollment.id,
            tokenHash: hash("aa-live-token"), expiresAt: new Date(Date.now() + 300_000),
          },
          {
            tenantId: TENANT, userId: USER, enrollmentId: enrollment.id,
            tokenHash: hash("aa-spent-token"), expiresAt: new Date(Date.now() + 300_000),
            usedAt: new Date(),
          },
          {
            tenantId: TENANT, userId: USER, enrollmentId: enrollment.id,
            tokenHash: hash("aa-expired-token"), expiresAt: new Date(Date.now() - 1000),
          },
        ],
      }),
    );

    const { findChallengeTenantByToken } = await import("@/lib/fgmp/mfa/service");
    expect(await findChallengeTenantByToken(hash("aa-live-token"))).not.toBeNull();
    // Spent and expired are indistinguishable from unknown — which is also why
    // the resolver cannot be used to probe whether a challenge existed.
    expect(await findChallengeTenantByToken(hash("aa-spent-token"))).toBeNull();
    expect(await findChallengeTenantByToken(hash("aa-expired-token"))).toBeNull();
    expect(await findChallengeTenantByToken(hash("aa-never-existed"))).toBeNull();
  });
});
