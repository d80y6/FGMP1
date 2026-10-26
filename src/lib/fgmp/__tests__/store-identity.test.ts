import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { useFgmp, identityKey, type Me } from "../store";
import type { Role } from "../types";

/**
 * D-1 / D-2 / D-3 — the store is the only place in the client that holds a whole
 * tenant's operational data at once, so it is the only place where "which
 * identity is this data for?" can be answered wrongly.
 *
 * These tests drive the REAL Zustand store (no re-implementation, no mocks of
 * the logic under test). Only `fetch` is stubbed, because the question is not
 * whether HTTP works but whether the request is issued at all and whether the
 * response is allowed to land.
 */

function me(overrides: Partial<Me> = {}): Me {
  return {
    id: "u-1",
    name: "Admin A",
    email: "a@example.test",
    role: "ADMIN" as Role,
    tenantId: "t-a",
    roles: ["ADMIN" as Role],
    permissions: { label: "", description: "", capabilities: [] },
    ...overrides,
  };
}

const SNAPSHOT_A = { sites: [{ id: "site-a", name: "Tenant A depot" }], kpis: { fuel: 111 } };
const SNAPSHOT_B = { sites: [{ id: "site-b", name: "Tenant B depot" }], kpis: { fuel: 222 } };

interface Call {
  url: string;
  init?: RequestInit;
}

let calls: Call[];
let respond: (url: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  respond = () => ({ status: 200, body: SNAPSHOT_A });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const r = await respond(url);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  // Reset the singleton between tests. `me: null` also clears the payload,
  // because setMe is the invalidation point.
  useFgmp.setState({
    snapshot: null,
    snapshotOwner: null,
    me: null,
    loading: true,
    error: null,
  });
});

// `fetch` is process-global and other test files may share the process, so put it
// back. A stubbed fetch leaking out of this file would make an unrelated suite
// silently stop reaching the network — the sort of cross-file contamination that
// shows up later as an inexplicable pass.
afterAll(() => {
  globalThis.fetch = realFetch;
});

// ── identityKey ─────────────────────────────────────────────────────────────

describe("identityKey", () => {
  test("is null without an identity — 'unknown' must never match a stored key", () => {
    expect(identityKey(null)).toBeNull();
    expect(identityKey(undefined)).toBeNull();
  });

  test("changes when the user changes", () => {
    expect(identityKey(me({ id: "u-1" }))).not.toBe(identityKey(me({ id: "u-2" })));
  });

  test("changes when ONLY the role changes — the cache is keyed by authority", () => {
    // The payload's SCOPE is the tenant (`/api/fgmp/state` is tenant-scoped for
    // every role, SUPERADMIN included); the role is in the key so the cache
    // belongs to the authority that fetched it. Keying on the user id alone
    // would survive a demotion and leave a demoted user's shell holding data —
    // and, the moment any per-role projection is added, data it may not see.
    expect(identityKey(me({ role: "SUPERADMIN" as Role }))).not.toBe(
      identityKey(me({ role: "ADMIN" as Role })),
    );
  });

  test("changes when only the tenant changes", () => {
    expect(identityKey(me({ tenantId: "t-a" }))).not.toBe(identityKey(me({ tenantId: "t-b" })));
  });
});

// ── D-1: the snapshot never outlives the identity that fetched it ───────────

describe("D-1 — cached snapshot is bound to one identity", () => {
  test("a snapshot survives an unrelated state write but not a logout", async () => {
    useFgmp.getState().setMe(me());
    await useFgmp.getState().init();
    expect(useFgmp.getState().snapshot).toEqual(SNAPSHOT_A as never);

    // Same identity re-asserted (the AppShell effect runs this on every render):
    // the payload must NOT be discarded, or the dashboard would blank itself.
    useFgmp.getState().setMe(me());
    expect(useFgmp.getState().snapshot).toEqual(SNAPSHOT_A as never);

    // Logout.
    useFgmp.getState().setMe(null);
    expect(useFgmp.getState().snapshot).toBeNull();
    expect(useFgmp.getState().snapshotOwner).toBeNull();
  });

  test("signing in as a DIFFERENT tenant's admin discards the previous tenant's data", async () => {
    useFgmp.getState().setMe(me({ id: "u-a", tenantId: "t-a" }));
    await useFgmp.getState().init();
    expect(useFgmp.getState().snapshot).toEqual(SNAPSHOT_A as never);

    // Same tab, account switch. This is the exact sequence in the defect report:
    // between this call and the next successful fetch, no component may read
    // tenant A's sites.
    useFgmp.getState().setMe(me({ id: "u-b", tenantId: "t-b", email: "b@example.test" }));
    expect(useFgmp.getState().snapshot).toBeNull();
  });

  test("a SUPERADMIN demoted to ADMIN loses the snapshot immediately", async () => {
    useFgmp.getState().setMe(me({ role: "SUPERADMIN" as Role, tenantId: "t-platform" }));
    await useFgmp.getState().init();
    expect(useFgmp.getState().snapshotOwner).toBe(identityKey(useFgmp.getState().me));

    // Same user id, same tenant, LOWER role. The data itself does not change —
    // the authority that fetched it does, which is what the cache records.
    useFgmp.getState().setMe(me({ role: "ADMIN" as Role, tenantId: "t-platform" }));
    expect(useFgmp.getState().snapshot).toBeNull();
  });
});

