// FGMP API request validation schemas (Zod v4).
//
// Every state-mutating API route under src/app/api/fgmp/[resource]/route.ts
// parses its incoming JSON body through one of these schemas before touching
// the database or the engine. This guarantees:
//
//  - Required fields are present and correctly typed.
//  - Enum-valued fields (status, role, command, priority, assetKind, ...)
//    only accept documented values, preventing invalid state machines.
//  - Numeric fields (volumeOrderedLitres, unitPrice, ...) are coerced to
//    numbers and bounded to plausible ranges so a bad payload cannot
//    overflow the DB or skew analytics.
//  - String fields are length-capped to prevent storage / log abuse.
//
// Schemas are grouped by API surface and exported individually. The
// validateBody helper returns a discriminated union so callers can
// short-circuit on { success: false, error } without a try/catch.

import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────
// Shared primitives
// ──────────────────────────────────────────────────────────────────────────

/** Non-empty trimmed string with a sensible upper bound (used for IDs). */
const idStr = z
  .string()
  .trim()
  .min(1, "required")
  .max(200, "too long");

/** Free-text note / reason / description. */
const noteStr = z.string().trim().max(4000).optional();

/** Email address. */
const emailStr = z
  .string()
  .trim()
  .toLowerCase()
  .email("invalid email")
  .max(254);

// ──────────────────────────────────────────────────────────────────────────
// Alarm actions
// ──────────────────────────────────────────────────────────────────────────

/**
 * POST /api/fgmp/alarms — single alarm ack/resolve.
 * The legacy API uses `{ action, alarmId, resolution }`; we accept the
 * flatter form here so existing clients keep working.
 */
export const ackAlarmSchema = z.object({
  action: z.literal("acknowledge").default("acknowledge"),
  alarmId: idStr,
  resolution: noteStr,
  note: noteStr,
});

export const resolveAlarmSchema = z.object({
  action: z.literal("resolve").default("resolve"),
  alarmId: idStr,
  resolution: noteStr,
  note: noteStr,
});

/** Bulk ack/resolve — `alarmIds` array form. */
export const bulkAckAlarmsSchema = z.object({
  action: z.literal("bulkAcknowledge"),
  alarmIds: z.array(idStr).min(1, "at least one alarmId required").max(1000),
});

export const bulkResolveAlarmsSchema = z.object({
  action: z.literal("bulkResolve"),
  alarmIds: z.array(idStr).min(1, "at least one alarmId required").max(1000),
  resolution: noteStr,
});

/** Discriminated union covering every alarm POST action. */
export const alarmActionSchema = z.discriminatedUnion("action", [
  ackAlarmSchema,
  resolveAlarmSchema,
  bulkAckAlarmsSchema,
  bulkResolveAlarmsSchema,
]);

// ──────────────────────────────────────────────────────────────────────────
// Maintenance tickets
// ──────────────────────────────────────────────────────────────────────────

const assetKindEnum = z.enum(["GENERATOR", "TANK", "BATTERY", "IOT", "DISPENSER"]);
const ticketTypeEnum = z.enum([
  "PREVENTIVE",
  "CORRECTIVE",
  "OIL_CHANGE",
  "INSPECTION",
  "CALIBRATION",
]);
const priorityEnum = z.enum(["P1", "P2", "P3", "P4"]);
const ticketStatusEnum = z.enum([
  "OPEN",
  "SCHEDULED",
  "IN_PROGRESS",
  "DONE",
  "CANCELLED",
]);

/** POST /api/fgmp/maintenance — create ticket. */
export const createTicketSchema = z.object({
  action: z.literal("create").default("create"),
  siteId: idStr,
  assetKind: assetKindEnum,
  assetId: idStr.optional(),
  type: ticketTypeEnum,
  priority: priorityEnum.default("P3"),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(8000).optional(),
  scheduledFor: z
    .string()
    .datetime({ offset: true })
    .optional()
    .or(z.string().min(1).max(40).optional()),
  notes: noteStr,
});

/** POST /api/fgmp/maintenance — complete ticket. */
export const completeTicketSchema = z.object({
  action: z.literal("complete"),
  ticketId: idStr,
});

