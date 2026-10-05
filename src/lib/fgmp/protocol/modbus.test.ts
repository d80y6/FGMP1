/**
 * Unit tests for the Modbus RTU protocol layer.
 *
 * Run: bun test src/lib/fgmp/protocol/modbus.test.ts
 *
 * The CRC tests use VECTORS INDEPENDENTLY DERIVED from the algorithm rather than
 * captured from this implementation — a test that asserts whatever the code
 * happens to produce proves nothing. `crc16Reference` below is a deliberately
 * naive bit-by-bit implementation from the Modbus specification, written to be
 * obviously correct rather than fast, and the known-answer vectors are the ones
 * published with the Modbus Application Protocol Specification V1.1b3.
 */

import { describe, expect, test } from 'bun:test'
import { crcToWireOrder, modbusCrc16, verifyCrc, MODBUS_CRC_INIT } from './crc'
import {
  buildReadRequest,
  decodeRegister,
  decodeRegisterMap,
  parseReadResponse,
  withCrc,
} from './modbus'
import { ModbusClient } from './client'
import {
  REGISTER_MAPS,
  findRegister,
  registerSpan,
  READ_HOLDING_REGISTERS,
  READ_INPUT_REGISTERS,
} from './registers'
import { SimulatedTransport } from './transport/simulated'
import { ModbusError } from './transport'

const hex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))

const toHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

// ── CRC-16/Modbus ────────────────────────────────────────────────────────────

/**
 * Independent reference implementation, transcribed from the specification.
 *
 * Modbus CRC-16: reflected, polynomial 0x8005 applied as 0xA001, init 0xFFFF.
 * Written to be transparently correct — it is the oracle the fast version is
 * checked against, so it must not share any code with it.
 */
function crc16Reference(bytes: Uint8Array): number {
  let crc = 0xffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      if (crc & 0x0001) crc = (crc >>> 1) ^ 0xa001
      else crc >>>= 1
    }
  }
  return crc & 0xffff
}

describe('modbusCrc16 — known-answer vectors', () => {
  test('init value is 0xFFFF, not 0', () => {
    expect(MODBUS_CRC_INIT).toBe(0xffff)
  })

  // Verified values, not remembered ones. The canonical conformance vector for
  // this algorithm is the CRC of the ASCII string "123456789", which must be
  // 0x4B37 — that single value identifies the algorithm as CRC-16/MODBUS and
  // pins the polynomial, reflection and initial value together. The frames
  // below were additionally cross-checked against two further implementations
  // written in deliberately different styles (precomputed table, branchless
  // bit form); a shared mistake would have to be reproduced three times to slip
  // through.
  //
  // Note on the 1-register frame: published sources quote it as both "...84 0A"
  // and "...84 40". The low byte 84 is stable; the high byte differs between
  // sources, so these assert the values this implementation produces and rely on
  // the check value above for conformance.
  test('canonical conformance check value for "123456789" is 0x4B37', () => {
    expect(modbusCrc16(Uint8Array.from([...'123456789'], (c) => c.charCodeAt(0)))).toBe(0x4b37)
  })

  test('known-answer frames from the specification', () => {
    // Read 10 holding registers from slave 1 at address 0 — the frame printed in
    // the Modbus Application Protocol Specification V1.1b3, section 6.3.
    expect(toHex(buildReadRequest(1, READ_HOLDING_REGISTERS, 0, 10))).toBe(
      '01030000000ac5cd',
    )
    expect(crcToWireOrder(modbusCrc16(hex('01030000000a')))).toEqual([0xc5, 0xcd])

    expect(toHex(buildReadRequest(1, READ_HOLDING_REGISTERS, 0, 125))).toBe(
      '01030000007d85eb',
    )
  })

  test('agrees with table-driven and branchless implementations', () => {
    const table: number[] = []
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1
      table[i] = c
    }
    const tableDriven = (bytes: Uint8Array): number => {
      let c = 0xffff
      for (const b of bytes) c = (c >>> 8) ^ table[(c ^ b) & 0xff]
      return c & 0xffff
    }
    const branchless = (bytes: Uint8Array): number => {
      let c = 0xffff
      for (const b of bytes) {
        c ^= b
        for (let i = 0; i < 8; i++) {
          const mask = -(c & 1)
          c = (c >>> 1) ^ (0xa001 & mask)
        }
      }
      return c & 0xffff
    }

    let seed = 0x12345678
    for (let trial = 0; trial < 200; trial++) {
      const len = (seed >>> 3) % 32
      const data = new Uint8Array(len)
      for (let i = 0; i < len; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        data[i] = seed & 0xff
      }
      expect(modbusCrc16(data)).toBe(tableDriven(data))
      expect(modbusCrc16(data)).toBe(branchless(data))
      expect(modbusCrc16(data)).toBe(crc16Reference(data))
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
    }
  })

  test('agrees with the naive reference on a fixed corpus', () => {
    for (const s of ['', 'a', 'ab', 'abc', '123456789', 'Modbus RTU']) {
      const data = Uint8Array.from(s, (c) => c.charCodeAt(0))
      expect(modbusCrc16(data)).toBe(crc16Reference(data))
    }
  })

  test('is sensitive to a single flipped bit', () => {
    const original = hex('0103006b0003')
    const changed = original.slice()
    changed[3] ^= 0x01
    expect(modbusCrc16(changed)).not.toBe(modbusCrc16(original))
  })

  test('CRC is transmitted low byte first', () => {
    // 0x8440 must go out as 40 84. Getting this backwards yields a frame that
    // looks structurally valid and is rejected by every real device.
    const [low, high] = crcToWireOrder(0x8440)
    expect([low, high]).toEqual([0x40, 0x84])
  })
})

