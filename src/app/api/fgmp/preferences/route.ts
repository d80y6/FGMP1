import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import { notificationPreferenceSchema, validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * Default preferences — mirrored from the Prisma model defaults. Returned by
 * GET when no row exists yet for the current user (and used as the create
 * payload in the upsert so the first GET auto-creates the row).
 */
const DEFAULT_PREFS = {
  inAppEnabled: true,
  emailEnabled: false,
  smsEnabled: false,
  inAppSeverities: "L1,L2,L3",
  emailSeverities: "L2,L3",
  smsSeverities: "L3",
  quietHoursStart: null as number | null,
  quietHoursEnd: null as number | null,
  emailOverride: null as string | null,
  phoneOverride: null as string | null,
};

/**
 * GET /api/fgmp/preferences
 * Returns the current user's notification preferences. Any authenticated
 * user may fetch their own prefs. If no row exists yet (first visit), the
 * endpoint upserts one with the Prisma defaults so subsequent GETs return
 * the persisted record.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    let pref;
    try {
      pref = await asTenant(user, (tx) =>
        tx.notificationPreference.upsert({
          where: { userId: user.id },
          update: {},
          create: { userId: user.id, tenantId: tenantIdOrThrow(user.tenantId), ...DEFAULT_PREFS },
        }),
      );
    } catch (upsertErr) {
      // P2003 = foreign key constraint violation — the session user.id doesn't
      // exist in the User table (e.g. a stale session after user deletion, or
      // a user that was never seeded). Rather than 409, degrade gracefully by
      // returning the default preferences so the UI remains usable. The PUT
      // handler will still reject writes in this state.
      if ((upsertErr as { code?: string })?.code === "P2003") {
        const res = NextResponse.json({
          id: null,
          userId: user.id,
          ...DEFAULT_PREFS,
          updatedAt: new Date().toISOString(),
        });
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
      throw upsertErr;
    }

    const res = NextResponse.json(pref);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PUT /api/fgmp/preferences
 * Update the current user's notification preferences. Any authenticated
 * user may edit their own prefs (userId is stamped from the session, not
 * from the body, so a client cannot impersonate another user).
 *
 * The body is validated against notificationPreferenceSchema. After update
 * the audit log records the diff for traceability (NOC ops teams need to
 * know who silenced L2 alarms and when).
 */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const r = validateBody(notificationPreferenceSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    // Normalize empty strings to null so the UI's "clear override" path
    // produces a clean DB state rather than storing "".
    const emailOverride = data.emailOverride?.trim() ? data.emailOverride.trim() : null;
    const phoneOverride = data.phoneOverride?.trim() ? data.phoneOverride.trim() : null;

    // Server-side guard: if only one of quietHoursStart/quietHoursEnd is
    // set, the window is half-defined. Reject rather than silently coerce —
    // the UI toggles both together so this should never trip in practice,
    // but it's a cheap integrity check.
    if (
      (data.quietHoursStart === null) !== (data.quietHoursEnd === null)
    ) {
      const res = NextResponse.json(
        { error: "quietHoursStart and quietHoursEnd must both be set or both be null" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const updated = await asTenant(user, (tx) => tx.notificationPreference.upsert({
      where: { userId: user.id },
      update: {
        inAppEnabled: data.inAppEnabled,
        emailEnabled: data.emailEnabled,
        smsEnabled: data.smsEnabled,
        inAppSeverities: data.inAppSeverities,
        emailSeverities: data.emailSeverities,
        smsSeverities: data.smsSeverities,
        quietHoursStart: data.quietHoursStart,
        quietHoursEnd: data.quietHoursEnd,
        emailOverride,
        phoneOverride,
      },
      create: {
        userId: user.id,
        tenantId: tenantIdOrThrow(user.tenantId),
        inAppEnabled: data.inAppEnabled,
        emailEnabled: data.emailEnabled,
        smsEnabled: data.smsEnabled,
        inAppSeverities: data.inAppSeverities,
        emailSeverities: data.emailSeverities,
        smsSeverities: data.smsSeverities,
        quietHoursStart: data.quietHoursStart,
        quietHoursEnd: data.quietHoursEnd,
        emailOverride,
        phoneOverride,
        },
      }),
    );

    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "PREFERENCES_UPDATE",
      entity: "NotificationPreference",
      entityId: updated.id,
      details: {
        inAppEnabled: data.inAppEnabled,
        emailEnabled: data.emailEnabled,
        smsEnabled: data.smsEnabled,
        inAppSeverities: data.inAppSeverities,
        emailSeverities: data.emailSeverities,
        smsSeverities: data.smsSeverities,
        quietHoursStart: data.quietHoursStart,
        quietHoursEnd: data.quietHoursEnd,
        emailOverride,
        phoneOverride,
      },
    });

    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
