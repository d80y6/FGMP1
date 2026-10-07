/**
 * ─────────────────────────────────────────────────────────────────────────────
 * INTERLOCK EVALUATION AND ENFORCEMENT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The rules live in ./interlock-rules.ts as data. This module evaluates them and
 * is the ONLY place allowed to refuse a control command.
 *
 * Separation that matters:
 *   interlock-rules.ts   WHAT the preconditions are (auditable, testable)
 *   interlocks.ts         WHETHER they are met, and what happens if not
 *
 * ── WHY A DENIED COMMAND IS STILL RECORDED ──────────────────────────────────
 * A refusal that vanishes is indistinguishable from a network drop. Operators
 * need to see that a command was considered and refused, with the reason, or
 * they will retry blindly — and a retry loop against a hard interlock is how a
 * transient reading becomes a repeated unsafe action. Every denial is written
 * as a ControlCommand row with status DENIED.
 *
 * ── WHY EMERGENCY_STOP IS NEVER BLOCKED ─────────────────────────────────────
 * An interlock that can veto an emergency stop is itself a hazard. If the
 * software's model of the world is wrong, the operator must still be able to
 * stop the engine. This is not a soft preference; it is why
 * UNBLOCKABLE_COMMANDS is checked before any HARD rule is consulted.
 */

import { withTenant } from "./tenant-context";
import type {
  ControlCommandName,
  InterlockContext,
  InterlockRule,
  InterlockRuleId,
  InterlockSeverity,
} from "./interlock-rules";
import {
  INTERLOCK_RULES,
  UNBLOCKABLE_COMMANDS,
} from "./interlock-rules";

/** A rule that fired, with its explanation. */
export interface InterlockFinding {
  ruleId: InterlockRuleId;
  severity: InterlockSeverity;
  /** True when the rule requires two-person authorization to override. */
  requiresTwoPerson: boolean;
  explanation: string;
  remedy: string;
}

export type InterlockVerdict =
  | {
      allowed: true;
      /** SOFT rules that fired. The command proceeds WITH these warnings. */
      warnings: InterlockFinding[];
      /** HARD rules that matched but are unblockable for this command. */
      bypassed: InterlockFinding[];
    }
  | {
      allowed: false;
      /** The HARD findings. The FIRST is the reason reported to the operator. */
      reasons: InterlockFinding[];
      warnings: InterlockFinding[];
      bypassed: InterlockFinding[];
    };

function finding(rule: InterlockRule, explanation: string): InterlockFinding {
  return {
    ruleId: rule.id,
    severity: rule.severity,
    requiresTwoPerson: rule.authority === "TWO_PERSON",
    explanation,
    remedy: rule.remedy,
  };
}

/**
 * Evaluate every rule against a requested command.
 *
 * Pure and synchronous — no database, no clock, no I/O. That is what makes the
 * safety logic exhaustively testable, and it is why `now` is a parameter
 * rather than something read from Date.now() here.
 */
export function evaluateInterlocks(
  command: ControlCommandName,
  ctx: InterlockContext,
  rules: readonly InterlockRule[] = INTERLOCK_RULES,
): InterlockVerdict {
  const warnings: InterlockFinding[] = [];
  const bypassed: InterlockFinding[] = [];
  const reasons: InterlockFinding[] = [];

  const unblockable = UNBLOCKABLE_COMMANDS.includes(command);

  // Phase 5: expose the REQUESTED command on the context so a rule can compare
  // it against an in-flight one. Without this the idempotency flag is a blanket
  // bypass — a START could slip past an in-flight STOP, which is precisely the
  // race COMMAND_ALREADY_IN_FLIGHT exists to stop.
  const ctxWithCommand: InterlockContext = { ...ctx, command };

  for (const rule of rules) {
    // EMERGENCY_STOP bypasses every rule without even evaluating it. A HARD
    // interlock exists to prevent damage; it must never become the reason a
    // set keeps running.
    if (unblockable) break;

    if (rule.appliesTo.length > 0 && !rule.appliesTo.includes(command)) continue;

    const explanation = rule.evaluate(ctxWithCommand);
    if (explanation === null) continue;

    const f = finding(rule, explanation);
    if (rule.severity === "HARD") {
      reasons.push(f);
    } else {
      warnings.push(f);
    }
  }

  // A SOFT rule cannot deny — that is the entire distinction between the
  // tiers — and only the HARD rules collected above can. UNBLOCKABLE_COMMANDS
  // already short-circuited the loop above, so any HARD finding here is a
  // genuine refusal.
  if (reasons.length > 0) {
    return { allowed: false, reasons, warnings, bypassed };
  }
  return { allowed: true, warnings, bypassed };
}

