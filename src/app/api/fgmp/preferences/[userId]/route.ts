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
import { requireRole, ROLES, assertTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

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
 * GET /api/fgmp/preferences/[userId]
 * Fetch ANY user's notification preferences. ADMIN-only — used by the
 * user-management UI so an admin can audit / adjust an operator's settings
 * (e.g. re-enable email for a field engineer who accidentally disabled it).
 *
 * If the target user has no row yet, upserts one with the defaults (same
 * behaviour as the self-service GET route).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ userId: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { userId } = await ctx.params;

    // ── IDOR: the `:userId` path parameter is attacker-controlled ───────────
    // Scoped in the QUERY, not filtered afterwards. `assertTenantOwned` compares
    // `record.tenantId` after the row is fetched, which under FORCE RLS never
    // happens — the fetch returns null and every lookup 404s. That made the
    // check inert rather than merely weak, so the scoping has to live in the
    // `where` clause for the check to function at all.
    //
    // The tenant comes from the AUTHENTICATED SESSION, never from the path, so
    // an admin cannot read another tenant's preferences by editing the URL.
    const { target, pref } = await asTenant(user, async (tx) => {
      const found = await tx.user.findFirst({
        where: { id: userId, tenantId: user.tenantId },
        select: { id: true, tenantId: true, name: true, email: true, role: true },
      });
      // Cross-tenant targets are indistinguishable from non-existent ones: both
      // yield 404, so this cannot be used to probe for valid user ids.
      if (!found) return { target: null, pref: null };

      // Kept as defence in depth. The query already scopes by tenantId; this
      // guarantees a future change to the where clause cannot become a read
      // of another tenant's preferences.
      const denied = assertTenantOwned(found, user);
      if (denied) return { target: null, pref: null };

      const prefs = await tx.notificationPreference.upsert({
        where: { userId: found.id },
        update: {},
        create: { userId: found.id, tenantId: found.tenantId, ...DEFAULT_PREFS },
      });
      return { target: found, pref: prefs };
    });

    if (!target || !pref) {
      const res = NextResponse.json({ error: "User not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Return the prefs alongside the target user's profile so the admin UI
    // can render "Editing preferences for: <name> (<email>)" without a
    // second round-trip.
    const res = NextResponse.json({ ...pref, user: target });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PUT /api/fgmp/preferences/[userId]
 * Update ANY user's notification preferences. ADMIN-only.
 *
 * Body is validated against notificationPreferenceSchema. userId is taken
 * from the URL (NOT the body) so a client cannot overwrite another user's
 * prefs by passing a different id in the JSON payload.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ userId: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { userId } = await ctx.params;

    // Same IDOR guard as GET: scope the lookup by the CALLER's tenant in the
    // query, so a cross-tenant userId is invisible rather than filtered out
    // after the fact. Writing another operator's notification preferences is a
    // privilege escalation, so this must not depend on a post-fetch check.
    const target = await asTenant(user, async (tx) => {
      const found = await tx.user.findFirst({
        where: { id: userId, tenantId: user.tenantId },
        select: { id: true, tenantId: true, name: true, email: true, role: true },
      });
      if (!found) return null;
      return assertTenantOwned(found, user) ? null : found;
    });
    if (!target) {
      const res = NextResponse.json({ error: "User not found" }, { status: 404 });
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

    const emailOverride = data.emailOverride?.trim() ? data.emailOverride.trim() : null;
    const phoneOverride = data.phoneOverride?.trim() ? data.phoneOverride.trim() : null;

    if ((data.quietHoursStart === null) !== (data.quietHoursEnd === null)) {
      const res = NextResponse.json(
        { error: "quietHoursStart and quietHoursEnd must both be set or both be null" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const updated = await asTenant(user, (tx) =>
      tx.notificationPreference.upsert({
      where: { userId: target.id },
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
        userId: target.id,
        tenantId: target.tenantId,
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
      action: "PREFERENCES_ADMIN_UPDATE",
      entity: "NotificationPreference",
      entityId: updated.id,
      details: {
        targetUserId: target.id,
        targetEmail: target.email,
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

    const res = NextResponse.json({ ...updated, user: target });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
