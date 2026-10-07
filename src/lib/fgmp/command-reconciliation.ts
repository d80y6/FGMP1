/**
 * Command reconciliation — moving abandoned ControlCommand rows to a terminal
 * state, WITH A REASON.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A command row is written when an operator issues it. Something then has to
 * move it to a terminal state, and for a dispatched-but-never-acknowledged
 * command that something is the device or the field bus. When it never arrives,
 * the row just sits there.
 *
 * That matters because `COMMAND_ALREADY_IN_FLIGHT` refuses new commands to a
 * generator while a non-terminal row exists for it. Without a sweep, a dropped
 * packet or a gateway restart leaves a row in PENDING/SENT forever and the
 * generator becomes permanently uncommandable — a self-inflicted lockout wearing
 * a safety costume. An operator who cannot start a generator during an outage
 * because of stale database rows is worse off than one who can.
 *
 * `interlock-enforce.ts` already bounds the in-flight QUERY by age, so a stale
 * row no longer blocks a new command. That is a mitigation, not a fix: the rows
 * still accumulate, the audit trail still shows commands that never resolved,
 * and `status` still cannot answer "what happened to this".
 *
 * ── WHY A REASON IS MANDATORY ──────────────────────────────────────────────
 * A row moved to a terminal state with no explanation is the same class of false
 * record this phase has been fixing everywhere else: it says "this resolved"
 * when in fact nobody ever heard back. `reason` is the only evidence that
 * distinguishes "the generator refused" from "we gave up waiting", and those
 * need different operator responses.
 *
 * ── TENANT SAFETY: WHY A PER-TENANT LOOP AND NOT AN OWNER SWEEP ─────────────
 * A sweep needs to find stale rows across tenants. `withTenant(tenantId, …)` is
 * by definition scoped to ONE tenant, so a single context cannot enumerate them.
 * The two options are an owner/ops connection that bypasses FORCE RLS, or a
 * per-tenant loop driven from the Tenant table.
 *
 * This uses the PER-TENANT LOOP, deliberately:
 *
 *   - It keeps every read and write inside RLS. An owner sweep would bypass
 *     FORCE RLS, which is a genuine privilege escalation granted for
 *     convenience; the control exists precisely so that a bug elsewhere cannot
 *     silently read or write across tenants, and a background job is exactly the
 *     kind of code that runs unattended.
 *   - The blast radius of a mistake is one tenant's commands rather than every
 *     tenant's.
 *   - The cost is one extra transaction per tenant. Tenant counts here are
 *     small (single digits), so this is not a real trade-off at this scale.
 *
 * The Tenant table itself carries no `tenantId` column and is outside RLS, so
 * reading the tenant LIST is not a cross-tenant data read — it is the platform
 * directory, which is what the loop needs to know where to point itself. No
 * command, alarm or asset row is read outside its own tenant's context.
 */

/** Terminal statuses a command can end in. Mirrors ControlCommandStatus. */
export const TERMINAL_STATUSES = ["EXECUTED", "FAILED", "TIMEOUT"] as const;

/** Statuses that mean "this command has not resolved yet". */
export const NON_TERMINAL_STATUSES = ["PENDING", "SENT"] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type NonTerminalStatus = (typeof NON_TERMINAL_STATUSES)[number];

/** Minimal shape of a row, so the decision function is testable without Prisma. */
export interface ReconcilableCommand {
  id: string;
  generatorId: string;
  status: string;
  issuedAt: Date;
  executedAt: Date | null;
  /** Present when the command already carries an explanation. */
  reason: string | null;
  result: string | null;
}

/** Why a command was reconciled. Recorded verbatim into `reason`. */
export type ReconciliationReason =
  | "NO_ACKNOWLEDGEMENT"
  | "EXECUTED_WITHOUT_TIMESTAMP"
  | "ALREADY_TERMINAL";

