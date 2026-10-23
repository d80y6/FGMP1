"use client";

import type React from "react";
import { useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BarGauge } from "@/components/fgmp/gauge";
import { Breadcrumbs } from "@/components/fgmp/breadcrumbs";
import { StatusBadge, severityDot } from "@/components/fgmp/status-badge";
import { Sparkline } from "@/components/fgmp/sparkline";
import { RemoteControlDialog } from "@/components/fgmp/remote-control-dialog";
import { SiteHealthTrend } from "@/components/fgmp/site-health-trend";
import { Building2, Droplet, Zap, BatteryCharging, Siren, Truck, MapPin, Cpu, RotateCcw, AlertOctagon, Power, TrendingUp, Pin, PinOff, StickyNote, Pencil } from "lucide-react";
import { useApi, apiPatch } from "@/lib/fgmp/use-api";
import { useFgmp } from "@/lib/fgmp/store";
import { useFavorites, useFavoritesHydration, useIsFavorite } from "@/lib/fgmp/use-favorites";
import { SiteNotesPanel } from "@/components/fgmp/site-notes-panel";
import { timeAgo, fmtLitres, fmtDateTime } from "@/lib/fgmp/format";
import { cn } from "@/lib/utils";
import type { GenCommand } from "@/lib/fgmp/types";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { alarmTypeLabel } from "@/lib/fgmp/labels";
import { useNow } from "@/lib/fgmp/use-now";
import { toast } from "sonner";


