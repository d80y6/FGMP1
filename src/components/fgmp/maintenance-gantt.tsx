"use client";

import { useMemo, useState } from "react";
import { CalendarClock, ChevronRight } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fmtDateTime } from "@/lib/fgmp/format";
import { useNow } from "@/lib/fgmp/use-now";
import { useT, useTF } from "@/lib/fgmp/use-language";

interface MaintenanceTicket {
  id: string;
  siteId: string;
  assetKind: string;
  assetId: string;
  type: string;
  status: string;
  priority: string;
  title: string;
  description?: string | null;
  assignedToId?: string | null;
  scheduledFor?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  site?: { name: string; code?: string | null } | null;
  assignedTo?: { name?: string } | null;
}

type RangeOption = 7 | 30 | 90;

interface MaintenanceGanttProps {
  tickets: MaintenanceTicket[];
  defaultRange?: RangeOption;
  onTicketClick?: (ticketId: string) => void;
}

// Status -> bar color tokens (DONE gets 50% opacity per spec)
const STATUS_META: Record<string, { bg: string; text: string; label: string }> = {
  OPEN: { bg: "bg-sky-500", text: "text-sky-500", label: "Open" },
  SCHEDULED: { bg: "bg-amber-500", text: "text-amber-500", label: "Scheduled" },
  IN_PROGRESS: { bg: "bg-violet-500", text: "text-violet-500", label: "In Progress" },
  DONE: { bg: "bg-emerald-500/50", text: "text-emerald-500", label: "Done" },
};

const STATUS_ORDER = ["OPEN", "SCHEDULED", "IN_PROGRESS", "DONE"];

const DAY_MS = 24 * 60 * 60 * 1000;
const LABEL_WIDTH = 168; // left Y-axis column
const ROW_HEIGHT = 32;
const BAR_HEIGHT = 22;
const MAX_SITES = 12;

// Range-dependent configuration
const RANGE_OPTIONS: RangeOption[] = [7, 30, 90];
const DAY_WIDTH_BY_RANGE: Record<RangeOption, number> = {
  7: 60, // wider, more detail
  30: 32, // current
  90: 14, // compact
};
const MIN_WIDTH_BY_RANGE: Record<RangeOption, number> = {
  7: 600,
  30: 800,
  90: 1200,
};
// X-axis label day-offsets per range
const LABEL_OFFSETS: Record<RangeOption, number[]> = {
  7: [0, 1, 2, 3, 4, 5, 6], // every day
  30: [1, 5, 10, 15, 20, 25], // every 5 days (existing behavior)
  90: [1, 14, 28, 42, 56, 70, 84], // every 14 days
};

/** A ticket that has a schedule instant — narrowed once, at the split below. */
type ScheduledTicket = MaintenanceTicket & { scheduledFor: string };

interface HoverState {
  ticket: ScheduledTicket;
  rowIdx: number;
  left: number;
  width: number;
}

/**
 * Maintenance Schedule Gantt
 * Renders maintenance tickets across a configurable timeline (7/30/90 days),
 * grouped by site. Past-due tickets pulse with a rose ring; DONE bars stretch
 * from scheduledFor to completedAt. Unscheduled tickets appear in a dedicated
 * lane above. The range toggle in the header lets users pick 7d (focused),
 * 30d (default) or 90d (long-horizon).
 */
