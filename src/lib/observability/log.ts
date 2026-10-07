/**
 * Structured JSON logging.
 *
 * ── WHY THIS FILE IS EXPLICIT ABOUT WHAT NOT TO LOG ──────────────────────────
 * This is a fuel platform for a telecom operator. Logs are shipped, retained and
 * frequently readable by people outside the platform team. Anything written here
 * can end up somewhere it should not be, and two categories are unrecoverable
 * once written:
 *
 *   SECRETS    session cookies, JWTs, passwords, API keys, SMTP credentials,
 *              DB URLs, webhook signing secrets.
 *   CUSTOMER   tank levels, site names, supplier names, fuel volumes, theft
 *              figures — anything that reveals a customer's operations to a
 *              third party with log access.
 *
 * A logger that quietly redacts nothing is a slow data breach. So redaction is
 * enforced HERE, by key name, at serialisation time — not left to the discipline
 * of whoever calls the logger. `redact()` is applied to every context object.
 */

/** Keys whose values are replaced regardless of nesting depth. */
const SECRET_KEYS = new Set([
  "password",
  "newpassword",
  "oldpassword",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "session",
  "sessiontoken",
  "cookie",
  "set-cookie",
  "authorization",
  "apikey",
  "api_key",
  "x-api-key",
  "secret",
  "clientsecret",
  "webhooksecret",
  "auth_token",
  "authtoken",
  "privatekey",
  "databaseurl",
  "database_url",
  "redisurl",
  "nextauthsecret",
  "totp",
  "totpsecret",
  "backupcod",
  "mfacode",
]);

/** Keys whose values are operational data that should not leave the platform. */
const CUSTOMER_KEYS = new Set([
  "levelmm",
  "volumelitres",
  "currentlitres",
  "capacitylitres",
  "volumedeliveredlitres",
  "supplier",
  "driverName".toLowerCase(),
  "vehicleplate",
  "donumber",
  "stolenvalueusd",
  "email",
  "phonenumber",
  "recipient",
  "fullname",
]);

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;
const MAX_STRING = 512;

/**
 * Deep-redact a value.
 *
 * Redacts by KEY NAME at any depth, truncates long strings, and drops values
 * that are not plain data. Depth-bounded so a cyclic object cannot hang the
 * logger.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[depth-limit]";

  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    return s.length > MAX_STRING ? s.slice(0, MAX_STRING) + "…" : s;
  }
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return (value as bigint).toString();
  if (t === "function" || t === "symbol") return "[unloggable]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redact(v, depth + 1));
  }
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (SECRET_KEYS.has(key)) {
        out[k] = REDACTED;
      } else if (CUSTOMER_KEYS.has(key)) {
        // Retained but marked, so the shape of the log survives for debugging
        // without the value itself being quotable in an incident channel.
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return "[unloggable]";
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): LogLevel {
  const v = (process.env.FGMP_LOG_LEVEL ?? "").toLowerCase();
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel()];
}

/**
 * Emit one JSON line.
 *
 * Single-line JSON is the point: a log aggregator can index fields without a
 * parser, and `console.log` of an object pretty-prints differently across
 * runtimes, which defeats that.
 */
export function log(
  level: LogLevel,
  event: string,
  context: Record<string, unknown> = {},
): void {
  if (!enabled(level)) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    // Redaction is applied here, unconditionally. Every caller gets it.
    ...(redact(context) as Record<string, unknown>),
  };

  const json = JSON.stringify(line);
  if (level === "error") console.error(json);
  else if (level === "warn") console.warn(json);
  else console.log(json);
}

export const logger = {
  debug: (event: string, ctx?: Record<string, unknown>) => log("debug", event, ctx),
  info: (event: string, ctx?: Record<string, unknown>) => log("info", event, ctx),
  warn: (event: string, ctx?: Record<string, unknown>) => log("warn", event, ctx),
  error: (event: string, ctx?: Record<string, unknown>) => log("error", event, ctx),
};