"use client";

import { useMemo, useState } from "react";
import {
  Truck,
  Package,
  MapPin,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Fuel,
  ChevronDown,
  ChevronRight,
  User,
  Hash,
  Calendar,
  Droplet,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useApi } from "@/lib/fgmp/use-api";
import { useFgmp } from "@/lib/fgmp/store";
import { timeAgo, fmtLitres } from "@/lib/fgmp/format";

/**
 * Fuel Delivery Tracking
 *
 * Comprehensive panel showing:
 *  1. Pipeline summary bar (counts by status)
 *  2. Active deliveries timeline (in-transit list with ETA countdown)
 *  3. Recent completions (last 5 DELIVERED/VERIFIED, collapsible)
 *  4. Mini bar chart (last 7 days delivery volume)
 *
 * Polls /api/fgmp/deliveries every 10s. Looks up site region via the
 * FGMP Zustand store since the deliveries API only returns site name+code.
 */

interface DeliverySite {
  name?: string | null;
  code?: string | null;
  region?: string | null;
}

interface Delivery {
  id: string;
  siteId: string;
  tankId: string;
  supplier: string;
  driverName: string | null;
  vehiclePlate: string | null;
  volumeOrderedLitres: number;
  volumeDeliveredLitres: number | null;
  doNumber: string | null;
  status: string;
  scheduledAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  verifiedAt: string | null;
  unitPrice: number | null;
  discrepancyNote?: string | null;
  site?: DeliverySite | null;
  tank?: { label?: string | null } | null;
}

/** Canonical UI status — collapses IN_TRANSIT → DISPATCHED for display. */
type UiStatus = "SCHEDULED" | "DISPATCHED" | "DELIVERED" | "VERIFIED";

function toUiStatus(raw: string): UiStatus {
  const s = (raw ?? "").toUpperCase();
  if (s === "SCHEDULED") return "SCHEDULED";
  if (s === "DISPATCHED" || s === "IN_TRANSIT" || s === "EN_ROUTE") return "DISPATCHED";
  if (s === "VERIFIED") return "VERIFIED";
  return "DELIVERED"; // DELIVERED + anything else
}

const STATUS_META: Record<UiStatus, { label: string; tone: string; icon: typeof Truck }> = {
  SCHEDULED: { label: "Scheduled", tone: "sky", icon: Clock },
  DISPATCHED: { label: "Dispatched", tone: "amber", icon: Truck },
  DELIVERED: { label: "Delivered", tone: "emerald", icon: CheckCircle2 },
  VERIFIED: { label: "Verified", tone: "violet", icon: Package },
};

const TONE_TILE: Record<string, string> = {
  sky: "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300",
  amber: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300",
  emerald: "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
  violet: "border-violet-500/30 bg-violet-500/5 text-violet-700 dark:text-violet-300",
  slate: "border-slate-500/30 bg-slate-500/5 text-slate-700 dark:text-slate-300",
};

const TONE_BADGE: Record<string, string> = {
  sky: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30",
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  emerald: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  violet: "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/30",
};

const TONE_DOT: Record<string, string> = {
  sky: "bg-sky-500",
  amber: "bg-amber-500",
  emerald: "bg-emerald-500",
  violet: "bg-violet-500",
};

const TONE_BAR: Record<string, string> = {
  sky: "from-sky-500/70 to-sky-400",
  amber: "from-amber-500/70 to-amber-400",
  emerald: "from-emerald-500/70 to-emerald-400",
  violet: "from-violet-500/70 to-violet-400",
  slate: "from-slate-500/70 to-slate-400",
};

/** Format an ETA Date into "HH:MM" (Asia/Aden timezone). */
function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Aden" });
}

/** Format a minutes delta as "Nm" or "Nh" if >60m. */
function fmtMins(m: number): string {
  if (Math.abs(m) >= 60) {
    const h = Math.floor(Math.abs(m) / 60);
    const rem = Math.abs(m) % 60;
    return rem ? `${h}h${rem}m` : `${h}h`;
  }
  return `${m}m`;
}

