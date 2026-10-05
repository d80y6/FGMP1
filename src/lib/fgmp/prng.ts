/**
 * Seedable PRNG (Phase 2 — remove simulated telemetry).
 *
 * `Math.random()` is unseeded, so a run is not reproducible and cannot be
 * asserted against. Anything that fabricates data must be able to replay
 * identically, otherwise a bug in the simulation is indistinguishable from
 * luck.
 *
 * The generator below is the SAME mulberry32 already used in seed.ts and in
 * engine.ts's history backfill. It is extracted here — not reimplemented —
 * so the simulation and the seed cannot drift into producing different streams
 * from the same seed. If you change the algorithm, every fixture built with it
 * changes too, so treat the function body as frozen.
 */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Default simulation seed.
 *
 * Fixed so a demo or a bug report replays identically. Override only via
 * FGMP_SIM_SEED, and only in development — see `simulation.ts`.
 */
export const DEFAULT_SIM_SEED = 20240617;

/**
 * A named, independent random stream.
 *
 * Separate streams rather than one shared sequence, because a stream consumed
 * at a different rate by unrelated code would otherwise shift every subsequent
 * value and make one subsystem's change silently rewrite another's behaviour.
 * `next()` on `tank` always returns the same nth value no matter how often
 * `generator.next()` was called.
 */
export class Rng {
  private next: () => number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
    this.next = mulberry32(seed);
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.next();
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** Uniform element of `arr`. Returns undefined only for an empty array. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  /** In-place Fisher-Yates using this stream, so it stays reproducible. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** A short opaque id, deterministic for a given stream position. */
  suffix(len = 8): string {
    let out = "";
    for (let i = 0; i < len; i++) {
      out += Math.floor(this.next() * 36).toString(36);
    }
    return out;
  }
}

/** Build a set of independent streams from one base seed. */
export function streamsFor(seed: number): Record<string, Rng> {
  return {
    iot: new Rng(seed ^ 0x1111),
    site: new Rng(seed ^ 0x2222),
    generator: new Rng(seed ^ 0x3333),
    tank: new Rng(seed ^ 0x4444),
    battery: new Rng(seed ^ 0x5555),
    dispenser: new Rng(seed ^ 0x6666),
    gateway: new Rng(seed ^ 0x7777),
    misc: new Rng(seed ^ 0x8888),
  };
}