"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Crown, Trophy, TrendingUp, Building2, Siren, Droplet, Zap, ChevronRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/fgmp/use-language";

function FactorBar({ label, value, weight, tone }: { label: string; value: number; weight: number; tone: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[10px] text-primary-foreground/70">{label}</span>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-primary-foreground/15">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right text-[10px] font-semibold tabular-nums">{Math.round(value)}</span>
      <span className="w-8 shrink-0 text-right text-[9px] text-primary-foreground/50">{Math.round(weight * 100)}%</span>
    </div>
  );
}

export interface LeaderboardRegion {
  region: string;
  sites: number;
  fuel: number;
  alarms: number;
  running: number;
}

interface RegionLeaderboardProps {
  regions: LeaderboardRegion[];
  totalSites: number;
  /** Optional callback fired when the user clicks a region row. */
  onSelectRegion?: (region: string) => void;
}

/** Avg fuel tank capacity per site, in litres. */
const AVG_TANK_CAPACITY_PER_SITE = 5000;

interface ScoredRegion extends LeaderboardRegion {
  score: number;
  factors: {
    stability: number;
    fuelAvail: number;
    genActivity: number;
    coverage: number;
  };
}

/**
 * Compute a 0-100 performance score for a region.
 *  - Online stability (35%): 100% when alarms < 5% of sites, scaled down for
 *    higher alarm density (reaches 0% at 100% alarm density).
 *  - Fuel availability (25%): fuel / (sites * 5000), capped at 100%.
 *  - Generator activity (20%): running / sites ratio.
 *  - Site coverage (20%): sites / totalSites.
 */
function computeScore(r: LeaderboardRegion, totalSites: number): ScoredRegion {
  const sites = Math.max(1, r.sites);

  // Online stability — 100% if alarms < 5% of sites, scales down above that.
  const alarmDensity = r.alarms / sites; // 0..n
  const stability =
    alarmDensity <= 0.05
      ? 100
      : Math.max(0, 100 - (alarmDensity - 0.05) * 100 * 1.05);

  // Fuel availability — assumes avg 5000L tank per site.
  const fuelAvail = Math.min(100, (r.fuel / (sites * AVG_TANK_CAPACITY_PER_SITE)) * 100);

  // Generator activity — running / sites ratio, capped at 100%.
  const genActivity = Math.min(100, (r.running / sites) * 100);

  // Site coverage — share of the national fleet.
  const coverage = totalSites > 0 ? Math.min(100, (r.sites / totalSites) * 100) : 0;

  const score = Math.round(
    stability * 0.35 + fuelAvail * 0.25 + genActivity * 0.2 + coverage * 0.2,
  );

  return { ...r, score, factors: { stability, fuelAvail, genActivity, coverage } };
}

function scoreColorClasses(score: number): string {
  if (score >= 85) return "text-emerald-500";
  if (score >= 70) return "text-amber-500";
  return "text-rose-500";
}

function scoreBarGradient(score: number): string {
  if (score >= 85) return "bg-gradient-to-r from-emerald-500 to-emerald-400";
  if (score >= 70) return "bg-gradient-to-r from-amber-500 to-amber-400";
  return "bg-gradient-to-r from-rose-500 to-rose-400";
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
          Region Performance Leaderboard
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            <TrendingUp className="mr-1 h-3 w-3" />
            {ranked.length} regions
          </Badge>
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600"
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
                      aria-label={`Rank ${rank}`}
                    >
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
                            "ml-1 h-4 shrink-0 animate-pulse-soft px-1.5 text-[9px] font-bold uppercase tracking-wide",
                            "border border-amber-500/50 bg-amber-500/15 text-amber-600 shadow-[0_0_8px_rgba(245,158,11,0.5)]",
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
                            scoreBarGradient(r.score),
                          )}
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                      <span
                        className={cn(
                          "w-9 text-right text-sm font-bold tabular-nums",
                          scoreColorClasses(r.score),
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
                            scoreBarGradient(r.score),
                          )}
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                      <span
                        className={cn(
                          "w-8 text-right text-sm font-bold tabular-nums",
                          scoreColorClasses(r.score),
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
                      label="Sites"
                      value={`${r.sites}`}
                    />
                    <StatChip
                      icon={<Siren className="h-3 w-3 text-rose-500" />}
                      label="Alarms"
                      value={`${r.alarms}`}
                      tone={r.alarms > 0 ? "text-rose-500" : undefined}
                    />
                    <StatChip
                      icon={<Droplet className="h-3 w-3 text-sky-500" />}
                      label="Fuel (L)"
                      value={r.fuel >= 1000 ? `${(r.fuel / 1000).toFixed(1)}k` : `${r.fuel}`}
                    />
                    <StatChip
                      icon={<Zap className="h-3 w-3 text-amber-500" />}
                      label="Generators running"
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
