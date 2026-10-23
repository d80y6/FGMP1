"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Terminal,
  Power,
  RotateCcw,
  AlertOctagon,
  CheckCircle2,
  Clock,
  User,
  Activity,
  Filter,
  Zap,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo, fmtDateTime } from "@/lib/fgmp/format";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { commandTypeLabel } from "@/lib/fgmp/labels";


/**
 * Command shape — accepts both the spec'd canonical form
 * (status: COMPLETED|PENDING|FAILED|IN_PROGRESS, completedAt, issuedBy.name)
 * and the raw DB/API form (status: SENT, executedAt, result, issuedById).
 * The normalizeCommand() helper below reconciles the two.
 */
export interface CommandHistoryItem {
  id: string;
  command: string;
  status: string;
  issuedAt: string;
  completedAt?: string;
  executedAt?: string;
  result?: string;
  reason?: string;
  issuedById?: string;
  issuedBy?: { name?: string } | null;
  generator?: { label?: string; site?: { name?: string } } | null;
}

interface Props {
  commands: CommandHistoryItem[];
}

/** Canonical command statuses used by the panel UI. */
type UiStatus = "COMPLETED" | "PENDING" | "FAILED" | "IN_PROGRESS";

/** Normalize a raw command record into the canonical shape used by the UI. */
function normalizeCommand(c: CommandHistoryItem) {
  let status: UiStatus;
  const raw = (c.status ?? "").toUpperCase();
  if (raw === "COMPLETED" || raw === "FAILED" || raw === "PENDING" || raw === "IN_PROGRESS") {
    status = raw;
  } else if (raw === "SENT") {
    // DB-default flow: SENT means command was dispatched; result indicates success/failure.
    const result = (c.result ?? "").toUpperCase();
    if (result.includes("FAIL") || result.includes("ERROR") || result === "REJECTED") {
      status = "FAILED";
    } else {
      status = "COMPLETED"; // OK or empty result → considered completed
    }
  } else if (raw === "EXECUTING" || raw === "RUNNING") {
    status = "IN_PROGRESS";
  } else if (raw === "" ) {
    status = "PENDING";
  } else {
    // Unknown status — fall back to PENDING for safety
    status = "PENDING";
  }

  const completedAt = c.completedAt ?? c.executedAt;
  const issuedByName = c.issuedBy?.name ?? null;
  const issuer = issuedByName ?? (c.issuedById ? c.issuedById.replace(/^u-/, "").replace(/-/g, " ") : null);
  const generatorLabel = c.generator?.label ?? null;
  const siteName = c.generator?.site?.name ?? null;

  return { ...c, uiStatus: status, completedAt, issuer, generatorLabel, siteName };
}

type CommandType = "START" | "STOP" | "RESET" | "EMERGENCY_STOP" | "SYNC";

const COMMAND_TYPES: CommandType[] = ["START", "STOP", "RESET", "EMERGENCY_STOP", "SYNC"];

/** Pretty label: "EMERGENCY_STOP" → translated via i18n ("Emergency Stop"/"إيقاف طارئ"). */
function prettyCommand(cmd: string, lang: Language): string {
  return commandTypeLabel(cmd, lang);
}

/** Icon for a given command type. */
function CommandIcon({ cmd, className }: { cmd: string; className?: string }) {
  const upper = cmd.toUpperCase();
  if (upper === "RESET") return <RotateCcw className={className} />;
  if (upper === "EMERGENCY_STOP") return <AlertOctagon className={className} />;
  if (upper === "SYNC") return <Activity className={className} />;
  // START + STOP both use Power (per spec); color via className from caller.
  return <Power className={className} />;
}

/** Per-command-type accent color classes (icon + bar). */
const COMMAND_COLORS: Record<string, { icon: string; bar: string }> = {
  START: { icon: "text-emerald-500", bar: "bg-emerald-500" },
  STOP: { icon: "text-amber-500", bar: "bg-amber-500" },
  RESET: { icon: "text-sky-500", bar: "bg-sky-500" },
  EMERGENCY_STOP: { icon: "text-rose-500", bar: "bg-rose-500" },
  SYNC: { icon: "text-violet-500", bar: "bg-violet-500" },
};

/** Status badge classes — color-coded per spec. */
const STATUS_BADGE: Record<UiStatus, string> = {
  COMPLETED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  PENDING: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  FAILED: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
  IN_PROGRESS: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
};

