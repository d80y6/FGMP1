"use client";

/**
 * FGMP loading skeletons — shimmer placeholders for data-heavy views.
 *
 * Each skeleton mirrors the layout/spacing of its real counterpart so the
 * transition from skeleton → live data is layout-shift-free. All skeletons
 * build on the shadcn `Skeleton` primitive (which already pulses) and layer
 * a `.shimmer` gradient sweep on top for a more polished feel.
 *
 * Exported components:
 *   - KpiCardSkeleton        — single KPI card placeholder
 *   - DashboardSkeleton      — full NOC dashboard layout (KPIs + charts + lists)
 *   - TableSkeleton          — generic table-shaped skeleton (rows × cols)
 *   - ChartSkeleton          — card with title line + chart block
 *   - AlarmsListSkeleton     — 8 alarm-row placeholders
 *   - SitesGridSkeleton      — grid of site card placeholders
 *   - DetailsSheetSkeleton   — detail-drawer header + 3 sections
 *
 * Task 33-C.
 */

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────
 * KPI card skeleton
 * ──────────────────────────────────────────────────────────────────────── */

export function KpiCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "shimmer relative overflow-hidden rounded-xl border bg-card p-4",
        className,
      )}
    >
      {/* accent bar */}
      <Skeleton className="absolute inset-x-0 top-0 h-1 rounded-none" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          {/* label line — small */}
          <Skeleton className="h-2.5 w-20" />
          {/* value line — larger */}
          <Skeleton className="h-6 w-24" />
          {/* hint line */}
          <Skeleton className="h-2 w-28" />
        </div>
        {/* icon box */}
        <Skeleton className="h-10 w-10 rounded-xl" />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Dashboard skeleton — KPI strip + chart + alarm list
 * ──────────────────────────────────────────────────────────────────────── */

export function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      {/* SectionHeader placeholder */}
      <div className="shimmer flex items-center justify-between rounded-lg border bg-card p-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-lg" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </div>

      {/* System status banner skeleton */}
      <div className="shimmer rounded-lg border bg-card p-3">
        <Skeleton className="h-9 w-full" />
      </div>

      {/* KPI grid — 4 cards in a row (responsive) */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <KpiCardSkeleton key={i} />
        ))}
      </div>

      {/* 2-column grid: chart skeleton + alarm list skeleton */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* Chart skeleton (h-64) — spans 2 columns on xl */}
        <div className="shimmer rounded-xl border bg-card p-4 xl:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
          <Skeleton className="h-64 w-full" />
        </div>

        {/* Alarm list skeleton — 5 rows */}
        <div className="shimmer rounded-xl border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-16 rounded-md" />
          </div>
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-start gap-2.5 rounded-lg border p-2.5"
              >
                <Skeleton className="mt-1.5 h-2 w-2 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-2.5 w-full" />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Charts row placeholder — 3 smaller cards */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "shimmer rounded-xl border bg-card p-4",
              i === 2 && "lg:col-span-2 xl:col-span-2",
            )}
          >
            <Skeleton className="mb-3 h-4 w-32" />
            <Skeleton className="h-44 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Table skeleton — header row + N body rows × M cols
 * ──────────────────────────────────────────────────────────────────────── */

export function TableSkeleton({
  rows = 8,
  cols = 5,
  className,
}: {
  rows?: number;
  cols?: number;
  className?: string;
}) {
  return (
    <div className={cn("shimmer w-full", className)}>
      {/* header row */}
      <div
        className="grid items-center gap-2 border-b px-3 py-2"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: cols }).map((_, c) => (
          <Skeleton key={c} className="h-3.5" />
        ))}
      </div>
      {/* body rows */}
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className="grid items-center gap-2 px-3 py-3"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton
                key={c}
                className={cn(
                  "h-4",
                  // Vary widths for visual rhythm — first col narrow, last col wide
                  c === 0 && "w-12",
                  c === cols - 1 && "w-full",
                  c > 0 && c < cols - 1 && "w-3/4",
                )}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Chart skeleton — card with title line + chart block
 * ──────────────────────────────────────────────────────────────────────── */

