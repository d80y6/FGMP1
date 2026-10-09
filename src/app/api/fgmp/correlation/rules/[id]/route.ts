import { NextRequest, NextResponse } from "next/server";
import { updateCorrelationRuleSchema } from "@/lib/fgmp/schemas/correlation";
import { validateBody } from "@/lib/fgmp/schemas";
import { updateRule, deleteRule } from "@/lib/fgmp/correlation/service";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";

export const dynamic = "force-dynamic";

/**
 * PATCH  /api/fgmp/correlation/rules/[id] — edit a rule.
 * DELETE /api/fgmp/correlation/rules/[id] — remove it.
 *
 * ── CROSS-TENANT SAFETY ON `id` ─────────────────────────────────────────────
 * The ruleId comes from the URL and is therefore attacker-controlled. The
 * service passes it to Prisma inside `withTenant(tenantIdOrThrow(me.tenantId), …)`, so RLS makes
 * another tenant's row unreachable and Prisma raises P2025 rather than
 * mutating it. That is defence in depth, not the primary guard — the primary
 * guard is that the query runs under this tenant's RLS context.
 *
 * A not-found from Prisma is therefore translated to 404, not 403: the caller
 * has no business learning that the id exists under some other tenant.
 */

/** Prisma's "record not found", which RLS can also produce by hiding a row. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2025"
  );
}

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;

  const guard = await requireRole(req, ROLES.ALARM_OPS);
  if ("error" in guard) return guard.error;

  try {
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id } = await ctx.params;
    const raw = await req.json();
    const v = validateBody(updateCorrelationRuleSchema, raw);
    if (!v.success) {
      const res = NextResponse.json({ error: v.error }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    let rule: unknown;
    try {
      rule = await updateRule(tenantIdOrThrow(me.tenantId), id, v.data);
    } catch (err) {
      if (isNotFound(err)) {
        return NextResponse.json({ error: "Rule not found" }, { status: 404 });
      }
      throw err;
    }

    await audit({
      userId: me.id,
      tenantId: tenantIdOrThrow(me.tenantId),
      action: "correlation.rule.update",
      entity: "CorrelationRule",
      entityId: id,
      details: { fields: Object.keys(v.data) },
    });

    const res = NextResponse.json(rule);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;

  const guard = await requireRole(req, ROLES.ALARM_OPS);
  if ("error" in guard) return guard.error;

  try {
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id } = await ctx.params;
    try {
      await deleteRule(tenantIdOrThrow(me.tenantId), id);
    } catch (err) {
      if (isNotFound(err)) {
        return NextResponse.json({ error: "Rule not found" }, { status: 404 });
      }
      throw err;
    }

    await audit({
      userId: me.id,
      tenantId: tenantIdOrThrow(me.tenantId),
      action: "correlation.rule.delete",
      entity: "CorrelationRule",
      entityId: id,
    });

    const res = NextResponse.json({ ok: true });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
