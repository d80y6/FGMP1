/**
 * FGMP Services — Facade exports for the decomposed engine.
 *
 * Import from here instead of individual service files to maintain
 * a clean public API and allow singleton management.
 */

export {
  engineCore,
  EngineCore,
  EngineTenantContextError,
  EngineTenantScopeError,
} from "./core";

export {
  simulation,
  SimulationService,
  type SimulationContext,
  type SimulationOutput,
} from "./simulation";

export {
  alarmService,
  AlarmService,
  type AlarmCandidate,
  type AlarmResolution,
  type EscalationThresholds,
} from "./alarm";

export {
  controlService,
  ControlService,
  type ControlResult,
  type GeneratorControlOptions,
  type DispenserControlOptions,
  type EspRebootOptions,
  type GatewayRebootOptions,
  type FirmwareDeployOptions,
} from "./control";

export {
  persistence,
  PersistenceService,
  type PersistableEvent,
  type PersistableSiteEvent,
  type PersistableGatewayHealth,
  type PersistableFuelTransaction,
  type PersistableDispenserUpdate,
  type PersistableControlCommand,
  type PersistableAlarm,
  type PersistableNotification,
} from "./persistence";