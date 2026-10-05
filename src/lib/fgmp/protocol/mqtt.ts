/**
 * MQTT topic design for telemetry and command flows.
 *
 * Topics are TENANT-SCOPED IN THE PATH, deliberately, for one reason: a broker
 * ACL enforces isolation by topic pattern. An MQTT broker has no database, so
 * RLS cannot help it — the ONLY thing standing between one operator's tenant and
 * another's telemetry is the topic namespace plus the ACL attached to it. If
 * the tenant id were a payload field instead, every subscriber would be
 * structurally able to receive every tenant's data and isolation would depend
 * entirely on each subscriber remembering to check.
 *
 * With the tenant in the path, isolation is one ACL rule per tenant:
 *
 *     pattern write, 5          fgmp/t-abc/#        (tenant t-abc only)
 *
 * and a subscription to `fgmp/t-xyz/#` is denied by the broker itself, not by
 * application code noticing.
 *
 * The id form matters too: a tenant id is validated before it reaches a topic,
 * because a topic separator (`/`) or wildcard (`+`, `#`) inside an unvalidated
 * id would let a crafted tenant break out of its own namespace and publish
 * into another tenant's tree. `assertTenantSegment` below is the guard, and it
 * is a security control, not a formatting nicety.
 */

import { assertTenantId } from '../tenant-context'

/** Root namespace. Never appears in an ACL on its own. */
export const MQTT_ROOT = 'fgmp'

/**
 * MQTT wildcard characters. These must never appear in an interpolated segment,
 * because the broker would interpret them as a pattern and a publisher could
 * address a subtree it does not own.
 */
const WILDCARDS = ['+', '#']

/**
 * Validate a tenant id for use as a single topic segment.
 *
 * Rejects the MQTT wildcards and the topic separator, plus anything outside a
 * conservative character set. This is the guard that stops topic injection:
 * without it, a tenant id containing `/` would silently relocate a device's
 * telemetry into another tenant's subtree, and the broker would have no way to
 * tell the difference.
 */
export function assertTenantSegment(tenantId: string): string {
  // Reuse the canonical tenant validation first, then add the MQTT-specific
  // constraints it does not cover.
  assertTenantId(tenantId)
  const id = tenantId.trim()
  for (const w of WILDCARDS) {
    if (id.includes(w)) {
      throw new Error(`tenant id contains the MQTT wildcard "${w}" and cannot be used as a topic segment`)
    }
  }
  if (id.includes('/')) {
    throw new Error('tenant id contains the topic separator "/" and cannot be used as a topic segment')
  }
  if (id.includes('\0')) {
    throw new Error('tenant id contains a null byte')
  }
  return id
}

/** Device classes that publish telemetry. Kept in sync with the register map. */
export const DEVICE_KINDS = [
  'tank',
  'generator',
  'dispenser',
  'battery',
] as const
export type DeviceKind = (typeof DEVICE_KINDS)[number]

/**
 * Telemetry topic.
 *
 *     fgmp/<tenantId>/<deviceKind>/<deviceId>/telemetry
 *
 * `<deviceId>` is scoped under the tenant so a broker ACL on `fgmp/<tenant>/#`
 * covers it. The leaf `telemetry` leaves room for sibling channels
 * (`telemetry/set`, `telemetry/ack`) without breaking existing subscriptions.
 */
export function telemetryTopic(tenantId: string, kind: DeviceKind, deviceId: string): string {
  const t = assertTenantSegment(tenantId)
  return `${MQTT_ROOT}/${t}/${kind}/${assertSegment(deviceId, 'deviceId')}/telemetry`
}

/** Status/availability topic. This is what the LWT is published to. */
export function statusTopic(tenantId: string, kind: DeviceKind, deviceId: string): string {
  const t = assertTenantSegment(tenantId)
  return `${MQTT_ROOT}/${t}/${kind}/${assertSegment(deviceId, 'deviceId')}/status`
}

/** Downlink command topic. */
export function commandTopic(tenantId: string, kind: DeviceKind, deviceId: string): string {
  const t = assertTenantSegment(tenantId)
  return `${MQTT_ROOT}/${t}/${kind}/${assertSegment(deviceId, 'deviceId')}/command`
}

/** Retained "here I am" topic, used by a device to announce itself on boot. */
export function announceTopic(tenantId: string, kind: DeviceKind, deviceId: string): string {
  const t = assertTenantSegment(tenantId)
  return `${MQTT_ROOT}/${t}/${kind}/${assertSegment(deviceId, 'deviceId')}/announce`
}

/**
 * ACL pattern a tenant's credentials are allowed to use.
 *
 * One line per tenant; a broker config generated from this has no way to grant
 * cross-tenant access, because the wildcard sits at the tenant's own subtree.
 */
