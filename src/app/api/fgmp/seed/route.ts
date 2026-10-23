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
import { hasOwnerDbUrl } from "@/lib/fgmp/owner-db";

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
    // Seeding spans tenants and creates the tenant rows themselves, so it runs
    // on the OWNER connection — which the web app deliberately never holds
    // (docker-compose does not pass FGMP_MIGRATE_DATABASE_URL to this
    // container, and it must not). Without that credential this would fall
    // back to the app role and fail on the first insert with an RLS violation,
    // surfacing as an opaque 500. Say what to run instead.
    if (!hasOwnerDbUrl()) {
      return NextResponse.json(
        {
          error: "Seeding is a deploy-time step",
          code: "SEED_REQUIRES_OWNER_CREDENTIAL",
          detail:
            "This container holds no owner credential, so seeding from an " +
            "HTTP request would be rejected by row-level security. Run " +
            "`bun run db:seed` (or the compose `seed` profile) as a one-shot " +
            "job with FGMP_MIGRATE_DATABASE_URL set.",
        },
        { status: 503 },
      );
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