/** PUT /api/fgmp/maintenance/[id] — update fields. */
export const updateTicketSchema = z.object({
  id: idStr.optional(), // also accept body-level id
  status: ticketStatusEnum.optional(),
  assigneeId: idStr.optional(),
  notes: noteStr,
  priority: priorityEnum.optional(),
});

export const maintenanceActionSchema = z.discriminatedUnion("action", [
  createTicketSchema,
  completeTicketSchema,
]);

// ──────────────────────────────────────────────────────────────────────────
// Generator control
// ──────────────────────────────────────────────────────────────────────────

/** POST /api/fgmp/generators/[id]/control — { command, reason }.
 *
 * The engine accepts START | STOP | EMERGENCY_STOP | RESET. The legacy API
 * body used `reason`; the task spec uses `note`. Accept either.
 */
export const generatorCommandSchema = z.object({
  command: z.enum(["START", "STOP", "EMERGENCY_STOP", "RESET"]),
  reason: noteStr,
  note: noteStr,
});

// ──────────────────────────────────────────────────────────────────────────
// Fuel deliveries
// ──────────────────────────────────────────────────────────────────────────

const deliveryStatusEnum = z.enum([
  "SCHEDULED",
  "IN_TRANSIT",
  "DELIVERED",
  "VERIFIED",
  "DISCREPANCY",
  "CANCELLED",
]);

/** POST /api/fgmp/deliveries — create delivery. */
export const createDeliverySchema = z.object({
  action: z.literal("create").default("create"),
  siteId: idStr,
  tankId: idStr,
  supplier: z.string().trim().min(1).max(200),
  volumeOrderedLitres: z.coerce.number().positive().max(1_000_000),
  scheduledAt: z
    .string()
    .min(1, "scheduledAt required")
    .max(40),
  driverName: z.string().trim().max(200).optional(),
  vehiclePlate: z.string().trim().max(60).optional(),
  doNumber: z.string().trim().min(1).max(120),
  unitPrice: z.coerce.number().nonnegative().max(1_000_000).optional(),
});

/** POST /api/fgmp/deliveries — dispatch an existing delivery. */
export const dispatchDeliverySchema = z.object({
  action: z.literal("dispatch"),
  deliveryId: idStr,
});

/** POST /api/fgmp/deliveries — verify a delivery (record actual volume). */
export const verifyDeliverySchema = z.object({
  action: z.literal("verify"),
  deliveryId: idStr,
  volumeDelivered: z.coerce.number().nonnegative().max(1_000_000),
  discrepancyNote: z.string().trim().max(2000).optional(),
});

/** PUT /api/fgmp/deliveries/[id] — generic update. */
export const updateDeliverySchema = z.object({
  id: idStr.optional(),
  status: deliveryStatusEnum,
  volumeDeliveredLitres: z.coerce.number().nonnegative().max(1_000_000).optional(),
  discrepancyNote: z.string().trim().max(2000).optional(),
  driverName: z.string().trim().max(200).optional(),
  vehiclePlate: z.string().trim().max(60).optional(),
});

export const deliveryActionSchema = z.discriminatedUnion("action", [
  createDeliverySchema,
  dispatchDeliverySchema,
  verifyDeliverySchema,
]);

// ──────────────────────────────────────────────────────────────────────────
// Users
// ──────────────────────────────────────────────────────────────────────────

const roleEnum = z.enum([
  "ADMIN",
  "NOC_OPERATOR",
  "REGIONAL_MANAGER",
  "FIELD_ENGINEER",
  "EXECUTIVE",
  "READONLY",
]);

/** POST /api/fgmp/users — create a user. */
export const createUserSchema = z.object({
  email: emailStr,
  name: z.string().trim().min(1).max(200),
  role: roleEnum,
  phone: z
    .string()
    .trim()
    .max(40)
    .optional(),
  password: z.string().min(8, "password must be ≥ 8 chars").max(256),
  tenantId: idStr.optional(),
});

/** PATCH /api/fgmp/users/[id] — update user. */
export const updateUserSchema = z.object({
  id: idStr.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  role: roleEnum.optional(),
  phone: z.string().trim().max(40).optional(),
  active: z.boolean().optional(),
});

// ──────────────────────────────────────────────────────────────────────────
// IoT telemetry ingest
// ──────────────────────────────────────────────────────────────────────────

