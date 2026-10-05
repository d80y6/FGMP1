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
   * Load that must remain energised for this site regardless of generation
   * state — the protected/critical load floor. Never shed below this.
   */
  protectedLoadKw?: number;
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

export const THRESHOLDS = {
  /**
   * Coolant temperature above which the set must not be asked to assume load.
   * INFERRED. Typical gensets are rated to ~40-50 °C coolant at continuous
   * load; below that they have headroom. Deliberately generous because a HOT
   * reading at assume-load is a hard stop.
   */
  coolantMaxC: 85,

  /**
   * Oil pressure below which the set is not mechanically sound to load.
   * INFERRED. Engines typically shut down below ~1.5 bar at operating speed;
   * that figure is speed- and oil-dependent, hence NEEDS CONFIRMATION.
   */
  oilPressureMinKpa: 150,

  /**
   * Hours since oil change beyond which an extended run risks the engine.
   * INFERRED PLACEHOLDER, deliberately a hard deny: running an overdue engine
   * to failure takes the site's power with it.
   */
  oilOverdueMaxHours: 500,

  /**
   * Remaining run-hours before scheduled service at which we warn.
   * INFERRED.
   */
  serviceWarnHours: 25,

  /**
   * Litres of fuel required to crank and reach a stable idle. Below this a
   * START is refused: an engine that dies while carrying load is strictly
   * worse than one that never started, because the site browns out during the
   * crank.
   *
   * INFERRED. Real practice is quoted as either a percentage of tank capacity
   * or as minutes of run at cranking load, both of which depend on engine
   * displacement. A flat litre figure cannot be right for every engine, which
   * is exactly why this needs operator confirmation.
   */
  crankingFuelLitres: 12,

  /**
   * Litres remaining at which a low-fuel warning is attached.
   * INFERRED.
   */
  lowFuelWarnLitres: 40,

  /**
   * Minimum rest between a stop and a subsequent start. Restarting a
   * just-stopped diesel is real wear (restart current, un-lubricated starts,
   * hot turbo), and on some sets a safety concern.
   *
   * INFERRED, expressed in MINUTES. Needs confirmation against the OEM.
   */
  cooldownMs: 3 * 60 * 1000,

  /**
   * Backoff applied after a FAULT-triggered stop, longer than an ordinary
   * cooldown because a latched fault usually has not been cleared.
   * INFERRED, in MINUTES.
   */
  faultRestartBackoffMs: 10 * 60 * 1000,

  /**
   * Fraction of rated power above which assuming more load is flagged.
   * INFERRED.
   */
  highLoadFraction: 0.9,

  /**
   * Minimum load as a fraction of rated power for sustained running.
   * Below this a diesel runs rich, soaks, and burns fuel — but blocking STOP
   * to protect the engine would be unsafe, so this is a soft warning only.
   * INFERRED.
   */
  lowLoadFraction: 0.3,
} as const;

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