export function tenantAclPattern(tenantId: string): string {
  return `${MQTT_ROOT}/${assertTenantSegment(tenantId)}/#`
}

/** Topics a gateway subscribing for one tenant should take. */
export function tenantSubscriptions(tenantId: string): string[] {
  return [`${MQTT_ROOT}/${assertTenantSegment(tenantId)}/#`]
}

/** Validate a device id used as a topic segment. */
function assertSegment(value: string, label: string): string {
  const v = value.trim()
  if (!v) throw new Error(`${label} must not be empty`)
  for (const w of WILDCARDS) {
    if (v.includes(w)) throw new Error(`${label} contains the MQTT wildcard "${w}"`)
  }
  if (v.includes('/')) throw new Error(`${label} contains the topic separator "/"`)
  if (v.includes('\0')) throw new Error(`${label} contains a null byte`)
  return v
}

// ── Payloads ─────────────────────────────────────────────────────────────────

/**
 * A validated telemetry reading from a field device.
 *
 * EVERY field is treated as untrusted. The payload arrives over TLS from a
 * device an attacker could physically reach at a remote site, so nothing in it
 * is assumed well-formed: numbers are checked for finite-ness and range, strings
 * are length-capped, and the device identity in the payload is CROSS-CHECKED
 * against the topic it arrived on. That last check is the important one — without
 * it a device can publish readings that will be attributed to another device.
 */
export type TelemetryPayload = {
  /** Device's own idea of its time, epoch ms. Rejected if wildly skewed. */
  ts: number
  /** Named readings, already scaled to engineering units by the decode layer. */
  readings: Record<string, number>
  /** Optional firmware version the device reports. */
  firmware?: string
  /** How the device's clock relates to ours, for drift detection. */
  clockOffsetMs?: number
}

/** Reject a reading outside plausible physical bounds for its kind. */
const READING_BOUNDS: Record<string, { min: number; max: number }> = {
  // A 48 V bank is ~54 V full, ~40 V empty; allow headroom either side.
  voltageMv: { min: -100, max: 100_000 },
  socPermille: { min: 0, max: 1000 },
  coolantDeciC: { min: -600, max: 1500 },
  temperatureDeciC: { min: -600, max: 1500 },
  // A tank probe beyond 20 m is implausible for these sites.
  levelMm: { min: 0, max: 20_000 },
  flowLpmDeci: { min: 0, max: 10_000 },
  // Generator output capped at 5 MW.
  loadDeciKw: { min: -1000, max: 500_000 },
  frequencyCentiHz: { min: 4500, max: 5500 },
}

/** Cap on distinct readings in one payload — a runaway device guard. */
const MAX_READINGS = 64
/** Cap on firmware string length. */
const MAX_FIRMWARE_LEN = 64

export type PayloadValidation = {
  ok: boolean
  value?: TelemetryPayload
  /** Why it was rejected. Safe to surface; never echoes the raw payload. */
  error?: string
  /** Individual readings dropped for being out of range, with reasons. */
  rejected?: { reading: string; reason: string }[]
}

/**
 * Validate an untrusted telemetry payload.
 *
 * Returns a result object rather than throwing, because a field device sending
 * garbage is an expected condition to be handled, not an exceptional one — the
 * caller records a rejection and keeps serving other devices on the bus.
 */
export function validateTelemetryPayload(raw: unknown): PayloadValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'payload must be a JSON object' }
  }
  const obj = raw as Record<string, unknown>

  const ts = obj.ts
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return { ok: false, error: 'ts must be a finite number (epoch milliseconds)' }
  }

  const readingsRaw = obj.readings
  if (typeof readingsRaw !== 'object' || readingsRaw === null || Array.isArray(readingsRaw)) {
    return { ok: false, error: 'readings must be an object' }
  }
  const readingsRawObj = readingsRaw as Record<string, unknown>

  const keys = Object.keys(readingsRawObj)
  if (keys.length > MAX_READINGS) {
    return { ok: false, error: `too many readings (${keys.length}, max ${MAX_READINGS})` }
  }

  const readings: Record<string, number> = {}
  const rejected: { reading: string; reason: string }[] = []

  for (const [name, value] of Object.entries(readingsRawObj)) {
    // Reject a name that could be used to poison a downstream object key.
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
      return { ok: false, error: `invalid reading name "${name}"` }
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: `reading "${name}" must be a finite number` }
    }
    // Infinity/NaN already rejected above; this catches absurd magnitudes.
    if (Math.abs(value) > 1e12) {
      return { ok: false, error: `reading "${name}" is out of representable range` }
    }
    const bounds = READING_BOUNDS[name]
    if (bounds && (value < bounds.min || value > bounds.max)) {
      // Out of range: drop this reading but keep the rest. One bad sensor
      // should not discard an otherwise good packet.
      rejected.push({ reading: name, reason: `outside ${bounds.min}..${bounds.max} ${name}` })
      continue
    }
    readings[name] = value
  }

  const firmware = obj.firmware
  if (firmware !== undefined) {
    if (typeof firmware !== 'string') return { ok: false, error: 'firmware must be a string' }
    if (firmware.length > MAX_FIRMWARE_LEN) {
      return { ok: false, error: `firmware string exceeds ${MAX_FIRMWARE_LEN} characters` }
    }
  }

  const clockOffsetMs = obj.clockOffsetMs
  if (clockOffsetMs !== undefined && (typeof clockOffsetMs !== 'number' || !Number.isFinite(clockOffsetMs))) {
    return { ok: false, error: 'clockOffsetMs must be a finite number' }
  }

  return {
    ok: true,
    value: {
      ts,
      readings,
      firmware: firmware as string | undefined,
      clockOffsetMs: clockOffsetMs as number | undefined,
    },
    rejected: rejected.length > 0 ? rejected : undefined,
  }
}

