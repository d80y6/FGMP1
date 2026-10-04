"use client";

import { useEffect } from "react";
import { create } from "zustand";
import type { SiteState } from "@/lib/fgmp/types";

/**
 * Favorites / Pinned Sites + Recently Viewed Sites store.
 *
 * Two related slices, both persisted to localStorage:
 *
 *  1. Pinned sites (`ids`) — user-curated, FIFO eviction at MAX_PINNED (12).
 *     Storage key: `fgmp:favorites` (JSON array of site IDs, insertion order,
 *     most recently added LAST).
 *
 *  2. Recent sites (`recentSiteIds` + `recentVisitedAt`) — auto-tracked last-
 *     visited sites, most-recent-first, deduped, capped at MAX_RECENT (5).
 *     Storage key: `fgmp:recent-sites` (JSON `{ ids: string[], visitedAt:
 *     Record<string, number> }`).
 *
 * SSR-safe: starts empty on the server and the first client render, then
 * hydrates inside a useEffect to avoid hydration mismatches.
 *
 * Deviation from Task #18 spec: the spec asked for these slices to live in
 * `useFgmp()` (the global app store) with a "persist middleware". The actual
 * codebase has no persist middleware on `useFgmp` — all client-side persisted
 * state uses this separate-store pattern (mirroring `useLanguage`, `useSiteNotes`,
 * etc.). Keeping the slices here avoids polluting the server-state store with
 * UI preferences and lets the existing `useFavoritesHydration()` hook pull in
 * both slices in one effect. The persisted behaviour (max 12 pinned w/ FIFO,
 * max 5 recent w/ MRU-first, deduped) matches the spec exactly.
 */

const STORAGE_KEY = "fgmp:favorites";
const RECENT_STORAGE_KEY = "fgmp:recent-sites";

/** Maximum number of pinned sites (FIFO eviction beyond this). */
const MAX_PINNED = 12;
/** Maximum number of recently-visited sites tracked (MRU-first). */
const MAX_RECENT = 5;

interface RecentSitesPayload {
  ids: string[];
  /** siteId → epoch ms of last visit. Stale entries (no longer in `ids`) are
   *  pruned lazily on read/write. */
  visitedAt: Record<string, number>;
}

interface FavoritesState {
  /** Pinned site IDs, in insertion order (most recently added last). */
  ids: string[];
  /** True until the client-side hydration effect has run at least once. */
  hydrated: boolean;
  /** Recently-visited site IDs, most-recent-first (deduped, capped at MAX_RECENT). */
  recentSiteIds: string[];
  /** siteId → epoch ms of last visit (parallel to recentSiteIds). */
  recentVisitedAt: Record<string, number>;
  /** Toggle a site's pinned state. Enforces MAX_PINNED via FIFO eviction. */
  toggle: (id: string) => void;
  /** Returns true if the given site ID is currently pinned. */
  isFavorite: (id: string) => boolean;
  /** Remove all pinned sites. */
  clear: () => void;
  /** Mark a site as just-visited: moves it to front of recentSiteIds (deduped),
   *  updates recentVisitedAt[id] = Date.now(), caps the list at MAX_RECENT. */
  addRecent: (id: string) => void;
  /** Clear the recent sites list (and its timestamps). Pinned sites untouched. */
  clearRecent: () => void;
  /** Re-read localStorage into state (called on mount and on storage events). */
  hydrate: () => void;
}

function readFromStorage(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Sanitise: keep only unique string IDs, preserve order.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of parsed) {
      if (typeof id === "string" && id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeToStorage(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Ignore quota / privacy mode errors — persistence is best-effort.
  }
}

function readRecentFromStorage(): RecentSitesPayload {
  if (typeof window === "undefined") return { ids: [], visitedAt: {} };
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return { ids: [], visitedAt: {} };
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed?.ids) ? parsed.ids : [];
    const visitedAt =
      parsed?.visitedAt && typeof parsed.visitedAt === "object" ? parsed.visitedAt : {};
    // Sanitise: keep only unique string IDs; drop timestamps for IDs not in `ids`.
    const seen = new Set<string>();
    const cleanIds: string[] = [];
    const cleanVisitedAt: Record<string, number> = {};
    for (const id of ids) {
      if (typeof id === "string" && id && !seen.has(id)) {
        seen.add(id);
        cleanIds.push(id);
        const ts = visitedAt[id];
        cleanVisitedAt[id] = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
      }
    }
    return { ids: cleanIds.slice(0, MAX_RECENT), visitedAt: cleanVisitedAt };
  } catch {
    return { ids: [], visitedAt: {} };
  }
}

