/**
 * Modbus RTU master: reads a device's register map over a Transport and records
 * the bus diagnostics an operator actually needs.
 *
 * Diagnostics are collected here rather than in the caller because the only way
 * to measure CRC errors, retries and latency is to do them where the exchange
 * happens. Counting them anywhere else would mean the numbers describe the
 * counter, not the bus.
 */

import {
  buildReadRequest,
  decodeRegisterMap,
  parseReadResponse,
} from './modbus'
import { registerSpan, REGISTER_MAPS, type DeviceClass, type RegisterMap } from './registers'
import {
  ModbusError,
  isTransportTimeout,
  type ModbusFailureKind,
  type Transport,
} from './transport'

/** Everything measured about one device's bus behaviour. */
export type BusDiagnostics = {
  /** Rolling counters since the last reset. */
  crcErrors: number
  timeouts: number
  retries: number
  retriesExhausted: number
  exceptionResponses: number
  /** Successful reads / total attempts. */
  successfulReads: number
  failedReads: number
  /** Latency of the most recent successful exchange, milliseconds. */
  lastLatencyMs: number
  /** Mean latency across the window, milliseconds. Null before any success. */
  averageLatencyMs: number | null
  lastPollAt: Date | null
  lastError: string | null
  lastErrorKind: ModbusFailureKind | null
}

export function emptyDiagnostics(): BusDiagnostics {
  return {
    crcErrors: 0,
    timeouts: 0,
    retries: 0,
    retriesExhausted: 0,
    exceptionResponses: 0,
    successfulReads: 0,
    failedReads: 0,
    lastLatencyMs: 0,
    averageLatencyMs: null,
    lastPollAt: null,
    lastError: null,
    lastErrorKind: null,
  }
}

/** How to talk to one device on the bus. */
export type ModbusTarget = {
  /** Slave address, 1–247. */
  unitId: number
  deviceClass: DeviceClass
  /** Override the built-in map for this device class. */
  registerMap?: RegisterMap
}

export type ModbusClientOptions = {
  /** Attempts per read INCLUDING the first. Default 3. */
  attempts?: number
  /** Per-attempt timeout in milliseconds. Default 1000. */
  timeoutMs?: number
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => Date
}

/**
 * A Modbus RTU master bound to one transport.
 *
 * One client per BUS, not per device: RS485 is a shared half-duplex medium, so
 * transactions must not interleave. Keeping the client bus-scoped makes that
 * structural rather than a convention someone has to remember.
 */
export class ModbusClient {
  private readonly attempts: number
  private readonly timeoutMs: number
  private readonly now: () => Date
  /** Per-device diagnostics, keyed by unit id. */
  private readonly diagnostics = new Map<number, BusDiagnostics>()
  /** Latency samples per device, bounded so a long-running process cannot grow without limit. */
  private readonly latencySamples = new Map<number, number[]>()
  private static readonly LATENCY_WINDOW = 100

  constructor(
    private readonly transport: Transport,
    options: ModbusClientOptions = {},
  ) {
    this.attempts = Math.max(1, options.attempts ?? 3)
    this.timeoutMs = options.timeoutMs ?? 1000
    this.now = options.now ?? (() => new Date())
  }

  /** Diagnostics for a device, creating a zeroed record on first access. */
  getDiagnostics(unitId: number): BusDiagnostics {
    let d = this.diagnostics.get(unitId)
    if (!d) {
      d = emptyDiagnostics()
      this.diagnostics.set(unitId, d)
    }
    return { ...d }
  }

  /** Clear counters for a device, e.g. after a technician services the bus. */
  resetDiagnostics(unitId: number): void {
    this.diagnostics.set(unitId, emptyDiagnostics())
    this.latencySamples.delete(unitId)
  }

  /** All devices seen so far, with their diagnostics. */
  allDiagnostics(): Map<number, BusDiagnostics> {
    return new Map([...this.diagnostics].map(([k, v]) => [k, { ...v }]))
  }

  /**
   * Read a device's full register map.
   *
   * Retries on timeout and CRC mismatch — the two failure modes that a retry
   * genuinely fixes, since both are transient bus/line noise. An exception
   * response is NOT retried: the device understood the request and refused it,
   * so repeating it just wastes the bus and hides a real configuration fault.
   */
  async read(target: ModbusTarget): Promise<Record<string, number>> {
    const map = target.registerMap ?? REGISTER_MAPS[target.deviceClass]
    const { start, count } = registerSpan(map)
    const request = buildReadRequest(target.unitId, map.functionCode, start, count)

    const diag = this.ensure(target.unitId)
    let lastError: ModbusError | null = null

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const startedAt = this.now()
      const elapsedStart = performance.now()
      try {
        const frame = await this.transport.transact(request, this.timeoutMs)
        const latency = performance.now() - elapsedStart
        const response = parseReadResponse(frame, {
          unitId: target.unitId,
          functionCode: map.functionCode,
          registerCount: count,
        })

        // Success.
        if (attempt > 1) diag.retries += attempt - 1
        diag.successfulReads += 1
        diag.lastLatencyMs = Math.round(latency * 1000) / 1000
        diag.lastPollAt = startedAt
        diag.lastError = null
        diag.lastErrorKind = null
        this.recordLatency(target.unitId, latency)

        return decodeRegisterMap(response.registers, start, map)
      } catch (err) {
        lastError = normalise(err)
        this.classify(diag, lastError)

        // Retry only the transient kinds.
        const retryable = lastError.kind === 'timeout' || lastError.kind === 'crc-mismatch'
        if (!retryable || attempt === this.attempts) {
          if (retryable && attempt === this.attempts) diag.retriesExhausted += 1
          break
        }
      }
    }

    diag.failedReads += 1
    diag.lastError = lastError?.message ?? 'unknown failure'
    diag.lastErrorKind = lastError?.kind ?? null
    throw lastError ?? new ModbusError('illegal-value', 'read failed with no error')
  }

  private ensure(unitId: number): BusDiagnostics {
    let d = this.diagnostics.get(unitId)
    if (!d) {
      d = emptyDiagnostics()
      this.diagnostics.set(unitId, d)
    }
    return d
  }

  private classify(diag: BusDiagnostics, err: ModbusError): void {
    switch (err.kind) {
      case 'crc-mismatch':
        diag.crcErrors += 1
        break
      case 'timeout':
        diag.timeouts += 1
        break
      case 'exception-response':
        diag.exceptionResponses += 1
        break
      default:
        break
    }
  }

  private recordLatency(unitId: number, latency: number): void {
    let samples = this.latencySamples.get(unitId)
    if (!samples) {
      samples = []
      this.latencySamples.set(unitId, samples)
    }
    samples.push(latency)
    if (samples.length > ModbusClient.LATENCY_WINDOW) samples.shift()
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    const d = this.diagnostics.get(unitId)
    if (d) d.averageLatencyMs = Math.round(mean * 1000) / 1000
  }
}

function normalise(err: unknown): ModbusError {
  if (err instanceof ModbusError) return err
  if (isTransportTimeout(err)) {
    return new ModbusError('timeout', err.message)
  }
  return new ModbusError('illegal-value', err instanceof Error ? err.message : String(err))
}