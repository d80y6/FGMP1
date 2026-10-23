import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getClientIp, rateLimitByUser, READ_LIMIT } from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { createSupportNote, getTenantMeta, tenantSummary } from "@/lib/fgmp/platform-store";
import {
  assertSupportTenant,
  assertSupportWritable,
} from "@/lib/fgmp/support-session";
import {
  currentSupport,
  noSupportSession,
  requireSuperAdmin,
  supportErrorResponse,
} from "@/lib/fgmp/support-request";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/platform/support/[tenant]/summary
 *
 * The demonstration — and the only shape — of cross-tenant READ in this
 * codebase: a super-admin with an OPEN support session for `tenant` reads that
 * tenant's data through `withTenant(session.tenantId)`, i.e. with
 * `SET LOCAL app.tenant_id` and RLS still applied. The role on the connection
 * is `fgmp_app`; nothing bypasses a policy.
 *
 * Two refusals, in this order:
 *   1. no active session           → 403 NO_SUPPORT_SESSION
 *   2. session for a different tenant → 403 SUPPORT_TENANT_MISMATCH
 *
 * The tenant id in the URL is therefore not a scope the caller supplies — it is
 * a claim the session must already agree with. That distinction is the whole
 * design: the id in the path cannot widen anything, it can only fail to match.
 *
 * The body contains counts and the most recent alarms, not a data dump. Support
 * work needs orientation first ("is this tenant healthy, what is alarming, who
 * is on shift"); row-level access to a specific entity belongs on the tenant's
 * own routes, which is a separate decision with a separate review.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ tenant: string }> }) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  const { tenant } = await ctx.params;

  const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
  if (!rl.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await currentSupport(me);
  if (!session) return noSupportSession();

  try {
    assertSupportTenant(session, tenant);
  } catch (err) {
    return supportErrorResponse(err) ?? errorResponse(err);
  }

  try {
    // The tenant row itself is outside RLS (it has no tenantId column), so this
    // read is platform metadata, not customer data.
    const tenantRow = await getTenantMeta(tenant);
    if (!tenantRow) {
      return NextResponse.json({ error: "No such tenant" }, { status: 404 });
    }

    const stats = await tenantSummary(tenant);

    return NextResponse.json({
      // Echoed so the operator's banner and the data on screen cannot disagree
      // about which tenant is being viewed.
      supportSession: {
        id: session.id,
        mode: session.mode,
        reason: session.reason,
        ticketRef: session.ticketRef,
        expiresAt: session.expiresAt,
      },
      tenant: tenantRow,
      counts: {
        users: stats.users,
        sites: stats.sites,
        tanks: stats.tanks,
        generators: stats.generators,
        openAlarms: stats.openAlarms,
        openTickets: stats.tickets,
        deliveries: stats.deliveries,
      },
      recentAlarms: stats.recentAlarms,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const noteSchema = z.object({
  note: z.string().min(3).max(1000),
});

/**
 * POST /api/fgmp/platform/support/[tenant]/summary
 *
 * Append a support note to the TENANT's audit log. This is the only write the
 * support surface offers in this phase, and it is chosen because it is
 * non-destructive: it changes no business state, it is what an engineer needs
 * to leave behind ("cleared the stuck command at 14:03"), and it lands where the
 * customer can see it.
 *
 * Requires `mode: "WRITE"`. A read-only session gets 403 SUPPORT_READ_ONLY —
 * read-only is the default and write access is a separate, ticketed grant.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ tenant: string }> }) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  const { tenant } = await ctx.params;

  const session = await currentSupport(me);
  if (!session) return noSupportSession();

  try {
    assertSupportTenant(session, tenant);
    assertSupportWritable(session);
  } catch (err) {
    return supportErrorResponse(err) ?? errorResponse(err);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = noteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    const row = await createSupportNote({
      tenantId: tenant,
      supportSessionId: session.id,
      actorUserId: me.id,
      actorEmail: me.email ?? null,
      ticketRef: session.ticketRef,
      note: parsed.data.note,
      ip: getClientIp(req),
    });
    return NextResponse.json({ ok: true, auditLogId: row.id, createdAt: row.createdAt }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
