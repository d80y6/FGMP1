/**
 * Phase 5 task 1 — the site-health agreement test.
 *
 * This file exists because three surfaces computed "how healthy is this site?"
 * with three different formulas and rendered all three. The bug was invisible
 * in review because each formula was internally reasonable and none of them
 * referenced the others beyond a comment claiming they matched.
 *
 * A comment saying "same weighting as X" is not a constraint. This is.
 *
 * Run: bun test src/components/fgmp/__tests__/site-health-score.test.ts
 */
import { describe, test, expect } from "bun:test";
import {
  computeSiteHealth,
  SITE_HEALTH_WEIGHTS,
  SITE_HEALTH_FACTOR_ORDER,
  healthBand,
  HEALTH_BAND_CLASSES,
  alarmScore,
  type SiteHealthInput,
} from "@/lib/health/site-health-score";
import { computeSiteHealth as computeFromBadge } from "../site-health-badge";

/** A representative site: healthy but not perfect. */
const MIXED: SiteHealthInput = {
  site: { status: "DEGRADED" },
  tanks: [
    { current: 4000, capacity: 5000 },
    { current: 1000, capacity: 5000 },
  ],
  generators: [
    { status: "RUNNING" },
    { status: "FAULT" },
    { status: "STOPPED" },
  ],
  batteries: [{ voltage: 48 }, { voltage: 44 }],
  alarmCount: 3,
};

const CASES: [string, SiteHealthInput][] = [
  ["healthy", { site: { status: "ONLINE" }, tanks: [{ current: 5000, capacity: 5000 }], generators: [{ status: "RUNNING" }], batteries: [{ voltage: 50 }], alarmCount: 0 }],
  ["degraded", MIXED],
  ["offline", { site: { status: "OFFLINE" }, tanks: [], generators: [{ status: "FAULT" }], batteries: [], alarmCount: 12 }],
  ["maintenance", { site: { status: "MAINTENANCE" }, tanks: [{ current: 200, capacity: 5000 }], generators: [{ status: "STOPPED" }], batteries: [{ voltage: 47 }], alarmCount: 1 }],
  ["no assets at all", { site: { status: "ONLINE" }, tanks: [], generators: [], batteries: [], alarmCount: 0 }],
  ["empty tank", { site: { status: "ONLINE" }, tanks: [{ current: 0, capacity: 5000 }], generators: [], batteries: [], alarmCount: 0 }],
  ["unknown status", { site: { status: "WAT" }, tanks: [], generators: [], batteries: [], alarmCount: 2 }],
];

