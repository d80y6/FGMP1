"use client";

import { create } from "zustand";
import type { Snapshot } from "@/lib/fgmp/types";
import type { Role } from "@/lib/fgmp/types";
import { canAccessApi } from "@/lib/fgmp/rbac-core";

export interface Me {
  id: string;
  name: string;
  email: string;
  /** Effective role — the previewed one while a preview is active. */
  role: Role;
  /** The DB-backed role. Present so the UI can tell a preview
   *  apart from a real reassignment (proposal §8.16). */
  permanentRole?: Role;
  previewRole?: Role | null;
  tenantId: string;
  roles: Role[];
  permissions: { label: string; description: string; capabilities: string[] };
}

export type ViewKey =
  | "dashboard" | "sites" | "fuel" | "generators" | "batteries"
  | "alarms" | "inventory" | "analytics" | "reports" | "iot"
  | "maintenance" | "audit" | "users" | "system-health" | "suppressions"
  | "preferences" | "dispensers" | "asset-registry" | "edge-firmware"
  | "fuel-forecast" | "consumption-patterns" | "tenants" | "geography"
  | "roles" | "system-settings" | "api-keys"
  | "tenant-isolation";

interface FgmpState {
  snapshot: Snapshot | null;
  /**
   * Identity the cached `snapshot` was fetched FOR, as `identityKey(me)`.
   *
   * The snapshot is one tenant's (or, for SUPERADMIN, every tenant's) operational
   * data. `me` changes without the page unloading — logout, account switch, role
   * preview, demotion, tenant change — and every one of those changes what the
   * caller is ALLOWED to see. Without this marker the store handed the previous
   * identity's data to the next one: sign out of tenant A, sign in as tenant B in
   * the same tab, and the shell painted A's sites, KPIs and alarms until the
   * first /api/fgmp/state response landed. When the earlier session was
   * SUPERADMIN the stale payload was the GLOBAL cross-tenant snapshot.
   *
   * `null` means "no snapshot is valid for anyone" — the initial state and the
   * state after any identity change.
   */
  snapshotOwner: string | null;
  me: Me | null;
  loading: boolean;
  error: string | null;
  view: ViewKey;
  selectedSiteId: string | null;
  regionFilter: string | null; // region id or null
  search: string;
  lastTickAt: number;
  livePaused: boolean;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  tick: (seconds?: number) => Promise<void>;
  setView: (v: ViewKey) => void;
  selectSite: (id: string | null) => void;
  setRegionFilter: (id: string | null) => void;
  setSearch: (s: string) => void;
  /** Set the current user (populated from the NextAuth session by AppShell). */
  setMe: (me: Me | null) => void;
  switchRole: (role: Role) => Promise<void>;
  /** Leave the role preview and return to the permanent role. */
  returnToPermanentRole: () => Promise<void>;
  toggleLive: () => void;
}

/**
 * The identity a data payload belongs to.
 *
 * Includes the ROLE and the TENANT, not just the user id, because the payload
 * itself is role-dependent: `/api/fgmp/state` returns the cross-tenant snapshot
 * for SUPERADMIN and one tenant's snapshot for everyone else. Keying on the id
 * alone would survive a SUPERADMIN→ADMIN change and keep showing a demoted
 * user every tenant's data.
 *
 * Returns null when there is no resolved identity, which never matches a stored
 * key — so "not yet known" also invalidates the cache.
 */
export function identityKey(me: Me | null | undefined): string | null {
  if (!me || !me.id) return null;
  return `${me.id}|${me.role ?? ""}|${me.tenantId ?? ""}`;
}

let stateRequestInFlight: Promise<void> | null = null;

/**
 * Fetch `/api/fgmp/state` on behalf of the CURRENT identity, and only if that
 * identity is allowed to read it.
 *
 * Three guards, all of which the previous inline `fetch()` lacked:
 *
 *  1. **Capability.** The single largest tenant-data response was the one
 *     request in the whole client that bypassed `canAccessApi()`. It is latent
 *     today — every role holds `view:dashboard` — but a raw fetch here means a
 *     future narrowing of that capability would still ship the payload to the
 *     browser, which is the bypass the shared policy check exists to prevent.
 *
 *  2. **Identity.** No resolved `me` means no request. Previously a signed-out
 *     tab polled `/api/fgmp/state` every five seconds forever, which is where
 *     the 401 storm in the console came from.
 *
 *  3. **Arrival order.** The response is committed only if the identity that
 *     asked for it is still the current one. Without this, a slow request from
 *     tenant A that resolves after tenant B signs in writes A's data into a
 *     store B is now reading — the same leak as D-1, one race later.
 */
