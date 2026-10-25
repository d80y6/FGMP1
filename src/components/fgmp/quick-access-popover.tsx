"use client";

import { useMemo, useState } from "react";
import { Pin, X, History, Sparkles, Trash2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/fgmp/status-badge";
import { useFgmp } from "@/lib/fgmp/store";
import {
  useFavorites,
  useFavoritesHydration,
  resolvePinnedSites,
  resolveRecentSites,
} from "@/lib/fgmp/use-favorites";
import { timeAgo } from "@/lib/fgmp/format";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { cn } from "@/lib/utils";

/**
 * Quick Access popover (#18) — pinned + recently-visited sites one click away.
 *
 * Mounted in the top header next to the global search. Renders a `Pin` icon
 * button with a small amber badge showing the pinned count. Clicking opens a
 * shadcn Popover with two stacked sections (Pinned Sites, Recent Sites) and a
 * "Clear recent" footer.
 *
 * The pinned-count badge uses a `key={count}` prop so the popover-trigger
 * badge re-mounts whenever the count changes, retriggering the one-shot
 * `animate-pin-pop` keyframe (defined in globals.css) — a subtle pulse so the
 * user notices the count just changed.
 */
export function QuickAccessPopover() {
  // Hydrate the favorites + recent-sites store on mount (idempotent).
  useFavoritesHydration();
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  // Subscribe to individual slices: a bare `useFgmp()` re-renders this
  // component on EVERY store write (search keystrokes, view changes,
  // lastTickAt, …) instead of only the slices actually read.
  const snapshot = useFgmp((s) => s.snapshot);
  const setView = useFgmp((s) => s.setView);
  const selectSite = useFgmp((s) => s.selectSite);

  const pinnedIds = useFavorites((s) => s.ids);
  const toggle = useFavorites((s) => s.toggle);
  const recentIds = useFavorites((s) => s.recentSiteIds);
  const recentVisitedAt = useFavorites((s) => s.recentVisitedAt);
  const addRecent = useFavorites((s) => s.addRecent);
  const clearRecent = useFavorites((s) => s.clearRecent);
  const [open, setOpen] = useState(false);

  // Stable fallback identity — see command-palette: a bare `?? []` is a new
  // array on every render, which defeats the memos below.
  const allSites = useMemo(() => snapshot?.sites ?? [], [snapshot]);
  const pinnedSites = useMemo(
    () => resolvePinnedSites(pinnedIds, allSites),
    [pinnedIds, allSites],
  );
  const recentSites = useMemo(
    () => resolveRecentSites(recentIds, allSites),
    [recentIds, allSites],
  );

  const pinnedCount = pinnedIds.length;

  function goToSite(id: string) {
    selectSite(id);
    setView("sites");
    addRecent(id);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="relative"
          aria-label={t("nav.quickAccess")}
          title={t("nav.quickAccess")}
        >
          <Pin className="h-4 w-4" />
          {pinnedCount > 0 && (
            <Badge
              key={pinnedCount}
              variant="secondary"
              className="absolute -right-1 -top-1 h-4 min-w-4 animate-pin-pop bg-amber-500 px-1 text-[10px] font-bold leading-none text-white"
              aria-label={formatNumber(pinnedCount, numLang)}
            >
              {formatNumber(pinnedCount, numLang)}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 p-0"
      >
        {/* Header — Pin icon + title */}
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Pin className="h-4 w-4 fill-amber-400 text-amber-500" />
          <span className="text-sm font-semibold">{t("nav.quickAccess")}</span>
        </div>

        {/* Pinned Sites section */}
        <div className="border-b">
          <div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5">
            <Sparkles className="h-3 w-3 text-amber-500" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("nav.pinnedSites")}
            </span>
            {pinnedCount > 0 && (
              <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-amber-700 dark:text-amber-400">
                {formatNumber(pinnedCount, numLang)}
              </span>
            )}
          </div>
          {pinnedSites.length === 0 ? (
            <EmptyState
              icon={<Pin className="h-4 w-4" />}
              text={t("nav.noPinned")}
            />
          ) : (
            <ScrollArea className="max-h-80">
              <div className="px-1.5 pb-1.5">
                {pinnedSites.map((s) => (
                  <div
                    key={s.id}
                    className="group flex items-center gap-1.5 rounded px-1.5 py-1.5 transition-colors hover:bg-muted/60"
                  >
                    <button
                      type="button"
                      onClick={() => goToSite(s.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      title={s.name}
                    >
                      <StatusBadge value={s.status} className="h-5 shrink-0 px-1 text-[9px]" showShape={false} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {s.name}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-muted-foreground">
                          {s.code} · {s.governorate}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(s.id);
                      }}
                      className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-rose-500/10 hover:text-rose-500 focus-visible:opacity-100 group-hover:opacity-100"
                      title={t("sites.unpinSite")}
                      aria-label={t("sites.unpinSite")}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>

        {/* Recent Sites section */}
        <div className="border-b">
          <div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5">
            <History className="h-3 w-3 text-muted-foreground" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("nav.recentSites")}
            </span>
            {recentSites.length > 0 && (
              <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-muted-foreground">
                {formatNumber(recentSites.length, numLang)}
              </span>
            )}
          </div>
          {recentSites.length === 0 ? (
            <EmptyState
              icon={<History className="h-4 w-4" />}
              text={t("nav.noRecent")}
            />
          ) : (
            <ScrollArea className="max-h-80">
              <div className="px-1.5 pb-1.5">
                {recentSites.map((s) => {
                  const ts = recentVisitedAt[s.id];
                  return (
                    <div
                      key={s.id}
                      className="group flex items-center gap-1.5 rounded px-1.5 py-1.5 transition-colors hover:bg-muted/60"
                    >
                      <button
                        type="button"
                        onClick={() => goToSite(s.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        title={s.name}
                      >
                        <StatusBadge value={s.status} className="h-5 shrink-0 px-1 text-[9px]" showShape={false} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-foreground">
                            {s.name}
                          </span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {typeof ts === "number" ? timeAgo(ts, numLang) : ""}
                          </span>
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </div>

        {/* Footer — Clear recent */}
        <div className="flex items-center justify-end px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-[11px] text-muted-foreground hover:text-rose-500"
            disabled={recentSites.length === 0}
            onClick={() => clearRecent()}
          >
            <Trash2 className="h-3 w-3" />
            {t("nav.clearRecent")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Shared empty-state row: subtle icon + muted hint text, no plain-text look. */
function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-3 py-4 text-center">
      <span className={cn("text-muted-foreground/50")}>{icon}</span>
      <p className="text-[10px] leading-snug text-muted-foreground">{text}</p>
    </div>
  );
}
