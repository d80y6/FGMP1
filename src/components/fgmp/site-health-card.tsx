"use client";

import { useMemo } from "react";
import { Activity } from "lucide-react";
import {
  computeSiteHealth,
  healthBand,
  HEALTH_BAND_CLASSES,
  HEALTH_BAND_LABEL_KEYS,
} from "@/lib/health/site-health-score";
import type { SiteHealthInput } from "@/lib/health/site-health-score";
import { useT } from "@/lib/fgmp/use-language";

/**
 * Site health, computed live — and only live.
 *
 * ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
 * This was `site-health-trend.tsx`, a "7-day trend" whose last point was the
 * real score and whose previous six were `Math.sin(seed)` noise around it. It
 * then summarised that invented series as "7-Day Avg", "Trend (Δ)" and "Best
 * Day" — three numbers an operator had no way to distinguish from measurements.
 *
 * That is exactly what the README promises the platform will not do ("screens
 * show an empty/unknown state rather than plausible numbers"), and the same sin
 * the analytics forecast was fixed for when it stopped multiplying by
 * `0.9 + Math.random() * 0.2`. The honest answer to "what was this site's score
 * last Tuesday" is that the platform does not store a score series, so there is
 * nothing to draw and nothing to average.
 *
 * What is left is all measured: the canonical score (the same function the
 * badge, the region sheet and the dashboard call) and its five weighted
 * factors, each rendered with the weight the score actually applied.
 */
interface SiteHealthCardProps {
  // Taken from the scorer's own input types: the card and the badge must agree
  // on what a tank, a generator and a battery are.
  tanks: SiteHealthInput["tanks"];
  generators: SiteHealthInput["generators"];
  batteries: SiteHealthInput["batteries"];
  /** Only the count feeds the score, so the element type stays open. */
  alarms: readonly unknown[];
  siteStatus: string; // ONLINE / DEGRADED / OFFLINE / MAINTENANCE
}

export function SiteHealthCard({
  tanks,
  generators,
  batteries,
  alarms,
  siteStatus,
}: SiteHealthCardProps) {
  const t = useT();

  const { result, band } = useMemo(() => {
    const scored = computeSiteHealth({
      site: { status: siteStatus },
      tanks,
      generators,
      batteries,
      alarmCount: alarms.length,
    });
    return { result: scored, band: healthBand(scored.overall) };
  }, [siteStatus, tanks, generators, batteries, alarms]);

  const bandStyle = HEALTH_BAND_CLASSES[band];

  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold">
          <Activity className="h-3.5 w-3.5 text-emerald-500" />
          {t("detail.health")}
        </p>
        <span
          className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[10px] font-medium ${bandStyle.cls}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${bandStyle.dot}`} />
          {t(HEALTH_BAND_LABEL_KEYS[band])}
        </span>
      </div>

      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold tabular-nums">{result.overall}</span>
        <span className="pb-0.5 text-[10px] text-muted-foreground">/ 100</span>
      </div>

      {/* The five factors, with the weight each carried in that number. */}
      <div className="mt-2 space-y-1.5">
        {result.factorKeys.map((factor) => (
          <div key={factor.key} className="flex items-center gap-2 text-[10px]">
            <span className="w-[110px] shrink-0 truncate text-muted-foreground">
              {t(factor.labelKey)}
            </span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className={`block h-full rounded-full ${HEALTH_BAND_CLASSES[healthBand(factor.value)].dot}`}
                style={{ width: `${Math.max(0, Math.min(100, factor.value))}%` }}
              />
            </span>
            <span className="w-8 shrink-0 text-end font-medium tabular-nums">{factor.value}</span>
            <span className="w-8 shrink-0 text-end text-muted-foreground">{factor.weight}</span>
          </div>
        ))}
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        {t("detail.healthLive")}
      </p>
    </div>
  );
}
