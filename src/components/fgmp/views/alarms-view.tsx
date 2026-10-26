"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Siren, CheckCircle2, AlertOctagon, ShieldCheck, Bell, CheckCheck, X, Keyboard, ShieldAlert, Loader2 } from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { hasCapability } from "@/lib/fgmp/rbac-core";
import { useApi, apiPost } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { AlarmCorrelationPanel } from "@/components/fgmp/alarm-correlation-panel";
import { AlarmSeverityHeatmap, getHourBucket } from "@/components/fgmp/alarm-severity-heatmap";
import { StatusBadge, severityDot } from "@/components/fgmp/status-badge";
import { CorrelationRulesEditor } from "@/components/fgmp/correlation-rules-editor";
import { SuppressionsView } from "@/components/fgmp/views/suppressions-view";
import { AlarmsListSkeleton } from "@/components/fgmp/skeletons";
import { EmptyState } from "@/components/fgmp/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FilterTabs, FilterTab } from "@/components/fgmp/filter-tabs";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { timeAgo, fmtDateTime } from "@/lib/fgmp/format";
import { csvFilename, type CsvColumn } from "@/lib/fgmp/csv-export";
import { ExportButton } from "@/components/fgmp/export-button";
import { useCorrelationRulesHydration } from "@/lib/fgmp/use-correlation-rules-server";
import { useCorrelationMatches } from "@/lib/fgmp/use-correlation-matches";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import type { AlarmRow } from "@/lib/fgmp/types";
import { alarmTypeLabel } from "@/lib/fgmp/labels";
import { useNow } from "@/lib/fgmp/use-now";
import { ResourceError } from "@/components/fgmp/resource-error";

const TYPES = ["FUEL_THEFT", "FUEL_REFILL", "FUEL_LOW", "FUEL_CRITICAL", "GEN_OFFLINE", "GEN_FAILURE", "GEN_OVERHEAT", "BATT_LOW_VOLTAGE", "BATT_FAILURE", "COMM_LOSS"];


const ACTIONABLE_STATUSES = new Set(["OPEN", "ACKNOWLEDGED", "ESCALATED"]);

