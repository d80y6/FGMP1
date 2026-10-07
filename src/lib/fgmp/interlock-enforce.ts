/**
 * ─────────────────────────────────────────────────────────────────────────────
 INTERLOCK ENFORCEMENT — the single gate every control command passes through
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The control route calls `enforceInterlock()` BEFORE touching the engine. A
 * denial is returned to the operator and recorded; the engine is never reached.
 *
 * The ordering is the safety property. If this function ran after
 * engine.applyCommand(), the command would already have been dispatched to the
 * generator and the interlock would be decoration.
 */

import { db } from "@/lib/db";
import { buildInterlockContext } from "./interlock-state";
import {
  evaluateInterlocks,
  recordDeniedCommand,
  denialResponseBody,
  requiresTwoPerson,
} from "./interlocks";
import type { InterlockVerdict } from "./interlocks";
import type { ControlCommandName } from "./interlock-rules";

/**
 * Outcome of the interlock gate.
 *
 * `verdict` is carried on BOTH branches, including the allowed one after an
 * override. That is deliberate: a command that was allowed only because a
 * second operator signed off still needs the caller to surface what was
 * overridden, and dropping the verdict on success would lose exactly the
 * information an operator needs to see.
 */
export type EnforcementOutcome =
  | {
      ok: true;
      verdict: InterlockVerdict;
      /** True when the command proceeded despite a hard interlock, via override. */
      overridden: boolean;
      /**
       * PHASE 5: the caller re-submitted a command that is already in flight
       * with the SAME intent, inside the idempotency window.
       *
       * The route must NOT dispatch again. Returning `ok: true` here is
       * deliberate — the command's intent has already been applied — but the
       * caller needs to know it is a replay so it does not act twice and so the
       * operator sees that their retry did not queue a second start.
       */
      replay?: { commandId: string; command: string };
    }
  | {
      ok: false;
      verdict: Extract<InterlockVerdict, { allowed: false }>;
      recordedId: string | null;
    };

/**
 * Evaluate the interlocks for a command and, if refused, record the refusal.
 *
 * `override` is present only when the caller has already established that a
 * valid override exists — either a two-person authorization, or a documented
 * single-tier justification. This function does NOT decide who may override;
 * `assertOverrideAuthorized` does, and it refuses to guess.
 */