export function MaintenanceGantt({ tickets, defaultRange = 30, onTicketClick }: MaintenanceGanttProps) {
  const t = useT();
  const tFmt = useTF();
  const [hovered, setHovered] = useState<HoverState | null>(null);
  const [range, setRange] = useState<RangeOption>(defaultRange);

  // Dynamic timeline geometry derived from the active range
  const timelineDays = range;
  const pastDays = Math.max(2, Math.floor(range * 0.18)); // 2 / 5 / 16 for 7 / 30 / 90
  const dayWidth = DAY_WIDTH_BY_RANGE[range];
  const minWidth = MIN_WIDTH_BY_RANGE[range];
  const labelOffsets = LABEL_OFFSETS[range];

  const timelineWidth = timelineDays * dayWidth;
  const now = useNow();

  // Timeline anchor: start of (today - pastDays) in local time. Derived from
  // the shared clock rather than from `new Date()` so the value is a pure
  // function of render inputs — the compiler's purity check, and a render
  // replayed by React, both depend on that.
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const startMs = dayStart.getTime() - pastDays * DAY_MS;

  // Split scheduled vs unscheduled
  const { scheduled, unscheduled } = useMemo(() => {
    // `scheduledFor` is optional on the wire shape; narrowing here means every
    // consumer below (bar geometry, tooltip) can use it as a plain string.
    const sched: ScheduledTicket[] = [];
    const unsched: MaintenanceTicket[] = [];
    for (const t of tickets) {
      if (t.scheduledFor) sched.push({ ...t, scheduledFor: t.scheduledFor });
      else unsched.push(t);
    }
    return { scheduled: sched, unscheduled: unsched };
  }, [tickets]);

  // Group by site, keep top N by ticket count
  const { rows, hiddenSitesCount } = useMemo(() => {
    const bySite = new Map<string, { name: string; code: string; tickets: ScheduledTicket[] }>();
    for (const t of scheduled) {
      const key = t.siteId;
      let group = bySite.get(key);
      if (!group) {
        group = { name: t.site?.name ?? "Unknown", code: t.site?.code ?? "—", tickets: [] };
        bySite.set(key, group);
      }
      group.tickets.push(t);
    }
    const sorted = Array.from(bySite.entries())
      .map(([siteId, v]) => ({ siteId, ...v, count: v.tickets.length }))
      .sort((a, b) => b.count - a.count);
    return {
      rows: sorted.slice(0, MAX_SITES),
      hiddenSitesCount: Math.max(0, sorted.length - MAX_SITES),
    };
  }, [scheduled]);

  // Counts per status (across ALL tickets — including unscheduled)
  const counts = useMemo(() => {
    const c: Record<string, number> = { OPEN: 0, SCHEDULED: 0, IN_PROGRESS: 0, DONE: 0 };
    for (const t of tickets) {
      if (c[t.status] !== undefined) c[t.status]++;
    }
    return c;
  }, [tickets]);

  // X-axis labels at range-specific day offsets
  const dayLabels = useMemo(() => {
    return labelOffsets.map((off) => {
      const d = new Date(startMs + off * DAY_MS);
      return {
        day: off,
        label: String(d.getDate()),
        month: d.toLocaleDateString("en-US", { month: "short" }),
      };
    });
  }, [startMs, labelOffsets]);

  // Count of scheduled tickets whose bar intersects the visible range
  const visibleTicketsCount = useMemo(() => {
    let count = 0;
    for (const t of scheduled) {
      if (!t.scheduledFor) continue;
      const sched = new Date(t.scheduledFor).getTime();
      const startDay = Math.floor((sched - startMs) / DAY_MS);
      let endDay = startDay + 1;
      if (t.status === "DONE" && t.completedAt) {
        const compDay =
          Math.floor((new Date(t.completedAt).getTime() - startMs) / DAY_MS) + 1;
        if (compDay > endDay) endDay = compDay;
      }
      // Visible if [startDay, endDay] intersects [0, timelineDays]
      if (startDay < timelineDays && endDay > 0) count++;
    }
    return count;
  }, [scheduled, startMs, timelineDays]);

  // Empty state: no scheduled tickets at all
  if (scheduled.length === 0) {
    return (
      <div className="space-y-3">
        <HeaderToolbar
          range={range}
          setRange={setRange}
          visibleCount={0}
          totalCount={tickets.length}
          counts={counts}
        />
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted/40">
            <CalendarClock className="h-7 w-7 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("maintenance.noScheduled")}</p>
            <p className="text-xs text-muted-foreground">
              {tFmt("maintenance.emptyHint", { n: range })}
            </p>
          </div>
          {unscheduled.length > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {unscheduled.length} unscheduled ticket{unscheduled.length === 1 ? "" : "s"} not shown
            </Badge>
          )}
        </div>
      </div>
    );
  }

  // Compute bar position for a ticket (clamped to visible range)
  const positionFor = (t: ScheduledTicket) => {
    const sched = new Date(t.scheduledFor).getTime();
    const startDay = Math.floor((sched - startMs) / DAY_MS);
    let endDay = startDay + 1; // default: 1-day wide bar
    if (t.status === "DONE" && t.completedAt) {
      const compDay = Math.floor((new Date(t.completedAt).getTime() - startMs) / DAY_MS) + 1;
      if (compDay > endDay) endDay = compDay;
    }
    const visibleStart = Math.max(0, startDay);
    const visibleEnd = Math.min(timelineDays, endDay);
    const isPastDue = sched < now && t.status !== "DONE";
    return {
      left: visibleStart * dayWidth,
      width: Math.max(dayWidth * 0.8, (visibleEnd - visibleStart) * dayWidth),
      isPastDue,
    };
  };

  // Today vertical line x-position (centered on the pastDays column)
  const todayX = LABEL_WIDTH + pastDays * dayWidth + dayWidth / 2;

  // Tooltip horizontal position (clamped so it stays within the timeline area)
  const tooltipHalf = 110;
  const tooltipLeft = hovered
    ? Math.max(
        LABEL_WIDTH + tooltipHalf,
        Math.min(
          LABEL_WIDTH + timelineWidth - tooltipHalf,
          LABEL_WIDTH + hovered.left + hovered.width / 2,
        ),
      )
    : 0;
  // For row 0 place tooltip below the bar (so it doesn't overflow above the header)
  const placeBelow = hovered ? hovered.rowIdx === 0 : false;
  const tooltipTop = hovered
    ? placeBelow
      ? (hovered.rowIdx + 1) * ROW_HEIGHT + 4
      : hovered.rowIdx * ROW_HEIGHT - 4
    : 0;
  const tooltipTransform = placeBelow
    ? "translateX(-50%)"
    : "translateX(-50%) translateY(-100%)";

  return (
    <div className="space-y-3">
      <HeaderToolbar
        range={range}
        setRange={setRange}
        visibleCount={visibleTicketsCount}
        totalCount={tickets.length}
        counts={counts}
      />

      {/* Unscheduled lane */}
      {unscheduled.length > 0 && (
        <div className="flex items-stretch gap-2 rounded-md border border-dashed border-muted-foreground/20 bg-muted/20 px-2 py-1.5">
          <div className="flex w-[168px] shrink-0 items-center">
            <span className="text-[11px] font-medium text-muted-foreground">Unscheduled</span>
            <Badge variant="outline" className="ml-1.5 h-4 px-1 text-[9px]">
              {unscheduled.length}
            </Badge>
          </div>
          <div className="flex flex-1 flex-wrap gap-1">
            {unscheduled.slice(0, 8).map((t) => {
              const m = STATUS_META[t.status] ?? STATUS_META.OPEN;
              return (
                <span
                  key={t.id}
                  title={t.title}
                  className={cn("rounded px-1.5 py-0.5 text-[9px] text-white", m.bg)}
                >
                  {t.title.length > 22 ? t.title.slice(0, 22) + "…" : t.title}
                </span>
              );
            })}
            {unscheduled.length > 8 && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                +{unscheduled.length - 8} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* Gantt chart */}
      <ScrollArea className="w-full pb-2">
        <div
          className="min-w-[600px]"
          style={{ width: LABEL_WIDTH + timelineWidth, minWidth }}
        >
          {/* Header: X-axis */}
          <div className="flex border-b border-border/60">
            <div
              className="sticky left-0 z-20 shrink-0 border-r border-border/60 bg-card px-3 py-1.5"
              style={{ width: LABEL_WIDTH }}
            >
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Site
              </span>
            </div>
            <div className="relative" style={{ width: timelineWidth, height: 36 }}>
              {/* Today badge (top) */}
              <div
                className="absolute top-0 z-20 flex -translate-x-1/2 items-center"
                style={{ left: pastDays * dayWidth + dayWidth / 2 }}
              >
                <Badge
                  variant="outline"
                  className="h-4 px-1 text-[8px] border-rose-500/50 bg-rose-500/15 text-rose-600 dark:text-rose-400"
                >
                  TODAY
                </Badge>
              </div>
              {/* Day labels (bottom) */}
              {dayLabels.map((d) => (
                <div
                  key={d.day}
                  className="absolute bottom-0 flex h-5 flex-col justify-end border-l border-border/40 pl-1"
                  style={{ left: d.day * dayWidth }}
                >
                  <span className="text-[10px] font-semibold leading-none text-foreground">
                    {d.label}
                  </span>
                  <span className="text-[9px] leading-none text-muted-foreground">{d.month}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Body: rows */}
          <div className="relative">
            {/* Today vertical line (spans all rows) */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-rose-500/60"
              style={{ left: todayX }}
            />

            {rows.map((row, i) => (
              <div key={row.siteId} className="flex items-stretch border-b border-border/30">
                {/* Y-axis: site label (sticky so it stays visible while scrolling) */}
                <div
                  className="sticky left-0 z-20 shrink-0 border-r border-border/60 bg-card px-3 py-1"
                  style={{ width: LABEL_WIDTH }}
                >
                  <p className="truncate text-[11px] font-medium leading-tight" title={row.name}>
                    {row.name}
                  </p>
                  <p className="text-[9px] text-muted-foreground">
                    {row.code} · {row.count}
                  </p>
                </div>
                {/* Timeline track */}
                <div className="relative" style={{ width: timelineWidth, height: ROW_HEIGHT }}>
                  {/* Subtle gridlines at labeled day offsets */}
                  {dayLabels.map((d) => (
                    <div
                      key={d.day}
                      className="pointer-events-none absolute top-0 bottom-0 border-l border-border/20"
                      style={{ left: d.day * dayWidth }}
                    />
                  ))}
                  {/* Ticket bars */}
                  {row.tickets.map((t) => {
                    const pos = positionFor(t);
                    const m = STATUS_META[t.status] ?? STATUS_META.OPEN;
                    return (
                      <div
                        key={t.id}
                        className={cn(
                          "group absolute top-1/2 -translate-y-1/2 cursor-pointer overflow-hidden rounded-md px-1.5 text-[9px] font-medium text-white shadow-sm transition-[filter,box-shadow] hover:z-30 hover:brightness-125 hover:shadow-md",
                          m.bg,
                          pos.isPastDue && "ring-2 ring-rose-500 animate-pulse",
                        )}
                        style={{ left: pos.left, width: pos.width, height: BAR_HEIGHT }}
                        onClick={() => onTicketClick?.(t.id)}
                        onMouseEnter={() =>
                          setHovered({ ticket: t, rowIdx: i, left: pos.left, width: pos.width })
                        }
                        onMouseLeave={() => setHovered(null)}
                      >
                        <span className="pointer-events-none block truncate pr-2 leading-[20px]">
                          {t.title}
                        </span>
                        <ChevronRight className="absolute right-0.5 top-1/2 -translate-y-1/2 h-2.5 w-2.5 text-white/70 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* "+N more sites" indicator */}
            {hiddenSitesCount > 0 && (
              <div className="flex items-center border-b border-border/30">
                <div
                  className="sticky left-0 z-20 shrink-0 border-r border-border/60 bg-card px-3 py-1.5"
                  style={{ width: LABEL_WIDTH }}
                >
                  <span className="text-[10px] text-muted-foreground">
                    +{hiddenSitesCount} more site{hiddenSitesCount === 1 ? "" : "s"}
                  </span>
                </div>
                <div style={{ width: timelineWidth }} />
              </div>
            )}

            {/* Hover tooltip */}
            {hovered && (
              <div
                className="pointer-events-none absolute z-40 w-[220px]"
                style={{ left: tooltipLeft, top: tooltipTop, transform: tooltipTransform }}
              >
                <div className="rounded-md border border-border bg-popover p-2 text-[10px] shadow-lg">
                  <p className="truncate text-[11px] font-semibold text-foreground">
                    {hovered.ticket.title}
                  </p>
                  <div className="mt-1 space-y-0.5 text-muted-foreground">
                    <p>
                      Site:{" "}
                      <span className="text-foreground">
                        {hovered.ticket.site?.name ?? "—"}
                      </span>
                    </p>
                    <p>
                      Type:{" "}
                      <span className="text-foreground">
                        {hovered.ticket.type.replace(/_/g, " ")}
                      </span>
                    </p>
                    <p>
                      Status:{" "}
                      <span className={STATUS_META[hovered.ticket.status]?.text}>
                        {STATUS_META[hovered.ticket.status]?.label ?? hovered.ticket.status}
                      </span>
                    </p>
                    <p>
                      Scheduled:{" "}
                      <span className="text-foreground">
                        {fmtDateTime(hovered.ticket.scheduledFor)}
                      </span>
                    </p>
                    {hovered.ticket.completedAt && (
                      <p>
                        Completed:{" "}
                        <span className="text-foreground">
                          {fmtDateTime(hovered.ticket.completedAt)}
                        </span>
                      </p>
                    )}
                    {hovered.ticket.assignedTo?.name && (
                      <p>
                        Assignee:{" "}
                        <span className="text-foreground">
                          {hovered.ticket.assignedTo.name}
                        </span>
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * Header toolbar: status legend (left) + "Showing N of M" counter, range
 * toggle (7d / 30d / 90d), and Past-due legend (right).
 */
function HeaderToolbar({
  range,
  setRange,
  visibleCount,
  totalCount,
  counts,
}: {
  range: RangeOption;
  setRange: (r: RangeOption) => void;
  visibleCount: number;
  totalCount: number;
  counts: Record<string, number>;
}) {
  // This helper renders outside the view component, so `t` was not in scope
  // when the toolbar label was translated.
  const t = useT();
  const tFmt = useTF();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1">
      {STATUS_ORDER.map((s) => {
        const m = STATUS_META[s];
        return (
          <div key={s} className="flex items-center gap-1.5">
            <span className={cn("h-2.5 w-2.5 rounded-sm", m.bg)} />
            <span className="text-[11px] text-muted-foreground">{m.label}</span>
            <span className={cn("text-[11px] font-semibold", m.text)}>
              {counts[s] ?? 0}
            </span>
          </div>
        );
      })}
      <div className="ml-auto flex items-center gap-3">
        <span className="text-[10px] text-muted-foreground">
          {tFmt("maintenance.showingCount", { visible: visibleCount, total: totalCount })}
        </span>
        <div
          className="inline-flex h-7 items-center rounded-md border bg-muted/40 p-0.5"
          role="tablist"
          aria-label={t("common.timelineRange")}
        >
          {RANGE_OPTIONS.map((r) => {
            const active = range === r;
            return (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setRange(r)}
                className={cn(
                  "h-6 px-2.5 text-[11px] font-medium rounded transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r}d
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm ring-2 ring-rose-500/60 animate-pulse" />
          <span className="text-[11px] text-muted-foreground">{t("maintenance.pastDue")}</span>
        </div>
      </div>
    </div>
  );
}