export function AlarmsView() {
  const now = useNow();
  // Subscribe to individual slices: a bare `useFgmp()` re-renders this
  // component on EVERY store write (search keystrokes, view changes,
  // lastTickAt, …) instead of only the slices actually read.
  const snapshot = useFgmp((s) => s.snapshot);
  const tick = useFgmp((s) => s.tick);
  const selectSite = useFgmp((s) => s.selectSite);
  const setView = useFgmp((s) => s.setView);
  const view = useFgmp((s) => s.view);
  const me = useFgmp((s) => s.me);
  const role = me?.role ?? "READONLY";
  const canManageRules = hasCapability(role, "alarm:configure");
  const canViewSuppressions = hasCapability(role, "view:suppressions");
  // Acknowledge and resolve are separate capabilities (POST/PATCH
  // /api/fgmp/alarms accepts either). Both are checked so a READONLY or
  // EXECUTIVE viewer is not shown a button whose only outcome is a 403.
  const canAcknowledge = hasCapability(role, "alarm:ack");
  const canResolve = hasCapability(role, "alarm:resolve");
  const canAct = canAcknowledge || canResolve;

  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const [status, setStatus] = useState("OPEN,ACKNOWLEDGED,ESCALATED");
  const [severity, setSeverity] = useState("all");
  const [type, setType] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [heatmapFilter, setHeatmapFilter] = useState<{ hour: number; severity: string } | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"alarms" | "suppressions">("alarms");
  // Only load the rules API for roles allowed to author correlation rules.
  // The Rules button and its data request share the same capability.
  useCorrelationRulesHydration(canManageRules);
  const { data: alarms, loading: alarmsLoading, error: alarmsError, refetch } = useApi<AlarmRow[]>(`/api/fgmp/alarms?status=${status}&severity=${severity === "all" ? "" : severity}&type=${type === "all" ? "" : type}&limit=300`, { interval: 6000 });

  // ── Optimistic updates (#20) ──────────────────────────────────────────────
  // Local overlay patches applied on top of the polled alarm list so ack/resolve
  // actions reflect instantly. `savingIds` tracks which rows are mid-flight
  // (drives the subtle opacity-50 + spinner saving indicator). Both are
  // reconciled with the polled data via the derived `mergedAlarms` below —
  // once the server returns the new status, the patch is auto-evicted and the
  // row returns to full opacity. On error the patch is rolled back.
  const [optimisticPatches, setOptimisticPatches] = useState<Record<string, Partial<AlarmRow>>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());

  // Active patches = patches that haven't yet been absorbed by the polled data.
  // Stale entries (polled status already matches) are dropped from the derived
  // map without needing setState-in-effect (compliant with
  // react-hooks/set-state-in-effect).
  const activePatches = useMemo(() => {
    const list = alarms ?? [];
    const polled = new Map<string, AlarmRow>();
    for (const a of list) polled.set(a.id, a);
    const out: Record<string, Partial<AlarmRow>> = {};
    for (const [id, p] of Object.entries(optimisticPatches)) {
      const server = polled.get(id);
      if (!server) continue; // alarm rolled out of view — drop patch
      if (p.status && server.status === p.status) continue; // polled caught up
      out[id] = p;
    }
    return out;
  }, [alarms, optimisticPatches]);

  // Polled alarms with active optimistic patches merged on top. All downstream
  // memos + render read from this list so the UI updates instantly on click.
  const mergedAlarms = useMemo(() => {
    const list = alarms ?? [];
    if (Object.keys(activePatches).length === 0) return list;
    return list.map((a) => (activePatches[a.id] ? { ...a, ...activePatches[a.id] } : a));
  }, [alarms, activePatches]);

  const typeCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of mergedAlarms ?? []) m[a.type] = (m[a.type] ?? 0) + 1;
    return m;
  }, [mergedAlarms]);

  // Actionable alarms in the current view (eligible for bulk ack/resolve)
  const actionableIds = useMemo(
    () => (mergedAlarms ?? []).filter((a) => ACTIONABLE_STATUSES.has(a.status)).map((a) => a.id),
    [mergedAlarms]
  );

  // Prune selected IDs to those still visible — auto-resolved alarms drop out of the set automatically
  const validSelectedIds = useMemo(() => {
    const visible = new Set((mergedAlarms ?? []).map((a) => a.id));
    const s = new Set<string>();
    for (const id of selectedIds) if (visible.has(id)) s.add(id);
    return s;
  }, [selectedIds, mergedAlarms]);

  // When the heatmap filter is active, narrow the alarm list to those matching the
  // selected hour-bucket + severity. Uses the same bucketing as the heatmap so the
  // counts line up exactly.
  const filteredAlarms = useMemo(() => {
    const all = mergedAlarms ?? [];
    if (!heatmapFilter) return all;
    return all.filter((a) => {
      if (a.severity !== heatmapFilter.severity) return false;
      return getHourBucket(a.createdAt, now) === heatmapFilter.hour;
    });
  }, [mergedAlarms, heatmapFilter, now]);

  // Hour label for the current heatmap filter bucket (e.g. "14:00"). Mirrors the
  // heatmap's labeling so the banner shows the same HH:00 string the user clicked.
  const heatmapFilterLabel = useMemo(() => {
    if (!heatmapFilter) return "";
    const bucketMs = now - (23 - heatmapFilter.hour) * 3600_000;
    const hh = String(new Date(bucketMs).getHours()).padStart(2, "0");
    return `${hh}:00`;
  }, [heatmapFilter, now]);

  const selectedCount = validSelectedIds.size;
  const allSelected = actionableIds.length > 0 && actionableIds.every((id) => validSelectedIds.has(id));
  const someSelected = selectedCount > 0 && !allSelected;

  // ── Optimistic ack/resolve (#20) ──────────────────────────────────────────
  // Apply patch → fetch → on success keep patch (auto-evicted by mergedAlarms
  // when polled data catches up) → on error roll back + toast.
  const ack = async (id: string) => {
    const meId = me?.id ?? null;
    const now = new Date().toISOString();
    const patch = { status: "ACKNOWLEDGED", acknowledgedAt: now, acknowledgedById: meId };
    setOptimisticPatches((prev) => ({ ...prev, [id]: patch }));
    setSavingIds((prev) => new Set(prev).add(id));
    const res = await apiPost("/api/fgmp/alarms", { action: "acknowledge", alarmId: id });
    setSavingIds((prev) => {
      const n = new Set(prev); n.delete(id); return n;
    });
    if (res.ok) {
      toast.success(t("common.acknowledgeSuccess"));
      refetch();
      tick(10);
    } else {
      // Rollback the optimistic patch
      setOptimisticPatches((prev) => {
        const n = { ...prev }; delete n[id]; return n;
      });
      toast.error(t("common.optimisticError"), { description: res.error });
    }
  };
  const resolve = async (id: string) => {
    const meId = me?.id ?? null;
    const now = new Date().toISOString();
    const patch = { status: "RESOLVED", resolvedAt: now, resolvedById: meId };
    setOptimisticPatches((prev) => ({ ...prev, [id]: patch }));
    setSavingIds((prev) => new Set(prev).add(id));
    const res = await apiPost("/api/fgmp/alarms", { action: "resolve", alarmId: id, resolution: t("alarms.resolvedByOperator") });
    setSavingIds((prev) => {
      const n = new Set(prev); n.delete(id); return n;
    });
    if (res.ok) {
      toast.success(t("common.resolveSuccess"));
      refetch();
      tick(10);
    } else {
      setOptimisticPatches((prev) => {
        const n = { ...prev }; delete n[id]; return n;
      });
      toast.error(t("common.optimisticError"), { description: res.error });
    }
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (actionableIds.length > 0 && actionableIds.every((id) => next.has(id))) {
        for (const id of actionableIds) next.delete(id);
      } else {
        for (const id of actionableIds) next.add(id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const bulkAck = async () => {
    const ids = Array.from(validSelectedIds);
    if (ids.length === 0) return;
    const meId = me?.id ?? null;
    const now = new Date().toISOString();
    const patch = { status: "ACKNOWLEDGED", acknowledgedAt: now, acknowledgedById: meId };
    // Snapshot for rollback
    const prevPatches = { ...optimisticPatches };
    setOptimisticPatches((prev) => {
      const n = { ...prev };
      for (const id of ids) n[id] = patch;
      return n;
    });
    setSavingIds((prev) => {
      const n = new Set(prev);
      for (const id of ids) n.add(id);
      return n;
    });
    const res = await apiPost("/api/fgmp/alarms", { action: "bulkAcknowledge", alarmIds: ids });
    setSavingIds((prev) => {
      const n = new Set(prev);
      for (const id of ids) n.delete(id);
      return n;
    });
    if (res.ok) {
      const count = (res.data as { count?: number } | undefined)?.count ?? ids.length;
      toast.success(`${formatNumber(count, numLang)} ${t("alarms.bulkAckToast")}`);
      clearSelection();
      refetch();
      tick(10);
    } else {
      // Rollback all bulk-applied patches
      setOptimisticPatches(prevPatches);
      toast.error(t("common.optimisticError"), { description: res.error });
    }
  };

  const bulkResolve = async () => {
    const ids = Array.from(validSelectedIds);
    if (ids.length === 0) return;
    const note = window.prompt(t("alarms.resolutionNoteOptional"), t("alarms.bulkResolvedByOperator"));
    if (note === null) return; // user cancelled
    const resolution = note.trim() || t("alarms.bulkResolvedByOperator");
    const meId = me?.id ?? null;
    const now = new Date().toISOString();
    const patch = { status: "RESOLVED", resolvedAt: now, resolvedById: meId, resolution };
    const prevPatches = { ...optimisticPatches };
    setOptimisticPatches((prev) => {
      const n = { ...prev };
      for (const id of ids) n[id] = patch;
      return n;
    });
    setSavingIds((prev) => {
      const n = new Set(prev);
      for (const id of ids) n.add(id);
      return n;
    });
    const res = await apiPost("/api/fgmp/alarms", { action: "bulkResolve", alarmIds: ids, resolution });
    setSavingIds((prev) => {
      const n = new Set(prev);
      for (const id of ids) n.delete(id);
      return n;
    });
    if (res.ok) {
      const count = (res.data as { count?: number } | undefined)?.count ?? ids.length;
      toast.success(`${formatNumber(count, numLang)} ${t("alarms.bulkResolveToast")}`);
      clearSelection();
      refetch();
      tick(10);
    } else {
      setOptimisticPatches(prevPatches);
      toast.error(t("common.optimisticError"), { description: res.error });
    }
  };

  // Export the *currently-filtered* alarm list to a CSV file. Pure client-side
  // via the reusable <ExportButton/> — respects every active filter: status
  // tab, severity, type, AND the heatmap hour/severity filter (when active).
  // The flattened `exportRows` shape mirrors the 9-column CSV header declared
  // inline below so the export always matches what the operator sees on screen.
  const exportRows = useMemo(() => {
    return filteredAlarms.map((a) => ({
      severity: a.severity ?? "",
      type: alarmTypeLabel(a.type ?? "", numLang),
      status: a.status ?? "",
      siteName: a.site?.name ?? "",
      siteCode: a.site?.code ?? "",
      message: a.message ?? "",
      triggeredAt: a.createdAt ? fmtDateTime(a.createdAt, numLang) : "",
      acknowledgedBy: a.acknowledgedById ?? "",
      resolvedAt: a.resolvedAt ? fmtDateTime(a.resolvedAt, numLang) : "",
    }));
  }, [filteredAlarms, numLang]);
  const exportColumns: CsvColumn[] = [
    { key: "severity", label: t("alarms.severity") },
    { key: "type", label: t("alarms.type") },
    { key: "status", label: t("alarms.status") },
    { key: "siteName", label: t("alarms.siteName") },
    { key: "siteCode", label: t("alarms.siteCode") },
    { key: "message", label: t("alarms.message") },
    { key: "triggeredAt", label: t("alarms.created") },
    { key: "acknowledgedBy", label: t("alarms.acknowledgedBy") },
    { key: "resolvedAt", label: t("alarms.resolved") },
  ];

  // Local keyboard shortcuts for the alarms view (single-key, no modifiers).
  // Active only when this view is mounted AND the user is not typing in an
  // input/textarea/select. The global useKeyboardShortcuts hook handles 'G'
  // navigation + ?/L/T; the shortcuts below are view-local so they don't
  // collide with anything else.
  //
  // `bulkAck`/`bulkResolve`/`clearSelection` are plain arrow functions, so they
  // get a new identity on every render and used to sit in the dep array — the
  // window keydown listener was torn down and re-added on every render. Hold
  // them in a ref and read at event time instead; the remaining deps are all
  // stable primitives/derived values, so the listener survives re-renders.
  const actionsRef = useRef({ bulkAck, bulkResolve, clearSelection });
  useEffect(() => {
    actionsRef.current = { bulkAck, bulkResolve, clearSelection };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea/select or using a modifier (besides shift)
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Only fire when alarms view is the current view AND the alarms tab is active
      if (view !== "alarms" || activeTab !== "alarms") return;

      if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        if (validSelectedIds.size > 0) actionsRef.current.bulkAck();
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        if (validSelectedIds.size > 0) actionsRef.current.bulkResolve();
      } else if (e.key === "Escape") {
        if (selectedCount > 0) {
          e.preventDefault();
          actionsRef.current.clearSelection();
        } else if (heatmapFilter) {
          e.preventDefault();
          setHeatmapFilter(null);
        } else if (selected) {
          e.preventDefault();
          setSelected(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, activeTab, validSelectedIds, selectedCount, heatmapFilter, selected]);

  // canManageRules was derived from the same capability used by the API.
  // Triggered-rule count for the Rules button badge.
  //
  // Phase 2: this used to call `evaluateAllRules` in the browser, which meant
  // the badge counted matches the CLIENT would have produced from the alarms
  // it happened to have loaded. It now counts matches the SERVER evaluated and
  // persisted, so the number an operator sees is the number the platform
  // actually acted on. Placed BEFORE the early `if (!snapshot)` return so the
  // hook order is stable on every render.
  const { matches: serverMatches } = useCorrelationMatches(0, canManageRules);
  const triggeredRuleCount = useMemo(() => {
    if (!canManageRules) return 0;
    // Distinct rules that fired, counted from persisted matches.
    return new Set(serverMatches.map((m) => m.ruleId)).size;
  }, [canManageRules, serverMatches]);

  // NOTE: there is deliberately no `const k = snapshot?.kpis` alias here. An
  // alias through optional chaining does not participate in TS's narrowing, so
  // the KPI row (which renders only inside the `!snapshot ? <skeleton/> : …`
  // branch below) could not see that `snapshot` is non-null. Reading
  // `snapshot.kpis` directly in that branch narrows for real.

  // Detail panel is bound to the filtered list — applying a heatmap filter that
  // excludes the currently-selected alarm will close its detail panel.
  const selectedAlarm = filteredAlarms.find((a) => a.id === selected);

  return (
    <div className="space-y-4">
      <ResourceError error={alarmsError} onRetry={refetch} />
      <Tabs
        value={activeTab === "suppressions" && !canViewSuppressions ? "alarms" : activeTab}
        onValueChange={(v) => setActiveTab(v as "alarms" | "suppressions")}
        className="gap-4"
      >
        <TabsList>
          <TabsTrigger value="alarms">{t("alarms.tabAlarms")}</TabsTrigger>
          {canViewSuppressions && (
            <TabsTrigger value="suppressions">{t("alarms.tabSuppressions")}</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="alarms" className="space-y-4 outline-none">
      <SectionHeader
        title={t("nav.alarms")}
        description={t("desc.alarms")}
        icon={<Siren className="h-5 w-5" />}
        actions={
          <>
            {canManageRules && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRulesOpen(true)}
                data-testid="open-correlation-rules"
                title={
                  triggeredRuleCount > 0
                    ? `${formatNumber(triggeredRuleCount, numLang)} ${t("alarms.ruleTriggeredTooltip")}`
                    : t("alarms.openRulesEditor")
                }
                className={cn(
                  triggeredRuleCount > 0 &&
                    "border-rose-500/40 bg-rose-500/5 text-rose-700 dark:text-rose-400 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400",
                )}
              >
                <ShieldAlert className="mr-1.5 h-4 w-4" /> {t("alarms.rules")}
                {triggeredRuleCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="ml-1.5 h-4 bg-rose-500/20 px-1 text-[10px] font-bold text-rose-700 dark:text-rose-400"
                  >
                    {formatNumber(triggeredRuleCount, numLang)}
                  </Badge>
                )}
              </Button>
            )}
            <ExportButton
              filename={csvFilename("alarms")}
              rows={exportRows}
              columns={exportColumns}
              disabled={filteredAlarms.length === 0}
              label={t("common.exportAlarms")}
              onExported={() => toast.success(`${formatNumber(filteredAlarms.length, numLang)} ${t("alarms.exportedToast")}`)}
            />
          </>
        }
      />
      {!snapshot ? (
        <Card>
          <CardContent className="p-0">
            <AlarmsListSkeleton />
          </CardContent>
        </Card>
      ) : (
        <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
        <KpiCard label={t("alarms.openAlarms")} value={formatNumber(snapshot.kpis.openAlarms, numLang)} icon={<Siren className="h-4 w-4" />} tone={snapshot.kpis.openAlarms > 0 ? "danger" : "good"} />
        <KpiCard label={t("sev.l1")} value={formatNumber(snapshot.kpis.alarmsL1, numLang)} icon={<Bell className="h-4 w-4" />} tone="warn" />
        <KpiCard label={t("sev.l2")} value={formatNumber(snapshot.kpis.alarmsL2, numLang)} icon={<AlertOctagon className="h-4 w-4" />} tone="warn" />
        <KpiCard label={t("sev.l3")} value={formatNumber(snapshot.kpis.alarmsL3, numLang)} icon={<AlertOctagon className="h-4 w-4" />} tone="danger" />
        <KpiCard label={t("alarms.escalation")} value="L1→L2→L3" icon={<ShieldCheck className="h-4 w-4" />} tone="info" hint={t("alarms.autoEscalation")} />
      </div>

      {/* Keyboard shortcut helper banner — only visible when alarms are selected */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px] text-sky-700 dark:text-sky-300">
          <Keyboard className="h-3.5 w-3.5" />
          <span className="font-medium">{t("alarms.keyboardActive")}</span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-background px-1.5 py-0.5 font-mono text-[10px]">A</kbd>
            {t("alarms.acknowledge")}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-background px-1.5 py-0.5 font-mono text-[10px]">R</kbd>
            {t("alarms.resolve")}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-background px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd>
            {t("alarms.clearSelection")}
          </span>
        </div>
      )}

      {/* 24h × Severity heatmap (full-width) */}
      <AlarmSeverityHeatmap
        alarms={mergedAlarms ?? []}
        selectedCell={heatmapFilter}
        onCellClick={(cell) =>
          setHeatmapFilter(cell ? { hour: cell.hour, severity: cell.severity } : null)
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        {/* Alarm types heatmap */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("alarms.alarmHeatmap")}</CardTitle></CardHeader>
          <CardContent className="p-3">
            <div className="grid grid-cols-2 gap-1.5">
              {TYPES.map((t) => {
                const c = typeCounts[t] ?? 0;
                const intensity = Math.min(1, c / 8);
                return (
                  <div key={t} className={cn("rounded border p-2 text-[10px] transition-colors", c > 0 ? "cursor-pointer hover:ring-1" : "opacity-50")}
                    style={c > 0 ? { background: `rgba(244,63,94,${0.08 + intensity * 0.4})`, borderColor: `rgba(244,63,94,${0.2 + intensity * 0.5})` } : undefined}
                    onClick={() => setType(type === t ? "all" : t)}
                  >
                    <p className="font-semibold leading-tight">{alarmTypeLabel(t, numLang)}</p>
                    <p className="text-[16px] font-bold tabular-nums">{formatNumber(c, numLang)}</p>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Alarm table */}
        <Card className="xl:col-span-3">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-sm">
                {heatmapFilter
                  ? `${t("alarms.activeAlarmsFiltered")}: ${heatmapFilter.severity} · ${formatNumber(heatmapFilterLabel, numLang)} — ${formatNumber(filteredAlarms.length, numLang)} ${t("alarms.shown")}`
                  : `${t("alarms.activeAlarms")} (${formatNumber(alarms?.length ?? 0, numLang)})`}
              </CardTitle>
              {heatmapFilter && (
                <button
                  type="button"
                  onClick={() => setHeatmapFilter(null)}
                  className="inline-flex items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-700 dark:text-sky-400"
                >
                  <span>
                    {t("alarms.heatmapFilter")}: {heatmapFilter.severity} · {formatNumber(heatmapFilterLabel, numLang)} ({formatNumber(filteredAlarms.length, numLang)})
                  </span>
                  <span className="ml-2 h-5 px-2 text-[10px] hover:bg-sky-500/20 rounded inline-flex items-center">
                    <X className="h-3 w-3" /> {t("alarms.clearFilter")}
                  </span>
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <FilterTabs value={status} onValueChange={setStatus} label={t("alarms.statusFilter")}>
                <FilterTab value="OPEN,ACKNOWLEDGED,ESCALATED">{t("common.active")}</FilterTab>
                <FilterTab value="RESOLVED">{t("common.resolved")}</FilterTab>
                <FilterTab value="OPEN,ACKNOWLEDGED,ESCALATED,RESOLVED">{t("common.all")}</FilterTab>
              </FilterTabs>
              <Select label={t("alarms.severity")} value={severity} onValueChange={setSeverity}>
                <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue placeholder={t("alarms.severity")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("alarms.allSeverity")}</SelectItem>
                  <SelectItem value="L1">L1</SelectItem>
                  <SelectItem value="L2">L2</SelectItem>
                  <SelectItem value="L3">L3</SelectItem>
                </SelectContent>
              </Select>
              <Select label={t("alarms.type")} value={type} onValueChange={setType}>
                <SelectTrigger className="h-8 w-[160px] text-xs"><SelectValue placeholder={t("alarms.type")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("alarms.allTypes")}</SelectItem>
                  {TYPES.map((t) => <SelectItem key={t} value={t}>{alarmTypeLabel(t, numLang)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {/* Bulk Action Bar — appears above the table when alarms are selected */}
            {selectedCount > 0 && (
              <div className="m-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/80 p-2 shadow-sm backdrop-blur">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <CheckCheck className="h-3.5 w-3.5 text-sky-500" />
                  <span>{formatNumber(selectedCount, numLang)} {t("common.selected")}</span>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {canAcknowledge && <Button
                    size="sm"
                    variant="outline"
                    className="h-7 border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400 hover:bg-sky-500/20 hover:text-sky-700"
                    onClick={bulkAck}
                  >
                    <CheckCheck className="mr-1.5 h-3.5 w-3.5" />{t("alarms.bulkAck")}
                    <kbd className="ml-2 hidden items-center rounded border bg-background/80 px-1.5 py-0.5 font-mono text-[10px] sm:inline-flex">A</kbd>
                  </Button>}
                  {canResolve && <Button
                    size="sm"
                    variant="outline"
                    className="h-7 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-700"
                    onClick={bulkResolve}
                  >
                    <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />{t("alarms.bulkResolve")}
                    <kbd className="ml-2 hidden items-center rounded border bg-background/80 px-1.5 py-0.5 font-mono text-[10px] sm:inline-flex">R</kbd>
                  </Button>}
                  <Button size="sm" variant="ghost" className="h-7" onClick={clearSelection}>
                    <X className="mr-1.5 h-3.5 w-3.5" />{t("alarms.clear")}
                    <kbd className="ml-2 hidden items-center rounded border bg-background/80 px-1.5 py-0.5 font-mono text-[10px] sm:inline-flex">Esc</kbd>
                  </Button>
                </div>
              </div>
            )}
            <ScrollArea className="h-[560px]">
              {alarmsLoading && !alarms ? (
                <AlarmsListSkeleton />
              ) : (
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead className="w-[40px] pr-0">
                      {canAct ? (
                        <Checkbox
                          checked={allSelected ? true : someSelected ? "indeterminate" : false}
                          onCheckedChange={toggleAll}
                          disabled={actionableIds.length === 0}
                          aria-label={t("alarms.selectAllActionable")}
                        />
                      ) : null}
                    </TableHead>
                    <TableHead className="w-[24px]"></TableHead>
                    <TableHead className="w-[140px]">{t("alarms.type")}</TableHead>
                    <TableHead>{t("alarms.siteMessage")}</TableHead>
                    <TableHead className="w-[70px]">{t("alarms.sev")}</TableHead>
                    <TableHead className="w-[90px]">{t("alarms.status")}</TableHead>
                    <TableHead className="w-[80px]">{t("alarms.esc")}</TableHead>
                    <TableHead className="w-[90px]">{t("alarms.time")}</TableHead>
                    <TableHead className="w-[140px] text-right">{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAlarms.map((a) => {
                    const actionable = ACTIONABLE_STATUSES.has(a.status);
                    const isSaving = savingIds.has(a.id);
                    return (
                      <TableRow key={a.id} className={cn(
                        "cursor-pointer transition-all hover:bg-muted/30",
                        selected === a.id && "bg-muted/50",
                        // Optimistic-update saving indicator: dim the row while
                        // the ack/resolve mutation is in flight (#20).
                        isSaving && "opacity-50",
                      )} onClick={() => setSelected(a.id)}>
                        <TableCell className="pr-0" onClick={(e) => e.stopPropagation()}>
                          {actionable && canAct ? (
                            <Checkbox
                              checked={validSelectedIds.has(a.id)}
                              onCheckedChange={() => toggleOne(a.id)}
                              aria-label={`Select alarm ${a.id}`}
                            />
                          ) : (
                            <span className="block w-4" />
                          )}
                        </TableCell>
                        <TableCell><span className={cn("block h-2 w-2 rounded-full", severityDot(a.severity))} /></TableCell>
                        <TableCell className="font-mono text-[11px] font-medium">{alarmTypeLabel(a.type, numLang)}</TableCell>
                        <TableCell>
                          <p className="line-clamp-1 text-xs">{a.message}</p>
                          <p className="text-[10px] text-muted-foreground">{a.site?.name} · {a.site?.code}</p>
                        </TableCell>
                        <TableCell><StatusBadge value={a.severity} className="h-5 text-[10px]" /></TableCell>
                        <TableCell><StatusBadge value={a.status} className="h-5 text-[10px]" /></TableCell>
                        <TableCell className="text-center text-xs">L{formatNumber(a.escalationLevel, numLang)}</TableCell>
                        <TableCell className="text-[10px] text-muted-foreground">{timeAgo(a.createdAt, numLang)}</TableCell>
                        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            {isSaving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-label={t("common.saving")} />}
                            {canAcknowledge && (a.status === "OPEN" || a.status === "ESCALATED") && (
                              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] active:scale-[0.98] transition-transform" disabled={isSaving} onClick={() => ack(a.id)}>{t("alarms.ack")}</Button>
                            )}
                            {canResolve && a.status !== "RESOLVED" && (
                              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10 active:scale-[0.98] transition-transform" disabled={isSaving} onClick={() => resolve(a.id)}>
                                <CheckCircle2 className="mr-1 h-3 w-3" />{t("alarms.resolve")}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filteredAlarms.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="p-0">
                        <EmptyState
                          icon={ShieldCheck}
                          title={t("alarms.noAlarms")}
                          description={
                            (heatmapFilter || severity !== "all" || type !== "all" || status !== "OPEN,ACKNOWLEDGED,ESCALATED")
                              ? t("alarms.clearAllFilters")
                              : undefined
                          }
                          action={
                            (heatmapFilter || severity !== "all" || type !== "all" || status !== "OPEN,ACKNOWLEDGED,ESCALATED") ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs active:scale-[0.98] transition-transform"
                                onClick={() => {
                                  setHeatmapFilter(null);
                                  setSeverity("all");
                                  setType("all");
                                  setStatus("OPEN,ACKNOWLEDGED,ESCALATED");
                                }}
                              >
                                <X className="mr-1.5 h-3.5 w-3.5" />{t("alarms.clearAllFilters")}
                              </Button>
                            ) : undefined
                          }
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Alarm Correlation Analysis */}
      <AlarmCorrelationPanel alarms={mergedAlarms ?? []} onSelectSite={(siteId) => { selectSite(siteId); setView("sites"); }} />

      {/* Selected alarm detail */}
      {selectedAlarm && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("alarms.alarmDetail")} · {alarmTypeLabel(selectedAlarm.type, numLang)}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <Field label={t("alarms.alarmId")} value={<span className="font-mono">{formatNumber(selectedAlarm.id.slice(-12), numLang)}</span>} />
              <Field label={t("common.created")} value={fmtDateTime(selectedAlarm.createdAt, numLang)} />
              <Field label={t("alarms.severity")} value={<StatusBadge value={selectedAlarm.severity} className="h-5 text-[10px]" />} />
              <Field label={t("alarms.status")} value={<StatusBadge value={selectedAlarm.status} className="h-5 text-[10px]" />} />
              <Field label={t("alarms.escalationLevel")} value={`L${formatNumber(selectedAlarm.escalationLevel, numLang)}`} />
              <Field label={t("alarms.site")} value={selectedAlarm.site?.name} />
              <Field label={t("alarms.value")} value={selectedAlarm.value != null ? formatNumber(selectedAlarm.value, numLang) : "—"} />
              <Field label={t("alarms.threshold")} value={selectedAlarm.threshold != null ? formatNumber(selectedAlarm.threshold, numLang) : "—"} />
              <div className="col-span-2 sm:col-span-4">
                <Field label={t("alarms.message")} value={selectedAlarm.message} />
              </div>
              {selectedAlarm.resolution && (
                <div className="col-span-2 sm:col-span-4"><Field label={t("alarms.resolution")} value={selectedAlarm.resolution} /></div>
              )}
            </div>

            {/* Escalation Timeline */}
            <EscalationTimeline
              severity={selectedAlarm.severity}
              escalationLevel={selectedAlarm.escalationLevel}
              status={selectedAlarm.status}
              createdAt={selectedAlarm.createdAt}
              acknowledgedAt={selectedAlarm.acknowledgedAt}
              resolvedAt={selectedAlarm.resolvedAt}
            />
          </CardContent>
        </Card>
      )}
        </>
      )}
        </TabsContent>
        {canViewSuppressions && (
          <TabsContent value="suppressions" className="outline-none">
            <SuppressionsView />
          </TabsContent>
        )}
      </Tabs>

      {/* Correlation Rules editor dialog — mounted at the bottom so it doesn't
          remount when the alarms table re-renders. The dialog itself decides
          whether to render based on the `open` prop. */}
      {canManageRules && rulesOpen && (
        <CorrelationRulesEditor open={rulesOpen} onOpenChange={setRulesOpen} />
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xs font-medium">{value ?? "—"}</p>
    </div>
  );
}

function EscalationTimeline({
  escalationLevel,
  createdAt,
  acknowledgedAt,
  resolvedAt,
}: {
  severity: string;
  escalationLevel: number;
  status: string;
  createdAt: string;
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
}) {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  // Map escalation level to which steps are active
  const l1Active = escalationLevel >= 1;
  const l2Active = escalationLevel >= 2;
  const l3Active = escalationLevel >= 3;

  const steps = [
    {
      level: "L1",
      label: t("alarms.notice"),
      active: l1Active,
      color: l1Active ? "border-sky-500 bg-sky-500/10 text-sky-500" : "border-muted bg-muted/30 text-muted-foreground",
      dotColor: l1Active ? "bg-sky-500" : "bg-muted-foreground/30",
      lineColor: l2Active ? "bg-sky-500" : "bg-muted-foreground/20",
      time: l1Active ? fmtDateTime(createdAt, numLang) : null,
      desc: t("alarms.alarmDetected"),
    },
    {
      level: "L2",
      label: t("alarms.warning"),
      active: l2Active,
      color: l2Active ? "border-amber-500 bg-amber-500/10 text-amber-500" : "border-muted bg-muted/30 text-muted-foreground",
      dotColor: l2Active ? "bg-amber-500" : "bg-muted-foreground/30",
      lineColor: l3Active ? "bg-amber-500" : "bg-muted-foreground/20",
      time: l2Active ? fmtDateTime(createdAt, numLang) : null,
      desc: l2Active ? t("alarms.autoEscalated15") : t("alarms.pending15"),
    },
    {
      level: "L3",
      label: t("alarms.critical"),
      active: l3Active,
      color: l3Active ? "border-rose-500 bg-rose-500/10 text-rose-500" : "border-muted bg-muted/30 text-muted-foreground",
      dotColor: l3Active ? "bg-rose-500" : "bg-muted-foreground/30",
      lineColor: "bg-muted-foreground/20",
      time: l3Active ? fmtDateTime(createdAt, numLang) : null,
      desc: l3Active ? t("alarms.emergencyEscalation") : t("alarms.pending30"),
    },
  ];

  return (
    <div className="rounded-lg border p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t("alarms.escalationTimeline")}
      </p>
      <div className="flex items-start gap-0">
        {steps.map((step, i) => (
          <div key={step.level} className="flex min-w-0 flex-1 items-start">
            {/* Step node */}
            <div className="flex flex-col items-center">
              <div className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full border-2 text-xs font-bold transition-all",
                step.color
              )}>
                {step.level}
              </div>
              <div className="mt-1 text-center">
                <p className={cn("text-[10px] font-semibold", step.active ? "text-foreground" : "text-muted-foreground")}>
                  {step.label}
                </p>
                {step.time && (
                  <p className="mt-0.5 text-[10px] text-muted-foreground">{timeAgo(createdAt, numLang)}</p>
                )}
              </div>
              <p className="mt-1 text-center text-[10px] leading-tight text-muted-foreground">
                {step.desc}
              </p>
            </div>
            {/* Connector line */}
            {i < steps.length - 1 && (
              <div className="mt-4.5 flex flex-1 items-center px-1">
                <div className={cn("h-0.5 w-full rounded-full transition-colors", step.lineColor)} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Acknowledge / Resolve markers */}
      {(acknowledgedAt || resolvedAt) && (
        <div className="mt-4 flex items-center gap-4 border-t pt-3">
          {acknowledgedAt && (
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              <span className="text-muted-foreground">{t("alarms.acknowledgedLabel")}: {fmtDateTime(acknowledgedAt, numLang)}</span>
            </div>
          )}
          {resolvedAt && (
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-muted-foreground">{t("alarms.resolvedLabel")}: {fmtDateTime(resolvedAt, numLang)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
