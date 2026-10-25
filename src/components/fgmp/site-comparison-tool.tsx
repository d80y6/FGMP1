"use client";

import { useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GitCompare, X, Trophy, TrendingUp, Zap, Droplet, Battery, Activity, Download, Printer, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFgmp } from "@/lib/fgmp/store";
import { toast } from "sonner";
import type { SiteState, TankState, GenState, BattState } from "@/lib/fgmp/types";
import { siteStatusTextClass } from "@/lib/fgmp/status";
import { rowsToCsv } from "@/lib/fgmp/csv";
import { useT } from "@/lib/fgmp/use-language";

interface ComparisonRow {
  label: string;
  icon: typeof Zap;
  getValue: (site: SiteState, tanks: TankState[], gens: GenState[], batts: BattState[]) => number;
  format: (v: number) => string;
  unit: string;
  higherBetter: boolean;
}

const METRICS: ComparisonRow[] = [
  {
    label: "Fuel Level",
    icon: Droplet,
    getValue: (_s, tanks) => tanks.length ? tanks.reduce((a, t) => a + (t.current / t.capacity) * 100, 0) / tanks.length : 0,
    format: (v) => v.toFixed(1),
    unit: "%",
    higherBetter: true,
  },
  {
    label: "Fuel Reserve",
    icon: Droplet,
    getValue: (_s, tanks) => tanks.reduce((a, t) => a + t.current, 0),
    format: (v) => Math.round(v).toLocaleString(),
    unit: "L",
    higherBetter: true,
  },
  {
    label: "Generators Running",
    icon: Zap,
    getValue: (_s, _t, gens) => gens.filter((g) => g.status === "RUNNING").length,
    format: (v) => String(v),
    unit: "",
    higherBetter: false,
  },
  {
    label: "Generator Faults",
    icon: Zap,
    getValue: (_s, _t, gens) => gens.filter((g) => g.status === "FAULT").length,
    format: (v) => String(v),
    unit: "",
    higherBetter: false,
  },
  {
    label: "Avg Gen Temp",
    icon: Activity,
    getValue: (_s, _t, gens) => {
      const valid = gens.filter((g) => typeof g.temperatureC === "number" && !isNaN(g.temperatureC));
      return valid.length ? valid.reduce((a, g) => a + g.temperatureC, 0) / valid.length : NaN;
    },
    format: (v) => isNaN(v) ? "—" : v.toFixed(0),
    unit: "°C",
    higherBetter: false,
  },
  {
    label: "Battery Voltage",
    icon: Battery,
    getValue: (_s, _t, _g, batts) => {
      const valid = batts.filter((b) => typeof b.voltage === "number" && !isNaN(b.voltage));
      return valid.length ? valid.reduce((a, b) => a + b.voltage, 0) / valid.length : NaN;
    },
    format: (v) => isNaN(v) ? "—" : v.toFixed(2),
    unit: "V",
    higherBetter: true,
  },
  {
    label: "Battery Charge",
    icon: Battery,
    getValue: (_s, _t, _g, batts) => {
      const valid = batts.filter((b) => typeof b.stateOfCharge === "number" && !isNaN(b.stateOfCharge));
      return valid.length ? valid.reduce((a, b) => a + b.stateOfCharge, 0) / valid.length : NaN;
    },
    format: (v) => isNaN(v) ? "—" : v.toFixed(0),
    unit: "%",
    higherBetter: true,
  },
  {
    label: "Site Load",
    icon: Zap,
    getValue: (s) => s.loadKw,
    format: (v) => v.toFixed(1),
    unit: "kW",
    higherBetter: false,
  },
  {
    label: "Tank Count",
    icon: Droplet,
    getValue: (_s, tanks) => tanks.length,
    format: (v) => String(v),
    unit: "",
    higherBetter: true,
  },
];