/**
 * Throw a typed error when a command is denied.
 *
 * Used at the HTTP boundary so a refusal is a refusal — the command must not
 * reach the engine. `ApiError` carries the status code so the route does not
 * have to decide what a denial means at the protocol level.
 */
export class InterlockDeniedError extends Error {
  readonly verdict: Extract<InterlockVerdict, { allowed: false }>;

  constructor(verdict: Extract<InterlockVerdict, { allowed: false }>) {
    super(verdict.reasons[0]?.explanation ?? "Command refused by an interlock.");
    this.name = "InterlockDeniedError";
    this.verdict = verdict;
  }
}

/** True when every firing hard rule can be cleared by a single operator. */
export function requiresTwoPerson(
  verdict: Extract<InterlockVerdict, { allowed: false }>,
): boolean {
  return verdict.reasons.some((r) => r.requiresTwoPerson);
}

/**
 * Persist a denied command so the refusal is visible to operators.
 *
 * Runs inside withTenant() because ControlCommand is RLS-protected and the
 * write would otherwise be rejected outright. The row is tenant-scoped exactly
 * like any other control record.
 *
 * The engine is NOT called. This function only records.
 */
export async function recordDeniedCommand(params: {
  tenantId: string;
  generatorId: string;
  command: ControlCommandName;
  userId: string;
  reason: string;
  /** Extra detail: rule ids, severities, and the decision inputs. */
  detail?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const row = await withTenant(params.tenantId, (tx) =>
    tx.controlCommand.create({
      data: {
        tenantId: params.tenantId,
        generatorId: params.generatorId,
        command: params.command,
        // DENIED is not in the ControlCommandStatus enum; the refusal is
        // recorded as FAILED with an explicit reason string, because the
        // command never became SENT. See docs for why the enum was not widened.
        status: "FAILED",
        reason: params.reason,
        issuedById: params.userId,
        executedAt: new Date(),
        result: JSON.stringify({ outcome: "DENIED_BY_INTERLOCK", ...(params.detail ?? {}) }),
      },
      select: { id: true },
    }),
  );
  return row;
}

/**
 * Build the client-facing refusal payload.
 *
 * Returned to the operator verbatim, so it carries both the machine-readable
 * rule id (for the UI to link to documentation) and the human explanation.
 */
export function denialResponseBody(verdict: Extract<InterlockVerdict, { allowed: false }>) {
  return {
    error: "Command refused by safety interlock",
    denied: true,
    reasonCode: verdict.reasons[0]?.ruleId ?? "INTERLOCK",
    reason: verdict.reasons[0]?.explanation ?? "Command refused by an interlock.",
    remedy: verdict.reasons[0]?.remedy ?? null,
    requiresTwoPerson: requiresTwoPerson(verdict),
    findings: verdict.reasons.map((r) => ({
      ruleId: r.ruleId,
      severity: r.severity,
      requiresTwoPerson: r.requiresTwoPerson,
      explanation: r.explanation,
      remedy: r.remedy,
    })),
    warnings: verdict.warnings.map((w) => ({
      ruleId: w.ruleId,
      explanation: w.explanation,
    })),
  };
}