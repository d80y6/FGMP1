"use client";

import type React from "react";
import { useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Zap, Power, AlertOctagon, RotateCcw, Search, Thermometer, Clock, Fuel as FuelIcon } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { StatusBadge } from "@/components/fgmp/status-badge";
import { RemoteControlDialog } from "@/components/fgmp/remote-control-dialog";
import { CommandHistoryPanel, type CommandHistoryItem } from "@/components/fgmp/command-history-panel";
import { MaintenancePredictionPanel } from "@/components/fgmp/maintenance-prediction-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/fgmp/format";
import type { GenCommand } from "@/lib/fgmp/types";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";

export function GeneratorsView() {
  const { snapshot, tick } = useFgmp(useShallow((s) => ({ snapshot: s.snapshot, tick: s.tick })));
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const [q, setQ] = useState("");
  const [ctrl, setCtrl] = useState<{ id: string; label: string; site: string; cmd: GenCommand } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const { data: commands } = useApi<{ commands: CommandHistoryItem[] }>("/api/fgmp/reports?period=daily", { interval: 20000 });

  const gens = useMemo(() => {
    if (!snapshot) return [];
    const siteOf = (id: string) => snapshot.sites.find((s) => s.id === id);
    let list = snapshot.generators.map((g) => ({ ...g, site: siteOf(g.siteId)?.name ?? "—", code: siteOf(g.siteId)?.code ?? "", region: siteOf(g.siteId)?.region ?? "" }));
    if (q) list = list.filter((g) => `${g.label} ${g.site} ${g.code} ${g.manufacturer}`.toLowerCase().includes(q.toLowerCase()));
    return list;
  }, [snapshot, q]);

  if (!snapshot) return null;
  const k = snapshot.kpis;
  const running = gens.filter((g) => g.status === "RUNNING");
  const fault = gens.filter((g) => g.status === "FAULT");
  const dueMaint = gens.filter((g) => g.runtimeHours >= g.nextMaintenanceHrs - 20);

  const detail = detailId ? gens.find((g) => g.id === detailId) : null;

  const doControl = (g: typeof gens[0], cmd: GenCommand) => {
    setCtrl({ id: g.id, label: g.label, site: g.site, cmd });
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.generators")}
        description={t("desc.generators")}
        icon={<Zap className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label={t("generators.running")} value={formatNumber(k.generatorsRunning, numLang)} unit={`/ ${formatNumber(k.generatorsTotal, numLang)}`} icon={<Zap className="h-4 w-4" />} tone="good" />
        <KpiCard label={t("generators.fault")} value={formatNumber(fault.length, numLang)} icon={<AlertOctagon className="h-4 w-4" />} tone={fault.length ? "danger" : "good"} />
        <KpiCard label={t("generators.stopped")} value={formatNumber(gens.filter((g) => g.status === "STOPPED").length, numLang)} icon={<Power className="h-4 w-4" />} />
        <KpiCard label={t("generators.avgTemp")} value={`${formatNumber(Math.round(running.reduce((a, g) => a + g.temperatureC, 0) / (running.length || 1)), numLang)}°C`} icon={<Thermometer className="h-4 w-4" />} tone="info" />
        <KpiCard label={t("generators.totalRuntime")} value={`${formatNumber(Math.round(gens.reduce((a, g) => a + g.runtimeHours, 0)), numLang)}h`} icon={<Clock className="h-4 w-4" />} />
        <KpiCard label={t("generators.maintDue")} value={formatNumber(dueMaint.length, numLang)} icon={<RotateCcw className="h-4 w-4" />} tone={dueMaint.length ? "warn" : "good"} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* Generator grid */}
        <Card className="xl:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm">{t("generators.fleet")} ({formatNumber(gens.length, numLang)})</CardTitle>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("generators.search")} className="h-9 w-[220px] pl-8" />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
              {gens.slice(0, 40).map((g) => (
                <div key={g.id} className={cn("rounded-lg border p-3 transition-shadow hover:shadow-sm", g.status === "FAULT" && "border-rose-500/40 bg-rose-500/5", g.status === "RUNNING" && "border-emerald-500/20")}>
                  <div className="flex items-start justify-between">
                    <button onClick={() => setDetailId(g.id)} className="min-w-0 text-left">
                      <p className="truncate text-sm font-medium hover:underline">{g.label}</p>
                      <p className="truncate text-[10px] text-muted-foreground">{g.code} · {g.manufacturer} {g.model}</p>
                    </button>
                    <StatusBadge value={g.status} className="h-5 text-[9px]" />
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-1.5 text-[11px]">
                    <div className="rounded bg-muted/40 px-1.5 py-1"><p className="text-[9px] text-muted-foreground">{t("generators.load").toUpperCase()}</p><p className="font-semibold tabular-nums">{formatNumber(g.loadKw, numLang)}kW</p></div>
                    <div className="rounded bg-muted/40 px-1.5 py-1"><p className="text-[9px] text-muted-foreground">{t("generators.temp").toUpperCase()}</p><p className={cn("font-semibold tabular-nums", g.temperatureC > 95 && "text-rose-500")}>{formatNumber(g.temperatureC, numLang)}°C</p></div>
                    <div className="rounded bg-muted/40 px-1.5 py-1"><p className="text-[9px] text-muted-foreground">{t("generators.runtime").toUpperCase()}</p><p className="font-semibold tabular-nums">{formatNumber(Math.round(g.runtimeHours), numLang)}h</p></div>
                  </div>
                  <div className="mt-2 flex items-center gap-1">
                    <Button size="sm" variant="outline" className="h-6 flex-1 text-[10px]" disabled={g.status === "RUNNING"} onClick={() => doControl(g, "START")}>
                      <Power className="mr-1 h-3 w-3 text-emerald-500" />{t("generators.start")}
                    </Button>
                    <Button size="sm" variant="outline" className="h-6 flex-1 text-[10px]" disabled={g.status !== "RUNNING"} onClick={() => doControl(g, "STOP")}>
                      <Power className="mr-1 h-3 w-3 text-amber-500" />{t("generators.stop")}
                    </Button>
                    <Button size="sm" variant="outline" className="h-6 flex-1 text-[10px]" onClick={() => doControl(g, "RESET")}>
                      <RotateCcw className="mr-1 h-3 w-3 text-sky-500" />{t("generators.reset")}
                    </Button>
                    <Button size="sm" variant="outline" className="h-6 flex-1 text-[10px] border-rose-500/40 text-rose-600 hover:bg-rose-500/10" onClick={() => doControl(g, "EMERGENCY_STOP")}>
                      <AlertOctagon className="mr-1 h-3 w-3" />{t("generators.eStop")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Detail + commands */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">{t("generators.detail")}</CardTitle></CardHeader>
            <CardContent>
              {detail ? (
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-semibold">{detail.label}</p>
                    <p className="text-[11px] text-muted-foreground">{detail.site} · {detail.manufacturer} {detail.model} · {formatNumber(detail.ratedPowerKw, numLang)}kW</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <DetailRow label={t("common.status")} value={<StatusBadge value={detail.status} className="h-5 text-[9px]" />} />
                    <DetailRow label={t("generators.mode")} value={detail.mode} />
                    <DetailRow label={t("generators.runtime")} value={`${formatNumber(detail.runtimeHours, numLang)} h`} />
                    <DetailRow label={t("generators.temperature")} value={`${formatNumber(detail.temperatureC, numLang)} °C`} tone={detail.temperatureC > 95 ? "danger" : undefined} />
                    <DetailRow label={t("generators.load")} value={`${formatNumber(detail.loadKw, numLang)} kW`} />
                    <DetailRow label={t("generators.fuelRate")} value={`${formatNumber(detail.fuelRateLph, numLang)} L/h`} />
                    <DetailRow label={t("generators.oilPressure")} value={`${formatNumber(detail.oilPressureKpa, numLang)} kPa`} />
                    <DetailRow label={t("generators.genBattery")} value={`${formatNumber(detail.batteryVoltage, numLang)} V`} />
                    <DetailRow label={t("generators.nextMaint")} value={`${formatNumber(Math.round(detail.nextMaintenanceHrs), numLang)} h`} />
                    <DetailRow label={t("generators.lastStarted")} value={detail.lastStartedAt ? timeAgo(detail.lastStartedAt, numLang) : "—"} />
                  </div>
                  <Tabs defaultValue="temp">
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="temp" className="text-xs"><Thermometer className="mr-1 h-3 w-3" />{t("generators.temp")}</TabsTrigger>
                      <TabsTrigger value="load" className="text-xs"><Zap className="mr-1 h-3 w-3" />{t("generators.load")}</TabsTrigger>
                    </TabsList>
                    <TabsContent value="temp" className="mt-2">
                      <ResponsiveContainer width="100%" height={120}>
                        <AreaChart data={detail.history?.slice(-48) ?? []} margin={{ top: 2, right: 2, left: -28, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                          <YAxis tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} domain={[20, 110]} />
                          <Tooltip contentStyle={{ fontSize: 11 }} />
                          <Area type="monotone" dataKey="temp" stroke="#f59e0b" strokeWidth={2} fill="#f59e0b" fillOpacity={0.15} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </TabsContent>
                    <TabsContent value="load" className="mt-2">
                      <ResponsiveContainer width="100%" height={120}>
                        <AreaChart data={detail.history?.slice(-48) ?? []} margin={{ top: 2, right: 2, left: -28, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                          <YAxis tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} />
                          <Tooltip contentStyle={{ fontSize: 11 }} />
                          <Area type="monotone" dataKey="load" stroke="#10b981" strokeWidth={2} fill="#10b981" fillOpacity={0.15} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </TabsContent>
                  </Tabs>
                </div>
              ) : (
                <p className="py-8 text-center text-xs text-muted-foreground">{t("generators.selectGen")}</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Maintenance due list */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><RotateCcw className="h-4 w-4 text-amber-500" /> {t("generators.maintenanceDue")}</CardTitle></CardHeader>
        <CardContent className="p-3">
          <div className="flex flex-wrap gap-2">
            {dueMaint.map((g) => (
              <div key={g.id} className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs">
                <FuelIcon className="h-3.5 w-3.5 text-amber-500" />
                <span className="font-medium">{g.label}</span>
                <span className="text-muted-foreground">{g.site}</span>
                <Badge variant="outline" className="h-4 px-1 text-[8px]">{formatNumber(Math.round(g.runtimeHours), numLang)}h / {formatNumber(Math.round(g.nextMaintenanceHrs), numLang)}h</Badge>
              </div>
            ))}
            {dueMaint.length === 0 && <p className="py-2 text-xs text-muted-foreground">{t("generators.noMaintenanceDue")}</p>}
          </div>
        </CardContent>
      </Card>

      {/* Maintenance Prediction — ranked runtime-hours-based ETA panel */}
      <MaintenancePredictionPanel />

      {/* Enhanced command history panel (full-width) */}
      <CommandHistoryPanel commands={commands?.commands ?? []} />

      <RemoteControlDialog
        open={!!ctrl}
        onOpenChange={(v) => !v && setCtrl(null)}
        generatorId={ctrl?.id ?? null}
        generatorLabel={ctrl?.label ?? ""}
        siteName={ctrl?.site ?? ""}
        command={ctrl?.cmd ?? "START"}
        onDone={() => tick(30)}
      />
    </div>
  );
}

function DetailRow({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "danger" }) {
  return (
    <div className="flex items-center justify-between rounded bg-muted/30 px-2 py-1.5">
      <span className="text-[10px] uppercase text-muted-foreground">{label}</span>
      <span className={cn("font-semibold tabular-nums", tone === "danger" && "text-rose-500")}>{value}</span>
    </div>
  );
}