async function loadState(
  set: (partial: Partial<FgmpState>) => void,
  get: () => FgmpState,
  opts: { initial: boolean },
): Promise<void> {
  const requestedFor = identityKey(get().me);
  if (!requestedFor || !canAccessApi(get().me?.role, "/api/fgmp/state", "GET")) {
    // Nothing to fetch, and nothing to keep: whatever is cached belongs to an
    // identity that is no longer established.
    set({ loading: false, ...(opts.initial ? { snapshot: null, snapshotOwner: null } : {}) });
    return;
  }

  try {
    const res = await fetch("/api/fgmp/state", {
      credentials: "include",
      cache: "no-store",
    });
    if (identityKey(get().me) !== requestedFor) return; // superseded
    if (!res.ok) {
      set({
        loading: false,
        error: `HTTP ${res.status} · /api/fgmp/state`,
        // A 401/403 means this identity may no longer read the snapshot at all.
        ...(res.status === 401 || res.status === 403
          ? { snapshot: null, snapshotOwner: null }
          : {}),
      });
      return;
    }
    const stateRes = await res.json();
    if (identityKey(get().me) !== requestedFor) return; // superseded while parsing
    set({ snapshot: stateRes, snapshotOwner: requestedFor, loading: false, error: null });
  } catch (e) {
    if (identityKey(get().me) !== requestedFor) return;
    set({ loading: false, error: String(e) });
  }
}

export const useFgmp = create<FgmpState>((set, get) => ({
  snapshot: null,
  snapshotOwner: null,
  me: null,
  loading: true,
  error: null,
  view: "dashboard",
  selectedSiteId: null,
  regionFilter: null,
  search: "",
  lastTickAt: 0,
  livePaused: false,

  init: () => {
    if (stateRequestInFlight) return stateRequestInFlight;
    set({ loading: true, error: null });
    // Note: /api/fgmp/me is no longer fetched here — `me` is derived from the
    // NextAuth session in AppShell. Share this request with refresh() so an
    // event or timer cannot race initial hydration.
    stateRequestInFlight = loadState(set, get, { initial: true }).finally(() => {
      stateRequestInFlight = null;
    });
    return stateRequestInFlight;
  },

  refresh: () => {
    if (stateRequestInFlight) return stateRequestInFlight;
    stateRequestInFlight = loadState(set, get, { initial: false }).finally(() => {
      stateRequestInFlight = null;
    });
    return stateRequestInFlight;
  },

  // Retained for existing view call sites after successful writes. Ticking is
  // server-owned; this action is now a scoped state refresh only.
  tick: async (_seconds = 60) => {
    await get().refresh();
    if (!get().error) set({ lastTickAt: Date.now() });
  },

  setView: (v) => set({ view: v, selectedSiteId: null }),
  selectSite: (id) => set({ selectedSiteId: id }),
  setRegionFilter: (id) => set({ regionFilter: id }),
  setSearch: (s) => set({ search: s }),
  /**
   * Adopt the effective identity, dropping any cached payload that belonged to
   * a different one.
   *
   * This is the synchronous half of D-1: the AppShell effect that calls it runs
   * AFTER the render in which a new session first becomes visible, so clearing
   * here alone would still leave one painted frame of the previous identity's
   * data. AppShell therefore also refuses to render a view until `me` is set —
   * see the `!me` gate there. Clearing here keeps the two in step and covers
   * every other caller.
   */
  setMe: (me) =>
    set((s) => {
      const next = identityKey(me);
      if (next === s.snapshotOwner) return { me };
      return { me, snapshot: null, snapshotOwner: null, error: null };
    }),
  toggleLive: () => set((s) => ({ livePaused: !s.livePaused })),

  /**
   * Enter a role preview (proposal §8.16). SESSION-SCOPED: the
   * server signs a 15-minute overlay token and never writes the
   * User row, so the permanent role is preserved and a fresh
   * login returns to it automatically.
   */
  switchRole: async (role) => {
    if (!canAccessApi(get().me?.role, "/api/fgmp/me/preview-role", "POST")) {
      throw new Error("switchRole denied: insufficient capability");
    }
    const res = await fetch("/api/fgmp/me/preview-role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
      credentials: "include",
    });
    if (!res.ok) {
      // Preview requires ADMIN/SUPERADMIN (Task 31-A auth-helpers).
      // Non-admins get 403; surface a generic error so the UI can toast it.
      throw new Error(`switchRole failed: ${res.status}`);
    }
    const me = await res.json();
    // Through setMe, not `set({ me })`: switching to a previewed role changes
    // what /api/fgmp/state would return (SUPERADMIN sees every tenant; ADMIN sees
    // one), so the cached payload must be dropped exactly as on a real role
    // change. A direct set() here would keep the cross-tenant snapshot on screen
    // for the whole preview.
    get().setMe(me);
  },

  /**
   * Leave the role preview — the proposal's "العودة إلى مدير"
   * (Return to Admin) one-click reset. Drops the overlay cookie;
   * the permanent role applies immediately.
   */
  returnToPermanentRole: async () => {
    if (!canAccessApi(get().me?.role, "/api/fgmp/me/preview-role", "DELETE")) {
      throw new Error("returnToPermanentRole denied: no authenticated role");
    }
    const res = await fetch("/api/fgmp/me/preview-role", {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(`returnToPermanentRole failed: ${res.status}`);
    }
    const me = await fetch("/api/fgmp/me", { credentials: "include" }).then((r) => r.json());
    get().setMe(me);
  },
}));

export function can(view: ViewKey): string {
  return `view:${view}`;
}
