import { NextRequest, NextResponse } from "next/server";
import { seedIfNeeded } from "@/lib/fgmp/seed";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    // Use the session user requireRole() already resolved rather than
    // re-resolving it (and rather than a getCurrentUser() that now fails closed).
    const user = auth.user;
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const res = await seedIfNeeded();
    await audit({ userId: user.id, action: "SEED", entity: "system", details: res });
    const response = NextResponse.json(res);
    applyRateLimitHeaders(response.headers, rl);
    return response;
  } catch (err) {
    return errorResponse(err);
  }
}
