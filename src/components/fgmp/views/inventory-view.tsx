"use client";

import { useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Truck, Plus, CheckCircle2, Package, TrendingUp, Download, FileCheck } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from "recharts";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPost } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { StatusBadge } from "@/components/fgmp/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { fmtDateTime, fmtLitres } from "@/lib/fgmp/format";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import type { AnalyticsPayload, DeliveryRow, SiteState, TankState } from "@/lib/fgmp/types";
import { translate } from "@/lib/fgmp/i18n";
import { ResourceError } from "@/components/fgmp/resource-error";

/**
 * Resolve a supplier brand string to its localized form, falling back to the
 * raw name. `supplier` is nullable in the schema — the empty check was already
 * there, so the parameter type was the only thing pretending otherwise.
 */
function supplierLabel(supplier: string | null | undefined, lang: Language): string {
  if (!supplier) return "";
  // Known brand mapping
  const map: Record<string, string> = {
    "Yemen Oil Co.": "inventory.supplier.yemenOil",
    "Hadramout Fuel Trading": "inventory.supplier.hadramoutFuel",
    "Aden Petroleum": "inventory.supplier.adenPetroleum",
    "Al-Mokha Diesel Supply": "inventory.supplier.alMokhaDiesel",
  };
  const key = map[supplier];
  if (!key) return supplier;
  const translated = translate(key, lang);
  return translated === key ? supplier : translated;
}

