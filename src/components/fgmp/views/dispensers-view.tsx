"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Fuel, Search, Plus, Pencil, Play, Square, RotateCcw, Lock, Unlock,
  Trash2, Download, Droplet, AlertTriangle, Receipt, Wallet,
  TrendingUp, Gauge, Wifi, XCircle, TriangleAlert,
  Hash,
} from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPost, apiPatch } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { StatusBadge } from "@/components/fgmp/status-badge";
import { EmptyState } from "@/components/fgmp/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { timeAgo, fmtDateTime } from "@/lib/fgmp/format";
import { useT, useArabicNumerals, formatNumber, toArabicNumerals } from "@/lib/fgmp/use-language";
import { useChartColors } from "@/lib/fgmp/use-chart-colors";
import type { Language } from "@/lib/fgmp/i18n";
import { translate } from "@/lib/fgmp/i18n";
import { downloadCsv, exportFilename } from "@/lib/fgmp/csv-export";
import { ResourceError } from "@/components/fgmp/resource-error";

/* ────────────────────────────────────────────────────────────────────────
 * Types & helpers
 * ──────────────────────────────────────────────────────────────────────── */

interface DispenserRow {
  id: string;
  siteId: string;
  label: string;
  manufacturer: string;
  model: string;
  nozzleCount: number;
  fuelType: string;
  maxFlowLpm: number;
  espDeviceId: string;
  espFirmware: string;
  rs485Baudrate: number;
  rs485Address: number;
  rs485Parity: string;
  ipAddress?: string | null;
  macAddress?: string | null;
  site?: { id: string; name: string; code: string };
  // live (merged from engine)
  liveStatus: string;
  liveMode: string;
  liveFlowRateLpm: number;
  liveCurrentVolumeLitres: number;
  liveTotalizerLitres: number;
  liveWifiRssi: number;
  liveLastCommAt: number;
  liveLastTransactionAt?: number;
  liveCurrentTransactionId?: string | null;
  liveTempC: number;
  // persisted defaults (used when engine hasn't ticked yet)
  status: string;
  mode: string;
  flowRateLpm: number;
  currentVolumeLitres: number;
  totalizerLitres: number;
  wifiRssi: number;
  lastCommAt?: string | null;
  lastTransactionAt?: string | null;
  tempC: number;
  presetVolumeLitres?: number | null;
}

interface TransactionRow {
  id: string;
  dispenserId: string;
  siteId: string;
  nozzle: number;
  volumeLitres: number;
  amountYer: number;
  unitPriceYer: number;
  vehiclePlate?: string | null;
  operatorName?: string | null;
  status: string;
  startedAt: string;
  completedAt?: string | null;
  durationSec: number;
  totalizerLitres?: number | null;
  dispenser?: { id: string; label: string; espDeviceId: string };
  site?: { id: string; name: string; code: string };
}

interface SiteOption {
  id: string;
  name: string;
  code: string;
}

const STATUSES = ["IDLE", "AUTHORIZED", "DISPENSING", "STOPPED", "FAULT", "MAINTENANCE", "OFFLINE"];
const FUEL_TYPES = ["DIESEL", "PETROL"];

/** Resolve a dispenser status enum value to its localized display label. */
function statusLabel(status: string, lang: Language): string {
  const key = `dispenser.status.${status}`;
  const translated = translate(key, lang);
  return translated === key ? status : translated;
}

/** Resolve a dispenser mode enum value to its localized display label. */
function modeLabel(mode: string, lang: Language): string {
  const key = `dispenser.mode.${mode}`;
  const translated = translate(key, lang);
  return translated === key ? mode : translated;
}

/** Resolve a fuel-type enum value to its localized display label. */
function fuelTypeLabel(fuelType: string, lang: Language): string {
  const key = `dispenser.fuelType.${fuelType}`;
  const translated = translate(key, lang);
  return translated === key ? fuelType : translated;
}

/** Resolve a transaction status enum value to its localized display label. */
function txnStatusLabel(status: string, lang: Language): string {
  const key = `dispenser.txnStatus.${status}`;
  const translated = translate(key, lang);
  return translated === key ? status.replace(/_/g, " ") : translated;
}

/** Format a YER amount with thousands separators + Arabic-Indic numerals if AR. */
function formatYer(amount: number, lang: Language): string {
  const s = Math.round(amount).toLocaleString("en-US");
  const digits = lang === "ar" ? translate("dispenser.yerSuffix", lang) : "YER";
  const num = toArabicNumerals(s);
  return lang === "ar" ? `${num} ${digits}` : `${num} ${digits}`;
}

