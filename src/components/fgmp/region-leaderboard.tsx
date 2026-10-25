"use client";

import { scoreBarClass, scoreTextClass } from "./score-tone";
import { useEffect, useMemo, useState } from "react";
import {
  Crown, Trophy, TrendingUp, Building2, Siren, Droplet, Zap, ChevronRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useT, useTF } from "@/lib/fgmp/use-language";
import { scoreRegion, type RegionScoreFactors } from "@/lib/fgmp/region-score";
import type { RegionBreakdownRow } from "@/lib/fgmp/types";

function FactorBar({ label, value, weight, tone }: { label: string; value: number; weight: number; tone: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[10px] text-primary-foreground/70">{label}</span>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-primary-foreground/15">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right text-[10px] font-semibold tabular-nums">{Math.round(value)}</span>
      <span className="w-8 shrink-0 text-right text-[10px] text-primary-foreground/50">{Math.round(weight * 100)}%</span>
    </div>
  );
}

/**
 * The shape both region surfaces read. Re-exported from the shared payload type
 * so the leaderboard, the trend chart and the analytics response cannot drift
 * apart — `region`/`sites`/`fuel`/`alarms`/`running` are the fields they share.
 */
export type LeaderboardRegion = RegionBreakdownRow;

interface RegionLeaderboardProps {
  regions: LeaderboardRegion[];
  totalSites: number;
  /** Optional callback fired when the user clicks a region row. */
  onSelectRegion?: (region: string) => void;
}

interface ScoredRegion extends LeaderboardRegion {
  score: number;
  factors: RegionScoreFactors;
}

/** Score a region and keep its factors for the expanded row. */
function computeScore(r: LeaderboardRegion, totalSites: number): ScoredRegion {
  return { ...r, ...scoreRegion(r, totalSites) };
}

function rankBadgeClasses(rank: number): string {
  if (rank === 1) return "bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-md shadow-amber-500/30";
  if (rank === 2) return "bg-gradient-to-br from-slate-300 to-slate-400 text-white";
  if (rank === 3) return "bg-gradient-to-br from-orange-400 to-orange-600 text-white";
  return "bg-muted text-muted-foreground";
}