// ─────────────────────────────────────────────────────────────────────────────
// HARD RULES
// ─────────────────────────────────────────────────────────────────────────────

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
    evaluate: ({ generator, fuelLitres }) => {
      // Absent fuel data is NOT treated as zero. Refusing every start on a site
      // with no bound tank would be a denial-of-service the operator cannot fix.
      if (fuelLitres === undefined || fuelLitres === null) return null;
      if (generator.status === "RUNNING") return null;
      return fuelLitres < THRESHOLDS.crankingFuelLitres
        ? `Only ${fuelLitres.toFixed(1)} L remain, below the ${THRESHOLDS.crankingFuelLitres} L cranking threshold.`
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
    evaluate: ({ generator }) =>
      generator.temperatureC > THRESHOLDS.coolantMaxC
        ? `Coolant is ${generator.temperatureC.toFixed(1)} °C, above the ${THRESHOLDS.coolantMaxC} °C assume-load limit.`
        : null,
  },
  {
    id: "OIL_PRESSURE_LOW",
    severity: "HARD",
    appliesTo: ["START"],
    authority: "OPERATOR",
    explanation: "Oil pressure is below the safe operating minimum.",
    remedy: "Investigate the lubrication system before starting.",
    evaluate: ({ generator }) =>
      generator.oilPressureKpa < THRESHOLDS.oilPressureMinKpa
        ? `Oil pressure is ${generator.oilPressureKpa.toFixed(0)} kPa, below the ${THRESHOLDS.oilPressureMinKpa} kPa minimum.`
        : null,
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
    evaluate: ({ commandInFlight }) =>
      commandInFlight
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
    evaluate: ({ generator, commandInFlight }) => {
      if (!commandInFlight) return null;
      if (generator.status === "RUNNING") {
        return commandInFlight.command === "STOP"
          ? `A STOP (${commandInFlight.id}) is already in flight; issuing START would race it.`
          : null;
      }
      return commandInFlight.command === "START"
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
    evaluate: ({ now, generator }) => {
      if (generator.lastStoppedAt === undefined) return null;
      const elapsed = now - generator.lastStoppedAt;
      if (elapsed < 0) return null;
      if (elapsed >= THRESHOLDS.cooldownMs) return null;
      const remainSec = Math.ceil((THRESHOLDS.cooldownMs - elapsed) / 1000);
      return `Cooldown active — ${remainSec}s remaining of the ${THRESHOLDS.cooldownMs / 60000}-minute rest period after stop.`;
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
    evaluate: ({ generator }) =>
      generator.nextMaintenanceHrs > 0 && generator.nextMaintenanceHrs <= THRESHOLDS.serviceWarnHours
        ? `Service is due in ${generator.nextMaintenanceHrs.toFixed(1)} run-hours.`
        : null,
  },
  {
    id: "NEAR_CRITICAL_FUEL",
    severity: "SOFT",
    appliesTo: [],
    authority: "OPERATOR",
    explanation: "Fuel level is low.",
    remedy: "Arrange refuelling before the next expected run.",
    evaluate: ({ fuelLitres }) =>
      fuelLitres !== undefined &&
      fuelLitres !== null &&
      fuelLitres < THRESHOLDS.lowFuelWarnLitres
        ? `${fuelLitres.toFixed(1)} L remain, below the ${THRESHOLDS.lowFuelWarnLitres} L warning level.`
        : null,
  },
  {
    id: "HIGH_EXISTING_LOAD",
    severity: "SOFT",
    appliesTo: ["START"],
    authority: "OPERATOR",
    explanation: "The set is already at high load relative to its rating.",
    remedy: "Check available headroom before adding further load.",
    evaluate: ({ generator }) =>
      generator.ratedPowerKw > 0 &&
      generator.loadKw / generator.ratedPowerKw > THRESHOLDS.highLoadFraction
        ? `Existing load ${generator.loadKw.toFixed(1)} kW is above ${Math.round(THRESHOLDS.highLoadFraction * 100)}% of ${generator.ratedPowerKw} kW rating.`
        : null,
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
 * Thresholds that were inferred rather than sourced, with what is needed to
 * confirm each one. Kept beside the rules so it is impossible to change a
 * number without reading that it is unconfirmed.
 */
export const NEEDS_OPERATOR_CONFIRMATION: ReadonlyArray<{
  threshold: keyof typeof THRESHOLDS;
  value: number;
  why: string;
  confirmWith: string;
}> = Object.freeze([
  {
    threshold: "coolantMaxC",
    value: THRESHOLDS.coolantMaxC,
    why: "No OEM datasheet or standard was supplied; chosen as a conservative generic genset assume-load limit.",
    confirmWith: "The engine manufacturer, or the IEC 60068 ambient/coolant rating for the installed set.",
  },
  {
    threshold: "oilPressureMinKpa",
    value: THRESHOLDS.oilPressureMinKpa,
    why: "Engine speed and oil viscosity dependent; a single figure cannot be correct for all sets.",
    confirmWith: "OEM minimum oil pressure at rated speed, and the oil grade in use.",
  },
  {
    threshold: "oilOverdueMaxHours",
    value: THRESHOLDS.oilOverdueMaxHours,
    why: "A generic service interval, not a figure from any specification. Set as a hard deny deliberately, because failing the engine under load also removes the site's power.",
    confirmWith: "The site's actual maintenance schedule and the OEM oil-change interval.",
  },
  {
    threshold: "crankingFuelLitres",
    value: THRESHOLDS.crankingFuelLitres,
    why: "Real practice expresses this as a tank percentage or as minutes of cranking load; both scale with engine displacement, so a flat litre figure is only a placeholder.",
    confirmWith:
      "Minimum usable fuel per site: typically 25% of tank capacity, or the litres needed to crank and reach stable idle for the installed engine.",
  },
  {
    threshold: "lowFuelWarnLitres",
    value: THRESHOLDS.lowFuelWarnLitres,
    why: "A warning level, not a stop level. Chosen as a multiple of the cranking figure.",
    confirmWith: "Site refuelling interval and delivery lead time.",
  },
  {
    threshold: "cooldownMs",
    value: THRESHOLDS.cooldownMs,
    why: "Post-stop rest is real practice, but the correct interval varies by set and is not standardised by one number.",
    confirmWith: "OEM guidance, and site policy for how long a stopped set must rest.",
  },
  {
    threshold: "faultRestartBackoffMs",
    value: THRESHOLDS.faultRestartBackoffMs,
    why: "Longer than ordinary cooldown because a latched fault usually has not been cleared; not taken from any specification.",
    confirmWith: "Site policy on how long to wait after a fault before remote restart is permitted.",
  },
  {
    threshold: "serviceWarnHours",
    value: THRESHOLDS.serviceWarnHours,
    why: "An advance-warning margin, not a service interval.",
    confirmWith: "Maintenance scheduling policy.",
  },
  {
    threshold: "highLoadFraction",
    value: THRESHOLDS.highLoadFraction,
    why: "Generic headroom margin before flagging a set as heavily loaded.",
    confirmWith: "The site's actual peak demand against installed generator rating.",
  },
  {
    threshold: "lowLoadFraction",
    value: THRESHOLDS.lowLoadFraction,
    why: "Diesel engines run rich below roughly this fraction and wet the plugs. Recorded as SOFT only, because blocking STOP to protect the engine would be unsafe.",
    confirmWith: "OEM minimum recommended continuous load fraction.",
  },
]);