function writeRecentToStorage(payload: RecentSitesPayload): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore quota / privacy mode errors — persistence is best-effort.
  }
}

export const useFavorites = create<FavoritesState>((set, get) => ({
  ids: [],
  hydrated: false,
  recentSiteIds: [],
  recentVisitedAt: {},
  toggle: (id) => {
    if (!id) return;
    const current = get().ids;
    let next: string[];
    if (current.includes(id)) {
      // Already pinned → remove.
      next = current.filter((x) => x !== id);
    } else {
      // Not pinned → add. FIFO eviction at MAX_PINNED: drop the oldest (front
      // of the array, since `ids` is in insertion order with most-recently-
      // added LAST). This preserves the existing insertion-order invariant.
      next = [...current, id];
      if (next.length > MAX_PINNED) {
        next = next.slice(next.length - MAX_PINNED);
      }
    }
    writeToStorage(next);
    set({ ids: next });
  },
  isFavorite: (id) => get().ids.includes(id),
  clear: () => {
    writeToStorage([]);
    set({ ids: [] });
  },
  addRecent: (id) => {
    if (!id) return;
    const prev = get().recentSiteIds;
    // Dedupe + move to front. Cap at MAX_RECENT (drop from the tail).
    const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX_RECENT);
    const visitedAt = { ...get().recentVisitedAt, [id]: Date.now() };
    // Prune timestamps for IDs that fell off the list.
    const keep = new Set(next);
    const prunedVisitedAt: Record<string, number> = {};
    for (const [k, v] of Object.entries(visitedAt)) {
      if (keep.has(k)) prunedVisitedAt[k] = v;
    }
    writeRecentToStorage({ ids: next, visitedAt: prunedVisitedAt });
    set({ recentSiteIds: next, recentVisitedAt: prunedVisitedAt });
  },
  clearRecent: () => {
    writeRecentToStorage({ ids: [], visitedAt: {} });
    set({ recentSiteIds: [], recentVisitedAt: {} });
  },
  hydrate: () => {
    const ids = readFromStorage();
    const recent = readRecentFromStorage();
    set({ ids, recentSiteIds: recent.ids, recentVisitedAt: recent.visitedAt, hydrated: true });
  },
}));

/**
 * Convenience selector: subscribe to whether a single site is pinned.
 * Returns false during SSR / before hydration so the first paint is stable.
 */
export function useIsFavorite(id: string | null | undefined): boolean {
  const isFav = useFavorites((s) => (id ? s.ids.includes(id) : false));
  return isFav;
}

/**
 * Mount this once near the top of the client tree to hydrate the store from
 * localStorage and keep it in sync across tabs (storage events). Pulls in
 * BOTH the pinned-sites and recent-sites slices in a single effect.
 */
export function useFavoritesHydration(): void {
  const hydrate = useFavorites((s) => s.hydrate);

  useEffect(() => {
    hydrate();

    function onStorage(e: StorageEvent) {
      // Re-hydrate whenever either persisted slice changes in another tab.
      if (e.key === STORAGE_KEY || e.key === RECENT_STORAGE_KEY || e.key === null) {
        hydrate();
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [hydrate]);
}

/**
 * Resolve a list of pinned site IDs to actual site objects, dropping stale
 * IDs that no longer exist in the snapshot.
 */
export function resolvePinnedSites(ids: string[], sites: SiteState[]): SiteState[] {
  const byId = new Map(sites.map((s) => [s.id, s] as const));
  const out: SiteState[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Resolve a list of recent-visit site IDs to actual site objects (in MRU
 * order), dropping stale IDs that no longer exist in the snapshot.
 */
export function resolveRecentSites(ids: string[], sites: SiteState[]): SiteState[] {
  const byId = new Map(sites.map((s) => [s.id, s] as const));
  const out: SiteState[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (s) out.push(s);
  }
  return out;
}