export interface ReconciliationDecision {
  /** True when this row must be moved. */
  shouldReconcile: boolean;
  /** Target status. Always TIMEOUT for a row that never resolved. */
  toStatus: TerminalStatus;
  reason: ReconciliationReason;
  /** Human-readable text written into `result`, or null when nothing changes. */
  note: string;
}

/** A command older than this can no longer be in flight. */
export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Decide what, if anything, to do about one stale command row.
 *
 * PURE — no database, no clock of its own. `now` is a required parameter so a
 * test can pin it and so a replay produces an identical decision.
 *
 * Conservative by design: anything it cannot confidently explain is left alone.
 * Reconciling a row that a real dispatcher legitimately still holds would
 * resurrect a command the operator believes is running, which is worse than
 * leaving a stale row for the age-bounded in-flight query to ignore.
 */
export function decideReconciliation(
  cmd: ReconcilableCommand,
  now: Date,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): ReconciliationDecision {
  const ageMs = now.getTime() - cmd.issuedAt.getTime();

  // Only non-terminal rows are candidates. A row that is already terminal is
  // never touched — this is what makes running the sweep twice a no-op.
  if ((TERMINAL_STATUSES as readonly string[]).includes(cmd.status)) {
    return {
      shouldReconcile: false,
      toStatus: cmd.status as TerminalStatus,
      reason: "ALREADY_TERMINAL",
      note: "",
    };
  }

  if (!(NON_TERMINAL_STATUSES as readonly string[]).includes(cmd.status)) {
    // An unrecognised status means someone added a state this module does not
    // understand. Leave it alone rather than guessing at its meaning.
    return {
      shouldReconcile: false,
      toStatus: "TIMEOUT",
      reason: "ALREADY_TERMINAL",
      note: "",
    };
  }

  // Not old enough — still legitimately in flight.
  if (ageMs < staleAfterMs) {
    return {
      shouldReconcile: false,
      toStatus: "TIMEOUT",
      reason: "NO_ACKNOWLEDGEMENT",
      note: "",
    };
  }

  // Old enough to give up on. The row never reached a terminal state and has no
  // acknowledgement, so the only honest terminal status is TIMEOUT.
  //
  // If `executedAt` IS set, the device acknowledged the action but the status
  // was never advanced. Recording it as TIMEOUT would be wrong — the command DID
  // execute — so it is reported distinctly and still moved, because leaving a
  // row in PENDING after an execution is what blocks the generator.
  const executedButUnrecorded = cmd.executedAt !== null;

  const note = executedButUnrecorded
    ? `Reconciled by sweep: acknowledged at ${cmd.executedAt.toISOString()} but ` +
      `status was still ${cmd.status}. Treated as a timeout for the status ` +
      `field; the acknowledgement timestamp is preserved.`
    : `Reconciled by sweep: no acknowledgement ${Math.round(ageMs / 1000)}s after ` +
      `issuance. No device response was ever recorded for this command.`;

  return {
    shouldReconcile: true,
    toStatus: "TIMEOUT",
    reason: executedButUnrecorded ? "EXECUTED_WITHOUT_TIMESTAMP" : "NO_ACKNOWLEDGEMENT",
    note,
  };
}

/** Compose the `reason` string persisted on the row. */
export function reconciliationReasonText(
  decision: ReconciliationDecision,
  cmd: ReconcilableCommand,
): string {
  return `${decision.reason}: ${decision.note}`;
}

/**
 * Select the rows a sweep should consider.
 *
 * Exported so the tenant loop and the tests share ONE definition of "stale
 * candidate" rather than each inventing a filter that can drift.
 */
export function staleCandidates(
  cmds: readonly ReconcilableCommand[],
  now: Date,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): ReconcilableCommand[] {
  return cmds.filter(
    (c) =>
      (NON_TERMINAL_STATUSES as readonly string[]).includes(c.status) &&
      now.getTime() - c.issuedAt.getTime() >= staleAfterMs,
  );
}