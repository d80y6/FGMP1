import { describe, it, expect, beforeEach } from "bun:test";
import {
  MAX_CONCURRENT_TENANTS_PER_OPERATOR,
  SUPPORT_MAX_TTL_SEC,
  SUPPORT_READ_TTL_SEC,
  SUPPORT_WRITE_TTL_SEC,
  SupportSessionError,
  __resetSupportSessionFailures,
  assertSupportTenant,
  assertSupportWritable,
  endSupportSession,
  resolveActiveSupport,
  signSupportToken,
  startSupportSession,
  supportSessionFailures,
  type ActiveSupportSession,
  type NewSupportSession,
  type SupportSessionRow,
  type SupportStore,
} from "../support-session";

/** A secret long enough for the same rule auth.ts applies to session signing. */
const SECRET = "test-secret-that-is-long-enough-for-hmac";
process.env.NEXTAUTH_SECRET = SECRET;

const TENANT_A = "t-default";
const TENANT_B = "t-other";

class MemoryStore implements SupportStore {
  rows: SupportSessionRow[] = [];
  tenants = new Set([TENANT_A, TENANT_B]);
  private seq = 0;
  /** Simulates the partial unique index `SupportSession_one_open_per_actor`. */
  uniqueIndex = true;

  async expireStale(actorUserId: string, now: Date) {
    let n = 0;
    for (const r of this.rows) {
      if (r.actorUserId === actorUserId && !r.endedAt && r.expiresAt <= now) {
        r.endedAt = now;
        r.endReason = "EXPIRED";
        n += 1;
      }
    }
    return n;
  }

  async findOpenForActor(actorUserId: string, now: Date) {
    return (
      this.rows.find((r) => r.actorUserId === actorUserId && !r.endedAt && r.expiresAt > now) ?? null
    );
  }

  async findById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async create(row: NewSupportSession) {
    if (this.uniqueIndex) {
      const open = this.rows.find((r) => r.actorUserId === row.actorUserId && !r.endedAt);
      if (open) {
        // Shaped like Prisma's P2002 so the wrapper's translation is exercised.
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "P2002" });
      }
    }
    this.seq += 1;
    const created: SupportSessionRow = {
      ...row,
      id: `sup_${this.seq}`,
      mode: row.mode,
      endedAt: null,
      endReason: null,
    };
    this.rows.push(created);
    return created;
  }

  async end(id: string, at: Date, reason: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.endedAt) return row ?? null;
    row.endedAt = at;
    row.endReason = reason;
    return row;
  }

  async tenantExists(tenantId: string) {
    return this.tenants.has(tenantId);
  }
}

interface Recorded {
  action: string;
  targetTenantId?: string | null;
  supportSessionId?: string | null;
  actorUserId: string;
  detail: Record<string, unknown>;
}

function harness(nowValue = new Date("2026-10-23T08:00:00Z")) {
  const store = new MemoryStore();
  const platform: Recorded[] = [];
  const notices: Recorded[] = [];
  let clock = nowValue;
  const deps = {
    store,
    secret: SECRET,
    now: () => clock,
    platformAudit: {
      async record(e: Recorded) {
        platform.push(e);
      },
    },
    tenantNotice: {
      async record(e: Recorded) {
        notices.push(e);
      },
    },
  };
  return {
    store,
    platform,
    notices,
    deps,
    advance(sec: number) {
      clock = new Date(clock.getTime() + sec * 1000);
    },
    now: () => clock,
  };
}

const superadmin = { id: "u-super", email: "super@example.test", role: "SUPERADMIN" };
const tenantAdmin = { id: "u-admin", email: "admin@example.test", role: "ADMIN" };

