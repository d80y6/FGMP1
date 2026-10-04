"use client";

import { create } from "zustand";
import type { Snapshot } from "@/lib/fgmp/types";
import type { Role } from "@/lib/fgmp/types";

export interface Me {
  id: string;
  name: string;
  email: string;
  role: Role;
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
  toggleLive: () => void;
}

export const useFgmp = create<FgmpState>((set, get) => ({
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

  init: async () => {
    try {
      set({ loading: true, error: null });
      // Note: /api/fgmp/me is no longer fetched here — `me` is now derived
      // from the NextAuth session in AppShell and pushed into the store via
      // setMe(). See src/components/fgmp/app-shell.tsx (Task 31-A).
      const res = await fetch("/api/fgmp/state", { credentials: "include" });
      if (!res.ok) {
        set({ loading: false, error: `HTTP ${res.status}` });
        return;
      }
      const stateRes = await res.json();
      set({ snapshot: stateRes, loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  refresh: async () => {
    try {
      const res = await fetch("/api/fgmp/state", { credentials: "include" });
      // Previously `if (!res.ok) return;` — a 401/403/429/500 was swallowed
      // entirely, leaving the last good snapshot on screen behind a
      // healthy-looking header. Record the status + endpoint instead.
      if (!res.ok) {
        set({ error: `HTTP ${res.status} · /api/fgmp/state` });
        return;
      }
      const stateRes = await res.json();
      set({ snapshot: stateRes, error: null });
    } catch (e) {
      set({ error: String(e) });
    }
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

  switchRole: async (role) => {
    const res = await fetch("/api/fgmp/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
      credentials: "include",
    });
    if (!res.ok) {
      // Role switch requires ADMIN (Task 31-A auth-helpers). Non-admins get
      // 403; surface a generic error so the UI can toast it.
      throw new Error(`switchRole failed: ${res.status}`);
    }
    const me = await res.json();
    set({ me });
  },
}));

export function can(view: ViewKey): string {
  return `view:${view}`;
}