/** Format a duration in seconds as "M:SS" or "H:MM:SS". */
function formatDuration(sec: number, _lang: Language): string {
  if (!sec || sec < 1) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const out = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  return toArabicNumerals(out);
}

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function DispensersView() {
  // Subscribe to individual slices: a bare `useFgmp()` re-renders this
  // component on EVERY store write (search keystrokes, view changes,
  // lastTickAt, …) instead of only the slices actually read.
  const snapshot = useFgmp((s) => s.snapshot);
  const me = useFgmp((s) => s.me);
  const tick = useFgmp((s) => s.tick);

  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const cc = useChartColors();

  const isAdmin = me?.role === "ADMIN";
  const canControl = me?.role === "ADMIN" || me?.role === "NOC_OPERATOR";

  const [tab, setTab] = useState<"registry" | "transactions" | "reports">("registry");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [fuelFilter, setFuelFilter] = useState("all");
  const [txnStatusFilter, setTxnStatusFilter] = useState("all");

  // Dialogs
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<DispenserRow | null>(null);
  const [authorizeTarget, setAuthorizeTarget] = useState<DispenserRow | null>(null);
  const [limitTarget, setLimitTarget] = useState<DispenserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DispenserRow | null>(null);

  // Data
  const { data: dispensers, loading: dispensersLoading, error: dispensersError, refetch: refetchDispensers } = useApi<DispenserRow[]>(
    "/api/fgmp/dispensers",
    { interval: 8000 },
  );
  const { data: txnPayload, error: txnsError, refetch: refetchTxns } = useApi<{ rows: TransactionRow[]; total: number }>(
    "/api/fgmp/dispensers/transactions?limit=200",
    { interval: 8000 },
  );
  // Stable fallback identity — a bare `?? []` is a new array every render.
  const transactions = useMemo(() => txnPayload?.rows ?? [], [txnPayload]);

  // Filtered dispensers
  const filtered = useMemo(() => {
    let list = dispensers ?? [];
    if (statusFilter !== "all") list = list.filter((d) => d.liveStatus === statusFilter);
    if (fuelFilter !== "all") list = list.filter((d) => d.fuelType === fuelFilter);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((d) =>
        `${d.label} ${d.espDeviceId} ${d.manufacturer} ${d.model} ${d.site?.name ?? ""} ${d.site?.code ?? ""}`
          .toLowerCase().includes(needle),
      );
    }
    return list;
  }, [dispensers, q, statusFilter, fuelFilter]);

  // Filtered transactions
  const filteredTxns = useMemo(() => {
    let list = transactions;
    if (txnStatusFilter !== "all") list = list.filter((t2) => t2.status === txnStatusFilter);
    if (q && tab === "transactions") {
      const needle = q.toLowerCase();
      list = list.filter((t2) =>
        `${t2.dispenser?.label ?? ""} ${t2.vehiclePlate ?? ""} ${t2.site?.name ?? ""} ${t2.operatorName ?? ""}`
          .toLowerCase().includes(needle),
      );
    }
    return list;
  }, [transactions, q, txnStatusFilter, tab]);

  // KPIs
  const k = snapshot?.kpis;
  const dispensersTotal = k?.dispensersTotal ?? dispensers?.length ?? 0;
  const dispensersDispensing = k?.dispensersDispensing ?? 0;
  const dispensersFault = k?.dispensersFault ?? 0;
  const txnToday = k?.dispenserTransactionsToday ?? 0;
  const volToday = k?.dispenserVolumeTodayL ?? 0;
  // revenue today from transactions
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const revenueToday = useMemo(
    () => transactions.filter((t2) => new Date(t2.startedAt).getTime() >= todayMs && t2.status === "COMPLETED")
      .reduce((a, t2) => a + t2.amountYer, 0),
    [transactions, todayMs],
  );

  // ── Reports data (computed from transactions) ────────────────────────
  // Proposal §8.17 Figure 31: aggregated statistics with a
  // 24h / 7d / 30d period picker.
  const [reportPeriod, setReportPeriod] = useState<"24h" | "7d" | "30d">("7d");
  const periodMs = reportPeriod === "24h" ? 24 * 3600_000 : reportPeriod === "7d" ? 7 * 86400_000 : 30 * 86400_000;
  const periodStartMs = Date.now() - periodMs;

  const periodTxns = useMemo(
    () => transactions.filter((t2) => t2.status === "COMPLETED" && new Date(t2.startedAt).getTime() >= periodStartMs),
    [transactions, periodStartMs],
  );

  const topDispensers = useMemo(() => {
    const m = new Map<string, { label: string; volume: number; amount: number }>();
    for (const t2 of periodTxns) {
      const key = t2.dispenserId;
      const prev = m.get(key) ?? { label: t2.dispenser?.label ?? "—", volume: 0, amount: 0 };
      prev.volume += t2.volumeLitres;
      prev.amount += t2.amountYer;
      m.set(key, prev);
    }
    return Array.from(m.values()).sort((a, b) => b.volume - a.volume).slice(0, 5);
  }, [periodTxns]);

  const volumeTrend = useMemo(() => {
    const days: { day: string; volume: number; amount: number }[] = [];
    const buckets = reportPeriod === "24h" ? 24 : reportPeriod === "7d" ? 7 : 30;
    for (let i = buckets - 1; i >= 0; i--) {
      const start = reportPeriod === "24h"
        ? Date.now() - (i + 1) * 3600_000
        : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); return d.getTime(); })();
      const end = reportPeriod === "24h" ? start + 3600_000 : start + 86400000;
      const bucketTxns = periodTxns.filter((t2) => {
        const ts = new Date(t2.startedAt).getTime();
        return ts >= start && ts < end;
      });
      const volume = bucketTxns.reduce((a, t2) => a + t2.volumeLitres, 0);
      const amount = bucketTxns.reduce((a, t2) => a + t2.amountYer, 0);
      const label = reportPeriod === "24h"
        ? new Date(start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
        : new Date(start).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });
      days.push({ day: label, volume: Math.round(volume * 10) / 10, amount });
    }
    return days;
  }, [periodTxns, reportPeriod]);

  const revenueBySite = useMemo(() => {
    const m = new Map<string, { name: string; amount: number; volume: number }>();
    for (const t2 of periodTxns) {
      const key = t2.siteId;
      const prev = m.get(key) ?? { name: t2.site?.name ?? "—", amount: 0, volume: 0 };
      prev.amount += t2.amountYer;
      prev.volume += t2.volumeLitres;
      m.set(key, prev);
    }
    return Array.from(m.values()).sort((a, b) => b.amount - a.amount).slice(0, 8);
  }, [periodTxns]);

  const volumeByVehicle = useMemo(() => {
    const m = new Map<string, { plate: string; volume: number; amount: number; txns: number }>();
    for (const t2 of periodTxns) {
      const key = t2.vehiclePlate ?? "—";
      const prev = m.get(key) ?? { plate: key, volume: 0, amount: 0, txns: 0 };
      prev.volume += t2.volumeLitres;
      prev.amount += t2.amountYer;
      prev.txns += 1;
      m.set(key, prev);
    }
    return Array.from(m.values()).sort((a, b) => b.volume - a.volume).slice(0, 8);
  }, [periodTxns]);

  const volumeByStatus = useMemo(() => {
    const m = new Map<string, { status: string; volume: number; txns: number }>();
    for (const t2 of transactions) {
      if (new Date(t2.startedAt).getTime() < periodStartMs) continue;
      const key = t2.status;
      const prev = m.get(key) ?? { status: key, volume: 0, txns: 0 };
      prev.volume += t2.volumeLitres;
      prev.txns += 1;
      m.set(key, prev);
    }
    return Array.from(m.values()).sort((a, b) => b.volume - a.volume);
  }, [transactions, periodStartMs]);

  // ── Actions ──────────────────────────────────────────────────────────
  const sendControl = async (
    d: DispenserRow,
    command:
      | "AUTHORIZE" | "DEAUTHORIZE" | "START" | "STOP" | "EMERGENCY_STOP"
      | "RESET" | "LOCK" | "UNLOCK" | "SET_LIMIT" | "RESET_COUNTER",
    preset?: number,
  ) => {
    const res = await apiPost(`/api/fgmp/dispensers/${d.id}/control`, {
      command,
      ...(preset ? { presetVolumeLitres: preset } : {}),
    });
    if (res.ok) {
      toast.success(`${t("dispenser.cmdSent")} ${command} — ${d.label}`);
      refetchDispensers();
      void tick(30);
    } else {
      const data = res.data as { message?: string; error?: string } | undefined;
      toast.error(t("dispenser.cmdFailed"), { description: data?.message ?? data?.error ?? res.error });
    }
  };

  const exportTxnsCsv = () => {
    if (filteredTxns.length === 0) {
      toast.info(t("dispenser.noTxnToExport"));
      return;
    }
    const rows: (string | number)[][] = [
      [
        "Time", "Dispenser", "ESP ID", "Site", "Nozzle", "Volume (L)",
        "Amount (YER)", "Unit Price", "Vehicle Plate", "Operator",
        "Status", "Duration (s)",
      ],
    ];
    for (const t2 of filteredTxns) {
      rows.push([
        fmtDateTime(t2.startedAt, "en"),
        t2.dispenser?.label ?? "",
        t2.dispenser?.espDeviceId ?? "",
        t2.site?.name ?? "",
        t2.nozzle,
        t2.volumeLitres,
        t2.amountYer,
        t2.unitPriceYer,
        t2.vehiclePlate ?? "",
        t2.operatorName ?? "",
        t2.status,
        t2.durationSec,
      ]);
    }
    downloadCsv(rows, exportFilename("dispenser-transactions"));
    toast.success(`${filteredTxns.length} ${t("dispenser.exportedToast")}`);
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("dispenser.title")}
        description={t("desc.dispensers")}
        icon={<Fuel className="h-5 w-5" />}
        tone="emerald"
        actions={
          isAdmin && (
            <Button onClick={() => setCreateOpen(true)} size="sm">
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">{t("dispenser.addDispenser")}</span>
            </Button>
          )
        }
      />

      <ResourceError error={dispensersError ?? txnsError} onRetry={() => { refetchDispensers(); refetchTxns(); }} />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label={t("dispenser.kpiTotal")} value={formatNumber(dispensersTotal, numLang)} icon={<Fuel className="h-4 w-4" />} />
        <KpiCard label={t("dispenser.kpiDispensing")} value={formatNumber(dispensersDispensing, numLang)} icon={<Droplet className="h-4 w-4" />} tone={dispensersDispensing > 0 ? "good" : "default"} />
        <KpiCard label={t("dispenser.kpiFaulty")} value={formatNumber(dispensersFault, numLang)} icon={<AlertTriangle className="h-4 w-4" />} tone={dispensersFault > 0 ? "danger" : "good"} />
        <KpiCard label={t("dispenser.kpiTxnToday")} value={formatNumber(txnToday, numLang)} icon={<Receipt className="h-4 w-4" />} tone="info" />
        <KpiCard label={t("dispenser.kpiVolumeToday")} value={formatNumber(volToday, numLang)} icon={<Gauge className="h-4 w-4" />} tone="info" />
        <KpiCard label={t("dispenser.kpiRevenueToday")} value={formatYer(revenueToday, numLang)} icon={<Wallet className="h-4 w-4" />} tone="good" />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="registry">{t("dispenser.tabRegistry")}</TabsTrigger>
          <TabsTrigger value="transactions">{t("dispenser.tabTransactions")}</TabsTrigger>
          <TabsTrigger value="reports">{t("dispenser.tabReports")}</TabsTrigger>
        </TabsList>

        {/* ── Tab 1: Registry ─────────────────────────────────────────────── */}
        <TabsContent value="registry" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
              <CardTitle className="text-sm">{t("dispenser.tabRegistry")} ({formatNumber(filtered.length, numLang)})</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("dispenser.search")} className="h-9 w-[220px] pl-8" />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-9 w-[140px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("dispenser.allStatuses")}</SelectItem>
                    {STATUSES.map((s) => <SelectItem key={s} value={s}>{statusLabel(s, numLang)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={fuelFilter} onValueChange={setFuelFilter}>
                  <SelectTrigger className="h-9 w-[120px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("dispenser.allFuelTypes")}</SelectItem>
                    {FUEL_TYPES.map((f) => <SelectItem key={f} value={f}>{fuelTypeLabel(f, numLang)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {dispensersLoading && !dispensers ? (
                <TableSkeletonRows cols={9} rows={6} />
              ) : filtered.length === 0 ? (
                <EmptyState icon={Fuel} title={t("dispenser.noDispensers")} />
              ) : (
                <div className="max-h-[640px] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card">
                      <TableRow>
                        <TableHead>{t("dispenser.colDispenser")}</TableHead>
                        <TableHead className="hidden md:table-cell">{t("dispenser.colSite")}</TableHead>
                        <TableHead className="hidden lg:table-cell w-[80px]">{t("dispenser.colNozzles")}</TableHead>
                        <TableHead className="hidden lg:table-cell w-[90px]">{t("dispenser.colFuelType")}</TableHead>
                        <TableHead className="hidden xl:table-cell w-[110px]">{t("dispenser.colRs485")}</TableHead>
                        <TableHead className="hidden xl:table-cell w-[80px]">{t("dispenser.colFirmware")}</TableHead>
                        <TableHead className="w-[140px]">{t("dispenser.colFlow")}</TableHead>
                        <TableHead className="hidden md:table-cell w-[100px]">{t("dispenser.colLastComm")}</TableHead>
                        <TableHead className="w-[80px]">{t("dispenser.colStatus")}</TableHead>
                        <TableHead className="w-[200px] text-right">{t("dispenser.colActions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.slice(0, 100).map((d) => {
                        const status = d.liveStatus ?? d.status;
                        const dispensing = status === "DISPENSING";
                        const commsStale = Date.now() - (d.liveLastCommAt ?? 0) > 90_000;
                        return (
                          <TableRow key={d.id} className="transition-colors hover:bg-muted/30">
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="text-sm font-medium">{d.label}</span>
                                <span className="font-mono text-[10px] text-muted-foreground" dir="ltr">{d.espDeviceId}</span>
                                {d.macAddress && (
                                  <span className="font-mono text-[10px] text-muted-foreground" dir="ltr">MAC {d.macAddress}</span>
                                )}
                                <span className="text-[10px] text-muted-foreground">{d.manufacturer} {d.model}</span>
                              </div>
                            </TableCell>
                            <TableCell className="hidden md:table-cell text-xs">{d.site?.name ?? "—"}</TableCell>
                            <TableCell className="hidden lg:table-cell text-center text-xs tabular-nums">{formatNumber(d.nozzleCount, numLang)}</TableCell>
                            <TableCell className="hidden lg:table-cell">
                              <Badge variant="outline" className={
                                d.fuelType === "DIESEL"
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[9px]"
                                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[9px]"
                              }>{fuelTypeLabel(d.fuelType, numLang)}</Badge>
                            </TableCell>
                            <TableCell className="hidden xl:table-cell text-[10px] tabular-nums text-muted-foreground" dir="ltr">
                              @{formatNumber(d.rs485Address, numLang)} · {formatNumber(d.rs485Baudrate, numLang)}
                            </TableCell>
                            <TableCell className="hidden xl:table-cell text-[10px] font-mono">{d.espFirmware}</TableCell>
                            <TableCell>
                              {dispensing ? (
                                <div className="space-y-0.5">
                                  <div className="flex items-center gap-1 text-xs">
                                    <Droplet className="h-3 w-3 text-emerald-500 animate-pulse" />
                                    <span className="font-medium tabular-nums">{formatNumber(d.liveFlowRateLpm.toFixed(1), numLang)}</span>
                                    <span className="text-[10px] text-muted-foreground">{t("dispenser.lpm")}</span>
                                  </div>
                                  <div className="text-[10px] text-muted-foreground tabular-nums">
                                    {formatNumber(d.liveCurrentVolumeLitres.toFixed(1), numLang)} {t("dispenser.litres")}
                                  </div>
                                </div>
                              ) : (
                                <div className="space-y-0.5">
                                  <div className="text-[10px] text-muted-foreground">{t("dispenser.colTotalizer")}</div>
                                  <div className="text-xs tabular-nums">{formatNumber(Math.round(d.liveTotalizerLitres).toLocaleString("en-US"), numLang)} {t("dispenser.litres")}</div>
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="hidden md:table-cell">
                              <div className="flex items-center gap-1 text-[10px]">
                                <Wifi className={`h-3 w-3 ${commsStale ? "text-rose-500" : "text-emerald-500"}`} />
                                <span className={commsStale ? "text-rose-500" : "text-muted-foreground"}>
                                  {timeAgo(d.liveLastCommAt ?? Date.now(), numLang)}
                                </span>
                              </div>
                              <div className="text-[9px] text-muted-foreground tabular-nums" dir="ltr">{formatNumber(d.liveWifiRssi, numLang)} dBm</div>
                            </TableCell>
                            <TableCell>
                              <StatusBadge value={status} className="h-5 text-[9px]" />
                              <div className="text-[9px] text-muted-foreground mt-0.5">{modeLabel(d.liveMode, numLang)}</div>
                            </TableCell>
                            <TableCell className="text-right">
                              {/* The ten control commands of proposal feature
                                  23, shown contextually by pump state so the
                                  row stays readable: authorize/limit when
                                  idle, start/deauthorize when armed, stop and
                                  emergency-stop while fuel is moving, reset
                                  on a fault latch, lock/unlock always, and
                                  the metrological counter reset for admins. */}
                              <div className="flex justify-end flex-wrap gap-1">
                                {canControl && (status === "IDLE" || status === "STOPPED") && d.liveMode !== "LOCKED" && (
                                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => setAuthorizeTarget(d)}>
                                    <Play className="mr-1 h-3 w-3" />{t("dispenser.cmdAuthorize")}
                                  </Button>
                                )}
                                {canControl && status === "AUTHORIZED" && (
                                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => sendControl(d, "START")}>
                                    <Play className="mr-1 h-3 w-3" />{t("dispenser.cmdStart")}
                                  </Button>
                                )}
                                {canControl && status === "AUTHORIZED" && (
                                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => sendControl(d, "DEAUTHORIZE")}>
                                    <XCircle className="mr-1 h-3 w-3" />{t("dispenser.cmdDeauthorize")}
                                  </Button>
                                )}
                                {canControl && (status === "DISPENSING" || status === "AUTHORIZED") && (
                                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => sendControl(d, "STOP")}>
                                    <Square className="mr-1 h-3 w-3" />{t("dispenser.cmdStop")}
                                  </Button>
                                )}
                                {canControl && (status === "DISPENSING" || status === "AUTHORIZED") && (
                                  <Button size="sm" variant="destructive" className="h-6 px-2 text-[10px]" onClick={() => sendControl(d, "EMERGENCY_STOP")}>
                                    <TriangleAlert className="mr-1 h-3 w-3" />{t("dispenser.cmdEmergencyStop")}
                                  </Button>
                                )}
                                {canControl && status === "FAULT" && (
                                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => sendControl(d, "RESET")}>
                                    <RotateCcw className="mr-1 h-3 w-3" />{t("dispenser.cmdReset")}
                                  </Button>
                                )}
                                {canControl && status !== "DISPENSING" && status !== "FAULT" && (
                                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setLimitTarget(d)} title={t("dispenser.cmdSetLimit")}>
                                    <Gauge className="h-3 w-3" />{t("dispenser.cmdSetLimit")}
                                  </Button>
                                )}
                                {canControl && d.liveMode !== "LOCKED" && status !== "DISPENSING" && status !== "FAULT" && (
                                  <Button size="sm" variant="ghost" className="h-6 px-1 text-[10px]" onClick={() => sendControl(d, "LOCK")} title={t("dispenser.cmdLock")}>
                                    <Lock className="h-3 w-3" />
                                  </Button>
                                )}
                                {canControl && d.liveMode === "LOCKED" && (
                                  <Button size="sm" variant="ghost" className="h-6 px-1 text-[10px]" onClick={() => sendControl(d, "UNLOCK")} title={t("dispenser.cmdUnlock")}>
                                    <Unlock className="h-3 w-3" />
                                  </Button>
                                )}
                                {isAdmin && canControl && status !== "DISPENSING" && (
                                  <Button size="sm" variant="ghost" className="h-6 px-1 text-[10px]" onClick={() => sendControl(d, "RESET_COUNTER")} title={t("dispenser.cmdResetCounter")}>
                                    <Hash className="h-3 w-3" />
                                  </Button>
                                )}
                                {isAdmin && (
                                  <>
                                    <Button size="sm" variant="ghost" className="h-6 px-1 text-[10px]" onClick={() => setEditTarget(d)} title={t("common.edit")}>
                                      <Pencil className="h-3 w-3" />
                                    </Button>
                                    <Button size="sm" variant="ghost" className="h-6 px-1 text-[10px] text-rose-500" onClick={() => setDeleteTarget(d)} title={t("common.delete")}>
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 2: Live Transactions ───────────────────────────────────── */}
        <TabsContent value="transactions" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
              <CardTitle className="text-sm">
                {t("dispenser.tabTransactions")} ({formatNumber(filteredTxns.length, numLang)})
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={txnStatusFilter} onValueChange={setTxnStatusFilter}>
                  <SelectTrigger className="h-9 w-[140px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("dispenser.allStatuses")}</SelectItem>
                    <SelectItem value="IN_PROGRESS">{txnStatusLabel("IN_PROGRESS", numLang)}</SelectItem>
                    <SelectItem value="COMPLETED">{txnStatusLabel("COMPLETED", numLang)}</SelectItem>
                    <SelectItem value="CANCELLED">{txnStatusLabel("CANCELLED", numLang)}</SelectItem>
                    <SelectItem value="FAILED">{txnStatusLabel("FAILED", numLang)}</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={exportTxnsCsv}>
                  <Download className="mr-1.5 h-4 w-4" />{t("dispenser.exportCsv")}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {filteredTxns.length === 0 ? (
                <EmptyState icon={Receipt} title={t("dispenser.noTxnMatch")} />
              ) : (
                <div className="max-h-[640px] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card">
                      <TableRow>
                        <TableHead className="w-[130px]">{t("dispenser.colTime")}</TableHead>
                        <TableHead>{t("dispenser.colPump")}</TableHead>
                        <TableHead className="hidden md:table-cell">{t("dispenser.colSite")}</TableHead>
                        <TableHead className="hidden lg:table-cell">{t("dispenser.colPlate")}</TableHead>
                        <TableHead className="hidden xl:table-cell">{t("dispenser.colOperator")}</TableHead>
                        <TableHead className="w-[90px] text-right">{t("dispenser.colVolume")}</TableHead>
                        <TableHead className="hidden md:table-cell w-[80px] text-right">{t("dispenser.colDuration")}</TableHead>
                        <TableHead className="hidden lg:table-cell w-[90px] text-right">{t("dispenser.colFlowRate")}</TableHead>
                        <TableHead className="hidden xl:table-cell w-[110px] text-right">{t("dispenser.colCounter")}</TableHead>
                        <TableHead className="hidden lg:table-cell w-[90px] text-right">{t("dispenser.colUnitPrice")}</TableHead>
                        <TableHead className="w-[110px] text-right">{t("dispenser.colAmount")}</TableHead>
                        <TableHead className="w-[90px]">{t("dispenser.colStatus")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredTxns.slice(0, 200).map((tx) => {
                        const inProgress = tx.status === "IN_PROGRESS";
                        // Flow rate L/min over the fill's duration.
                        const flowLpm = tx.durationSec > 0
                          ? Math.round((tx.volumeLitres / (tx.durationSec / 60)) * 10) / 10
                          : 0;
                        return (
                          <TableRow key={tx.id} className={inProgress ? "bg-emerald-500/5" : "transition-colors hover:bg-muted/30"}>
                            <TableCell className="text-[10px] text-muted-foreground tabular-nums" dir="ltr">
                              {fmtDateTime(tx.startedAt, numLang).slice(0, 16)}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="text-xs font-medium">{tx.dispenser?.label ?? "—"}</span>
                                <span className="font-mono text-[9px] text-muted-foreground" dir="ltr">{tx.dispenser?.espDeviceId ?? ""}</span>
                              </div>
                            </TableCell>
                            <TableCell className="hidden md:table-cell text-xs">{tx.site?.name ?? "—"}</TableCell>
                            <TableCell className="hidden lg:table-cell text-xs font-mono" dir="ltr">{tx.vehiclePlate ?? "—"}</TableCell>
                            <TableCell className="hidden xl:table-cell text-xs">{tx.operatorName ?? "—"}</TableCell>
                            <TableCell className="text-right text-xs tabular-nums">{formatNumber(tx.volumeLitres.toFixed(1), numLang)}</TableCell>
                            <TableCell className="hidden md:table-cell text-right text-xs tabular-nums">{formatDuration(tx.durationSec, numLang)}</TableCell>
                            <TableCell className="hidden lg:table-cell text-right text-xs tabular-nums">{formatNumber(flowLpm.toFixed(1), numLang)} {t("dispenser.lpm")}</TableCell>
                            <TableCell className="hidden xl:table-cell text-right text-xs tabular-nums">
                              {tx.totalizerLitres != null
                                ? `${formatNumber(Number(tx.totalizerLitres).toLocaleString("en-US"), numLang)} ${t("dispenser.litres")}`
                                : "—"}
                            </TableCell>
                            <TableCell className="hidden lg:table-cell text-right text-xs tabular-nums">
                              {formatYer(tx.unitPriceYer, numLang)}/{t("dispenser.litres")}
                            </TableCell>
                            <TableCell className="text-right text-xs tabular-nums">{formatYer(tx.amountYer, numLang)}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className={
                                tx.status === "COMPLETED" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[9px]" :
                                tx.status === "IN_PROGRESS" ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[9px]" :
                                tx.status === "CANCELLED" ? "border-slate-500/30 bg-slate-500/10 text-slate-500 text-[9px]" :
                                "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400 text-[9px]"
                              }>{txnStatusLabel(tx.status, numLang)}</Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 3: Reports ───────────────────────────────────────
             Proposal §8.17 Figure 31: aggregated statistics
             (totals, by site, by pump, by vehicle, by status)
             with a 24h chart and a 24h / 7d / 30d picker. */}
        <TabsContent value="reports" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("dispenser.reportPeriod")}</span>
            {(["24h", "7d", "30d"] as const).map((p) => (
              <Button
                key={p}
                size="sm"
                variant={reportPeriod === p ? "default" : "outline"}
                className="h-7 px-2 text-[10px]"
                onClick={() => setReportPeriod(p)}
              >
                {p === "24h" ? t("dispenser.period24h") : p === "7d" ? t("dispenser.period7d") : t("dispenser.period30d")}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card className="col-span-2 lg:col-span-1">
              <CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">{t("dispenser.colVolume")}</CardTitle></CardHeader>
              <CardContent><p className="text-xl font-semibold tabular-nums">{formatNumber(Math.round(periodTxns.reduce((a, t2) => a + t2.volumeLitres, 0)), numLang)} L</p></CardContent>
            </Card>
            <Card className="col-span-2 lg:col-span-1">
              <CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">{t("dispenser.colAmount")}</CardTitle></CardHeader>
              <CardContent><p className="text-xl font-semibold tabular-nums">{formatYer(Math.round(periodTxns.reduce((a, t2) => a + t2.amountYer, 0)), numLang)}</p></CardContent>
            </Card>
            <Card className="col-span-2 lg:col-span-1">
              <CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">{t("dispenser.reportTxns")}</CardTitle></CardHeader>
              <CardContent><p className="text-xl font-semibold tabular-nums">{formatNumber(periodTxns.length, numLang)}</p></CardContent>
            </Card>
            <Card className="col-span-2 lg:col-span-1">
              <CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">{t("dispenser.reportAvgFlow")}</CardTitle></CardHeader>
              <CardContent><p className="text-xl font-semibold tabular-nums">
                {formatNumber(periodTxns.length === 0 ? 0 : periodTxns.reduce((a, t2) => a + (t2.durationSec > 0 ? t2.volumeLitres / (t2.durationSec / 60) : 0), 0) / periodTxns.length, numLang)} L/min
              </p></CardContent>
            </Card>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm"><TrendingUp className="h-4 w-4 text-emerald-500" />{t("dispenser.topDispensers")}</CardTitle>
              </CardHeader>
              <CardContent>
                {topDispensers.length === 0 ? (
                  <EmptyState icon={TrendingUp} title={t("dispenser.noChartData")} />
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={topDispensers} layout="vertical" margin={{ top: 5, right: 20, left: 20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                      <YAxis type="category" dataKey="label" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} width={100} />
                      <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v: number) => [`${formatNumber(v, numLang)} L`, t("dispenser.volumeLitres")]} />
                      <Bar dataKey="volume" radius={[0, 4, 4, 0]} name={t("dispenser.volumeLitres")}>
                        {topDispensers.map((_, i) => <Cell key={i} fill={[cc.emerald, cc.amber, cc.sky, cc.violet, cc.rose][i % 5]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm"><Gauge className="h-4 w-4 text-sky-500" />{t("dispenser.volumeTrend")}</CardTitle>
              </CardHeader>
              <CardContent>
                {volumeTrend.every((d) => d.volume === 0) ? (
                  <EmptyState icon={Gauge} title={t("dispenser.noChartData")} />
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={volumeTrend} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                      <defs>
                        <linearGradient id="a-vol" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={cc.emerald} stopOpacity={0.4} />
                          <stop offset="100%" stopColor={cc.emerald} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                      <XAxis dataKey="day" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} />
                      <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                      <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v: number) => [`${formatNumber(v, numLang)} L`, t("dispenser.volumeLitres")]} />
                      <Area type="monotone" dataKey="volume" stroke={cc.emerald} strokeWidth={2} fill="url(#a-vol)" name={t("dispenser.volumeLitres")} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm"><Wallet className="h-4 w-4 text-violet-500" />{t("dispenser.revenueBySite")}</CardTitle>
            </CardHeader>
            <CardContent>
              {revenueBySite.length === 0 ? (
                <EmptyState icon={Wallet} title={t("dispenser.noChartData")} />
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={revenueBySite} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} interval={0} angle={-15} textAnchor="end" height={60} />
                    <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                    <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v: number) => [formatYer(v, numLang), t("dispenser.amountYer")]} />
                    <Bar dataKey="amount" radius={[4, 4, 0, 0]} name={t("dispenser.amountYer")}>
                      {revenueBySite.map((_, i) => <Cell key={i} fill={[cc.emerald, cc.amber, cc.sky, cc.violet, cc.rose][i % 5]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* By vehicle + by status — the two breakdowns the
              proposal's pump-reports screen aggregates. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm"><Fuel className="h-4 w-4 text-sky-500" />{t("dispenser.reportByVehicle")}</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {volumeByVehicle.length === 0 ? (
                  <EmptyState icon={Fuel} title={t("dispenser.noChartData")} />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[110px]">{t("dispenser.colPlate")}</TableHead>
                        <TableHead className="w-[70px] text-right">{t("dispenser.reportTxns")}</TableHead>
                        <TableHead className="text-right">{t("dispenser.colVolume")}</TableHead>
                        <TableHead className="text-right">{t("dispenser.colAmount")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {volumeByVehicle.map((v) => (
                        <TableRow key={v.plate}>
                          <TableCell className="text-xs font-mono" dir="ltr">{v.plate}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatNumber(v.txns, numLang)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatNumber(Math.round(v.volume * 10) / 10, numLang)} L</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatYer(Math.round(v.amount), numLang)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm"><Receipt className="h-4 w-4 text-violet-500" />{t("dispenser.reportByStatus")}</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {volumeByStatus.length === 0 ? (
                  <EmptyState icon={Receipt} title={t("dispenser.noChartData")} />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[120px]">{t("dispenser.colStatus")}</TableHead>
                        <TableHead className="w-[70px] text-right">{t("dispenser.reportTxns")}</TableHead>
                        <TableHead className="text-right">{t("dispenser.colVolume")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {volumeByStatus.map((v) => (
                        <TableRow key={v.status}>
                          <TableCell><Badge variant="outline" className="h-5 text-[9px]">{txnStatusLabel(v.status, numLang)}</Badge></TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatNumber(v.txns, numLang)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatNumber(Math.round(v.volume * 10) / 10, numLang)} L</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* ── Dialogs ─────────────────────────────────────────────────────── */}
      <CreateDispenserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { refetchDispensers(); setCreateOpen(false); }}
        lang={numLang}
      />
      <EditDispenserDialog
        target={editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
        onSaved={() => { refetchDispensers(); setEditTarget(null); }}
        lang={numLang}
      />
      <AuthorizeDialog
        target={authorizeTarget}
        onOpenChange={(o) => !o && setAuthorizeTarget(null)}
        onConfirm={(d, preset) => { sendControl(d, "AUTHORIZE", preset); setAuthorizeTarget(null); }}
        lang={numLang}
      />
      <AuthorizeDialog
        target={limitTarget}
        onOpenChange={(o) => !o && setLimitTarget(null)}
        onConfirm={(d, preset) => { sendControl(d, "SET_LIMIT", preset); setLimitTarget(null); }}
        lang={numLang}
        limitMode
      />
      <DeleteConfirmDialog
        target={deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        onDeleted={() => { refetchDispensers(); refetchTxns(); setDeleteTarget(null); }}
        lang={numLang}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Sub-components
 * ──────────────────────────────────────────────────────────────────────── */

function TableSkeletonRows({ cols, rows }: { cols: number; rows: number }) {
  return (
    <div className="shimmer space-y-2 p-3">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="grid items-center gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-6" />
          ))}
        </div>
      ))}
    </div>
  );
}

function DispenserFormFields({
  form, lang, sites,
}: {
  form: {
    siteId: string; setSiteId: (v: string) => void;
    label: string; setLabel: (v: string) => void;
    manufacturer: string; setManufacturer: (v: string) => void;
    model: string; setModel: (v: string) => void;
    nozzleCount: number; setNozzleCount: (v: number) => void;
    fuelType: string; setFuelType: (v: string) => void;
    maxFlowLpm: number; setMaxFlowLpm: (v: number) => void;
    espDeviceId: string; setEspDeviceId: (v: string) => void;
    espFirmware: string; setEspFirmware: (v: string) => void;
    rs485Baudrate: number; setRs485Baudrate: (v: number) => void;
    rs485Address: number; setRs485Address: (v: number) => void;
    rs485Parity: string; setRs485Parity: (v: string) => void;
    ipAddress: string; setIpAddress: (v: string) => void;
    macAddress: string; setMacAddress: (v: string) => void;
  };
  lang: Language;
  sites: SiteOption[];
}) {
  const t = useT();
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">{t("dispenser.lblSite")}</Label>
        <Select value={form.siteId} onValueChange={form.setSiteId}>
          <SelectTrigger className="h-9 w-full"><SelectValue placeholder={t("dispenser.selectSite")} /></SelectTrigger>
          <SelectContent>
            {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name} ({s.code})</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("dispenser.lblLabel")}</Label>
          <Input value={form.label} onChange={(e) => form.setLabel(e.target.value)} className="h-9" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("dispenser.lblNozzleCount")}</Label>
          <Select value={String(form.nozzleCount)} onValueChange={(v) => form.setNozzleCount(Number(v))}>
            <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <SelectItem key={n} value={String(n)}>{String(n)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("dispenser.lblManufacturer")}</Label>
          <Input value={form.manufacturer} onChange={(e) => form.setManufacturer(e.target.value)} className="h-9" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("dispenser.lblModel")}</Label>
          <Input value={form.model} onChange={(e) => form.setModel(e.target.value)} className="h-9" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("dispenser.lblFuelType")}</Label>
          <Select value={form.fuelType} onValueChange={form.setFuelType}>
            <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {FUEL_TYPES.map((f) => <SelectItem key={f} value={f}>{fuelTypeLabel(f, lang)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("dispenser.lblMaxFlow")}</Label>
          <Input type="number" step="1" min="1" max="200" value={form.maxFlowLpm} onChange={(e) => form.setMaxFlowLpm(Number(e.target.value))} className="h-9" dir="ltr" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("dispenser.lblEspId")}</Label>
          <Input value={form.espDeviceId} onChange={(e) => form.setEspDeviceId(e.target.value)} className="h-9 font-mono text-xs" dir="ltr" placeholder="ESP32-DISP-001" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("dispenser.lblFirmware")}</Label>
          <Input value={form.espFirmware} onChange={(e) => form.setEspFirmware(e.target.value)} className="h-9 font-mono text-xs" dir="ltr" placeholder="v1.0.0" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("dispenser.lblAddress")}</Label>
          <Input type="number" min="1" max="247" value={form.rs485Address} onChange={(e) => form.setRs485Address(Number(e.target.value))} className="h-9" dir="ltr" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("dispenser.lblBaudrate")}</Label>
          <Select value={String(form.rs485Baudrate)} onValueChange={(v) => form.setRs485Baudrate(Number(v))}>
            <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((b) => <SelectItem key={b} value={String(b)}>{String(b)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("dispenser.lblParity")}</Label>
          <Select value={form.rs485Parity} onValueChange={form.setRs485Parity}>
            <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {["8N1", "8E1", "8O1", "7N1", "7E1", "7O1"].map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">{t("dispenser.lblIpAddress")}</Label>
        <Input value={form.ipAddress} onChange={(e) => form.setIpAddress(e.target.value)} className="h-9 font-mono text-xs" dir="ltr" placeholder="10.0.0.10" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">{t("dispenser.lblMacAddress")}</Label>
        <Input value={form.macAddress} onChange={(e) => form.setMacAddress(e.target.value)} className="h-9 font-mono text-xs" dir="ltr" placeholder="02:00:0A:00:00:01" />
      </div>
    </div>
  );
}

function useSiteList() {
  // Subscribe to individual slices: a bare `useFgmp()` re-renders this
  // component on EVERY store write (search keystrokes, view changes,
  // lastTickAt, …) instead of only the slices actually read.
  const snapshot = useFgmp((s) => s.snapshot);

  return useMemo<SiteOption[]>(() => (snapshot?.sites ?? []).map((s) => ({ id: s.id, name: s.name, code: s.code })), [snapshot]);
}

function CreateDispenserDialog({ open, onOpenChange, onCreated, lang }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
  lang: Language;
}) {
  const t = useT();
  const sites = useSiteList();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    siteId: "", label: "", manufacturer: "Tatsuno", model: "CR-200",
    nozzleCount: 1, fuelType: "DIESEL", maxFlowLpm: 40,
    espDeviceId: "", espFirmware: "v1.0.0",
    rs485Baudrate: 9600, rs485Address: 1, rs485Parity: "8N1",
    ipAddress: "", macAddress: "",
  });

  useEffect(() => {
    if (open) {
      setForm((f) => ({ ...f, siteId: f.siteId || (sites[0]?.id ?? "") }));
    }
  }, [open, sites]);

  const update = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const onSubmit = async () => {
    if (!form.siteId || !form.label || !form.espDeviceId) {
      toast.error(t("dispenser.createFailed"), { description: "siteId, label, espDeviceId required" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiPost("/api/fgmp/dispensers", {
        siteId: form.siteId,
        label: form.label,
        manufacturer: form.manufacturer,
        model: form.model,
        nozzleCount: form.nozzleCount,
        fuelType: form.fuelType,
        maxFlowLpm: form.maxFlowLpm,
        espDeviceId: form.espDeviceId,
        espFirmware: form.espFirmware,
        rs485Baudrate: form.rs485Baudrate,
        rs485Address: form.rs485Address,
        rs485Parity: form.rs485Parity,
        ipAddress: form.ipAddress || undefined,
        macAddress: form.macAddress || undefined,
      });
      if (res.ok) {
        toast.success(t("dispenser.created"));
        setForm({
          siteId: sites[0]?.id ?? "", label: "", manufacturer: "Tatsuno", model: "CR-200",
          nozzleCount: 1, fuelType: "DIESEL", maxFlowLpm: 40,
          espDeviceId: "", espFirmware: "v1.0.0",
          rs485Baudrate: 9600, rs485Address: 1, rs485Parity: "8N1",
          ipAddress: "", macAddress: "",
        });
        onCreated();
      } else {
        const data = res.data as { error?: string } | undefined;
        if (data?.error === "espDeviceId already in use") {
          toast.error(t("dispenser.invalidEspId"));
        } else {
          toast.error(data?.error ?? t("dispenser.createFailed"));
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setForm((f) => ({ ...f, label: "", espDeviceId: "", ipAddress: "", macAddress: "" })); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("dispenser.createTitle")}</DialogTitle>
          <DialogDescription>{t("desc.dispensers")}</DialogDescription>
        </DialogHeader>
        <DispenserFormFields form={{
          siteId: form.siteId, setSiteId: (v) => update("siteId", v),
          label: form.label, setLabel: (v) => update("label", v),
          manufacturer: form.manufacturer, setManufacturer: (v) => update("manufacturer", v),
          model: form.model, setModel: (v) => update("model", v),
          nozzleCount: form.nozzleCount, setNozzleCount: (v) => update("nozzleCount", v),
          fuelType: form.fuelType, setFuelType: (v) => update("fuelType", v),
          maxFlowLpm: form.maxFlowLpm, setMaxFlowLpm: (v) => update("maxFlowLpm", v),
          espDeviceId: form.espDeviceId, setEspDeviceId: (v) => update("espDeviceId", v),
          espFirmware: form.espFirmware, setEspFirmware: (v) => update("espFirmware", v),
          rs485Baudrate: form.rs485Baudrate, setRs485Baudrate: (v) => update("rs485Baudrate", v),
          rs485Address: form.rs485Address, setRs485Address: (v) => update("rs485Address", v),
          rs485Parity: form.rs485Parity, setRs485Parity: (v) => update("rs485Parity", v),
          ipAddress: form.ipAddress, setIpAddress: (v) => update("ipAddress", v),
          macAddress: form.macAddress, setMacAddress: (v) => update("macAddress", v),
        }} lang={lang} sites={sites} />
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>{t("common.cancel")}</Button>
          <Button onClick={onSubmit} disabled={submitting} className="bg-emerald-500 hover:bg-emerald-600 text-white">
            {submitting ? "…" : t("common.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDispenserDialog({ target, onOpenChange, onSaved, lang }: {
  target: DispenserRow | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
  lang: Language;
}) {
  const t = useT();
  const sites = useSiteList();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    siteId: "", label: "", manufacturer: "", model: "",
    nozzleCount: 1, fuelType: "DIESEL", maxFlowLpm: 40,
    espDeviceId: "", espFirmware: "v1.0.0",
    rs485Baudrate: 9600, rs485Address: 1, rs485Parity: "8N1",
    ipAddress: "", macAddress: "",
  });

  useEffect(() => {
    if (target) {
      setForm({
        siteId: target.siteId, label: target.label, manufacturer: target.manufacturer, model: target.model,
        nozzleCount: target.nozzleCount, fuelType: target.fuelType, maxFlowLpm: target.maxFlowLpm,
        espDeviceId: target.espDeviceId, espFirmware: target.espFirmware,
        rs485Baudrate: target.rs485Baudrate, rs485Address: target.rs485Address, rs485Parity: target.rs485Parity,
        ipAddress: target.ipAddress ?? "",
    macAddress: target.macAddress ?? "",
      });
    }
  }, [target]);

  const update = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const onSubmit = async () => {
    if (!target) return;
    setSubmitting(true);
    try {
      const res = await apiPatch(`/api/fgmp/dispensers/${target.id}`, {
        siteId: form.siteId,
        label: form.label,
        manufacturer: form.manufacturer,
        model: form.model,
        nozzleCount: form.nozzleCount,
        fuelType: form.fuelType,
        maxFlowLpm: form.maxFlowLpm,
        espFirmware: form.espFirmware,
        rs485Baudrate: form.rs485Baudrate,
        rs485Address: form.rs485Address,
        rs485Parity: form.rs485Parity,
        ipAddress: form.ipAddress || undefined,
        macAddress: form.macAddress || undefined,
      });
      if (res.ok) {
        toast.success(t("dispenser.updated"));
        onSaved();
      } else {
        const data = res.data as { error?: string } | undefined;
        toast.error(data?.error ?? t("dispenser.updateFailed"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("dispenser.editTitle")}</DialogTitle>
          <DialogDescription>{target?.label} · <span className="font-mono" dir="ltr">{target?.espDeviceId}</span></DialogDescription>
        </DialogHeader>
        <DispenserFormFields form={{
          siteId: form.siteId, setSiteId: (v) => update("siteId", v),
          label: form.label, setLabel: (v) => update("label", v),
          manufacturer: form.manufacturer, setManufacturer: (v) => update("manufacturer", v),
          model: form.model, setModel: (v) => update("model", v),
          nozzleCount: form.nozzleCount, setNozzleCount: (v) => update("nozzleCount", v),
          fuelType: form.fuelType, setFuelType: (v) => update("fuelType", v),
          maxFlowLpm: form.maxFlowLpm, setMaxFlowLpm: (v) => update("maxFlowLpm", v),
          espDeviceId: form.espDeviceId, setEspDeviceId: (v) => update("espDeviceId", v),
          espFirmware: form.espFirmware, setEspFirmware: (v) => update("espFirmware", v),
          rs485Baudrate: form.rs485Baudrate, setRs485Baudrate: (v) => update("rs485Baudrate", v),
          rs485Address: form.rs485Address, setRs485Address: (v) => update("rs485Address", v),
          rs485Parity: form.rs485Parity, setRs485Parity: (v) => update("rs485Parity", v),
          ipAddress: form.ipAddress, setIpAddress: (v) => update("ipAddress", v),
          macAddress: form.macAddress, setMacAddress: (v) => update("macAddress", v),
        }} lang={lang} sites={sites} />
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>{t("common.cancel")}</Button>
          <Button onClick={onSubmit} disabled={submitting}>{submitting ? "…" : t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AuthorizeDialog({ target, onOpenChange, onConfirm, lang, limitMode = false }: {
  target: DispenserRow | null;
  onOpenChange: (o: boolean) => void;
  onConfirm: (d: DispenserRow, preset?: number) => void;
  lang: Language;
  /** SET_LIMIT reuses this dialog with a limit-specific title. */
  limitMode?: boolean;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  // The input is uncontrolled + keyed by target.id, so the field is fresh
  // each time a different dispenser is targeted (no setState-in-effect).
  const targetKey = target?.id ?? "none";

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="h-4 w-4 text-emerald-500" />
            {limitMode ? t("dispenser.setLimitTitle") : t("dispenser.authorizeTitle")}
          </DialogTitle>
          <DialogDescription>{target?.label} · {target?.site?.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground" dir={lang === "ar" ? "rtl" : undefined}>
            {limitMode ? t("dispenser.setLimitDesc") : t("dispenser.authorizeDesc")}
          </p>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("dispenser.presetVolume")}</Label>
            <Input
              key={targetKey}
              ref={inputRef}
              type="number"
              min="1"
              max="10000"
              step="0.1"
              className="h-9"
              dir="ltr"
              placeholder={t("dispenser.presetOptional")}
            />
          </div>
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            onClick={() => {
              if (!target) return;
              const raw = inputRef.current?.value ?? "";
              onConfirm(target, raw ? Number(raw) : undefined);
            }}
            className="bg-emerald-500 hover:bg-emerald-600 text-white"
          >
            <Play className="mr-1.5 h-4 w-4" />{t("dispenser.cmdAuthorize")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteConfirmDialog({ target, onOpenChange, onDeleted, lang }: {
  target: DispenserRow | null;
  onOpenChange: (o: boolean) => void;
  onDeleted: () => void;
  lang: Language;
}) {
  const t = useT();
  const [deleting, setDeleting] = useState(false);

  const onConfirm = async () => {
    if (!target) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/fgmp/dispensers/${target.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        toast.success(t("dispenser.deleted"));
        onDeleted();
      } else {
        const json = await res.json().catch(() => ({}));
        toast.error((json as { error?: string }).error ?? t("dispenser.deleteFailed"));
      }
    } finally {
      setDeleting(false);
    }
  };

  void lang;

  return (
    <AlertDialog open={!!target} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-rose-500" />{t("dispenser.deleteTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("dispenser.confirmDelete")}
            <br />
            <span className="font-medium text-foreground">{target?.label}</span>
            {" · "}
            <span className="font-mono text-[10px]" dir="ltr">{target?.espDeviceId}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); void onConfirm(); }}
            disabled={deleting}
            className="bg-rose-500 hover:bg-rose-600 text-white"
          >
            {deleting ? "…" : t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