/** Single telemetry reading envelope. At least one metric must be present. */
export const iotReadingSchema = z
  .object({
    tankLevel: z.coerce.number().nonnegative().max(1_000_000).optional(),
    genStatus: z
      .enum(["RUNNING", "STOPPED", "FAULT", "MAINTENANCE", "OFFLINE"])
      .optional(),
    genLoad: z.coerce.number().nonnegative().max(100_000).optional(),
    battVoltage: z.coerce.number().nonnegative().max(1000).optional(),
    battSoc: z.coerce.number().min(0).max(100).optional(),
    temp: z.coerce.number().min(-50).max(200).optional(),
  })
  .refine((r) => Object.values(r).some((v) => v !== undefined), {
    message: "at least one reading field is required",
  });

/** POST /api/fgmp/iot — bridge ingest payload. */
export const iotIngestSchema = z.object({
  siteId: idStr,
  readings: iotReadingSchema,
});

/** PATCH /api/fgmp/iot — OTA / reboot device. */
export const iotActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ota"),
    deviceId: idStr,
    firmware: z.string().trim().min(1).max(120),
  }),
  z.object({
    action: z.literal("reboot"),
    deviceId: idStr,
  }),
]);

// ──────────────────────────────────────────────────────────────────────────
// Site notes (client-side persistence, schema documented for future API)
// ──────────────────────────────────────────────────────────────────────────

export const createSiteNoteSchema = z.object({
  siteId: idStr,
  note: z.string().trim().min(1).max(1000),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
});

// ──────────────────────────────────────────────────────────────────────────
// Correlation rules (client-side persistence, schema documented for future API)
// ──────────────────────────────────────────────────────────────────────────

export const correlationRuleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  condition: z.record(z.string(), z.unknown()),
  action: z.enum(["ESCALATE", "NOTIFY", "SUPPRESS", "CREATE_TICKET"]),
  enabled: z.boolean(),
});

// ──────────────────────────────────────────────────────────────────────────
// Alarm Suppressions (Task 32-B)
// ──────────────────────────────────────────────────────────────────────────

/**
 * POST /api/fgmp/suppressions — create a maintenance window / suppression.
 *
 * siteId and alarmType are both nullable: null means "all sites" / "all
 * alarm types" respectively. startsAt / endsAt may arrive as ISO strings
 * or as Date objects (the form posts strings; the API normalizes to Date).
 *
 * The API additionally enforces that endsAt > startsAt (server-side guard
 * below); the zod schema here just checks shape.
 */
export const createSuppressionSchema = z.object({
  siteId: z.string().optional().nullable(),
  alarmType: z.string().optional().nullable(),
  reason: z.string().min(3).max(500),
  startsAt: z.string().or(z.date()),
  endsAt: z.string().or(z.date()),
});
export type CreateSuppressionInput = z.infer<typeof createSuppressionSchema>;

/**
 * PATCH /api/fgmp/suppressions/[id] — extend (new endsAt) or cancel
 * (set isActive=false). Both fields are optional; at least one must be
 * supplied (enforced server-side).
 */