describe("support sessions — who may open one", () => {
  it("refuses a tenant administrator", async () => {
    const h = harness();
    await expect(
      startSupportSession({ actor: tenantAdmin, tenantId: TENANT_A, reason: "investigating ticket 42" }, h.deps),
    ).rejects.toMatchObject({ status: 403, code: "SUPPORT_REQUIRES_SUPERADMIN" });
    expect(h.store.rows).toHaveLength(0);
    expect(h.platform).toHaveLength(0);
  });

  it("refuses an unauthenticated actor (no role)", async () => {
    const h = harness();
    await expect(
      startSupportSession({ actor: { id: "anon" }, tenantId: TENANT_A, reason: "investigating ticket 42" }, h.deps),
    ).rejects.toMatchObject({ code: "SUPPORT_REQUIRES_SUPERADMIN" });
  });

  it("refuses an unknown tenant without writing a session", async () => {
    const h = harness();
    await expect(
      startSupportSession({ actor: superadmin, tenantId: "t-nope", reason: "investigating ticket 42" }, h.deps),
    ).rejects.toMatchObject({ status: 404, code: "SUPPORT_TENANT_UNKNOWN" });
    expect(h.store.rows).toHaveLength(0);
  });

  it("requires a substantive reason and records none of a refused attempt", async () => {
    const h = harness();
    await expect(
      startSupportSession({ actor: superadmin, tenantId: TENANT_A, reason: "test" }, h.deps),
    ).rejects.toMatchObject({ status: 400, code: "SUPPORT_REASON_REQUIRED" });
    expect(h.store.rows).toHaveLength(0);
    expect(h.platform).toHaveLength(0);
  });
});

describe("support sessions — one tenant at a time", () => {
  it("states the concurrency limit as one tenant per operator", () => {
    expect(MAX_CONCURRENT_TENANTS_PER_OPERATOR).toBe(1);
  });

  it("refuses a SECOND session while one is open, even for another tenant", async () => {
    const h = harness();
    await startSupportSession({ actor: superadmin, tenantId: TENANT_A, reason: "first investigation" }, h.deps);

    await expect(
      startSupportSession({ actor: superadmin, tenantId: TENANT_B, reason: "second investigation" }, h.deps),
    ).rejects.toMatchObject({ status: 409, code: "SUPPORT_SESSION_ALREADY_OPEN" });

    // The refusal names the tenant that is actually open, so the operator is
    // not left guessing which session they are holding.
    const open = h.store.rows.filter((r) => !r.endedAt);
    expect(open).toHaveLength(1);
    expect(open[0].tenantId).toBe(TENANT_A);
  });

  it("allows a second tenant only after the first is ended", async () => {
    const h = harness();
    const first = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "first investigation" },
      h.deps,
    );
    await endSupportSession(superadmin, first.session.id, {}, h.deps);

    const second = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_B, reason: "second investigation" },
      h.deps,
    );
    expect(second.session.tenantId).toBe(TENANT_B);
    const open = h.store.rows.filter((r) => !r.endedAt);
    expect(open.map((r) => r.tenantId)).toEqual([TENANT_B]);
  });

  it("the store itself rejects a second open row (the partial unique index)", async () => {
    // Proves the invariant does not depend only on the check in this module:
    // a concurrent request that raced past both checks still hits the index.
    const store = new MemoryStore();
    await store.create({
      actorUserId: superadmin.id,
      actorEmail: "super@example.test",
      tenantId: TENANT_A,
      reason: "investigating ticket 42",
      ticketRef: null,
      mode: "READ",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      ip: null,
      userAgent: null,
    });
    await expect(
      store.create({
        actorUserId: superadmin.id,
        actorEmail: "super@example.test",
        tenantId: TENANT_B,
        reason: "investigating ticket 43",
        ticketRef: null,
        mode: "READ",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        ip: null,
        userAgent: null,
      }),
    ).rejects.toThrow(/unique constraint/);
  });

  it("translates a RACING insert into the same 409, instead of a 500", async () => {
    // The pre-insert check and the insert are not atomic. Simulate the other
    // request winning the race: the check passes, then the index refuses.
    const h = harness();
    // Another request inserted first: the index refuses THIS insert.
    h.store.create = async () => {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "P2002" });
    };
    await expect(
      startSupportSession({ actor: superadmin, tenantId: TENANT_B, reason: "investigating ticket 44" }, h.deps),
    ).rejects.toMatchObject({ status: 409, code: "SUPPORT_SESSION_ALREADY_OPEN" });
  });

  it("closes an EXPIRED session so a new one can be opened, recording why", async () => {
    const h = harness();
    const first = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "first investigation", ttlSec: 60 },
      h.deps,
    );
    h.advance(61);

    const second = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_B, reason: "second investigation" },
      h.deps,
    );
    expect(second.session.tenantId).toBe(TENANT_B);
    const old = h.store.rows.find((r) => r.id === first.session.id);
    expect(old?.endReason).toBe("EXPIRED");
  });
});

