import { NextRequest, NextResponse } from "next/server";
import { evaluateAndPersist } from "@/lib/fgmp/correlation/service";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";

export const dynamic = "force-dynamic";

/**
 * POST /api/fgmp/correlation/evaluate — run the server-side evaluator now.
 *
 * The scheduler already calls `evaluateAndPersist` after each tick, so matches
 * accumulate on their own. This endpoint is the manual equivalent, for an
 * operator who has just authored a rule and wants to see its effect without
 * waiting for the next tick.
 *
 * ── WHY `now` IS NOT TAKEN FROM THE CLIENT ──────────────────────────────────
 * An evaluation is a pure function of (rules, alarms, now). Letting the caller
 * supply `now` would let anyone rewind the window and replay an old alarm
 * stream into fresh matches, so the instant is always taken server-side.
 * `evaluateAndPersist` takes it as a required parameter for reproducibility in
 * tests; this route supplies `Date.now()`.
 *
 * ── IDEMPOTENCY ────────────────────────────────────────────────────────────
 * A second run over an unchanged alarm stream must insert nothing. The
 * response reports `inserted` and `deduplicated` separately precisely so that
 * property is observable from the API rather than assumed; see
 * `scripts/correlation-idempotency-proof.ts`.
 *
 * Evaluates only the CALLER's tenant. There is no cross-tenant mode, because
 * there is no safe way to offer one: `evaluateAndPersist` scopes its reads and
 * writes to a single `app.tenant_id`.
 */
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

    const outcome = await evaluateAndPersist({
      tenantId: me.tenantId,
      now: Date.now(),
    });

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "correlation.evaluate",
      entity: "CorrelationRule",
      details: {
        rulesConsidered: outcome.rulesConsidered,
        triggered: outcome.triggered.length,
        inserted: outcome.inserted,
        deduplicated: outcome.deduplicated,
      },
    });

    const res = NextResponse.json(outcome);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}