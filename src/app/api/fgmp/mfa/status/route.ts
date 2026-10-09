import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/fgmp/auth-helpers";
import { errorResponse } from "@/lib/fgmp/api-error";
import { mfaEncryptionConfigured, mfaEncryptionProblem } from "@/lib/fgmp/mfa/crypto";
import { describeOwnEnrollment } from "@/lib/fgmp/mfa/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/mfa/status — a user's own MFA enrolment state.
 *
 * ── WHY THIS IS NOT COSMETIC ────────────────────────────────────────────────
 * The login UI cannot render "MFA enabled — 3 backup codes remaining" without it,
 * and an operator who has burned through their backup codes has no other way to
 * find out before they need one. At 03:00 with a theft alarm, discovering this
 * during a lockout is the failure the whole recovery design exists to prevent.
 *
 * ── REACHABLE WHILE `mfaPending` ────────────────────────────────────────────
 * This route MUST stay reachable during a pending challenge. A user who has just
 * been asked for a code is exactly the user who needs to see that MFA is enabled
 * and that backup codes exist. It is already inside the guard's `/api/fgmp/mfa/`
 * allowlist prefix, so that is preserved deliberately.
 *
 * ── NEVER RETURNS THE CODES, OR THE SECRET ─────────────────────────────────
 * Backup codes are reported as a COUNT and the TOTP secret is never included.
 * Both are hashed or encrypted at rest and neither is recoverable, which is the
 * property that makes them safe; a status endpoint must not undo it.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const configured = mfaEncryptionConfigured();

    // Not configured: the UI must be able to say "MFA is unavailable on this
    // deployment" rather than offering enrolment that will fail at /enrol.
    // Returned as 200 with `configured: false` rather than an error, because the
    // page still has to render something useful.
    if (!configured || !auth.user.tenantId) {
      return NextResponse.json({
        configured,
        enabled: false,
        enrolled: false,
        enrolledAt: null,
        lastUsedAt: null,
        disabledAt: null,
        disabledReason: null,
        backupCodesRemaining: 0,
        backupCodeCount: 0,
        ...(configured ? {} : { problem: mfaEncryptionProblem() }),
      });
    }

    // The service owns the lookup, because a PENDING session has no tenant and
    // therefore cannot open a tenant-scoped transaction at all. It is keyed on
    // the caller's own userId and returns only their own row, so it grants
    // nothing: a tenant-less session learns only its own enrolment state, which
    // is exactly what it is being asked about.
    const { enrollment, backupCodesRemaining } = await describeOwnEnrollment(
      auth.user.id,
      auth.user.tenantId,
    );

    return NextResponse.json({
      configured: true,
      // `enabled` is the claim that matters: enrolment was VERIFIED, so a second
      // factor is genuinely required. `enrolled` alone would be true for an
      // enrolment that was started and abandoned.
      enabled: enrollment?.enabled === true,
      enrolled: enrollment !== null,
      enrolledAt: enrollment?.enrolledAt ?? null,
      lastUsedAt: enrollment?.lastUsedAt ?? null,
      disabledAt: enrollment?.disabledAt ?? null,
      disabledReason: enrollment?.disabledReason ?? null,
      digits: enrollment?.digits ?? 6,
      periodSeconds: enrollment?.periodSeconds ?? 30,
      // COUNT only. The codes themselves are shown once at enrolment and are
      // stored hashed, so they cannot be re-displayed.
      backupCodesRemaining,
      // Advisory: so the UI can prompt BEFORE the operator is out of codes.
      lowBackupCodes: backupCodesRemaining > 0 && backupCodesRemaining <= 3,
      // True when MFA is on and every backup code is spent — the operator is one
      // lost authenticator from needing a two-person break-glass reset.
      noRecoveryCodes: backupCodesRemaining === 0,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
