/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GENERATOR CONTROL INTERLOCKS — declarative rule definitions
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SAFETY-CRITICAL. Read this before changing anything here.
 *
 * An interlock is a precondition that REFUSES a control command. If it only
 * warns, it is not an interlock. `evaluateInterlocks` in ./interlocks.ts is
 * the only thing allowed to decide, and `enforceInterlock` is the only thing
 * allowed to refuse at the command boundary.
 *
 * ── WHY RULES ARE DATA ──────────────────────────────────────────────────────
 * Every rule below is a record, not an if-statement. Two reasons:
 *
 *   1. It is AUDITABLE. An operator asking "why was my command refused?" gets
 *      a stable rule id (`COOLANT_HOT_AT_ASSUME_LOAD`) that maps to a row in
 *      the audit trail. A rule buried in a conditional cannot be enumerated,
 *      reviewed, or tested exhaustively.
 *   2. It is TESTABLE WITHOUT A DATABASE. `interlocks.test.ts` exercises all of
 *      them against plain objects. Safety logic that can only be tested by
 *      booting Postgres is safety logic that does not get tested.
 *
 * ── HARD vs SOFT ────────────────────────────────────────────────────────────
 *
 * HARD  The command is refused. Continuing risks equipment damage, a
 *       blackout, or an unsafe electrical state.
 *
 * SOFT  The command is permitted and a warning is attached. Used where
 *       refusing would be MORE dangerous than proceeding — the canonical case
 *       is EMERGENCY_STOP, which must never be blocked because some
 *       precondition looks wrong. A soft interlock still returns a reason so
 *       the condition is recorded and reviewable.
 *
 * ── THRESHOLDS: WHAT IS ENGINEERING, WHAT IS INFERRED ───────────────────────
 *
 * This file contains NO threshold that comes from a manufacturer datasheet, an
 * IEC/ISO standard, or the original platform specification. None was supplied.
 * Every number below is either (a) a deliberately conservative placeholder that
 * fails safe, or (b) a structural zero. They are collected in
 * `NEEDS_OPERATOR_CONFIRMATION` at the bottom so none of them can be mistaken
 * for an engineering standard. They MUST be confirmed against real equipment
 * before this gate controls anything in production.
 *
 * The failure direction matters: these thresholds all DENY, so a wrong value
 * fails toward refusing a command, never toward permitting an unsafe one.
 */

/** Machine-readable rule identifiers. Stable — these appear in audit records. */
export type InterlockRuleId =
  // Hard
  | "COOLANT_HOT_AT_ASSUME_LOAD"
  | "OIL_PRESSURE_LOW"
  | "NOT_READY_TO_ASSUME_LOAD"
  | "FUEL_BELOW_CRANKING_THRESHOLD"
  | "COMMAND_ALREADY_IN_FLIGHT"
  | "CONFLICTING_COMMAND_IN_FLIGHT"
  | "RESTART_BACKOFF_ACTIVE"
  | "COOLDOWN_ACTIVE"
  | "MAINTENANCE_LOCKOUT"
  | "CRITICAL_LOAD_SHED"
  | "SHED_BELOW_SITE_REQUIREMENT"
  | "GENERATOR_OFFLINE"
  | "IN_SERVICE_OVERDUE"
  // Soft
  | "OVERDUE_SERVICE_WARNING"
  | "NEAR_CRITICAL_FUEL"
  | "HIGH_EXISTING_LOAD"
  | "REMOTE_MODE_NOT_SET";

/** HARD refuses the command. SOFT permits it and attaches a warning. */
export type InterlockSeverity = "HARD" | "SOFT";

/**
 * Authorization tier for a rule.
 *
 * OPERATOR  any role holding ROLES.CONTROL.
 * TWO_PERSON additionally requires an explicit, separately-recorded override
 *           by a second, higher-authority actor. See ./interlocks.ts.
 */
export type InterlockAuthority = "OPERATOR" | "TWO_PERSON";

export type ControlCommandName = "START" | "STOP" | "EMERGENCY_STOP" | "RESET";

/**
 * The generator state an interlock may inspect.
 *
 * A structural subset of `GenState` (src/lib/fgmp/types.ts) chosen so the
 * rules can be unit-tested against literals. `now` is injected rather than read
 * from Date.now() so cooldown/backoff arithmetic is deterministic in tests —
 * a time-dependent safety rule that cannot be tested at its boundary is a rule
 * nobody can trust.
 */
