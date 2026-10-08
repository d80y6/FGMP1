/**
 * MFA enforcement tests.
 *
 * Run: bun test src/lib/fgmp/mfa/mfa-service.test.ts
 *
 * The headline assertion is `a pending session reaches NO protected route`. That
 * is written as an ENUMERATION over the actual route files on disk rather than
 * as a hand-written list, because a hand-written list is exactly how a guard ends
 * up protecting the dashboard and not /api/fgmp/generators/[id]/control — which
 * is worse than no guard, because it looks like it works.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  evaluatePendingSession,
  isPublicPath,
  pendingSessionMayAccess,
  pendingAllowlistForTest,
} from "./guard";

const API_ROOT = join(process.cwd(), "src/app/api");

/** Every route.ts under src/app/api, as a URL path. */
function enumerateApiRoutes(dir: string = API_ROOT, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (entry.startsWith("(") || entry.startsWith("_")) continue;
    if (statSync(full).isDirectory()) {
      // Next dynamic segments: [id] matches any single segment.
      const segment = entry.startsWith("[") ? "[id]" : entry;
      enumerateApiRoutes(full, acc);
      void segment;
      continue;
    }
    if (entry === "route.ts") {
      acc.push(dir.slice(API_ROOT.length) || "/");
    }
  }
  return acc;
}

const ROUTES = enumerateApiRoutes().map((r) => (r.endsWith("/") ? r : r));

describe("the pending-session guard — the property that matters", () => {
  test("the route enumeration actually found routes", () => {
    // A guard test that enumerates zero routes passes vacuously. This asserts
    // the enumeration works before trusting any conclusion drawn from it.
    expect(ROUTES.length).toBeGreaterThan(20);
  });

  test("a pending session is refused on EVERY protected route on disk", () => {
    const violations: string[] = [];
    for (const route of ROUTES) {
      const decision = evaluatePendingSession(route, { mfaPending: true });
      if (!decision.blocked && !isPublicPath(route)) violations.push(route);
    }
    // The allowlist is the ONLY thing that should let a pending session through.
    expect(violations).toEqual([]);
  });

  test("specifically: control, telemetry, ingest and admin routes are refused", () => {
    // Named explicitly as well as enumerated. These are the routes where a
    // half-authenticated session would do real damage, and a reader should be
    // able to see them refused without running the suite.
    const critical = [
      "/api/fgmp/generators/[id]/control",
      "/api/fgmp/generators",
      "/api/fgmp/tanks",
      "/api/fgmp/iot/ingest",
      "/api/fgmp/alarms",
      "/api/fgmp/settings",
      "/api/fgmp/backups",
      "/api/fgmp/users",
      "/api/fgmp/edge/rs485",
      "/api/fgmp/deliveries",
    ];
    for (const route of critical) {
      expect(evaluatePendingSession(route, { mfaPending: true }).blocked).toBe(true);
    }
  });

  test("the MFA completion route IS reachable, or nobody could ever finish", () => {
    expect(evaluatePendingSession("/api/fgmp/mfa/challenge", { mfaPending: true }).blocked).toBe(false);
    expect(evaluatePendingSession("/api/fgmp/mfa/enrol", { mfaPending: true }).blocked).toBe(false);
  });

  test("logout stays reachable, or a wrong code traps the operator", () => {
    expect(pendingSessionMayAccess("/api/auth/logout")).toBe(true);
    expect(pendingSessionMayAccess("/api/auth/callback/credentials")).toBe(true);
  });

  test("a user with NO pending state is never blocked", () => {
    // MFA must cost nothing when it is not configured — otherwise every
    // deployment without MFA breaks.
    for (const route of ROUTES) {
      expect(evaluatePendingSession(route, null).blocked).toBe(false);
      expect(evaluatePendingSession(route, { mfaPending: false }).blocked).toBe(false);
    }
  });

  test("the allowlist is short and legible", () => {
    // If this list grows, someone is adding a protected route to it. That is
    // the failure mode the allowlist shape exists to make visible.
    const { prefixes, exact } = pendingAllowlistForTest();
    expect(prefixes.length).toBeLessThanOrEqual(3);
    expect(exact.length).toBeLessThanOrEqual(2);
  });

  test("the allowlist grants nothing outside auth and MFA", () => {
    for (const p of pendingAllowlistForTest().prefixes) {
      expect(p === "/api/fgmp/mfa/" || p === "/api/auth/").toBe(true);
    }
  });
});

describe("path classification", () => {
  test("login and the auth API are public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/providers")).toBe(true);
  });

  test("everything under /api/fgmp is NOT public", () => {
    for (const p of ["/api/fgmp/sites", "/api/fgmp/tanks", "/api/fgmp/metrics"]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
});