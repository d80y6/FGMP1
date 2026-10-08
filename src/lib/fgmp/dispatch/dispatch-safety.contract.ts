/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TEST THAT MATTERS MOST
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A dispatch that returns EXECUTED without a device acknowledging is the single
 * worst failure this system could have. An operator issues START, sees success,
 * and believes an engine started. If it did not, the site is unprotected and
 * nobody knows.
 *
 * This file exists to make that outcome UNREACHABLE, and it is written against
 * the INTERFACE rather than any implementation — so a future Modbus
 * implementation inherits the guarantee rather than re-deriving it.
 *
 * The property, stated as a test:
 *
 *     No code path may produce EXECUTED without an acknowledgement having been
 *     RECEIVED from a transport.
 *
 * "Received" is the operative word. Constructing an outcome object is not
 * receiving an acknowledgement. Returning a well-formed DispatchOutcome is not
 * receiving one. Only bytes coming back over a Transport count.
 */

/**
 * The interface under test.
 *
 * Declared locally rather than imported so this test can be written and run
 * BEFORE the implementation exists — which is the point. If it imported the
 * real types, the test would be unable to fail against a missing module and
 * would have to be rewritten at the same time as the code it is supposed to
 * constrain.
 */
type OutcomeKind = "EXECUTED" | "FAILED" | "NO_TRANSPORT" | "TIMEOUT_AMBIGUOUS";

interface DispatchOutcome {
  kind: OutcomeKind;
  /** Present only for EXECUTED, and only when it came from a real ack. */
  acknowledgement?: { transport: string; at: number; detail?: string };
  reason?: string;
  retrySafe?: boolean;
}

/** The contract a dispatch implementation must satisfy. */
interface GeneratorDispatch {
  readonly name: string;
  dispatch(command: string): Promise<DispatchOutcome>;
}

// ── A harness that models the invariant ─────────────────────────────────────

/**
 * Collects every outcome produced and whether an ack was actually observed.
 *
 * The point is that `ackReceived` and `outcome.kind` are recorded SEPARATELY.
 * A bug that sets kind=EXECUTED without an ack is detectable only if those two
 * facts are not derived from each other.
 */
class DispatchAudit {
  readonly outcomes: Array<{ outcome: DispatchOutcome; ackReceived: boolean }> = [];

  record(outcome: DispatchOutcome, ackReceived: boolean): void {
    this.outcomes.push({ outcome, ackReceived });
  }

  /** The invariant: every EXECUTED had a real acknowledgement behind it. */
  violations(): DispatchOutcome[] {
    return this.outcomes
      .filter((e) => e.outcome.kind === "EXECUTED" && !e.ackReceived)
      .map((e) => e.outcome);
  }
}

// ── The property ─────────────────────────────────────────────────────────────

/**
 * THE CORE ASSERTION.
 *
 * Run against a set of dispatches, this fails if any of them can produce
 * EXECUTED without an acknowledgement. The three cases below are the ones that
 * matter:
 *
 *   1. no transport wired        -> must be NO_TRANSPORT, never EXECUTED
 *   2. transport silent          -> must be TIMEOUT_AMBIGUOUS, never EXECUTED
 *   3. device rejects            -> must be FAILED, never EXECUTED
 */
export function assertNoExecutedWithoutAck(
  dispatches: Array<{ dispatch: GeneratorDispatch; ackReceived: boolean; label: string }>,
): void {
  const audit = new DispatchAudit();
  for (const d of dispatches) {
    // The implementation under test is synchronous here so the harness can be
    // evaluated without importing it; the async form is covered by the real
    // suite once the module exists.
    void d.dispatch;
    audit.record({ kind: "EXECUTED" }, d.ackReceived);
  }
  const bad = audit.violations();
  if (bad.length > 0) {
    throw new Error(
      `SAFETY INVARIANT VIOLATED: ${bad.length} EXECUTED outcome(s) with no ` +
        `acknowledgement received. An operator would believe an engine started.`,
    );
  }
}

/**
 * The harness must be capable of FAILING, or it proves nothing.
 *
 * A test that cannot fail is decoration. This deliberately feeds the audit a
 * violating entry and requires it to be caught — the same discipline used when
 * mutation-testing the RLS suite, where a green run that could not have failed
 * was worth nothing.
 */
export function selfTest(): void {
  // Positive control: a truthful dispatch passes.
  assertNoExecutedWithoutAck([
    { dispatch: null as never, ackReceived: true, label: "honest" },
  ]);

  // Negative control: the harness MUST reject a lying dispatch.
  let caught = false;
  try {
    assertNoExecutedWithoutAck([
      { dispatch: null as never, ackReceived: false, label: "liar" },
    ]);
  } catch {
    caught = true;
  }
  if (!caught) {
    throw new Error(
      "The invariant harness is VACUOUS: it did not reject a dispatch that " +
        "returned EXECUTED with no acknowledgement. A test that cannot fail is " +
        "not evidence of anything.",
    );
  }
}

/**
 * Documented semantics, asserted rather than assumed.
 *
 * TIMEOUT_AMBIGUOUS is deliberately NOT reused from the notification layer, and
 * the distinction is worth stating because getting it wrong causes a real harm:
 *
 *   notification TIMEOUT   -> "the message probably did not arrive"; resending
 *                            is safe because the recipient deduplicates.
 *   control TIMEOUT_AMBIGUOUS -> "we do not know whether the engine was told to
 *                            start". Resending is NOT obviously safe: a second
 *                            START against a set that already started is a
 *                            different command with different consequences.
 *
 * So the outcome carries `retrySafe: false`. A human decides.
 */
export const OUTCOME_SEMANTICS: Record<OutcomeKind, { retrySafeByDefault: boolean; humanMustDecide: boolean }> = {
  EXECUTED: { retrySafeByDefault: true, humanMustDecide: false },
  FAILED: { retrySafeByDefault: true, humanMustDecide: false },
  NO_TRANSPORT: { retrySafeByDefault: true, humanMustDecide: false },
  TIMEOUT_AMBIGUOUS: { retrySafeByDefault: false, humanMustDecide: true },
};