describe("support sessions — mode and lifetime", () => {
  it("defaults to READ and one hour", async () => {
    const h = harness();
    const { session } = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42" },
      h.deps,
    );
    expect(session.mode).toBe("READ");
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(SUPPORT_READ_TTL_SEC * 1000);
  });

  it("refuses WRITE without a ticket reference", async () => {
    const h = harness();
    await expect(
      startSupportSession(
        { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42", mode: "WRITE" },
        h.deps,
      ),
    ).rejects.toMatchObject({ status: 400, code: "SUPPORT_TICKET_REQUIRED" });
  });

  it("grants WRITE with a ticket, and refuses a write under a READ session", async () => {
    const h = harness();
    const { session } = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42", mode: "WRITE", ticketRef: "INC-9" },
      h.deps,
    );
    expect(session.mode).toBe("WRITE");
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(SUPPORT_WRITE_TTL_SEC * 1000);
    expect(() => assertSupportWritable(session)).not.toThrow();

    const readOnly: ActiveSupportSession = { ...session, mode: "READ" };
    expect(() => assertSupportWritable(readOnly)).toThrow(SupportSessionError);
    try {
      assertSupportWritable(readOnly);
    } catch (err) {
      expect((err as SupportSessionError).code).toBe("SUPPORT_READ_ONLY");
      expect((err as SupportSessionError).status).toBe(403);
    }
  });

  it("clamps a requested lifetime to the ceiling and refuses a non-positive one", async () => {
    const h = harness();
    const { session } = await startSupportSession(
      {
        actor: superadmin,
        tenantId: TENANT_A,
        reason: "investigating ticket 42",
        ttlSec: SUPPORT_MAX_TTL_SEC * 10,
      },
      h.deps,
    );
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(SUPPORT_MAX_TTL_SEC * 1000);

    const h2 = harness();
    await expect(
      startSupportSession(
        { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42", ttlSec: 0 },
        h2.deps,
      ),
    ).rejects.toMatchObject({ code: "SUPPORT_TTL_INVALID" });
  });
});

describe("support sessions — where the evidence lands", () => {
  it("writes a platform record AND a tenant-visible notice with the reason", async () => {
    const h = harness();
    const { session } = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "Customer reports missing deliveries" },
      h.deps,
    );

    expect(h.platform).toHaveLength(1);
    expect(h.platform[0]).toMatchObject({
      action: "SUPPORT_SESSION_START",
      actorUserId: "u-super",
      targetTenantId: TENANT_A,
      supportSessionId: session.id,
    });
    expect(h.platform[0].detail.reason).toBe("Customer reports missing deliveries");

    // The tenant's own trail names the session and the operator, so the customer
    // can see who looked — not just that "support" did.
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({
      action: "SUPPORT_ACCESS_STARTED",
      tenantId: TENANT_A,
      supportSessionId: session.id,
      actorUserId: "u-super",
    });
  });

  it("records the end, with a duration, in both places", async () => {
    const h = harness();
    const { session } = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42" },
      h.deps,
    );
    h.advance(300);
    const ended = await endSupportSession(superadmin, session.id, { reason: "done" }, h.deps);

    expect(ended.endedAt).not.toBeNull();
    const end = h.platform.find((e) => e.action === "SUPPORT_SESSION_END");
    expect(end?.detail.durationSec).toBe(300);
    expect(h.notices.some((n) => n.action === "SUPPORT_ACCESS_ENDED")).toBe(true);
  });

  it("counts a failed tenant notice instead of dropping it silently", async () => {
    __resetSupportSessionFailures();
    const h = harness();
    h.deps.tenantNotice = {
      async record() {
        throw new Error("audit table unavailable");
      },
    };
    const { session } = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42" },
      h.deps,
    );
    expect(session.tenantId).toBe(TENANT_A);
    expect(supportSessionFailures()).toBe(1);
  });
});