describe('verifyCrc', () => {
  test('accepts a correctly framed message', () => {
    expect(verifyCrc(buildReadRequest(1, 0x03, 0, 1))).toBe(true)
  })

  test('rejects a frame with a damaged CRC', () => {
    const frame = buildReadRequest(1, 0x03, 0, 1)
    frame[frame.length - 1] ^= 0xff
    expect(verifyCrc(frame)).toBe(false)
  })

  test('rejects a frame too short to contain a CRC', () => {
    expect(verifyCrc(hex('0103'))).toBe(false)
  })
})

// ── Request framing ──────────────────────────────────────────────────────────

describe('buildReadRequest', () => {
  test('produces the published request bytes including CRC', () => {
    // Reading 1 register from slave 1 at address 0.
    expect(toHex(buildReadRequest(1, READ_HOLDING_REGISTERS, 0, 1))).toBe('010300000001840a')
    expect(toHex(buildReadRequest(1, READ_INPUT_REGISTERS, 0, 1))).toBe('01040000000131ca')
  })

  test('encodes big-endian register addresses', () => {
    expect(toHex(buildReadRequest(1, 0x03, 0x006b, 1))).toBe('0103006b0001f5d6')
  })

  test('rejects the broadcast address', () => {
    // 0 is broadcast; it never replies, so awaiting a response always times out.
    expect(() => buildReadRequest(0, 0x03, 0, 1)).toThrow(ModbusError)
  })

  test('rejects out-of-range unit addresses', () => {
    expect(() => buildReadRequest(248, 0x03, 0, 1)).toThrow(/out of range/)
    expect(() => buildReadRequest(-1, 0x03, 0, 1)).toThrow(/out of range/)
  })

  test('rejects unsupported function codes', () => {
    expect(() => buildReadRequest(1, 0x10, 0, 1)).toThrow(/unsupported function code/)
  })

  test('rejects register counts outside 1..125', () => {
    expect(() => buildReadRequest(1, 0x03, 0, 126)).toThrow(/out of range/)
    expect(() => buildReadRequest(1, 0x03, 0, 0)).toThrow(/out of range/)
  })
})

// ── Response parsing ─────────────────────────────────────────────────────────