export function SiteComparisonTool() {
  const t = useT();
  const { snapshot, selectSite, setView } = useFgmp(useShallow((s) => ({ snapshot: s.snapshot, selectSite: s.selectSite, setView: s.setView })));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pickerValue, setPickerValue] = useState("");

  // Stable fallback identities — a bare `?? []` is a new array every render.
  const { sites, tanks, generators, batteries } = useMemo(
    () => ({
      sites: snapshot?.sites ?? [],
      tanks: snapshot?.tanks ?? [],
      generators: snapshot?.generators ?? [],
      batteries: snapshot?.batteries ?? [],
    }),
    [snapshot],
  );

  const selectedSites = useMemo(
    () => selectedIds.map((id) => sites.find((s) => s.id === id)).filter(Boolean) as SiteState[],
    [selectedIds, sites]
  );

  const addSite = (id: string) => {
    if (id && !selectedIds.includes(id) && selectedIds.length < 4) {
      setSelectedIds([...selectedIds, id]);
    }
    setPickerValue("");
  };

  const removeSite = (id: string) => {
    setSelectedIds(selectedIds.filter((x) => x !== id));
  };

  // Compute metric values and find the best
  const computedRows = METRICS.map((metric) => {
    const values = selectedSites.map((s) => {
      const siteTanks = tanks.filter((t) => t.siteId === s.id);
      const siteGens = generators.filter((g) => g.siteId === s.id);
      const siteBatts = batteries.filter((b) => b.siteId === s.id);
      return metric.getValue(s, siteTanks, siteGens, siteBatts);
    });
    const bestIdx = metric.higherBetter
      ? values.indexOf(Math.max(...values))
      : values.indexOf(Math.min(...values));
    return { metric, values, bestIdx };
  });


  // Per-site win counts and leading site (most wins)
  const winCounts = selectedSites.map((_, i) =>
    computedRows.filter((r) => r.bestIdx === i).length
  );
  const maxWins = winCounts.length > 0 ? Math.max(...winCounts) : 0;
  const leaderIdx = winCounts.findIndex((w) => w === maxWins);
  const leaderSite = leaderIdx >= 0 && maxWins > 0 ? selectedSites[leaderIdx] : null;

  const handleExportCsv = () => {
    try {
      if (selectedSites.length < 2) {
        toast.error("Select at least 2 sites to export a comparison.");
        return;
      }

      const header = [
        "Metric",
        "Unit",
        ...selectedSites.map((s) => s.name),
        "Best Site",
      ];
      const rows: string[][] = [header];

      computedRows.forEach(({ metric, values, bestIdx }) => {
        const bestSiteName =
          bestIdx >= 0 && bestIdx < selectedSites.length
            ? selectedSites[bestIdx].name
            : "";
        rows.push([
          metric.label,
          metric.unit,
          ...values.map((v) => metric.format(v)),
          bestSiteName,
        ]);
      });

      // Best Count summary row (blank Best Site column)
      rows.push([
        "Best Count",
        "",
        ...winCounts.map((w) => String(w)),
        "",
      ]);

      const csvContent = rowsToCsv(rows);

      const blob = new Blob([csvContent], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `fgmp-site-comparison-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success("Comparison exported");
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handlePrint = () => {
    try {
      window.print();
    } catch (err) {
      toast.error(`Print failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleViewLeaderInSites = () => {
    if (!leaderSite) return;
    selectSite(leaderSite.id);
    setView("sites");
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <GitCompare className="h-4 w-4 text-violet-500" />
          Site Comparison Tool
          {selectedSites.length > 0 && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {selectedSites.length}/4 sites
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Site selector */}
        <div className="flex flex-wrap items-center gap-2">
          <Select label={t("comparison.selectTwo")} value={pickerValue} onValueChange={addSite}>
            <SelectTrigger className="h-8 w-[260px] text-xs" disabled={selectedIds.length >= 4}>
              <SelectValue placeholder={selectedIds.length >= 4 ? "Max 4 sites selected" : "Add a site to compare…"} />
            </SelectTrigger>
            <SelectContent>
              {sites.filter((s) => !selectedIds.includes(s.id)).map((s) => (
                <SelectItem key={s.id} value={s.id} className="text-xs">
                  {s.name} · {s.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedIds.length > 0 && (
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setSelectedIds([])}>
              {t("comparison.clearAll")}
            </Button>
          )}
          {selectedSites.length >= 2 && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-[11px]"
                onClick={handleExportCsv}
              >
                <Download className="h-3 w-3" />
                {t("common.exportCsv")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-[11px]"
                onClick={handlePrint}
              >
                <Printer className="h-3 w-3" />
                Print
              </Button>
            </>
          )}
        </div>

        {/* Selected site chips */}
        {selectedSites.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {selectedSites.map((s) => (
              <div key={s.id} className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium",
                siteStatusTextClass(s.status)
              )}>
                <span className="max-w-[160px] truncate">{s.name}</span>
                <button onClick={() => removeSite(s.id)} className="ml-0.5 rounded-sm hover:bg-foreground/10">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Comparison table */}
        {selectedSites.length >= 2 ? (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="sticky left-0 z-10 bg-muted/30 p-2 text-left font-medium text-muted-foreground">
                    Metric
                  </th>
                  {selectedSites.map((s, i) => (
                    <th key={s.id} className="min-w-[120px] p-2 text-center">
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="text-[9px] text-muted-foreground">Site {i + 1}</span>
                        <span className="max-w-[110px] truncate text-[11px] font-semibold">{s.name}</span>
                        <span className={cn("rounded border px-1 text-[8px]", siteStatusTextClass(s.status))}>{s.status}</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {computedRows.map(({ metric, values, bestIdx }) => {
                  const Icon = metric.icon;
                  return (
                    <tr key={metric.label} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="sticky left-0 z-10 bg-card p-2">
                        <div className="flex items-center gap-1.5">
                          <Icon className="h-3 w-3 text-muted-foreground" />
                          <span className="font-medium">{metric.label}</span>
                        </div>
                      </td>
                      {values.map((v, i) => {
                        const isBest = i === bestIdx;
                        return (
                          <td key={i} className="p-2 text-center">
                            <div className={cn(
                              "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
                              isBest && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                            )}>
                              {isBest && <Trophy className="h-3 w-3" />}
                              <span className={cn("font-bold tabular-nums", isBest && "text-emerald-700 dark:text-emerald-400")}>
                                {metric.format(v)}
                              </span>
                              {metric.unit && <span className="text-[9px] text-muted-foreground">{metric.unit}</span>}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {/* Summary row */}
                <tr className="bg-muted/20 font-medium">
                  <td className="sticky left-0 z-10 bg-muted/20 p-2">
                    <div className="flex items-center gap-1.5">
                      <Trophy className="h-3 w-3 text-amber-500" />
                      <span>{t("comparison.bestCount")}</span>
                    </div>
                  </td>
                  {selectedSites.map((_, i) => {
                    const wins = winCounts[i];
                    const isLeader = wins === maxWins && wins > 0;
                    return (
                      <td key={i} className="p-2 text-center">
                        <span className={cn(
                          "inline-flex items-center gap-1 rounded px-2 py-1 text-sm font-bold tabular-nums",
                          isLeader ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "text-muted-foreground"
                        )}>
                          {isLeader && <TrendingUp className="h-3 w-3" />}
                          {wins}
                          <span className="text-[9px] font-normal">wins</span>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-8 text-center">
            <GitCompare className="mb-2 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{t("comparison.selectTwo")}</p>
            <p className="text-[11px] text-muted-foreground/70">{t("comparison.compareHint")}</p>
          </div>
        )}

        {/* Best Site summary card (only when 2+ sites selected and there is a leader) */}
        {selectedSites.length >= 2 && leaderSite && (
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-gradient-to-br from-amber-500/10 to-transparent p-3 mt-3">
            <div className="flex items-center gap-2.5">
              <Trophy className="h-5 w-5 text-amber-500" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t("comparison.leadingSite")}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{leaderSite.name}</span>
                  <span className="inline-flex items-center gap-1 bg-amber-500/15 text-amber-700 dark:text-amber-400 rounded-full px-2 py-0.5 text-[11px] font-bold">
                    {maxWins} {maxWins === 1 ? "win" : "wins"}
                  </span>
                </div>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-[11px]"
              onClick={handleViewLeaderInSites}
            >
              <ExternalLink className="h-3 w-3" />
              {t("comparison.viewInSites")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
