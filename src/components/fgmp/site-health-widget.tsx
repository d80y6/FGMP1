"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Droplet, Zap, Battery, Siren, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import {
  healthBand,
  HEALTH_BAND_HEX,
  HEALTH_BAND_LABEL_KEYS,
} from "@/lib/health/site-health-score";

interface HealthFactor {
  label: string;
  value: number;
  weight: number;
  icon: string;
  good: boolean;
}

interface SiteHealthWidgetProps {
  overall: number;
  factors: HealthFactor[];
}

const FACTOR_ICONS: Record<string, typeof Activity> = {
  uptime: Building2,
  fuel: Droplet,
  generator: Zap,
  battery: Battery,
  alarm: Siren,
};

// Map the backend `icon` field (locale-independent) to an i18n key.
const FACTOR_LABEL_KEYS: Record<string, string> = {
  uptime: "dash.siteUptime",
  fuel: "dash.fuelReserves",
  generator: "dash.generatorHealth",
  battery: "dash.batteryHealth",
  alarm: "dash.alarmLoad",
};

/**
 * Band/colour lookup now comes from the canonical site-health module. This
 * widget used to carry a near-copy of the scale with 85/70/55/40 cut-offs,
 * which disagreed with the badge on scores of 85–89 and 70–74.
 */
const healthColor = (score: number): string => HEALTH_BAND_HEX[healthBand(score)];

export function SiteHealthWidget({ overall, factors }: SiteHealthWidgetProps) {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const color = healthColor(overall);
  const label = t(HEALTH_BAND_LABEL_KEYS[healthBand(overall)]);

  // Pulse-on-change: when `overall` changes, the score number span remounts
  // (key includes the value) and replays the CSS fade-in animation. This is
  // a pure-render approach — no state, no refs, no effects — so it doesn't
  // trip the react-hooks/refs or react-hooks/set-state-in-effect rules.
  // The animation is subtle (slide-in-up) so it reads as a gentle "value
  // updated" cue rather than a flashy pulse.
  const pulseKey = `health-${overall}`;

  // SVG radial gauge configuration
  const size = 140;
  const stroke = 12;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (overall / 100) * circumference;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="h-4 w-4 text-emerald-500" />
          {t("health.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          {/* Radial gauge with colored ring */}
          <div className="relative flex shrink-0 items-center justify-center">
            <svg width={size} height={size} className="rotate-[-90deg]">
              {/* Background track */}
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeOpacity={0.08}
                strokeWidth={stroke}
              />
              {/* Progress arc — colored ring around the score (stroke-dasharray) */}
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                className="transition-all duration-700 ease-out motion-reduce:transition-none"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              {/* Score number — key={pulseKey} so a value change remounts the
                  span and replays the subtle fade-in animation (pulse-on-change).
                  Respects prefers-reduced-motion via the motion-reduce: prefix. */}
              <span
                key={pulseKey}
                className="animate-slide-in-up motion-reduce:animate-none text-3xl font-bold tabular-nums"
                style={{ color }}
              >
                {formatNumber(overall, numLang)}
              </span>
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {label}
              </span>
              {/* Subtle "live" indicator — pulsing dot below the label to signal
                  that the score is being polled in real time. Replaces the
                  trend arrow (which would have required forbidden ref access). */}
              <span className="mt-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                <span
                  className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse-soft motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {t("common.live")}
              </span>
            </div>
          </div>

          {/* Factor breakdown */}
          <div className="flex-1 space-y-2">
            {factors.map((factor) => {
              const Icon = FACTOR_ICONS[factor.icon] ?? Activity;
              const fColor = healthColor(factor.value);
              return (
                <div key={factor.label} className="group">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <Icon className={cn("h-3 w-3", factor.good ? "text-emerald-500" : "text-amber-500")} />
                      <span className="text-[11px] font-medium">{t(FACTOR_LABEL_KEYS[factor.icon] ?? "") || factor.label}</span>
                      <span className="text-[10px] text-muted-foreground">({formatNumber(Math.round(factor.weight * 100), numLang)}%)</span>
                    </div>
                    <span className="text-xs font-bold tabular-nums" style={{ color: fColor }}>
                      {formatNumber(factor.value, numLang)}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                    <div
                      className="h-full rounded-full transition-all duration-500 ease-out motion-reduce:transition-none"
                      style={{ width: `${factor.value}%`, backgroundColor: fColor }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
