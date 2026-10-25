"use client";

import type React from "react";
import { useState, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Boxes, Fuel, Zap, BatteryCharging, Cpu, Droplets, Search, Plus,
  Pencil, Trash2, MoreVertical, ShieldAlert,
} from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { hasCapability } from "@/lib/fgmp/rbac-core";
import { useApi, apiPost, apiPatch, apiDelete } from "@/lib/fgmp/use-api";
import { cn } from "@/lib/utils";
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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { ResourceError } from "@/components/fgmp/resource-error";

/* ────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────── */

type Tab = "tanks" | "generators" | "batteries" | "iot" | "dispensers";

interface SiteOpt { id: string; name: string; code: string; }

interface TankRow {
  id: string; siteId: string; label: string; fuelType: string;
  capacityLitres: number; currentLitres: number;
  lowThreshold: number; criticalThreshold: number;
  status: string; lastReadingAt?: string | null;
  liveCurrentLitres?: number; liveStatus?: string; liveLastReadingAt?: number;
  site?: SiteOpt;
}

interface GenRow {
  id: string; siteId: string; label: string;
  manufacturer: string; model: string; ratedPowerKw: number;
  fuelType: string; status: string; mode: string; runtimeHours: number;
  temperatureC: number; loadKw: number; fuelRateLph: number;
  lastReadingAt?: string | null;
  liveStatus?: string; liveMode?: string;
  liveRuntimeHours?: number; liveLoadKw?: number;
  liveTemperatureC?: number; liveFuelRateLph?: number; liveLastReadingAt?: number;
  site?: SiteOpt;
}

interface BatteryRow {
  id: string; siteId: string; label: string; chemistry: string;
  capacityAh: number; nominalVoltage: number; voltage: number;
  currentA: number; stateOfCharge: number; stateOfHealth: number;
  temperatureC: number; charging: boolean; status: string;
  installedAt: string; lastReadingAt?: string | null;
  liveVoltage?: number; liveStateOfCharge?: number;
  liveStateOfHealth?: number; liveStatus?: string;
  liveCharging?: boolean; liveLastReadingAt?: number;
  site?: SiteOpt;
}

interface IotRow {
  id: string; siteId: string; name: string; type: string;
  protocol: string; vendor: string; serialNo: string; firmware: string;
  ipAddress?: string | null; modbusUnit?: number | null;
  status: string; lastSeenAt?: string | null; signalRssi: number;
  otaTargetFw?: string | null; otaStatus?: string | null;
  liveStatus?: string;
  site?: SiteOpt;
}

