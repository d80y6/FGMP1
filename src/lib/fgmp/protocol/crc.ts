/**
 * CRC-16/Modbus — the checksum used by Modbus RTU.
 *
 * Parameters are the ones Modbus actually specifies, and they are not the same
 * as the more common CRC-CCITT used by X.25/HDLC:
 *
 *   width   16
 *   poly    0x8005, but reflected — implemented directly as 0xA001
 *   init    0xFFFF
 *   refin   true
 *   refout  true
 *   xorout  0x0000
 *
 * The poly is usually quoted as 0x8005. On the wire the algorithm runs the
 * REVERSED polynomial 0xA001 with a right shift, which is why the constant
 * below is 0xA001 and not 0x8005. Substituting 0x8005 produces plausible-looking
 * but wrong checksums — the single most common Modbus CRC bug, and one that
 * only shows up as intermittent "device not responding".
 *
 * The CRC is transmitted LOW BYTE FIRST. That trips up nearly everyone: the
 * buffer is [addr, fn, data..., crcLow, crcHigh], not the other way round.
 */

/** The reflected polynomial actually used by the Modbus CRC. */
export const MODBUS_CRC_POLY = 0xa001

/** Initial register value. Not zero — this is a frequent source of mismatch. */
export const MODBUS_CRC_INIT = 0xffff

/**
 * Compute the Modbus CRC-16 over a byte sequence.
 *
 * @returns the 16-bit CRC. The caller must append it low-byte first.
 */
export function modbusCrc16(bytes: Uint8Array): number {
  let crc = MODBUS_CRC_INIT
  for (const byte of bytes) {
    // XOR the byte into the low 8 bits, then shift right 8 times, feeding the
    // reflected polynomial in whenever a 1 bit falls off the end.
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ MODBUS_CRC_POLY : crc >>> 1
    }
  }
  return crc & 0xffff
}

/**
 * Split a computed CRC into the two-byte wire order Modbus uses.
 *
 * Modbus puts the LOW byte first, unlike nearly every other CRC in common use.
 * This is the single most common framing bug, so it is a named function rather
 * than an inline `crc & 0xff` at each call site.
 */
export function crcToWireOrder(crc: number): [low: number, high: number] {
  return [crc & 0xff, (crc >>> 8) & 0xff]
}

/**
 * Verify a framed RTU message: its final two bytes must be the CRC of
 * everything preceding them.
 *
 * @returns true when the trailing CRC matches.
 */
export function verifyCrc(frame: Uint8Array): boolean {
  if (frame.length < 4) return false
  const body = frame.subarray(0, frame.length - 2)
  const expected = modbusCrc16(body)
  const [low, high] = crcToWireOrder(expected)
  return frame[frame.length - 2] === low && frame[frame.length - 1] === high
}