"use client";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Info } from "lucide-react";
import { AnimatedNumber } from "@/components/fgmp/animated-number";
import { Sparkline } from "@/components/fgmp/sparkline";
import { useT } from "@/lib/fgmp/use-language";

interface KpiCardProps {
  label: string;
  value: ReactNode;
  unit?: string;
  icon?: ReactNode;
  trend?: number; // percent change
  /** Optional supporting line under the value. Plain text or a small inline
   *  node (e.g. a trend arrow). Rendered inside a <p>, so callers should keep
   *  it to phrasing/inline elements. */
  hint?: ReactNode;
  /** Optional explainer shown as an ⓘ tooltip next to the label (formula / definition). */
  info?: string;
  tone?: "default" | "danger" | "warn" | "good" | "info";
  className?: string;
  /** When true and value is a number, animates count-up on change. */
  animate?: boolean;
  /** Decimals for animated numeric value. */
  decimals?: number;
  /** Optional sparkline data (last N readings). When provided, renders a tiny
   *  inline SVG below the value. Stroke color matches the card's tone. */
  sparkline?: number[];
  /** Accessible label for the sparkline (read by screen readers). */
  sparklineLabel?: string;
}

const TONE_RING: Record<string, string> = {
  default: "",
  danger: "border-rose-500/20 hover:border-rose-500/40",
  warn: "border-amber-500/20 hover:border-amber-500/40",
  good: "border-emerald-500/20 hover:border-emerald-500/40",
  info: "border-sky-500/20 hover:border-sky-500/40",
};

const TONE_ICON: Record<string, string> = {
  default: "text-muted-foreground bg-muted/60",
  danger: "text-rose-500 bg-rose-500/10",
  warn: "text-amber-500 bg-amber-500/10",
  good: "text-emerald-500 bg-emerald-500/10",
  info: "text-sky-500 bg-sky-500/10",
};

const TONE_ACCENT: Record<string, string> = {
  default: "bg-muted/60",
  danger: "bg-gradient-to-r from-rose-500 to-rose-400",
  warn: "bg-gradient-to-r from-amber-500 to-amber-400",
  good: "bg-gradient-to-r from-emerald-500 to-emerald-400",
  info: "bg-gradient-to-r from-sky-500 to-sky-400",
};

const TONE_VALUE: Record<string, string> = {
  default: "",
  danger: "text-rose-700 dark:text-rose-400",
  warn: "text-amber-700 dark:text-amber-400",
  good: "text-emerald-700 dark:text-emerald-400",
  info: "text-sky-700 dark:text-sky-400",
};

// Sparkline stroke colors per tone — keep in sync with TONE_VALUE so the
// mini-chart visually reinforces the card's status colour.
const TONE_SPARK_STROKE: Record<string, string> = {
  default: "rgb(100 116 139)", // slate-500
  danger: "rgb(244 63 94)",    // rose-500
  warn: "rgb(245 158 11)",     // amber-500
  good: "rgb(16 185 129)",     // emerald-500
  info: "rgb(14 165 233)",     // sky-500
};

export function KpiCard({ label, value, unit, icon, trend, hint, info, tone = "default", className, animate = false, decimals = 0, sparkline, sparklineLabel }: KpiCardProps) {
  const t = useT();
  return (
    <Card className={cn(
      "group relative overflow-hidden bg-gradient-to-br from-card to-card/50 p-0 transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5",
      TONE_RING[tone],
      className
    )}>
      {/* Gradient accent bar at top — 2px colored top-border using the card's status color */}
      <div className={cn("h-[3px] w-full transition-opacity", TONE_ACCENT[tone], tone === "default" ? "opacity-30 group-hover:opacity-60" : "opacity-70 group-hover:opacity-100")} />

      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
              {info && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={label}
                      className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    >
                      <Info className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[220px] text-[11px] leading-snug font-normal">
                    {info}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {/* Better number formatting: large bold number, smaller unit/suffix below */}
            <div className="mt-1.5 flex items-baseline gap-1">
              <span className={cn("text-2xl font-bold tabular-nums tracking-tight", TONE_VALUE[tone])}>
                {animate && typeof value === "number"
                  ? <AnimatedNumber value={value} decimals={decimals} />
                  : value}
              </span>
              {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
            </div>
            {hint && <p className="mt-1.5 text-[11px] leading-tight text-muted-foreground">{hint}</p>}
            {/* Tiny inline sparkline — last 5 values. Sits flush under the hint. */}
            {sparkline && sparkline.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* A real control, not a <div> with an aria-label: axe flags
                      aria-label on a generic element (aria-prohibited-attr) and a
                      non-focusable hover target is unreachable by keyboard. The
                      button is focusable, so the tooltip opens on focus too. */}
                  <button
                    type="button"
                    aria-label={sparklineLabel}
                    className="mt-2 h-6 w-full cursor-help rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <Sparkline
                      data={sparkline}
                      width={120}
                      height={20}
                      color={TONE_SPARK_STROKE[tone]}
                      fill
                      decorative
                      className="w-full"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-[11px] font-normal">
                  {sparklineLabel}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {icon && (
            <div className={cn("shrink-0 rounded-xl p-2.5 transition-transform group-hover:scale-110", TONE_ICON[tone])}>
              {icon}
            </div>
          )}
        </div>
        {typeof trend === "number" && (
          <div className="mt-2 flex items-center gap-1 text-[11px]">
            {trend >= 0 ? (
              <ArrowUpRight className="h-3 w-3 text-emerald-500" />
            ) : (
              <ArrowDownRight className="h-3 w-3 text-rose-500" />
            )}
            <span className={cn("font-medium", trend >= 0 ? "text-emerald-500" : "text-rose-500")}>
              {Math.abs(trend)}%
            </span>
            <span className="text-muted-foreground">{t("kpi.vsPrevPeriod")}</span>
          </div>
        )}
      </div>

      {/* Subtle corner glow for danger/warn tones */}
      {tone === "danger" && (
        <div className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full bg-rose-500/5 blur-2xl" />
      )}
      {tone === "warn" && (
        <div className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full bg-amber-500/5 blur-2xl" />
      )}
    </Card>
  );
}