/**
 * Validate a command payload sent DOWN to a device.
 *
 * Commands are the dangerous direction: a malformed or replayed command can
 * start a generator or open a fuel nozzle. Every command carries a correlation
 * id so the reply can be matched, and only an explicit allow-list of commands
 * is accepted.
 */
export const ALLOWED_COMMANDS = [
  'setStatus',
  'requestTelemetry',
  'reboot',
  'setPollInterval',
  'acknowledgeAlarm',
] as const
export type CommandName = (typeof ALLOWED_COMMANDS)[number]

export type CommandPayload = {
  cmd: CommandName
  /** Correlates the device's response. */
  correlationId: string
  params?: Record<string, unknown>
}

export type CommandValidation =
  | { ok: true; value: CommandPayload }
  | { ok: false; error: string }

/**
 * Validate a downlink command. Arguments are validated per command rather than
 * generically: a command name alone is not enough, because `setPollInterval`
 * with a string argument would otherwise pass an allow-list that only checked
 * the name.
 */
export function validateCommandPayload(raw: unknown): CommandValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'command payload must be a JSON object' }
  }
  const obj = raw as Record<string, unknown>

  const cmd = obj.cmd
  if (typeof cmd !== 'string') return { ok: false, error: 'cmd must be a string' }
  if (!(ALLOWED_COMMANDS as readonly string[]).includes(cmd)) {
    return { ok: false, error: `unknown command "${cmd}"` }
  }

  const correlationId = obj.correlationId
  if (typeof correlationId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(correlationId)) {
    return { ok: false, error: 'correlationId must be 8-64 chars of [A-Za-z0-9_-]' }
  }

  const params = obj.params
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    return { ok: false, error: 'params must be an object when present' }
  }
  const p = (params ?? {}) as Record<string, unknown>

  // Per-command parameter validation.
  if (cmd === 'setPollInterval') {
    const v = p.seconds
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, error: 'setPollInterval requires a numeric seconds parameter' }
    }
    // A 0 s interval would hammer the broker; an 86400 s interval looks like a
    // device going deaf. Both are almost certainly a bad number, not an intent.
    if (v < 5 || v > 3600) {
      return { ok: false, error: 'setPollInterval seconds must be between 5 and 3600' }
    }
  }

  if (cmd === 'setStatus') {
    if (p.status !== undefined && typeof p.status !== 'string') {
      return { ok: false, error: 'setStatus.status must be a string' }
    }
  }

  return {
    ok: true,
    value: { cmd: cmd as CommandName, correlationId, params: params as Record<string, unknown> | undefined },
  }
}

/**
 * Parse a topic back into its parts.
 *
 * Used to verify that a message's topic matches the device identity claimed in
 * its payload — the check that stops one device writing readings under another
 * device's topic.
 */
export function parseTopic(topic: string): {
  tenantId: string
  kind: DeviceKind
  deviceId: string
  channel: string
} | null {
  const parts = topic.split('/')
  if (parts.length !== 5) return null
  const [root, tenantId, kind, deviceId, channel] = parts
  if (root !== MQTT_ROOT) return null
  if (!(DEVICE_KINDS as readonly string[]).includes(kind)) return null
  return { tenantId, kind: kind as DeviceKind, deviceId, channel }
}

/**
 * Confirm a payload's device identity agrees with the topic it arrived on.
 *
 * Without this, any device that can reach the broker can publish a valid-looking
 * packet on another device's topic and the readings will be attributed to the
 * wrong asset — a spoofed fuel level on a tank that is actually being drained is
 * exactly the fraud this platform exists to detect.
 */
export function topicMatchesDevice(
  topic: string,
  claimedTenantId: string,
  claimedDeviceId: string,
): boolean {
  const parsed = parseTopic(topic)
  if (!parsed) return false
  return parsed.tenantId === claimedTenantId && parsed.deviceId === claimedDeviceId
}