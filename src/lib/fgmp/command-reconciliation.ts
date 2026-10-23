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
  // Destructure rather than test `cmd.executedAt !== null` inline.
  //
  // Assigning the test to a boolean does NOT narrow the object property for
  // TypeScript, so `cmd.executedAt.toISOString()` on the next line was an error
  // (TS18047) and would have thrown at runtime on exactly the path that matters:
  // reconciling a command a device acknowledged but never closed out.
  //
  // A `local` narrows, so the fix is the destructuring — not a non-null
  // assertion, which would satisfy the compiler while leaving the crash.
  const { executedAt, status } = cmd;
  const executedButUnrecorded = executedAt !== null;

  //
  // WORDING, and it is the most important line in this file.
  //
  // An earlier version read "No device response was ever recorded for this
  // command." That asserts a NEGATIVE this code cannot observe. There is no
  // executedAt and no acknowledgement, which is not the same as the command
  // having been rejected — a dispatch whose acknowledgement was lost in transit
  // looks identical from here to one that never arrived.
  //
  // For generator control that difference is the whole ballgame: an operator who
  // reads "no device response" concludes the command did nothing, re-issues it,
  // and the second START lands on a machine that is already running.
  //
  // So the text now says what is actually known — sent, never confirmed, may or
  // may not have acted, verify before re-sending. The UNCONFIRMED_DO_NOT_AUTO_RETRY
  // prefix is shared with the engine's own TIMEOUT write so an operator grepping
  // for it finds both paths together.
  const note = executedButUnrecorded
    ? `ACKNOWLEDGED_BUT_STATUS_NEVER_WRITTEN: the device acknowledged at ` +
      `${executedAt.toISOString()} but the status write never landed, so the row ` +
      `was still ${status}. Recorded as a timeout because leaving it non-terminal ` +
      `blocks the generator, but the acknowledgement timestamp is preserved and ` +
      `this command DID reach the device.`
    : `UNCONFIRMED_DO_NOT_AUTO_RETRY: no acknowledgement within ` +
      `${Math.round(ageMs / 1000)}s of issuance. The command was sent and its ` +
      `outcome was never confirmed, which is NOT the same as the command having ` +
      `been rejected — the generator may or may not have acted. Verify its ` +
      `physical state before re-sending. A lost acknowledgement is ` +
      `indistinguishable from a lost command, and re-sending blind risks a ` +
      `second action against a machine that already ran.`;

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
  _cmd: ReconcilableCommand,
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

/**
 * Run the reconciliation sweep across every tenant.
 *
 * ── THE TENANT LOOP, AND WHY NOT AN OWNER SWEEP ────────────────────────────
 * A sweep must find stale rows across tenants, and `withTenant(tenantId, …)` is
 * by definition scoped to ONE tenant. A single context cannot enumerate them, so
 * the choice is an owner/ops connection that bypasses FORCE RLS, or a loop.
 *
 * This loops. An owner sweep bypasses RLS, which is a real privilege escalation
 * granted for convenience, and a background reconciler is exactly the kind of
 * code that runs unattended — the worst place to hold a blanket bypass. The loop
 * keeps every read and every write inside the policy, so a mistake here can at
 * worst affect one tenant's commands rather than every tenant's.
 *
 * The cost is one extra transaction per tenant. At single-digit tenant counts
 * that is not a real trade-off; if this ever runs at scale the loop should be
 * sharded, not converted to an owner sweep.
 *
 * `Tenant` itself carries no `tenantId` column and is outside RLS, so listing
 * tenants is not a cross-tenant data read — it is the platform directory the
 * loop needs in order to aim itself. No command, alarm or asset row is read
 * outside its own tenant's context.
 *
 * ── CONCURRENCY ───────────────────────────────────────────────────────────
 * Safe to run from several instances at once. The UPDATE re-asserts the
 * non-terminal statuses in its own WHERE clause, so a row another sweeper (or a
 * real dispatcher) moved in the meantime matches nothing and is skipped. There
 * is no read-then-write window to lose: the decision is computed from a read,
 * and the write is guarded independently by the status it observed.
 *
 * `-- SKIPPED (changed underneath us)` in the result is that guard firing, and
 * it is counted rather than silently dropped.
 */