describe("the preview actions invalidate the payload too", () => {
  test("returnToPermanentRole drops the snapshot when the role changes", async () => {
    // A previewed role and the permanent role have different VISIBILITY as well
    // as different permissions, and the cached payload is keyed by the authority
    // that fetched it. Both preview actions therefore go through setMe() rather
    // than writing `me` directly.
    useFgmp.getState().setMe(me({ role: "ADMIN" as Role }));
    await useFgmp.getState().init();
    expect(useFgmp.getState().snapshot).not.toBeNull();

    respond = () => ({ status: 200, body: { ...me({ role: "NOC_OPERATOR" as Role }) } });
    await useFgmp.getState().returnToPermanentRole();

    // The identity the server returned is different from the one the snapshot was
    // fetched for, so the payload must be gone.
    expect(useFgmp.getState().snapshot).toBeNull();
    expect(useFgmp.getState().snapshotOwner).toBeNull();
  });
});

// ── D-2 / D-3: no request without an identity that may make it ──────────────

describe("D-2/D-3 — the state request is gated before it is issued", () => {
  test("no session ⇒ no request at all", async () => {
    await useFgmp.getState().init();
    await useFgmp.getState().refresh();
    expect(calls).toHaveLength(0);
    expect(useFgmp.getState().snapshot).toBeNull();
  });

  test("a role that cannot read view:dashboard ⇒ no request", async () => {
    // Not a real role: the point is that the decision comes from the shared
    // capability policy, not from a hard-coded list in the store.
    useFgmp.getState().setMe(me({ role: "NOT_A_ROLE" as Role }));
    await useFgmp.getState().init();
    expect(calls).toHaveLength(0);
  });

  test("every real role that holds view:dashboard does issue the request", async () => {
    for (const role of ["SUPERADMIN", "ADMIN", "NOC_OPERATOR", "REGIONAL_MANAGER", "FIELD_ENGINEER", "EXECUTIVE", "READONLY"] as Role[]) {
      calls = [];
      useFgmp.setState({ snapshot: null, snapshotOwner: null, me: null, loading: true, error: null });
      useFgmp.getState().setMe(me({ role }));
      await useFgmp.getState().init();
      expect(calls.map((c) => c.url)).toEqual(["/api/fgmp/state"]);
    }
  });

  test("the request carries no-store and same-origin credentials", async () => {
    useFgmp.getState().setMe(me());
    await useFgmp.getState().init();
    expect(calls[0]?.init?.cache).toBe("no-store");
    expect(calls[0]?.init?.credentials).toBe("include");
  });
});

// ── Arrival order: the race the identity key alone does not close ──────────

describe("a response for a superseded identity is discarded", () => {
  test("slow fetch for tenant A cannot land after tenant B signs in", async () => {
    let releaseA: (v: { status: number; body: unknown }) => void = () => {};
    const gate = new Promise<{ status: number; body: unknown }>((resolve) => {
      releaseA = resolve;
    });

    useFgmp.getState().setMe(me({ id: "u-a", tenantId: "t-a" }));
    respond = () => gate;
    const inFlight = useFgmp.getState().init();

    // Tenant B signs in while A's request is still open.
    useFgmp.getState().setMe(me({ id: "u-b", tenantId: "t-b" }));
    releaseA({ status: 200, body: SNAPSHOT_A });
    await inFlight;

    // A's payload must not be committed, and must certainly not be filed under
    // B's identity.
    const s = useFgmp.getState();
    expect(s.snapshotOwner).not.toBe(identityKey(s.me));
    expect(s.snapshot).toBeNull();
  });

  test("a 403 drops the payload — the identity may no longer read it", async () => {
    useFgmp.getState().setMe(me());
    await useFgmp.getState().init();
    expect(useFgmp.getState().snapshot).not.toBeNull();

    respond = () => ({ status: 403, body: { error: "Forbidden" } });
    await useFgmp.getState().refresh();
    expect(useFgmp.getState().snapshot).toBeNull();
    expect(useFgmp.getState().snapshotOwner).toBeNull();
  });

  test("a 500 keeps the last good payload — it is the same identity, transient failure", async () => {
    useFgmp.getState().setMe(me());
    await useFgmp.getState().init();

    respond = () => ({ status: 500, body: { error: "boom" } });
    await useFgmp.getState().refresh();
    expect(useFgmp.getState().snapshot).toEqual(SNAPSHOT_A as never);
    expect(useFgmp.getState().error).toContain("500");
  });
});

describe("refresh after an identity change fetches for the NEW identity", () => {
  test("B's own data is what lands", async () => {
    useFgmp.getState().setMe(me({ id: "u-a", tenantId: "t-a" }));
    await useFgmp.getState().init();
    expect(useFgmp.getState().snapshot).toEqual(SNAPSHOT_A as never);

    useFgmp.getState().setMe(me({ id: "u-b", tenantId: "t-b" }));
    respond = () => ({ status: 200, body: SNAPSHOT_B });
    await useFgmp.getState().init();

    expect(useFgmp.getState().snapshot).toEqual(SNAPSHOT_B as never);
    expect(useFgmp.getState().snapshotOwner).toBe(identityKey(me({ id: "u-b", tenantId: "t-b" })));
  });
});