/** Parse a possibly-null ISO timestamp into a Date or null. */
function parseDate(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  try {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export function FuelDeliveryTracking() {
  const { data: deliveries, loading } = useApi<Delivery[]>("/api/fgmp/deliveries", { interval: 10000 });
  const snapshot = useFgmp((s) => s.snapshot);
  const [completionsOpen, setCompletionsOpen] = useState(true);

  /** Build siteId → region lookup from the FGMP snapshot (API only returns name+code). */
  const regionOf = useMemo(() => {
    const map = new Map<string, string>();
    if (snapshot?.sites) {
      for (const s of snapshot.sites) map.set(s.id, s.region);
    }
    return map;
  }, [snapshot]);

  const enriched = useMemo(() => {
    return (deliveries ?? []).map((d) => {
      const uiStatus = toUiStatus(d.status);
      const region = d.site?.region ?? regionOf.get(d.siteId) ?? "";
      return { ...d, uiStatus, region };
    });
  }, [deliveries, regionOf]);

  // --- Pipeline summary counts/litres by UI status -----------------------
  const pipeline = useMemo(() => {
    const buckets: Record<UiStatus, { count: number; litres: number }> = {
      SCHEDULED: { count: 0, litres: 0 },
      DISPATCHED: { count: 0, litres: 0 },
      DELIVERED: { count: 0, litres: 0 },
      VERIFIED: { count: 0, litres: 0 },
    };
    let total = { count: 0, litres: 0 };
    for (const d of enriched) {
      const litres = d.volumeOrderedLitres ?? 0;
      buckets[d.uiStatus].count += 1;
      buckets[d.uiStatus].litres += litres;
      total.count += 1;
      total.litres += litres;
    }
    return { buckets, total };
  }, [enriched]);

  // --- Active deliveries (SCHEDULED + DISPATCHED) ------------------------
  const active = useMemo(() => {
    return enriched
      .filter((d) => d.uiStatus === "SCHEDULED" || d.uiStatus === "DISPATCHED")
      .sort((a, b) => {
        // DISPATCHED first, then by scheduledAt ascending
        if (a.uiStatus !== b.uiStatus) return a.uiStatus === "DISPATCHED" ? -1 : 1;
        const ta = parseDate(a.scheduledAt)?.getTime() ?? 0;
        const tb = parseDate(b.scheduledAt)?.getTime() ?? 0;
        return ta - tb;
      });
  }, [enriched]);

  // --- Recent completions (DELIVERED + VERIFIED) -------------------------
  const completions = useMemo(() => {
    return enriched
      .filter((d) => d.uiStatus === "DELIVERED" || d.uiStatus === "VERIFIED")
      .sort((a, b) => {
        const ta = parseDate(b.verifiedAt ?? b.deliveredAt)?.getTime() ?? 0;
        const tb = parseDate(a.verifiedAt ?? a.deliveredAt)?.getTime() ?? 0;
        return ta - tb;
      })
      .slice(0, 5);
  }, [enriched]);

  // --- 7-day mini bar chart ---------------------------------------------
  const daily = useMemo(() => {
    const days: { date: Date; key: string; label: string; litres: number; count: number }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      days.push({
        date: d,
        key: d.toISOString().slice(0, 10),
        label: d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "Asia/Aden" }),
        litres: 0,
        count: 0,
      });
    }
    const byKey = new Map(days.map((d) => [d.key, d]));
    for (const dv of enriched) {
      if (dv.uiStatus !== "DELIVERED" && dv.uiStatus !== "VERIFIED") continue;
      const ts = parseDate(dv.deliveredAt ?? dv.dispatchedAt ?? dv.scheduledAt);
      if (!ts) continue;
      const k = ts.toLocaleDateString("en-CA", { timeZone: "Asia/Aden" });
      const bucket = byKey.get(k);
      if (bucket) {
        bucket.litres += dv.volumeDeliveredLitres ?? dv.volumeOrderedLitres ?? 0;
        bucket.count += 1;
      }
    }
    return days;
  }, [enriched]);

  const maxDaily = Math.max(1, ...daily.map((d) => d.litres));

  return (
    <Card className="rounded-xl border bg-card/50 backdrop-blur">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Truck className="h-4 w-4 text-sky-500" />
          Fuel Delivery Tracking
          {loading && deliveries === null ? (
            <span className="ml-1 text-[10px] font-normal text-muted-foreground">loading…</span>
          ) : (
            <span className="ml-1 text-[10px] font-normal text-muted-foreground">
              {pipeline.total.count} total · live (10s)
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4">

        {/* ===== Pipeline Summary Bar ===== */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {(["SCHEDULED", "DISPATCHED", "DELIVERED", "VERIFIED"] as UiStatus[]).map((s) => {
            const meta = STATUS_META[s];
            const Icon = meta.icon;
            const b = pipeline.buckets[s];
            return (
              <div
                key={s}
                className={cn(
                  "rounded-lg border bg-muted/30 px-3 py-2 transition-colors hover:bg-muted/50",
                  TONE_TILE[meta.tone]
                )}
              >
                <div className="flex items-center gap-1.5">
                  <Icon className="h-3 w-3 opacity-80" />
                  <span className="text-[10px] font-semibold uppercase tracking-wide">{meta.label}</span>
                </div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-lg font-bold tabular-nums leading-none">{b.count}</span>
                  <span className="text-[10px] text-muted-foreground">{fmtLitres(b.litres)}</span>
                </div>
              </div>
            );
          })}
          {/* Total tile */}
          <div className={cn("rounded-lg border bg-muted/30 px-3 py-2", TONE_TILE.slate)}>
            <div className="flex items-center gap-1.5">
              <Fuel className="h-3 w-3 opacity-80" />
              <span className="text-[10px] font-semibold uppercase tracking-wide">Total</span>
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-lg font-bold tabular-nums leading-none">{pipeline.total.count}</span>
              <span className="text-[10px] text-muted-foreground">{fmtLitres(pipeline.total.litres)}</span>
            </div>
          </div>
        </div>

        {/* ===== Active Deliveries Timeline ===== */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Active Deliveries
            </h3>
            <Badge variant="outline" className="h-5 px-2 text-[10px]">{active.length} in transit</Badge>
          </div>
          {active.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/20 py-10 text-center">
              <Truck className="h-7 w-7 text-muted-foreground/60" />
              <p className="text-xs font-medium text-muted-foreground">No active deliveries</p>
              <p className="text-[10px] text-muted-foreground/80">All scheduled fuel is either delivered or awaiting dispatch.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {active.map((d) => (
                <ActiveDeliveryCard key={d.id} d={d} />
              ))}
            </div>
          )}
        </div>

        {/* ===== Recent Completions (collapsible) ===== */}
        <div>
          <button
            type="button"
            onClick={() => setCompletionsOpen((v) => !v)}
            className="mb-2 flex w-full items-center justify-between text-left"
          >
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {completionsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Recent Completions
            </h3>
            <Badge variant="outline" className="h-5 px-2 text-[10px]">{completions.length} recent</Badge>
          </button>
          {completionsOpen && (
            completions.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/20 py-8 text-center">
                <CheckCircle2 className="h-6 w-6 text-muted-foreground/60" />
                <p className="text-xs text-muted-foreground">No completed deliveries yet</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {completions.map((d) => {
                  const shortBy = (d.volumeOrderedLitres ?? 0) - (d.volumeDeliveredLitres ?? 0);
                  const isShort = d.volumeDeliveredLitres != null && shortBy > 0;
                  const completedAt = parseDate(d.verifiedAt ?? d.deliveredAt);
                  return (
                    <div
                      key={d.id}
                      className="flex items-center gap-2.5 rounded-lg border bg-card/50 px-3 py-2"
                    >
                      <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full", TONE_BADGE[STATUS_META[d.uiStatus].tone])}>
                        {d.uiStatus === "VERIFIED" ? <Package className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-xs font-medium">
                            {d.site?.name ?? "—"}
                            <span className="ml-1 text-[10px] text-muted-foreground">({d.site?.code ?? "—"})</span>
                          </p>
                          <span className={cn(
                            "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                            TONE_BADGE[STATUS_META[d.uiStatus].tone]
                          )}>
                            {STATUS_META[d.uiStatus].label}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="inline-flex items-center gap-0.5">
                            <Droplet className="h-2.5 w-2.5" />
                            {fmtLitres(d.volumeDeliveredLitres ?? d.volumeOrderedLitres ?? 0)}
                          </span>
                          <span>·</span>
                          <span className="inline-flex items-center gap-0.5">
                            <Clock className="h-2.5 w-2.5" />
                            {completedAt ? timeAgo(completedAt) : "—"}
                          </span>
                          {d.doNumber && (
                            <>
                              <span>·</span>
                              <span className="inline-flex items-center gap-0.5">
                                <Hash className="h-2.5 w-2.5" />
                                <span className="font-mono">{d.doNumber}</span>
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      {isShort && (
                        <span className="shrink-0 text-rose-600 text-[10px] font-medium">
                          Short by {fmtLitres(shortBy)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>

        {/* ===== Mini 7-day Bar Chart ===== */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Calendar className="h-3.5 w-3.5" />
              Last 7 Days Delivery Volume
            </h3>
            <Badge variant="outline" className="h-5 px-2 text-[10px]">
              {fmtLitres(daily.reduce((a, d) => a + d.litres, 0))} total
            </Badge>
          </div>
          <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
            {daily.map((d) => {
              const pct = (d.litres / maxDaily) * 100;
              return (
                <div key={d.key} className="group/grid flex items-center gap-2">
                  <div className="w-12 shrink-0 text-[10px] font-medium text-muted-foreground">{d.label}</div>
                  <div className="relative h-2.5 flex-1 rounded bg-muted/40">
                    <div
                      className={cn(
                        "h-2.5 rounded-r-md bg-gradient-to-r transition-all duration-500",
                        d.litres > 0 ? TONE_BAR.emerald : "bg-muted-foreground/20"
                      )}
                      style={{ width: `${Math.max(d.litres > 0 ? 4 : 0, pct)}%` }}
                    />
                    {/* Hover tooltip */}
                    <div className="pointer-events-none absolute left-1/2 top-[-30px] z-10 -translate-x-1/2 rounded-md border bg-popover px-2 py-1 text-[10px] opacity-0 shadow-md transition-opacity group-hover/grid:opacity-100">
                      <span className="font-medium">{d.label}</span>
                      <span className="mx-1 text-muted-foreground">·</span>
                      <span className="tabular-nums">{fmtLitres(d.litres)}</span>
                      <span className="ml-1 text-muted-foreground">({d.count} delivery{d.count === 1 ? "" : "ies"})</span>
                    </div>
                  </div>
                  <div className="w-16 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                    {d.litres > 0 ? fmtLitres(d.litres) : "—"}
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

/** Active delivery card with progress + ETA. */
function ActiveDeliveryCard({ d }: { d: Delivery & { uiStatus: UiStatus; region: string } }) {
  const now = Date.now();
  const scheduledAt = parseDate(d.scheduledAt);
  const dispatchedAt = parseDate(d.dispatchedAt);
  const eta = dispatchedAt ? new Date(dispatchedAt.getTime() + 90 * 60 * 1000) : null;
  const isDispatched = d.uiStatus === "DISPATCHED";

  // ETA state
  let etaLabel = "";
  let etaOverdue = false;
  if (eta) {
    const diffMin = Math.round((eta.getTime() - now) / 60000);
    if (diffMin >= 0) {
      etaLabel = `ETA: ${fmtTime(eta)} (in ${fmtMins(diffMin)})`;
    } else {
      etaLabel = `Overdue by ${fmtMins(-diffMin)}`;
      etaOverdue = true;
    }
  }

  // Progress label
  let progressLabel = "";
  if (isDispatched && dispatchedAt) {
    const elapsedMin = Math.max(0, Math.round((now - dispatchedAt.getTime()) / 60000));
    progressLabel = `In transit · ${fmtMins(elapsedMin)} elapsed`;
  } else if (scheduledAt) {
    const diffMin = Math.round((scheduledAt.getTime() - now) / 60000);
    if (diffMin >= 0) {
      progressLabel = `Awaiting dispatch · in ${fmtMins(diffMin)}`;
    } else {
      progressLabel = `Awaiting dispatch · ${fmtMins(-diffMin)} overdue`;
    }
  } else {
    progressLabel = "Awaiting dispatch";
  }

  // Progress % (mock): SCHEDULED=10%, DISPATCHED=40% (or scaled by elapsed vs ETA)
  const progressPct = isDispatched
    ? Math.min(95, Math.max(15, dispatchedAt ? Math.round(((now - dispatchedAt.getTime()) / (90 * 60 * 1000)) * 100) : 40))
    : 8;

  const meta = STATUS_META[d.uiStatus];

  return (
    <div className="rounded-lg border bg-card p-3 transition-colors hover:bg-muted/30 hover:shadow-sm">
      <div className="flex flex-wrap items-start gap-3">
        {/* Left: vehicle plate + driver */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <Truck className="h-3.5 w-3.5 text-muted-foreground" />
            {d.vehiclePlate ? (
              <span className="font-mono text-sm font-bold tracking-wide bg-muted/40 px-2 py-1 rounded">
                {d.vehiclePlate}
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground">No plate</span>
            )}
          </div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <User className="h-2.5 w-2.5" />
            <span className="truncate">{d.driverName ?? "Unassigned"}</span>
          </div>
        </div>

        {/* Middle: route + DO */}
        <div className="min-w-[180px] flex-1">
          <div className="flex items-center gap-1 text-[11px]">
            <span className="truncate font-medium">{d.supplier ?? "—"}</span>
            <MapPin className="h-2.5 w-2.5 text-muted-foreground" />
            <span className="truncate text-muted-foreground">{d.site?.name ?? "—"}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-0.5">
              <Droplet className="h-2.5 w-2.5" />
              {fmtLitres(d.volumeOrderedLitres ?? 0)} ordered
            </span>
            {d.site?.code && (
              <>
                <span>·</span>
                <span className="font-mono">{d.site.code}</span>
              </>
            )}
            {d.region && (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-0.5 rounded bg-muted/40 px-1 py-0.5">
                  <MapPin className="h-2 w-2" />
                  {d.region}
                </span>
              </>
            )}
          </div>
          {/* DO number chip */}
          {d.doNumber && (
            <div className="mt-1">
              <span className="font-mono text-[10px] bg-muted/40 px-1.5 py-0.5 rounded inline-flex items-center gap-0.5">
                <Hash className="h-2 w-2" />
                {d.doNumber}
              </span>
            </div>
          )}
        </div>

        {/* Right: status + ETA */}
        <div className="flex flex-col items-end gap-1">
          <span className={cn(
            "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
            TONE_BADGE[meta.tone]
          )}>
            {meta.label}
          </span>
          {etaLabel && (
            <span className={cn(
              "rounded-md border px-2 py-0.5 text-[11px] inline-flex items-center gap-1",
              etaOverdue
                ? "bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-400"
                : "bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400"
            )}>
              {etaOverdue ? <AlertTriangle className="h-2.5 w-2.5" /> : <Clock className="h-2.5 w-2.5" />}
              {etaLabel}
            </span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-2.5">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[meta.tone])} />
            {progressLabel}
          </span>
          <span className="tabular-nums">{progressPct}%</span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-1.5 rounded-full bg-gradient-to-r transition-all duration-700",
              etaOverdue ? TONE_BAR.amber : TONE_BAR[meta.tone]
            )}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
