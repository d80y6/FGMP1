"use client";

import { useMemo, useState } from "react";
import { useNow } from "@/lib/fgmp/use-now";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock, Flame, TrendingUp, Activity, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import { translateFmt, type Language } from "@/lib/fgmp/i18n";

type Severity = "L1" | "L2" | "L3";

interface Alarm {
  id: string;
  type: string;
  severity: Severity;
  status: string;
  createdAt: string;
}

export interface HeatmapCell {
  hour: number;
  severity: string;
  count: number;
}

interface Props {
  alarms: Alarm[];
  selectedCell?: { hour: number; severity: string } | null;
  onCellClick?: (cell: HeatmapCell | null) => void;
}

const SEVERITIES: Severity[] = ["L1", "L2", "L3"];
const HOUR_MS = 3600_000;

/**
 * Map an alarm's createdAt to a 0..23 hour bucket on the heatmap grid.
 *   idx 23 = current hour, idx 0 = 23 hours ago.
 * Returns -1 if the timestamp is outside the 24h window (future-dated or older than 24h).
 */
export function getHourBucket(createdAt: string | number, now: number): number {
  const t =
    typeof createdAt === "number" ? createdAt : new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return -1;
  const diffMs = now - t;
  if (diffMs < 0) return -1; // future-dated
  const hoursAgo = Math.floor(diffMs / HOUR_MS);
  if (hoursAgo >= 24) return -1; // outside 24h window
  const idx = 23 - hoursAgo;
  if (idx < 0 || idx > 23) return -1;
  return idx;
}
// Label columns — every 3 hours, ending at the most recent (col 23)
const LABEL_COLS = new Set<number>([2, 5, 8, 11, 14, 17, 20, 23]);

interface SevMeta {
  short: string;
  /** i18n key under the heatmap.* namespace for the full label. */
  fullKey: "heatmap.notice" | "heatmap.warning" | "heatmap.critical";
  dot: string;
  text: string;
  ring: string;
  solidRing: string; // solid (non-alpha) ring color, used for selected state
  tints: string[]; // index 0..4 for count buckets 0 / 1-2 / 3-5 / 6-9 / 10+
}

const SEV_META: Record<Severity, SevMeta> = {
  L1: {
    short: "L1",
    fullKey: "heatmap.notice",
    dot: "bg-sky-500",
    text: "text-sky-700 dark:text-sky-400",
    ring: "ring-sky-500/60",
    solidRing: "ring-sky-500",
    tints: [
      "bg-muted/20 opacity-40",
      "bg-sky-500/15",
      "bg-sky-500/35",
      "bg-sky-500/60",
      "bg-sky-500/85",
    ],
  },
  L2: {
    short: "L2",
    fullKey: "heatmap.warning",
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-400",
    ring: "ring-amber-500/60",
    solidRing: "ring-amber-500",
    tints: [
      "bg-muted/20 opacity-40",
      "bg-amber-500/15",
      "bg-amber-500/35",
      "bg-amber-500/60",
      "bg-amber-500/85",
    ],
  },
  L3: {
    short: "L3",
    fullKey: "heatmap.critical",
    dot: "bg-rose-500",
    text: "text-rose-700 dark:text-rose-400",
    ring: "ring-rose-500/60",
    solidRing: "ring-rose-500",
    tints: [
      "bg-muted/20 opacity-40",
      "bg-rose-500/15",
      "bg-rose-500/35",
      "bg-rose-500/60",
      "bg-rose-500/85",
    ],
  },
};

