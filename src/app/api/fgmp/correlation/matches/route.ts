import { NextRequest, NextResponse } from "next/server";
import { listMatches } from "@/lib/fgmp/correlation/service";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/correlation/matches — persisted correlation results.
 *
 * This is the ONLY source the UI renders. It returns rows that the server
 * already evaluated and persisted; nothing here recomputes a decision, and the
 * browser has no code path that could produce a match.
 *
 * `listMatches` runs inside `withTenant(me.tenantId, …)` internally, so a
 * cross-tenant match is unreachable at the database level rather than filtered
 * in application code. An operator on tenant A cannot see tenant B's
 * correlations even by guessing a match id.
 *
 * Read access is any authenticated role: seeing that alarms were correlated is
 * part of reading the alarm view, and this exposes no more than the alarm list
 * itself already does.
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

    const { searchParams } = new URL(req.url);
    const rawLimit = Number.parseInt(searchParams.get("limit") ?? "50", 10);
    // Clamp rather than trust: an unbounded limit is an easy way to turn a
    // dashboard into a full-table scan.
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 200)
      : 50;

    const matches = await listMatches(me.tenantId, limit);

    // evaluatedAt is a Date; NextResponse.json serialises it to an ISO string,
    // which is what the UI expects.
    const res = NextResponse.json(matches);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}