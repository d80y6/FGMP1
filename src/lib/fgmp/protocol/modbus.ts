/**
 * Modbus RTU framing.
 *
 * An RTU message is: [address][function][data…][CRC-low][CRC-high], with no
 * length field and no delimiters — the receiver infers the end of the frame
 * from the function code and byte count. That is why the CRC matters so much:
 * it is the only end-of-frame signal on the wire.
 *
 * This module is pure — bytes in, bytes out. All I/O lives behind Transport.
 */

import { crcToWireOrder, modbusCrc16, verifyCrc } from './crc'
import { ModbusError } from './transport'

/** A decoded successful read response. */
export type ReadRegistersResponse = {
  readonly unitId: number
  readonly functionCode: number
  /** Raw register values in wire order, already de-noded into unsigned 16-bit. */
  readonly registers: readonly number[]
}

/** Modbus exception codes (the high bit of the function code is set). */
export const MODBUS_EXCEPTIONS: Readonly<Record<number, string>> = {
  0x01: 'ILLEGAL FUNCTION',
  0x02: 'ILLEGAL DATA ADDRESS',
  0x03: 'ILLEGAL DATA VALUE',
  0x04: 'SERVER DEVICE FAILURE',
  0x05: 'ACKNOWLEDGE',
  0x06: 'SERVER DEVICE BUSY',
  0x08: 'MEMORY PARITY ERROR',
  0x0a: 'GATEWAY PATH UNAVAILABLE',
  0x0b: 'GATEWAY TARGET DEVICE FAILED TO RESPOND',
}

/**
 * Build a request to read holding (0x03) or input (0x04) registers.
 *
 * @param unitId Modbus slave address, 1–247. 0 is the broadcast address and is
 *               deliberately rejected: broadcast has no response, so awaiting
 *               one would always time out.
 */
export function buildReadRequest(
  unitId: number,
  functionCode: number,
  startRegister: number,
  count: number,
): Uint8Array {
  if (!Number.isInteger(unitId) || unitId < 1 || unitId > 247) {
    throw new ModbusError(
      'illegal-value',
      `Modbus unit address ${unitId} is out of range`,
      'Valid slave addresses are 1-247; 0 is broadcast and does not respond',
    )
  }
  if (functionCode !== 0x03 && functionCode !== 0x04) {
    throw new ModbusError(
      'illegal-value',
      `unsupported function code 0x${functionCode.toString(16)}`,
      'only 0x03 (read holding) and 0x04 (read input) are implemented',
    )
  }
  // The protocol caps a single read at 125 registers (0x7D). Beyond that the
  // device is entitled to return an exception, so fail before sending.
  if (!Number.isInteger(count) || count < 1 || count > 125) {
    throw new ModbusError(
      'illegal-value',
      `register count ${count} is out of range`,
      'Modbus allows 1-125 registers per read',
    )
  }
  if (!Number.isInteger(startRegister) || startRegister < 0 || startRegister > 0xffff) {
    throw new ModbusError(
      'illegal-value',
      `start register ${startRegister} is out of range`,
      'register addresses are 16-bit unsigned',
    )
  }

  // Request PDU: unit address + function code + 2-byte big-endian start +
  // 2-byte count. That is SIX bytes, not seven — an over-long buffer leaves a
  // trailing zero byte inside the CRC computation and produces a frame every
  // real device silently discards.
  const body = new Uint8Array(6)
  body[0] = unitId
  body[1] = functionCode
  body[2] = (startRegister >>> 8) & 0xff
  body[3] = startRegister & 0xff
  body[4] = (count >>> 8) & 0xff
  body[5] = count & 0xff

  return withCrc(body)
}

/** Append the CRC-16 in Modbus wire order (low byte first). */
export function withCrc(body: Uint8Array): Uint8Array {
  const crc = modbusCrc16(body)
  const [low, high] = crcToWireOrder(crc)
  const out = new Uint8Array(body.length + 2)
  out.set(body, 0)
  out[body.length] = low
  out[body.length + 1] = high
  return out
}

/**
 * Parse a read response, validating everything that can be validated.
 *
 * Validation order matters: CRC first. If the frame is corrupt, every field
 * after it is untrustworthy, and reporting "address echo mismatch" for a frame
 * that was really damaged in transit sends an operator hunting the wrong
 * problem.
 */
