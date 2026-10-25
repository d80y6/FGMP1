"use client";

/**
 * FGMP System Health Mini-Indicator (Task 33-B)
 * ─────────────────────────────────────────────────────────────────────────
 * A compact, always-visible widget for the app header that shows the
 * platform's health status at a glance — a pulsing dot + brief status
 * text. Clicking it navigates to the full System Health NOC view.
 *
 * Polling strategy:
 *   - Fetches `/api/fgmp/health` every 30s (lighter than the full view's
 *     10s cadence — this widget only needs a coarse-grained status).
 *   - On 401/403/network error: shows the gray "Checking…" state. Non-
 *     admin users see this forever, which is fine (they can't access the
 *     health API anyway, so the indicator is hidden for them at the app-
 *     shell level via the `me?.role === "ADMIN"` gate).
 *
 * Status computation is delegated to `computeHealthStatus()` in
 * @/lib/fgmp/compute-health — a pure function with no React deps, so it
 * can be unit-tested in isolation and reused by other consumers.
 *
 * Visual states:
 *   - healthy   → green dot, slow 2s pulse, "Healthy" label
 *   - degraded  → amber dot, medium 1.5s pulse, "Degraded" label
 *   - critical  → red dot, fast 0.8s pulse, "Critical" label
 *   - unknown   → gray dot, static (no animation), "Checking…" label
 *
 * The pulse animations are defined in `src/app/globals.css` as
 * `health-dot-green` / `health-dot-amber` / `health-dot-red` classes.
 */

import { useEffect, useRef } from "react";
import { Activity } from "lucide-react";
import { useApi } from "@/lib/fgmp/use-api";
import {
  useT,
  useDir,
  useArabicNumerals,
  formatNumber,
} from "@/lib/fgmp/use-language";
import { cn } from "@/lib/utils";
import { useNow } from "@/lib/fgmp/use-now";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  computeHealthStatus,
  type HealthSnapshot,
  type HealthStatus,
} from "@/lib/fgmp/compute-health";
import type { Language } from "@/lib/fgmp/i18n";

/** Polling interval (ms). Lighter than the full dashboard's 10s. */
const POLL_INTERVAL_MS = 30_000;

/** Per-status visual configuration: dot color, animation class, label key. */
interface StatusVisual {
  dotClass: string;
  animationClass: string;
  labelKey: string;
}

const STATUS_VISUALS: Record<HealthStatus, StatusVisual> = {
  healthy: {
    dotClass: "bg-emerald-500",
    animationClass: "health-dot-green",
    labelKey: "healthIndicator.healthy",
  },
  degraded: {
    dotClass: "bg-amber-500",
    animationClass: "health-dot-amber",
    labelKey: "healthIndicator.degraded",
  },
  critical: {
    dotClass: "bg-rose-500",
    animationClass: "health-dot-red",
    labelKey: "healthIndicator.critical",
  },
  unknown: {
    // Gray + static (no pulse) — the "we don't know yet" state.
    dotClass: "bg-muted-foreground/50",
    animationClass: "",
    labelKey: "healthIndicator.checking",
  },
};

interface SystemHealthIndicatorProps {
  /** Click handler — typically `() => setView("system-health")`. */
  onClick: () => void;
}