describe("support sessions — the token is not the capability", () => {
  it("resolves only with a valid, user-bound token", async () => {
    const h = harness();
    const { session, token } = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42" },
      h.deps,
    );

    await expect(resolveActiveSupport(superadmin, token, h.deps)).resolves.toMatchObject({
      id: session.id,
      tenantId: TENANT_A,
    });
    // The same token presented by somebody else authorises nothing.
    await expect(resolveActiveSupport({ id: "u-other", role: "SUPERADMIN" }, token, h.deps)).resolves.toBeNull();
    // A tenant administrator holding it gets nothing.
    await expect(resolveActiveSupport({ id: "u-admin", role: "ADMIN" }, token, h.deps)).resolves.toBeNull();
    // Forged / truncated tokens fail closed.
    await expect(resolveActiveSupport(superadmin, token.slice(0, -2) + "xx", h.deps)).resolves.toBeNull();
    await expect(resolveActiveSupport(superadmin, "", h.deps)).resolves.toBeNull();
    await expect(resolveActiveSupport(superadmin, null, h.deps)).resolves.toBeNull();
  });

  it("stops resolving once the session is ended or expired", async () => {
    const h = harness();
    const { session, token } = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42", ttlSec: 60 },
      h.deps,
    );
    await endSupportSession(superadmin, session.id, {}, h.deps);
    await expect(resolveActiveSupport(superadmin, token, h.deps)).resolves.toBeNull();

    const h2 = harness();
    const second = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42", ttlSec: 60 },
      h2.deps,
    );
    h2.advance(61);
    await expect(resolveActiveSupport(superadmin, second.token, h2.deps)).resolves.toBeNull();
  });

  it("refuses a token that names a different tenant than the row", async () => {
    const h = harness();
    const { session, token } = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42" },
      h.deps,
    );
    // Simulate a tampered summary: correctly signed, but pointing at tenant B.
    // The row is the authority, so this must not resolve.
    const forged = signSupportToken(
      {
        sid: session.id,
        sub: superadmin.id,
        tid: TENANT_B,
        mode: "READ",
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      SECRET,
    );
    await expect(resolveActiveSupport(superadmin, forged, h.deps)).resolves.toBeNull();
    await expect(resolveActiveSupport(superadmin, token, h.deps)).resolves.not.toBeNull();
  });
});

describe("support sessions — tenant scoping", () => {
  it("refuses a tenant other than the one the session grants", async () => {
    const h = harness();
    const { session } = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42" },
      h.deps,
    );
    expect(() => assertSupportTenant(session, TENANT_A)).not.toThrow();
    try {
      assertSupportTenant(session, TENANT_B);
      throw new Error("should have refused");
    } catch (err) {
      expect((err as SupportSessionError).code).toBe("SUPPORT_TENANT_MISMATCH");
      expect((err as SupportSessionError).status).toBe(403);
    }
  });
});

describe("support sessions — ending", () => {
  it("refuses to end somebody else's session", async () => {
    const h = harness();
    const { session } = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42" },
      h.deps,
    );
    await expect(
      endSupportSession({ id: "u-other", role: "SUPERADMIN" }, session.id, {}, h.deps),
    ).rejects.toMatchObject({ status: 404, code: "SUPPORT_SESSION_NOT_FOUND" });
    // Still open for the operator who owns it.
    expect(h.store.rows[0].endedAt).toBeNull();
  });

  it("is idempotent", async () => {
    const h = harness();
    const { session } = await startSupportSession(
      { actor: superadmin, tenantId: TENANT_A, reason: "investigating ticket 42" },
      h.deps,
    );
    const first = await endSupportSession(superadmin, session.id, {}, h.deps);
    const second = await endSupportSession(superadmin, session.id, {}, h.deps);
    expect(second.endedAt).toEqual(first.endedAt);
  });
});

beforeEach(() => {
  __resetSupportSessionFailures();
});