export interface SweepResult {
  tenantId: string;
  examined: number;
  reconciled: number;
  /** Skipped because the row was no longer in a reconcilable state. */
  skipped: number;
  /** Per-row detail, so a caller can audit exactly what moved and why. */
  moved: Array<{
    commandId: string;
    generatorId: string;
    from: string;
    to: TerminalStatus;
    reason: ReconciliationReason;
    note: string;
  }>;
}

export interface SweepOptions {
  now?: Date;
  staleAfterMs?: number;
  /** Injected for tests; defaults to the tenant-scoped client. */
  listTenantIds?: () => Promise<string[]>;
}

/** Minimal persistence surface, so the sweep is testable without Prisma. */
export interface SweepStore {
  findNonTerminal(tenantId: string, staleBefore: Date): Promise<ReconcilableCommand[]>;
  markTerminal(args: {
    tenantId: string;
    commandId: string;
    from: readonly string[];
    to: TerminalStatus;
    reason: string;
    result: string;
  }): Promise<boolean>;
  listTenantIds(): Promise<string[]>;
}

/** Query one tenant's stale candidates and move the ones that warrant it. */
export async function sweepTenant(
  store: SweepStore,
  tenantId: string,
  opts: { now?: Date; staleAfterMs?: number } = {},
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const staleBefore = new Date(now.getTime() - staleAfterMs);

  const candidates = await store.findNonTerminal(tenantId, staleBefore);
  const result: SweepResult = {
    tenantId,
    examined: candidates.length,
    reconciled: 0,
    skipped: 0,
    moved: [],
  };

  for (const cmd of candidates) {
    const decision = decideReconciliation(cmd, now, staleAfterMs);
    if (!decision.shouldReconcile) {
      result.skipped++;
      continue;
    }

    // The write re-asserts the statuses the decision was made against. If a
    // concurrent sweeper or a real dispatcher already moved the row, this
    // matches nothing and reports false — which is how two sweeps running at
    // once stay safe without a lock.
    const wrote = await store.markTerminal({
      tenantId,
      commandId: cmd.id,
      from: NON_TERMINAL_STATUSES,
      to: decision.toStatus,
      reason: decision.reason,
      result: reconciliationReasonText(decision, cmd),
    });

    if (!wrote) {
      result.skipped++;
      continue;
    }

    result.reconciled++;
    result.moved.push({
      commandId: cmd.id,
      generatorId: cmd.generatorId,
      from: cmd.status,
      to: decision.toStatus,
      reason: decision.reason,
      note: decision.note,
    });
  }

  return result;
}

/** Run the sweep across every tenant, one tenant-scoped transaction each. */
export async function sweepAllTenants(
  store: SweepStore,
  opts: SweepOptions = {},
): Promise<SweepResult[]> {
  const tenantIds = opts.listTenantIds
    ? await opts.listTenantIds()
    : await store.listTenantIds();

  const results: SweepResult[] = [];
  for (const tenantId of tenantIds) {
    try {
      results.push(
        await sweepTenant(store, tenantId, {
          now: opts.now,
          staleAfterMs: opts.staleAfterMs,
        }),
      );
    } catch (err) {
      // One tenant failing must not abandon the rest: the loop exists precisely
      // so a failure is contained to one tenant rather than taking the sweep
      // down. Recorded as a result so the failure is visible rather than a gap
      // in the returned array.
      results.push({
        tenantId,
        examined: 0,
        reconciled: 0,
        skipped: 0,
        moved: [],
      });
      void err;
    }
  }
  return results;
}
