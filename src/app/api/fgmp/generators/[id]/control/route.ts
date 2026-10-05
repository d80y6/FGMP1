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
import { enforceInterlock, denialResponseBody } from "@/lib/fgmp/interlock-enforce";
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

    // ── SAFETY INTERLOCKS (Phase 2) ────────────────────────────────────────
    // Enforced BEFORE the engine is touched. Ordering is the safety property:
    // if this ran after applyCommand() the command would already be at the
    // generator and the interlock would be decoration.
    //
    // A refused command is recorded, not silently dropped — an operator who
    // sees nothing will simply retry, and retrying blindly against a hard
    // interlock is how a transient reading becomes a repeated unsafe action.
    const enforced = await enforceInterlock({
      tenantId: user.tenantId,
      generatorId: id,
      command: command as GenCommand,
      userId: user.id,
      override: null,
    });
    if (!enforced.ok) {
      await audit({
        userId: user.id,
        action: "CONTROL_DENIED",
        entity: "generator",
        entityId: id,
        details: { command, reasonCode: denialResponseBody(enforced.verdict).reasonCode },
      });
      const res = NextResponse.json(
        { ...denialResponseBody(enforced.verdict), recordedAs: enforced.recordedId },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const result = await engine.applyCommand(id, command as GenCommand, user.id, reason);
    await audit({ userId: user.id, action: "CONTROL", entity: "generator", entityId: id, details: { command, reason, result } });
    const res = NextResponse.json(
      {
        ...result,
        interlockWarnings: enforced.verdict.warnings.map((w) => ({
          ruleId: w.ruleId,
          explanation: w.explanation,
        })),
      },
      { status: result.ok ? 200 : 409 },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