export async function enforceInterlock(params: {
  tenantId: string;
  generatorId: string;
  command: ControlCommandName;
  userId: string;
  /** Present when a valid override was established by the caller. */
  override?: { approvedById: string; justification: string } | null;
  now?: number;
}): Promise<EnforcementOutcome> {
  const now = params.now ?? Date.now();

  // If the engine cannot describe the asset, the preconditions cannot be
  // assessed. Refusing is the safe direction: an unassessable command is not
  // an approved one.
  // Phase 5: now ASYNC — the context loads the tenant's thresholds from the
  // database inside withTenant. A read failure PROPAGATES rather than silently
  // degrading to the shipped defaults: a transient database error must never
  // quietly change a safety limit without anyone noticing.
  const ctx = await buildInterlockContext(params.generatorId, params.tenantId, now);
  if (!ctx) {
    const recorded = await recordDeniedCommand({
      tenantId: params.tenantId,
      generatorId: params.generatorId,
      command: params.command,
      userId: params.userId,
      reason: "STATE_UNAVAILABLE",
      detail: {
        outcome: "DENIED_BY_INTERLOCK",
        ruleId: "STATE_UNAVAILABLE",
        explanation:
          "Current generator state could not be read, so the safety preconditions could not be evaluated.",
      },
    });
    return {
      ok: false,
      recordedId: recorded.id,
      verdict: {
        allowed: false,
        warnings: [],
        bypassed: [],
        reasons: [
          {
            ruleId: "STATE_UNAVAILABLE" as never,
            severity: "HARD",
            requiresTwoPerson: false,
            explanation:
              "Current generator state could not be read, so the safety preconditions could not be evaluated.",
            remedy: "Restore generator telemetry and retry.",
          },
        ],
      },
    };
  }

  // PHASE 5 — IDEMPOTENCY AND THE STUCK-SENT LOCKOUT.
  //
  // Two problems with the previous query, both measured:
  //
  // 1. STUCK ROWS. It matched any command in PENDING/SENT with no age bound.
  //    Because the dispatch is simulated, a SENT row never transitions to
  //    EXECUTED — so after the FIRST command to a generator, every subsequent
  //    command matched this query forever and COMMAND_ALREADY_IN_FLIGHT refused
  //    all control for that asset permanently. That is a self-inflicted lockout
  //    dressed as a safety property: an operator locked a working generator out
  //    of remote control permanently, with no way to recover but manual SQL.
  //
  // 2. NO IDEMPOTENCY. A double-POSTed START replayed, because nothing
  //    recognised the repeat. For a safety-relevant action that is a real
  //    hazard even when the dispatch is simulated.
  //
  // Fix 1: bound the query by age. A command that has not resolved within
  // STALE_COMMAND_MS cannot still be in flight — there is nothing left to race.
  // That turns an unbounded permanent lockout into a bounded window.
  const STALE_COMMAND_MS = 5 * 60 * 1000;
  const staleBefore = new Date(now - STALE_COMMAND_MS);
  const inFlight = await db.controlCommand.findFirst({
    where: {
      generatorId: params.generatorId,
      status: { in: ["PENDING", "SENT"] },
      createdAt: { gte: staleBefore },
    },
    select: { id: true, command: true, status: true, createdAt: true },
  });
  ctx.commandInFlight = inFlight;

  // Fix 2: an exact-duplicate resubmission is treated as the SAME command, not
  // a second one. The caller may legitimately retry after a dropped response,
  // and re-dispatching a START that was already applied is the hazard. Rather
  // than silently ignoring it, the duplicate is reported so the route can tell
  // the operator it was already applied.
  if (
    inFlight &&
    inFlight.command === params.command &&
    !ctx.idempotentReplay
  ) {
    const ageMs = now - inFlight.createdAt.getTime();
    // Within a short window, treat as a replay. Beyond it the row is genuinely
    // stale and the age bound above would not have selected it.
    ctx.idempotentReplay = ageMs < STALE_COMMAND_MS;
  }

  const verdict = evaluateInterlocks(params.command, ctx);

  if (verdict.allowed) {
    // PHASE 5 idempotency: a duplicate submission is reported, not re-dispatched.
    return {
      ok: true,
      verdict,
      overridden: false,
      replay: inFlight && ctx.idempotentReplay
        ? { commandId: inFlight.id, command: inFlight.command }
        : undefined,
    };
  }

  // ── Override gate ─────────────────────────────────────────────────────────
  // A refusal can only be cleared by an override that was AUTHORIZED upstream.
  // This is the point where a two-person rule becomes a real control: without
  // a second, distinct approver, the command stays refused no matter who asks.
  if (params.override) {
    const needsTwoPerson = requiresTwoPerson(verdict);
    const approvedBy = params.override.approvedById;

    if (needsTwoPerson && approvedBy === params.userId) {
      // Self-approval. This is the single most important check in the module:
      // without it, "two-person rule" means one person typing twice.
      const recorded = await recordDeniedCommand({
        tenantId: params.tenantId,
        generatorId: params.generatorId,
        command: params.command,
        userId: params.userId,
        reason: "TWO_PERSON_SELF_APPROVAL",
        detail: {
          outcome: "DENIED_BY_INTERLOCK",
          ruleId: "TWO_PERSON_SELF_APPROVAL",
          requiresTwoPerson: true,
          explanation:
            "This interlock requires two-person authorization and the requester cannot also be the approver.",
          justification: params.override.justification,
        },
      });
      return { ok: false, recordedId: recorded.id, verdict };
    }

    // Authorized override: record it, then allow.
    await db.interlockOverride.create({
      data: {
        tenantId: params.tenantId,
        generatorId: params.generatorId,
        command: params.command,
        ruleId: verdict.reasons[0]?.ruleId ?? "INTERLOCK",
        requestedById: params.userId,
        approvedById: approvedBy,
        justification: params.override.justification,
      },
    });
    return { ok: true, verdict, overridden: true };
  }

  const recorded = await recordDeniedCommand({
    tenantId: params.tenantId,
    generatorId: params.generatorId,
    command: params.command,
    userId: params.userId,
    reason: verdict.reasons[0]?.ruleId ?? "INTERLOCK",
    detail: {
      outcome: "DENIED_BY_INTERLOCK",
      requiresTwoPerson: requiresTwoPerson(verdict),
      findings: verdict.reasons.map((r) => ({
        ruleId: r.ruleId,
        requiresTwoPerson: r.requiresTwoPerson,
        explanation: r.explanation,
      })),
      warnings: verdict.warnings.map((w) => ({ ruleId: w.ruleId })),
    },
  });

  return { ok: false, recordedId: recorded.id, verdict };
}

export { denialResponseBody };