/**
 * Transport abstraction for industrial field protocols.
 *
 * The whole point of this interface is that protocol logic must be testable
 * without physical hardware. A Modbus master that can only be exercised by
 * plugging in a device is not testable, and untested protocol code on a field
 * bus is where silent data corruption comes from.
 *
 * Implementations:
 *   - `SimulatedTransport` (transport/simulated.ts) — in-memory fake bus
 *   - `TcpTransport`     (transport/tcp.ts)       — Modbus/TCP, real sockets
 *   - a serial-port transport can be added for RS485 without touching protocol
 *     code at all, which is the property that makes this worth having.
 */

/**
 * A request/response byte channel. Deliberately dumb: it moves bytes and
 * reports how the exchange went. It knows nothing about Modbus, MQTT or framing
 * — that belongs to the protocol layer above it.
 */
export interface Transport {
  /** Human-readable name, used in diagnostics and log lines. */
  readonly name: string

  /**
   * Send one frame and read the reply, with a timeout.
   *
   * @param request  bytes to write
   * @param timeoutMs how long to wait for the response before giving up
   * @returns the raw response bytes
   * @throws TransportTimeoutError when the device does not answer in time
   */
  transact(request: Uint8Array, timeoutMs: number): Promise<Uint8Array>

  /** Release the underlying resource. Safe to call more than once. */
  close?(): Promise<void>
}

/** Distinguishes "the bus was silent" from "the device said something invalid". */
export class TransportTimeoutError extends Error {
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message)
    this.name = 'TransportTimeoutError'
  }
}

/** The transport failed in a way that is neither a timeout nor a short read. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportError'
  }
}

/** Why a Modbus exchange ended badly. Callers switch on this, not on strings. */
export type ModbusFailureKind =
  | 'timeout'
  | 'crc-mismatch'
  | 'short-frame'
  | 'address-echo'
  | 'function-code'
  | 'exception-response'
  | 'illegal-value'

/**
 * A structured protocol failure.
 *
 * These are counted per device to produce bus diagnostics, so the KIND has to
 * be machine-readable — the RS485 route reports CRC error counts and timeout
 * counts separately, and collapsing them into one "error" bucket would destroy
 * the only signal an operator actually uses to diagnose a failing bus.
 */
export class ModbusError extends Error {
  constructor(
    readonly kind: ModbusFailureKind,
    message: string,
    /** Device detail for diagnostics, e.g. exception code text. */
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'ModbusError'
  }
}

/** Narrowing helper so callers do not need `instanceof` across module loads. */
export function isModbusError(e: unknown): e is ModbusError {
  return e instanceof ModbusError
}

/** Narrowing helper for timeouts. */
export function isTransportTimeout(e: unknown): e is TransportTimeoutError {
  return e instanceof TransportTimeoutError
}