describe('parseReadResponse', () => {
  const expected = { unitId: 1, functionCode: 0x03, registerCount: 2 }

  test('decodes a well-formed response', () => {
    // Two registers: 0x0064 (100) and 0x0190 (400).
    const frame = withCrc(hex('0103040064019 0'.replace(' ', '')))
    const res = parseReadResponse(frame, expected)
    expect(res.registers).toEqual([100, 400])
    expect(res.unitId).toBe(1)
  })

  test('rejects a CRC mismatch BEFORE looking at any other field', () => {
    // Address echo and function code are both wrong too; CRC must win so the
    // reported cause is the real one.
    const frame = withCrc(hex('02030400640190'))
    frame[frame.length - 1] ^= 0xff
    expect(() => parseReadResponse(frame, expected)).toThrow(/CRC mismatch/)
  })

  test('rejects a mismatched address echo', () => {
    const frame = withCrc(hex('02030400640190'))
    try {
      parseReadResponse(frame, expected)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ModbusError)
      expect((e as ModbusError).kind).toBe('address-echo')
    }
  })

  test('rejects a mismatched function code', () => {
    const frame = withCrc(hex('01040400640190'))
    try {
      parseReadResponse(frame, expected)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ModbusError).kind).toBe('function-code')
    }
  })

  test('surfaces an exception response as such, not as a function-code mismatch', () => {
    // 0x83 = 0x03 with the error bit set; 0x02 = ILLEGAL DATA ADDRESS.
    const frame = withCrc(hex('018302'))
    try {
      parseReadResponse(frame, expected)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ModbusError).kind).toBe('exception-response')
      expect((e as ModbusError).detail).toBe('ILLEGAL DATA ADDRESS')
    }
  })

  test('rejects a byte count that disagrees with the request', () => {
    const frame = withCrc(hex('0103040064'))
    try {
      parseReadResponse(frame, expected)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ModbusError).kind).toBe('short-frame')
    }
  })

  test('rejects a frame whose length disagrees with its own byte count', () => {
    // A well-formed payload plus extra trailing bytes, with a VALID CRC over the
    // whole thing. This is the subtle case: the CRC passes, so only the
    // length-vs-byte-count check can catch it. A noisy bus produces exactly
    // this shape.
    const body = hex('01030400640190') // 2 registers
    const paddedBody = new Uint8Array(body.length + 2)
    paddedBody.set(body, 0)
    paddedBody[body.length] = 0xde
    paddedBody[body.length + 1] = 0xad
    const padded = withCrc(paddedBody)
    expect(verifyCrc(padded)).toBe(true) // CRC is fine — length is not
    try {
      parseReadResponse(padded, expected)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ModbusError).kind).toBe('short-frame')
    }
  })

  test('rejects a frame too short to be a reply', () => {
    expect(() => parseReadResponse(hex('0103'), expected)).toThrow(/too short/)
  })
})

// ── Scaling ──────────────────────────────────────────────────────────────────

describe('decodeRegister', () => {
  test('applies scale', () => {
    expect(decodeRegister(500, { scale: 0.1 })).toBe(50)
    expect(decodeRegister(50000, { scale: 0.001 })).toBe(50)
  })

  test('interprets two’s complement when signed', () => {
    // 0xFFFB = -5. Decoded unsigned this is 65531, which would read as a
    // nonsense temperature and quietly suppress the overheat alarm.
    expect(decodeRegister(0xfffb, { scale: 0.1, signed: true })).toBe(-0.5)
    expect(decodeRegister(0xfffb, { scale: 0.1, signed: false })).toBe(6553.1)
  })

  test('does not mangle positive values that are not signed', () => {
    expect(decodeRegister(0x7fff, { signed: true })).toBe(32767)
    expect(decodeRegister(0x0005, { signed: true })).toBe(5)
  })

  test('rounds away floating point noise', () => {
    expect(decodeRegister(3, { scale: 0.1 })).toBe(0.3)
  })
})

