"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Cpu,
  Database,
  Zap,
  Clock,
  Users,
  Wifi,
  WifiOff,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  Minus,
  ShieldAlert,
} from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useT,
  useDir,
  useArabicNumerals,
  formatNumber,
} from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────
 * Types — mirror of the HealthResponse interface exported by
 * /api/fgmp/health/route.ts. Declared locally so the view doesn't import
 * from a route file (which would couple the client bundle to the server
 * module).
 * ──────────────────────────────────────────────────────────────────────── */

interface RecordedError {
  timestamp: string;
  method: string;
  path: string;
  status: number;
  message: string;
}

interface HealthResponse {
  uptime: string;
  uptimeSeconds: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  database: {
    type: "sqlite";
    sizeBytes: number;
    sizeMB: number;
    path: string;
    tableCounts: {
      sites: number;
      alarms: number;
      sensorReadings: number;
      users: number;
      auditLogs: number;
    };
  };
  realtime: {
    connected: boolean;
    url: string;
    clients: number;
  };
  api: {
    avgResponseMs: number;
    totalRequests: number;
  };
  sessions: {
    activeUsers: number;
  };
  errors: RecordedError[];
  timestamp: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────────────────────────────────── */

const POLL_INTERVAL_S = 10;
const ONE_HOUR_MS = 60 * 60 * 1000;

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */

/** Localize a Date ISO string → readable HH:MM:SS in the active language. */
function fmtTime(iso: string, lang: Language): string {
  try {
    const d = new Date(iso);
    if (lang === "ar") {
      try {
        return d.toLocaleTimeString("ar-SA-u-nu-arab", {
          hour12: false,
          timeZone: "Asia/Aden",
        });
      } catch {
        return d.toLocaleTimeString("en-GB", { hour12: false });
      }
    }
    return d.toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Aden" });
  } catch {
    return iso;
  }
}

/** Localize a Date ISO string → readable YYYY-MM-DD HH:MM:SS. */
function fmtDateTimeLocal(iso: string, lang: Language): string {
  try {
    const d = new Date(iso);
    if (lang === "ar") {
      try {
        return d.toLocaleString("ar-SA-u-nu-arab", {
          hour12: false,
          timeZone: "Asia/Aden",
        });
      } catch {
        return d.toLocaleString("en-GB", { hour12: false });
      }
    }
    return d.toLocaleString("en-GB", { hour12: false, timeZone: "Asia/Aden" });
  } catch {
    return iso;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function SystemHealthView() {
  const t = useT();
  const dir = useDir();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const { me } = useFgmp();

  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [countdown, setCountdown] = useState(POLL_INTERVAL_S);
  // Track previous avgResponseMs to compute trend.
  const prevAvgRef = useRef<number | null>(null);
  // Incremented to force a manual refresh; bundled into the fetch effect deps.
  const [manualNonce, setManualNonce] = useState(0);

  const doFetch = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/fgmp/health", { credentials: "include" });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as HealthResponse;
      setData(json);
      setError(null);
      setLastRefresh(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  // Manual + interval fetcher. The interval is driven by a 1s countdown
  // (so the UI can render the countdown to next refresh). When countdown
  // reaches 0 we fetch and reset to POLL_INTERVAL_S.
  useEffect(() => {
    // Initial load + manual refresh trigger.
    void doFetch();
  }, [doFetch, manualNonce]);

  useEffect(() => {
    const id = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          void doFetch();
          return POLL_INTERVAL_S;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [doFetch]);

  // Reset the countdown whenever the user manually refreshes.
  const manualRefresh = useCallback(() => {
    setCountdown(POLL_INTERVAL_S);
    setManualNonce((n) => n + 1);
  }, []);

  // Compute trend on avgResponseMs across fetches.
  const avgTrend = useMemo(() => {
    const cur = data?.api.avgResponseMs;
    if (cur === undefined) return 0;
    const prev = prevAvgRef.current;
    if (prev === null || prev === 0) {
      prevAvgRef.current = cur;
      return 0;
    }
    const delta = Math.round(((cur - prev) / prev) * 100);
    // Only update the ref when we have a new sample (cur differs from prev).
    if (cur !== prev) prevAvgRef.current = cur;
    return delta;
  }, [data?.api.avgResponseMs]);

  // Number of errors captured within the last hour (drives the KPI tone).
  const errorsLastHour = useMemo(() => {
    if (!data?.errors) return 0;
    const cutoff = Date.now() - ONE_HOUR_MS;
    return data.errors.filter((e) => {
      try {
        return new Date(e.timestamp).getTime() >= cutoff;
      } catch {
        return false;
      }
    }).length;
  }, [data?.errors]);

  // Heap usage percentage (drives the Progress bar + colour).
  const heapPct = useMemo(() => {
    const { heapUsed, heapTotal } = data?.memory ?? { heapUsed: 0, heapTotal: 0 };
    if (!heapTotal || heapTotal <= 0) return 0;
    return Math.min(100, Math.round((heapUsed / heapTotal) * 100));
  }, [data?.memory]);

  // ── Access control: ADMIN-only ──────────────────────────────────────────
  // Checked AFTER all hooks are called (Rules of Hooks). Non-admins who
  // somehow land on this view (e.g. via URL ?view=system-health) see a
  // rejection alert instead of the dashboard.
  if (me && me.role !== "ADMIN") {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>{t("systemHealth.accessDenied")}</AlertTitle>
          <AlertDescription>
            {t("systemHealth.accessDeniedDescription")}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // ── Derived display values ──────────────────────────────────────────────
  const uptimeStr = data?.uptime ?? "—";
  const uptimeHealthy = (data?.uptimeSeconds ?? 0) >= 3600; // > 1h
  const avgResponse = data?.api.avgResponseMs ?? 0;
  const activeSessions = data?.sessions.activeUsers ?? 0;

  // Error count tone: 0 = good, 1-3 = warn, 4+ = danger.
  const errorTone: "good" | "warn" | "danger" =
    errorsLastHour === 0 ? "good" : errorsLastHour <= 3 ? "warn" : "danger";

  // ── Loading state (first fetch, no data yet) ────────────────────────────
  if (loading && !data) {
    return (
      <div className="space-y-4">
        <SectionHeader
          title={t("systemHealth.title")}
          description={t("systemHealth.subtitle")}
          icon={<Activity className="h-5 w-5" />}
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    );
  }

  // ── Error state ─────────────────────────────────────────────────────────
  if (error && !data) {
    return (
      <div className="space-y-4">
        <SectionHeader
          title={t("systemHealth.title")}
          description={t("systemHealth.subtitle")}
          icon={<Activity className="h-5 w-5" />}
        />
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("systemHealth.fetchError")}</AlertTitle>
          <AlertDescription dir="ltr">{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("systemHealth.title")}
        description={t("systemHealth.subtitle")}
        icon={<Activity className="h-5 w-5" />}
        tone="primary"
        actions={
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5" dir="ltr">
              <Clock className="h-3.5 w-3.5" />
              <span dir={dir === "rtl" ? "rtl" : undefined}>
                {t("systemHealth.lastRefresh")}:
              </span>{" "}
              <span className="font-mono">
                {lastRefresh
                  ? fmtTime(new Date(lastRefresh).toISOString(), numLang)
                  : "—"}
              </span>
            </span>
            <span className="hidden items-center gap-1.5 sm:flex" dir="ltr">
              <RefreshCw className="h-3.5 w-3.5" />
              <span dir={dir === "rtl" ? "rtl" : undefined}>
                {t("systemHealth.nextRefresh")}:
              </span>{" "}
              <span className="font-mono tabular-nums">
                {formatNumber(countdown, numLang)}
                {t("systemHealth.seconds")}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={manualRefresh}
              disabled={refreshing}
              className="h-8 gap-1.5"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              <span className="hidden sm:inline">
                {refreshing ? t("systemHealth.refreshing") : t("systemHealth.refreshNow")}
              </span>
            </Button>
          </div>
        }
      />

      {/* ── KPI strip ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {/* Uptime */}
        <KpiCard
          label={t("systemHealth.uptime")}
          value={<span dir="ltr">{uptimeStr}</span>}
          icon={
            <span className="relative flex h-4 w-4 items-center justify-center">
              {uptimeHealthy && (
                <span className="absolute inline-flex h-3 w-3 animate-ping rounded-full bg-emerald-500/60" />
              )}
              <Clock className="h-4 w-4" />
            </span>
          }
          tone="good"
          hint={
            data?.timestamp
              ? `${t("systemHealth.lastRefresh")}: ${fmtTime(data.timestamp, numLang)}`
              : undefined
          }
        />

        {/* Avg API Response */}
        <KpiCard
          label={t("systemHealth.avgResponse")}
          value={`${formatNumber(avgResponse, numLang)}ms`}
          icon={<Zap className="h-4 w-4" />}
          tone={avgResponse < 100 ? "good" : avgResponse < 300 ? "warn" : "danger"}
          hint={
            <span className="inline-flex items-center gap-1">
              {avgTrend > 0 ? (
                <>
                  <ArrowUp className="h-3 w-3 text-rose-500" />
                  <span className="text-rose-500">{formatNumber(Math.abs(avgTrend), numLang)}%</span>
                </>
              ) : avgTrend < 0 ? (
                <>
                  <ArrowDown className="h-3 w-3 text-emerald-500" />
                  <span className="text-emerald-500">{formatNumber(Math.abs(avgTrend), numLang)}%</span>
                </>
              ) : (
                <>
                  <Minus className="h-3 w-3 text-muted-foreground" />
                  <span>0%</span>
                </>
              )}
            </span>
          }
        />

        {/* Active Sessions (24h) */}
        <KpiCard
          label={t("systemHealth.activeSessions")}
          value={formatNumber(activeSessions, numLang)}
          icon={<Users className="h-4 w-4" />}
          tone="info"
          hint={t("systemHealth.activeSessionsHint")}
        />

        {/* Error Count (last 1h) */}
        <KpiCard
          label={t("systemHealth.errorCount")}
          value={formatNumber(errorsLastHour, numLang)}
          icon={
            <span className="relative flex h-4 w-4 items-center justify-center">
              {errorTone === "danger" && (
                <span className="absolute inline-flex h-3 w-3 animate-ping rounded-full bg-rose-500/60" />
              )}
              <AlertCircle className="h-4 w-4" />
            </span>
          }
          tone={errorTone}
          hint={t("systemHealth.lastHour")}
        />
      </div>

      {/* ── Realtime + Memory cards (2-col on lg) ──────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Realtime status */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <div
                  className={cn(
                    "rounded-lg p-2.5 ring-1 ring-inset ring-border/50",
                    data?.realtime.connected
                      ? "bg-emerald-500/10 text-emerald-500 dark:text-emerald-400"
                      : "bg-rose-500/10 text-rose-500 dark:text-rose-400",
                  )}
                >
                  {data?.realtime.connected ? (
                    <Wifi className="h-5 w-5" />
                  ) : (
                    <WifiOff className="h-5 w-5" />
                  )}
                </div>
                <div>
                  <CardTitle className="text-sm">
                    {t("systemHealth.realtime")}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {t("systemHealth.realtimeSubtitle")}
                  </CardDescription>
                </div>
              </div>
              {/* Live pulsing indicator */}
              <div className="flex items-center gap-2">
                {data?.realtime.connected ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-emerald-500/60" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                    </span>
                    {t("systemHealth.connected")}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-600 dark:text-rose-400">
                    <span className="relative flex h-2 w-2">
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
                    </span>
                    {t("systemHealth.disconnected")}
                  </span>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 pt-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("systemHealth.clients")}
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {formatNumber(data?.realtime.clients ?? 0, numLang)}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("systemHealth.websocketUrl")}
              </p>
              <p className="mt-1 font-mono text-xs leading-tight break-all" dir="ltr">
                {data?.realtime.url ?? "—"}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Memory usage */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2.5">
              <div className="rounded-lg bg-sky-500/10 p-2.5 text-sky-500 ring-1 ring-inset ring-border/50 dark:text-sky-400">
                <Cpu className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-sm">
                  {t("systemHealth.memory")}
                </CardTitle>
                <CardDescription className="text-xs">
                  {t("systemHealth.memorySubtitle")}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 pt-2">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium">{t("systemHealth.heapUsage")}</span>
                <span className="font-mono tabular-nums">
                  {formatNumber(heapPct, numLang)}%
                </span>
              </div>
              <Progress
                value={heapPct}
                className={cn(
                  "h-2",
                  heapPct > 85
                    ? "[&_[data-slot=progress-indicator]]:bg-rose-500"
                    : heapPct > 60
                      ? "[&_[data-slot=progress-indicator]]:bg-amber-500"
                      : "[&_[data-slot=progress-indicator]]:bg-emerald-500",
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <MemoryRow
                label={t("systemHealth.rss")}
                hint={t("systemHealth.rssHint")}
                value={data?.memory.rss}
                unit="MB"
                numLang={numLang}
              />
              <MemoryRow
                label={t("systemHealth.heapUsed")}
                value={data?.memory.heapUsed}
                unit="MB"
                numLang={numLang}
              />
              <MemoryRow
                label={t("systemHealth.heapTotal")}
                value={data?.memory.heapTotal}
                unit="MB"
                numLang={numLang}
              />
              <MemoryRow
                label={t("systemHealth.external")}
                value={data?.memory.external}
                unit="MB"
                numLang={numLang}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Database card (full width) ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg bg-violet-500/10 p-2.5 text-violet-500 ring-1 ring-inset ring-border/50 dark:text-violet-400">
              <Database className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-sm">{t("systemHealth.database")}</CardTitle>
              <CardDescription className="text-xs">
                {t("systemHealth.databaseSubtitle")}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <DbMeta
              label={t("systemHealth.dbType")}
              value={data?.database.type ?? "sqlite"}
              mono
            />
            <DbMeta
              label={t("systemHealth.dbSize")}
              value={
                data
                  ? `${formatNumber(data.database.sizeMB, numLang)} MB`
                  : "—"
              }
            />
            <DbMeta
              label={t("systemHealth.path")}
              value={data?.database.path ?? "—"}
              mono
              truncate
            />
          </div>

          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("systemHealth.tableCounts")}
            </p>
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead className="text-xs">{t("systemHealth.sites")}</TableHead>
                    <TableHead className="text-xs">{t("systemHealth.alarms")}</TableHead>
                    <TableHead className="text-xs">{t("systemHealth.sensorReadings")}</TableHead>
                    <TableHead className="text-xs">{t("systemHealth.users")}</TableHead>
                    <TableHead className="text-xs">{t("systemHealth.auditLogs")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-mono font-semibold tabular-nums">
                      {formatNumber(data?.database.tableCounts.sites ?? 0, numLang)}
                    </TableCell>
                    <TableCell className="font-mono font-semibold tabular-nums">
                      {formatNumber(data?.database.tableCounts.alarms ?? 0, numLang)}
                    </TableCell>
                    <TableCell className="font-mono font-semibold tabular-nums">
                      {formatNumber(data?.database.tableCounts.sensorReadings ?? 0, numLang)}
                    </TableCell>
                    <TableCell className="font-mono font-semibold tabular-nums">
                      {formatNumber(data?.database.tableCounts.users ?? 0, numLang)}
                    </TableCell>
                    <TableCell className="font-mono font-semibold tabular-nums">
                      {formatNumber(data?.database.tableCounts.auditLogs ?? 0, numLang)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Recent errors table ───────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg bg-rose-500/10 p-2.5 text-rose-500 ring-1 ring-inset ring-border/50 dark:text-rose-400">
              <AlertCircle className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-sm">
                {t("systemHealth.recentErrors")}
              </CardTitle>
              <CardDescription className="text-xs">
                {t("systemHealth.recentErrorsSubtitle")}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          {!data?.errors || data.errors.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <div className="rounded-full bg-emerald-500/10 p-3 text-emerald-500">
                <AlertCircle className="h-6 w-6" />
              </div>
              <p className="text-sm font-medium">{t("systemHealth.noErrors")}</p>
              <p className="max-w-md text-xs text-muted-foreground">
                {t("systemHealth.noErrorsRecorded")}
              </p>
            </div>
          ) : (
            <div className="health-errors-scroll max-h-96 overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead className="text-xs whitespace-nowrap">
                      {t("systemHealth.timestamp")}
                    </TableHead>
                    <TableHead className="text-xs w-[80px]">
                      {t("systemHealth.method")}
                    </TableHead>
                    <TableHead className="text-xs">{t("systemHealth.path")}</TableHead>
                    <TableHead className="text-xs w-[70px]">
                      {t("systemHealth.status")}
                    </TableHead>
                    <TableHead className="text-xs">
                      {t("systemHealth.message")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.errors.map((e, i) => (
                    <TableRow key={`${e.timestamp}-${i}-${e.path}`}>
                      <TableCell className="text-[11px] text-muted-foreground whitespace-nowrap font-mono" dir="ltr">
                        {fmtDateTimeLocal(e.timestamp, numLang)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Badge variant="outline" className="text-[10px] font-mono">
                          {e.method}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-[11px] max-w-[220px] truncate" dir="ltr" title={e.path}>
                        {e.path}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={e.status} numLang={numLang} />
                      </TableCell>
                      <TableCell className="text-[11px] text-muted-foreground max-w-[280px] truncate" title={e.message}>
                        {e.message}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Small presentational helpers
 * ──────────────────────────────────────────────────────────────────────── */

function MemoryRow({
  label,
  hint,
  value,
  unit,
  numLang,
}: {
  label: string;
  hint?: string;
  value: number | undefined;
  unit: string;
  numLang: Language;
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-mono text-sm font-semibold tabular-nums" dir="ltr">
        {value !== undefined ? formatNumber(value, numLang) : "—"}
        <span className="ml-1 text-[10px] font-normal text-muted-foreground">{unit}</span>
      </p>
      {hint && (
        <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function DbMeta({
  label,
  value,
  mono = false,
  truncate = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-sm font-medium",
          mono && "font-mono",
          truncate && "truncate",
        )}
        dir="ltr"
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function StatusBadge({ status, numLang }: { status: number; numLang: Language }) {
  const tone =
    status >= 500
      ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400"
      : status >= 400
        ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  return (
    <Badge variant="outline" className={cn("text-[10px] font-mono tabular-nums", tone)}>
      {formatNumber(status, numLang)}
    </Badge>
  );
}
