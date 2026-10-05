/**
 * Unit tests for the MQTT layer.
 *
 * Run: bun test src/lib/fgmp/protocol/mqtt.test.ts
 *
 * The properties under test are the ones that determine whether tenant
 * isolation actually holds on a broker: that a tenant id cannot escape its own
 * topic subtree, and that an untrusted payload cannot write into another
 * device's identity.
 */

import { describe, expect, test } from 'bun:test'
import {
  ALLOWED_COMMANDS,
  assertTenantSegment,
  commandTopic,
  parseTopic,
  statusTopic,
  telemetryTopic,
  tenantAclPattern,
  tenantSubscriptions,
  topicMatchesDevice,
  validateCommandPayload,
  validateTelemetryPayload,
} from './mqtt'
import {
  QOS,
  buildWill,
  classifyDisconnect,
  encodeStatus,
  isValidTopicFilter,
  makeClientId,
  shouldRetainStatus,
  type QoS,
} from './mqtt-client'
import { InMemoryBroker, topicMatches } from './broker'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const bytes = (s: string) => ({ topic: '', payload: enc(s), qos: QOS.AT_LEAST_ONCE, retain: false, duplicate: false })

// ── Topic construction and isolation ─────────────────────────────────────────

describe('tenant-scoped topics', () => {
  test('puts the tenant in the path so a broker ACL can enforce isolation', () => {
    // This is the whole reason for the design: an ACL on `fgmp/t-abc/#` denies
    // any access to another tenant's subtree, enforced by the broker.
    expect(telemetryTopic('t-abc', 'tank', 'dev-1')).toBe('fgmp/t-abc/tank/dev-1/telemetry')
    expect(tenantAclPattern('t-abc')).toBe('fgmp/t-abc/#')
  })

  test('separates tenants in their own subtrees', () => {
    const a = telemetryTopic('t-abc', 'tank', 'dev-1')
    const b = telemetryTopic('t-xyz', 'tank', 'dev-1')
    expect(a).not.toBe(b)
    expect(topicMatches('fgmp/t-abc/#', a)).toBe(true)
    expect(topicMatches('fgmp/t-xyz/#', a)).toBe(false)
  })

  test('channels are distinct per tenant and per device', () => {
    expect(statusTopic('t-abc', 'tank', 'dev-1')).not.toBe(commandTopic('t-abc', 'tank', 'dev-1'))
    expect(statusTopic('t-abc', 'tank', 'dev-1')).not.toBe(statusTopic('t-abc', 'tank', 'dev-2'))
  })

  // Topic injection: without validation a tenant id containing '/' would move
  // a device's telemetry into another tenant's subtree, and the broker could
  // not tell the difference.
  test('rejects a tenant id containing the topic separator', () => {
    // Caught by assertTenantId's character set before the MQTT-specific check
    // runs — defence in depth, with the stricter check first.
    expect(() => telemetryTopic('t-abc/fgmp/t-xyz', 'tank', 'dev-1')).toThrow(/outside|separator/)
  })

  test('rejects a tenant id containing an MQTT wildcard', () => {
    expect(() => telemetryTopic('t-abc/#', 'tank', 'dev-1')).toThrow(/outside|wildcard/)
    expect(() => telemetryTopic('t-abc/+', 'tank', 'dev-1')).toThrow(/outside|wildcard/)
  })

  test('rejects a device id containing a separator or wildcard', () => {
    expect(() => telemetryTopic('t-abc', 'tank', 'dev/../x')).toThrow(/separator/)
    expect(() => telemetryTopic('t-abc', 'tank', 'dev#')).toThrow(/wildcard/)
    expect(() => telemetryTopic('t-abc', 'tank', '')).toThrow(/empty/)
  })

  test('rejects a null byte anywhere in the path', () => {
    expect(() => assertTenantSegment('t-abc\0evil')).toThrow(/outside|null byte/)
  })

  test('an injected tenant id cannot produce another tenant ACL', () => {
    expect(() => tenantAclPattern('t-abc/#')).toThrow()
    expect(tenantAclPattern('t-abc')).toBe('fgmp/t-abc/#')
    expect(tenantSubscriptions('t-abc')).toEqual(['fgmp/t-abc/#'])
  })
})