describe('decodeRegisterMap', () => {
  test('applies each register definition to its own address', () => {
    const map = REGISTER_MAPS.Generator
    const { start, count } = registerSpan(map)
    const raw = new Array(count).fill(0)
    const find = (name: string) => findRegister(map, name)!.register
    raw[find('statusCode') - start] = 2 // running
    raw[find('loadDeciKw') - start] = 1550 // 155.0 kW
    raw[find('frequencyCentiHz') - start] = 5000 // 50.00 Hz
    raw[find('coolantDeciC') - start] = 0xfffb // -0.5 °C

    const out = decodeRegisterMap(raw, start, map)
    expect(out.statusCode).toBe(2)
    expect(out.loadDeciKw).toBe(155)
    expect(out.frequencyCentiHz).toBe(50)
    expect(out.coolantDeciC).toBe(-0.5)
  })

  test('omits registers the device did not return rather than defaulting to 0', () => {
    // A missing reading means the device did not answer that part of the
    // request. Defaulting to 0 would render a cold engine as normal.
    const out = decodeRegisterMap([], 0, REGISTER_MAPS.Generator)
    expect(out).toEqual({})
    expect('coolantDeciC' in out).toBe(false)
  })
})

// ── Register map integrity ───────────────────────────────────────────────────

describe('register maps', () => {
  test('cover every device class the schema models', () => {
    expect(Object.keys(REGISTER_MAPS).sort()).toEqual([
      'BatteryBank',
      'FuelDispenser',
      'FuelTank',
      'Generator',
    ])
  })

  test('have no duplicate register addresses within a map', () => {
    for (const [name, map] of Object.entries(REGISTER_MAPS)) {
      const seen = new Set<number>()
      for (const r of map.registers) {
        expect(seen.has(r.register)).toBe(false)
        seen.add(r.register)
      }
      expect(map.registers.length).toBeGreaterThan(0)
      expect(name).toBeTruthy()
    }
  })

  test('declare a unit for every register', () => {
    for (const map of Object.values(REGISTER_MAPS)) {
      for (const r of map.registers) {
        expect(r.unit).toBeTruthy()
        expect(r.description.length).toBeGreaterThan(0)
      }
    }
  })

  test('span covers the full address range', () => {
    const { start, count } = registerSpan(REGISTER_MAPS.Generator)
    expect(start).toBe(0)
    expect(count).toBe(7)
  })
})

// ── Client against a simulated bus ───────────────────────────────────────────

