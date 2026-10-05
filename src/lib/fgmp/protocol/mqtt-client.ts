/**
 * MQTT connection semantics: QoS, retained messages, LWT and clean session.
 *
 * The broker connection itself is behind an interface so the semantics can be
 * tested without a broker, exactly as Modbus sits behind a Transport. `InMemoryBroker`
 * in broker.ts implements it for tests and for a local development environment.
 */

import { randomUUID } from 'node:crypto'

/** Quality of Service levels. */
export const QOS = {
  /** At most once. Fire and forget; a lost telemetry reading is acceptable. */
  AT_MOST_ONCE: 0,
  /** At least once. Duplicates possible — handlers must be idempotent. */
  AT_LEAST_ONCE: 1,
  /** Exactly once. Highest overhead; worth it only for commands. */
  EXACTLY_ONCE: 2,
} as const
export type QoS = (typeof QOS)[keyof typeof QOS]

export type MqttMessage = {
  topic: string
  payload: Uint8Array
  qos: QoS
  retain: boolean
  /** True when the broker delivered this because of a subscription, not a publish. */
  duplicate: boolean
}

/**
 * The broker surface the application uses. Deliberately minimal: a real MQTT
 * client (mqtt.js) satisfies this shape, and so does the in-memory fake.
 */
export interface MqttBroker {
  connect(options: ConnectOptions): Promise<void>
  disconnect(): Promise<void>
  publish(message: OutgoingMessage): Promise<void>
  subscribe(topicFilter: string, qos: QoS): Promise<void>
  unsubscribe(topicFilter: string): Promise<void>
  /** Register a handler; returns a disposer. */
  onMessage(handler: (m: MqttMessage) => void): () => void
  readonly connected: boolean
}

export type ConnectOptions = {
  clientId: string
  /**
   * Clean session.
   *
   * true  — the broker discards any previous session for this client id. Simple,
   *         but a reconnecting gateway loses its subscriptions and in-flight
   *         QoS 1 messages.
   * false — the broker preserves subscriptions and queued QoS 1/2 messages
   *         across reconnects.
   *
   * The right answer differs by role, and the distinction matters:
   *   - a GATEWAY subscribing to commands wants cleanSession: false, or a
   *     network blip silently drops pending commands;
   *   - a short-lived CLI or one-shot publisher wants true, so it does not
   *     accumulate state on the broker forever.
   * For this platform the gateway is the one that matters, so the default is
   * false and the caller must opt in to true.
   */
  cleanSession: boolean
  /** Keepalive in seconds. */
  keepaliveSeconds: number
  /** Last Will and Testament, published by the broker if the client dies. */
  will?: {
    topic: string
    payload: Uint8Array
    qos: QoS
    retain: boolean
  }
}

/**
 * A device's LWT.
 *
 * The broker publishes this automatically when the connection drops WITHOUT a
 * clean disconnect. That is the entire point: a device yanked from the bus by a
 * power cut never gets to send "I am offline", so the broker synthesises it.
 * A device that shuts down gracefully must NOT rely on the will firing, and
 * must publish its own offline status before disconnecting.
 */
export function buildWill(offlineTopic: string, reason: string, qos: QoS = QOS.AT_LEAST_ONCE): ConnectOptions['will'] {
  const payload = JSON.stringify({ status: 'offline', reason, at: new Date().toISOString() })
  // Retained: a subscriber that connects AFTER the device died must still learn
  // it is offline. Without retain, the will is published to nobody and the
  // dashboard shows a device that is merely quiet rather than down.
  return { topic: offlineTopic, payload: new TextEncoder().encode(payload), qos, retain: true }
}

export type OutgoingMessage = {
  topic: string
  payload: Uint8Array
  qos: QoS
  retain: boolean
}

/**
 * Encoded statuses published on a device's status topic.
 *
 * `online` should be RETAINED so a fresh subscriber immediately knows the
 * current state; `offline` from the will is also retained for the same reason.
 * Intermediate states (error, degraded) are published unretained so they do not
 * become a permanent "current state" that hides a later recovery.
 */
export const STATUS_ONLINE: 'online' = 'online'
export const STATUS_OFFLINE: 'offline' = 'offline'

export type DeviceStatusPayload = {
  status: 'online' | 'offline' | 'degraded' | 'error'
  at: string
  reason?: string
  firmware?: string
}

export function encodeStatus(p: DeviceStatusPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(p))
}

/** Whether a status should be retained. Only the two durable states are. */
export function shouldRetainStatus(status: DeviceStatusPayload['status']): boolean {
  return status === 'online' || status === 'offline'
}

/** MQTT topic filters use `+` (one level) and `#` (rest). Validate ours. */
export function isValidTopicFilter(filter: string): boolean {
  if (!filter || filter.startsWith('/') || filter.endsWith('/')) return false
  const levels = filter.split('/')
  for (const level of levels) {
    // A wildcard must occupy an entire level; `fgmp/+/x` is valid, `fgmp/a+/x` is not.
    if (level.includes('+') && level !== '+') return false
    if (level.includes('#') && level !== '#') return false
  }
  // '#' must be the final level.
  if (levels.indexOf('#') !== -1 && levels.indexOf('#') !== levels.length - 1) return false
  return true
}

/** Generate a client id that cannot collide across gateways. */
export function makeClientId(prefix = 'fgmp'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

/**
 * Coarse classification of why a connection dropped, from the MQTT CONNACK /
 * socket-close codes a broker reports.
 *
 * Worth having explicitly because the two causes demand opposite responses: a
 * timeout is fixed by retrying, an auth rejection is fixed by NOT retrying.
 * A client that retries forever on bad credentials locks the account out and
 * floods the broker log.
 */
export function classifyDisconnect(code: number | undefined): 'normal' | 'retry' | 'fatal' {
  if (code === undefined) return 'normal'
  // CONNACK 0 is success; a clean close has no code.
  if (code === 0) return 'normal'
  // 4 = bad username/password, 5 = not authorised. Retrying cannot fix these.
  if (code === 4 || code === 5) return 'fatal'
  // Everything else (network, keepalive timeout, server busy) is worth a retry.
  return 'retry'
}