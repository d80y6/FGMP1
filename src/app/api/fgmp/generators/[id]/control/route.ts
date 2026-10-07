import { NextRequest, NextResponse } from "next/server";
import { engine } from "@/lib/fgmp";
import { withTenant } from "@/lib/fgmp/tenant-context";
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
import { withGeneratorCommandLock } from "@/lib/fgmp/command-lock";
import type { GenCommand } from "@/lib/fgmp/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.CONTROL);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await params;

    // ── PHASE 3: scoped lookup ────────────────────────────────────────────
    // Previously an unscoped `db` read. Under FORCE RLS that returns null for
    // every id, so assertSiteTenantOwned(null) answered 404 and the control
    // endpoint was unreachable for legitimate operators. With the caller's own
    // tenant in scope the row resolves, and a cross-tenant id still yields
    // null -> 404, which is the intended 404-not-403 behaviour.
    const gen = await withTenant(me.tenantId, (tx) =>
      tx.generator.findUnique({
        where: { id },
        select: { id: true, site: { select: { tenantId: true } } },
      }),
    );
    const denied = assertSiteTenantOwned(gen?.site ?? null, me);
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
      tenantId: me.tenantId,
      generatorId: id,
      command: command as GenCommand,
      userId: me.id,
      override: null,
    });
    if (!enforced.ok) {
      await audit({
        userId: me.id,
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

    // ── PHASE 5 IDEMPOTENCY ───────────────────────────────────────────────────
    // A duplicate submission of a command that is already in flight with the
    // SAME intent must NOT be dispatched again. Dispatching a second START
    // because a client retried after a dropped response is a real hazard, and
    // the operator needs to be told their retry was recognised rather than
    // seeing a fresh success that implies a second start.
    if (enforced.replay) {
      await audit({
        userId: me.id,
        tenantId: me.tenantId,
        action: "CONTROL_REPLAY_SUPPRESSED",
        entity: "generator",
        entityId: id,
        details: {
          command,
          duplicateOf: enforced.replay.commandId,
          duplicateCommand: enforced.replay.command,
        },
      });
      const res = NextResponse.json(
        {
          ok: true,
          replayed: true,
          message:
            `Duplicate ${enforced.replay.command} suppressed — command ` +
            `${enforced.replay.commandId} is already in flight for this generator.`,
          duplicateOf: enforced.replay.commandId,
        },
        { status: 200 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // ── PHASE 5: CLOSE THE CHECK-THEN-DISPATCH WINDOW (TOCTOU) ───────────────
    // `enforceInterlock()` above and `applyCommand()` below were two separate
    // awaits with no lock between them. A concurrent IoT ingest could change
    // coolant temperature or fuel level inside that window, and the command
    // would then be authorised against a STALE reading.
    //
    // Latent today only because the dispatch is an in-process memory write.
    // The moment it becomes a Modbus write this is a real race: the interlock
    // would have said "safe at 84 °C" and the engine would receive START while
    // the sensor read 97 °C.
    //
    // The interlock is therefore RE-EVALUATED inside a per-generator critical
    // section, immediately before dispatch, and the dispatch is refused if the
    // state has moved. Re-evaluating under the lock is what makes this correct:
    // an advisory lock alone would serialise commands but still admit a
    // telemetry write that landed between the first check and the lock being
    // taken.
    //
    // The lock is IN-PROCESS and per-generator. It is honest about its own
    // limits: it cannot order a write arriving from another replica. Once the
    // dispatch targets real hardware this needs a database advisory lock held
    // across the read-and-dispatch, not a process-local mutex — recorded rather
    // than left to be discovered as an unexplained unsafe start.
    const { result, revalidated } = await withGeneratorCommandLock(id, async () => {
      const recheck = await enforceInterlock({
        tenantId: me.tenantId,
        generatorId: id,
        command: command as GenCommand,
        userId: me.id,
        override: null,
      });
      if (!recheck.ok) {
        await audit({
          userId: me.id,
          action: "CONTROL_DENIED",
          entity: "generator",
          entityId: id,
          details: {
            command,
            reasonCode: denialResponseBody(recheck.verdict).reasonCode,
            // Distinguishes "refused at the initial check" from "state moved
            // between the check and the dispatch". The second is the finding
            // this whole block exists to catch, so it must be visible.
            stage: "REVALIDATED_BEFORE_DISPATCH",
          },
        });
        return {
          result: { ok: false, message: denialResponseBody(recheck.verdict).reasonCode },
          revalidated: denialResponseBody(recheck.verdict),
        };
      }

      // ── PHASE 3: the AUTHENTICATED tenant is passed down so the engine can
      // assert the generator's tenant matches it, before any state mutation.
      return {
        result: await engine.applyCommand(id, command as GenCommand, me.id, reason, me.tenantId),
        revalidated: null,
      };
    });

    if (revalidated) {
      const res = NextResponse.json(revalidated, { status: 409 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    await audit({ userId: me.id, action: "CONTROL", entity: "generator", entityId: id, details: { command, reason, result } });
    const res = NextResponse.json(
      {
        ...result,
        // The warnings that matter are the ones from the check that actually
        // authorised this dispatch, which is the re-check inside the lock.
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
