/**
 * MFA login-flow tests — the loop, end to end.
 *
 * Run: bun test src/lib/fgmp/mfa/mfa-login-flow.test.ts
 *
 * This covers the three traps the lead named:
 *   1. A pending session must carry NO capabilities, or anything checking roles
 *      BEFORE the guard passes — a control that protects the dashboard but not
 *      /generators/[id]/control.
 *   2. The loop must CLOSE: pending refuses, challenge completes, the new
 *      session is fully authoritative.
 *   3. It must be OBSERVABLE, or the operator sees a login with no prompt.
 *
 * The jwt/session callbacks are exercised directly rather than through a full
 * HTTP sign-in: they are where the pending state is created, cleared and
 * exposed, and driving them directly keeps the test honest about WHICH code
 * makes the decision.
 */

import { describe, expect, test } from "bun:test";
import { authOptions } from "@/lib/auth";
import { evaluatePendingSession } from "./guard";

const cb = authOptions.callbacks!;
const jwtCb = cb.jwt!;
const sessionCb = cb.session!;

type AnyToken = Record<string, unknown>;

function baseToken(): AnyToken {
  return { id: "u-1", email: "op@fgmp.local", name: "Operator" };
}

describe("step 1 — the credentials callback issues a PENDING session", () => {
  test("an enrolled user's first token is pending and carries NO capability", async () => {
    // Simulates what authorize() returns for an MFA-enrolled user.
    const token = await jwtCb({
      token: baseToken() as never,
      user: { id: "u-1", name: "Operator", email: "op@fgmp.local", mfaPending: true } as never,
      account: {} as never,
      profile: undefined,
      trigger: undefined,
    } as never);

    expect(token.mfaPending).toBe(true);
    // The whole point: role and tenantId are ABSENT, not present-but-flagged.
    expect(token.role).toBeUndefined();
    expect(token.tenantId).toBeUndefined();
  });

  test("a non-enrolled user gets a full session", async () => {
    const token = await jwtCb({
      token: baseToken() as never,
      user: { id: "u-1", name: "Op", email: "op@fgmp.local", role: "ADMIN", tenantId: "t-a" } as never,
      account: {} as never,
      profile: undefined,
      trigger: undefined,
    } as never);

    expect(token.mfaPending).toBe(false);
    expect(token.role).toBe("ADMIN");
    expect(token.tenantId).toBe("t-a");
  });
});

describe("step 1 — a pending session cannot escalate via useSession().update()", () => {
  // This is the privilege-escalation path the lead flagged. `update()` is
  // callable by ANY client, and the update branch re-reads role from the
  // database — which would hand back exactly what the login withheld.
  test("trigger=update does NOT restore role/tenantId to a pending token", async () => {
    const token = await jwtCb({
      token: { ...baseToken(), mfaPending: true } as never,
      // No `user` argument — this is a session update, not a sign-in.
      user: undefined,
      account: {} as never,
      profile: undefined,
      trigger: "update",
    } as never);

    expect(token.mfaPending).toBe(true);
    expect(token.role).toBeUndefined();
    expect(token.tenantId).toBeUndefined();
  });

  test("a pending session cannot mint itself SUPERADMIN by asking", async () => {
    const token = await jwtCb({
      token: { ...baseToken(), mfaPending: true, role: "SUPERADMIN" } as never,
      user: undefined,
      account: {} as never,
      profile: undefined,
      trigger: "update",
    } as never);

    // Even a token that somehow arrived with the role must not keep it.
    expect(token.role).toBeUndefined();
  });
});