describe('parseTopic', () => {
  test('round-trips a well-formed topic', () => {
    const parsed = parseTopic(telemetryTopic('t-abc', 'generator', 'gen-9'))
    expect(parsed).toEqual({ tenantId: 't-abc', kind: 'generator', deviceId: 'gen-9', channel: 'telemetry' })
  })

  test('rejects topics with the wrong shape or an unknown kind', () => {
    expect(parseTopic('fgmp/t-abc/tank/dev-1')).toBeNull()
    expect(parseTopic('other/t-abc/tank/dev-1/telemetry')).toBeNull()
    expect(parseTopic('fgmp/t-abc/unicorn/dev-1/telemetry')).toBeNull()
  })
})

// ── Identity binding ─────────────────────────────────────────────────────────

describe('topicMatchesDevice', () => {
  const topic = telemetryTopic('t-abc', 'tank', 'dev-1')

  test('accepts a matching identity', () => {
    expect(topicMatchesDevice(topic, 't-abc', 'dev-1')).toBe(true)
  })

  // The core anti-spoofing check: a device must not be able to publish readings
  // that will be attributed to a different asset.
  test('rejects a payload claiming a different device', () => {
    expect(topicMatchesDevice(topic, 't-abc', 'dev-2')).toBe(false)
  })

  test('rejects a payload claiming a different tenant', () => {
    expect(topicMatchesDevice(topic, 't-xyz', 'dev-1')).toBe(false)
  })

  test('rejects an unparseable topic', () => {
    expect(topicMatchesDevice('garbage', 't-abc', 'dev-1')).toBe(false)
  })
})

// ── Payload validation ───────────────────────────────────────────────────────

