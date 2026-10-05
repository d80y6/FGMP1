/**
 * An in-memory MQTT broker implementing enough of MQTT 3.1.1 semantics to test
 * the client: topic-filter matching with `+` and `#`, retained messages, QoS
 * downgrading on delivery, and Last Will publication on an unclean disconnect.
 *
 * THIS IS NOT A BROKER. It implements the subset the platform relies on and
 * nothing else — no persistence across restarts, no session takeover, no QoS 2
 * deduplication, no keepalive timing, no wire protocol. It is for tests and
 * local development. Do not point production at it.
 *
 * The broker interface is deliberately narrow enough that a real client
 * (mqtt.js) is a drop-in replacement, which is what lets the platform use this
 * in CI and a real broker in a site without touching application code.
 */

import {
  QOS,
  type ConnectOptions,
  type MqttBroker,
  type MqttMessage,
  type OutgoingMessage,
  type QoS,
} from './mqtt-client'

/** Does a topic match a filter? Implements MQTT 3.1.1 §4.7. */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/')
  const t = topic.split('/')
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') {
      // '#' matches the remainder, including zero levels.
      return true
    }
    if (i >= t.length) return false
    if (f[i] === '+') continue
    if (f[i] !== t[i]) return false
  }
  return f.length === t.length
}

type Subscription = { filter: string; qos: QoS }

type Session = {
  clientId: string
  cleanSession: boolean
  connected: boolean
  subscriptions: Subscription[]
  will?: ConnectOptions['will']
  /** Messages queued while offline, delivered on reconnect for a durable session. */
  queued: MqttMessage[]
}

export class InMemoryBroker implements MqttBroker {
  private readonly sessions = new Map<string, Session>()
  private readonly handlers = new Set<(m: MqttMessage) => void>()
  /** Retained messages per topic — the most recent retained payload wins. */
  private readonly retained = new Map<string, MqttMessage>()

  /** Audit counters, so a test can assert delivery rather than inspect internals. */
  publishesAccepted = 0
  messagesDelivered = 0
  willsPublished = 0

  get connected(): boolean {
    return true
  }

  async connect(options: ConnectOptions): Promise<void> {
    const existing = this.sessions.get(options.clientId)
    // A clean session discards prior state, including queued QoS 1 messages.
    // Getting this backwards means a reconnecting gateway silently loses
    // commands that were in flight when the network dropped.
    if (options.cleanSession || !existing) {
      this.sessions.set(options.clientId, {
        clientId: options.clientId,
        cleanSession: options.cleanSession,
        connected: true,
        subscriptions: existing && !options.cleanSession ? existing.subscriptions : [],
        queued: [],
      })
    } else {
      existing.connected = true
      existing.cleanSession = options.cleanSession
    }

    const session = this.sessions.get(options.clientId)!
    session.will = options.will

    // Deliver anything queued while this client was offline.
    const queued = session.queued.splice(0)
    for (const m of queued) {
      this.route(m)
    }

    // A NEW subscription receives retained messages matching its filter, which
    // is how a dashboard learns device state without polling.
    for (const sub of session.subscriptions) {
      for (const [topic, message] of this.retained) {
        if (topicMatches(sub.filter, topic)) {
          this.deliver(session, { ...message, retain: true })
        }
      }
    }
  }

  async disconnect(): Promise<void> {
    // Graceful disconnect: the will MUST NOT fire. A device that shuts down
    // cleanly publishes its own offline status first; firing the will here
    // would mark a device offline that is actually gone on purpose.
    for (const session of this.sessions.values()) {
      session.connected = false
      session.will = undefined
    }
  }

  /**
   * Simulate an UNCLEAN disconnect — power cut, cable pull, network loss.
   * This is the only path that publishes the will, exactly as in real MQTT.
   *
   * Order matters: the will is routed BEFORE the session is marked
   * disconnected. A broker delivers the will to the client's existing
   * SUBSCRIPTIONS, which survive the disconnect — marking it offline first
   * delivers the will to nobody and the device silently appears healthy.
   */
  dropConnection(clientId: string): void {
    const session = this.sessions.get(clientId)
    if (!session) return
    const will = session.will
    session.will = undefined

    if (will) {
      this.willsPublished += 1
      const message: MqttMessage = {
        topic: will.topic,
        payload: will.payload,
        qos: will.qos,
        retain: will.retain,
        duplicate: false,
      }
      if (will.retain) this.retained.set(will.topic, message)
      // Route while the session is still connected, so its own subscriptions
      // (and any other subscriber) receive the will.
      this.route(message)
    }

    session.connected = false
  }

  async publish(message: OutgoingMessage): Promise<void> {
    this.publishesAccepted += 1
    const m: MqttMessage = { ...message, duplicate: false }

    // A retained publish with an EMPTY payload CLEARS the retained message —
    // this is how a device removes its retained status. Modelling it matters
    // because getting it wrong leaves a device permanently "online" after it
    // is decommissioned.
    if (message.retain && message.payload.length === 0) {
      this.retained.delete(message.topic)
      return
    }
    if (message.retain) {
      this.retained.set(message.topic, m)
    }
    this.route(m)
  }

  async subscribe(topicFilter: string, qos: QoS): Promise<void> {
    for (const session of this.sessions.values()) {
      if (!session.connected) continue
      if (session.subscriptions.some((s) => s.filter === topicFilter)) continue
      session.subscriptions.push({ filter: topicFilter, qos })
    }
    // A new subscription immediately receives matching retained messages.
    for (const session of this.sessions.values()) {
      if (!session.connected || !session.subscriptions.some((s) => s.filter === topicFilter)) continue
      for (const [topic, message] of this.retained) {
        if (topicMatches(topicFilter, topic)) {
          this.deliver(session, { ...message, retain: true })
        }
      }
    }
  }

  async unsubscribe(topicFilter: string): Promise<void> {
    for (const session of this.sessions.values()) {
      session.subscriptions = session.subscriptions.filter((s) => s.filter !== topicFilter)
    }
  }

  onMessage(handler: (m: MqttMessage) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** Deliver matching messages to every connected subscriber. */
  private route(message: MqttMessage): void {
    for (const session of this.sessions.values()) {
      if (!session.connected) continue
      for (const sub of session.subscriptions) {
        if (!topicMatches(sub.filter, message.topic)) continue
        // QoS on delivery is the MINIMUM of publish QoS and subscription QoS.
        const delivered: MqttMessage = { ...message, qos: Math.min(message.qos, sub.qos) as QoS }
        this.deliver(session, delivered)
      }
    }
  }

  private deliver(session: Session, message: MqttMessage): void {
    this.messagesDelivered += 1
    for (const handler of this.handlers) {
      handler({ ...message, topic: message.topic })
    }
    void session
  }

  /** Test helper: how many messages are queued for an offline client. */
  queuedCount(clientId: string): number {
    return this.sessions.get(clientId)?.queued.length ?? 0
  }

  /** Test helper: the retained message on a topic, if any. */
  retainedOn(topic: string): MqttMessage | undefined {
    return this.retained.get(topic)
  }

  /** QoS constants re-exported so tests need only import the broker. */
  static readonly QOS = QOS
}