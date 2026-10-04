"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Star, ChevronDown, ChevronRight, X } from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import {
  useFavorites,
  useFavoritesHydration,
  resolvePinnedSites,
} from "@/lib/fgmp/use-favorites";
import type { SiteState } from "@/lib/fgmp/types";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/fgmp/use-language";

const COLLAPSED_KEY = "fgmp:favorites-collapsed";

/** Subscribe to localStorage `storage` events for the collapsed flag. */
function subscribeCollapsed(cb: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === COLLAPSED_KEY) cb();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

function getCollapsedSnapshot(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function getCollapsedServerSnapshot(): boolean {
  return false;
}

/** Write the collapsed flag to localStorage and notify same-window listeners. */
function writeCollapsed(v: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
    // `storage` events don't fire in the same window that wrote them,
    // so dispatch a synthetic one to trigger useSyncExternalStore.
    window.dispatchEvent(
      new StorageEvent("storage", { key: COLLAPSED_KEY, newValue: v ? "1" : "0" }),
    );
  } catch {
    /* ignore */
  }
}

/** Status → dot colour, matching the rest of the app's severity semantics. */
function statusDot(status: string): string {
  switch (status) {
    case "ONLINE":
      return "bg-emerald-500";
    case "DEGRADED":
      return "bg-amber-500";
    case "OFFLINE":
      return "bg-rose-500";
    case "MAINTENANCE":
      return "bg-sky-500";
    default:
      return "bg-slate-400";
  }
}

export function PinnedSitesWidget() {
  const t = useT();
  // Hydrate the favorites store from localStorage on mount.
  useFavoritesHydration();

  // Subscribe to individual slices: a bare `useFgmp()` re-renders this
  // component on EVERY store write (search keystrokes, view changes,
  // lastTickAt, …) instead of only the slices actually read.
  const snapshot = useFgmp((s) => s.snapshot);
  const setView = useFgmp((s) => s.setView);
  const selectSite = useFgmp((s) => s.selectSite);

  const ids = useFavorites((s) => s.ids);
  const toggle = useFavorites((s) => s.toggle);

  // Collapsed state, persisted in localStorage. Uses useSyncExternalStore so
  // SSR returns false and the client hydrates from localStorage without a
  // setState-in-effect cascading render.
  const collapsed = useSyncExternalStore(
    subscribeCollapsed,
    getCollapsedSnapshot,
    getCollapsedServerSnapshot,
  );

  const sites = useMemo<SiteState[]>(
    () => resolvePinnedSites(ids, snapshot?.sites ?? []),
    [ids, snapshot?.sites],
  );

  const count = sites.length;

  function goToSite(id: string) {
    setView("sites");
    selectSite(id);
  }

  return (
    <div className="rounded-md border bg-card/50 p-2 text-[11px]">
      {/* Header */}
      <button
        type="button"
        onClick={() => writeCollapsed(!collapsed)}
        className="flex w-full items-center gap-1.5 rounded px-0.5 py-0.5 text-left transition-colors hover:bg-muted/60"
        aria-expanded={!collapsed}
        aria-label={collapsed ? t("pinned.expand") : t("pinned.collapse")}
      >
        <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500" />
        <span className="flex-1 truncate font-semibold text-foreground">
          {t("pinned.title")}
        </span>
        {count > 0 && (
          <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-amber-600 dark:text-amber-400">
            {count}
          </span>
        )}
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>

      {/* Body */}
      {!collapsed && (
        <div className="mt-1.5">
          {count === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-2 py-3 text-center">
              <Star className="h-4 w-4 text-muted-foreground/40" />
              <p className="text-[10px] leading-snug text-muted-foreground">
                {t("pinned.empty")}
              </p>
            </div>
          ) : (
            <div className="max-h-48 space-y-0.5 overflow-y-auto pr-0.5">
              {sites.map((s) => (
                <div
                  key={s.id}
                  className="group flex items-center gap-1.5 rounded px-1 py-1 transition-colors hover:bg-muted/60"
                >
                  <button
                    type="button"
                    onClick={() => goToSite(s.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    title={`Open ${s.name}`}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        statusDot(s.status),
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">
                        {s.name}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {s.code}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(s.id);
                    }}
                    className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-rose-500/10 hover:text-rose-500 focus-visible:opacity-100 group-hover:opacity-100"
                    title="Unpin site"
                    aria-label={`Unpin ${s.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