export function SiteDetailSheet({ siteId, open, onOpenChange }: { siteId: string | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const { data, loading, refetch } = useApi<any>(siteId ? `/api/fgmp/sites/${siteId}` : null, { interval: 6000, deps: [siteId] });
  const { tick, me } = useFgmp(useShallow((s) => ({ tick: s.tick, me: s.me })));
  const [ctrl, setCtrl] = useState<{ id: string; label: string; cmd: GenCommand } | null>(null);

  if (!siteId) return null;
  const site = data?.site;
  const role = me?.role ?? "READONLY";
  const notesReadOnly = role === "READONLY";
  // Threshold editing is ADMIN-only (matches the PATCH route guard).
  const canEditThresholds = role === "ADMIN";

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full overflow-hidden p-0 sm:max-w-2xl">
          <SheetHeader className="border-b px-5 py-4">
            {/* Breadcrumbs (#11) — Fleet → Region → Site (current) */}
            <Breadcrumbs
              items={[
                { label: t("common.fleet"), href: "/?view=dashboard" },
                ...(site ? [{ label: site.region, href: "/?view=geography" }] : []),
                ...(site ? [{ label: site.name }] : []),
              ]}
              className="mb-1"
            />
            <SheetTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-emerald-500" />
              {loading ? t("detail.loading") : site?.name}
              {site && <HeaderPinButton siteId={site.id} />}
            </SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-2">
              {site && <>
                <Badge variant="outline" className="font-mono text-[10px]">{site.code}</Badge>
                <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{site.governorate}, {site.region}</span>
                {site.status && <StatusBadge value={site.status} />}
                <StatusBadge value={site.criticality} />
                <span className="text-[11px]">{site.latitude.toFixed(4)}, {site.longitude.toFixed(4)}</span>
              </>}
            </SheetDescription>
          </SheetHeader>

          {site && (
            <div className="flex h-[calc(100%-88px)] flex-col">
              {/* quick stats */}
              <div className="grid grid-cols-4 gap-2 border-b px-5 py-3 text-center">
                <Stat label={t("detail.load")} value={`${site.loadKw} kW`} />
                <Stat label={t("detail.power")} value={site.powerSource} />
                <Stat label={t("detail.grid")} value={site.gridAvailable ? t("detail.gridAvailable") : t("detail.gridDown")} tone={site.gridAvailable ? "good" : "danger"} />
                <Stat label={t("detail.assets")} value={(data?.tanks?.length ?? 0) + (data?.generators?.length ?? 0) + (data?.batteries?.length ?? 0) + (data?.iot?.length ?? 0)} />
              </div>

              <Tabs defaultValue="tanks" className="flex flex-1 flex-col overflow-hidden">
                <TabsList className="mx-5 mt-3 grid grid-cols-7">
                  <TabsTrigger value="tanks" className="text-xs"><Droplet className="mr-1 h-3.5 w-3.5" />{t("detail.tanks")}</TabsTrigger>
                  <TabsTrigger value="gens" className="text-xs"><Zap className="mr-1 h-3.5 w-3.5" />{t("detail.gens")}</TabsTrigger>
                  <TabsTrigger value="batt" className="text-xs"><BatteryCharging className="mr-1 h-3.5 w-3.5" />{t("detail.batt")}</TabsTrigger>
                  <TabsTrigger value="iot" className="text-xs"><Cpu className="mr-1 h-3.5 w-3.5" />{t("detail.iot")}</TabsTrigger>
                  <TabsTrigger value="events" className="text-xs"><Siren className="mr-1 h-3.5 w-3.5" />{t("detail.events")}</TabsTrigger>
                  <TabsTrigger value="trends" className="text-xs"><TrendingUp className="mr-1 h-3.5 w-3.5" />{t("detail.trends")}</TabsTrigger>
                  <TabsTrigger value="notes" className="text-xs"><StickyNote className="mr-1 h-3.5 w-3.5" />{t("detail.notes")}</TabsTrigger>
                </TabsList>

                <ScrollArea className="flex-1">
                  <div className="p-4">
                    <TabsContent value="tanks" className="mt-0 space-y-2">
                      {(data?.tanks ?? []).map((tk: any) => {
                        const pct = (tk.current / tk.capacity) * 100;
                        return (
                          <Card key={tk.id}>
                            <CardContent className="p-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <Droplet className="h-4 w-4 text-sky-500" />
                                  <span className="text-sm font-medium">{tk.label}</span>
                                  <StatusBadge value={tk.status} className="h-5 text-[9px]" />
                                  {canEditThresholds && (
                                    <TankThresholdEditor
                                      tankId={tk.id}
                                      low={tk.low}
                                      critical={tk.critical}
                                      onSaved={refetch}
                                    />
                                  )}
                                </div>
                                <span className="text-sm font-bold tabular-nums">{fmtLitres(tk.current, numLang)} / {fmtLitres(tk.capacity, numLang)}</span>
                              </div>
                              <div className="mt-2"><BarGauge value={pct} showLabel /></div>
                              <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
                                <span>{t("detail.low")}: {Math.round(tk.low)}L · {t("detail.criticalLevel")}: {Math.round(tk.critical)}L</span>
                                <Sparkline data={tk.history?.map((h: any) => h.l).slice(-48) ?? []} width={80} height={20} color="#0ea5e9" />
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </TabsContent>

                    <TabsContent value="gens" className="mt-0 space-y-2">
                      {(data?.generators ?? []).map((g: any) => (
                        <Card key={g.id}>
                          <CardContent className="p-3">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Zap className="h-4 w-4 text-amber-500" />
                                <span className="text-sm font-medium">{g.label}</span>
                                <StatusBadge value={g.status} className="h-5 text-[9px]" />
                                <span className="text-[10px] text-muted-foreground">{g.manufacturer} {g.model}</span>
                              </div>
                              <span className="text-xs tabular-nums">{g.ratedPowerKw} kW</span>
                            </div>
                            <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
                              <Metric label={t("detail.runtime")} value={`${g.runtimeHours} h`} />
                              <Metric label={t("detail.temp")} value={`${g.temperatureC}°C`} tone={g.temperatureC > 95 ? "danger" : undefined} />
                              <Metric label={t("detail.load")} value={`${g.loadKw} kW`} />
                              <Metric label={t("detail.fuelRate")} value={`${g.fuelRateLph} L/h`} />
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={g.status === "RUNNING"} onClick={() => setCtrl({ id: g.id, label: g.label, cmd: "START" })}>
                                <Power className="mr-1 h-3 w-3 text-emerald-500" />{t("detail.start")}
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={g.status === "STOPPED"} onClick={() => setCtrl({ id: g.id, label: g.label, cmd: "STOP" })}>
                                <Power className="mr-1 h-3 w-3 text-amber-500" />{t("detail.stop")}
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setCtrl({ id: g.id, label: g.label, cmd: "RESET" })}>
                                <RotateCcw className="mr-1 h-3 w-3 text-sky-500" />{t("detail.reset")}
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 text-[11px] border-rose-500/40 text-rose-600 hover:bg-rose-500/10" onClick={() => setCtrl({ id: g.id, label: g.label, cmd: "EMERGENCY_STOP" })}>
                                <AlertOctagon className="mr-1 h-3 w-3" />{t("detail.eStop")}
                              </Button>
                              <span className="ml-auto self-center text-[10px] text-muted-foreground">{t("detail.nextMaint")}: {Math.round(g.nextMaintenanceHrs)} h</span>
                              {canEditThresholds && (
                                <GenMaintenanceEditor
                                  generatorId={g.id}
                                  hours={g.nextMaintenanceHrs}
                                  onSaved={refetch}
                                />
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </TabsContent>

                    <TabsContent value="batt" className="mt-0 space-y-2">
                      {(data?.batteries ?? []).map((b: any) => (
                        <Card key={b.id}>
                          <CardContent className="p-3">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <BatteryCharging className="h-4 w-4 text-emerald-500" />
                                <span className="text-sm font-medium">{b.label}</span>
                                <StatusBadge value={b.status} className="h-5 text-[9px]" />
                              </div>
                              <span className="text-xs">{b.chemistry} · {b.nominalVoltage}V</span>
                            </div>
                            <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
                              <Metric label={t("detail.voltage")} value={`${b.voltage}V`} tone={b.voltage < b.nominalVoltage * 0.88 ? "danger" : undefined} />
                              <Metric label={t("detail.soc")} value={`${b.stateOfCharge}%`} />
                              <Metric label={t("detail.soh")} value={`${b.stateOfHealth}%`} tone={b.stateOfHealth < 70 ? "warn" : undefined} />
                              <Metric label={t("detail.current")} value={`${b.currentA}A`} />
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </TabsContent>

                    <TabsContent value="iot" className="mt-0 space-y-2">
                      {(data?.iot ?? []).map((d: any) => (
                        <div key={d.id} className="flex items-center justify-between rounded-lg border p-2.5 text-xs">
                          <div className="flex items-center gap-2">
                            <Cpu className="h-4 w-4 text-muted-foreground" />
                            <div>
                              <p className="font-medium">{d.name}</p>
                              <p className="text-[10px] text-muted-foreground">{d.vendor} · {d.protocol} · fw {d.firmware}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-muted-foreground">{d.ipAddress}</span>
                            <StatusBadge value={d.status} className="h-5 text-[9px]" />
                          </div>
                        </div>
                      ))}
                    </TabsContent>

                    <TabsContent value="events" className="mt-0 space-y-1.5">
                      <div className="mb-2 flex items-center gap-2 text-xs">
                        <Truck className="h-4 w-4 text-emerald-500" />
                        <span className="font-medium">{t("detail.deliveries")}</span>
                      </div>
                      {(data?.deliveries ?? []).slice(0, 5).map((d: any) => (
                        <div key={d.id} className="flex items-center justify-between rounded border p-2 text-[11px]">
                          <span>{fmtDateTime(d.scheduledAt, numLang)} · {formatNumber(Math.round(d.volumeOrderedLitres), numLang)}L</span>
                          <StatusBadge value={d.status} className="h-5 text-[9px]" />
                        </div>
                      ))}
                      <div className="mb-2 mt-3 flex items-center gap-2 text-xs">
                        <Siren className="h-4 w-4 text-rose-500" />
                        <span className="font-medium">{t("detail.recentAlarms")}</span>
                      </div>
                      {(data?.alarms ?? []).slice(0, 8).map((a: any) => (
                        <div key={a.id} className="flex items-start gap-2 rounded border p-2 text-[11px]">
                          <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", severityDot(a.severity))} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{alarmTypeLabel(a.type, numLang)}</p>
                            <p className="text-[10px] text-muted-foreground">{a.message}</p>
                          </div>
                          <span className="text-[10px] text-muted-foreground">{timeAgo(a.createdAt, numLang)}</span>
                        </div>
                      ))}
                    </TabsContent>

                    {/* Trends tab — historical charts */}
                    <TabsContent value="trends" className="mt-0 space-y-3">
                      <SiteHealthTrend
                        siteId={siteId}
                        tanks={data?.tanks ?? []}
                        generators={data?.generators ?? []}
                        batteries={data?.batteries ?? []}
                        alarms={data?.alarms ?? []}
                        siteStatus={site.status}
                      />
                      <SiteTrendsTab data={data} />
                    </TabsContent>

                    {/* Notes tab — operator annotations (client-side, localStorage) */}
                    <TabsContent value="notes" className="mt-0">
                      <SiteNotesPanel
                        siteId={site.id}
                        siteName={site.name}
                        readOnly={notesReadOnly}
                      />
                    </TabsContent>
                  </div>
                </ScrollArea>
              </Tabs>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <RemoteControlDialog
        open={!!ctrl}
        onOpenChange={(v) => !v && setCtrl(null)}
        generatorId={ctrl?.id ?? null}
        generatorLabel={ctrl?.label ?? ""}
        siteName={site?.name ?? ""}
        command={ctrl?.cmd ?? "START"}
        onDone={() => tick(30)}
      />
    </>
  );
}

function HeaderPinButton({ siteId }: { siteId: string }) {
  // Ensure favorites store is hydrated when this sheet opens.
  useFavoritesHydration();
  const t = useT();
  const isFav = useIsFavorite(siteId);
  const toggle = useFavorites((s) => s.toggle);
  // #18 — Pin / PinOff icons (was Star). When pinned, the Pin icon gets
  // fill="currentColor" so it renders as a solid amber shape; otherwise we
  // render the outline PinOff (or outline Pin) to signal the toggle target.
  // `key={isFav ? "on" : "off"}` re-mounts the icon on each toggle so the
  // one-shot `animate-pin-pop` keyframe retriggers.
  const Icon = isFav ? Pin : PinOff;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggle(siteId);
      }}
      title={isFav ? t("sites.unpinSite") : t("sites.pinSite")}
      aria-label={isFav ? t("sites.unpinSite") : t("sites.pinSite")}
      aria-pressed={isFav}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
        isFav
          ? "border-amber-500/40 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20"
          : "border-border bg-background/40 text-muted-foreground hover:bg-muted hover:text-amber-500",
      )}
    >
      <Icon
        key={isFav ? "on" : "off"}
        fill={isFav ? "currentColor" : "none"}
        className={cn(
          "h-4 w-4 transition-colors",
          isFav && "animate-pin-pop",
        )}
      />
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "good" | "danger" }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-sm font-bold", tone === "good" && "text-emerald-500", tone === "danger" && "text-rose-500")}>{value}</p>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "danger" | "warn" }) {
  return (
    <div className="rounded bg-muted/40 px-2 py-1">
      <p className="text-[9px] uppercase text-muted-foreground">{label}</p>
      <p className={cn("font-semibold tabular-nums", tone === "danger" && "text-rose-500", tone === "warn" && "text-amber-500")}>{value}</p>
    </div>
  );
}

/**
 * TankThresholdEditor (#8) — inline Popover that lets an ADMIN update the
 * per-asset low-fuel / critical-fuel thresholds (in litres) for a single tank.
 *
 * On save it PATCHes `/api/fgmp/tanks/[id]` with `{ lowFuelLitres,
 * criticalFuelLitres }` (the route handler maps these to the canonical DB
 * columns `lowThreshold` / `criticalThreshold`). After a successful save the
 * parent refetches the site snapshot so the new thresholds are reflected in
 * the BarGauge colors + alarm engine on the next render.
 *
 * Form state is held in `useState` and only mutated from event handlers
 * (input change, popover open, button click) — never from `useEffect`, so
 * the `react-hooks/set-state-in-effect` lint rule is satisfied.
 */
function TankThresholdEditor({
  tankId,
  low,
  critical,
  onSaved,
}: {
  tankId: string;
  low: number;
  critical: number;
  onSaved: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [lowStr, setLowStr] = useState<string>(String(Math.round(low)));
  const [criticalStr, setCriticalStr] = useState<string>(String(Math.round(critical)));
  const [saving, setSaving] = useState(false);

  // Derived validation (no setState in effects).
  const lowNum = parseFloat(lowStr);
  const critNum = parseFloat(criticalStr);
  const lowPositive = !isNaN(lowNum) && lowNum > 0;
  const critPositive = !isNaN(critNum) && critNum > 0;
  const critLessThanLow = lowPositive && critPositive && critNum < lowNum;
  const lowErr = lowStr.trim() === "" || lowPositive ? null : t("thresholds.invalidLowFuel");
  const critErr =
    criticalStr.trim() === ""
      ? null
      : !critPositive
        ? t("thresholds.invalidLowFuel")
        : !critLessThanLow
          ? t("thresholds.invalidCritical")
          : null;
  const canSubmit = lowPositive && critPositive && critLessThanLow && !saving;

  const handleOpenChange = (next: boolean) => {
    if (next) {
      // Reset the form to the latest tank values whenever the popover opens,
      // so the user never sees stale inputs from a previous edit.
      setLowStr(String(Math.round(low)));
      setCriticalStr(String(Math.round(critical)));
    }
    setOpen(next);
  };

  const handleSave = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const res = await apiPatch(`/api/fgmp/tanks/${tankId}`, {
        lowFuelLitres: lowNum,
        criticalFuelLitres: critNum,
      });
      if (res.ok) {
        toast.success(t("thresholds.saveSuccess"));
        setOpen(false);
        onSaved();
      } else {
        toast.error(t("thresholds.saveFailure"), {
          description: res.error ?? undefined,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          aria-label={t("thresholds.editThresholds")}
          title={t("thresholds.editThresholds")}
        >
          <Pencil className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="space-y-3">
          <p className="text-xs font-semibold">{t("thresholds.editThresholds")}</p>
          <div className="space-y-1">
            <Label htmlFor={`tank-low-${tankId}`} className="text-[11px]">
              {t("thresholds.lowFuel")} ({t("thresholds.litres")})
            </Label>
            <Input
              id={`tank-low-${tankId}`}
              type="number"
              inputMode="decimal"
              min={0}
              step={1}
              value={lowStr}
              onChange={(e) => setLowStr(e.target.value)}
              disabled={saving}
              className="h-8 text-xs"
            />
            {lowErr && <p className="text-[10px] text-rose-500">{lowErr}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor={`tank-crit-${tankId}`} className="text-[11px]">
              {t("thresholds.criticalFuel")} ({t("thresholds.litres")})
            </Label>
            <Input
              id={`tank-crit-${tankId}`}
              type="number"
              inputMode="decimal"
              min={0}
              step={1}
              value={criticalStr}
              onChange={(e) => setCriticalStr(e.target.value)}
              disabled={saving}
              className="h-8 text-xs"
            />
            {critErr && <p className="text-[10px] text-rose-500">{critErr}</p>}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              {t("thresholds.cancel")}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={handleSave}
              disabled={!canSubmit}
            >
              {saving ? t("thresholds.saving") : t("thresholds.save")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * GenMaintenanceEditor (#8) — inline Popover that lets an ADMIN update the
 * per-asset maintenance-due runtime threshold (in hours) for a single
 * generator.
 *
 * On save it PATCHes `/api/fgmp/generators/[id]` with `{ maintenanceDueHours }`
 * (the route handler maps this to the canonical DB column
 * `nextMaintenanceHrs`). After a successful save the parent refetches the
 * site snapshot so the maintenance-prediction panel reflects the new value.
 */
function GenMaintenanceEditor({
  generatorId,
  hours,
  onSaved,
}: {
  generatorId: string;
  hours: number;
  onSaved: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [hoursStr, setHoursStr] = useState<string>(String(Math.round(hours)));
  const [saving, setSaving] = useState(false);

  const hoursNum = parseFloat(hoursStr);
  const hoursPositive = !isNaN(hoursNum) && hoursNum > 0;
  const hoursErr = hoursStr.trim() === "" || hoursPositive ? null : t("thresholds.invalidMaintenance");
  const canSubmit = hoursPositive && !saving;

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setHoursStr(String(Math.round(hours)));
    }
    setOpen(next);
  };

  const handleSave = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const res = await apiPatch(`/api/fgmp/generators/${generatorId}`, {
        maintenanceDueHours: hoursNum,
      });
      if (res.ok) {
        toast.success(t("thresholds.saveSuccess"));
        setOpen(false);
        onSaved();
      } else {
        toast.error(t("thresholds.saveFailure"), {
          description: res.error ?? undefined,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          aria-label={t("thresholds.editThresholds")}
          title={t("thresholds.editThresholds")}
        >
          <Pencil className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="space-y-3">
          <p className="text-xs font-semibold">{t("thresholds.editThresholds")}</p>
          <div className="space-y-1">
            <Label htmlFor={`gen-hours-${generatorId}`} className="text-[11px]">
              {t("thresholds.maintenanceDueHours")} ({t("thresholds.hours")})
            </Label>
            <Input
              id={`gen-hours-${generatorId}`}
              type="number"
              inputMode="decimal"
              min={0}
              step={1}
              value={hoursStr}
              onChange={(e) => setHoursStr(e.target.value)}
              disabled={saving}
              className="h-8 text-xs"
            />
            {hoursErr && <p className="text-[10px] text-rose-500">{hoursErr}</p>}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              {t("thresholds.cancel")}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={handleSave}
              disabled={!canSubmit}
            >
              {saving ? t("thresholds.saving") : t("thresholds.save")}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SiteTrendsTab({ data }: { data: any }) {
  const t = useT();
  const now = useNow();
  // Stable fallback identities — a bare `?? []` is a new array every render,
  // which would invalidate all four trend memos below on any parent re-render.
  const { tanks, generators, batteries, alarms } = useMemo(
    () => ({
      tanks: data?.tanks ?? [],
      generators: data?.generators ?? [],
      batteries: data?.batteries ?? [],
      alarms: data?.alarms ?? [],
    }),
    [data],
  );

  // Build combined fuel level trend from all tanks (last 48 points = ~4h at 5min intervals)
  const fuelTrend = useMemo(() => {
    if (tanks.length === 0) return [];
    const maxLen = Math.max(...tanks.map((t: any) => t.history?.length ?? 0), 0);
    const result: { t: string; litres: number; pct: number }[] = [];
    for (let i = 0; i < Math.min(maxLen, 48); i++) {
      let totalL = 0;
      let totalCap = 0;
      let time = "";
      for (const t of tanks) {
        const h = t.history?.[t.history.length - 48 + i] ?? t.history?.[i];
        if (h) {
          totalL += h.l;
          totalCap += t.capacity;
          if (!time) time = new Date(h.t).toISOString().slice(11, 16);
        }
      }
      if (totalCap > 0) {
        result.push({ t: time, litres: Math.round(totalL), pct: Math.round((totalL / totalCap) * 1000) / 10 });
      }
    }
    return result;
  }, [tanks]);

  // Generator load trend
  const genLoadTrend = useMemo(() => {
    if (generators.length === 0) return [];
    const maxLen = Math.max(...generators.map((g: any) => g.history?.length ?? 0), 0);
    const result: { t: string; load: number; temp: number }[] = [];
    for (let i = 0; i < Math.min(maxLen, 48); i++) {
      let totalLoad = 0;
      let avgTemp = 0;
      let count = 0;
      let time = "";
      for (const g of generators) {
        const h = g.history?.[g.history.length - 48 + i] ?? g.history?.[i];
        if (h) {
          totalLoad += h.load ?? 0;
          avgTemp += h.temp ?? 0;
          count++;
          if (!time) time = new Date(h.t).toISOString().slice(11, 16);
        }
      }
      if (count > 0) {
        result.push({ t: time, load: Math.round(totalLoad * 10) / 10, temp: Math.round(avgTemp / count) });
      }
    }
    return result;
  }, [generators]);

  // Battery voltage trend
  const battTrend = useMemo(() => {
    if (batteries.length === 0) return [];
    const maxLen = Math.max(...batteries.map((b: any) => b.history?.length ?? 0), 0);
    const result: { t: string; voltage: number; charge: number }[] = [];
    for (let i = 0; i < Math.min(maxLen, 48); i++) {
      let totalV = 0;
      let totalC = 0;
      let count = 0;
      let time = "";
      for (const b of batteries) {
        const h = b.history?.[b.history.length - 48 + i] ?? b.history?.[i];
        if (h) {
          totalV += h.v ?? 0;
          totalC += h.c ?? 0;
          count++;
          if (!time) time = new Date(h.t).toISOString().slice(11, 16);
        }
      }
      if (count > 0) {
        result.push({ t: time, voltage: Math.round((totalV / count) * 100) / 100, charge: Math.round(totalC / count) });
      }
    }
    return result;
  }, [batteries]);

  // Alarm timeline (last 24h by hour)
  const alarmTimeline = useMemo(() => {
    if (alarms.length === 0) return [];
    const buckets: { hour: string; count: number; L1: number; L2: number; L3: number }[] = [];
    for (let h = 23; h >= 0; h--) {
      const start = now - (h + 1) * 3600000;
      const end = now - h * 3600000;
      const hourAlarms = alarms.filter((a: any) => {
        const t = new Date(a.createdAt).getTime();
        return t >= start && t < end;
      });
      buckets.push({
        hour: new Date(end).toISOString().slice(11, 16),
        count: hourAlarms.length,
        L1: hourAlarms.filter((a: any) => a.severity === "L1").length,
        L2: hourAlarms.filter((a: any) => a.severity === "L2").length,
        L3: hourAlarms.filter((a: any) => a.severity === "L3").length,
      });
    }
    return buckets;
  }, [alarms, now]);

  const hasData = fuelTrend.length > 0 || genLoadTrend.length > 0 || battTrend.length > 0;

  if (!hasData && alarmTimeline.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <TrendingUp className="mb-2 h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">{t("detail.noTrendData")}</p>
        <p className="text-[11px] text-muted-foreground/70">{t("detail.trendWillPopulate")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Fuel Level Trend */}
      {fuelTrend.length > 0 && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold">
            <Droplet className="h-3.5 w-3.5 text-sky-500" />
            {t("detail.fuelTrend4h")}
          </p>
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={fuelTrend} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
              <defs>
                <linearGradient id="trend-fuel" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
              <XAxis dataKey="t" tick={{ fontSize: 8 }} stroke="currentColor" strokeOpacity={0.3} interval={6} />
              <YAxis tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} />
              <Tooltip contentStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="litres" stroke="#0ea5e9" strokeWidth={2} fill="url(#trend-fuel)" name="Litres" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Generator Load & Temp Trend */}
      {genLoadTrend.length > 0 && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold">
            <Zap className="h-3.5 w-3.5 text-amber-500" />
            {t("detail.genLoadTrend4h")}
          </p>
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={genLoadTrend} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
              <XAxis dataKey="t" tick={{ fontSize: 8 }} stroke="currentColor" strokeOpacity={0.3} interval={6} />
              <YAxis yAxisId="l" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} />
              <Tooltip contentStyle={{ fontSize: 11 }} />
              <Line yAxisId="l" type="monotone" dataKey="load" stroke="#f59e0b" strokeWidth={2} dot={false} name="Load (kW)" />
              <Line yAxisId="r" type="monotone" dataKey="temp" stroke="#f43f5e" strokeWidth={2} dot={false} name="Temp (°C)" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Battery Voltage Trend */}
      {battTrend.length > 0 && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold">
            <BatteryCharging className="h-3.5 w-3.5 text-emerald-500" />
            {t("detail.battTrend4h")}
          </p>
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={battTrend} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
              <XAxis dataKey="t" tick={{ fontSize: 8 }} stroke="currentColor" strokeOpacity={0.3} interval={6} />
              <YAxis yAxisId="l" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} />
              <Tooltip contentStyle={{ fontSize: 11 }} />
              <Line yAxisId="l" type="monotone" dataKey="voltage" stroke="#10b981" strokeWidth={2} dot={false} name="Voltage (V)" />
              <Line yAxisId="r" type="monotone" dataKey="charge" stroke="#22c55e" strokeWidth={2} dot={false} name="Charge (%)" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Alarm Timeline */}
      {alarmTimeline.length > 0 && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold">
            <Siren className="h-3.5 w-3.5 text-rose-500" />
            {t("detail.alarmTimeline24h")}
          </p>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={alarmTimeline} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
              <XAxis dataKey="hour" tick={{ fontSize: 8 }} stroke="currentColor" strokeOpacity={0.3} interval={3} />
              <YAxis tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 11 }} />
              <Bar dataKey="L3" stackId="a" fill="#f43f5e" name="L3 Critical" radius={[0, 0, 0, 0]} />
              <Bar dataKey="L2" stackId="a" fill="#f59e0b" name="L2 Warning" radius={[0, 0, 0, 0]} />
              <Bar dataKey="L1" stackId="a" fill="#0ea5e9" name="L1 Notice" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