export const updateSuppressionSchema = z.object({
  endsAt: z.string().or(z.date()).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateSuppressionInput = z.infer<typeof updateSuppressionSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Shift Handover (Round 46)
// ──────────────────────────────────────────────────────────────────────────
// The outgoing operator creates a handover note describing the state of the
// network at end-of-shift + ongoing issues + flagged sites. The incoming
// operator acknowledges it (optional reply note).
//
// shift: MORNING (06:00–14:00) | EVENING (14:00–22:00) | NIGHT (22:00–06:00)
// priority: P1 (urgent — read first) | P2 | P3 (routine)
const shiftEnum = z.enum(["MORNING", "EVENING", "NIGHT"]);
const handoverPriorityEnum = z.enum(["P1", "P2", "P3"]);

/**
 * POST /api/fgmp/shift-handover — create a new shift handover note.
 * tenantId / authorId / authorName / authorRole / point-in-time KPI snapshot
 * are all stamped server-side from the authenticated session and the live
 * engine snapshot — the client only supplies the descriptive fields.
 */
export const createShiftHandoverSchema = z.object({
  shift: shiftEnum,
  priority: handoverPriorityEnum.default("P3"),
  notes: z.string().trim().min(3, "notes required").max(4000),
  ongoingIssues: z.string().trim().max(2000).optional(),
  flaggedSiteIds: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});
export type CreateShiftHandoverInput = z.infer<typeof createShiftHandoverSchema>;

/**
 * PATCH /api/fgmp/shift-handover/[id] — acknowledge an OPEN handover note
 * (incoming operator confirms receipt). Only the `acknowledge` action is
 * supported via this route; mutations of the note itself require ADMIN
 * (use DELETE + re-create). acknowledgedNote is an optional reply.
 */
export const acknowledgeShiftHandoverSchema = z.object({
  action: z.literal("acknowledge").default("acknowledge"),
  acknowledgedNote: z.string().trim().max(1000).optional(),
});
export type AcknowledgeShiftHandoverInput = z.infer<typeof acknowledgeShiftHandoverSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Per-User Notification Preferences (Task 33-A)
// ──────────────────────────────────────────────────────────────────────────

/**
 * PUT /api/fgmp/preferences — update the current user's notification prefs.
 *
 * Each channel has an on/off toggle plus a comma-separated list of severities
 * (subset of L1,L2,L3) that should trigger notifications via that channel.
 * quietHoursStart / quietHoursEnd are nullable ints 0-23 (AST timezone); when
 * both are null the feature is disabled. Email/phone overrides are optional
 * and fall back to the user's profile email/phone when empty.
 */
export const notificationPreferenceSchema = z.object({
  inAppEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  smsEnabled: z.boolean(),
  inAppSeverities: z.string().regex(/^[L1-3,]+$/),
  emailSeverities: z.string().regex(/^[L1-3,]+$/),
  smsSeverities: z.string().regex(/^[L1-3,]+$/),
  quietHoursStart: z.number().int().min(0).max(23).nullable(),
  quietHoursEnd: z.number().int().min(0).max(23).nullable(),
  emailOverride: z.string().email().nullable().or(z.literal("")),
  phoneOverride: z.string().nullable().or(z.literal("")),
});
export type NotificationPreferenceInput = z.infer<typeof notificationPreferenceSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Fuel Dispensers (Task 34-B)
// ──────────────────────────────────────────────────────────────────────────

const dispenserFuelTypeEnum = z.enum(["DIESEL", "PETROL"]);
const dispenserStatusEnum = z.enum([
  "IDLE",
  "AUTHORIZED",
  "DISPENSING",
  "STOPPED",
  "FAULT",
  "MAINTENANCE",
  "OFFLINE",
]);
const dispenserModeEnum = z.enum(["AUTO", "MANUAL", "LOCKED"]);
// Feature 23 of the technical proposal: ten control commands per pump.
// AUTHORIZE / DEAUTHORIZE arm and disarm the nozzle; START / STOP /
// EMERGENCY_STOP drive the flow; LOCK / UNLOCK gate the whole unit;
// RESET clears a fault latch; SET_LIMIT arms a volume preset;
// RESET_COUNTER zeroes the cumulative totalizer (audited).
const dispenserCommandEnum = z.enum([
  "AUTHORIZE",
  "DEAUTHORIZE",
  "START",
  "STOP",
  "EMERGENCY_STOP",
  "RESET",
  "LOCK",
  "UNLOCK",
  "SET_LIMIT",
  "RESET_COUNTER",
]);

/** POST /api/fgmp/dispensers — create a dispenser. ADMIN-only. */
export const createDispenserSchema = z.object({
  siteId: idStr,
  // Pump identifier 1..N within a site — backs the @@unique([siteId, pumpNumber])
  // constraint the create route pre-checks with a 409.
  pumpNumber: z.coerce.number().int().min(1).max(999),
  label: z.string().trim().min(1).max(200),
  manufacturer: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  nozzleCount: z.coerce.number().int().min(1).max(8), // proposal §5.4: 1–8 nozzles
  fuelType: dispenserFuelTypeEnum.default("DIESEL"),
  maxFlowLpm: z.coerce.number().positive().max(200),
  espDeviceId: z.string().trim().min(1).max(120),
  espFirmware: z.string().trim().min(1).max(60).default("v1.0.0"),
  rs485Baudrate: z.coerce.number().int().min(1200).max(115200).default(9600),
  rs485Address: z.coerce.number().int().min(1).max(247).default(1),
  rs485Parity: z.string().trim().min(1).max(8).default("8N1"),
  ipAddress: z.string().trim().max(60).optional().or(z.literal("")),
  // MAC of the industrial controller (proposal §8.17 pump card identity).
  macAddress: z.string().trim().max(30).optional(),
  mode: dispenserModeEnum.default("AUTO"),
  presetVolumeLitres: z.coerce.number().nonnegative().max(10000).optional(),
});
export type CreateDispenserInput = z.infer<typeof createDispenserSchema>;

/** PATCH /api/fgmp/dispensers/[id] — update a dispenser. ADMIN-only. */
export const updateDispenserSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  manufacturer: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  nozzleCount: z.coerce.number().int().min(1).max(8).optional(),
  fuelType: dispenserFuelTypeEnum.optional(),
  maxFlowLpm: z.coerce.number().positive().max(200).optional(),
  espFirmware: z.string().trim().min(1).max(60).optional(),
  rs485Baudrate: z.coerce.number().int().min(1200).max(115200).optional(),
  rs485Address: z.coerce.number().int().min(1).max(247).optional(),
  rs485Parity: z.string().trim().min(1).max(8).optional(),
  ipAddress: z.string().trim().max(60).optional().or(z.literal("")),
  macAddress: z.string().trim().max(30).optional(),
  status: dispenserStatusEnum.optional(),
  mode: dispenserModeEnum.optional(),
  presetVolumeLitres: z.coerce.number().nonnegative().max(10000).optional(),
});
export type UpdateDispenserInput = z.infer<typeof updateDispenserSchema>;