describe("step 3 — the pending state is observable to the client", () => {
  /** Narrow the callback's union return to the augmented Session shape. */
  function sessionUser(s: unknown): {
    mfaPending?: boolean;
    role?: string;
    tenantId?: string;
  } {
    const u = (s as { user?: Record<string, unknown> }).user;
    if (!u) throw new Error("session callback returned no user");
    return u as { mfaPending?: boolean; role?: string; tenantId?: string };
  }

  test("the session callback exposes mfaPending for the login UI", async () => {
    // Without this the operator sees a successful login and no prompt, and the
    // whole flow is invisible.
    const session = await sessionCb({
      session: { user: { id: "", name: "", email: "" } } as never,
      token: { ...baseToken(), mfaPending: true } as never,
      user: undefined,
      newSession: undefined,
    } as never);

    expect(sessionUser(session).mfaPending).toBe(true);
  });

  test("a pending session exposes NO role to the client either", async () => {
    // Defence in depth: the guard already refuses these paths, but a pending
    // session should not PRESENT a capability to a component deciding what to
    // render.
    const session = await sessionCb({
      session: { user: { id: "", name: "", email: "" } } as never,
      token: { ...baseToken(), mfaPending: true } as never,
      user: undefined,
      newSession: undefined,
    } as never);

    expect(sessionUser(session).role).toBeUndefined();
    expect(sessionUser(session).tenantId).toBeUndefined();
  });

  test("a completed session presents its role normally", async () => {
    const session = await sessionCb({
      session: { user: { id: "", name: "", email: "" } } as never,
      token: { ...baseToken(), mfaPending: false, role: "ADMIN", tenantId: "t-a" } as never,
      user: undefined,
      newSession: undefined,
    } as never);

    expect(sessionUser(session).mfaPending).toBe(false);
    expect(sessionUser(session).role).toBe("ADMIN");
    expect(sessionUser(session).tenantId).toBe("t-a");
  });
});

describe("step 2 — the loop closes", () => {
  test("PENDING refuses every protected route", () => {
    for (const route of [
      "/api/fgmp/generators/[id]/control",
      "/api/fgmp/sites",
      "/api/fgmp/alarms",
      "/api/fgmp/telemetry",
    ]) {
      expect(evaluatePendingSession(route, { mfaPending: true }).blocked).toBe(true);
    }
  });

  test("PENDING can reach the challenge route", () => {
    expect(evaluatePendingSession("/api/fgmp/mfa/challenge", { mfaPending: true }).blocked).toBe(false);
  });

  test("COMPLETED is allowed everywhere", () => {
    // The other half of the loop: a guard that refuses forever would lock
    // every operator out of their own platform.
    for (const route of ["/api/fgmp/generators/[id]/control", "/api/fgmp/sites", "/api/fgmp/alarms"]) {
      expect(evaluatePendingSession(route, { mfaPending: false }).blocked).toBe(false);
      expect(evaluatePendingSession(route, null).blocked).toBe(false);
    }
  });

  test("the transition is real: pending -> completed changes the verdict", () => {
    const route = "/api/fgmp/generators/[id]/control";
    const before = evaluatePendingSession(route, { mfaPending: true });
    const after = evaluatePendingSession(route, { mfaPending: false });
    expect(before.blocked).toBe(true);
    expect(after.blocked).toBe(false);
  });

  test("the blocked response tells the client where to go", () => {
    // A 403 with no pointer leaves the operator stranded on a login page.
    const decision = evaluatePendingSession("/api/fgmp/sites", { mfaPending: true });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.status).toBe(403);
      expect(decision.body.code).toBe("MFA_PENDING");
      expect(decision.body.completeAt).toBe("/api/fgmp/mfa/challenge");
    }
  });
});

describe("MFA off in this deployment costs nothing", () => {
  test("a user with no pending flag is never blocked, on any route", () => {
    // A deployment without MFA must behave exactly as before. If enabling the
    // machinery breaks everyone who has not enrolled, the rollout is wrong.
    for (const route of ["/api/fgmp/sites", "/api/fgmp/tanks", "/api/fgmp/settings"]) {
      expect(evaluatePendingSession(route, undefined).blocked).toBe(false);
      expect(evaluatePendingSession(route, null).blocked).toBe(false);
      expect(evaluatePendingSession(route, { mfaPending: false }).blocked).toBe(false);
    }
  });
});