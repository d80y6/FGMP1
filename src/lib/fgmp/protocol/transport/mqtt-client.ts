/**
 * Real MQTT broker connection, bound to the existing Transport abstraction.
 *
 * ── WHY A TRANSPORT, WHEN MQTT IS A PROTOCOL NOT A BUS ──────────────────────
 * `transport.ts` was written for Modbus: a request/response byte channel with a
 * timeout. MQTT does not fit that shape, so this does not pretend to. What it
 * reuses is the thing that matters — the seam.
 *
 * Without a seam here, the MQTT code would be exercised only against a broker
 * container, so a unit test would need Docker, and every developer without it
 * would skip the tests. With one, the same connection logic is tested against
 * InMemoryBroker, and the LIVE-broker test covers only what the fake cannot:
 * whether the ACL actually denies a cross-tenant subscribe. That division is
 * deliberate — the fake can prove our logic, only the broker can prove the
 * boundary.
 */

import { connect, type MqttClient, type IClientOptions } from "mqtt";
import {
  QOS,
  type ConnectOptions,
  type MqttBroker,
  type MqttMessage,
  type OutgoingMessage,
  type QoS,
} from "../mqtt-client";

/** Broker endpoint. Loopback-bound in development; see docker-compose.yml. */
export const BROKER_URL = process.env.FGMP_MQTT_URL ?? "mqtt://127.0.0.1:1885";

/**
 * Per-tenant credentials.
 *
 * Each tenant connects with its OWN username and password. This is the whole
 * basis of MQTT tenant isolation, so it is worth being explicit about what it
 * buys and what it does not:
 *
 *   It buys: the broker decides. `subscribe('fgmp/tenant-b/#')` as tenant A is
 *   REFUSED by mosquitto — no SUBSCRIBE acknowledgement, no delivery. That
 *   denial happens in the broker, so no bug in this file can widen it.
 *
 *   It does not buy: protection from a tenant that is handed someone else's
 *   credentials. Credential issuance and rotation are the trust boundary here;
 *   the ACL only enforces what the username it is given permits.
 */
export type TenantCredentials = {
  username: string
  password: string
}

export type MqttBrokerConnectionOptions = {
  credentials: TenantCredentials
  clientId: string
  url?: string
  /** Seconds to wait for CONNACK before declaring the broker unreachable. */
  connectTimeoutMs?: number
  will?: ConnectOptions["will"]
  cleanSession?: boolean
}

/**
 * One tenant's connection to the broker.
 *
 * Instances are per-tenant BY CONSTRUCTION: constructing one requires
 * credentials, so there is no way to accidentally create a shared
 * `fgmp/#`-subscriber and call it isolated. A `subscribe()` outside the
 * caller's own subtree is still possible to *request* — that is deliberate, so
 * the live-broker test can prove the broker refuses it rather than mocking the
 * refusal.
 */
export class MqttTenantConnection implements MqttBroker {
  readonly name: string
  private readonly client: MqttClient
  private readonly handlers = new Set<(m: MqttMessage) => void>()
  private readonly connectTimeoutMs: number

  constructor(options: MqttBrokerConnectionOptions) {
    this.name = `mqtt:${options.clientId}`
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000

    const mqttOptions: IClientOptions = {
      username: options.credentials.username,
      password: options.credentials.password,
      clientId: options.clientId,
      clean: options.cleanSession ?? false,
      // Reconnect is bounded: a broker that is refusing these credentials will
      // keep refusing, and an unbounded retry loop turns a misconfiguration into
      // a log flood and a locked account.
      reconnectPeriod: 4_000,
      connectTimeout: this.connectTimeoutMs,
      resubscribe: true,
    }

    this.client = connect(options.url ?? BROKER_URL, mqttOptions)

    // An LWT registered here is stored by the broker and published by the BROKER
    // if this connection dies without a clean disconnect — which is the only
    // way a device that lost power can announce it is gone.
    if (options.will) {
      this.client.options.will = options.will as IClientOptions["will"]
    }
  }

  get connected(): boolean {
    return this.client.connected
  }