describe('validateTelemetryPayload', () => {
  test('accepts a well-formed payload', () => {
    const r = validateTelemetryPayload({ ts: Date.now(), readings: { levelMm: 1200, temperatureDeciC: 250 } })
    expect(r.ok).toBe(true)
    expect(r.value?.readings.levelMm).toBe(1200)
  })

  test('rejects non-objects', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      expect(validateTelemetryPayload(bad).ok).toBe(false)
    }
  })

  test('rejects a missing or non-finite timestamp', () => {
    expect(validateTelemetryPayload({ readings: {} }).ok).toBe(false)
    expect(validateTelemetryPayload({ ts: 'now', readings: {} }).ok).toBe(false)
    expect(validateTelemetryPayload({ ts: NaN, readings: {} }).ok).toBe(false)
    expect(validateTelemetryPayload({ ts: Infinity, readings: {} }).ok).toBe(false)
  })

  test('rejects non-numeric readings rather than coercing them', () => {
    // String "1200" would silently become 1200 with a naive parse, hiding a
    // device that is sending the wrong type.
    expect(validateTelemetryPayload({ ts: Date.now(), readings: { levelMm: '1200' } }).ok).toBe(false)
    expect(validateTelemetryPayload({ ts: Date.now(), readings: { levelMm: null } }).ok).toBe(false)
  })

  test('rejects NaN and Infinity readings', () => {
    expect(validateTelemetryPayload({ ts: Date.now(), readings: { levelMm: NaN } }).ok).toBe(false)
    expect(validateTelemetryPayload({ ts: Date.now(), readings: { levelMm: Infinity } }).ok).toBe(false)
  })

  test('drops an out-of-range reading but keeps the rest of the packet', () => {
    // One bad sensor must not discard an otherwise good packet — that would
    // blind the dashboard to a fuel tank because its temperature probe is odd.
    const r = validateTelemetryPayload({ ts: Date.now(), readings: { levelMm: 1200, socPermille: 9999 } })
    expect(r.ok).toBe(true)
    expect(r.value?.readings.levelMm).toBe(1200)
    expect(r.value?.readings.socPermille).toBeUndefined()
    expect(r.rejected?.[0]?.reading).toBe('socPermille')
  })

  test('rejects a reading name that could poison an object key', () => {
    // Parsed from a JSON string, because a JS object LITERAL silently drops
    // `__proto__` as a key and would make this test pass vacuously. JSON.parse
    // creates a real own property, which is what an attacker on the wire would
    // actually produce.
    const withProto = JSON.parse('{"ts":1,"readings":{"__proto__":{"polluted":1}}}')
    expect(validateTelemetryPayload(withProto).ok).toBe(false)

    expect(validateTelemetryPayload({ ts: Date.now(), readings: { '9bad': 1 } }).ok).toBe(false)
    expect(validateTelemetryPayload({ ts: Date.now(), readings: { 'a b': 1 } }).ok).toBe(false)
  })

  test('does not let a payload mutate a prototype', () => {
    // The concrete attack: a device publishes a reading named "__proto__" and
    // some downstream code assigns it onto an object literal, polluting
    // Object.prototype for every request in the process.
    const withProto = JSON.parse('{"ts":1,"readings":{"__proto__":{"polluted":true}}}')
    const r = validateTelemetryPayload(withProto)
    expect(r.ok).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('rejects an absurd number of readings', () => {
    const readings: Record<string, number> = {}
    for (let i = 0; i < 100; i++) readings[`r${i}`] = i
    expect(validateTelemetryPayload({ ts: Date.now(), readings }).ok).toBe(false)
  })

  test('rejects an over-long firmware string', () => {
    expect(validateTelemetryPayload({ ts: Date.now(), readings: {}, firmware: 'x'.repeat(500) }).ok).toBe(false)
  })

  test('accepts a firmware string within bounds', () => {
    const r = validateTelemetryPayload({ ts: Date.now(), readings: {}, firmware: '1.2.3' })
    expect(r.ok).toBe(true)
    expect(r.value?.firmware).toBe('1.2.3')
  })
})

describe('validateCommandPayload', () => {
  const ok = { cmd: 'requestTelemetry', correlationId: 'abc12345' }

  test('accepts an allowed command', () => {
    const r = validateCommandPayload(ok)
    expect(r.ok).toBe(true)
  })

  test('rejects a command outside the allow-list', () => {
    // A device must not be reachable with an arbitrary command name.
    for (const cmd of ['deleteSite', 'setFuelPrice', '__proto__']) {
      const r = validateCommandPayload({ ...ok, cmd })
      expect(r.ok).toBe(false)
    }
  })

  test('requires a well-formed correlation id', () => {
    expect(validateCommandPayload({ ...ok, correlationId: 'short' }).ok).toBe(false)
    expect(validateCommandPayload({ ...ok, correlationId: 'has space 1234' }).ok).toBe(false)
    expect(validateCommandPayload({ ...ok, correlationId: 'a'.repeat(200) }).ok).toBe(false)
    expect(validateCommandPayload({ cmd: 'reboot' }).ok).toBe(false)
  })

  test('validates per-command parameters, not just the command name', () => {
    // An allow-list check alone would let a string through where a number is
    // required.
    expect(validateCommandPayload({ ...ok, cmd: 'setPollInterval', params: { seconds: 'soon' } }).ok).toBe(false)
    expect(validateCommandPayload({ ...ok, cmd: 'setPollInterval', params: { seconds: 0 } }).ok).toBe(false)
    expect(validateCommandPayload({ ...ok, cmd: 'setPollInterval', params: { seconds: 30 } }).ok).toBe(true)
  })

  test('every allowed command is a known, bounded verb', () => {
    for (const cmd of ALLOWED_COMMANDS) expect(typeof cmd).toBe('string')
  })
})

// ── Connection semantics ─────────────────────────────────────────────────────

