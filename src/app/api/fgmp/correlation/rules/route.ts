import { NextRequest, NextResponse } from "next/server";
import { createCorrelationRuleSchema } from "@/lib/fgmp/schemas/correlation";
import { validateBody } from "@/lib/fgmp/schemas";
import { createRule, listRules } from "@/lib/fgmp/correlation/service";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/correlation/rules — list the tenant's correlation rules.
 * POST /api/fgmp/correlation/rules — author a new rule.
 *
 * ── WHERE EVALUATION HAPPENS ────────────────────────────────────────────────
 * Not here, and not in the browser. Rules are evaluated SERVER-SIDE by
 * `correlation/service.ts`, which loads the tenant's alarms inside
 * `withTenant()` and persists each fired match. This endpoint only authors and
 * reads rules; the browser displays matches that already exist.
 *
 * The previous implementation evaluated rules in the browser against alarms
 * the browser held, so the suppression decision was made by whichever client
 * happened to load the page — and two operators could disagree about whether
 * the same alarm stream had correlated.
 *
 * ── TENANT SCOPE ───────────────────────────────────────────────────────────
 * `listRules` / `createRule` supply their own `withTenant()` internally from the
 * tenantId passed here. Do NOT wrap them in another context and do not pass a
 * client: `createRule`'s third argument bypasses RLS and is a test seam only.
 */

/**
 * Correlation authoring is a platform-configuration action.
 *
 * It is deliberately NOT `READ_LIMIT`-visible to every role: a rule causes
 * alarms to be escalated to L2/L3, so being able to author one is an
 * operational privilege. ALARM_OPS are the roles that act on alarms and can
 * reasonably tune the rules that raise them.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;

  try {
    const rl = rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const rules = await listRules(me.tenantId);
    const res = NextResponse.json(rules);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;

  const guard = await requireRole(req, ROLES.ALARM_OPS);
  if ("error" in guard) return guard.error;

  try {
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const raw = await req.json();
    const v = validateBody(createCorrelationRuleSchema, raw);
    if (!v.success) {
      const res = NextResponse.json({ error: v.error }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const rule = await createRule(me.tenantId, {
      name: v.data.name,
      description: v.data.description,
      alarmType: v.data.alarmType,
      threshold: v.data.threshold,
      windowMinutes: v.data.windowMinutes,
      scope: v.data.scope,
      escalateTo: v.data.escalateTo,
    });

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "correlation.rule.create",
      entity: "CorrelationRule",
      details: {
        name: v.data.name,
        alarmType: v.data.alarmType,
        threshold: v.data.threshold,
        windowMinutes: v.data.windowMinutes,
        scope: v.data.scope,
        escalateTo: v.data.escalateTo,
      },
    });

    const res = NextResponse.json(rule, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}