/**
 * POST /api/fgmp/dispensers/[id]/control
 *
 * The ten commands of proposal feature 23: AUTHORIZE, DEAUTHORIZE,
 * START, STOP, EMERGENCY_STOP, RESET, LOCK, UNLOCK, SET_LIMIT
 * (via `presetVolumeLitres`), RESET_COUNTER.
 */
export const dispenserControlSchema = z.object({
  command: dispenserCommandEnum,
  presetVolumeLitres: z.coerce.number().nonnegative().max(10000).optional(),
});
export type DispenserControlInput = z.infer<typeof dispenserControlSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Misc mutation bodies
// ──────────────────────────────────────────────────────────────────────────

/** POST /api/fgmp/me — switch active role. */
export const switchRoleSchema = z.object({
  role: roleEnum,
});

/** POST /api/fgmp/tick — advance the engine clock. */
export const tickSchema = z
  .object({
    seconds: z.coerce.number().int().min(1).max(3600).optional(),
  })
  .optional()
  .default({});

/** POST /api/fgmp/notifications — mark sent / mark all sent. */
export const notificationMarkSentSchema = z.object({
  action: z.literal("markSent"),
  notificationId: idStr,
});

export const notificationMarkAllSentSchema = z.object({
  action: z.literal("markAllSent"),
});

export const notificationActionSchema = z.discriminatedUnion("action", [
  notificationMarkSentSchema,
  notificationMarkAllSentSchema,
]);

// ──────────────────────────────────────────────────────────────────────────
// validateBody helper
// ──────────────────────────────────────────────────────────────────────────

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Parse an unknown request body against a Zod schema. Returns a
 * discriminated union so callers can branch on `success` without a
 * try/catch:
 *
 * ```ts
 * const r = validateBody(createTicketSchema, body);
 * if (!r.success) return NextResponse.json({ error: r.error }, { status: 400 });
 * const data = r.data; // fully typed
 * ```
 *
 * The `error` string is a human-readable summary suitable for logs. For a
 * structured field-level breakdown, call `schema.safeParse()` directly or
 * use the `ApiError` helper in `api-error.ts`.
 */
export function validateBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
): ValidationResult<T> {
  const result = schema.safeParse(body);
  if (result.success) return { success: true, data: result.data };
  // Build a concise error string from the flattened issues.
  const flat = result.error.flatten();
  const formErrors = (flat.formErrors ?? []).join("; ");
  const fieldErrors = Object.entries(flat.fieldErrors ?? {})
    .map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`)
    .join("; ");
  const error = [formErrors, fieldErrors].filter(Boolean).join(" | ") || "invalid input";
  return { success: false, error };
}

// realtime: invalidate stale Turbopack cache (Task 31-B)
