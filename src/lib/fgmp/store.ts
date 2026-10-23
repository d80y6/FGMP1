"use client";

import { create } from "zustand";
import type { Snapshot } from "@/lib/fgmp/types";
import type { Role } from "@/lib/fgmp/types";

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

let stateRequestInFlight: Promise<void> | null = null;

export const useFgmp = create<FgmpState>((set) => ({
  snapshot: null,
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
    stateRequestInFlight = (async () => {
      try {
        const res = await fetch("/api/fgmp/state", {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) {
          set({ loading: false, error: `HTTP ${res.status} · /api/fgmp/state` });
          return;
        }
        const stateRes = await res.json();
        set({ snapshot: stateRes, loading: false, error: null });
      } catch (e) {
        set({ loading: false, error: String(e) });
      }
    })().finally(() => {
      stateRequestInFlight = null;
    });
    return stateRequestInFlight;
  },

  refresh: () => {
    if (stateRequestInFlight) return stateRequestInFlight;
    stateRequestInFlight = (async () => {
      try {
        const res = await fetch("/api/fgmp/state", {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) {
          set({ error: `HTTP ${res.status} · /api/fgmp/state` });
          return;
        }
        const stateRes = await res.json();
        set({ snapshot: stateRes, error: null });
      } catch (e) {
        set({ error: String(e) });
      }
    })().finally(() => {
      stateRequestInFlight = null;
    });
    return stateRequestInFlight;
  },

  tick: async (seconds = 60) => {
    try {
      const tickRes = await fetch("/api/fgmp/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seconds }),
        credentials: "include",
      });
      // tick() previously never inspected its own response.
      if (!tickRes.ok) {
        set({ error: `HTTP ${tickRes.status} · /api/fgmp/tick` });
        return;
      }
      const res = await fetch("/api/fgmp/state", { credentials: "include" });
      if (!res.ok) {
        set({ error: `HTTP ${res.status} · /api/fgmp/state` });
        return;
      }
      const stateRes = await res.json();
      set({ snapshot: stateRes, lastTickAt: Date.now(), error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  setView: (v) => set({ view: v, selectedSiteId: null }),
  selectSite: (id) => set({ selectedSiteId: id }),
  setRegionFilter: (id) => set({ regionFilter: id }),
  setSearch: (s) => set({ search: s }),
  setMe: (me) => set({ me }),
  toggleLive: () => set((s) => ({ livePaused: !s.livePaused })),

  /**
   * Enter a role preview (proposal §8.16). SESSION-SCOPED: the
   * server signs a 15-minute overlay token and never writes the
   * User row, so the permanent role is preserved and a fresh
   * login returns to it automatically.
   */
  switchRole: async (role) => {
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
    set({ me });
  },

  /**
   * Leave the role preview — the proposal's "العودة إلى مدير"
   * (Return to Admin) one-click reset. Drops the overlay cookie;
   * the permanent role applies immediately.
   */
  returnToPermanentRole: async () => {
    const res = await fetch("/api/fgmp/me/preview-role", {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(`returnToPermanentRole failed: ${res.status}`);
    }
    const me = await fetch("/api/fgmp/me", { credentials: "include" }).then((r) => r.json());
    set({ me });
  },
}));

export function can(view: ViewKey): string {
  return `view:${view}`;
}
