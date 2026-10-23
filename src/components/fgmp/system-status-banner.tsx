"use client";

import { useEffect, useState } from "react";
import {
  ShieldCheck,
  AlertTriangle,
  Siren,
  Building2,
  Droplet,
  Zap,
  BatteryWarning,
  Activity,
  Check,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Kpis } from "@/lib/fgmp/types";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { determineSystemStatus, type SystemStatusLevel as StatusLevel } from "@/lib/fgmp/status";

interface SystemStatusBannerProps {
  kpis: Kpis;
}


interface StatusConfig {
  titleKey: "statusBanner.operational" | "statusBanner.degraded" | "statusBanner.critical";
  Icon: LucideIcon;
  iconClass: string;
  containerClass: string;
  titleClass: string;
  cardClass: string;
  /** Pulsing animation applied to status icon (and card in CRITICAL). */
  pulse: boolean;
}

const STATUS_CONFIG: Record<StatusLevel, StatusConfig> = {
  OPERATIONAL: {
    titleKey: "statusBanner.operational",
    Icon: ShieldCheck,
    iconClass: "text-emerald-500 dark:text-emerald-400",
    containerClass: "bg-emerald-500/15 ring-1 ring-inset ring-emerald-500/30",
    titleClass: "text-emerald-600 dark:text-emerald-400",
    cardClass:
      "bg-gradient-to-r from-emerald-500/10 via-emerald-500/5 to-transparent ring-1 ring-emerald-500/20",
    pulse: false,
  },
  DEGRADED: {
    titleKey: "statusBanner.degraded",
    Icon: AlertTriangle,
    iconClass: "text-amber-500 dark:text-amber-400",
    containerClass: "bg-amber-500/15 ring-1 ring-inset ring-amber-500/30",
    titleClass: "text-amber-600 dark:text-amber-400",
    cardClass:
      "bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent ring-1 ring-amber-500/20",
    pulse: false,
  },
  CRITICAL: {
    titleKey: "statusBanner.critical",
    Icon: Siren,
    iconClass: "text-rose-500 dark:text-rose-400",
    containerClass: "bg-rose-500/15 ring-1 ring-inset ring-rose-500/40",
    titleClass: "text-rose-600 dark:text-rose-400",
    cardClass:
      "bg-gradient-to-r from-rose-500/10 via-rose-500/5 to-transparent ring-1 ring-rose-500/30",
    pulse: true,
  },
};

interface Indicator {
  key: string;
  labelKey:
    | "statusBanner.indicator.offline"
    | "statusBanner.indicator.l3"
    | "statusBanner.indicator.l2"
    | "statusBanner.indicator.tanks"
    | "statusBanner.indicator.gen"
    | "statusBanner.indicator.batt";
  count: number;
  Icon: LucideIcon;
  tone: "rose" | "amber";
}

const INDICATORS: Array<Omit<Indicator, "count">> = [
  { key: "offline", labelKey: "statusBanner.indicator.offline", Icon: Building2, tone: "rose" },
  { key: "l3", labelKey: "statusBanner.indicator.l3", Icon: Siren, tone: "rose" },
  { key: "l2", labelKey: "statusBanner.indicator.l2", Icon: AlertTriangle, tone: "amber" },
  { key: "tanks", labelKey: "statusBanner.indicator.tanks", Icon: Droplet, tone: "rose" },
  { key: "gen", labelKey: "statusBanner.indicator.gen", Icon: Zap, tone: "rose" },
  { key: "batt", labelKey: "statusBanner.indicator.batt", Icon: BatteryWarning, tone: "amber" },
];

function chipToneClass(tone: "rose" | "amber"): string {
  return tone === "rose"
    ? "border-rose-500/20 bg-rose-500/[0.04] text-rose-600 dark:text-rose-400"
    : "border-amber-500/20 bg-amber-500/[0.04] text-amber-600 dark:text-amber-400";
}

export function SystemStatusBanner({ kpis }: SystemStatusBannerProps) {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const status = determineSystemStatus(kpis);
  const config = STATUS_CONFIG[status];
  const { Icon: StatusIcon } = config;

  // Live HH:MM:SS timestamp (updates once per second). Localized digits in AR mode.
  const [now, setNow] = useState<string>("");
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      setNow(`${hh}:${mm}:${ss}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const indicators: Indicator[] = INDICATORS.map((i) => ({
    ...i,
    count:
      i.key === "offline" ? kpis.offlineSites
      : i.key === "l3" ? kpis.alarmsL3
      : i.key === "l2" ? kpis.alarmsL2
      : i.key === "tanks" ? kpis.tanksCritical
      : i.key === "gen" ? kpis.generatorsFault
      : kpis.batteriesLow,
  }));

  const showAll = status === "OPERATIONAL";

  return (
    <Card
      className={cn(
        "rounded-xl border bg-card/50 backdrop-blur p-4",
        config.cardClass,
        config.pulse && "animate-pulse-soft"
      )}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Left: status icon + status text + timestamp */}
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl",
              config.containerClass
            )}
          >
            <StatusIcon
              className={cn("h-8 w-8", config.iconClass, config.pulse && "animate-pulse-soft")}
            />
          </div>
          <div className="min-w-0">
            <h2
              className={cn(
                "font-bold tracking-tight",
                status === "CRITICAL" ? "text-lg" : "text-base",
                config.titleClass
              )}
            >
              {t(config.titleKey)}
            </h2>
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Activity className="h-3 w-3" />
              <span>{t("statusBanner.lastUpdated")}</span>
              <span className="tabular-nums">{now ? formatNumber(now, numLang) : formatNumber("--:--:--", numLang)}</span>
            </p>
          </div>
        </div>

        {/* Right: issue indicator chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {indicators.map((ind) => {
            const { Icon, count, tone, labelKey, key } = ind;
            // In OPERATIONAL state, render every chip — those at 0 use an
            // emerald check accent; any nonzero (only possible for L2/battery
            // since the other four are guaranteed 0 by the OPERATIONAL rules)
            // still render with its tone so we never hide live data.
            if (showAll && count === 0) {
              return (
                <div
                  key={key}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-2.5 py-1 text-xs transition-colors hover:bg-muted/50"
                >
                  <Check className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />
                  <span className="font-bold tabular-nums text-sm text-emerald-600 dark:text-emerald-400">
                    {formatNumber(0, numLang)}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t(labelKey)}
                  </span>
                </div>
              );
            }
            // Non-OPERATIONAL state: hide zero-count chips.
            if (count === 0) return null;
            return (
              <div
                key={key}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors hover:bg-muted/50",
                  chipToneClass(tone)
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="font-bold tabular-nums text-sm">{formatNumber(count, numLang)}</span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t(labelKey)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
