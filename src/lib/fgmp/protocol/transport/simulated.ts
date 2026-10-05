/**
 * An in-memory Modbus bus for tests and for developing against without field
 * hardware.
 *
 * THIS IS NOT A DEVICE. It answers frames that match its programmed register
 * values; it does not model electrical behaviour, partial frames, collisions or
 * real timing. It exists so protocol logic can be tested deterministically, and
 * so an integration environment has something to talk to.
 *
 * It can be told to misbehave on purpose (see `corruptCrc`, `dropNext`,
 * `respondWith`), because the failure paths are the ones worth testing — a
 * client that has only ever seen a happy path is not tested.
 */

import { withCrc } from '../modbus'
import { Transport, TransportTimeoutError } from '../transport'

type SimulatedDevice = {
  unitId: number
  /** Register values keyed by zero-based register address. */
  registers: Map<number, number>
  /** Canned exception to return instead of data, e.g. 0x02 illegal address. */
  exception?: number
}

export type SimulatedTransportOptions = {
  name?: string
  /** Fixed latency, so tests are deterministic. Defaults to 0. */
  latencyMs?: number
}

export class SimulatedTransport implements Transport {
  readonly name: string
  private readonly devices = new Map<number, SimulatedDevice>()
  private readonly latencyMs: number

  /** Counters, so a test can assert on traffic without spying on internals. */
  requestsHandled = 0
  framesSent: Uint8Array[] = []

  /** When true, the next N transactions are ignored (device silent). */
  private dropCount = 0
  /** When set, the next response is returned verbatim instead of a real reply. */
  private cannedFrame: Uint8Array | null = null
  /** Flip the last byte of the next response to corrupt its CRC. */
  private corruptNextCrc = false

  constructor(options: SimulatedTransportOptions = {}) {
    this.name = options.name ?? 'simulated-modbus'
    this.latencyMs = options.latencyMs ?? 0
  }

  /**
   * Register a device.
   *
   * @param registers zero-based register address → raw unsigned 16-bit value
   */
  addDevice(unitId: number, registers: Record<number, number> = {}): this {
    this.devices.set(unitId, {
      unitId,
      registers: new Map(Object.entries(registers).map(([k, v]) => [Number(k), v])),
    })
    return this
  }

  /** Set one register on an existing device. */
  setRegister(unitId: number, address: number, value: number): this {
    const dev = this.devices.get(unitId)
    if (!dev) throw new Error(`no simulated device at unit ${unitId}`)
    dev.registers.set(address, value)
    return this
  }

  /** Make the next `count` transactions time out, modelling a silent device. */
  dropNext(count = 1): this {
    this.dropCount = count
    return this
  }

  /** Return an arbitrary frame next, e.g. to simulate bus contention. */
  respondWith(frame: Uint8Array): this {
    this.cannedFrame = frame
    return this
  }

  /** Corrupt the CRC of the next response. */
  corruptCrcOnce(): this {
    this.corruptNextCrc = true
    return this
  }

  /** Make the device answer with a Modbus exception from now on. */
  setException(unitId: number, code: number | null): this {
    const dev = this.devices.get(unitId)
    if (!dev) throw new Error(`no simulated device at unit ${unitId}`)
    dev.exception = code ?? undefined
    return this
  }

  async transact(request: Uint8Array, _timeoutMs: number): Promise<Uint8Array> {
    this.requestsHandled += 1
    this.framesSent.push(request)

    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs))
    }

    if (this.dropCount > 0) {
      this.dropCount -= 1
      throw new TransportTimeoutError(
        `simulated device did not respond within ${_timeoutMs}ms`,
        _timeoutMs,
      )
    }

    if (this.cannedFrame) {
      const frame = this.cannedFrame
      this.cannedFrame = null
      return this.maybeCorrupt(frame)
    }

    const unitId = request[0]
    const functionCode = request[1]
    const device = this.devices.get(unitId)
    if (!device) {
      // No such device. Modbus stays silent, so model it as a timeout — that
      // is exactly what the caller experiences in the field.
      throw new TransportTimeoutError(`no response from unit ${unitId}`, _timeoutMs)
    }

    if (device.exception !== undefined) {
      const body = new Uint8Array([unitId, functionCode | 0x80, device.exception])
      return this.maybeCorrupt(withCrc(body))
    }

    const start = (request[2] << 8) | request[3]
    const count = (request[4] << 8) | request[5]

    const body = new Uint8Array(3 + count * 2)
    body[0] = unitId
    body[1] = functionCode
    body[2] = count * 2
    for (let i = 0; i < count; i++) {
      // Absent registers read as 0, which is what most real meters do.
      const raw = device.registers.get(start + i) ?? 0
      body[3 + i * 2] = (raw >>> 8) & 0xff
      body[4 + i * 2] = raw & 0xff
    }
    return this.maybeCorrupt(withCrc(body))
  }

  private maybeCorrupt(frame: Uint8Array): Uint8Array {
    if (!this.corruptNextCrc) return frame
    this.corruptNextCrc = false
    const bad = frame.slice()
    bad[bad.length - 1] = bad[bad.length - 1] ^ 0xff
    return bad
  }

  async close(): Promise<void> {
    this.devices.clear()
  }
}