describe('Last Will and Testament', () => {
  test('is retained so a late subscriber still learns the device is down', () => {
    const will = buildWill('fgmp/t-abc/tank/dev-1/status', 'link-loss')!
    expect(will.retain).toBe(true)
    const decoded = JSON.parse(dec(will.payload))
    expect(decoded.status).toBe('offline')
    expect(decoded.reason).toBe('link-loss')
  })

  test('fires on an unclean disconnect', () => {
    const broker = new InMemoryBroker()
    const received: { topic: string; payload: Uint8Array }[] = []
    broker.onMessage((m) => received.push(m))
    return (async () => {
      await broker.connect({
        clientId: 'dev-1',
        cleanSession: false,
        keepaliveSeconds: 60,
        will: buildWill('fgmp/t-abc/tank/dev-1/status', 'link-loss')!,
      })
      await broker.subscribe('fgmp/#', QOS.AT_LEAST_ONCE)
      broker.dropConnection('dev-1')

      expect(broker.willsPublished).toBe(1)
      const will = received.find((m) => m.topic.endsWith('/status'))
      expect(will).toBeDefined()
      expect(JSON.parse(dec(will!.payload)).status).toBe('offline')
    })()
  })

  test('does NOT fire on a graceful disconnect', async () => {
    // A device shutting down on purpose has published its own status; firing
    // the will as well would mark it offline when it is merely gone.
    const broker = new InMemoryBroker()
    await broker.connect({
      clientId: 'dev-1',
      cleanSession: false,
      keepaliveSeconds: 60,
      will: buildWill('fgmp/t-abc/tank/dev-1/status', 'x')!,
    })
    await broker.disconnect()
    expect(broker.willsPublished).toBe(0)
  })
})

describe('retained messages', () => {
  test('a new subscriber immediately receives the retained state', async () => {
    const broker = new InMemoryBroker()
    await broker.connect({ clientId: 'a', cleanSession: false, keepaliveSeconds: 60 })
    await broker.publish({
      topic: 'fgmp/t-abc/tank/dev-1/status',
      payload: encodeStatus({ status: 'online', at: new Date().toISOString() }),
      qos: QOS.AT_LEAST_ONCE,
      retain: true,
    })

    const received: { topic: string; retain: boolean }[] = []
    broker.onMessage((m) => received.push(m))
    await broker.subscribe('fgmp/#', QOS.AT_LEAST_ONCE)

    const retained = received.filter((m) => m.topic.endsWith('/status'))
    expect(retained.length).toBe(1)
    expect(retained[0].retain).toBe(true)
  })

  test('an empty retained payload clears the retained message', async () => {
    const broker = new InMemoryBroker()
    await broker.connect({ clientId: 'a', cleanSession: false, keepaliveSeconds: 60 })
    await broker.publish({ topic: 'fgmp/t-abc/tank/dev-1/status', payload: encodeStatus({ status: 'online', at: '' }), qos: 1, retain: true })
    expect(broker.retainedOn('fgmp/t-abc/tank/dev-1/status')).toBeDefined()
    await broker.publish({ topic: 'fgmp/t-abc/tank/dev-1/status', payload: new Uint8Array(0), qos: 1, retain: true })
    // Otherwise a decommissioned device stays "online" on every dashboard forever.
    expect(broker.retainedOn('fgmp/t-abc/tank/dev-1/status')).toBeUndefined()
  })

  test('only durable states are retained', () => {
    expect(shouldRetainStatus('online')).toBe(true)
    expect(shouldRetainStatus('offline')).toBe(true)
    // An intermediate error must not become the device's permanent state and
    // hide a later recovery.
    expect(shouldRetainStatus('degraded')).toBe(false)
    expect(shouldRetainStatus('error')).toBe(false)
  })
})

