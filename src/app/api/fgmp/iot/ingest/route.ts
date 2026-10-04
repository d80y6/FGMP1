import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, bootstrap, engine } from "@/lib/fgmp";
import { emitToRealtime } from "@/lib/fgmp/realtime-emitter";
import {
  rateLimitByApiKey,
  applyRateLimitHeaders,
  IOT_LIMIT,
} from "@/lib/fgmp/rate-limit";

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
 *     }
 *   }
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
  temp: z.number().min(-50).max(150).optional(),
});

const IngestBodySchema = z.object({
  siteId: z.string().min(1).max(64),
  readings: ReadingSchema,
});

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
  await bootstrap();

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
  const rl = rateLimitByApiKey(req, IOT_LIMIT.limit, IOT_LIMIT.windowMs);
  if (!rl.success) {
    const res = NextResponse.json(
      { error: "Too many requests", code: "RATE_LIMITED" },
      { status: 429 },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  // ── Parse + validate body ──────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
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
  const { siteId, readings } = parsed.data;
  const now = new Date();
  const nowMs = now.getTime();
  const applied: {
    tank?: string;
    generator?: string;
    battery?: string;
  } = {};
  const writes: Promise<unknown>[] = [];

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
      writes.push(
        db.sensorReading.create({
          data: {
            siteId,
            entityKind: "TANK",
            entityId: tank.id,
            metric: "FUEL_LEVEL",
            value: tank.current,
            ts: now,
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
      writes.push(
        db.sensorReading.create({
          data: {
            siteId,
            entityKind: "GENERATOR",
            entityId: gen.id,
            metric: "LOAD_KW",
            value: gen.loadKw,
            ts: now,
          },
        }),
      );
    }
  }

  // Battery
  if (readings.battVoltage !== undefined || readings.battSoc !== undefined) {
    const batt = engine.batteries.find((b) => b.siteId === siteId);
    if (batt) {
      if (readings.battVoltage !== undefined) batt.voltage = readings.battVoltage;
      if (readings.battSoc !== undefined) batt.stateOfCharge = readings.battSoc;
      batt.lastReadingAt = nowMs;
      batt.history.push({
        t: nowMs,
        v: batt.voltage,
        soc: Math.round(batt.stateOfCharge),
      });
      if (batt.history.length > HISTORY_LIMIT) batt.history.shift();
      applied.battery = batt.id;
      writes.push(
        db.sensorReading.create({
          data: {
            siteId,
            entityKind: "BATTERY",
            entityId: batt.id,
            metric: "BATT_VOLTAGE",
            value: batt.voltage,
            ts: now,
          },
        }),
      );
      writes.push(
        db.sensorReading.create({
          data: {
            siteId,
            entityKind: "BATTERY",
            entityId: batt.id,
            metric: "BATT_SOC",
            value: batt.stateOfCharge,
            ts: now,
          },
        }),
      );
    }
  }

  // Ambient temperature (logged at site level)
  if (readings.temp !== undefined) {
    writes.push(
      db.sensorReading.create({
        data: {
          siteId,
          entityKind: "SITE",
          entityId: siteId,
          metric: "TEMPERATURE",
          value: readings.temp,
          ts: now,
        },
      }),
    );
  }

  // Persist (best-effort — never block the response on a DB hiccup)
  await Promise.allSettled(writes);

  // ── Push to realtime service (browser push via socket.io) ─────────────
  // Emit ONLY to the site room — clients subscribed to this site receive
  // the per-site telemetry update immediately.
  emitToRealtime(
    "telemetry:new",
    { siteId, readings, applied, ts: nowMs },
    `site:${siteId}`,
  );

  return NextResponse.json({ ok: true, applied, ts: nowMs });
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
        temp: "number? (°C)",
      },
    },
  });
}
