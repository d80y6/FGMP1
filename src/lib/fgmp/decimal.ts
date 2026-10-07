/**
 * Prisma.Decimal ⇄ number conversion helpers (Phase 1 step 9 groundwork).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Phase 1 step 1 moved the datasource from SQLite to PostgreSQL. Step 9 then
 * converts the double-precision (`Float`) columns that hold fuel volumes and
 * money into `Decimal`, which is the only correct type for litre/riyal
 * accounting — binary floating point cannot represent 0.1 exactly, so float
 * error compounds across a national fuel-delivery ledger and eventually shows
 * up as reconciliation drift that looks like theft.
 *
 * The cost is that Prisma returns `Decimal` objects, not `number`s. Two
 * consequences, both reproduced against the generated client before this
 * module was written:
 *
 *   1. TYPE: a `Decimal` is not assignable to `number` (TS2322), and
 *      `Decimal + number` is rejected (TS2365). The in-memory engine state
 *      (TankState/GenState/BattState in types.ts) is typed `number`, so the
 *      DB→state mapping in engine.ts needs an explicit conversion.
 *
 *   2. SERIALISATION: `JSON.stringify(new Prisma.Decimal("1234.56"))` produces
 *      `{"v":"1234.56"}` — a STRING, not a number. Every API route that
 *      returns a converted field would silently change its JSON contract, and
 *      because a string is still valid JSON the change can pass a typecheck
 *      gate and only surface in a browser or a downstream consumer.
 *
 * These helpers make both conversions explicit and total. They are deliberately
 * NOT wired into metrics-fuel.ts, engine.ts or any route yet: those consume the
 * volume/measurement columns, which are deferred to the step-9 follow-up phase.
 * This round only converts three monetary columns
 * (FuelTransaction.amountYer/unitPriceYer, FuelDelivery.unitPrice), which are
 * pure DB→JSON with no arithmetic.
 *
 * ── Rounding policy ─────────────────────────────────────────────────────────
 * Volume and money must never be silently truncated, so `toNum` rounds to a
 * caller-chosen scale. Default scale 6 suits litres and rial amounts; pass a
 * smaller scale (2) for a presentation-rounded figure, and pass `scale: 0` only
 * for genuinely integral quantities.
 *
 * Rounding mode is JavaScript's `Math.round` semantics — ties round toward
 * +Infinity (HALF_UP in the common sense, but note it is *toward positive*:
 * `toNum(dec("-2.5"), {scale: 0})` is -2, not -3). This is stated explicitly
 * because Decimal.js supports banker's rounding (HALF_EVEN, which is symmetric
 * about zero) and the two disagree on exact .5 ties — `toNum(dec("2.5"),
 * {scale: 0})` is 3 here, whereas HALF_EVEN would give 2. These semantics were
 * chosen because they are what every existing `Math.round` in this codebase
 * already does, so converting a column does not silently change how existing
 * money figures round. Callers who need symmetric banker's rounding must do the
 * arithmetic in Prisma.Decimal first and pass the result in.
 */

/**
 * Anything Prisma can hand back for a Decimal column, plus the shapes that
 * arrive from JSON or from arithmetic. `unknown` is deliberate at the boundary
 * so callers are forced to route every value through this module rather than
 * reaching for a bare `Number()` cast.
 */
export type DecimalLike =
  | number
  | string
  | { toString(): string }
  | { toNumber(): number }
  | null
  | undefined;

/** Default decimal places retained when converting to a JS number. */
export const DEFAULT_DECIMAL_SCALE = 6;

function isNil(v: DecimalLike): v is null | undefined {
  return v === null || v === undefined;
}

/**
 * Convert a Prisma.Decimal (or anything numeric) to a JS `number`, rounded
 * HALF_EVEN to `scale` decimal places.
 *
 * Total by design: every input produces a finite number, never `NaN`. A NaN
 * that reaches a fuel ledger is far worse than a wrong number, because it
 * propagates silently through sums and comparisons and only shows up as a
 * blank dashboard cell.
 *
 * Non-numeric input resolves to `fallback` (default 0) rather than NaN. The
 * caller decides the fallback — a volume may want 0, a monetary total may want
 * to surface the anomaly instead.
 */
