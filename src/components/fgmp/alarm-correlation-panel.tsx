"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Network, AlertTriangle, Clock, MapPin, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/fgmp/format";
import { useArabicNumerals, formatNumber, useT, useTF } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { alarmTypeLabel } from "@/lib/fgmp/labels";


interface Alarm {
  id: string;
  type: string;
  severity: string;
  status: string;
  message: string;
  siteId: string;
  createdAt: string;
  site?: { name: string; code: string };
}

interface AlarmGroup {
  key: string;
  siteName: string;
  siteCode: string;
  siteId: string;
  count: number;
  types: Set<string>;
  severities: { L1: number; L2: number; L3: number };
  firstAt: string;
  lastAt: string;
  alarms: Alarm[];
}

interface Props {
  alarms: Alarm[] | undefined;
  onSelectSite?: (siteId: string) => void;
}

/**
 * Alarm Correlation & Analysis Panel
 * Groups active alarms by site to reveal correlated incidents and patterns.
 * Shows sites with multiple alarms, dominant alarm types, and time clustering.
 */
export function AlarmCorrelationPanel({ alarms, onSelectSite }: Props) {
  const t = useT();
  const tFmt = useTF();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const groups = useMemo(() => {
    if (!alarms || alarms.length === 0) return [];
    const map = new Map<string, AlarmGroup>();
    for (const a of alarms) {
      const key = a.siteId;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          siteName: a.site?.name ?? "Unknown",
          siteCode: a.site?.code ?? "—",
          siteId: a.siteId,
          count: 0,
          types: new Set(),
          severities: { L1: 0, L2: 0, L3: 0 },
          firstAt: a.createdAt,
          lastAt: a.createdAt,
          alarms: [],
        };
        map.set(key, g);
      }
      g.count++;
      g.types.add(a.type);
      g.severities[a.severity as "L1" | "L2" | "L3"]++;
      if (new Date(a.createdAt) < new Date(g.firstAt)) g.firstAt = a.createdAt;
      if (new Date(a.createdAt) > new Date(g.lastAt)) g.lastAt = a.createdAt;
      g.alarms.push(a);
    }
    // Sort by alarm count descending, then by severity
    return Array.from(map.values())
      .map((g) => ({
        ...g,
        types: Array.from(g.types),
        riskScore: g.count * 2 + g.severities.L3 * 5 + g.severities.L2 * 2 + g.severities.L1,
      }))
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 12); // top 12 correlated sites
  }, [alarms]);

  const totalSites = groups.length;
  const totalAlarms = groups.reduce((s, g) => s + g.count, 0);
  const hotspots = groups.filter((g) => g.count >= 3).length;

  // Find correlated alarm types (types that frequently co-occur at the same site)
  const correlatedTypes = useMemo(() => {
    if (groups.length === 0) return [];
    const pairs = new Map<string, number>();
    for (const g of groups) {
      const types = g.types;
      for (let i = 0; i < types.length; i++) {
        for (let j = i + 1; j < types.length; j++) {
          const pair = [types[i], types[j]].sort().join(" + ");
          pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
        }
      }
    }
    return Array.from(pairs.entries())
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [groups]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Network className="h-4 w-4 text-violet-500" />
          {t("correlation.title")}
          {totalSites > 0 && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {tFmt("correlation.siteAlarmSummary", { sites: formatNumber(totalSites, numLang), alarms: formatNumber(totalAlarms, numLang) })}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-2 text-center">
            <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{t("correlation.hotspots")}</p>
            <p className="text-lg font-bold text-rose-500 tabular-nums">{hotspots}</p>
            <p className="text-[8px] text-muted-foreground">{t("correlation.sitesWithAlarms")}</p>
          </div>
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2 text-center">
            <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{t("correlation.avgPerSite")}</p>
            <p className="text-lg font-bold text-amber-500 tabular-nums">
              {totalSites > 0 ? (totalAlarms / totalSites).toFixed(1) : "0"}
            </p>
            <p className="text-[8px] text-muted-foreground">{t("correlation.alarmsPerSite")}</p>
          </div>
          <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-2 text-center">
            <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{t("correlation.correlations")}</p>
            <p className="text-lg font-bold text-violet-500 tabular-nums">{correlatedTypes.length}</p>
            <p className="text-[8px] text-muted-foreground">{t("correlation.typePairs")}</p>
          </div>
        </div>

        {/* Correlated type pairs */}
        {correlatedTypes.length > 0 && (
          <div className="rounded-lg border p-2.5">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <TrendingUp className="h-3 w-3" />
              {t("correlation.coOccurring")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {correlatedTypes.map(([pair, count]) => (
                <Badge key={pair} variant="outline" className="gap-1 text-[9px]">
                  <span className="font-mono">{alarmTypeLabel(pair, numLang)}</span>
                  <span className="rounded bg-violet-500/15 px-1 text-violet-700 dark:text-violet-400">×{formatNumber(count, numLang)}</span>
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Site alarm clusters */}
        <ScrollArea className="h-[280px]">
          <div className="space-y-1.5 pr-2">
            {groups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Network className="mb-2 h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">{t("correlation.empty")}</p>
                <p className="text-[11px] text-muted-foreground">{t("correlation.emptyHint")}</p>
              </div>
            ) : (
              groups.map((g, idx) => {
                const duration = new Date(g.lastAt).getTime() - new Date(g.firstAt).getTime();
                const durationMin = Math.round(duration / 60000);
                const isHotspot = g.count >= 3;
                return (
                  <button
                    key={g.key}
                    onClick={() => onSelectSite?.(g.siteId)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition-all hover:shadow-sm",
                      isHotspot
                        ? "border-rose-500/30 bg-rose-500/[0.04] hover:bg-rose-500/[0.08]"
                        : "border-border hover:bg-muted/50"
                    )}
                  >
                    {/* Rank */}
                    <div className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                      idx === 0 ? "bg-rose-500/20 text-rose-700 dark:text-rose-400"
                        : idx === 1 ? "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                        : idx === 2 ? "bg-orange-500/20 text-orange-700 dark:text-orange-400"
                        : "bg-muted text-muted-foreground"
                    )}>
                      {idx + 1}
                    </div>

                    {/* Site info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <MapPin className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="truncate text-xs font-semibold">{g.siteName}</span>
                          <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{g.siteCode}</span>
                        </div>
                        <span className="shrink-0 text-xs font-bold tabular-nums text-rose-500">{g.count}</span>
                      </div>

                      {/* Severity breakdown bar */}
                      <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                        {g.severities.L3 > 0 && (
                          <div className="bg-rose-500" style={{ width: `${(g.severities.L3 / g.count) * 100}%` }} title={`L3: ${g.severities.L3}`} />
                        )}
                        {g.severities.L2 > 0 && (
                          <div className="bg-amber-500" style={{ width: `${(g.severities.L2 / g.count) * 100}%` }} title={`L2: ${g.severities.L2}`} />
                        )}
                        {g.severities.L1 > 0 && (
                          <div className="bg-sky-500" style={{ width: `${(g.severities.L1 / g.count) * 100}%` }} title={`L1: ${g.severities.L1}`} />
                        )}
                      </div>

                      {/* Type tags + time */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {g.types.slice(0, 3).map((tp) => (
                          <span key={tp} className="rounded bg-muted px-1 py-0.5 text-[8px] font-mono">
                            {alarmTypeLabel(tp, numLang)}
                          </span>
                        ))}
                        {g.types.length > 3 && (
                          <span className="text-[8px] text-muted-foreground">+{formatNumber(g.types.length - 3, numLang)} more</span>
                        )}
                        <span className="ml-auto flex items-center gap-0.5 text-[9px] text-muted-foreground">
                          <Clock className="h-2.5 w-2.5" />
                          {durationMin > 0 ? `${formatNumber(durationMin, numLang)}m span` : timeAgo(g.firstAt, numLang)}
                        </span>
                      </div>
                    </div>

                    {/* Hotspot indicator */}
                    {isHotspot && (
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 animate-pulse-soft text-rose-500" />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