export function InventoryView() {
  const { snapshot, tick } = useFgmp(useShallow((s) => ({ snapshot: s.snapshot, tick: s.tick })));
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const { data: deliveries, error: deliveriesError, refetch } = useApi<DeliveryRow[]>("/api/fgmp/deliveries", { interval: 8000 });
  const { data: analytics, error: analyticsError, refetch: refetchAnalytics } = useApi<AnalyticsPayload>("/api/fgmp/analytics?projection=inventory", { interval: 15000 });
  const [createOpen, setCreateOpen] = useState(false);
  const [verify, setVerify] = useState<{ id: string; vol: number } | null>(null);

  const forecast = analytics?.forecast ?? [];
  const reconciliation = useMemo(() => {
    return (deliveries ?? []).filter((d) => d.status === "DELIVERED" || d.status === "VERIFIED" || d.status === "DISCREPANCY").map((d) => {
      const ordered = d.volumeOrderedLitres;
      const delivered = d.volumeDeliveredLitres ?? 0;
      const diff = delivered - ordered;
      return { ...d, diff, diffPct: ordered ? Math.round((diff / ordered) * 1000) / 10 : 0 };
    });
  }, [deliveries]);

  if (!snapshot) return null;
  const k = snapshot.kpis;
  const scheduled = (deliveries ?? []).filter((d) => d.status === "SCHEDULED");
  const inTransit = (deliveries ?? []).filter((d) => d.status === "IN_TRANSIT");
  const delivered = (deliveries ?? []).filter((d) => d.status === "DELIVERED" || d.status === "VERIFIED");
  const totalVolume = delivered.reduce((a, d) => a + (d.volumeDeliveredLitres ?? 0), 0);

  const dispatch = async (id: string) => {
    const res = await apiPost("/api/fgmp/deliveries", { action: "dispatch", deliveryId: id });
    if (res.ok) { toast.success(t("inventory.deliveryDispatched")); refetch(); tick(30); }
  };
  const doVerify = async () => {
    if (!verify) return;
    const res = await apiPost("/api/fgmp/deliveries", { action: "verify", deliveryId: verify.id, volumeDelivered: verify.vol });
    if (res.ok) { toast.success(t("inventory.deliveryVerified")); setVerify(null); refetch(); tick(30); }
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.inventory")}
        description={t("desc.inventory")}
        icon={<Truck className="h-5 w-5" />}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => window.open("/api/fgmp/export?type=sites", "_blank")}><Download className="mr-1.5 h-4 w-4" /> {t("common.exportShort")}</Button>
            <CreateDeliveryDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={() => { refetch(); setCreateOpen(false); }} tanks={snapshot.tanks} sites={snapshot.sites} />
          </>
        }
      />

      <ResourceError error={deliveriesError ?? analyticsError} onRetry={() => { refetch(); refetchAnalytics(); }} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label={t("inventory.pending")} value={formatNumber(k.pendingDeliveries, numLang)} icon={<Package className="h-4 w-4" />} tone="info" hint={`${formatNumber(scheduled.length, numLang)} ${t("inventory.scheduled")}`} />
        <KpiCard label={t("inventory.inTransit")} value={formatNumber(inTransit.length, numLang)} icon={<Truck className="h-4 w-4" />} tone="warn" />
        <KpiCard label={t("inventory.delivered")} value={formatNumber(delivered.length, numLang)} icon={<CheckCircle2 className="h-4 w-4" />} tone="good" />
        <KpiCard label={t("inventory.volumeDelivered")} value={fmtLitres(totalVolume, numLang)} icon={<TrendingUp className="h-4 w-4" />} tone="good" />
        <KpiCard label={t("inventory.nationalFuel")} value={`${formatNumber(k.fuelPct, numLang)}%`} unit={fmtLitres(k.totalFuelLitres, numLang)} icon={<Package className="h-4 w-4" />} tone="info" />
        <KpiCard label={t("inventory.discrepancies")} value={formatNumber(reconciliation.filter((r) => Math.abs(r.diffPct) > 2).length, numLang)} icon={<FileCheck className="h-4 w-4" />} tone="warn" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("inventory.deliveryTracking")}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[460px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead className="w-[110px]">{t("inventory.doNumber")}</TableHead>
                    <TableHead>{t("inventory.siteTank")}</TableHead>
                    <TableHead className="w-[90px]">{t("inventory.volume")}</TableHead>
                    <TableHead className="w-[100px]">{t("inventory.supplier")}</TableHead>
                    <TableHead className="w-[90px]">{t("inventory.scheduledAt")}</TableHead>
                    <TableHead className="w-[90px]">{t("alarms.status")}</TableHead>
                    <TableHead className="w-[110px] text-right">{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(deliveries ?? []).map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="font-mono text-[11px]">{d.doNumber}</TableCell>
                      <TableCell>
                        <p className="text-xs font-medium">{d.site?.name}</p>
                        <p className="text-[10px] text-muted-foreground">{d.tank?.label} · {d.vehiclePlate}</p>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">{formatNumber(Math.round(d.volumeOrderedLitres), numLang)}L</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">{supplierLabel(d.supplier, numLang)}</TableCell>
                      <TableCell className="text-[10px] text-muted-foreground">{fmtDateTime(d.scheduledAt, numLang).slice(0, 10)}</TableCell>
                      <TableCell><StatusBadge value={d.status} className="h-5 text-[10px]" /></TableCell>
                      <TableCell className="text-right">
                        {d.status === "SCHEDULED" && <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => dispatch(d.id)}>{t("inventory.dispatch")}</Button>}
                        {d.status === "DELIVERED" && <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10" onClick={() => setVerify({ id: d.id, vol: d.volumeOrderedLitres })}>{t("inventory.verify")}</Button>}
                        {(d.status === "VERIFIED" || d.status === "IN_TRANSIT") && <span className="text-[10px] text-muted-foreground">—</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><TrendingUp className="h-4 w-4 text-emerald-500" /> {t("inventory.consumptionForecast")}</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart tabIndex={-1} data={forecast} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                  <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Bar dataKey="litres" radius={[4, 4, 0, 0]}>
                    {forecast.map((_f, i: number) => <Cell key={i} fill={i === 0 ? "#10b981" : "#34d399"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><FileCheck className="h-4 w-4 text-amber-500" /> {t("inventory.reconciliation")}</CardTitle></CardHeader>
            <CardContent className="p-3">
              <div className="max-h-[200px] space-y-1.5 overflow-y-auto" tabIndex={0} role="region" aria-label={t("a11y.scrollReconciliation")}>
                {reconciliation.slice(0, 12).map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded border p-2 text-[11px]">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{r.site?.name}</p>
                      <p className="text-[10px] text-muted-foreground">{r.doNumber}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold tabular-nums">{formatNumber(Math.round(r.volumeDeliveredLitres ?? 0), numLang)}L</p>
                      <p className={r.diffPct > 2 ? "text-rose-500" : r.diffPct < -2 ? "text-amber-500" : "text-emerald-500"}>
                        {r.diffPct > 0 ? "+" : ""}{formatNumber(r.diffPct, numLang)}%
                      </p>
                    </div>
                  </div>
                ))}
                {reconciliation.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">{t("inventory.noReconcile")}</p>}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Verify dialog */}
      <Dialog open={!!verify} onOpenChange={(v) => !v && setVerify(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{t("inventory.verifyDelivery")}</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">{t("inventory.deliveredVolume")}</Label>
            <Input type="number" value={verify?.vol ?? 0} onChange={(e) => setVerify((v) => v ? { ...v, vol: Number(e.target.value) } : v)} />
            <p className="text-[11px] text-muted-foreground">{t("inventory.ordered")}: {verify ? formatNumber(Math.round(verify.vol), numLang) : formatNumber(0, numLang)} L</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVerify(null)}>{t("common.cancel")}</Button>
            <Button onClick={doVerify} className="bg-emerald-500 hover:bg-emerald-600 text-white"><CheckCircle2 className="mr-1.5 h-4 w-4" />{t("inventory.confirmVerification")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateDeliveryDialog({ open, onOpenChange, onCreated, tanks, sites }: {
  open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void; tanks: TankState[]; sites: SiteState[];
}) {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const [siteId, setSiteId] = useState("");
  const [tankId, setTankId] = useState("");
  const [supplier, setSupplier] = useState("Yemen Oil Co.");
  const [volume, setVolume] = useState(500);
  // Tomorrow, computed once at mount. A lazy initialiser keeps the impure
  // clock read out of the render body — reading it inline makes every render of
  // the dialog a different render for the same inputs (React Compiler flags
  // this, and a replayed render would disagree with the server's).
  const [scheduled, setScheduled] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  });
  /**
   * EMPTY by default, deliberately.
   *
   * This was prefilled with `DO-${Math.floor(10000 + Math.random() * 89999)}` —
   * a delivery-order number that looked exactly like it came from a system of
   * record but was invented in the browser. An operator could dispatch fuel
   * against a document number that exists nowhere, and the record would look
   * legitimate afterwards. A blank field invites the real number; a fabricated
   * one launders a fiction into a system of record.
   */
  const [doNumber, setDoNumber] = useState("");
  const [busy, setBusy] = useState(false);

  const siteTanks = tanks.filter((t) => t.siteId === siteId);

  const submit = async () => {
    if (!siteId || !tankId) { toast.error(t("inventory.selectSiteTank")); return; }
    setBusy(true);
    const res = await apiPost("/api/fgmp/deliveries", { action: "create", siteId, tankId, supplier, volumeOrderedLitres: volume, scheduledAt: scheduled, doNumber, driverName: "TBD", vehiclePlate: "TBD", unitPrice: 520 });
    setBusy(false);
    if (res.ok) { toast.success(t("inventory.deliveryScheduled")); onCreated(); }
    else toast.error(t("inventory.failedCreate"), { description: res.error });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="mr-1.5 h-4 w-4" />{t("inventory.scheduleDelivery")}</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t("inventory.scheduleFuelDelivery")}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label className="text-xs">{t("inventory.site")}</Label>
            <Select label={t("inventory.site")} value={siteId} onValueChange={(v) => { setSiteId(v); setTankId(""); }}>
              <SelectTrigger><SelectValue placeholder={t("inventory.selectSite")} /></SelectTrigger>
              <SelectContent className="max-h-60">{sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.code} · {s.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <Label className="text-xs">{t("inventory.tank")}</Label>
            <Select label={t("inventory.tank")} value={tankId} onValueChange={setTankId}>
              <SelectTrigger><SelectValue placeholder={t("inventory.selectTank")} /></SelectTrigger>
              <SelectContent>{siteTanks.map((t) => <SelectItem key={t.id} value={t.id}>{t.label} · {formatNumber(Math.round(t.capacity), numLang)}L</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">{t("inventory.volumeL")}</Label>
            <Input type="number" value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
          </div>
          <div>
            <Label className="text-xs">{t("inventory.scheduledDate")}</Label>
            <Input type="date" value={scheduled} onChange={(e) => setScheduled(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">{t("inventory.supplier")}</Label>
            <Select label={t("inventory.supplier")} value={supplier} onValueChange={setSupplier}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="Yemen Oil Co.">{supplierLabel("Yemen Oil Co.", numLang)}</SelectItem>
                <SelectItem value="Hadramout Fuel Trading">{supplierLabel("Hadramout Fuel Trading", numLang)}</SelectItem>
                <SelectItem value="Aden Petroleum">{supplierLabel("Aden Petroleum", numLang)}</SelectItem>
                <SelectItem value="Al-Mokha Diesel Supply">{supplierLabel("Al-Mokha Diesel Supply", numLang)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">{t("inventory.doNumberLabel")}</Label>
            <Input value={doNumber} onChange={(e) => setDoNumber(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button onClick={submit} disabled={busy}>{busy ? t("inventory.scheduling") : t("inventory.scheduleDelivery")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