export function toNum(
  value: DecimalLike,
  opts: { scale?: number; fallback?: number } = {},
): number {
  const { scale = DEFAULT_DECIMAL_SCALE, fallback = 0 } = opts;

  if (isNil(value)) return fallback;

  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    n = Number(value.trim());
  } else if (typeof (value as { toNumber?: unknown }).toNumber === "function") {
    // Prisma.Decimal exposes toNumber(); use it so the library's own decimal
    // arithmetic semantics (not binary float) produce the result.
    n = (value as { toNumber(): number }).toNumber();
  } else {
    // Prisma.Decimal also satisfies toString(); parsing that preserves the
    // full decimal string rather than going through a lossy float first.
    n = Number(String(value));
  }

  if (!Number.isFinite(n)) return fallback;

  const factor = 10 ** scale;
  const rounded = Math.round(n * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Sum DecimalLike values without accumulating float error.
 *
 * Accumulating a long run of `number`s in JS is exactly the drift Decimal was
 * introduced to remove, so this sums in integer minor units (scaled by
 * `10**scale`) and divides once at the end. For a national delivery ledger
 * this is the difference between a total that reconciles and one that does not.
 */
export function sumDecimals(
  values: DecimalLike[],
  opts: { scale?: number } = {},
): number {
  const scale = opts.scale ?? DEFAULT_DECIMAL_SCALE;
  const factor = 10 ** scale;

  let totalMinor = 0;
  for (const v of values) {
    const n = toNum(v, { scale });
    if (!Number.isFinite(n)) continue;
    // Round each contribution into minor units so the running total stays an
    // integer and cannot drift.
    totalMinor += Math.round(n * factor);
  }
  return totalMinor / factor;
}

/**
 * Multiply a DecimalLike by a plain factor (e.g. volume × unitPrice).
 *
 * Rounds to `scale` — money and volume are never left with sub-cent / sub-litre
 * dust. This is the helper that will replace bare `*` once the volume columns
 * are converted.
 */
export function mulDecimals(
  value: DecimalLike,
  factor: DecimalLike,
  opts: { scale?: number } = {},
): number {
  const scale = opts.scale ?? DEFAULT_DECIMAL_SCALE;
  const a = toNum(value, { scale: DEFAULT_DECIMAL_SCALE });
  const b = toNum(factor, { scale: DEFAULT_DECIMAL_SCALE });
  return toNum(a * b, { scale });
}

/**
 * Serialise a DecimalLike for a JSON response body.
 *
 * IMPORTANT: this returns a NUMBER, never a Decimal. Handing a Decimal straight
 * to `NextResponse.json` stringifies it (JSON.stringify(Decimal) === "1234.56"),
 * which silently changes the API's JSON contract from number to string and can
 * pass a typecheck gate while breaking every consumer. Route handlers that
 * return converted monetary values must call this.
 */
export function toJsonNumber(
  value: DecimalLike,
  opts: { scale?: number; fallback?: number } = {},
): number {
  return toNum(value, opts);
}

/**
 * Recursively convert Prisma.Decimal values to numbers, for a JSON response.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `NextResponse.json()` stringifies a Decimal, because `Decimal.prototype.toJSON`
 * returns its string form. So converting `FuelTank.capacityLitres` to
 * `numeric(12,3)` silently changed the API contract from
 *
 *     { "capacityLitres": 5000 }
 *
 * to
 *
 *     { "capacityLitres": "5000" }
 *
 * without a single type error — a string is valid JSON, and the route handler's
 * inferred return type widens with it. Every numeric consumer of those endpoints
 * (sorting a volume column, summing a fleet total, charting a trend) then
 * produces garbage, and nothing in the toolchain objects.
 *
 * Calling `toJsonNumber()` at each field is correct but is a per-field tax that
 * every future route author has to remember. A route that forgets reintroduces
 * the same bug silently, which is the pattern this function exists to end.
 *
 * ── WHAT IT TOUCHES ──────────────────────────────────────────────────────────
 * Only objects that expose a Prisma-shaped `toNumber()` — i.e. actual Decimals
 * — and plain objects/arrays containing them. `Date` is preserved because
 * `toJSON` on it is meaningful and the route layer wants the ISO string;
 * `bigint` is preserved for the same reason rather than being silently coerced
 * to a lossy number.
 *
 * Depth is bounded so a cyclic object cannot hang the request.
 */
export function decimalsToJson<T>(value: T, depth = 0): T {
  // A cycle here would otherwise be a denial of service on a request path.
  if (depth > 12) return value;

  if (value === null || typeof value !== "object") return value;

  // Dates keep their own toJSON (ISO string). Not coerced to epoch millis —
  // that would be a second, quieter contract change.
  if (value instanceof Date) return value;

  // Prisma.Decimal: has toNumber() and a string toString().
  if (
    typeof (value as { toNumber?: unknown }).toNumber === "function" &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    return toNum(value as DecimalLike, { scale: 3 }) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((v) => decimalsToJson(v, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = decimalsToJson(v, depth + 1);
  }
  return out as T;
}
