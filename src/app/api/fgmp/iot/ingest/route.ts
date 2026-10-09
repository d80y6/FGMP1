import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { engine } from "@/lib/fgmp";
import { errorResponse } from "@/lib/fgmp/api-error";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { emitToRealtime } from "@/lib/fgmp/realtime-emitter";
import {
  rateLimitByApiKey,
  applyRateLimitHeaders,
  IOT_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { resolveReadingTs } from "@/lib/fgmp/ingest-ts";
import {
  DeviceWatermarkStore,
  parseReadingTs,
  checkDeclaredBodySize,
  MAX_INGEST_BODY_BYTES,
} from "@/lib/fgmp/ingest-buffer";

export const dynamic = "force-dynamic";

/**
 * FGMP IoT Ingestion Endpoint
 * ─────────────────────────────────────────────────────────────────────────
 * Accepts normalized telemetry readings from edge-gateway devices (in dev,
 * the `mini-services/iot-bridge` simulator; in prod, real MQTT/Modbus
 * bridges running on-site).
 *
 * Auth: requests MUST include `x-api-key: <IOT_API_KEY>`. The default dev
 * key is `fgmp-iot-dev-key`. In production, set IOT_API_KEY to a strong
 * secret and rotate per-device keys via an API-key management layer.
 *
 * Body shape:
 *   {
 *     "siteId":  "clx...",
 *     "readings": {
 *       "tankLevel"?:   number (litres, ≥ 0),
 *       "genStatus"?:   "running" | "stopped" | "fault",
 *       "genLoad"?:     number (kW, ≥ 0),
 *       "battVoltage"?: number (V),
 *       "battSoc"?:     number (0–100 %),
 *       "temp"?:        number (°C)
 *       "ts"?:          number|string — DEVICE timestamp, epoch millis or ISO-8601
 *     }
 *   }
 *
 * ── BUFFERING (Phase 2) ────────────────────────────────────────────────────
 * Field devices sit on unstable links, so the same reading is retried, packets
 * arrive out of order, and a reconnecting gateway dumps its backlog. Readings
 * are judged against a per-site watermark of the newest reading already
 * accepted, BEFORE any in-memory or database state is touched:
 *
 *   200 accepted         — applied and persisted at the device's own timestamp
 *   409 REJECT_STALE     — older than the newest accepted; never overwrites it
 *   409 REJECT_DUPLICATE — a retry of something already stored
 *   409 REJECT_FUTURE    — timestamp implausibly ahead of server time
 *   409 REJECT_TOO_OLD   — beyond the absolute staleness limit
 *   413                  — body over the size limit
 *
 * A reading with no usable `ts` is still accepted, but is reported as
 * "undated" and does not move the watermark — field firmware often has no
 * real-time clock, and rejecting those would push operators toward disabling
 * the check entirely.
 *
 * Side effects:
 *   1. Updates the in-memory engine state for the matching tank/generator/
 *      battery at the site (so the next `/api/fgmp/state` snapshot reflects
 *      the new reading immediately).
 *   2. Persists a `SensorReading` row per metric (for time-series history).
 *   3. Pushes a `telemetry:new` event to the realtime service (which fans
 *      it out to browsers connected to `site:<id>` room).
 *
 * Returns:
 *   200 { ok: true, applied: { tank?, generator?, battery? } }
 *   400 { error: "..." } validation failure
 *   401 { error: "unauthorized" } missing/invalid API key
 *   404 { error: "site has no <asset>" } site exists but has no matching asset
 */

const ReadingSchema = z.object({
  tankLevel: z.number().nonnegative().max(100000).optional(),
  genStatus: z.enum(["running", "stopped", "fault"]).optional(),
  genLoad: z.number().nonnegative().max(10000).optional(),
  battVoltage: z.number().min(0).max(1000).optional(),
  battSoc: z.number().min(0).max(100).optional(),
  /**
   * Signed cell-to-cell imbalance in millivolts.
   *
   * Signed because the sign carries the diagnosis: a positive delta means one
   * cell is sitting above the string mean and a negative one below, and the
   * failing cell is identified by which. Taking the absolute value — the obvious
   * implementation, and what the register map's unsigned encoding invites — would
   * discard exactly the half of the measurement that says which cell to replace.
   *
   * Range is deliberately wide (±5000 mV). A real imbalance large enough to
   * breach it is a battery already in failure, and clamping it here would make
   * the most severe readings look like moderate ones.
   */
  battCellBalanceMv: z.number().min(-5000).max(5000).optional(),
  temp: z.number().min(-50).max(150).optional(),
  /**
   * Device-measured timestamp, epoch millis or ISO-8601 (Phase 2).
   *
   * Optional because field firmware often has no real-time clock. When present
   * it is what staleness is judged against; when absent the reading is still
   * accepted, but it is recorded as undated rather than being silently stamped
   * with server time and made to look fresh.
   */
  ts: z.union([z.number(), z.string()]).optional(),
});

const IngestBodySchema = z.object({
  siteId: z.string().min(1).max(64),
  readings: ReadingSchema,
});

/**
 * Per-process ingest watermark store (Phase 2).
 *
 * Process-local by construction: it is a module-level singleton, so it protects
 * the replica that served the request. With more than one app instance a
 * device retry routed to a different replica would not see the watermark. The
 * durable answer is a unique index on (entityId, metric, ts) plus a Redis
 * watermark — Redis is already a dependency. Recorded as a known limit rather
 * than left to be discovered as a phantom duplicate bug in production.
 */
const watermarks = new DeviceWatermarkStore();

/**
 * Shared secret for edge devices. There is deliberately no committed default.
 * The previous fallback (`fgmp-iot-dev-key`) was hardcoded in BOTH this file
 * and firmware/dispenser-esp/*.ino, so any deployment that did not override it
 * accepted telemetry — which overwrites live tank and generator levels — from
 * anyone who read the repository.
 *
 * Read lazily rather than at module scope: `next build` imports route modules
 * to collect page data, where runtime secrets do not exist yet. The request
 * handler below fails closed when the key is genuinely absent.
 */
function iotApiKey(): string {
  const v = process.env.IOT_API_KEY;
  if (!v || v.length < 16) {
    throw new Error(
      "IOT_API_KEY is missing or too short (min 16 chars) — refusing to serve telemetry ingest.",
    );
  }
  return v;
}

const HISTORY_LIMIT = 288; // match engine's 24h @ 5min history window

export async function POST(req: NextRequest) {
  // Initialise the engine WITHOUT bootstrap(). bootstrap() resolves the
  // authenticated user and throws when there is no session — but this endpoint
  // authenticates with an API key, and field devices have no NextAuth session.
  // The call therefore threw on EVERY ingest request, before the API key was
  // even checked, so the device path returned 500 for all traffic.
  //
  // Only engine state is wanted here; the handler never reads `user`.
  // Device ingest carries an API key, not a session, so there is no tenant to
  // scope to here — and this endpoint only wants engine state, never `user`.
  // That makes it a genuine "load everything" case, so it uses the one named
  // entry point that is allowed to resolve all tenants.
  await engine.ensureAllTenants();

  // ── API-key auth (edge-device authentication) ──────────────────────────
  const apiKey = req.headers.get("x-api-key");
  let expected: string;
  try {
    expected = iotApiKey();
  } catch (err) {
    // Misconfigured deployment — refuse rather than accept anything.
    return NextResponse.json(
      {
        error: "ingest not configured",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
  if (!apiKey || apiKey !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── Rate limit ─────────────────────────────────────────────────────────
  // `rateLimitByApiKey` / `IOT_LIMIT` existed in rate-limit.ts but had ZERO
  // call sites, so this endpoint — which writes a SensorReading row and
  // overwrites live tank/generator/battery levels — was an unbounded write
  // amplifier for anyone holding the key.
  //
  // Placed AFTER auth so a bad key still costs a 401 rather than consuming a
  // legitimate device's budget. Keyed on the api-key itself, not the client
  // IP, so it is unaffected by the TRUSTED_PROXY change in getClientIp.
  const rl = await rateLimitByApiKey(req, IOT_LIMIT.limit, IOT_LIMIT.windowMs);
  if (!rl.success) {
    const res = NextResponse.json(
      { error: "Too many requests", code: "RATE_LIMITED" },
      { status: 429 },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  // ── Bound the body BEFORE parsing (Phase 2) ────────────────────────────
  // An unbounded `req.json()` lets a device holding the key send a very large
  // payload and exhaust memory before any validation runs. The declared length
  // is the cheap check; the byte cap below is the actual limit.
  const size = checkDeclaredBodySize(req);
  if (!size.ok) {
    const res = NextResponse.json(
      { error: "payload too large", detail: size.reason },
      { status: 413 },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_INGEST_BODY_BYTES) {
    const res = NextResponse.json(
      { error: "payload too large", detail: `body exceeds ${MAX_INGEST_BODY_BYTES} bytes` },
      { status: 413 },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  // ── Parse + validate body ──────────────────────────────────────────────
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { error: "invalid JSON body" },
      { status: 400 },
    );
  }
  const parsed = IngestBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }
  // Wrapped so the database duplicate verdict below can be mapped to a 409 and
  // any other failure to errorResponse(), instead of escaping as a 500.
  try {
  const { siteId, readings } = parsed.data;
  const now = new Date();
  const nowMs = now.getTime();
  // Phase 1 step 4: SensorReading requires a tenantId, and the ingest body only
  // carries siteId. Resolve the owning tenant once, from the Site the engine
  // loaded FROM THE DATABASE. An unknown site is rejected rather than
  // defaulted: a guessed tenant would place telemetry in the wrong tenant, and
  // the step 6 RLS policy would then protect it there forever.
  //
  // Reading it from the engine rather than issuing a fresh query is deliberate.
  // The lookup needs a tenant in order to build the tenant context, so querying
  // here would be circular. The engine's site list IS the database's site list
  // for the tenants it has loaded, and an empty or stale list now fails CLOSED
  // with a 404 rather than writing anywhere.
  const site = engine.sites.find((s) => s.id === siteId);
  if (!site) {
    const res = NextResponse.json(
      { error: "Unknown site", code: "SITE_NOT_FOUND" },
      { status: 404 },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }
  const tenantId = site.tenantId;
  const applied: {
    tank?: string;
    generator?: string;
    battery?: string;
  } = {};
  // Queued as thunks over the transaction client rather than executed
  // immediately, so every write runs inside the tenant context established
  // below instead of on the ambient client.
  const writes: ((tx: Prisma.TransactionClient) => Promise<unknown>)[] = [];

  // ── Buffering: judge freshness BEFORE any state is mutated (Phase 2) ──
  //
  // Every metric in a payload shares one device timestamp, so they share one
  // verdict. Judged per SITE rather than per metric: the watermark is the
  // newest reading accepted from that site, and a tank report must not be
  // judged against a temperature report taken at a different moment.
  //
  // This runs BEFORE the in-memory mutation below on purpose. Once
  // `tank.current` has been overwritten by a stale level, the damage is done —
  // refusing the database write afterwards would still leave the dashboard and
  // the theft figures reflecting a reading from an hour ago.
  const deviceTs = parseReadingTs((readings as { ts?: unknown }).ts);
  const verdict = watermarks.evaluate(siteId, deviceTs, nowMs);

  if (verdict.status !== "ACCEPT") {
    // 409: the request was well-formed and authenticated, but it conflicts
    // with state already stored. Not a 400 — the payload was valid.
    const res = NextResponse.json(
      {
        ok: false,
        applied: {},
        buffered: {
          status: verdict.status,
          readingTs: verdict.status === "REJECT_FUTURE" ? verdict.readingTs : verdict.readingTs,
          ...("newestTs" in verdict ? { newestTs: verdict.newestTs } : {}),
        },
      },
      { status: 409 },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  // The reading's own timestamp is what is persisted, so the stored history
  // reflects when the measurement was taken rather than when it happened to
  // arrive. SensorReading has no separate receivedAt column and adding one
  // needs a schema migration that is out of this change's scope, so uplink
  // delay is reported in the response instead — an operator debugging a
  // delayed link needs it, and it does not require a column to observe.
  // ── The ts contract ───────────────────────────────────────────────────────
  // `ts` is the identity of the measurement, and UNIQUE(entityId, metric, ts) is
  // the replay guarantee. Defaulting an absent `ts` to server time invented an
  // identity: a retry then landed on a different timestamp, missed the
  // constraint, and was accepted as new data — duplicate readings, silently,
  // forever.
  //
  // resolveReadingTs() marks instead: an undated reading is stored with tsSource
  // = SERVER and the dedup guarantee is explicitly NOT claimed for it. See
  // src/lib/fgmp/ingest-ts.ts for the decision and its provenance (INFERRED).
  const tsDecision = resolveReadingTs({ deviceTs, nowMs });
  if (!tsDecision.ok) {
    const res = NextResponse.json(
      { error: tsDecision.error, code: tsDecision.code },
      { status: tsDecision.status },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }
  const readingDate = tsDecision.readingTs;
  const tsSource = tsDecision.source;
  const receivedDate = new Date(nowMs);

  // ── Apply to in-memory engine + persist SensorReading rows ────────────

  // Fuel tank
  if (readings.tankLevel !== undefined) {
    const tank = engine.tanks.find((t) => t.siteId === siteId);
    if (tank) {
      tank.prevLevel = tank.current;
      tank.current = Math.min(tank.capacity, Math.max(0, readings.tankLevel));
      tank.lastReadingAt = nowMs;
      tank.status = tank.current <= tank.critical ? "EMPTY" : "OPERATIONAL";
      tank.history.push({ t: nowMs, l: Math.round(tank.current) });
      if (tank.history.length > HISTORY_LIMIT) tank.history.shift();
      applied.tank = tank.id;
      writes.push((tx) =>
        tx.sensorReading.create({
          data: {
            tenantId,
            siteId,
            entityKind: "TANK",
            entityId: tank.id,
            metric: "FUEL_LEVEL",
            value: tank.current,
            ts: readingDate,
            tsSource,
          },
        }),
      );
    }
  }

  // Generator
  if (readings.genStatus !== undefined || readings.genLoad !== undefined) {
    const gen = engine.generators.find((g) => g.siteId === siteId);
    if (gen) {
      if (readings.genStatus === "running") {
        gen.status = "RUNNING";
        gen.lastStartedAt = gen.lastStartedAt ?? nowMs;
      } else if (readings.genStatus === "stopped") {
        gen.status = "STOPPED";
        gen.lastStoppedAt = nowMs;
      } else if (readings.genStatus === "fault") {
        gen.status = "FAULT";
        gen.faultUntil = gen.faultUntil ?? nowMs + 30 * 60 * 1000;
      }
      if (readings.genLoad !== undefined) gen.loadKw = readings.genLoad;
      gen.lastReadingAt = nowMs;
      gen.history.push({
        t: nowMs,
        temp: gen.temperatureC,
        load: gen.loadKw,
        runtime: gen.runtimeHours,
        rate: gen.fuelRateLph,
      });
      if (gen.history.length > HISTORY_LIMIT) gen.history.shift();
      applied.generator = gen.id;
      writes.push((tx) =>
        tx.sensorReading.create({
          data: {
            tenantId,
            siteId,
            entityKind: "GENERATOR",
            entityId: gen.id,
            metric: "LOAD_KW",
            value: gen.loadKw,
            ts: readingDate,
            tsSource,
          },
        }),
      );
    }
  }

  // Battery
  if (
    readings.battVoltage !== undefined ||
    readings.battSoc !== undefined ||
    readings.battCellBalanceMv !== undefined
  ) {
    const batt = engine.batteries.find((b) => b.siteId === siteId);
    if (batt) {
      if (readings.battVoltage !== undefined) batt.voltage = readings.battVoltage;
      if (readings.battSoc !== undefined) batt.stateOfCharge = readings.battSoc;
      if (readings.battCellBalanceMv !== undefined) {
        batt.cellBalanceMv = readings.battCellBalanceMv;
      }
      batt.lastReadingAt = nowMs;
      batt.history.push({
        t: nowMs,
        v: batt.voltage,
        soc: Math.round(batt.stateOfCharge),
      });
      if (batt.history.length > HISTORY_LIMIT) batt.history.shift();
      applied.battery = batt.id;
      writes.push((tx) =>
        tx.sensorReading.create({
          data: {
            tenantId,
            siteId,
            entityKind: "BATTERY",
            entityId: batt.id,
            metric: "BATT_VOLTAGE",
            value: batt.voltage,
            ts: readingDate,
            tsSource,
          },
        }),
      );
      writes.push((tx) =>
        tx.sensorReading.create({
          data: {
            tenantId,
            siteId,
            entityKind: "BATTERY",
            entityId: batt.id,
            metric: "BATT_SOC",
            value: batt.stateOfCharge,
            ts: readingDate,
            tsSource,
          },
        }),
      );

      // Cell imbalance is stored TWICE on purpose.
      //
      // The SensorReading row is the trend — imbalance is diagnosed by how it
      // MOVES, not by its value today, so a single snapshot is close to
      // useless. The BatteryBank column is the current state, so the battery
      // list and any interlock can read it without scanning the history.
      //
      // Before this, the Modbus reader parsed the value and dropped it: it was
      // read off the wire and never stored anywhere, so it could not be trended,
      // alarmed on, or reviewed. A measurement that is collected and discarded
      // is the same defect as one never collected.
      if (readings.battCellBalanceMv !== undefined) {
        writes.push((tx) =>
          tx.sensorReading.create({
            data: {
              tenantId,
              siteId,
              entityKind: "BATTERY",
              entityId: batt.id,
              metric: "BATT_CELL_BALANCE_MV",
              value: readings.battCellBalanceMv!,
              ts: readingDate,
              tsSource,
            },
          }),
        );
        writes.push((tx) =>
          tx.batteryBank.update({
            where: { id: batt.id },
            data: { cellBalanceMv: Math.round(readings.battCellBalanceMv!) },
          }),
        );
      }
    }
  }

  // Ambient temperature (logged at site level)
  const temp = readings.temp;
  if (temp !== undefined) {
    writes.push((tx) =>
      tx.sensorReading.create({
        data: {
          tenantId,
          siteId,
          entityKind: "SITE",
          entityId: siteId,
          metric: "TEMPERATURE",
          value: temp,
          ts: readingDate,
          tsSource,
        },
      }),
    );
  }

  // ── Persist inside the site's tenant context ──────────────────────────
  // The tenant is the one resolved from the SITE above, which is server-side
  // state loaded from the database — never a field from the request body. An
  // unscoped create is rejected outright by WITH CHECK ("new row violates row
  // level security policy"), so this is what makes the path work at all.
  //
  // Same-site guarantees hold because the buffer verdict ran before this: a
  // stale or duplicate reading is refused with 409 above and never reaches a
  // write. Resolving the tenant inside the transaction also means the site and
  // the rows written against it are consistent with one another.
  if (writes.length > 0) {
    await withTenant(tenantId, async (tx) => {
      // Rebuild the writes against the transaction client. They were queued as
      // closures over `tx` above, so they execute inside this transaction.
      //
      // Phase 4 item 4: results are now INSPECTED rather than discarded.
      // `Promise.allSettled` swallowed every rejection, so when two replicas
      // raced on the same replayed reading the loser got a unique-constraint
      // violation that nobody read — and still answered 200, claiming the
      // reading was applied when it had in fact been dropped. The database is
      // the authority for duplicates, which means its verdict has to be
      // reported, not absorbed.
      const results = await Promise.allSettled(writes.map((run) => run(tx)));

      const duplicate = results.find(
        (r): r is PromiseRejectedResult =>
          r.status === "rejected" && isUniqueViolation(r.reason),
      );
      if (duplicate) {
        // Another replica won the race, or this reading was already stored.
        // Same verdict the process-local store produced, now derived from the
        // storage engine rather than from one process's memory.
        throw new DuplicateReadingError();
      }

      // Any OTHER failure keeps the previous best-effort behaviour: a DB hiccup
      // must not stop a device from reporting, so it is logged and swallowed.
      for (const r of results) {
        if (r.status === "rejected" && !isUniqueViolation(r.reason)) {
          console.error("[ingest] write failed (non-duplicate):", r.reason);
        }
      }
    });
  }

  // ── Push to realtime service (browser push via socket.io) ─────────────
  // Emit ONLY to the site room — clients subscribed to this site receive
  // the per-site telemetry update immediately.
  //
  // `ts` is the READING's timestamp, not arrival time, so a browser rendering a
  // late-arriving sample does not present it as happening just now.
  emitToRealtime(
    "telemetry:new",
    {
      siteId,
      readings,
      applied,
      ts: readingDate.getTime(),
      receivedAt: nowMs,
      buffered: deviceTs === null ? "undated" : "timestamped",
    },
    `site:${siteId}`,
  );

  return NextResponse.json({
    ok: true,
    applied,
    ts: readingDate.getTime(),
    receivedAt: nowMs,
    // How far behind the measurement was when it reached us. Zero for an
    // undated reading, which is why `buffered` distinguishes the two.
    uplinkDelayMs: nowMs - readingDate.getTime(),
    buffered: deviceTs === null ? "undated" : "timestamped",
  });
  } catch (err) {
    // Phase 4 item 4: the storage engine refused the insert because this exact
    // (entity, metric, ts) already exists. That is a duplicate, not a fault —
    // another replica accepted this replay first, or the row is already stored.
    // 409 is the same class as the pre-write buffering verdict, so a device
    // sees one consistent answer whether its retry landed on the replica that
    // already had the reading or the one that did not.
    if (err instanceof DuplicateReadingError) {
      const res = NextResponse.json(
        {
          ok: false,
          applied: {},
          buffered: { status: "REJECT_DUPLICATE", source: "database-constraint" },
        },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    return errorResponse(err);
  }
}

/**
 * Raised when the database refuses an insert as an exact duplicate.
 *
 * Distinct from a generic write failure so the handler can map it to 409
 * without inspecting driver internals at the call site.
 */
class DuplicateReadingError extends Error {
  constructor() {
    super("duplicate sensor reading (entity, metric, ts already stored)");
    this.name = "DuplicateReadingError";
  }
}

/**
 * Is this a unique-constraint violation?
 *
 * Prisma reports these as P2002. The check is deliberately narrow — a generic
 * failure must NOT be reported as a duplicate, or a real outage would be
 * mislabelled as a device retry and answered 409, telling a field device to
 * stop retrying while its data is being dropped.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code !== "P2002") return false;
  // Where the driver tells us, confirm it is OUR index and not some other
  // constraint, so an unrelated uniqueness failure is not misreported.
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  if (typeof target === "string") {
    return target.includes("entityId") && target.includes("metric");
  }
  if (Array.isArray(target)) {
    const fields = target.map(String);
    return fields.includes("entityId") && fields.includes("metric") && fields.includes("ts");
  }
  // No target metadata: P2002 on a create from this route is the dedupe index.
  return true;
}

/**
 * GET — minimal discovery endpoint for edge devices to verify connectivity
 * and auth. Returns 200 if the API key is valid, 401 otherwise.
 */
export async function GET(req: NextRequest) {
  const apiKey = req.headers.get("x-api-key");
  let expected: string;
  try {
    expected = iotApiKey();
  } catch (err) {
    return NextResponse.json(
      {
        error: "ingest not configured",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
  if (!apiKey || apiKey !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    endpoint: "/api/fgmp/iot/ingest",
    method: "POST",
    requiredHeaders: ["x-api-key", "content-type: application/json"],
    bodyShape: {
      siteId: "string",
      readings: {
        tankLevel: "number? (litres)",
        genStatus: '"running" | "stopped" | "fault"?',
        genLoad: "number? (kW)",
        battVoltage: "number? (V)",
        battSoc: "number? (0-100)",
        battCellBalanceMv: "number? (signed mV, cell-to-cell imbalance)",
        temp: "number? (°C)",
        ts: "number|string? (device timestamp, epoch millis or ISO-8601)",
      },
    },
  });
}