describe('clean session', () => {
  test('a clean session discards prior state', async () => {
    const broker = new InMemoryBroker()
    await broker.connect({ clientId: 'gw', cleanSession: true, keepaliveSeconds: 60 })
    await broker.subscribe('fgmp/t-abc/#', QOS.AT_LEAST_ONCE)
    await broker.connect({ clientId: 'gw', cleanSession: true, keepaliveSeconds: 60 })
    // Re-subscribing is required after a clean reconnect.
    const received: string[] = []
    broker.onMessage((m) => received.push(m.topic))
    await broker.publish({ topic: 'fgmp/t-abc/tank/dev-1/telemetry', payload: enc('{}'), qos: 1, retain: false })
    expect(received.length).toBe(0)
  })

  test('a durable session keeps its subscriptions across a reconnect', async () => {
    // A gateway that loses its command subscription on a network blip would
    // silently stop receiving commands while appearing healthy.
    const broker = new InMemoryBroker()
    await broker.connect({ clientId: 'gw', cleanSession: false, keepaliveSeconds: 60 })
    await broker.subscribe('fgmp/t-abc/#', QOS.AT_LEAST_ONCE)

    broker.dropConnection('gw')
    await broker.connect({ clientId: 'gw', cleanSession: false, keepaliveSeconds: 60 })

    const received: string[] = []
    broker.onMessage((m) => received.push(m.topic))
    await broker.publish({ topic: 'fgmp/t-abc/tank/dev-1/command', payload: enc('{}'), qos: 1, retain: false })
    expect(received).toContain('fgmp/t-abc/tank/dev-1/command')
  })
})

describe('QoS', () => {
  test('delivered QoS is the minimum of publish and subscription QoS', async () => {
    const broker = new InMemoryBroker()
    const received: { qos: QoS }[] = []
    await broker.connect({ clientId: 'a', cleanSession: false, keepaliveSeconds: 60 })
    broker.onMessage((m) => received.push(m))
    await broker.subscribe('fgmp/#', QOS.AT_LEAST_ONCE)
    // Published at QoS 2 but the subscriber only asked for 1.
    await broker.publish({ topic: 'fgmp/t-abc/x/y/telemetry', payload: enc('{}'), qos: QOS.EXACTLY_ONCE, retain: false })
    expect(received[0].qos).toBe(QOS.AT_LEAST_ONCE)
  })
})

describe('topicMatches', () => {
  test('implements + and #', () => {
    expect(topicMatches('fgmp/+/+/x/telemetry', 'fgmp/t-abc/tank/x/telemetry')).toBe(true)
    expect(topicMatches('fgmp/#', 'fgmp/a/b/c/d')).toBe(true)
    expect(topicMatches('fgmp/t-abc/#', 'fgmp/t-xyz/tank/d/telemetry')).toBe(false)
    expect(topicMatches('fgmp/a/b', 'fgmp/a/b')).toBe(true)
    expect(topicMatches('fgmp/a/b', 'fgmp/a/b/c')).toBe(false)
  })
})

describe('misc helpers', () => {
  test('topic filter validation', () => {
    expect(isValidTopicFilter('fgmp/#')).toBe(true)
    expect(isValidTopicFilter('fgmp/+/telemetry')).toBe(true)
    expect(isValidTopicFilter('fgmp/a+b/c')).toBe(false)
    expect(isValidTopicFilter('fgmp/#/x')).toBe(false)
    expect(isValidTopicFilter('fgmp/')).toBe(false)
  })

  test('disconnect classification distinguishes retryable from fatal', () => {
    // Retrying forever on bad credentials locks an account out and floods logs.
    expect(classifyDisconnect(4)).toBe('fatal')
    expect(classifyDisconnect(5)).toBe('fatal')
    expect(classifyDisconnect(0)).toBe('normal')
    expect(classifyDisconnect(undefined)).toBe('normal')
    expect(classifyDisconnect(1)).toBe('retry')
  })

  test('client ids are unique', () => {
    expect(makeClientId()).not.toBe(makeClientId())
    expect(makeClientId('gw')).toMatch(/^gw-[0-9a-f]{8}$/)
  })
})