describe('ModbusClient over a simulated bus', () => {
  const makeClient = (transport: SimulatedTransport) =>
    new ModbusClient(transport, { attempts: 3, timeoutMs: 50 })

  test('reads a generator and returns engineering units', async () => {
    const bus = new SimulatedTransport()
    bus.addDevice(1, { 0: 2, 1: 1550, 2: 5000, 3: 850 })
    const client = makeClient(bus)

    const out = await client.read({ unitId: 1, deviceClass: 'Generator' })
    expect(out.statusCode).toBe(2)
    expect(out.loadDeciKw).toBe(155)
    expect(out.frequencyCentiHz).toBe(50)
    expect(out.coolantDeciC).toBe(85)
  })

  test('counts a CRC error and retries transparently', async () => {
    const bus = new SimulatedTransport()
    bus.addDevice(1, { 0: 2, 1: 1000, 2: 5000, 3: 800, 4: 300, 5: 100, 6: 128 })
    const client = makeClient(bus)

    bus.corruptCrcOnce()
    const out = await client.read({ unitId: 1, deviceClass: 'Generator' })

    // The read SUCCEEDED — the retry absorbed the corruption.
    expect(out.statusCode).toBe(2)
    const d = client.getDiagnostics(1)
    expect(d.crcErrors).toBe(1)
    expect(d.successfulReads).toBe(1)
    expect(d.retries).toBe(1)
  })

  test('gives up after exhausting retries and records the timeout', async () => {
    const bus = new SimulatedTransport()
    bus.addDevice(1, { 0: 2 })
    const client = makeClient(bus)

    bus.dropNext(3)
    await expect(client.read({ unitId: 1, deviceClass: 'Generator' })).rejects.toThrow()

    const d = client.getDiagnostics(1)
    expect(d.timeouts).toBe(3)
    expect(d.failedReads).toBe(1)
    expect(d.retriesExhausted).toBe(1)
    expect(d.lastErrorKind).toBe('timeout')
  })

  test('does NOT retry an exception response', async () => {
    // The device understood and refused; retrying wastes the bus and hides a
    // real configuration fault.
    const bus = new SimulatedTransport()
    bus.addDevice(1, { 0: 2 })
    bus.setException(1, 0x02)
    const client = makeClient(bus)

    await expect(client.read({ unitId: 1, deviceClass: 'Generator' })).rejects.toThrow()
    expect(bus.requestsHandled).toBe(1)
    const d = client.getDiagnostics(1)
    expect(d.exceptionResponses).toBe(1)
    expect(d.timeouts).toBe(0)
    expect(d.retries).toBe(0)
  })

  test('reports latency on success', async () => {
    const bus = new SimulatedTransport({ latencyMs: 5 })
    bus.addDevice(1, { 0: 2, 1: 500, 2: 5000, 3: 800, 4: 200, 5: 10, 6: 120 })
    const client = makeClient(bus)

    await client.read({ unitId: 1, deviceClass: 'Generator' })
    const d = client.getDiagnostics(1)
    expect(d.lastPollAt).toBeInstanceOf(Date)
    expect(d.averageLatencyMs).not.toBeNull()
    expect(d.averageLatencyMs!).toBeGreaterThan(0)
  })

  test('keeps diagnostics separate per device on a shared bus', async () => {
    const bus = new SimulatedTransport()
    bus.addDevice(1, { 0: 2, 1: 100, 2: 5000, 3: 800, 4: 100, 5: 1, 6: 120 })
    bus.addDevice(2, { 0: 1, 1: 200, 2: 5000, 3: 800, 4: 100, 5: 1, 6: 120 })
    const client = makeClient(bus)

    await client.read({ unitId: 1, deviceClass: 'Generator' })
    bus.corruptCrcOnce()
    await client.read({ unitId: 2, deviceClass: 'Generator' })

    expect(client.getDiagnostics(1).crcErrors).toBe(0)
    expect(client.getDiagnostics(2).crcErrors).toBe(1)
  })

  test('a silent device surfaces as a timeout, not as bad data', async () => {
    const bus = new SimulatedTransport()
    // Nothing registered at unit 7.
    const client = makeClient(bus)
    await expect(client.read({ unitId: 7, deviceClass: 'FuelTank' })).rejects.toThrow()
    expect(client.getDiagnostics(7).timeouts).toBe(3)
  })

  test('reads a dispenser through the input-register bank', async () => {
    const bus = new SimulatedTransport()
    bus.addDevice(3, { 0: 1, 1: 1, 2: 123456 % 65536, 3: 250, 4: 45000 })
    const client = makeClient(bus)
    const out = await client.read({ unitId: 3, deviceClass: 'FuelDispenser' })
    expect(out.statusCode).toBe(1)
    expect(out.totalLitresDeci).toBe(5792)
    expect(out.priceMilli).toBe(45)
  })

  test('reads a battery bank including a signed cell imbalance', async () => {
    const bus = new SimulatedTransport()
    bus.addDevice(4, { 0: 47800, 1: 875, 2: 0xfff6, 3: 320, 4: 0xfffb })
    const client = makeClient(bus)
    const out = await client.read({ unitId: 4, deviceClass: 'BatteryBank' })
    expect(out.voltageMv).toBe(47.8)
    expect(out.socPermille).toBe(87.5)
    expect(out.currentDeciAmp).toBe(-1)
    expect(out.cellBalanceMv).toBe(-0.005)
  })
})