function StatChip({
  icon, label, value, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div
      className="inline-flex items-center gap-1 rounded-md bg-muted/40 px-1.5 py-0.5 text-[10px]"
      title={label}
    >
      <span className={cn("shrink-0", tone)}>{icon}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

export function RegionLeaderboard({ regions, totalSites, onSelectRegion }: RegionLeaderboardProps) {
  const t = useT();
  const tFmt = useTF();
  // Trigger CSS width transitions after mount so bars animate from 0 → score%.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const tm = window.setTimeout(() => setMounted(true), 60);
    return () => window.clearTimeout(tm);
  }, []);

  const ranked = useMemo(() => {
    return regions
      .map((r) => computeScore(r, totalSites))
      .sort((a, b) => b.score - a.score);
  }, [regions, totalSites]);

  if (ranked.length === 0) return null;

  const topScore = ranked[0].score;

  return (
    <Card className="rounded-xl border bg-card/50 backdrop-blur">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Trophy className="h-4 w-4 text-amber-500" />
          {t("leaderboard.title")}
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            <TrendingUp className="mr-1 h-3 w-3" />
            {ranked.length} regions
          </Badge>
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
          >
            Top: {topScore}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 p-3 pt-0 sm:p-4">
        {ranked.map((r, idx) => {
          const rank = idx + 1;
          const isLeader = rank === 1;
          const widthPct = mounted ? r.score : 0;
          return (
            <Tooltip key={r.region} delayDuration={150}>
              <TooltipTrigger asChild>
                <div
                  onClick={() => onSelectRegion?.(r.region)}
                  className={cn(
                    "group relative overflow-hidden rounded-lg border border-transparent px-2.5 py-2 transition-all duration-200 hover:bg-muted/40 sm:px-3",
                    onSelectRegion ? "cursor-pointer" : "cursor-help",
                    isLeader &&
                      "bg-gradient-to-r from-amber-500/10 to-transparent ring-1 ring-amber-500/30",
                    !isLeader && "hover:border-border/60",
                  )}
                >
                  <div className="flex items-center gap-2.5 sm:gap-3">
                    {/* Rank badge */}
                    <div
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums",
                        rankBadgeClasses(rank),
                      )}
                    >
                      <span className="sr-only">{tFmt("leaderboard.rank", { n: rank })}</span>
                      {rank}
                    </div>

                    {/* Region name + leader crown */}
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      {isLeader && (
                        <Crown className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      )}
                      <span className="truncate text-sm font-semibold">{r.region}</span>
                      {isLeader && (
                        <Badge
                          className={cn(
                            "ml-1 h-4 shrink-0 animate-pulse-soft px-1.5 text-[10px] font-bold uppercase tracking-wide",
                            "border border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.5)]",
                          )}
                        >
                          Leader
                        </Badge>
                      )}
                    </div>

                    {/* Score bar + numeric value (desktop) */}
                    <div className="hidden min-w-[140px] flex-1 items-center gap-2 md:flex">
                      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted/60">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all duration-700 ease-out",
                            scoreBarClass(r.score),
                          )}
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                      <span
                        className={cn(
                          "w-9 text-right text-sm font-bold tabular-nums",
                          scoreTextClass(r.score),
                        )}
                      >
                        {r.score}
                      </span>
                    </div>

                    {/* Score numeric value (mobile — no bar to save space) */}
                    <div className="flex items-center gap-2 md:hidden">
                      <div className="relative h-1.5 w-16 overflow-hidden rounded-full bg-muted/60">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all duration-700 ease-out",
                            scoreBarClass(r.score),
                          )}
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                      <span
                        className={cn(
                          "w-8 text-right text-sm font-bold tabular-nums",
                          scoreTextClass(r.score),
                        )}
                      >
                        {r.score}
                      </span>
                    </div>
                  </div>

                  {/* Stat chips row — wraps on mobile, inline on desktop */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-9 sm:pl-10">
                    <StatChip
                      icon={<Building2 className="h-3 w-3 text-emerald-500" />}
                      label={t("kpi.sites")}
                      value={`${r.sites}`}
                    />
                    <StatChip
                      icon={<Siren className="h-3 w-3 text-rose-500" />}
                      label={t("kpi.alarms")}
                      value={`${r.alarms}`}
                      tone={r.alarms > 0 ? "text-rose-500" : undefined}
                    />
                    <StatChip
                      icon={<Droplet className="h-3 w-3 text-sky-500" />}
                      label={t("leaderboard.fuelLitres")}
                      value={r.fuel >= 1000 ? `${(r.fuel / 1000).toFixed(1)}k` : `${r.fuel}`}
                    />
                    <StatChip
                      icon={<Zap className="h-3 w-3 text-amber-500" />}
                      label={t("leaderboard.generatorsRunning")}
                      value={`${r.running}`}
                      tone={r.running > 0 ? "text-amber-500" : undefined}
                    />
                  </div>

                  {/* Hover-revealed drill-down chevron — only when row is clickable */}
                  {onSelectRegion && (
                    <ChevronRight className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent side="left" className="w-64 p-3">
                <div className="space-y-1.5">
                  <p className="mb-1 text-xs font-bold">{r.region} · Score {r.score}</p>
                  <FactorBar label={t("region.stability")} value={r.factors.stability} weight={0.35} tone="bg-emerald-400" />
                  <FactorBar label={t("region.fuelAvail")} value={r.factors.fuelAvail} weight={0.25} tone="bg-sky-400" />
                  <FactorBar label={t("region.genActivity")} value={r.factors.genActivity} weight={0.20} tone="bg-amber-400" />
                  <FactorBar label={t("region.coverage")} value={r.factors.coverage} weight={0.20} tone="bg-violet-400" />
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </CardContent>
    </Card>
  );
}
