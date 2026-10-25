"use client";

import { useMemo, useState } from "react";
import { BatteryCharging, Search, AlertTriangle, Zap, Thermometer, HeartPulse } from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { TruncationNote } from "@/components/fgmp/truncation-note";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { BarGauge } from "@/components/fgmp/gauge";
import { StatusBadge } from "@/components/fgmp/status-badge";
import { Sparkline } from "@/components/fgmp/sparkline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useT, useTF, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";

export function BatteriesView() {
  const snapshot = useFgmp((s) => s.snapshot);
  const t = useT();
  const tFmt = useTF();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const [q, setQ] = useState("");

  const banks = useMemo(() => {
    if (!snapshot) return [];
    const siteOf = (id: string) => snapshot.sites.find((s) => s.id === id);
    let list = snapshot.batteries.map((b) => {
      const site = siteOf(b.siteId);
      const vPct = (b.voltage / b.nominalVoltage) * 100;
      return { ...b, site: site?.name ?? "—", code: site?.code ?? "", vPct };
    });
    if (q) list = list.filter((b) => `${b.label} ${b.site} ${b.code}`.toLowerCase().includes(q.toLowerCase()));
    return list;
  }, [snapshot, q]);

  if (!snapshot) return null;
  const low = banks.filter((b) => b.status === "LOW" || b.vPct < 90);
  const replacement = banks.filter((b) => b.stateOfHealth < 75);
  const charging = banks.filter((b) => b.charging);
  const avgSoc = banks.length ? Math.round(banks.reduce((a, b) => a + b.stateOfCharge, 0) / banks.length) : 0;
  const avgSoh = banks.length ? Math.round(banks.reduce((a, b) => a + b.stateOfHealth, 0) / banks.length) : 0;

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.batteries")}
        description={t("desc.batteries")}
        icon={<BatteryCharging className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label={t("batteries.banks")} value={formatNumber(banks.length, numLang)} icon={<BatteryCharging className="h-4 w-4" />} />
        <KpiCard label={t("batteries.avgSoc")} value={`${formatNumber(avgSoc, numLang)}%`} icon={<Zap className="h-4 w-4" />} tone={avgSoc < 40 ? "danger" : "good"} />
        <KpiCard label={t("batteries.avgSoh")} value={`${formatNumber(avgSoh, numLang)}%`} icon={<HeartPulse className="h-4 w-4" />} tone={avgSoh < 75 ? "warn" : "good"} />
        <KpiCard label={t("batteries.lowVoltage")} value={formatNumber(low.length, numLang)} icon={<AlertTriangle className="h-4 w-4" />} tone={low.length ? "warn" : "good"} />
        <KpiCard label={t("batteries.charging")} value={formatNumber(charging.length, numLang)} icon={<BatteryCharging className="h-4 w-4" />} tone="info" />
        <KpiCard label={t("batteries.replaceDue")} value={formatNumber(replacement.length, numLang)} icon={<AlertTriangle className="h-4 w-4" />} tone={replacement.length ? "danger" : "good"} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm">{t("batteries.banks")} ({formatNumber(banks.length, numLang)})</CardTitle>
            <div className="relative">
              <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("batteries.search")} className="h-9 w-[200px] ps-8" />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
              {banks.slice(0, 60).map((b) => (
                <div key={b.id} className={cn("rounded-lg border p-3", b.vPct < 88 && "border-amber-500/40 bg-amber-500/5")}>
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{b.label}</p>
                      <p className="truncate text-[10px] text-muted-foreground">{b.code} · {b.site}</p>
                    </div>
                    <StatusBadge value={b.status} className="h-5 text-[10px]" />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                    <div className="rounded bg-muted/40 px-2 py-1">
                      <p className="text-[10px] text-muted-foreground">{t("batteries.voltage")}</p>
                      <p className={cn("font-semibold tabular-nums", b.vPct < 88 && "text-amber-500")}>{tFmt("batteries.voltageOf", { v: formatNumber(b.voltage, numLang), nominal: formatNumber(b.nominalVoltage, numLang) })}</p>
                    </div>
                    <div className="rounded bg-muted/40 px-2 py-1">
                      <p className="text-[10px] text-muted-foreground">{t("batteries.current")}</p>
                      <p className="font-semibold tabular-nums">{formatNumber(b.currentA, numLang)}A {b.charging && "↑"}</p>
                    </div>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    <div>
                      <div className="flex justify-between text-[10px] text-muted-foreground"><span>{t("batteries.charge")}</span><span className="tabular-nums">{formatNumber(b.stateOfCharge, numLang)}%</span></div>
                      <BarGauge value={b.stateOfCharge} />
                    </div>
                    <div>
                      <div className="flex justify-between text-[10px] text-muted-foreground"><span>{t("batteries.health")}</span><span className="tabular-nums">{formatNumber(b.stateOfHealth, numLang)}%</span></div>
                      <BarGauge value={b.stateOfHealth} />
                    </div>
                  </div>
                </div>
              ))}
              {/* A tenant with no batteries used to see an empty grid under a
                  "Battery Banks (0)" heading with no explanation. */}
              {banks.length === 0 && (
                <p className="py-6 text-center text-xs text-muted-foreground">{t("common.noneYet")}</p>
              )}
            </div>
            <TruncationNote shown={60} total={banks.length} />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><AlertTriangle className="h-4 w-4 text-amber-500" /> {t("batteries.replacement")}</CardTitle></CardHeader>
            <CardContent className="p-3">
              <div className="space-y-2">
                {[...banks].sort((a, b) => a.stateOfHealth - b.stateOfHealth).slice(0, 8).map((b) => (
                  <div key={b.id} className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{b.label} <span className="text-muted-foreground">· {b.site}</span></p>
                      <div className="mt-1"><BarGauge value={b.stateOfHealth} /></div>
                    </div>
                    <span className={cn("w-10 text-end text-xs font-bold tabular-nums", b.stateOfHealth < 70 ? "text-rose-500" : b.stateOfHealth < 80 ? "text-amber-500" : "text-emerald-500")}>{formatNumber(b.stateOfHealth, numLang)}%</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Thermometer className="h-4 w-4 text-rose-500" /> {t("batteries.lowVoltageBanks")}</CardTitle></CardHeader>
            <CardContent className="p-3">
              <div className="space-y-1.5">
                {low.slice(0, 8).map((b) => (
                  <div key={b.id} className="flex items-center justify-between rounded border p-2 text-[11px]">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{b.label}</p>
                      <p className="text-[10px] text-muted-foreground">{b.site} · {formatNumber(b.voltage, numLang)}V</p>
                    </div>
                    <Sparkline data={b.history?.slice(-30).map((h) => h.v) ?? []} width={60} height={18} color="#f59e0b" />
                  </div>
                ))}
                {low.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">{t("batteries.allInRange")}</p>}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