export interface InterlockGeneratorState {
  id: string;
  /** Needed to resolve the owning site's fuel and protected-load context. */
  siteId: string;
  status: string;
  mode: string;
  runtimeHours: number;
  temperatureC: number;
  oilPressureKpa: number;
  loadKw: number;
  ratedPowerKw: number;
  oilChangeIntervalHrs: number;
  nextMaintenanceHrs: number;
  lastStartedAt?: number;
  lastStoppedAt?: number;
  /** Epoch ms until which a latched FAULT is considered live. */
  faultUntil?: number;
}

export interface InterlockSiteState {
  id: string;
  criticality: string;
  loadKw: number;
  gridAvailable: boolean;
}

/** Per-command conditions a rule may inspect. */
export interface InterlockContext {
  now: number;
  generator: InterlockGeneratorState;
  site: InterlockSiteState;
  /** A command already dispatched to this generator and not yet resolved. */
  commandInFlight?: { id: string; command: string; status: string } | null;
  /** Hours of run accumulated since the last recorded oil change. */
  hoursSinceOilChange: number;
  /**
   * Litres remaining in the tank feeding this generator. Absent when the site
   * has no tank bound — absence must not be read as zero.
   */
  fuelLitres?: number;
  /**
   * Usable capacity of that tank, in litres.
   *
   * REQUIRED for any fuel rule expressed as a fraction of tank capacity. A flat
   * litre threshold cannot be correct across engine displacements — 12 L is
   * trivial for a 2000 kW prime set and absurd for a 6 kW standby set — so
   * cranking and low-fuel limits are percentages and the litre figure is
   * derived at evaluation time. Absent when the site has no usable capacity
   * modelled; a rule that needs it declines rather than substituting a guess.
   */
  tankCapacityLitres?: number;
  /**
   * Load that must remain energised for this site regardless of generation
   * state — the protected/critical load floor. Never shed below this.
   */
  protectedLoadKw?: number;
  /**
   * Thresholds resolved for the acting tenant — merged over the shipped
   * defaults by ./interlock-thresholds.ts. Optional only so that a rule can be
   * unit-tested with a bare literal; `thresholdsOf` falls back to the
   * conservative defaults when it is absent, never to `undefined`.
   */
  thresholds?: ResolvedThresholds;
  /**
   * Whether `thresholds` came from the tenant's stored rows or from the shipped
   * defaults.
   *
   * Carried so a refusal is attributed to the right limit. A denial recorded
   * against the hardcoded 85 °C when the operator confirmed 120 °C is an
   * INACCURATE audit record, not merely an incomplete one — an incident review
   * would conclude the wrong limit was enforced.
   */
  thresholdsFromDatabase?: boolean;
  /**
   * PHASE 5: set by the enforcement layer when the only in-flight command for
   * this generator is the SAME command being re-submitted, within the idempotency
   * window.
   *
   * A duplicate START must not re-dispatch, but it is also not a conflict the
   * operator needs blocked — a retry after a dropped response is legitimate. The
   * in-flight rules consult this so a replay is reported as a replay rather than
   * refused as a race, and the caller does not act on it twice.
   */
  idempotentReplay?: boolean;
  /**
   * The command being evaluated.
   *
   * Set by `evaluateInterlocks` before any rule runs, so a rule can compare the
   * REQUESTED command against an in-flight one. The idempotency flag is not
   * sufficient on its own: without the requested command, "this is a replay"
   * cannot be distinguished from "this is a different command that happens to
   * carry the replay flag", and the second case is a race the interlock exists
   * to stop.
   */
  command?: ControlCommandName;
}

/**
 * A single declarative rule.
 *
 * `evaluate` returns null when the rule does not apply or does not fire, and
 * an explanation when it does. Returning null rather than a boolean keeps
 * warnings and denials in one shape and makes "no opinion" explicit.
 */