export function parseReadResponse(
  frame: Uint8Array,
  expected: { unitId: number; functionCode: number; registerCount: number },
): ReadRegistersResponse {
  // Shortest legitimate response is addr + fn + byteCount + CRC.
  if (frame.length < 5) {
    throw new ModbusError(
      'short-frame',
      `response is ${frame.length} bytes, too short to be a Modbus reply`,
    )
  }

  // 1. CRC. Note that this is checked on the raw frame, which is also the only
  //    way to distinguish a corrupt frame from a legitimate exception reply.
  if (!verifyCrc(frame)) {
    throw new ModbusError(
      'crc-mismatch',
      'CRC mismatch — the frame is corrupt or two devices are answering at once',
      `expected CRC over the first ${frame.length - 2} bytes did not match the trailing 2`,
    )
  }

  const unitId = frame[0]
  const rawFunction = frame[1]

  // 2. Exception responses set the high bit of the function code. Check this
  //    BEFORE comparing the function code, or every exception would be
  //    misreported as a "function code mismatch".
  if (rawFunction & 0x80) {
    const code = frame[2]
    throw new ModbusError(
      'exception-response',
      `device returned exception 0x${code.toString(16).padStart(2, '0')}`,
      MODBUS_EXCEPTIONS[code] ?? 'unknown exception code',
    )
  }

  // 3. Address echo. A frame from another device on a shared bus means either
  //    an addressing bug or two units configured at the same slave id.
  if (unitId !== expected.unitId) {
    throw new ModbusError(
      'address-echo',
      `address echo mismatch: expected unit ${expected.unitId}, got ${unitId}`,
    )
  }

  // 4. Function code.
  if (rawFunction !== expected.functionCode) {
    throw new ModbusError(
      'function-code',
      `function code mismatch: expected 0x${expected.functionCode.toString(16)}, got 0x${rawFunction.toString(16)}`,
    )
  }

  const byteCount = frame[2]
  if (byteCount !== expected.registerCount * 2) {
    throw new ModbusError(
      'short-frame',
      `byte count mismatch: header says ${byteCount}, ${expected.registerCount} registers need ${expected.registerCount * 2}`,
    )
  }

  // Exact-length check: a longer frame means the CRC happened to pass over
  // trailing garbage, which is a real failure mode on a noisy bus.
  const expectedLength = 3 + byteCount + 2
  if (frame.length !== expectedLength) {
    throw new ModbusError(
      'short-frame',
      `frame length ${frame.length} does not match the ${expectedLength} implied by the byte count`,
    )
  }

  // 5. De-node. Each register is big-endian on the wire.
  const registers: number[] = []
  for (let i = 0; i < byteCount / 2; i++) {
    registers.push((frame[3 + i * 2] << 8) | frame[4 + i * 2])
  }

  return { unitId, functionCode: rawFunction, registers }
}

/**
 * Convert a raw unsigned register value into engineering units.
 *
 * `scale` is a MULTIPLIER, not a divisor. A battery bank reporting 47800 mV
 * converts to volts with scale 0.001; a temperature of 850 deci-degrees
 * converts to °C with scale 0.1. Dividing here instead — the intuitive but
 * wrong reading — yields 47 800 000 V and would sail straight through as a
 * plausible-looking number.
 *
 * Two's complement is handled here rather than at each call site: a coolant
 * reading of 65531 instead of −5 is exactly the kind of error that looks
 * plausible all the way to a missed overheat alarm.
 */
export function decodeRegister(
  raw: number,
  opts: { scale?: number; offset?: number; signed?: boolean },
): number {
  const value = opts.signed && raw > 0x7fff ? raw - 0x10000 : raw
  const scale = opts.scale ?? 1
  const offset = opts.offset ?? 0
  // Round to 6 dp to keep float noise (0.1 * 850 = 84.99999999999999) out of
  // values an operator reads on a dashboard.
  return Math.round((value * scale + offset) * 1e6) / 1e6
}

/**
 * Decode a whole register map from raw words.
 *
 * Registers not present in the response are omitted rather than defaulted to
 * zero: a missing register means the device did not answer that part of the
 * request, and a silent 0 for, say, coolant temperature would read as a normal
 * cold engine.
 */
export function decodeRegisterMap(
  registers: readonly number[],
  startRegister: number,
  map: { registers: readonly { register: number; name: string; unit: string; scale?: number; offset?: number; signed?: boolean }[] },
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const def of map.registers) {
    const index = def.register - startRegister
    const raw = registers[index]
    if (raw === undefined) continue
    out[def.name] = decodeRegister(raw, def)
  }
  return out
}