describe("canonical weights", () => {
  test("sum to exactly 1.0", () => {
    // If this drifts the score stops being a weighted average and the weights
    // stop meaning anything. A rounded sum is not good enough — the score is
    // derived from these numbers directly.
    const sum = Object.values(SITE_HEALTH_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  test("cover every factor the function returns", () => {
    const { factors } = computeSiteHealth(MIXED);
    expect(Object.keys(factors).sort()).toEqual(Object.keys(SITE_HEALTH_WEIGHTS).sort());
    // And the render order must not omit one.
    expect(SITE_HEALTH_FACTOR_ORDER.length).toBe(Object.keys(SITE_HEALTH_WEIGHTS).length);
  });
});

describe("all surfaces agree", () => {
  // The regression this whole file is for.
  for (const [name, input] of CASES) {
    test(`badge and canonical agree: ${name}`, () => {
      const canonical = computeSiteHealth(input).overall;
      const badge = computeFromBadge({
        site: { ...input.site, loadKw: 0, gridAvailable: true },
        tanks: input.tanks as never,
        generators: input.generators as never,
        batteries: input.batteries as never,
        alarmCount: input.alarmCount,
      }).overall;
      expect(badge).toBe(canonical);
    });
  }
});

describe("score behaviour", () => {
  test("stays within 0-100 for every case", () => {
    for (const [, input] of CASES) {
      const { overall } = computeSiteHealth(input);
      expect(overall).toBeGreaterThanOrEqual(0);
      expect(overall).toBeLessThanOrEqual(100);
    }
  });

  test("empty collections score 100, not 0", () => {
    // A site with no tanks is not "0% fuel" — it has nothing to be wrong about.
    // Scoring it 0 would punish sites for being un-instrumented.
    const { overall, factors } = computeSiteHealth({
      site: { status: "ONLINE" }, tanks: [], generators: [], batteries: [], alarmCount: 0,
    });
    expect(factors.fuel).toBe(100);
    expect(factors.generator).toBe(100);
    expect(factors.battery).toBe(100);
    expect(overall).toBe(100);
  });

  test("an offline site scores lower than an online one with identical assets", () => {
    const base = { tanks: [{ current: 5000, capacity: 5000 }], generators: [{ status: "RUNNING" as const }], batteries: [{ voltage: 50 }], alarmCount: 0 };
    const online = computeSiteHealth({ ...base, site: { status: "ONLINE" } }).overall;
    const offline = computeSiteHealth({ ...base, site: { status: "OFFLINE" } }).overall;
    expect(offline).toBeLessThan(online);
  });

  test("more alarms never increase the score", () => {
    // Monotonicity: this is what a weighted average guarantees, and what the
    // old `-penalty + 15` arithmetic broke (zero alarms scored HIGHER than no
    // measured factor at all).
    let previous = Infinity;
    for (let alarms = 0; alarms <= 12; alarms++) {
      const { overall } = computeSiteHealth({ ...MIXED, alarmCount: alarms });
      expect(overall).toBeLessThanOrEqual(previous);
      previous = overall;
    }
  });

  test("a FAULT generator lowers the score", () => {
    const withFault = computeSiteHealth({
      site: { status: "ONLINE" },
      tanks: [], generators: [{ status: "FAULT" }, { status: "RUNNING" }], batteries: [], alarmCount: 0,
    }).overall;
    const allHealthy = computeSiteHealth({
      site: { status: "ONLINE" },
      tanks: [], generators: [{ status: "RUNNING" }, { status: "STOPPED" }], batteries: [], alarmCount: 0,
    }).overall;
    expect(withFault).toBeLessThan(allHealthy);
  });

  test("alarms saturate rather than driving the score negative", () => {
    const many = computeSiteHealth({ ...MIXED, alarmCount: 9999 });
    expect(many.overall).toBeGreaterThanOrEqual(0);
    expect(many.factors.alarms).toBe(0);
  });

  test("factorKeys carry label and weight for rendering", () => {
    const { factorKeys } = computeSiteHealth(MIXED);
    expect(factorKeys).toHaveLength(5);
    for (const f of factorKeys) {
      expect(f.labelKey).toMatch(/^dash\./);
      expect(f.weight).toMatch(/%$/);
      expect(f.value).toBeGreaterThanOrEqual(0);
      expect(f.value).toBeLessThanOrEqual(100);
    }
  });
});

describe("band scale", () => {
  test("every band has a class entry", () => {
    for (const b of ["excellent", "good", "fair", "poor", "critical"] as const) {
      expect(HEALTH_BAND_CLASSES[b].cls).toBeTruthy();
      expect(HEALTH_BAND_CLASSES[b].dot).toBeTruthy();
    }
  });

  test("band thresholds are the ones the badge used to own", () => {
    expect(healthBand(95)).toBe("excellent");
    expect(healthBand(80)).toBe("good");
    expect(healthBand(65)).toBe("fair");
    expect(healthBand(45)).toBe("poor");
    expect(healthBand(10)).toBe("critical");
  });

  test("is monotonic across the whole range", () => {
    const order = ["excellent", "good", "fair", "poor", "critical"] as const;
    for (let s = 0; s <= 100; s++) {
      const idx = order.indexOf(healthBand(s));
      expect(idx).toBeGreaterThanOrEqual(0);
      // higher score must never be a worse band
      if (s > 0) {
        expect(order.indexOf(healthBand(s))).toBeLessThanOrEqual(order.indexOf(healthBand(s - 1)));
      }
    }
  });
});
/**
 * Phase 5 (analytics task) — the server-side aggregate and the per-site
 * surfaces now share one alarm factor.
 *
 * Before this change the analytics route computed alarm pressure as a per-site
 * density penalty capped at 25 points, while every per-site surface computed
 * it as a bounded factor saturating at 10 alarms. Measured across sampled
 * inputs the two disagreed by up to 80 points on the factor, which is 8 points
 * on the 0-100 headline — enough for the same site to read "healthy" on the
 * dashboard and "unhealthy" on its badge.
 *
 * This asserts the old penalty shape no longer exists anywhere, and that the
 * factor is the one both call.
 */
describe("alarm factor is shared, not re-derived", () => {
  test("the old per-site density penalty is gone from analytics", async () => {
    const src = await Bun.file("src/app/api/fgmp/analytics/route.ts").text();
    // ALARM_PENALTY_PER_SITE / ALARM_PENALTY_CAP defined the old shape.
    expect(src).not.toContain("ALARM_PENALTY_PER_SITE");
    expect(src).not.toContain("ALARM_PENALTY_CAP");
    // And it must actually import the canonical factor rather than inline it.
    expect(src).toContain("alarmScore");
    expect(src).toContain("@/lib/health/site-health-score");
  });

  test("the old private weight table is gone from analytics", async () => {
    const src = await Bun.file("src/app/api/fgmp/analytics/route.ts").text();
    expect(src).not.toContain("const HEALTH_WEIGHTS");
    expect(src).toContain("SITE_HEALTH_WEIGHTS");
  });

  test("alarmScore ignores siteCount, so no caller can reintroduce density", () => {
    // A site has exactly one site. Dividing by a site count would let a fleet
    // of 20 sites hide a genuine alarm backlog behind a per-site average.
    expect(alarmScore(10, 1)).toBe(alarmScore(10, 20));
    expect(alarmScore(10, 1)).toBe(0);
    expect(alarmScore(0, 1)).toBe(100);
  });
});