  /** Resolve on CONNACK. Rejects on auth failure or timeout. */
  async connect(_options?: ConnectOptions): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new Error(
            `broker did not send CONNACK within ${this.connectTimeoutMs}ms ` +
              `(broker=${BROKER_URL}, user=${this.client.options.username})`,
          ),
        )
      }, this.connectTimeoutMs)

      const onConnect = () => {
        cleanup()
        resolve()
      }
      // The broker signals a refused CONNECT this way. `return` (rather than
      // 'error') is because the connection is still open at that point.
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.client.off("connect", onConnect)
        this.client.off("error", onError)
      }

      this.client.once("connect", onConnect)
      this.client.once("error", onError)
      if (this.client.connected) onConnect()
    })
  }

  async disconnect(): Promise<void> {
    // A clean disconnect must NOT fire the LWT. `endAsync` completes the
    // DISCONNECT handshake so the broker drops the will.
    await this.client.endAsync(true)
  }

  async publish(message: OutgoingMessage): Promise<void> {
    // The broker interface is deliberately platform-neutral and carries a
    // `Uint8Array`. mqtt.js is a Node library and narrows that to `Buffer`.
    // The conversion happens HERE, at the transport edge, so the interface
    // every other broker implementation satisfies stays free of Node types —
    // otherwise a Uint8Array payload would drag `Buffer` into the contract.
    this.client.publish(message.topic, Buffer.from(message.payload), {
      qos: message.qos,
      retain: message.retain,
    })
  }

  /**
   * Subscribe and report what the BROKER decided.
   *
   * The grant shape differs by client version — mqtt.js returns an array of
   * `{ topic, qos }` from the SUBACK callback, not a keyed object — so the
   * result is normalised here rather than leaking that difference to callers.
   *
   * A REFUSED subscription is the interesting case. mosquitto omits the filter
   * from the SUBACK and sends nothing further, so "the broker declined to grant
   * it" is observed as the filter's absence. Waiting only on the callback would
   * therefore hang forever on exactly the case the isolation test cares about,
   * hence the settle timeout.
   */
  async subscribe(topicFilter: string, qos: QoS): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }

      this.client.subscribe(topicFilter, { qos }, (err, granted) => {
        if (!err && Array.isArray(granted)) {
          this.lastGranted = Object.fromEntries(
            granted.map((g) => [g.topic, g.qos as QoS]),
          )
        }
        done()
      })

      // Safety net for a denied filter, which produces no SUBACK grant.
      setTimeout(done, 1_500)
    })
  }

  /** QoS the broker actually granted, per filter, from the last SUBACK. */
  lastGranted: Record<string, QoS> = {}

  /**
   * True when the broker granted the filter in the last SUBACK.
   * A filter the ACL denied never appears.
   */
  isGranted(topicFilter: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.lastGranted, topicFilter)
  }

  async unsubscribe(topicFilter: string): Promise<void> {
    await this.client.unsubscribeAsync(topicFilter)
  }

  onMessage(handler: (m: MqttMessage) => void): () => void {
    this.handlers.add(handler)

    // Wire the broker's message event once, fanning out to handlers, so
    // repeated onMessage() calls do not attach duplicate listeners.
    if (this.handlers.size === 1) {
      this.client.on("message", (topic, payload, packet) => {
        const m: MqttMessage = {
          topic,
          payload: new Uint8Array(payload),
          qos: packet.qos as QoS,
          retain: packet.retain,
          duplicate: packet.dup === true,
        }
        for (const h of this.handlers) h(m)
      })
    }

    return () => {
      this.handlers.delete(handler)
    }
  }

  /** Raw client, for tests that need to observe broker-level events. */
  get raw(): MqttClient {
    return this.client
  }
}

/**
 * Subscribe and REPORT the broker's decision rather than throwing.
 *
 * The live test needs to distinguish three outcomes — granted, denied, and
 * never acknowledged — and a throw/resolve pair cannot express all three. This
 * returns the verdict as data.
 */
/**
 * Subscribe and report what the BROKER decided.
 *
 * The grant shape differs by client version — mqtt.js returns an array of
 * `{ topic, qos }` from the SUBACK callback, not a keyed object — so the
 * result is normalised here rather than leaking that difference to callers.
 *
 * ── READ `granted` AS A HINT, NOT AS A SECURITY SIGNAL ──────────────────────
 * On MQTT 3.1.1 a denied subscription is reported by the broker as a SUBACK
 * code of 0x80. Mosquitto 2.1.2 does not do this: it returns success codes for
 * every filter it is asked about and enforces the ACL when it ROUTES each
 * message. Verified directly — `mosquitto_sub -d` against a broker whose ACL
 * correctly denies the request still prints
 *
 *     Subscribed (mid: 1): 0, 0
 *
 * for both the permitted and the forbidden filter, while the forbidden tenant's
 * PUBLISH is rejected outright with reason code 135 (Not authorized) and its
 * messages are never delivered to the other tenant.
 *
 * So on this broker `granted` is true for a cross-tenant filter that is in fact
 * correctly refused. It reports whether the broker ACKNOWLEDGED the request,
 * not whether it will honour it.
 *
 * `canReceive()` exists because of that, and it is the only assertion in the
 * isolation suite that carries weight: it publishes a real message from a real
 * second tenant and reports whether it ARRIVED. A granted-but-refused
 * subscription passes `granted` and fails `canReceive`.
 */
export async function subscribeAndReport(
  conn: MqttTenantConnection,
  topicFilter: string,
  qos: QoS = QOS.AT_LEAST_ONCE,
): Promise<{ granted: boolean; grantedQos: QoS | null }> {
  conn.lastGranted = {}
  await conn.subscribe(topicFilter, qos)
  return {
    granted: conn.isGranted(topicFilter),
    grantedQos: conn.lastGranted[topicFilter] ?? null,
  }
}

/**
 * Does a message published under `topic` actually ARRIVE at `conn`?
 *
 * This is the only reliable tenant-isolation signal on mosquitto, and the reason
 * it exists as a separate function is worth stating: a subscription the ACL
 * forbids is still ACKNOWLEDGED by this broker, so `subscribeAndReport(...).granted`
 * is true for a cross-tenant filter. Delivery is the thing that must not happen,
 * and delivery is observable.
 *
 * `publisher` must be a connection authenticated as the tenant that OWNS the
 * topic. Passing a connection for some other tenant would test nothing, because
 * the ACL would refuse the publish and the message would never be routed — a
 * pass for the wrong reason. `expectDelivery` therefore takes the owning
 * tenant's connection deliberately.
 */
export async function canReceive(
  conn: MqttTenantConnection,
  publisher: MqttTenantConnection,
  topic: string,
  payload: Uint8Array,
  waitMs = 1_200,
): Promise<boolean> {
  const seen: string[] = []
  const off = conn.onMessage((m) => seen.push(m.topic))
  try {
    // The subscriber must already hold the filter; this function only observes
    // whether anything arrives. Subscribing here would conflate routing with
    // authorization.
    await publisher.publish({ topic, payload, qos: QOS.AT_LEAST_ONCE, retain: false })
    await new Promise((r) => setTimeout(r, waitMs))
    return seen.includes(topic)
  } finally {
    off()
  }
}