function tintIndex(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

interface HoverState {
  hour: number;
  sev: Severity;
  count: number;
  x: number;
  y: number;
}

interface HeatmapStats {
  total: number;
  totals: Record<Severity, number>;
  peakHour: number; // -1 if none
  peakCount: number;
  dominant: Severity;
  longestQuiet: number;
  longestStart: number; // -1 if none
  hourTotals: number[];
}

/**
 * Alarm Severity Heatmap
 * 24-hour × 3-severity (L1/L2/L3) matrix showing alarm density over time.
 * Column 0 = oldest (23h ago), Column 23 = most recent (current hour).
 */
export function AlarmSeverityHeatmap({
  alarms,
  selectedCell,
  onCellClick,
}: Props) {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const lang: Language = useArabicNums ? "ar" : "en";
  const [hover, setHover] = useState<HoverState | null>(null);
  const now = useNow();

  const { matrix, stats, hourLabels } = useMemo(() => {
    const m: Record<Severity, number[]> = {
      L1: new Array(24).fill(0),
      L2: new Array(24).fill(0),
      L3: new Array(24).fill(0),
    };
    let total = 0;
    const totals: Record<Severity, number> = { L1: 0, L2: 0, L3: 0 };

    for (const a of alarms) {
      const sev = a.severity;
      if (sev !== "L1" && sev !== "L2" && sev !== "L3") continue;
      const idx = getHourBucket(a.createdAt, now);
      if (idx < 0) continue;
      m[sev][idx]++;
      totals[sev]++;
      total++;
    }

    const hourTotals = new Array(24).fill(0);
    let peakHour = -1;
    let peakCount = 0;
    for (let i = 0; i < 24; i++) {
      hourTotals[i] = m.L1[i] + m.L2[i] + m.L3[i];
      if (hourTotals[i] > peakCount) {
        peakCount = hourTotals[i];
        peakHour = i;
      }
    }
    if (peakCount === 0) {
      peakHour = -1;
    }

    // Dominant severity
    let dominant: Severity = "L1";
    let domCount = -1;
    for (const s of SEVERITIES) {
      if (totals[s] > domCount) {
        domCount = totals[s];
        dominant = s;
      }
    }
    if (total === 0) dominant = "L1";

    // Longest run of zero hours
    let longestQuiet = 0;
    let longestStart = -1;
    let cur = 0;
    let curStart = -1;
    for (let i = 0; i < 24; i++) {
      if (hourTotals[i] === 0) {
        if (cur === 0) curStart = i;
        cur++;
        if (cur > longestQuiet) {
          longestQuiet = cur;
          longestStart = curStart;
        }
      } else {
        cur = 0;
      }
    }

    // Hour-of-day labels: bucket i represents time (now - (23-i)h) hour-of-day
    const labels: string[] = [];
    for (let i = 0; i < 24; i++) {
      const bucketMs = now - (23 - i) * HOUR_MS;
      const d = new Date(bucketMs);
      const hh = String(d.getHours()).padStart(2, "0");
      labels.push(`${hh}:00`);
    }

    const s: HeatmapStats = {
      total,
      totals,
      peakHour,
      peakCount,
      dominant,
      longestQuiet,
      longestStart,
      hourTotals,
    };

    return { matrix: m, stats: s, hourLabels: labels };
  }, [alarms, now]);

  const peakLabel = stats.peakHour >= 0 ? hourLabels[stats.peakHour] : "—";
  const quietLabel =
    stats.longestStart >= 0 && stats.longestQuiet > 0
      ? `${hourLabels[stats.longestStart]} → ${hourLabels[Math.min(23, stats.longestStart + stats.longestQuiet - 1)]}`
      : t("heatmap.noQuietWindow");
  const domMeta = SEV_META[stats.dominant];

  return (
    <Card className="rounded-xl border bg-card/50">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-rose-500/10 p-1.5 ring-1 ring-inset ring-rose-500/30">
              <Flame className="h-4 w-4 text-rose-500" />
            </div>
            <div>
              <CardTitle className="text-sm">{t("heatmap.title")}</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                {t("heatmap.description")}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip
              icon={<Activity className="h-3 w-3 text-muted-foreground" />}
              label={t("heatmap.total")}
              value={formatNumber(stats.total, lang)}
            />
            <Chip
              icon={<TrendingUp className="h-3 w-3 text-muted-foreground" />}
              label={t("heatmap.dominant")}
              value={domMeta.short}
              dot={domMeta.dot}
            />
            <Chip
              icon={<Clock className="h-3 w-3 text-muted-foreground" />}
              label={t("heatmap.quiet")}
              value={stats.longestQuiet > 0 ? `${formatNumber(stats.longestQuiet, lang)}h` : "—"}
            />
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
              <Flame className="mr-1 inline h-3 w-3 align-text-bottom" />
              <span className="font-semibold">{t("heatmap.peak")}:</span>{" "}
              <span className="tabular-nums">{peakLabel}</span>
              {stats.peakCount > 0 && (
                <span className="ml-1 tabular-nums">· {formatNumber(stats.peakCount, lang)}</span>
              )}
            </div>
            {selectedCell && onCellClick && (
              <button
                type="button"
                onClick={() => onCellClick(null)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                  "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400 hover:bg-sky-500/20",
                )}
              >
                <span>
                  {translateFmt("heatmap.filteringBy", lang, {
                    sev: selectedCell.severity,
                    hour: hourLabels[selectedCell.hour],
                  })}{" "}
                  (
                  {formatNumber(matrix[selectedCell.severity as Severity]?.[selectedCell.hour] ?? 0, lang)}{" "}
                  {t("heatmap.alarmsWord")})
                </span>
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-3">
        <div className="overflow-x-auto pb-2">
          <div className="min-w-[640px]">
            {/* Heatmap grid: sticky-left y-axis label column + 24 hour columns */}
            <div className="flex">
              {/* Y-axis label column */}
              <div className="sticky left-0 z-10 w-[78px] shrink-0 bg-card/85 pr-2 backdrop-blur">
                {/* spacer matching x-axis label row height */}
                <div className="h-[18px]" />
                {SEVERITIES.map((s) => {
                  const meta = SEV_META[s];
                  return (
                    <div
                      key={s}
                      className="flex h-7 items-center gap-1.5 border-b border-border/40 px-1"
                    >
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", meta.dot)} />
                      <span className="text-[10px] font-medium">{meta.short}</span>
                      <span className="text-[9px] text-muted-foreground">{t(meta.fullKey)}</span>
                      <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                        {formatNumber(stats.totals[s], lang)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Cells area */}
              <div className="flex-1">
                {/* X-axis labels */}
                <div className="flex h-[18px] gap-px">
                  {Array.from({ length: 24 }).map((_, i) => (
                    <div
                      key={i}
                      className="relative flex min-w-[24px] max-w-[32px] flex-1 items-start justify-center"
                    >
                      {i === 23 ? (
                        <span className="rounded-sm bg-emerald-500/15 px-1 text-[8px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                          {t("heatmap.now")}
                        </span>
                      ) : LABEL_COLS.has(i) ? (
                        <span className="text-[9px] tabular-nums text-muted-foreground">
                          {formatNumber(hourLabels[i], lang)}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>

                {/* Severity rows */}
                {SEVERITIES.map((s) => {
                  const meta = SEV_META[s];
                  return (
                    <div
                      key={s}
                      className="flex h-7 gap-px border-b border-border/40"
                    >
                      {Array.from({ length: 24 }).map((_, i) => {
                        const count = matrix[s][i];
                        const tIdx = tintIndex(count);
                        const isHovered = hover?.hour === i && hover?.sev === s;
                        const isNow = i === 23;
                        const isSelected =
                          selectedCell?.hour === i && selectedCell?.severity === s;
                        return (
                          <div
                            key={i}
                            role="img"
                            aria-label={`${formatNumber(hourLabels[i], lang)} · ${s}: ${formatNumber(count, lang)} ${count === 1 ? t("heatmap.notice") : t("heatmap.alarmsWord")}`}
                            title={translateFmt("heatmap.filteringBy", lang, { sev: s, hour: hourLabels[i] })}
                            onClick={() => {
                              if (!onCellClick) return;
                              if (isSelected) onCellClick(null);
                              else onCellClick({ hour: i, severity: s, count });
                            }}
                            onMouseEnter={(e) =>
                              setHover({ hour: i, sev: s, count, x: e.clientX, y: e.clientY })
                            }
                            onMouseLeave={() => setHover(null)}
                            className={cn(
                              "min-w-[24px] max-w-[32px] flex-1 rounded-md transition-transform cursor-pointer",
                              meta.tints[tIdx],
                              "hover:ring-2 hover:ring-offset-1 hover:ring-offset-card hover:scale-105 hover:z-20",
                              isHovered && "ring-2 ring-offset-1 ring-offset-card",
                              isHovered ? meta.ring : "hover:ring-foreground/40",
                              isNow && !isSelected && "ring-1 ring-inset ring-emerald-500/40",
                              isSelected &&
                                "scale-110 z-10 ring-2 ring-offset-2 ring-offset-card",
                              isSelected && meta.solidRing,
                            )}
                          />
                        );
                      })}
                    </div>
                  );
                })}

                {/* Hour-totals micro-bar under the grid */}
                <div className="flex h-4 gap-px">
                  {Array.from({ length: 24 }).map((_, i) => (
                    <div
                      key={i}
                      className="flex min-w-[24px] max-w-[32px] flex-1 items-center justify-center"
                    >
                      {stats.hourTotals[i] > 0 ? (
                        <span className="text-[9px] tabular-nums text-muted-foreground">
                          {formatNumber(stats.hourTotals[i], lang)}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Legend */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 pl-[78px] text-[10px] text-muted-foreground">
              <span className="font-semibold text-foreground/80">{t("heatmap.intensity")}:</span>
              {[
                { range: "0", cls: SEV_META.L3.tints[0] },
                { range: "1-2", cls: SEV_META.L3.tints[1] },
                { range: "3-5", cls: SEV_META.L3.tints[2] },
                { range: "6-9", cls: SEV_META.L3.tints[3] },
                { range: "10+", cls: SEV_META.L3.tints[4] },
              ].map((item) => (
                <div key={item.range} className="flex items-center gap-1">
                  <span className={cn("h-3 w-3 rounded-sm", item.cls)} />
                  <span>{formatNumber(item.range, lang)}</span>
                </div>
              ))}
              <span className="ml-2 italic">
                {t("heatmap.columnsNote")}
              </span>
            </div>
          </div>
        </div>

        {/* Summary stats row */}
        <div className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 sm:grid-cols-4">
          <StatBox
            icon={<Flame className="h-3.5 w-3.5 text-amber-500" />}
            label={t("heatmap.peakHour")}
            value={peakLabel}
            sub={stats.peakCount > 0 ? translateFmt("heatmap.alarmsCount", lang, { n: formatNumber(stats.peakCount, lang) }) : t("heatmap.noAlarms")}
            accent
          />
          <StatBox
            icon={<Activity className="h-3.5 w-3.5 text-sky-500" />}
            label={t("heatmap.total24h")}
            value={formatNumber(stats.total, lang)}
            sub={`L1:${formatNumber(stats.totals.L1, lang)} · L2:${formatNumber(stats.totals.L2, lang)} · L3:${formatNumber(stats.totals.L3, lang)}`}
          />
          <StatBox
            icon={<TrendingUp className="h-3.5 w-3.5 text-emerald-500" />}
            label={t("heatmap.dominantSeverity")}
            value={stats.dominant}
            sub={`${formatNumber(stats.totals[stats.dominant], lang)} ${t("heatmap.of")} ${formatNumber(stats.total, lang)} ${t("heatmap.alarmsWord")}`}
          />
          <StatBox
            icon={<Clock className="h-3.5 w-3.5 text-violet-500" />}
            label={t("heatmap.longestQuiet")}
            value={stats.longestQuiet > 0 ? `${formatNumber(stats.longestQuiet, lang)}h` : "—"}
            sub={quietLabel !== t("heatmap.noQuietWindow") ? quietLabel : t("heatmap.noQuietWindow")}
          />
        </div>
      </CardContent>

      {/* Floating hover tooltip — single instance, pointer-events-none */}
      {hover && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur"
          style={{
            left: Math.min(hover.x + 14, window.innerWidth - 200),
            top: Math.min(hover.y + 14, window.innerHeight - 80),
          }}
        >
          <div className="flex items-center gap-1.5">
            <Clock className="h-3 w-3 text-muted-foreground" />
            <span className="font-semibold tabular-nums">{formatNumber(hourLabels[hover.hour], lang)}</span>
            <span className="text-muted-foreground">· {translateFmt("heatmap.hoursAgo", lang, { n: formatNumber(23 - hover.hour, lang) })}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className={cn("h-2 w-2 rounded-full", SEV_META[hover.sev].dot)} />
            <span className="font-medium">{hover.sev}</span>
            <span className="text-muted-foreground">·</span>
            <span>
              <span className="font-semibold tabular-nums">{formatNumber(hover.count, lang)}</span>{" "}
              {hover.count === 1 ? t("heatmap.notice") : t("heatmap.alarmsWord")}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

function Chip({
  icon,
  label,
  value,
  dot,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  dot?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1 text-[11px]">
      {icon}
      <span className="text-muted-foreground">{label}:</span>
      {dot ? <span className={cn("h-2 w-2 rounded-full", dot)} /> : null}
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function StatBox({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-2",
        accent ? "border-amber-500/30 bg-amber-500/10" : "bg-muted/30"
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-1 text-sm font-bold tabular-nums">{value}</p>
      {sub ? <p className="text-[10px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}
