/**
 * Every mutating endpoint must declare a rate limit — derived, not remembered.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * Two endpoints shipped without a limiter while their OWN FILES contained one:
 *
 *   POST /platform/support/[tenant]/summary   — the file's GET was limited, the
 *                                               POST was not, so "does this file
 *                                               rate-limit?" said yes
 *   DELETE /platform/support-sessions/[id]    — the file was not limited at all
 *   DELETE /platform/support-sessions/current — same
 *
 * None of those is a dramatic hole on its own; together they are the pattern the
 * RBAC review kept finding: a control that exists in one handler and is silently
 * missing from its sibling, which a reviewer reading the file top-to-bottom has
 * no reason to notice. So the requirement is DERIVED from the route tree instead
 * of being remembered per route.
 *
 * Two of the three findings share a second property worth naming: they are the
 * support-session surface, i.e. the audited path by which a platform operator
 * reaches a customer's data. An unbounded caller there can flood a customer's
 * audit log with operator-attributed rows, or tear the operator's sessions down
 * faster than they can open them. The one surface whose whole purpose is to be
 * accountable was the one with the fewest throttles.
 *
 * ── WHAT COUNTS AS A LIMITER ───────────────────────────────────────────────
 * A call to one of the shared entry points, or to a route-local wrapper over
 * them (`limitFor` in `users/[id]`). The list is short on purpose: adding a new
 * limiter name is a deliberate edit here, which is the moment to ask whether a
 * new mechanism is needed at all.
 *
 * ── WHY AN ALLOWLIST AND NOT A "SKIP" COMMENT ──────────────────────────────
 * Each exemption is a DECISION with a reason, recorded in one place, and this
 * test asserts the exemption is still real: a route that is allowlisted but no
 * longer exists fails, and a route that is allowlisted but has since gained a
 * limiter also fails (a stale exemption is how an allowlist quietly becomes a
 * list of things nobody checked). Three exemptions, each one sentence of why.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The route root, resolved from this file so the working directory does not
 * matter. `src/lib/fgmp/__tests__` → the repository root is three levels up.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const ROUTE_ROOT = join(REPO_ROOT, "src", "app", "api");

/** Shared limiter entry points, plus the one route-local wrapper. */
const LIMITER_CALL =
  /\b(rateLimitByUser|rateLimitByApiKey|rateLimitByIp|rateLimit|limitFor|enforceMutationLimit)\s*\(/;

export interface MutatingHandler {
  /** URL path, e.g. `/api/fgmp/platform/support/t-1/summary`. */
  route: string;
  method: string;
  sourceFile: string;
  /** Whether the handler body calls a limiter. */
  limited: boolean;
}

/**
 * Handlers that deliberately have no limiter, with the reason.
 *
 * Keys are `METHOD route`. Every entry must (a) still exist and (b) still be
 * unlimited — see the assertions at the bottom.
 */
export const UNLIMITED_BY_DESIGN: Record<string, string> = {
  "POST /api/auth/[...nextauth]":
    "NextAuth's own mount point. The login limiter runs inside authorize() (AUTH_LIMIT, per IP) " +
    "and is backed by the per-account lockout in the User row; a second limiter on the mount " +
    "point would also throttle sign-out and session polling, which are not attacker-controlled work.",
  "POST /api/fgmp/tick":
    "Returns 410 unconditionally (`TICK_ENDPOINT_DISABLED`) after requireAuth. It performs no " +
    "database work and mutates nothing, so there is nothing to protect.",
  "POST /api/fgmp/realtime/auth":
    "Called by the Apinator SDK once per private-channel subscription and does a constant-time " +
    "HMAC over a string derived from the session — no database, no writes. The failure mode of " +
    "limiting it is that a reconnect storm leaves a whole tenant without live updates, i.e. the " +
    "limiter would cause the outage it is meant to prevent.",
};

/** Split a route module into its exported handlers. */
function handlersIn(file: string, source: string): MutatingHandler[] {
  // `relative()` returns no leading separator, so the base is `/api/` — writing
  // `/api` here produced `/apiauth/[...nextauth]`, i.e. an allowlist that matched
  // nothing while the test reported "no such handler".
  const route =
    "/api/" +
    relative(join(REPO_ROOT, "src", "app", "api"), file)
      .replace(/\/route\.ts$/, "")
      .split("\\")
      .join("/");
  const starts = [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)];
  return starts.map((m, i) => {
    const from = m.index ?? 0;
    const to = i + 1 < starts.length ? (starts[i + 1].index ?? source.length) : source.length;
    const body = source.slice(from, to);
    return {
      route,
      method: m[1],
      sourceFile: relative(REPO_ROOT, file),
      limited: LIMITER_CALL.test(body),
    };
  });
}

function walkRoutes(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkRoutes(full, found);
    else if (entry === "route.ts") found.push(full);
  }
  return found;
}

const allHandlers: MutatingHandler[] = walkRoutes(ROUTE_ROOT).flatMap((file) =>
  handlersIn(file, readFileSync(file, "utf8")),
);

/** A mutation is any verb that changes state; GET/HEAD/OPTIONS are excluded. */
const mutating = allHandlers.filter((h) => !["GET", "HEAD", "OPTIONS"].includes(h.method));

describe("mutation rate limits: derived from the route tree", () => {
  test("the scan actually found the route tree (guards against a silent empty pass)", () => {
    // A broken walk, or a route root rename, must not turn this into a green no-op.
    expect(allHandlers.length).toBeGreaterThan(150);
    expect(mutating.length).toBeGreaterThan(40);
  });

  test("every mutating handler limits, or is an explained exemption", () => {
    const unexplained = mutating
      .filter((h) => !h.limited)
      .map((h) => `${h.method} ${h.route}`)
      .filter((key) => !(key in UNLIMITED_BY_DESIGN));
    expect(unexplained).toEqual([]);
  });

  test("every exemption still names a handler that exists AND is still unlimited", () => {
    // A stale exemption is worse than no exemption: it reads as a decision that
    // was made about code that has since changed.
    const problems: string[] = [];
    for (const key of Object.keys(UNLIMITED_BY_DESIGN)) {
      const [method, route] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
      const match = mutating.find((h) => h.method === method && h.route === route);
      if (!match) problems.push(`${key}: no such handler (the route moved or was deleted)`);
      else if (match.limited) problems.push(`${key}: now HAS a limiter — delete the exemption`);
    }
    expect(problems).toEqual([]);
  });

  test("the support surface — the audited cross-tenant path — is limited end to end", () => {
    // Named explicitly because this is the reasoning above: these five are the
    // whole support-session control plane, and one of them wrote to a customer's
    // audit log with no throttle at all.
    const required = [
      "POST /api/fgmp/platform/support-sessions",
      "DELETE /api/fgmp/platform/support-sessions/current",
      "POST /api/fgmp/platform/support/[tenant]/summary",
    ];
    const problems = required.filter((key) => {
      const method = key.slice(0, key.indexOf(" "));
      const route = key.slice(key.indexOf(" ") + 1);
      const handler = mutating.find((h) => h.method === method && h.route === route);
      return !handler || !handler.limited;
    });
    expect(problems).toEqual([]);
  });
});
