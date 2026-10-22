import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import { tickSchema, validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import { simulationDecision } from "@/lib/fgmp/simulation";

export const dynamic = "force-dynamic";

/**
 * POST /api/fgmp/tick — advance the simulation clock by `seconds` (1..3600).
 * GET  /api/fgmp/tick — advance by a fixed 60s.
 *
 * ── SECURITY ───────────────────────────────────────────────────────────────
 * `engine.tick()` is the ONE endpoint whose effect is not tenant-scoped: it
 * advances every site's tanks, generators, batteries, IoT devices and alarm
 * evaluation for EVERY tenant at once, and appends audit rows across the
 * platform. It was gated on a bare `requireAuth()`, so a READONLY or
 * EXECUTIVE account could fast-forward global state 60×/min at up to 3600
 * simulated seconds per call — a data-integrity / cross-tenant denial of
 * service, not merely a privilege leak.
 *
 * Now gated on `ROLES.TICK` (ADMIN, NOC_OPERATOR, REGIONAL_MANAGER) — the
 * operator roles that legitimately drive the simulation. Both GET and POST
 * carry the guard: GET ticks too, so it needs the same protection.
 *
 * NOTE for the UI owner: `src/components/fgmp/app-shell.tsx` polls the state
 * API every 5s for every role — since the Apinator cutover this poll is the
 * ONLY state refresher (there is no `state:tick` push anymore; realtime
 * events merely trigger an immediate refresh). This endpoint ADVANCES the
 * simulation and stays gated on ROLES.TICK: an EXECUTIVE / READONLY session
 * calling it receives 403 and the store's `tick()` ignores the response
 * status — by design, for the data-integrity reasons documented above. A
 * role-specific poll is not needed because the state poll uses `refresh()`,
 * not this endpoint.
 */
/**
 * Refuse to fabricate telemetry when simulation is not permitted (Phase 2).
 *
 * This endpoint's entire purpose is to invent data, so it is the one place
 * where a production deployment must say no outright. `engine.tick()` enforces
 * the same rule independently; this is the HTTP-surface guard that returns a
 * clear explanation instead of a generic 500.
 *
 * 503 rather than 403: nothing is wrong with the caller's credentials — the
 * capability is not offered in this environment.
 */
function simulationRefusal() {
  const d = simulationDecision();
  if (d.allowed) return null;
  return NextResponse.json(
    {
      error: "Simulated telemetry is disabled",
      code: d.code,
      reason: d.reason,
    },
    { status: 503 },
  );
}

export async function POST(req: NextRequest) {
  const refusal = simulationRefusal();
  if (refusal) return refusal;
  const auth = await requireRole(req, ROLES.TICK);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const raw = await req.json().catch(() => ({}));
    const r = validateBody(tickSchema, raw);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const seconds = r.data.seconds ?? 60;
    const res2 = await engine.tick(seconds);
    const res = NextResponse.json({ ok: true, ...res2 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(req: NextRequest) {
  // GET is not a read — it advances the clock by 60s, so it carries the same
  // operator guard as POST and the same simulation guard.
  const refusal = simulationRefusal();
  if (refusal) return refusal;
  const auth = await requireRole(req, ROLES.TICK);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const res2 = await engine.tick(60);
    const res = NextResponse.json({ ok: true, ...res2 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