interface DispenserRow {
  id: string; siteId: string; label: string;
  manufacturer: string; model: string; nozzleCount: number;
  fuelType: string; maxFlowLpm: number;
  espDeviceId: string; espFirmware: string;
  rs485Baudrate: number; rs485Address: number; rs485Parity: string;
  wifiRssi: number; ipAddress?: string | null;
  lastCommAt?: string | null;
  status: string; mode: string;
  flowRateLpm: number; currentVolumeLitres: number;
  totalizerLitres: number; tempC: number;
  liveStatus?: string; liveMode?: string;
  liveTotalizerLitres?: number; liveFlowRateLpm?: number;
  liveWifiRssi?: number; liveLastCommAt?: number;
  site?: SiteOpt;
}

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function AssetRegistryView() {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const { snapshot, me } = useFgmp(useShallow((s) => ({ snapshot: s.snapshot, me: s.me })));
  const [tab, setTab] = useState<Tab>("tanks");
  const isAdmin = me?.role === "ADMIN";

  // Belt-and-suspenders guard for direct /?view=asset-registry deep links.
  //
  // This used to be a hand-written role allowlist that omitted SUPERADMIN, so
  // the platform's highest role — which rbac.ts grants `["*"]`, and which the
  // nav entry for this view is gated on via `view:asset-registry` — was shown
  // "Access denied" here while the sidebar happily rendered the link. Use the
  // same capability check the nav uses so the two can never disagree.
  //
  // `hasCapability` is safe in a client component: rbac.ts is a pure data
  // module (its only import is `import type { Role }` — no Prisma), and
  // AppShell already imports it into the client bundle.
  const canViewRegistry = me ? hasCapability(me.role, "view:asset-registry") : true;

  if (me && !canViewRegistry) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>{t("users.accessDenied")}</AlertTitle>
          <AlertDescription>{t("users.accessDeniedDescription")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const k = snapshot?.kpis;
  const sites = snapshot?.sites ?? [];

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.asset-registry")}
        description={t("desc.asset-registry")}
        icon={<Boxes className="h-5 w-5" />}
        tone="emerald"
      />

      {/* KPI strip — totals per asset type */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          label={t("footer.tanks")}
          value={formatNumber(k?.totalTanks ?? snapshot?.tanks.length ?? 0, numLang)}
          icon={<Fuel className="h-4 w-4" />}
          tone="info"
        />
        <KpiCard
          label={t("footer.generators")}
          value={formatNumber(k?.generatorsTotal ?? snapshot?.generators.length ?? 0, numLang)}
          icon={<Zap className="h-4 w-4" />}
          tone="good"
        />
        <KpiCard
          label={t("batteries.banks")}
          value={formatNumber(snapshot?.batteries.length ?? 0, numLang)}
          icon={<BatteryCharging className="h-4 w-4" />}
          tone="warn"
        />
        <KpiCard
          label={t("nav.iot")}
          value={formatNumber(snapshot?.iotDevices.length ?? 0, numLang)}
          icon={<Cpu className="h-4 w-4" />}
          tone="info"
        />
        <KpiCard
          label={t("dispenser.kpiTotal")}
          value={formatNumber(k?.dispensersTotal ?? snapshot?.dispensers.length ?? 0, numLang)}
          icon={<Droplets className="h-4 w-4" />}
          tone="good"
        />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-5 h-auto">
          <TabsTrigger value="tanks" className="text-xs">
            <Fuel className="mr-1.5 h-3.5 w-3.5" />
            {t("footer.tanks")}
          </TabsTrigger>
          <TabsTrigger value="generators" className="text-xs">
            <Zap className="mr-1.5 h-3.5 w-3.5" />
            {t("footer.generators")}
          </TabsTrigger>
          <TabsTrigger value="batteries" className="text-xs">
            <BatteryCharging className="mr-1.5 h-3.5 w-3.5" />
            {t("batteries.banks")}
          </TabsTrigger>
          <TabsTrigger value="iot" className="text-xs">
            <Cpu className="mr-1.5 h-3.5 w-3.5" />
            {t("nav.iot")}
          </TabsTrigger>
          <TabsTrigger value="dispensers" className="text-xs">
            <Droplets className="mr-1.5 h-3.5 w-3.5" />
            {t("nav.dispensers")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tanks" className="mt-4">
          <TanksTab sites={sites} isAdmin={isAdmin} numLang={numLang} />
        </TabsContent>
        <TabsContent value="generators" className="mt-4">
          <GeneratorsTab sites={sites} isAdmin={isAdmin} numLang={numLang} />
        </TabsContent>
        <TabsContent value="batteries" className="mt-4">
          <BatteriesTab sites={sites} isAdmin={isAdmin} numLang={numLang} />
        </TabsContent>
        <TabsContent value="iot" className="mt-4">
          <IotTab sites={sites} isAdmin={isAdmin} numLang={numLang} />
        </TabsContent>
        <TabsContent value="dispensers" className="mt-4">
          <DispensersTab sites={sites} isAdmin={isAdmin} numLang={numLang} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Shared building blocks
 * ──────────────────────────────────────────────────────────────────────── */

function SiteSelect({ value, onChange, sites, lang }: {
  value: string; onChange: (v: string) => void;
  sites: SiteOpt[]; lang: Language;
}) {
  void lang;
  const t = useT();
  return (
    <Select label={t("sites.site")} value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full"><SelectValue placeholder={t("common.selectSite")} /></SelectTrigger>
      <SelectContent className="max-h-72">
        {sites.map((s) => (
          <SelectItem key={s.id} value={s.id}>{s.name} · {s.code}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RegistryTableSkeleton({ cols }: { cols: number }) {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} className="h-9 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

function RowActions({ onEdit, onDelete, disabled }: {
  onEdit: () => void;
  onDelete: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          disabled={disabled}
          aria-label={t("common.actions")}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          {t("common.edit")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onDelete}
          className="text-rose-700 dark:text-rose-400 focus:text-rose-700 focus:bg-rose-50 dark:focus:bg-rose-950/40"
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          {t("common.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeleteConfirmDialog({ open, onOpenChange, onConfirm, title, message, targetLabel }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: () => Promise<void> | void;
  title: string;
  message: string;
  targetLabel: string;
}) {
  const t = useT();
  const [deleting, setDeleting] = useState(false);
  const onConfirmClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    setDeleting(true);
    try { await onConfirm(); } finally { setDeleting(false); }
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-rose-500" />
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {message}
            <br />
            <span className="font-medium text-foreground">{targetLabel}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirmClick}
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

/* ────────────────────────────────────────────────────────────────────────
 * Tab 1: Fuel Tanks
 * ──────────────────────────────────────────────────────────────────────── */

const TANK_STATUSES = ["OPERATIONAL", "MAINTENANCE", "OFFLINE", "EMPTY"];
const TANK_FUEL_TYPES = ["DIESEL", "PETROL"];

function TanksTab({ sites, isAdmin, numLang }: {
  sites: SiteOpt[]; isAdmin: boolean; numLang: Language;
}) {
  const t = useT();
  const { data: tanks, loading, error, refetch } = useApi<TankRow[]>("/api/fgmp/tanks", { interval: 10000 });
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [fuelFilter, setFuelFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TankRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TankRow | null>(null);

  const filtered = useMemo(() => {
    let list = tanks ?? [];
    if (statusFilter !== "all") list = list.filter((x) => (x.liveStatus ?? x.status) === statusFilter);
    if (fuelFilter !== "all") list = list.filter((x) => x.fuelType === fuelFilter);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((x) =>
        `${x.label} ${x.fuelType} ${x.site?.name ?? ""} ${x.site?.code ?? ""}`
          .toLowerCase().includes(needle),
      );
    }
    return list;
  }, [tanks, q, statusFilter, fuelFilter]);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-sm">
          {t("footer.tanks")} ({formatNumber(filtered.length, numLang)})
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={t("common.search")}
              className="h-9 w-[200px] pl-8"
            />
          </div>
          <Select label={t("common.status")} value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-[150px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.all")}</SelectItem>
              {TANK_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select label={t("assets.fuelType")} value={fuelFilter} onValueChange={setFuelFilter}>
            <SelectTrigger className="h-9 w-[140px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.all")}</SelectItem>
              {TANK_FUEL_TYPES.map((f) => (
                <SelectItem key={f} value={f}>{f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isAdmin && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">{t("assets.addTank")}</span>
            </Button>
          )}
        </div>
      </CardHeader>

      <div className="px-6">
        <ResourceError error={error} onRetry={refetch} compact className="mb-3" />
      </div>
      <CardContent className="p-0">
        {loading && !tanks ? (
          <RegistryTableSkeleton cols={6} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Fuel} title={t("registry.noTanks")} description={t("registry.noTanksDesc")} />
        ) : (
          <div className="max-h-[600px] overflow-y-auto" tabIndex={0} role="region" aria-label={t("a11y.scrollTankTable")}>
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Tank</TableHead>
                  <TableHead className="hidden md:table-cell">{t("common.site")}</TableHead>
                  <TableHead className="w-[100px]">Fuel</TableHead>
                  <TableHead className="w-[140px]">{t("assets.capacityCurrent")}</TableHead>
                  <TableHead className="w-[90px]">{t("common.status")}</TableHead>
                  {isAdmin && <TableHead className="w-[60px] text-right">{t("common.actions")}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((tk) => {
                  const liveCurrent = tk.liveCurrentLitres ?? tk.currentLitres;
                  const pct = tk.capacityLitres > 0 ? Math.min(100, Math.max(0, (liveCurrent / tk.capacityLitres) * 100)) : 0;
                  return (
                    <TableRow key={tk.id} className="hover:bg-muted/30">
                      <TableCell>
                        <p className="text-xs font-medium">{tk.label}</p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {tk.id.slice(-8)}
                        </p>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs">
                        {tk.site?.name ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">{tk.fuelType}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="text-xs">
                          <div className="tabular-nums">
                            {formatNumber(Math.round(liveCurrent), numLang)} / {formatNumber(Math.round(tk.capacityLitres), numLang)} L
                          </div>
                          <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                            {/*
                              The fill level was conveyed by bar colour alone
                              (rose/amber/emerald). Expose it as a meter with a
                              real value + text so it is not colour-only, and so
                              screen readers announce the level rather than
                              nothing.
                            */}
                            <div
                              role="meter"
                              aria-valuenow={Math.round(pct)}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-label={`${t("fuel.tankInventory")} — ${formatNumber(Math.round(pct), numLang)}%`}
                              className={
                                "h-full " +
                                (pct < 10 ? "bg-rose-500" : pct < 25 ? "bg-amber-500" : "bg-emerald-500")
                              }
                              style={{ width: `${pct}%` }}
                            />
                            {/* Text equivalent for the colour-only encoding. */}
                            <span className="sr-only">
                              {formatNumber(Math.round(pct), numLang)}%
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={tk.liveStatus ?? tk.status} className="h-5 text-[9px]" />
                      </TableCell>
                      {isAdmin && (
                        <TableCell className="text-right">
                          <RowActions
                            onEdit={() => setEditTarget(tk)}
                            onDelete={() => setDeleteTarget(tk)}
                          />
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <TankFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        target={null}
        sites={sites}
        lang={numLang}
        onSaved={() => { refetch(); setCreateOpen(false); }}
      />
      <TankFormDialog
        open={!!editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
        target={editTarget}
        sites={sites}
        lang={numLang}
        onSaved={() => { refetch(); setEditTarget(null); }}
      />
      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("assets.deleteTank")}
        message={t("assets.deleteTankMsg")}
        targetLabel={deleteTarget?.label ?? ""}
        onConfirm={async () => {
          if (!deleteTarget) return;
          // apiDelete runs the same capability check the server does, before
          // the request leaves the tab: a role that cannot delete an asset gets
          // a local 403 and NO network call. A raw fetch() here would reach the
          // server and rely on it alone.
          const res = await apiDelete(`/api/fgmp/tanks/${deleteTarget.id}`);
          if (res.ok) {
            toast.success("Tank deleted");
            setDeleteTarget(null);
            refetch();
          } else {
            toast.error(res.error ?? "Failed to delete");
          }
        }}
      />
    </Card>
  );
}

function TankFormDialog({ open, onOpenChange, target, sites, lang, onSaved }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: TankRow | null;
  sites: SiteOpt[];
  lang: Language;
  onSaved: () => void;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    siteId: target?.siteId ?? sites[0]?.id ?? "",
    label: target?.label ?? "",
    fuelType: target?.fuelType ?? "DIESEL",
    capacityLitres: target?.capacityLitres?.toString() ?? "",
    currentLitres: target?.currentLitres?.toString() ?? "",
    lowThreshold: target?.lowThreshold?.toString() ?? "",
    criticalThreshold: target?.criticalThreshold?.toString() ?? "",
    status: target?.status ?? "OPERATIONAL",
  });

  // Re-initialise the form ONLY when the dialog opens or the edited record
  // changes. Both `target` and `sites` are re-created by the 5s /api/fgmp/state
  // poll, so depending on either would wipe the user's in-progress input every
  // 5 seconds (and revert an edit form to create-mode defaults). We key on the
  // record id + `open`, and read `sites` from this render's closure.
  const targetId = target?.id ?? null;
  useEffect(() => {
    if (!open) return;
    setForm({
      siteId: target?.siteId ?? sites[0]?.id ?? "",
      label: target?.label ?? "",
      fuelType: target?.fuelType ?? "DIESEL",
      capacityLitres: target?.capacityLitres?.toString() ?? "",
      currentLitres: target?.currentLitres?.toString() ?? "",
      lowThreshold: target?.lowThreshold?.toString() ?? "",
      criticalThreshold: target?.criticalThreshold?.toString() ?? "",
      status: target?.status ?? "OPERATIONAL",
    });
  // Intentionally keyed on identity, not contents: `target` and `sites` are
  // rebuilt by the 5 s state poll, and re-seeding on them would overwrite
  // whatever the operator has typed since opening the dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, open]);

  const onSubmit = async () => {
    if (!form.siteId || !form.label || !form.capacityLitres) {
      toast.error("Please fill required fields");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        siteId: form.siteId,
        label: form.label,
        fuelType: form.fuelType,
        capacityLitres: Number(form.capacityLitres),
        currentLitres: form.currentLitres ? Number(form.currentLitres) : undefined,
        lowThreshold: form.lowThreshold ? Number(form.lowThreshold) : undefined,
        criticalThreshold: form.criticalThreshold ? Number(form.criticalThreshold) : undefined,
        status: target ? form.status : undefined,
      };
      const res = target
        ? await apiPatch(`/api/fgmp/tanks/${target.id}`, payload)
        : await apiPost("/api/fgmp/tanks", payload);
      if (res.ok) {
        toast.success(target ? "Tank updated" : "Tank created");
        onSaved();
      } else {
        toast.error(res.error ?? "Failed");
      }
    } finally {
      setSubmitting(false);
    }
  };

  void lang;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{target ? "Edit Tank" : "Add Fuel Tank"}</DialogTitle>
          <DialogDescription>
            {target ? "Update tank configuration." : "Register a new fuel storage tank."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5">
            <Label className="text-xs">{t("common.site")}</Label>
            <SiteSelect
              value={form.siteId}
              onChange={(v) => setForm({ ...form, siteId: v })}
              sites={sites}
              lang={lang}
            />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label className="text-xs">Label *</Label>
            <Input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              className="h-9"
              placeholder={t("assets.tankNamePlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("assets.fuelType")}</Label>
            <Select label={t("assets.fuelType")} value={form.fuelType} onValueChange={(v) => setForm({ ...form, fuelType: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TANK_FUEL_TYPES.map((f) => (
                  <SelectItem key={f} value={f}>{f}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {target && (
            <div className="space-y-1.5">
              <Label className="text-xs">Status</Label>
              <Select label={t("common.status")} value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TANK_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">Capacity (L) *</Label>
            <Input
              type="number" value={form.capacityLitres}
              onChange={(e) => setForm({ ...form, capacityLitres: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Current (L)</Label>
            <Input
              type="number" value={form.currentLitres}
              onChange={(e) => setForm({ ...form, currentLitres: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Low Threshold (L)</Label>
            <Input
              type="number" value={form.lowThreshold}
              onChange={(e) => setForm({ ...form, lowThreshold: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Critical Threshold (L)</Label>
            <Input
              type="number" value={form.criticalThreshold}
              onChange={(e) => setForm({ ...form, criticalThreshold: e.target.value })}
              className="h-9"
            />
          </div>
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? "…" : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Tab 2: Generators
 * ──────────────────────────────────────────────────────────────────────── */

const GEN_STATUSES = ["RUNNING", "STOPPED", "FAULT", "MAINTENANCE", "OFFLINE"];
const GEN_MODES = ["AUTO", "MANUAL", "REMOTE"];

function GeneratorsTab({ sites, isAdmin, numLang }: {
  sites: SiteOpt[]; isAdmin: boolean; numLang: Language;
}) {
  const t = useT();
  const { data: generators, loading, error, refetch } = useApi<GenRow[]>("/api/fgmp/generators", { interval: 10000 });
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<GenRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GenRow | null>(null);

  const filtered = useMemo(() => {
    let list = generators ?? [];
    if (statusFilter !== "all") list = list.filter((g) => (g.liveStatus ?? g.status) === statusFilter);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((g) =>
        `${g.label} ${g.manufacturer} ${g.model} ${g.site?.name ?? ""}`.toLowerCase().includes(needle),
      );
    }
    return list;
  }, [generators, q, statusFilter]);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-sm">
          {t("footer.generators")} ({formatNumber(filtered.length, numLang)})
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={t("generators.search")}
              className="h-9 w-[200px] pl-8"
            />
          </div>
          <Select label={t("common.status")} value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-[150px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.all")}</SelectItem>
              {GEN_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isAdmin && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">{t("assets.addGenerator")}</span>
            </Button>
          )}
        </div>
      </CardHeader>

      <div className="px-6">
        <ResourceError error={error} onRetry={refetch} compact className="mb-3" />
      </div>
      <CardContent className="p-0">
        {loading && !generators ? (
          <RegistryTableSkeleton cols={6} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Zap} title={t("registry.noGenerators")} description={t("registry.noGeneratorsDesc")} />
        ) : (
          <div className="max-h-[600px] overflow-y-auto" tabIndex={0} role="region" aria-label={t("a11y.scrollGeneratorTable")}>
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Generator</TableHead>
                  <TableHead className="hidden md:table-cell">{t("common.site")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("assets.makeModel")}</TableHead>
                  <TableHead className="w-[100px]">{t("generators.load")}</TableHead>
                  <TableHead className="w-[110px]">{t("generators.runtime")}</TableHead>
                  <TableHead className="w-[90px]">{t("common.status")}</TableHead>
                  {isAdmin && <TableHead className="w-[60px] text-right">{t("common.actions")}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((g) => {
                  const runtime = g.liveRuntimeHours ?? g.runtimeHours;
                  const load = g.liveLoadKw ?? g.loadKw;
                  return (
                    <TableRow key={g.id} className="hover:bg-muted/30">
                      <TableCell>
                        <p className="text-xs font-medium">{g.label}</p>
                        <p className="text-[10px] text-muted-foreground tabular-nums">
                          {formatNumber(Math.round(g.ratedPowerKw), numLang)} kW
                        </p>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs">{g.site?.name ?? "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell text-xs">
                        <p>{g.manufacturer}</p>
                        <p className="text-[10px] text-muted-foreground">{g.model}</p>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {formatNumber(Math.round(load), numLang)} kW
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {formatNumber(Math.round(runtime), numLang)}h
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={g.liveStatus ?? g.status} className="h-5 text-[9px]" />
                      </TableCell>
                      {isAdmin && (
                        <TableCell className="text-right">
                          <RowActions
                            onEdit={() => setEditTarget(g)}
                            onDelete={() => setDeleteTarget(g)}
                          />
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <GeneratorFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        target={null}
        sites={sites}
        lang={numLang}
        onSaved={() => { refetch(); setCreateOpen(false); }}
      />
      <GeneratorFormDialog
        open={!!editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
        target={editTarget}
        sites={sites}
        lang={numLang}
        onSaved={() => { refetch(); setEditTarget(null); }}
      />
      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("assets.deleteGenerator")}
        message={t("assets.deleteGeneratorMsg")}
        targetLabel={deleteTarget?.label ?? ""}
        onConfirm={async () => {
          if (!deleteTarget) return;
          // apiDelete runs the same capability check the server does, before
          // the request leaves the tab: a role that cannot delete an asset gets
          // a local 403 and NO network call. A raw fetch() here would reach the
          // server and rely on it alone.
          const res = await apiDelete(`/api/fgmp/generators/${deleteTarget.id}`);
          if (res.ok) {
            toast.success("Generator deleted");
            setDeleteTarget(null);
            refetch();
          } else {
            toast.error(res.error ?? "Failed to delete");
          }
        }}
      />
    </Card>
  );
}

function GeneratorFormDialog({ open, onOpenChange, target, sites, lang, onSaved }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: GenRow | null;
  sites: SiteOpt[];
  lang: Language;
  onSaved: () => void;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    siteId: target?.siteId ?? sites[0]?.id ?? "",
    label: target?.label ?? "",
    manufacturer: target?.manufacturer ?? "",
    model: target?.model ?? "",
    ratedPowerKw: target?.ratedPowerKw?.toString() ?? "",
    fuelType: target?.fuelType ?? "DIESEL",
    status: target?.status ?? "STOPPED",
    mode: target?.mode ?? "AUTO",
    runtimeHours: target?.runtimeHours?.toString() ?? "",
  });

  // Keyed on [targetId, open] only — see TankFormDialog above. `target` and
  // `sites` get a new identity on every 5s store poll and would wipe input.
  const targetId = target?.id ?? null;
  useEffect(() => {
    if (!open) return;
    setForm({
      siteId: target?.siteId ?? sites[0]?.id ?? "",
      label: target?.label ?? "",
      manufacturer: target?.manufacturer ?? "",
      model: target?.model ?? "",
      ratedPowerKw: target?.ratedPowerKw?.toString() ?? "",
      fuelType: target?.fuelType ?? "DIESEL",
      status: target?.status ?? "STOPPED",
      mode: target?.mode ?? "AUTO",
      runtimeHours: target?.runtimeHours?.toString() ?? "",
    });
  // Intentionally keyed on identity, not contents: `target` and `sites` are
  // rebuilt by the 5 s state poll, and re-seeding on them would overwrite
  // whatever the operator has typed since opening the dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, open]);

  const onSubmit = async () => {
    if (!form.siteId || !form.label || !form.manufacturer || !form.model || !form.ratedPowerKw) {
      toast.error("Please fill required fields");
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        siteId: form.siteId,
        label: form.label,
        manufacturer: form.manufacturer,
        model: form.model,
        ratedPowerKw: Number(form.ratedPowerKw),
        fuelType: form.fuelType,
      };
      if (target) {
        payload.status = form.status;
        payload.mode = form.mode;
        if (form.runtimeHours) payload.runtimeHours = Number(form.runtimeHours);
      }
      const res = target
        ? await apiPatch(`/api/fgmp/generators/${target.id}`, payload)
        : await apiPost("/api/fgmp/generators", payload);
      if (res.ok) {
        toast.success(target ? "Generator updated" : "Generator created");
        onSaved();
      } else {
        toast.error(res.error ?? "Failed");
      }
    } finally {
      setSubmitting(false);
    }
  };

  void lang;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{target ? "Edit Generator" : "Add Generator"}</DialogTitle>
          <DialogDescription>
            {target ? "Update generator configuration." : "Register a new backup generator."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5">
            <Label className="text-xs">{t("common.site")}</Label>
            <SiteSelect value={form.siteId} onChange={(v) => setForm({ ...form, siteId: v })} sites={sites} lang={lang} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Label *</Label>
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Rated Power (kW) *</Label>
            <Input type="number" value={form.ratedPowerKw} onChange={(e) => setForm({ ...form, ratedPowerKw: e.target.value })} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Manufacturer *</Label>
            <Input value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Model *</Label>
            <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("assets.fuelType")}</Label>
            <Select label={t("assets.fuelType")} value={form.fuelType} onValueChange={(v) => setForm({ ...form, fuelType: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["DIESEL", "PETROL"].map((f) => (
                  <SelectItem key={f} value={f}>{f}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {target && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Status</Label>
                <Select label={t("common.status")} value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {GEN_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("generators.mode")}</Label>
                <Select label={t("generators.mode")} value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {GEN_MODES.map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("generators.runtime")} (h)</Label>
                <Input type="number" value={form.runtimeHours} onChange={(e) => setForm({ ...form, runtimeHours: e.target.value })} className="h-9" />
              </div>
            </>
          )}
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? "…" : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Tab 3: Battery Banks
 * ──────────────────────────────────────────────────────────────────────── */

const BATT_STATUSES = ["OK", "LOW", "FAILING", "REPLACEMENT_DUE", "OFFLINE"];
const BATT_CHEMISTRIES = ["VRLA", "AGM", "LITHIUM", "GEL", "LIPO"];

function BatteriesTab({ sites, isAdmin, numLang }: {
  sites: SiteOpt[]; isAdmin: boolean; numLang: Language;
}) {
  const t = useT();
  const { data: batteries, loading, error, refetch } = useApi<BatteryRow[]>("/api/fgmp/batteries", { interval: 10000 });
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<BatteryRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BatteryRow | null>(null);

  const filtered = useMemo(() => {
    let list = batteries ?? [];
    if (statusFilter !== "all") list = list.filter((b) => (b.liveStatus ?? b.status) === statusFilter);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((b) =>
        `${b.label} ${b.chemistry} ${b.site?.name ?? ""}`.toLowerCase().includes(needle),
      );
    }
    return list;
  }, [batteries, q, statusFilter]);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-sm">
          {t("batteries.banks")} ({formatNumber(filtered.length, numLang)})
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={t("batteries.search")}
              className="h-9 w-[200px] pl-8"
            />
          </div>
          <Select label={t("common.status")} value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-[150px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.all")}</SelectItem>
              {BATT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isAdmin && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">{t("assets.addBattery")}</span>
            </Button>
          )}
        </div>
      </CardHeader>

      <div className="px-6">
        <ResourceError error={error} onRetry={refetch} compact className="mb-3" />
      </div>
      <CardContent className="p-0">
        {loading && !batteries ? (
          <RegistryTableSkeleton cols={6} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={BatteryCharging} title={t("registry.noBatteries")} description={t("registry.noBatteriesDesc")} />
        ) : (
          <div className="max-h-[600px] overflow-y-auto" tabIndex={0} role="region" aria-label={t("a11y.scrollBatteryTable")}>
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Battery</TableHead>
                  <TableHead className="hidden md:table-cell">{t("common.site")}</TableHead>
                  <TableHead className="w-[100px]">Chemistry</TableHead>
                  <TableHead className="w-[110px]">{t("batteries.voltage")}</TableHead>
                  <TableHead className="w-[90px]">SOC</TableHead>
                  <TableHead className="w-[90px]">{t("common.status")}</TableHead>
                  {isAdmin && <TableHead className="w-[60px] text-right">{t("common.actions")}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((b) => {
                  const soc = b.liveStateOfCharge ?? b.stateOfCharge;
                  const v = b.liveVoltage ?? b.voltage;
                  return (
                    <TableRow key={b.id} className="hover:bg-muted/30">
                      <TableCell>
                        <p className="text-xs font-medium">{b.label}</p>
                        <p className="text-[10px] text-muted-foreground tabular-nums">
                          {formatNumber(Math.round(b.capacityAh), numLang)} Ah · {formatNumber(b.nominalVoltage, numLang)}V
                        </p>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs">{b.site?.name ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">{b.chemistry}</Badge>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {formatNumber(v.toFixed(1), numLang)}V
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <div className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
                            <div
                              className={
                                "h-full " +
                                (soc < 25 ? "bg-rose-500" : soc < 50 ? "bg-amber-500" : "bg-emerald-500")
                              }
                              style={{ width: `${Math.min(100, soc)}%` }}
                            />
                          </div>
                          <span className="text-[10px] tabular-nums">{formatNumber(Math.round(soc), numLang)}%</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={b.liveStatus ?? b.status} className="h-5 text-[9px]" />
                      </TableCell>
                      {isAdmin && (
                        <TableCell className="text-right">
                          <RowActions
                            onEdit={() => setEditTarget(b)}
                            onDelete={() => setDeleteTarget(b)}
                          />
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <BatteryFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        target={null}
        sites={sites}
        lang={numLang}
        onSaved={() => { refetch(); setCreateOpen(false); }}
      />
      <BatteryFormDialog
        open={!!editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
        target={editTarget}
        sites={sites}
        lang={numLang}
        onSaved={() => { refetch(); setEditTarget(null); }}
      />
      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("assets.deleteBattery")}
        message={t("assets.deleteBatteryMsg")}
        targetLabel={deleteTarget?.label ?? ""}
        onConfirm={async () => {
          if (!deleteTarget) return;
          // apiDelete runs the same capability check the server does, before
          // the request leaves the tab: a role that cannot delete an asset gets
          // a local 403 and NO network call. A raw fetch() here would reach the
          // server and rely on it alone.
          const res = await apiDelete(`/api/fgmp/batteries/${deleteTarget.id}`);
          if (res.ok) {
            toast.success("Battery deleted");
            setDeleteTarget(null);
            refetch();
          } else {
            toast.error(res.error ?? "Failed to delete");
          }
        }}
      />
    </Card>
  );
}

function BatteryFormDialog({ open, onOpenChange, target, sites, lang, onSaved }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: BatteryRow | null;
  sites: SiteOpt[];
  lang: Language;
  onSaved: () => void;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    siteId: target?.siteId ?? sites[0]?.id ?? "",
    label: target?.label ?? "",
    chemistry: target?.chemistry ?? "VRLA",
    capacityAh: target?.capacityAh?.toString() ?? "",
    nominalVoltage: target?.nominalVoltage?.toString() ?? "48",
    voltage: target?.voltage?.toString() ?? "",
    stateOfCharge: target?.stateOfCharge?.toString() ?? "",
    stateOfHealth: target?.stateOfHealth?.toString() ?? "",
    status: target?.status ?? "OK",
  });

  // Keyed on [targetId, open] only — see TankFormDialog above. `target` and
  // `sites` get a new identity on every 5s store poll and would wipe input.
  const targetId = target?.id ?? null;
  useEffect(() => {
    if (!open) return;
    setForm({
      siteId: target?.siteId ?? sites[0]?.id ?? "",
      label: target?.label ?? "",
      chemistry: target?.chemistry ?? "VRLA",
      capacityAh: target?.capacityAh?.toString() ?? "",
      nominalVoltage: target?.nominalVoltage?.toString() ?? "48",
      voltage: target?.voltage?.toString() ?? "",
      stateOfCharge: target?.stateOfCharge?.toString() ?? "",
      stateOfHealth: target?.stateOfHealth?.toString() ?? "",
      status: target?.status ?? "OK",
    });
  // Intentionally keyed on identity, not contents: `target` and `sites` are
  // rebuilt by the 5 s state poll, and re-seeding on them would overwrite
  // whatever the operator has typed since opening the dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, open]);

  const onSubmit = async () => {
    if (!form.siteId || !form.label || !form.capacityAh || !form.nominalVoltage) {
      toast.error("Please fill required fields");
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        siteId: form.siteId,
        label: form.label,
        chemistry: form.chemistry,
        capacityAh: Number(form.capacityAh),
        nominalVoltage: Number(form.nominalVoltage),
      };
      if (target) {
        if (form.voltage) payload.voltage = Number(form.voltage);
        if (form.stateOfCharge) payload.stateOfCharge = Number(form.stateOfCharge);
        if (form.stateOfHealth) payload.stateOfHealth = Number(form.stateOfHealth);
        payload.status = form.status;
      }
      const res = target
        ? await apiPatch(`/api/fgmp/batteries/${target.id}`, payload)
        : await apiPost("/api/fgmp/batteries", payload);
      if (res.ok) {
        toast.success(target ? "Battery updated" : "Battery created");
        onSaved();
      } else {
        toast.error(res.error ?? "Failed");
      }
    } finally {
      setSubmitting(false);
    }
  };

  void lang;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{target ? "Edit Battery" : "Add Battery Bank"}</DialogTitle>
          <DialogDescription>
            {target ? "Update battery bank configuration." : "Register a new battery bank."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5">
            <Label className="text-xs">{t("common.site")}</Label>
            <SiteSelect value={form.siteId} onChange={(v) => setForm({ ...form, siteId: v })} sites={sites} lang={lang} />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label className="text-xs">Label *</Label>
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Chemistry</Label>
            <Select label={t("batteries.chemistry")} value={form.chemistry} onValueChange={(v) => setForm({ ...form, chemistry: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {BATT_CHEMISTRIES.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {target && (
            <div className="space-y-1.5">
              <Label className="text-xs">Status</Label>
              <Select label={t("common.status")} value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {BATT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs">Capacity (Ah) *</Label>
            <Input type="number" value={form.capacityAh} onChange={(e) => setForm({ ...form, capacityAh: e.target.value })} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Nominal Voltage (V) *</Label>
            <Input type="number" value={form.nominalVoltage} onChange={(e) => setForm({ ...form, nominalVoltage: e.target.value })} className="h-9" />
          </div>
          {target && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Voltage (V)</Label>
                <Input type="number" value={form.voltage} onChange={(e) => setForm({ ...form, voltage: e.target.value })} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">SOC (%)</Label>
                <Input type="number" value={form.stateOfCharge} onChange={(e) => setForm({ ...form, stateOfCharge: e.target.value })} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">SOH (%)</Label>
                <Input type="number" value={form.stateOfHealth} onChange={(e) => setForm({ ...form, stateOfHealth: e.target.value })} className="h-9" />
              </div>
            </>
          )}
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? "…" : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Tab 4: IoT Devices
 * ──────────────────────────────────────────────────────────────────────── */

const IOT_STATUSES = ["ONLINE", "OFFLINE", "DEGRADED", "PROVISIONING"];
const IOT_TYPES = ["FUEL_SENSOR", "GENERATOR_CONTROLLER", "BATTERY_SENSOR", "POWER_METER", "ENVIRONMENTAL"];
const IOT_PROTOCOLS = ["RS485", "MODBUS_RTU", "MODBUS_TCP", "MQTT", "HTTP", "SNMP"];

function IotTab({ sites, isAdmin, numLang }: {
  sites: SiteOpt[]; isAdmin: boolean; numLang: Language;
}) {
  const t = useT();
  const { data: devices, loading, error, refetch } = useApi<IotRow[]>("/api/fgmp/iot", { interval: 10000 });
  const [q, setQ] = useState("");
  const [protocol, setProtocol] = useState("all");
  const [type, setType] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<IotRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IotRow | null>(null);

  const filtered = useMemo(() => {
    let list = devices ?? [];
    if (protocol !== "all") list = list.filter((d) => d.protocol === protocol);
    if (type !== "all") list = list.filter((d) => d.type === type);
    if (statusFilter !== "all") list = list.filter((d) => (d.liveStatus ?? d.status) === statusFilter);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((d) =>
        `${d.name} ${d.serialNo} ${d.vendor} ${d.firmware} ${d.site?.name ?? ""}`.toLowerCase().includes(needle),
      );
    }
    return list;
  }, [devices, q, protocol, type, statusFilter]);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-sm">
          {t("nav.iot")} ({formatNumber(filtered.length, numLang)})
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={t("iot.search")}
              className="h-9 w-[180px] pl-8"
            />
          </div>
          <Select label={t("iot.protocol")} value={protocol} onValueChange={setProtocol}>
            <SelectTrigger className="h-9 w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("iot.allProtocols")}</SelectItem>
              {IOT_PROTOCOLS.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select label={t("iot.deviceType")} value={type} onValueChange={setType}>
            <SelectTrigger className="h-9 w-[150px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.all")}</SelectItem>
              {IOT_TYPES.map((tp) => (
                <SelectItem key={tp} value={tp}>{tp.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select label={t("common.status")} value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.all")}</SelectItem>
              {IOT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isAdmin && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">{t("assets.addDevice")}</span>
            </Button>
          )}
        </div>
      </CardHeader>

      <div className="px-6">
        <ResourceError error={error} onRetry={refetch} compact className="mb-3" />
      </div>
      <CardContent className="p-0">
        {loading && !devices ? (
          <RegistryTableSkeleton cols={6} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Cpu} title={t("registry.noIot")} description={t("registry.noIotDesc")} />
        ) : (
          <div className="max-h-[600px] overflow-y-auto" tabIndex={0} role="region" aria-label={t("a11y.scrollDeviceTable")}>
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead className="hidden md:table-cell">{t("common.site")}</TableHead>
                  <TableHead className="w-[130px]">{t("common.type")}</TableHead>
                  <TableHead className="w-[110px]">{t("iot.protocol")}</TableHead>
                  <TableHead className="hidden lg:table-cell w-[90px]">{t("iot.firmware")}</TableHead>
                  <TableHead className="w-[90px]">{t("common.status")}</TableHead>
                  {isAdmin && <TableHead className="w-[60px] text-right">{t("common.actions")}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((d) => (
                  <TableRow key={d.id} className="hover:bg-muted/30">
                    <TableCell>
                      <p className="text-xs font-medium">{d.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{d.serialNo}</p>
                      <p className="text-[10px] text-muted-foreground">{d.vendor}</p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs">{d.site?.name ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[9px]">{d.type.replace(/_/g, " ")}</Badge>
                    </TableCell>
                    <TableCell className="text-[11px]">{d.protocol}</TableCell>
                    <TableCell className="hidden lg:table-cell text-[10px] font-mono">{d.firmware}</TableCell>
                    <TableCell>
                      <StatusBadge value={d.liveStatus ?? d.status} className="h-5 text-[9px]" />
                    </TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        <RowActions
                          onEdit={() => setEditTarget(d)}
                          onDelete={() => setDeleteTarget(d)}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <IotFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        target={null}
        sites={sites}
        lang={numLang}
        onSaved={() => { refetch(); setCreateOpen(false); }}
      />
      <IotFormDialog
        open={!!editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
        target={editTarget}
        sites={sites}
        lang={numLang}
        onSaved={() => { refetch(); setEditTarget(null); }}
      />
      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("assets.deleteDevice")}
        message={t("assets.deleteDeviceMsg")}
        targetLabel={deleteTarget?.name ?? ""}
        onConfirm={async () => {
          if (!deleteTarget) return;
          // No dedicated IoT delete endpoint — use the generic site asset cleanup
          // path via a direct DB delete through a future endpoint. For now,
          // refuse gracefully.
          toast.error("IoT device delete not yet wired (no DELETE endpoint). Use the iot-bridge admin console.");
          setDeleteTarget(null);
        }}
      />
    </Card>
  );
}

function IotFormDialog({ open, onOpenChange, target, sites, lang, onSaved }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: IotRow | null;
  sites: SiteOpt[];
  lang: Language;
  onSaved: () => void;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    siteId: target?.siteId ?? sites[0]?.id ?? "",
    name: target?.name ?? "",
    type: target?.type ?? "FUEL_SENSOR",
    protocol: target?.protocol ?? "RS485",
    vendor: target?.vendor ?? "",
    serialNo: target?.serialNo ?? "",
    firmware: target?.firmware ?? "v1.0.0",
    ipAddress: target?.ipAddress ?? "",
    modbusUnit: target?.modbusUnit?.toString() ?? "",
    status: target?.status ?? "ONLINE",
  });

  // Keyed on [targetId, open] only — see TankFormDialog above. `target` and
  // `sites` get a new identity on every 5s store poll and would wipe input.
  const targetId = target?.id ?? null;
  useEffect(() => {
    if (!open) return;
    setForm({
      siteId: target?.siteId ?? sites[0]?.id ?? "",
      name: target?.name ?? "",
      type: target?.type ?? "FUEL_SENSOR",
      protocol: target?.protocol ?? "RS485",
      vendor: target?.vendor ?? "",
      serialNo: target?.serialNo ?? "",
      firmware: target?.firmware ?? "v1.0.0",
      ipAddress: target?.ipAddress ?? "",
      modbusUnit: target?.modbusUnit?.toString() ?? "",
      status: target?.status ?? "ONLINE",
    });
  // Intentionally keyed on identity, not contents: `target` and `sites` are
  // rebuilt by the 5 s state poll, and re-seeding on them would overwrite
  // whatever the operator has typed since opening the dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, open]);

  const onSubmit = async () => {
    if (!form.siteId || !form.name || !form.vendor || !form.serialNo) {
      toast.error("Please fill required fields");
      return;
    }
    setSubmitting(true);
    try {
      // Note: IoT device CRUD is done via the iot-bridge mini-service / ingest
      // API in production. For this registry UI, we POST/PATCH through the
      // generic /api/fgmp/iot endpoint which accepts ota/reboot actions only.
      // Here we just optimistically refresh and show a notice.
      toast.info(
        target
          ? "IoT updates are managed via the iot-bridge admin console."
          : "IoT devices are provisioned via the iot-bridge admin console.",
      );
      onSaved();
    } finally {
      setSubmitting(false);
    }
  };

  void lang;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{target ? "Edit IoT Device" : "Provision IoT Device"}</DialogTitle>
          <DialogDescription>
            {target
              ? "Update device metadata (the iot-bridge mini-service performs the actual mutation in production)."
              : "Register a new IoT device. Production provisioning is performed by the iot-bridge mini-service."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5">
            <Label className="text-xs">{t("common.site")}</Label>
            <SiteSelect value={form.siteId} onChange={(v) => setForm({ ...form, siteId: v })} sites={sites} lang={lang} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("assets.deviceName")}</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Vendor *</Label>
            <Input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("assets.serialNo")}</Label>
            <Input value={form.serialNo} onChange={(e) => setForm({ ...form, serialNo: e.target.value })} className="h-9 font-mono" dir="ltr" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("iot.firmware")}</Label>
            <Input value={form.firmware} onChange={(e) => setForm({ ...form, firmware: e.target.value })} className="h-9 font-mono" dir="ltr" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("common.type")}</Label>
            <Select label={t("iot.deviceType")} value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {IOT_TYPES.map((tp) => (
                  <SelectItem key={tp} value={tp}>{tp.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("iot.protocol")}</Label>
            <Select label={t("iot.protocol")} value={form.protocol} onValueChange={(v) => setForm({ ...form, protocol: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {IOT_PROTOCOLS.map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("assets.ipAddress")}</Label>
            <Input value={form.ipAddress} onChange={(e) => setForm({ ...form, ipAddress: e.target.value })} className="h-9 font-mono" dir="ltr" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("assets.modbusUnit")}</Label>
            <Input type="number" value={form.modbusUnit} onChange={(e) => setForm({ ...form, modbusUnit: e.target.value })} className="h-9" />
          </div>
          {target && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t("common.status")}</Label>
              <Select label={t("common.status")} value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {IOT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? "…" : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Tab 5: Fuel Dispensers (reuses existing /api/fgmp/dispensers endpoints)
 * ──────────────────────────────────────────────────────────────────────── */

const DISP_STATUSES = ["IDLE", "AUTHORIZED", "DISPENSING", "STOPPED", "FAULT", "MAINTENANCE", "OFFLINE"];

function DispensersTab({ sites, isAdmin, numLang }: {
  sites: SiteOpt[]; isAdmin: boolean; numLang: Language;
}) {
  const t = useT();
  const { data: dispensers, loading, error, refetch } = useApi<DispenserRow[]>("/api/fgmp/dispensers", { interval: 10000 });
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [fuelFilter, setFuelFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<DispenserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DispenserRow | null>(null);

  // ── Optimistic create/delete (#20) ──────────────────────────────────────────
  // pendingCreates: temp rows appended instantly on form submit (real ID
  //   back-filled from the API response on success; rolled back on error).
  // pendingDeleteIds: IDs hidden instantly on delete-confirm (restored on
  //   error). savingIds: tracks rows mid-flight for the opacity-50 saving
  //   indicator. All three auto-evict via the derived mergedDispensers below.
  const [pendingCreates, setPendingCreates] = useState<DispenserRow[]>([]);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());

  // Merge polled list with optimistic overlays. Temp-create rows whose real
  // server row has now appeared in the polled list are evicted (matched by
  // espDeviceId since temp IDs never collide with real cuids). Deleted IDs
  // are filtered out. No setState-in-effect — cleanup is purely derived.
  const mergedDispensers = useMemo(() => {
    const polled = dispensers ?? [];
    const polledEspIds = new Set(polled.map((d) => d.espDeviceId));
    const stillPending = pendingCreates.filter((d) => !polledEspIds.has(d.espDeviceId));
    const visiblePolled = polled.filter((d) => !pendingDeleteIds.has(d.id));
    return [...stillPending, ...visiblePolled];
  }, [dispensers, pendingCreates, pendingDeleteIds]);

  // Optimistic create handler — called by DispenserFormDialog when target is
  // null. Builds a temp row, appends it instantly, fires the API, then either
  // promotes the temp to the real server row or rolls it back.
  const handleCreateSubmit = async (payload: {
    siteId: string; label: string; manufacturer: string; model: string;
    nozzleCount: number; fuelType: string; maxFlowLpm: number;
    espDeviceId: string; espFirmware: string;
    rs485Baudrate: number; rs485Address: number; rs485Parity: string;
    ipAddress?: string;
  }): Promise<void> => {
    const tempId = `temp-${Date.now()}`;
    const site = sites.find((s) => s.id === payload.siteId);
    const tempItem: DispenserRow = {
      id: tempId,
      siteId: payload.siteId,
      label: payload.label,
      manufacturer: payload.manufacturer,
      model: payload.model,
      nozzleCount: payload.nozzleCount,
      fuelType: payload.fuelType,
      maxFlowLpm: payload.maxFlowLpm,
      espDeviceId: payload.espDeviceId,
      espFirmware: payload.espFirmware,
      rs485Baudrate: payload.rs485Baudrate,
      rs485Address: payload.rs485Address,
      rs485Parity: payload.rs485Parity,
      wifiRssi: 0,
      ipAddress: payload.ipAddress ?? null,
      lastCommAt: null,
      status: "IDLE",
      mode: "AUTO",
      flowRateLpm: 0,
      currentVolumeLitres: 0,
      totalizerLitres: 0,
      tempC: 0,
      site: site ? { id: site.id, name: site.name, code: site.code } : undefined,
    };
    // Optimistic: append instantly + close dialog + mark saving
    setPendingCreates((prev) => [tempItem, ...prev]);
    setSavingIds((prev) => new Set(prev).add(tempId));
    setCreateOpen(false);

    const res = await apiPost("/api/fgmp/dispensers", payload);
    setSavingIds((prev) => {
      const n = new Set(prev); n.delete(tempId); return n;
    });
    if (res.ok) {
      const real = res.data as DispenserRow | undefined;
      if (real?.id) {
        // Replace temp with real (preserve the joined site from temp since the
        // API response is the bare DispenserState without a `site` relation).
        setPendingCreates((prev) => prev.map((d) => d.id === tempId ? { ...real, site: tempItem.site } : d));
      }
      toast.success(t("common.createSuccess"));
      refetch();
    } else {
      // Rollback: remove the temp row
      setPendingCreates((prev) => prev.filter((d) => d.id !== tempId));
      toast.error(t("common.optimisticError"), { description: res.error });
    }
  };

  // Optimistic delete handler — invoked from DeleteConfirmDialog.onConfirm.
  const handleDeleteConfirm = async (target: DispenserRow): Promise<void> => {
    // Optimistic: hide instantly + close dialog + mark saving
    setPendingDeleteIds((prev) => new Set(prev).add(target.id));
    setSavingIds((prev) => new Set(prev).add(target.id));
    setDeleteTarget(null);

    const res = await apiDelete(`/api/fgmp/dispensers/${target.id}`);
    setSavingIds((prev) => {
      const n = new Set(prev); n.delete(target.id); return n;
    });
    if (res.ok) {
      toast.success(t("common.deleteSuccess"));
      refetch();
    } else {
      // Rollback: restore the row
      setPendingDeleteIds((prev) => {
        const n = new Set(prev); n.delete(target.id); return n;
      });
      toast.error(t("common.optimisticError"), { description: res.error ?? t("dispenser.deleteFailed") });
    }
  };

  const filtered = useMemo(() => {
    let list = mergedDispensers;
    if (statusFilter !== "all") list = list.filter((d) => (d.liveStatus ?? d.status) === statusFilter);
    if (fuelFilter !== "all") list = list.filter((d) => d.fuelType === fuelFilter);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((d) =>
        `${d.label} ${d.espDeviceId} ${d.manufacturer} ${d.model} ${d.site?.name ?? ""}`.toLowerCase().includes(needle),
      );
    }
    return list;
  }, [mergedDispensers, q, statusFilter, fuelFilter]);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-sm">
          {t("nav.dispensers")} ({formatNumber(filtered.length, numLang)})
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={t("dispenser.search")}
              className="h-9 w-[200px] pl-8"
            />
          </div>
          <Select label={t("common.status")} value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-[140px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("dispenser.allStatuses")}</SelectItem>
              {DISP_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`dispenser.status.${s}`) === `dispenser.status.${s}` ? s.replace(/_/g, " ") : t(`dispenser.status.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select label={t("dispenser.lblFuelType")} value={fuelFilter} onValueChange={setFuelFilter}>
            <SelectTrigger className="h-9 w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("dispenser.allFuelTypes")}</SelectItem>
              {["DIESEL", "PETROL"].map((f) => (
                <SelectItem key={f} value={f}>{f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isAdmin && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">{t("dispenser.addDispenser")}</span>
            </Button>
          )}
        </div>
      </CardHeader>

      <div className="px-6">
        <ResourceError error={error} onRetry={refetch} compact className="mb-3" />
      </div>
      <CardContent className="p-0">
        {loading && mergedDispensers.length === 0 ? (
          <RegistryTableSkeleton cols={6} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Droplets} title={t("registry.noDispensers")} description={t("registry.noDispensersDesc")} />
        ) : (
          <div className="max-h-[600px] overflow-y-auto" tabIndex={0} role="region" aria-label={t("a11y.scrollDispenserTable")}>
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>{t("dispenser.colDispenser")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("dispenser.colSite")}</TableHead>
                  <TableHead className="hidden lg:table-cell">ESP</TableHead>
                  <TableHead className="w-[80px]">{t("dispenser.colNozzles")}</TableHead>
                  <TableHead className="w-[100px]">{t("dispenser.colFuelType")}</TableHead>
                  <TableHead className="w-[120px]">{t("dispenser.colTotalizer")}</TableHead>
                  <TableHead className="w-[90px]">{t("common.status")}</TableHead>
                  {isAdmin && <TableHead className="w-[60px] text-right">{t("common.actions")}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((d) => {
                  const totalizer = d.liveTotalizerLitres ?? d.totalizerLitres;
                  const isSaving = savingIds.has(d.id) || d.id.startsWith("temp-");
                  return (
                    <TableRow key={d.id} className={cn("hover:bg-muted/30", isSaving && "opacity-50")}>
                      <TableCell>
                        <p className="text-xs font-medium">{d.label}</p>
                        <p className="text-[10px] text-muted-foreground">{d.manufacturer} {d.model}</p>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs">{d.site?.name ?? "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <p className="font-mono text-[10px]">{d.espDeviceId}</p>
                        <p className="text-[10px] text-muted-foreground">{d.espFirmware}</p>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">{formatNumber(d.nozzleCount, numLang)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[9px]">{d.fuelType}</Badge>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {formatNumber(Math.round(totalizer), numLang)} L
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={d.liveStatus ?? d.status} className="h-5 text-[9px]" />
                      </TableCell>
                      {isAdmin && (
                        <TableCell className="text-right">
                          <RowActions
                            onEdit={() => setEditTarget(d)}
                            onDelete={() => setDeleteTarget(d)}
                            disabled={isSaving}
                          />
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <DispenserFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        target={null}
        sites={sites}
        lang={numLang}
        onSaved={() => { refetch(); setCreateOpen(false); }}
        onCreateSubmit={handleCreateSubmit}
      />
      <DispenserFormDialog
        open={!!editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
        target={editTarget}
        sites={sites}
        lang={numLang}
        onSaved={() => { refetch(); setEditTarget(null); }}
      />
      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t("dispenser.deleteTitle")}
        message={t("dispenser.confirmDelete")}
        targetLabel={deleteTarget?.label ?? ""}
        onConfirm={() => (deleteTarget ? handleDeleteConfirm(deleteTarget) : Promise.resolve())}
      />
    </Card>
  );
}

function DispenserFormDialog({ open, onOpenChange, target, sites, lang, onSaved, onCreateSubmit }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: DispenserRow | null;
  sites: SiteOpt[];
  lang: Language;
  onSaved: () => void;
  /** Optimistic create handler (#20). When provided, the dialog delegates the
   * create API call to the parent so the parent can append a temp row to the
   * list instantly and roll back on error. Only used when `target` is null. */
  onCreateSubmit?: (payload: {
    siteId: string; label: string; manufacturer: string; model: string;
    nozzleCount: number; fuelType: string; maxFlowLpm: number;
    espDeviceId: string; espFirmware: string;
    rs485Baudrate: number; rs485Address: number; rs485Parity: string;
    ipAddress?: string;
  }) => Promise<void>;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    siteId: target?.siteId ?? sites[0]?.id ?? "",
    label: target?.label ?? "",
    manufacturer: target?.manufacturer ?? "",
    model: target?.model ?? "",
    nozzleCount: target?.nozzleCount?.toString() ?? "1",
    fuelType: target?.fuelType ?? "DIESEL",
    maxFlowLpm: target?.maxFlowLpm?.toString() ?? "40",
    espDeviceId: target?.espDeviceId ?? "",
    espFirmware: target?.espFirmware ?? "v1.0.0",
    rs485Baudrate: target?.rs485Baudrate?.toString() ?? "9600",
    rs485Address: target?.rs485Address?.toString() ?? "1",
    rs485Parity: target?.rs485Parity ?? "8N1",
    ipAddress: target?.ipAddress ?? "",
  });

  // Keyed on [targetId, open] only — see TankFormDialog above. `target` and
  // `sites` get a new identity on every 5s store poll and would wipe input.
  const targetId = target?.id ?? null;
  useEffect(() => {
    if (!open) return;
    setForm({
      siteId: target?.siteId ?? sites[0]?.id ?? "",
      label: target?.label ?? "",
      manufacturer: target?.manufacturer ?? "",
      model: target?.model ?? "",
      nozzleCount: target?.nozzleCount?.toString() ?? "1",
      fuelType: target?.fuelType ?? "DIESEL",
      maxFlowLpm: target?.maxFlowLpm?.toString() ?? "40",
      espDeviceId: target?.espDeviceId ?? "",
      espFirmware: target?.espFirmware ?? "v1.0.0",
      rs485Baudrate: target?.rs485Baudrate?.toString() ?? "9600",
      rs485Address: target?.rs485Address?.toString() ?? "1",
      rs485Parity: target?.rs485Parity ?? "8N1",
      ipAddress: target?.ipAddress ?? "",
    });
  // Intentionally keyed on identity, not contents: `target` and `sites` are
  // rebuilt by the 5 s state poll, and re-seeding on them would overwrite
  // whatever the operator has typed since opening the dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, open]);

  const onSubmit = async () => {
    if (!form.siteId || !form.label || !form.manufacturer || !form.model || !form.espDeviceId) {
      toast.error("Please fill required fields");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        siteId: form.siteId,
        label: form.label,
        manufacturer: form.manufacturer,
        model: form.model,
        nozzleCount: Number(form.nozzleCount),
        fuelType: form.fuelType,
        maxFlowLpm: Number(form.maxFlowLpm),
        espDeviceId: form.espDeviceId,
        espFirmware: form.espFirmware,
        rs485Baudrate: Number(form.rs485Baudrate),
        rs485Address: Number(form.rs485Address),
        rs485Parity: form.rs485Parity,
        ipAddress: form.ipAddress || undefined,
      };
      if (target) {
        // Edit path (unchanged) — no optimistic behavior needed for edits.
        const res = await apiPatch(`/api/fgmp/dispensers/${target.id}`, payload);
        if (res.ok) {
          toast.success(t("dispenser.updated"));
          onSaved();
        } else {
          toast.error(res.error ?? "Failed");
        }
      } else if (onCreateSubmit) {
        // Optimistic create path (#20) — parent handles API + state + toast.
        // The parent closes the dialog immediately and appends a temp row.
        await onCreateSubmit(payload);
      } else {
        // Fallback create path (no optimistic — used if onCreateSubmit is not provided).
        const res = await apiPost("/api/fgmp/dispensers", payload);
        if (res.ok) {
          toast.success(t("dispenser.created"));
          onSaved();
        } else {
          toast.error(res.error ?? "Failed");
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  void lang;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{target ? t("dispenser.editTitle") : t("dispenser.createTitle")}</DialogTitle>
          <DialogDescription>{t("desc.dispensers")}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5">
            <Label className="text-xs">{t("common.site")}</Label>
            <SiteSelect value={form.siteId} onChange={(v) => setForm({ ...form, siteId: v })} sites={sites} lang={lang} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("dispenser.lblLabel")}</Label>
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("dispenser.lblManufacturer")}</Label>
            <Input value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Model</Label>
            <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("dispenser.colNozzles")}</Label>
            <Select label={t("dispenser.colNozzles")} value={form.nozzleCount} onValueChange={(v) => setForm({ ...form, nozzleCount: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4].map((n) => (
                  <SelectItem key={n} value={n.toString()}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("dispenser.colFuelType")}</Label>
            <Select label={t("dispenser.lblFuelType")} value={form.fuelType} onValueChange={(v) => setForm({ ...form, fuelType: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["DIESEL", "PETROL"].map((f) => (
                  <SelectItem key={f} value={f}>{f}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Max Flow (L/m)</Label>
            <Input type="number" value={form.maxFlowLpm} onChange={(e) => setForm({ ...form, maxFlowLpm: e.target.value })} className="h-9" />
          </div>
          <div className="col-span-2 border-t pt-2 mt-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">{t("assets.espController")}</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("assets.espDeviceId")}</Label>
            <Input value={form.espDeviceId} onChange={(e) => setForm({ ...form, espDeviceId: e.target.value })} className="h-9 font-mono" dir="ltr" placeholder="ESP32-DISP-001" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("iot.firmware")}</Label>
            <Input value={form.espFirmware} onChange={(e) => setForm({ ...form, espFirmware: e.target.value })} className="h-9 font-mono" dir="ltr" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("dispenser.lblAddress")}</Label>
            <Input type="number" value={form.rs485Address} onChange={(e) => setForm({ ...form, rs485Address: e.target.value })} className="h-9" min={1} max={247} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">RS485 Baudrate</Label>
            <Select label={t("dispenser.lblBaudrate")} value={form.rs485Baudrate} onValueChange={(v) => setForm({ ...form, rs485Baudrate: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["9600", "19200", "38400", "115200"].map((b) => (
                  <SelectItem key={b} value={b}>{b}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">RS485 Parity</Label>
            <Select label={t("dispenser.lblParity")} value={form.rs485Parity} onValueChange={(v) => setForm({ ...form, rs485Parity: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["8N1", "8E1", "8O1", "8N2"].map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("dispenser.lblIpAddress")}</Label>
            <Input value={form.ipAddress} onChange={(e) => setForm({ ...form, ipAddress: e.target.value })} className="h-9 font-mono" dir="ltr" />
          </div>
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? "…" : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