export function ChartSkeleton({
  height = 240,
  className,
}: {
  height?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "shimmer rounded-xl border bg-card p-4",
        className,
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-5 w-12 rounded-full" />
      </div>
      {/* chart area — wavy: a baseline grid + a few "bars" of varying
          heights to suggest a chart silhouette rather than a flat block */}
      <div
        className="relative w-full overflow-hidden rounded-md border border-border/40 bg-background/40"
        style={{ height: `${height}px` }}
      >
        {/* faint horizontal grid lines */}
        <div className="absolute inset-0 flex flex-col justify-between p-2 opacity-40">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-px w-full opacity-50" />
          ))}
        </div>
        {/* varying-height bars — like a bar chart silhouette */}
        <div className="absolute inset-x-4 bottom-4 flex items-end gap-1.5">
          {[40, 65, 50, 80, 60, 90, 70, 55, 75, 45, 85, 60].map((h, i) => (
            <Skeleton
              key={i}
              className="flex-1 rounded-t-sm"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Alarms list skeleton — 8 alarm rows
 * Each row: colored dot + 2 text lines + badge
 * ──────────────────────────────────────────────────────────────────────── */

export function AlarmsListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="shimmer space-y-2 p-3">
      {/* table-style header */}
      <div className="grid grid-cols-[24px_140px_1fr_70px_90px_90px] items-center gap-2 border-b px-2 pb-2">
        <Skeleton className="h-3" />
        <Skeleton className="h-3" />
        <Skeleton className="h-3" />
        <Skeleton className="h-3" />
        <Skeleton className="h-3" />
        <Skeleton className="h-3" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="grid grid-cols-[24px_140px_1fr_70px_90px_90px] items-center gap-2 rounded-md border p-2.5"
        >
          {/* colored dot */}
          <Skeleton className="h-2 w-2 rounded-full" />
          {/* type label */}
          <Skeleton className="h-3 w-28" />
          {/* message + site name (2 lines) */}
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-2.5 w-2/3" />
          </div>
          {/* severity badge */}
          <Skeleton className="h-5 w-12 rounded-full" />
          {/* status badge */}
          <Skeleton className="h-5 w-14 rounded-full" />
          {/* action buttons */}
          <div className="flex justify-end gap-1">
            <Skeleton className="h-6 w-12 rounded-md" />
            <Skeleton className="h-6 w-14 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Sites grid skeleton — 6-9 site card placeholders
 * ──────────────────────────────────────────────────────────────────────── */

export function SitesGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="shimmer rounded-xl border bg-card p-4"
        >
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-2.5 w-14" />
              </div>
            </div>
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className="h-2.5 w-3/4" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
          <div className="mt-3 flex items-center justify-between border-t pt-3">
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Details sheet skeleton — header (avatar + 2 lines) + 3 sections
 * Used by site detail / region detail / alarm detail sheets while they
 * fetch their data on open.
 * ──────────────────────────────────────────────────────────────────────── */

export function DetailsSheetSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("shimmer space-y-4 p-4", className)}>
      {/* Header: avatar circle + 2 lines */}
      <div className="flex items-center gap-3 border-b pb-4">
        <Skeleton className="h-12 w-12 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="h-8 w-8 rounded-md" />
      </div>

      {/* 3 sections of content */}
      {Array.from({ length: 3 }).map((_, s) => (
        <div key={s} className="space-y-2">
          {/* section title */}
          <Skeleton className="h-3.5 w-32" />
          {/* 2-3 rows of fields */}
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: 4 }).map((_, r) => (
              <div key={r} className="rounded-md border p-2">
                <Skeleton className="mb-1.5 h-2 w-16" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
