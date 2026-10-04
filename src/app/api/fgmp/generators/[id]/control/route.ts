import { NextRequest, NextResponse } from "next/server";
import { db, engine, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import { generatorCommandSchema, validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import type { GenCommand } from "@/lib/fgmp/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.CONTROL);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await params;

    // Tenant isolation: verify the generator's site belongs to the caller's
    // tenant before dispatching the control command through the engine.
    const gen = await db.generator.findUnique({
      where: { id },
      select: { id: true, site: { select: { tenantId: true } } },
    });
    const denied = assertSiteTenantOwned(gen?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    const body = await req.json().catch(() => ({}));
    const r = validateBody(generatorCommandSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { command, reason } = r.data;

    const result = await engine.applyCommand(id, command as GenCommand, user.id, reason);
    await audit({ userId: user.id, action: "CONTROL", entity: "generator", entityId: id, details: { command, reason, result } });
    const res = NextResponse.json(result, { status: result.ok ? 200 : 409 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