/** Human-readable duration between two ISO timestamps. */
function durationLabel(startIso?: string, endIso?: string): string | null {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function CommandHistoryPanel({ commands }: Props) {
  const [activeFilter, setActiveFilter] = useState<"ALL" | CommandType>("ALL");
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";

  // Normalize once.
  const items = useMemo(() => (commands ?? []).map(normalizeCommand), [commands]);
  // Header stats
  const stats = useMemo(() => {
    const total = items.length;
    const completed = items.filter((c) => c.uiStatus === "COMPLETED").length;
    const pending = items.filter((c) => c.uiStatus === "PENDING").length;
    const failed = items.filter((c) => c.uiStatus === "FAILED").length;
    const inProgress = items.filter((c) => c.uiStatus === "IN_PROGRESS").length;
    const successRate = completed + failed > 0 ? Math.round((completed / (completed + failed)) * 100) : total > 0 ? 100 : 0;

    // Avg duration for COMPLETED entries only
    const durations: number[] = [];
    for (const c of items) {
      if (c.uiStatus !== "COMPLETED" || !c.completedAt || !c.issuedAt) continue;
      const start = new Date(c.issuedAt).getTime();
      const end = new Date(c.completedAt).getTime();
      if (Number.isNaN(start) || Number.isNaN(end) || end < start) continue;
      durations.push(end - start);
    }
    const avgMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const avgLabel = durations.length ? durationLabel(new Date(0).toISOString(), new Date(avgMs).toISOString()) : "—";

    return { total, completed, pending, failed, inProgress, successRate, avgLabel };
  }, [items]);

  // Filtered list
  const visible = useMemo(() => {
    if (activeFilter === "ALL") return items;
    return items.filter((c) => (c.command ?? "").toUpperCase() === activeFilter);
  }, [items, activeFilter]);

  // Bar chart counts (last 50 commands)
  const barData = useMemo(() => {
    const slice = items.slice(0, 50);
    const counts: Record<string, number> = { START: 0, STOP: 0, RESET: 0, EMERGENCY_STOP: 0, SYNC: 0 };
    for (const c of slice) {
      const key = (c.command ?? "").toUpperCase();
      if (key in counts) counts[key] += 1;
    }
    const max = Math.max(1, ...Object.values(counts));
    return COMMAND_TYPES.map((t) => ({ type: t, count: counts[t], pct: (counts[t] / max) * 100 }));
  }, [items]);

  return (
    <Card className="rounded-xl border bg-card/50 backdrop-blur">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 ring-1 ring-inset ring-sky-500/20">
            <Terminal className="h-4 w-4" />
          </div>
          <div>
            <CardTitle className="text-sm">{t("cmdHistory.title")}</CardTitle>
            <p className="text-[10px] text-muted-foreground">{t("cmdHistory.subtitle")}</p>
          </div>
        </div>
        <Badge variant="outline" className="h-5 px-1.5 text-[9px] tabular-nums">{formatNumber(stats.total, numLang)} {t("cmdHistory.total").toLowerCase()}</Badge>
      </CardHeader>

      <CardContent className="space-y-3">
        {items.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {/* Header stats row */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <StatTile icon={<Activity className="h-3 w-3" />} label={t("cmdHistory.total")} value={formatNumber(stats.total, numLang)} />
              <StatTile icon={<CheckCircle2 className="h-3 w-3 text-emerald-500" />} label={t("cmdHistory.success")} value={`${formatNumber(stats.successRate, numLang)}%`} />
              <StatTile icon={<Clock className="h-3 w-3 text-amber-500" />} label={t("cmdHistory.pending")} value={formatNumber(stats.pending, numLang)} pulse={stats.pending > 0} />
              <StatTile icon={<AlertTriangle className="h-3 w-3 text-rose-500" />} label={t("cmdHistory.failed")} value={formatNumber(stats.failed, numLang)} tone={stats.failed ? "danger" : undefined} />
              <StatTile icon={<Zap className="h-3 w-3 text-sky-500" />} label={t("cmdHistory.avgDur")} value={stats.avgLabel ?? "—"} />
            </div>

            {/* Filter chips */}
            <div className="flex flex-wrap items-center gap-1.5">
              <Filter className="mr-0.5 h-3 w-3 text-muted-foreground" />
              <FilterChip label={t("cmdHistory.all")} active={activeFilter === "ALL"} onClick={() => setActiveFilter("ALL")} count={items.length} />
              {COMMAND_TYPES.map((tp) => {
                const count = items.filter((c) => (c.command ?? "").toUpperCase() === tp).length;
                if (count === 0) return null; // hide chips with no data to reduce clutter
                return (
                  <FilterChip
                    key={tp}
                    label={prettyCommand(tp, numLang)}
                    active={activeFilter === tp}
                    onClick={() => setActiveFilter(tp)}
                    count={count}
                  />
                );
              })}
            </div>

            {/* Timeline list */}
            <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
              {visible.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">{t("cmdHistory.noMatch")}</p>
              ) : (
                visible.map((c) => {
                  const cmdUpper = (c.command ?? "").toUpperCase();
                  const color = COMMAND_COLORS[cmdUpper] ?? { icon: "text-muted-foreground", bar: "bg-muted-foreground" };
                  const isFailed = c.uiStatus === "FAILED";
                  const isCompleted = c.uiStatus === "COMPLETED";
                  const isPending = c.uiStatus === "PENDING";
                  const dur = isCompleted ? durationLabel(c.issuedAt, c.completedAt) : null;
                  const siteName = c.siteName;
                  const genLabel = c.generatorLabel ?? t("cmdHistory.unknownGenerator");
                  const issuer = c.issuer;

                  return (
                    <div
                      key={c.id}
                      title={`${t("cmdHistory.issuedAt")} ${fmtDateTime(c.issuedAt, numLang)}${c.completedAt ? ` · ${t("cmdHistory.completedAt")} ${fmtDateTime(c.completedAt, numLang)}` : ""}`}
                      className={cn(
                        "rounded-lg border bg-card px-3 py-2 transition-colors hover:bg-muted/30",
                        isFailed && "bg-rose-500/[0.04] border-rose-500/20",
                        isCompleted && "bg-emerald-500/[0.03] border-emerald-500/15",
                      )}
                    >
                      <div className="flex items-start gap-2">
                        {/* Icon */}
                        <div className={cn("mt-0.5 shrink-0", color.icon, isPending && "animate-pulse-soft")}>
                          <CommandIcon cmd={cmdUpper} className="h-3.5 w-3.5" />
                        </div>

                        {/* Main body */}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span className="text-xs font-semibold">{prettyCommand(cmdUpper, numLang)}</span>
                            {genLabel && <span className="text-[10px] text-muted-foreground">· {genLabel}</span>}
                            {siteName && <span className="truncate text-[10px] text-muted-foreground">· {siteName}</span>}
                            {isFailed && (
                              <span className="inline-flex items-center gap-0.5 text-[9px] font-medium text-rose-600 dark:text-rose-400">
                                <AlertTriangle className="h-2.5 w-2.5" /> {t("cmdHistory.failed")}
                              </span>
                            )}
                          </div>

                          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-muted-foreground">
                            <span className="inline-flex items-center gap-0.5">
                              <User className="h-2.5 w-2.5" />
                              {issuer ?? t("cmdHistory.system")}
                            </span>
                            <span className="inline-flex items-center gap-0.5">
                              <Clock className="h-2.5 w-2.5" />
                              {timeAgo(c.issuedAt, numLang)}
                            </span>
                            {dur && (
                              <span className="inline-flex items-center gap-0.5 tabular-nums">
                                <Activity className="h-2.5 w-2.5" /> {dur}
                              </span>
                            )}
                            {c.reason && <span className="truncate italic text-rose-500/80">“{c.reason}”</span>}
                          </div>
                        </div>

                        {/* Status badge */}
                        <Badge
                          variant="outline"
                          className={cn(
                            "h-4 shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                            STATUS_BADGE[c.uiStatus],
                            isPending && "animate-pulse-soft",
                          )}
                        >
                          {t(`cmdHistory.${c.uiStatus}`) !== `cmdHistory.${c.uiStatus}` ? t(`cmdHistory.${c.uiStatus}`) : c.uiStatus.replace("_", " ")}
                        </Badge>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Mini bar chart */}
            <div className="rounded-lg border bg-muted/20 p-2.5">
              <p className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                <Activity className="h-3 w-3" /> {t("cmdHistory.commandMix")}
              </p>
              <div className="space-y-1">
                {barData.map((b) => (
                  <div key={b.type} className="flex items-center gap-2">
                    <span className="w-24 shrink-0 truncate text-[10px] text-muted-foreground">{prettyCommand(b.type, numLang)}</span>
                    <div className="relative h-3 flex-1 overflow-hidden rounded bg-muted/40">
                      <div
                        className={cn("h-3 rounded-r-md transition-all", COMMAND_COLORS[b.type].bar)}
                        style={{ width: `${b.pct}%` }}
                      />
                    </div>
                    <span className="w-6 shrink-0 text-right text-[10px] font-semibold tabular-nums">{formatNumber(b.count, numLang)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------- Sub-components ---------- */

function StatTile({
  icon,
  label,
  value,
  tone,
  pulse,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: "danger";
  pulse?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {icon}
        <span className="uppercase tracking-wide">{label}</span>
      </div>
      <div
        className={cn(
          "mt-0.5 text-base font-bold tabular-nums",
          tone === "danger" && "text-rose-600 dark:text-rose-400",
          pulse && "animate-pulse-soft",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  count,
  onClick,
}: {
  label: string;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={onClick}
      className={cn(
        "h-6 rounded-full border px-2.5 py-1 text-[11px] font-medium tabular-nums",
        active
          ? "border-sky-500/40 bg-sky-500/15 text-sky-600 hover:bg-sky-500/20 hover:text-sky-700"
          : "border-border bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      )}
    >
      {label}
      <span className={cn("ml-1 rounded-full px-1 text-[9px]", active ? "bg-sky-500/20" : "bg-muted/60")}>{count}</span>
    </Button>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/40 text-muted-foreground">
        <Terminal className="h-6 w-6" />
      </div>
      <div>
        <p className="text-sm font-medium">{t("cmdHistory.noCommands")}</p>
        <p className="text-[11px] text-muted-foreground">{t("cmdHistory.noCommandsHint")}</p>
      </div>
    </div>
  );
}