export function SystemHealthIndicator({ onClick }: SystemHealthIndicatorProps) {
  const t = useT();
  const dir = useDir();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const now = useNow();

  // ── Poll /api/fgmp/health every 30s ───────────────────────────────────
  // useApi sends `credentials: "include"` so the NextAuth session cookie
  // is attached automatically. On 401/403/network failure, `data` stays
  // null and `error` gets a string — both map to the "unknown" status.
  const { data, loading, error } = useApi<HealthSnapshot>(
    "/api/fgmp/health",
    { interval: POLL_INTERVAL_MS },
  );

  // ── Compute the 4-tier status from the latest snapshot ────────────────
  // On 200: data is populated → computeHealthStatus returns one of the
  // three "known" tiers. On loading/error/401: data is null → "unknown".
  const status: HealthStatus = computeHealthStatus(data ?? null);

  // ── Ref mirror of the latest snapshot + status ────────────────────────
  // Keeps the latest values reachable from any future callback (manual
  // refresh, keyboard handler, …) without re-creating the closure on
  // every render. This is the "ref to avoid stale closures" pattern
  // called out in the task spec.
  const dataRef = useRef<HealthSnapshot | null>(null);
  const statusRef = useRef<HealthStatus>(status);
  useEffect(() => {
    dataRef.current = data ?? null;
    statusRef.current = status;
  }, [data, status]);

  // ── Visual config for the current status ──────────────────────────────
  const visual = STATUS_VISUALS[status];
  const label = t(visual.labelKey);

  // ── Tooltip breakdown — only meaningful when we have data ─────────────
  // On the "unknown" state we show a generic "Fetching status…" hint
  // instead of zeros, so the user understands the widget is loading
  // rather than reporting a healthy system with no errors.
  const realtimeConnected = data?.realtime?.connected === true;
  const errorsLastHour = (() => {
    if (!data?.errors) return 0;
    return data.errors.filter((e) => {
      if (!e?.timestamp) return false;
      const ts = new Date(e.timestamp).getTime();
      if (!Number.isFinite(ts)) return false;
      return now - ts < 3_600_000;
    }).length;
  })();
  const avgResponseMs = data?.api?.avgResponseMs ?? 0;

  const tooltipRealtime = realtimeConnected
    ? t("healthIndicator.connected")
    : t("healthIndicator.disconnected");

  // Status-level aria-label for screen readers (concise summary).
  const ariaLabel = `${t("systemHealth.title")}: ${label}`;

  // When loading and no data yet, show the Activity icon as a fallback
  // (per spec) so the widget isn't a bare gray dot on first paint.
  const showActivityFallback = loading && !data;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel}
          title={ariaLabel}
          dir={dir === "rtl" ? "rtl" : undefined}
          className={cn(
            // ~120px wide, 32px tall — matches the header's other pills.
            "flex h-8 w-[120px] items-center justify-center gap-1.5 rounded-md px-2 text-xs",
            "text-muted-foreground transition-colors hover:bg-muted/50",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            // Status-tinted text for at-a-glance readability.
            status === "healthy" && "text-emerald-700 dark:text-emerald-400",
            status === "degraded" && "text-amber-700 dark:text-amber-400",
            status === "critical" && "text-rose-700 dark:text-rose-400",
          )}
        >
          {showActivityFallback ? (
            <Activity className="h-3.5 w-3.5 animate-pulse" />
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
                visual.dotClass,
                visual.animationClass,
              )}
            />
          )}
          <span className="truncate text-[12px] font-medium leading-none">
            {label}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="center"
        className="max-w-[240px] p-3 text-start"
      >
        <div
          className="flex flex-col gap-1"
          dir={dir === "rtl" ? "rtl" : undefined}
        >
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-semibold">
            <Activity className="h-3 w-3" />
            {t("systemHealth.title")}
          </div>
          {data ? (
            <>
              <TooltipRow
                label={t("healthIndicator.realtime")}
                value={tooltipRealtime}
                valueTone={
                  realtimeConnected
                    ? "text-emerald-500"
                    : "text-rose-500"
                }
              />
              <TooltipRow
                label={t("healthIndicator.errorsLastHour")}
                value={formatNumber(errorsLastHour, numLang)}
                valueTone={
                  errorsLastHour > 0
                    ? "text-amber-500"
                    : "text-emerald-500"
                }
              />
              <TooltipRow
                label={t("healthIndicator.avgResponse")}
                value={`${formatNumber(avgResponseMs, numLang)}ms`}
                valueTone={
                  avgResponseMs >= 500
                    ? "text-rose-500"
                    : avgResponseMs >= 200
                      ? "text-amber-500"
                      : "text-emerald-500"
                }
              />
              <div className="mt-1.5 border-t border-border/40 pt-1.5 text-[10px] text-muted-foreground">
                {t("healthIndicator.viewDetails")} →
              </div>
            </>
          ) : (
            <div className="py-1 text-[11px] text-muted-foreground">
              {error
                ? t("systemHealth.fetchError")
                : t("healthIndicator.checking")}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Small two-column row for the tooltip: label on the left, value on the right. */
function TooltipRow({
  label,
  value,
  valueTone,
}: {
  label: string;
  value: string;
  valueTone?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono font-medium tabular-nums", valueTone)}>
        {value}
      </span>
    </div>
  );
}
