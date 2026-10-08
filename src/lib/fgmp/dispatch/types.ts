/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GENERATOR DISPATCH — the boundary between "simulated" and "real"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Until now, `engine.applyCommand` mutated in-process memory and recorded a
 * result. Everything built around it — interlocks, idempotency, reconciliation,
 * per-generator locking — is real, but the thing at the centre was not: nothing
 * ever communicated with a generator.
 *
 * This module is that centre, made explicit and swappable.
 *
 * ── WHY A BOUNDARY RATHER THAN A BRANCH INSIDE THE ENGINE ─────────────────
 * A conditional in applyCommand is invisible: you cannot tell from a diff whether
 * a command reached hardware. An interface makes the boundary greppable, makes
 * the no-transport case a first-class outcome rather than a silent success, and
 * means an implementation can be swapped without touching the safety layer.
 *
 * ── WHY NO_TRANSPORT IS AN OUTCOME AND NOT AN ERROR ────────────────────────
 * "No transport is wired" is the expected state of this deployment, not an
 * exception. It has to be REPORTABLE, because an operator who issued a START and
 * got no confirmation must be able to discover it was never attempted.
 */

export type DispatchOutcomeKind =
  /** A device answered and confirmed. The ONLY outcome that may say "it ran". */
  | "EXECUTED"
  /** Attempted and the device or the bus rejected it. */
  | "FAILED"
  /** Nothing is wired. The command was accepted but never reached a device. */
  | "NO_TRANSPORT"
  /**
   * We do not know whether it landed.
   *
   * NOT the same semantics as a notification-layer TIMEOUT, and deliberately not
   * reused: a notification timeout means "probably not delivered", and resending
   * is safe because the recipient deduplicates. A control timeout means "we do
   * not know whether an engine was told to start", and resending is NOT
   * obviously safe — a second START against a set that already started is a
   * different command with different consequences. So this outcome always carries
   * `retrySafe: false` and a human decides.
   */
  | "TIMEOUT_AMBIGUOUS";

/**
 * Evidence that a device actually acknowledged.
 *
 * Required for EXECUTED. Optional for everything else, and its presence is the
 * only thing separating "it ran" from "we assumed it ran".
 */
export interface DispatchAcknowledgement {
  /** Which transport carried it — recorded so an audit can name the path. */
  transport: string;
  /** Epoch ms the acknowledgement was received. */
  at: number;
  /** Optional device-supplied detail (register value, exception code). */
  detail?: string;
}

export interface DispatchOutcome {
  kind: DispatchOutcomeKind;
  /**
   * MUST be present when kind === "EXECUTED".
   *
   * Constructing an outcome is not receiving an acknowledgement. This field
   * exists so that distinction is representable, and
   * dispatch-safety.contract.ts asserts it cannot be forgotten.
   */
  acknowledgement?: DispatchAcknowledgement;
  /** Why, for FAILED / NO_TRANSPORT / TIMEOUT_AMBIGUOUS. */
  reason?: string;
  /**
   * Whether re-sending the same command is safe. False for TIMEOUT_AMBIGUOUS by
   * construction: a human decides.
   */
  retrySafe?: boolean;
}

export type GeneratorCommandName = "START" | "STOP" | "EMERGENCY_STOP" | "RESET";

export interface DispatchRequest {
  command: GeneratorCommandName;
  /** The generator being commanded. */
  generatorId: string;
  /** Opaque addressing for a real transport (unit id, register map, …). */
  target?: Record<string, unknown>;
  /** Epoch ms. Injected so outcomes are deterministic under test. */
  now?: number;
}

export interface GeneratorDispatch {
  /** Identifies the implementation in logs and audit rows. */
  readonly name: string;
  /**
   * Issue one command.
   *
   * Must NEVER resolve to EXECUTED unless an acknowledgement was actually
   * received from a transport.
   */
  dispatch(req: DispatchRequest): Promise<DispatchOutcome>;
  /** Optional release of transport resources. */
  close?(): Promise<void>;
}

/** Narrow an outcome to EXECUTED, throwing if it is not. */
export function requireExecuted(o: DispatchOutcome): DispatchAcknowledgement {
  if (o.kind !== "EXECUTED" || !o.acknowledgement) {
    throw new Error(
      `requireExecuted called on a ${o.kind} outcome. This is the bug the ` +
        `contract test exists to prevent: EXECUTED without an acknowledgement.`,
    );
  }
  return o.acknowledgement;
}

/**
 * Fail loudly rather than fabricate.
 *
 * A dispatch that cannot reach hardware returns NO_TRANSPORT with a reason that
 * says so in plain words. It does not return EXECUTED, does not return FAILED
 * (nothing was attempted, so nothing failed), and does not throw — throwing would
 * turn an expected configuration state into a 500.
 */
export function noTransport(implName: string, reason: string): DispatchOutcome {
  return {
    kind: "NO_TRANSPORT",
    reason: `${implName}: ${reason}`,
    retrySafe: true,
  };
}

/** TIMEOUT_AMBIGUOUS. Always `retrySafe: false` — see DispatchOutcomeKind. */
export function timeoutAmbiguous(implName: string, reason: string): DispatchOutcome {
  return {
    kind: "TIMEOUT_AMBIGUOUS",
    reason: `${implName}: ${reason}`,
    retrySafe: false,
  };
}

/** FAILED: attempted and rejected, with the device's reason. */
export function failed(implName: string, reason: string, detail?: string): DispatchOutcome {
  return {
    kind: "FAILED",
    reason: `${implName}: ${reason}`,
    retrySafe: true,
    acknowledgement: detail
      ? { transport: implName, at: 0, detail }
      : undefined,
  };
}