export interface InterlockRule {
  id: InterlockRuleId;
  severity: InterlockSeverity;
  /** Commands this rule applies to. Empty array = all commands. */
  appliesTo: readonly ControlCommandName[];
  /** Human-readable explanation, shown to operators and stored on the audit row. */
  explanation: string;
  /** Short operator guidance. */
  remedy: string;
  /** Override tier. TWO_PERSON rules cannot be cleared by one operator. */
  authority: InterlockAuthority;
  evaluate: (ctx: InterlockContext) => string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THRESHOLDS — inferred, not from a specification. See the header.
// ─────────────────────────────────────────────────────────────────────────────

// Phase 4: threshold VALUES live in ./interlock-thresholds.ts, where each one
// carries its provenance and can be overridden per tenant without a deploy.
// A rule reads them through `thresholdsOf(ctx)`, so no rule can physically use
// a value an operator has overridden.
export {
  DEFAULT_THRESHOLDS as THRESHOLDS,
  describeThresholds,
  resolveThresholds,
  minutesToMs,
} from "./interlock-thresholds";
import {
  DEFAULT_THRESHOLDS,
  resolveThresholds,
  minutesToMs,
} from "./interlock-thresholds";
import type { ResolvedThresholds, ThresholdKey } from "./interlock-thresholds";

/**
 * The thresholds a rule must evaluate against.
 *
 * Every rule reads numbers through this and never through a bare constant, so
 * an operator override cannot be silently bypassed by a rule that hard-coded
 * one. When the context carries no resolved set — a unit test with a literal,
 * or an emergency path that must not fail closed — the shipped INFERRED
 * defaults apply. Those defaults all DENY, so that fallback is the safe
 * direction: it over-refuses rather than over-permits.
 */
const FALLBACK_THRESHOLDS = resolveThresholds([]);
export const thresholdsOf = (ctx: InterlockContext): ResolvedThresholds =>
  ctx.thresholds ?? FALLBACK_THRESHOLDS;

/** The value a threshold currently resolves to, with its provenance intact. */
export const thresholdValueOf = <K extends ThresholdKey>(
  ctx: InterlockContext,
  key: K,
): number => thresholdsOf(ctx).values[key];

// Kept so a rule author writing `DEFAULT_THRESHOLDS.x.value` in a test has a
// single obvious place to look; it is NOT the path rules take.
void DEFAULT_THRESHOLDS;
const HARD_RULES: InterlockRule[] = [
  {
    id: "GENERATOR_OFFLINE",
    severity: "HARD",
    appliesTo: [],
    authority: "OPERATOR",
    explanation: "Generator is OFFLINE — no control path to the set.",
    remedy: "Restore communications before issuing commands.",
    evaluate: ({ generator }) =>
      generator.status === "OFFLINE"
        ? "The generator reports OFFLINE; a remote command cannot reach it."
        : null,
  },
  {
    id: "MAINTENANCE_LOCKOUT",
    severity: "HARD",
    appliesTo: ["START", "RESET"],
    authority: "TWO_PERSON",
    explanation: "Generator is in MAINTENANCE — locked out for service.",
    remedy:
      "Clear the maintenance lockout after the work is complete; an override requires two-person authorization.",
    evaluate: ({ generator }) =>
      generator.status === "MAINTENANCE"
        ? "The set is locked out for maintenance and must not be started."
        : null,
  },
  {
    id: "FUEL_BELOW_CRANKING_THRESHOLD",
    severity: "HARD",
    appliesTo: ["START"],
    authority: "OPERATOR",
    explanation:
      "Fuel level is below the cranking threshold — the engine cannot reliably start and reach idle.",
    remedy:
      "Refuel before starting. Starting an engine that cannot sustain idle drops the site load mid-crank.",
    evaluate: (ctx) => {
      const { generator, fuelLitres, tankCapacityLitres } = ctx;
      if (generator.status === "RUNNING") return null;

      // ── PHASE 5: THIS NOW DENIES INSTEAD OF PERMITTING ──────────────────
      // It previously returned null for both absent fuel and absent capacity.
      // `null` means "the rule does not fire", and a rule that does not fire
      // PERMITS. Verified before the fix:
      //
      //     fuel = 0.1 L, capacity UNKNOWN -> allowed = TRUE   <- fail-open
      //     fuel = 0.1 L, capacity = 0      -> allowed = TRUE   <- fail-open
      //
      // The old comment justified this as "uncomputable, so the rule declines
      // rather than guessing". That is correct about not INVENTING A NUMBER
      // and wrong about what the rule should DO. Declining the CHECK is the
      // opposite of fail-safe: an unknown tank capacity silently became a
      // licence to crank an engine that may be running on fumes.
      //
      // A missing tank reading is now also a DENIAL rather than a pass. The
      // earlier concern — refusing every start on a site with no telemetry
      // would be a denial-of-service the operator cannot fix — is answered by
      // the remedy text: the operator is told exactly what to do, and the
      // condition is one they can clear. An interlock they cannot act on is
      // not usable either.
      if (fuelLitres === undefined || fuelLitres === null) {
        return (
          "Fuel level cannot be read for this site, so the cranking-fuel check " +
          "cannot be satisfied. Refusing to start on an unmeasured fuel state."
        );
      }
      if (!tankCapacityLitres || tankCapacityLitres <= 0) {
        return (
          "Tank capacity is unknown for this site, so the cranking-fuel " +
          "threshold (a percentage of capacity) cannot be computed. Declare " +
          "the tank capacity to enable remote start."
        );
      }
      const pct = thresholdsOf(ctx).values.crankingFuelFractionPct;
      const requiredLitres = (pct / 100) * tankCapacityLitres;
      return fuelLitres < requiredLitres
        ? `Only ${fuelLitres.toFixed(1)} L remain of ${tankCapacityLitres.toFixed(0)} L usable ` +
          `(${((fuelLitres / tankCapacityLitres) * 100).toFixed(1)}%), below the ${pct}% ` +
          `(${requiredLitres.toFixed(1)} L) cranking threshold.`
        : null;
    },
  },
  {
    id: "IN_SERVICE_OVERDUE",
    severity: "HARD",
    appliesTo: ["START"],
    authority: "TWO_PERSON",
    explanation: "Scheduled service is overdue — running risks engine failure and loss of site power.",
    remedy:
      "Complete the service first. Continuing to run an overdue engine can fail it under load, which is worse than not starting.",
    evaluate: ({ generator }) => {
      if (generator.status === "RUNNING") return null;
      return generator.nextMaintenanceHrs <= 0
        ? `Service is overdue by ${Math.abs(generator.nextMaintenanceHrs).toFixed(1)} run-hours.`
        : null;
    },
  },
  {
    id: "COOLANT_HOT_AT_ASSUME_LOAD",
    severity: "HARD",
    appliesTo: ["START"],
    authority: "OPERATOR",
    explanation: "Coolant temperature is too high to accept load.",
    remedy: "Allow the set to cool, or investigate the cooling system.",
    evaluate: (ctx) => {
      const { generator } = ctx;
      const limit = thresholdsOf(ctx).values.coolantMaxC;
      return generator.temperatureC > limit
        ? `Coolant is ${generator.temperatureC.toFixed(1)} °C, above the ${limit} °C assume-load limit.`
        : null;
    },
  },
  {
    id: "OIL_PRESSURE_LOW",
    severity: "HARD",
    appliesTo: ["START"],
    authority: "OPERATOR",
    explanation: "Oil pressure is below the safe operating minimum.",
    remedy: "Investigate the lubrication system before starting.",
    evaluate: (ctx) => {
      const { generator } = ctx;
      const min = thresholdsOf(ctx).values.oilPressureMinKpa;
      return generator.oilPressureKpa < min
        ? `Oil pressure is ${generator.oilPressureKpa.toFixed(0)} kPa, below the ${min} kPa minimum.`
        : null;
    },
  },
  {
    id: "NOT_READY_TO_ASSUME_LOAD",
    severity: "HARD",
    appliesTo: ["START"],
    authority: "OPERATOR",
    explanation: "The generator is already RUNNING — it is carrying load.",
    remedy: "No start is required while the set is running.",
    evaluate: ({ generator }) =>
      generator.status === "RUNNING" ? "The generator is already running and carrying load." : null,
  },
  {
    id: "COMMAND_ALREADY_IN_FLIGHT",
    severity: "HARD",
    appliesTo: [],
    authority: "OPERATOR",
    explanation: "A control command is already in flight for this generator.",
    remedy: "Wait for the outstanding command to resolve before issuing another.",
    // PHASE 5: a same-command re-submission inside the idempotency window is a
    // RETRY, not a second command. Refusing it as a race would break a
    // legitimate retry after a dropped response; dispatching it again is the
    // hazard. The enforcement layer recognises it as already applied and skips
    // the dispatch, so this rule must stop claiming a conflict.
    evaluate: ({ commandInFlight, idempotentReplay }) =>
      commandInFlight && !idempotentReplay
        ? `Command ${commandInFlight.id} (${commandInFlight.command}) is still ${commandInFlight.status}; a second command would race it.`
        : null,
  },
  {
    id: "CONFLICTING_COMMAND_IN_FLIGHT",
    severity: "HARD",
    appliesTo: ["START", "STOP"],
    authority: "OPERATOR",
    explanation: "A conflicting control command is already in flight.",
    remedy: "Wait for the outstanding command to resolve.",
    evaluate: ({ generator, commandInFlight, idempotentReplay, command }) => {
      if (!commandInFlight) return null;
      // PHASE 5: the replay flag is only honoured when the in-flight command is
      // the SAME intent. `command` is not currently in InterlockContext, so the
      // rule falls back to comparing the CONFLICT itself rather than the flag —
      // a blanket `if (idempotentReplay) return null` here would let a START slip
      // past an in-flight STOP, which is the exact race this rule exists to stop.
      //
      // If the requested command matches the in-flight one, there is no conflict
      // to report: it is a retry, and the enforcement layer will not dispatch it
      // twice.
      const sameIntent = idempotentReplay && command === commandInFlight.command;
      if (generator.status === "RUNNING") {
        // A running set with a STOP in flight: only a START conflicts, and only
        // when the retry is NOT the same command.
        return commandInFlight.command === "STOP" && !sameIntent
          ? `A STOP (${commandInFlight.id}) is already in flight; issuing START would race it.`
          : null;
      }
      return commandInFlight.command === "START" && !sameIntent
        ? `A START (${commandInFlight.id}) is already in flight; issuing ${generator.status === "STOPPED" ? "START" : "a command"} would race it.`
        : null;
    },
  },
  {
    id: "COOLDOWN_ACTIVE",
    severity: "HARD",
    appliesTo: ["START"],
    authority: "OPERATOR",
    explanation: "The generator is within its post-stop cooldown window.",
    remedy:
      "Wait for the cooldown to expire. Restarting a just-stopped diesel causes real wear and can be unsafe on some sets.",
    evaluate: (ctx) => {
      const { now, generator } = ctx;
      if (generator.lastStoppedAt === undefined) return null;
      const elapsed = now - generator.lastStoppedAt;
      if (elapsed < 0) return null;
      const cooldownMinutes = thresholdsOf(ctx).values.cooldownMinutes;
      const cooldownMs = minutesToMs(cooldownMinutes);
      if (elapsed >= cooldownMs) return null;
      const remainSec = Math.ceil((cooldownMs - elapsed) / 1000);
      return `Cooldown active — ${remainSec}s remaining of the ` +
        `${cooldownMinutes}-minute rest period after stop.`;
    },
  },
  {
    id: "RESTART_BACKOFF_ACTIVE",
    severity: "HARD",
    appliesTo: ["START"],
    authority: "TWO_PERSON",
    explanation: "Restart backoff is active after a fault stop.",
    remedy:
      "Diagnose and clear the fault, then wait out the backoff. Overriding requires two-person authorization.",
    evaluate: ({ now, generator }) => {
      if (generator.faultUntil === undefined) return null;
      if (now >= generator.faultUntil) return null;
      if (generator.lastStoppedAt === undefined) return null;
      const remainSec = Math.ceil((generator.faultUntil - now) / 1000);
      return `Restart backoff active for ${remainSec}s after a fault stop; clear the fault first.`;
    },
  },
  {
    id: "CRITICAL_LOAD_SHED",
    severity: "HARD",
    appliesTo: ["STOP"],
    authority: "TWO_PERSON",
    explanation:
      "Shedding this generator would de-energise protected critical load at this site.",
    remedy:
      "Transfer to another source first, or reduce the protected load floor. Overriding requires two-person authorization.",
    evaluate: ({ site, generator }) => {
      // Never refuse an emergency stop on the grounds that it would black out a
      // critical site — that is precisely the situation an emergency stop exists
      // to escape. Only an ORDINARY stop is gated.
      if (generator.status !== "RUNNING") return null;
      if (site.gridAvailable) return null;
      return (
        site.criticality === "CRITICAL" || site.criticality === "HIGH"
          ? `Site ${site.id} is ${site.criticality} with no grid available; stopping this set would shed protected load.`
          : null
      );
    },
  },
  {
    id: "SHED_BELOW_SITE_REQUIREMENT",
    severity: "HARD",
    appliesTo: ["STOP"],
    authority: "TWO_PERSON",
    explanation: "Stopping would leave the site below its minimum required load.",
    remedy:
      "Start an alternative source or lower the site's required load before stopping. Overriding requires two-person authorization.",
    evaluate: ({ site, generator, protectedLoadKw }) => {
      if (generator.status !== "RUNNING") return null;
      const floor = protectedLoadKw ?? 0;
      if (floor <= 0) return null;
      // The generator is currently carrying the site's whole load; stopping it
      // takes the site below the floor.
      return generator.loadKw > 0 && site.gridAvailable === false && floor >= site.loadKw
        ? `Generator is carrying ${generator.loadKw.toFixed(1)} kW against a required floor of ${floor.toFixed(1)} kW with no grid available.`
        : null;
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SOFT RULES — permitted, but the condition is recorded and surfaced.
// ─────────────────────────────────────────────────────────────────────────────

const SOFT_RULES: InterlockRule[] = [
  {
    id: "OVERDUE_SERVICE_WARNING",
    severity: "SOFT",
    appliesTo: [],
    authority: "OPERATOR",
    explanation: "Scheduled service is approaching due.",
    remedy: "Schedule the service; continuing to run shortens engine life.",
    evaluate: (ctx) =>
      ctx.generator.nextMaintenanceHrs > 0 &&
        ctx.generator.nextMaintenanceHrs <= thresholdsOf(ctx).values.serviceWarnHours
        ? `Service is due in ${ctx.generator.nextMaintenanceHrs.toFixed(1)} run-hours.`
        : null,
  },
  {
    id: "NEAR_CRITICAL_FUEL",
    severity: "SOFT",
    appliesTo: [],
    authority: "OPERATOR",
    explanation: "Fuel level is low.",
    remedy: "Arrange refuelling before the next expected run.",
    evaluate: (ctx) => {
      const { fuelLitres, tankCapacityLitres } = ctx;
      // PHASE 5 audit of the second capacity-dependent rule. This one is SOFT,
      // so declining the check cannot permit an unsafe START the way it did for
      // the hard rule — but silence is still the wrong signal here. An operator
      // seeing "fuel state unknown" is better placed than one seeing nothing,
      // and the HARD rule already refuses the start, so this warning is
      // genuinely informational rather than a backstop.
      if (fuelLitres === undefined || fuelLitres === null) {
        return "Fuel level cannot be read for this site; fuel state is unknown.";
      }
      if (!tankCapacityLitres || tankCapacityLitres <= 0) {
        return "Tank capacity is unknown; fuel percentage cannot be computed.";
      }
      const pct = thresholdsOf(ctx).values.lowFuelWarnFractionPct;
      const warnLitres = (pct / 100) * tankCapacityLitres;
      return fuelLitres < warnLitres
        ? `${fuelLitres.toFixed(1)} L remain of ${tankCapacityLitres.toFixed(0)} L usable ` +
          `(${((fuelLitres / tankCapacityLitres) * 100).toFixed(1)}%), below the ${pct}% warning level.`
        : null;
    },
  },
  {
    id: "HIGH_EXISTING_LOAD",
    severity: "SOFT",
    appliesTo: ["START"],
    authority: "OPERATOR",
    explanation: "The set is already at high load relative to its rating.",
    remedy: "Check available headroom before adding further load.",
    evaluate: (ctx) => {
      const { generator } = ctx;
      const pct = thresholdsOf(ctx).values.highLoadFractionPct;
      return generator.ratedPowerKw > 0 &&
        (generator.loadKw / generator.ratedPowerKw) * 100 > pct
        ? `Existing load ${generator.loadKw.toFixed(1)} kW is above ${pct}% of ${generator.ratedPowerKw} kW rating.`
        : null;
    },
  },
  {
    id: "REMOTE_MODE_NOT_SET",
    severity: "SOFT",
    appliesTo: ["START", "STOP"],
    authority: "OPERATOR",
    explanation: "The generator is not in REMOTE mode.",
    remedy:
      "Local mode will not accept remote commands reliably; confirm the set is switched to remote before relying on this action.",
    evaluate: ({ generator }) =>
      generator.mode !== "REMOTE" ? `Generator mode is ${generator.mode}, not REMOTE.` : null,
  },
];

/**
 * Every rule, hard first. Evaluation order matters: the first HARD denial is
 * the reason reported to the operator, so the more fundamental preconditions
 * are ordered before the more specific ones.
 */
export const INTERLOCK_RULES: readonly InterlockRule[] = Object.freeze([
  ...HARD_RULES,
  ...SOFT_RULES,
]);


/**
 * Commands that must never be blocked, whatever the preconditions say.
 *
 * EMERGENCY_STOP is in this set deliberately. An interlock that can prevent an
 * emergency stop is itself a hazard: if the software believes the engine is
 * safe to run, the operator needs to be able to stop it anyway.
 */
export const UNBLOCKABLE_COMMANDS: readonly ControlCommandName[] = ["EMERGENCY_STOP"];

/**
 * Commands that change an electrical state and therefore attract the strictest
 * preconditions. RESET clears a latched fault, so it is treated as an
 * assume-load-adjacent action.
 */
export const STATE_CHANGING_COMMANDS: readonly ControlCommandName[] = [
  "START",
  "RESET",
];
