"use client";

import { useShallow } from "zustand/react/shallow";
import {
  CircuitBoard, Wifi, HardDriveDownload, RefreshCw, Search,
  Radio, Router, Activity, AlertTriangle, CheckCircle2, Cpu,
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPatch } from "@/lib/fgmp/use-api";
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
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { timeAgo } from "@/lib/fgmp/format";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import { useChartColors } from "@/lib/fgmp/use-chart-colors";
import type { Language } from "@/lib/fgmp/i18n";

/* ────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────── */

interface SiteOpt { id: string; name: string; code: string; }

interface DispenserRow {
  id: string; siteId: string; label: string;
  espDeviceId: string; espFirmware: string;
  rs485Baudrate: number; rs485Address: number; rs485Parity: string;
  wifiRssi: number; ipAddress?: string | null;
  lastCommAt?: string | null;
  status: string; mode: string;
  liveStatus?: string; liveWifiRssi?: number; liveLastCommAt?: number;
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

/** Unified ESP gateway record — derived from either a dispenser or an
 *  RS485-class IoT device. */
interface EspGateway {
  id: string;        // source id (dispenser.id or iot.id)
  source: "dispenser" | "iot";
  espId: string;     // espDeviceId for dispensers, serialNo for IoT
  siteId: string;
  siteName: string;
  firmware: string;
  rs485Address: number;
  rs485Baudrate: number;
  rs485Parity: string;
  wifiRssi: number;
  lastCommMs: number;
  status: string;
  otaTargetFw?: string | null;
  otaStatus?: string | null;
}

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function EdgeFirmwareView() {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const cc = useChartColors();
  const { snapshot, me, tick } = useFgmp(useShallow((s) => ({ snapshot: s.snapshot, me: s.me, tick: s.tick })));
  const [tab, setTab] = useState<"gateways" | "firmware" | "rs485" | "reboot">("gateways");

  const { data: dispensers, loading: dispLoading } = useApi<DispenserRow[]>(
    "/api/fgmp/dispensers", { interval: 10000 },
  );
  const { data: iotDevices, loading: iotLoading } = useApi<IotRow[]>(
    "/api/fgmp/iot", { interval: 10000 },
  );

  // Build unified ESP gateway list
  const gateways: EspGateway[] = useMemo(() => {
    const list: EspGateway[] = [];
    const sites = snapshot?.sites ?? [];
    const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? "—";

    for (const d of dispensers ?? []) {
      list.push({
        id: d.id,
        source: "dispenser",
        espId: d.espDeviceId,
        siteId: d.siteId,
        siteName: d.site?.name ?? siteName(d.siteId),
        firmware: d.espFirmware,
        rs485Address: d.rs485Address,
        rs485Baudrate: d.rs485Baudrate,
        rs485Parity: d.rs485Parity,
        wifiRssi: d.liveWifiRssi ?? d.wifiRssi,
        lastCommMs: d.liveLastCommAt ?? (d.lastCommAt ? new Date(d.lastCommAt).getTime() : 0),
        status: d.liveStatus ?? d.status,
      });
    }
    for (const d of iotDevices ?? []) {
      // Only RS485-class IoT devices are ESP gateways.
      if (d.protocol !== "RS485" && d.protocol !== "MODBUS_RTU") continue;
      list.push({
        id: d.id,
        source: "iot",
        espId: d.serialNo,
        siteId: d.siteId,
        siteName: d.site?.name ?? siteName(d.siteId),
        firmware: d.firmware,
        rs485Address: d.modbusUnit ?? 0,
        rs485Baudrate: 9600, // IoT device model doesn't track baud; default.
        rs485Parity: "8N1",
        wifiRssi: d.signalRssi,
        lastCommMs: d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0,
        status: d.liveStatus ?? d.status,
        otaTargetFw: d.otaTargetFw,
        otaStatus: d.otaStatus,
      });
    }
    return list;
  }, [dispensers, iotDevices, snapshot]);

  const totalEsps = gateways.length;
  const onlineEsps = gateways.filter((g) => g.status === "ONLINE" || g.status === "IDLE" || g.status === "DISPENSING" || g.status === "AUTHORIZED").length;
  const offlineEsps = gateways.filter((g) => g.status === "OFFLINE" || g.status === "FAULT").length;
  const otaInProgress = gateways.filter((g) => g.otaStatus === "IN_PROGRESS").length;

  // RS485 conflicts: per-site, addresses that appear more than once on the
  // same bus (same baudrate).
  const rs485Conflicts = useMemo(() => {
    const bySite = new Map<string, EspGateway[]>();
    for (const g of gateways) {
      const arr = bySite.get(g.siteId) ?? [];
      arr.push(g);
      bySite.set(g.siteId, arr);
    }
    let conflicts = 0;
    for (const arr of bySite.values()) {
      const seen = new Map<string, number>();
      for (const g of arr) {
        const key = `${g.rs485Baudrate}:${g.rs485Address}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      for (const n of seen.values()) if (n > 1) conflicts++;
    }
    return conflicts;
  }, [gateways]);

  const loading = dispLoading || iotLoading;

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.edge-firmware")}
        description={t("desc.edge-firmware")}
        icon={<CircuitBoard className="h-5 w-5" />}
        tone="emerald"
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          label="Total ESP Devices"
          value={formatNumber(totalEsps, numLang)}
          icon={<CircuitBoard className="h-4 w-4" />}
        />
        <KpiCard
          label="Online"
          value={formatNumber(onlineEsps, numLang)}
          icon={<Wifi className="h-4 w-4" />}
          tone="good"
        />
        <KpiCard
          label="Offline / Fault"
          value={formatNumber(offlineEsps, numLang)}
          icon={<AlertTriangle className="h-4 w-4" />}
          tone={offlineEsps > 0 ? "danger" : "good"}
        />
        <KpiCard
          label="OTA In Progress"
          value={formatNumber(otaInProgress, numLang)}
          icon={<HardDriveDownload className="h-4 w-4" />}
          tone={otaInProgress > 0 ? "warn" : "default"}
        />
        <KpiCard
          label="RS485 Conflicts"
          value={formatNumber(rs485Conflicts, numLang)}
          icon={<Radio className="h-4 w-4" />}
          tone={rs485Conflicts > 0 ? "danger" : "good"}
        />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4 h-auto">
          <TabsTrigger value="gateways" className="text-xs">
            <Router className="mr-1.5 h-3.5 w-3.5" />
            Gateways
          </TabsTrigger>
          <TabsTrigger value="firmware" className="text-xs">
            <HardDriveDownload className="mr-1.5 h-3.5 w-3.5" />
            ESP Firmware
          </TabsTrigger>
          <TabsTrigger value="rs485" className="text-xs">
            <Radio className="mr-1.5 h-3.5 w-3.5" />
            RS485 Diagnostics
          </TabsTrigger>
          <TabsTrigger value="reboot" className="text-xs">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            ESP Reboot
          </TabsTrigger>
        </TabsList>

        <TabsContent value="gateways" className="mt-4">
          <GatewaysTab gateways={gateways} loading={loading} numLang={numLang} />
        </TabsContent>
        <TabsContent value="firmware" className="mt-4">
          <FirmwareTab
            gateways={gateways}
            loading={loading}
            numLang={numLang}
            onRefresh={tick}
          />
        </TabsContent>
        <TabsContent value="rs485" className="mt-4">
          <Rs485Tab gateways={gateways} loading={loading} numLang={numLang} />
        </TabsContent>
        <TabsContent value="reboot" className="mt-4">
          <RebootTab
            gateways={gateways}
            loading={loading}
            numLang={numLang}
            onReboot={tick}
            isAdmin={me?.role === "ADMIN" || me?.role === "NOC_OPERATOR"}
          />
        </TabsContent>
      </Tabs>

      {/* Recharts color variables are read once at module eval; we keep the
          `cc` reference here so React re-renders on theme change. */}
      <span className="hidden" data-chart-colors={cc.emerald} />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Tab 1: Gateways
 * ──────────────────────────────────────────────────────────────────────── */

function GatewaysTab({ gateways, loading, numLang }: {
  gateways: EspGateway[];
  loading: boolean;
  numLang: Language;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = useMemo(() => {
    let list = gateways;
    if (statusFilter !== "all") {
      if (statusFilter === "ONLINE") {
        list = list.filter((g) => g.status === "ONLINE" || g.status === "IDLE" || g.status === "DISPENSING" || g.status === "AUTHORIZED");
      } else {
        list = list.filter((g) => g.status === statusFilter);
      }
    }
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((g) =>
        `${g.espId} ${g.siteName} ${g.firmware} ${g.source}`.toLowerCase().includes(needle),
      );
    }
    return list;
  }, [gateways, q, statusFilter]);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-sm">
          ESP Gateways ({formatNumber(filtered.length, numLang)})
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search ESP ID, site…"
              className="h-9 w-[220px] pl-8"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-[140px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("common.all")}</SelectItem>
              <SelectItem value="ONLINE">Online</SelectItem>
              <SelectItem value="OFFLINE">Offline</SelectItem>
              <SelectItem value="FAULT">Fault</SelectItem>
              <SelectItem value="DISPENSING">Dispensing</SelectItem>
              <SelectItem value="IDLE">Idle</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loading && gateways.length === 0 ? (
          <RegistrySkeleton cols={7} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Router} title="No ESP gateways found" description="No ESP devices match the current filters." />
        ) : (
          <div className="max-h-[600px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>ESP Device ID</TableHead>
                  <TableHead className="hidden md:table-cell">{t("common.site")}</TableHead>
                  <TableHead className="w-[80px]">Source</TableHead>
                  <TableHead className="hidden lg:table-cell w-[100px]">{t("iot.firmware")}</TableHead>
                  <TableHead className="w-[130px]">RS485</TableHead>
                  <TableHead className="w-[90px]">WiFi RSSI</TableHead>
                  <TableHead className="hidden md:table-cell w-[120px]">Last Comm</TableHead>
                  <TableHead className="w-[100px]">{t("common.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((g) => (
                  <TableRow key={`${g.source}:${g.id}`} className="hover:bg-muted/30">
                    <TableCell>
                      <p className="font-mono text-[11px] font-medium">{g.espId}</p>
                      <p className="text-[10px] text-muted-foreground">{g.source}</p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs">{g.siteName}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[9px]">
                        {g.source === "dispenser" ? "Dispenser" : "IoT"}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-[10px] font-mono">{g.firmware}</TableCell>
                    <TableCell className="text-[10px] font-mono tabular-nums">
                      <span className="text-foreground">@{formatNumber(g.rs485Address, numLang)}</span>
                      <span className="text-muted-foreground"> · {formatNumber(g.rs485Baudrate, numLang)}</span>
                      <div className="text-[9px] text-muted-foreground">{g.rs485Parity}</div>
                    </TableCell>
                    <TableCell>
                      <RssiBar rssi={g.wifiRssi} numLang={numLang} />
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-[10px] text-muted-foreground">
                      {g.lastCommMs ? timeAgo(new Date(g.lastCommMs).toISOString(), numLang) : "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={g.status} className="h-5 text-[9px]" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Tab 2: ESP Firmware
 * ──────────────────────────────────────────────────────────────────────── */

function FirmwareTab({ gateways, loading, numLang, onRefresh }: {
  gateways: EspGateway[];
  loading: boolean;
  numLang: Language;
  onRefresh: (delayMs?: number) => void;
}) {
  const t = useT();
  const cc = useChartColors();
  const [otaTarget, setOtaTarget] = useState<EspGateway | null>(null);
  const [otaFw, setOtaFw] = useState("v1.3.0");

  // Distribution of firmware versions
  const dist = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of gateways) {
      map.set(g.firmware, (map.get(g.firmware) ?? 0) + 1);
    }
    const arr = Array.from(map.entries())
      .map(([fw, count]) => ({ fw, count }))
      .sort((a, b) => a.fw.localeCompare(b.fw, undefined, { numeric: true }));
    return arr;
  }, [gateways]);

  // Pick the highest firmware as the suggested OTA target.
  const latestFw = useMemo(() => {
    if (dist.length === 0) return "v1.3.0";
    return dist.reduce((max, d) => (d.fw > max ? d.fw : max), dist[0].fw);
  }, [dist]);

  const palette = [cc.emerald, cc.amber, cc.rose, cc.sky, cc.violet, cc.muted];

  const startOta = async () => {
    if (!otaTarget) return;
    // Reuse the iot PATCH endpoint (action: "ota") — works for IoT devices.
    // For dispenser ESPs, we use the dispenser control endpoint with a
    // firmware-payload extension via the same PATCH.
    let res;
    if (otaTarget.source === "iot") {
      res = await apiPatch("/api/fgmp/iot", {
        deviceId: otaTarget.id,
        action: "ota",
        firmware: otaFw,
      });
    } else {
      // For dispensers: there is no native OTA endpoint, so we PATCH the
      // dispenser's espFirmware field directly. The next tick the engine
      // will reconcile.
      res = await apiPatch(`/api/fgmp/dispensers/${otaTarget.id}`, {
        espFirmware: otaFw,
      });
    }
    if (res.ok) {
      toast.success(`OTA update queued for ${otaTarget.espId}`, {
        description: `Target firmware: ${otaFw}`,
      });
      setOtaTarget(null);
      onRefresh(2000);
    } else {
      toast.error("OTA update failed", { description: res.error });
    }
  };

  return (
    <div className="space-y-4">
      {/* Firmware distribution chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-500" />
            Firmware Version Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading && gateways.length === 0 ? (
            <Skeleton className="h-64 w-full" />
          ) : dist.length === 0 ? (
            <EmptyState icon={HardDriveDownload} title="No firmware data" description="No ESP devices available." />
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dist} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={cc.grid} />
                  <XAxis
                    dataKey="fw"
                    stroke={cc.text}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke={cc.text}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--background)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    labelStyle={{ fontWeight: 600 }}
                  />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                    {dist.map((_, i) => (
                      <Cell key={i} fill={palette[i % palette.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Devices grouped by firmware */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Devices by Firmware Version</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading && gateways.length === 0 ? (
            <RegistrySkeleton cols={5} />
          ) : dist.length === 0 ? (
            <EmptyState icon={CircuitBoard} title="No devices" />
          ) : (
            <div className="max-h-[500px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>ESP Device ID</TableHead>
                    <TableHead className="hidden md:table-cell">{t("common.site")}</TableHead>
                    <TableHead className="w-[100px]">Current</TableHead>
                    <TableHead className="w-[100px]">Target</TableHead>
                    <TableHead className="w-[120px]">OTA Status</TableHead>
                    <TableHead className="w-[90px] text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gateways
                    .slice()
                    .sort((a, b) => a.firmware.localeCompare(b.firmware, undefined, { numeric: true }))
                    .map((g) => (
                      <TableRow key={`${g.source}:${g.id}`} className="hover:bg-muted/30">
                        <TableCell>
                          <p className="font-mono text-[11px] font-medium">{g.espId}</p>
                          <p className="text-[10px] text-muted-foreground">{g.siteName}</p>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs">{g.siteName}</TableCell>
                        <TableCell className="text-[10px] font-mono">{g.firmware}</TableCell>
                        <TableCell className="text-[10px] font-mono text-muted-foreground">
                          {g.otaTargetFw ?? "—"}
                        </TableCell>
                        <TableCell>
                          {g.otaStatus ? (
                            <Badge variant="outline" className="text-[9px]">{g.otaStatus}</Badge>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm" variant="outline"
                            className="h-6 px-2 text-[10px]"
                            onClick={() => {
                              setOtaTarget(g);
                              setOtaFw(nextFw(g.firmware, latestFw));
                            }}
                          >
                            <HardDriveDownload className="mr-1 h-3 w-3" />
                            OTA
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* OTA dialog */}
      <Dialog open={!!otaTarget} onOpenChange={(v) => !v && setOtaTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HardDriveDownload className="h-4 w-4 text-emerald-500" />
              OTA Firmware Update
            </DialogTitle>
            <DialogDescription>
              Queue a firmware update for the selected ESP device.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Device: <b className="font-mono text-foreground">{otaTarget?.espId}</b>
            </p>
            <p className="text-xs text-muted-foreground">
              Current: <span className="font-mono">{otaTarget?.firmware}</span>
              {" → "}Target: <span className="font-mono">{otaFw}</span>
            </p>
            <Label className="text-xs">{t("iot.targetFirmware")}</Label>
            <Input value={otaFw} onChange={(e) => setOtaFw(e.target.value)} className="font-mono" dir="ltr" />
            <div className="rounded border bg-muted/30 p-2 text-[11px] text-muted-foreground">
              {t("iot.otaStagingNote")}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOtaTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={startOta} className="bg-emerald-500 hover:bg-emerald-600 text-white">
              <HardDriveDownload className="mr-1.5 h-4 w-4" />
              Deploy OTA
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Tab 3: RS485 Diagnostics
 * ──────────────────────────────────────────────────────────────────────── */

interface BusRow {
  siteId: string;
  siteName: string;
  baud: number;
  parity: string;
  devices: EspGateway[];
  addresses: number[];
  conflicts: number[];
  signalQuality: number; // 0-100 average
}

function Rs485Tab({ gateways, loading, numLang }: {
  gateways: EspGateway[];
  loading: boolean;
  numLang: Language;
}) {
  const t = useT();

  // Group by site → then by (baud, parity) bus
  const buses: BusRow[] = useMemo(() => {
    const bySite = new Map<string, EspGateway[]>();
    for (const g of gateways) {
      const arr = bySite.get(g.siteId) ?? [];
      arr.push(g);
      bySite.set(g.siteId, arr);
    }
    const rows: BusRow[] = [];
    for (const [siteId, devs] of bySite.entries()) {
      // Group by baud+parity within site (each unique combo = separate bus)
      const byBus = new Map<string, EspGateway[]>();
      for (const d of devs) {
        const key = `${d.rs485Baudrate}:${d.rs485Parity}`;
        const arr = byBus.get(key) ?? [];
        arr.push(d);
        byBus.set(key, arr);
      }
      const site = devs[0];
      for (const [busKey, busDevs] of byBus.entries()) {
        const [baudStr, parity] = busKey.split(":");
        const addresses = busDevs.map((d) => d.rs485Address).sort((a, b) => a - b);
        // Find duplicate addresses
        const addrCount = new Map<number, number>();
        for (const a of addresses) addrCount.set(a, (addrCount.get(a) ?? 0) + 1);
        const conflicts = Array.from(addrCount.entries())
          .filter(([, n]) => n > 1)
          .map(([a]) => a);
        // Signal quality: map RSSI [-100, -30] → [0, 100]
        const avgRssi = busDevs.reduce((s, d) => s + d.wifiRssi, 0) / (busDevs.length || 1);
        const sq = Math.max(0, Math.min(100, Math.round(((avgRssi + 100) / 70) * 100)));
        rows.push({
          siteId,
          siteName: site.siteName,
          baud: Number(baudStr),
          parity,
          devices: busDevs,
          addresses,
          conflicts,
          signalQuality: sq,
        });
      }
    }
    return rows.sort((a, b) => a.siteName.localeCompare(b.siteName));
  }, [gateways]);

  const totalConflicts = buses.reduce((s, b) => s + b.conflicts.length, 0);
  const totalBuses = buses.length;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-emerald-500" />
              <p className="text-xs text-muted-foreground">Total Buses</p>
            </div>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatNumber(totalBuses, numLang)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              {totalConflicts === 0 ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-rose-500" />
              )}
              <p className="text-xs text-muted-foreground">Address Conflicts</p>
            </div>
            <p className={"mt-1 text-2xl font-semibold tabular-nums " + (totalConflicts > 0 ? "text-rose-500" : "text-emerald-500")}>
              {formatNumber(totalConflicts, numLang)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-emerald-500" />
              <p className="text-xs text-muted-foreground">Total RS485 Devices</p>
            </div>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatNumber(gateways.length, numLang)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Bus table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">RS485 Bus Health per Site</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading && gateways.length === 0 ? (
            <RegistrySkeleton cols={6} />
          ) : buses.length === 0 ? (
            <EmptyState icon={Radio} title="No RS485 buses" description="No RS485-connected ESP devices detected." />
          ) : (
            <div className="max-h-[600px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>{t("common.site")}</TableHead>
                    <TableHead className="w-[120px]">Bus Config</TableHead>
                    <TableHead className="w-[60px]">Devices</TableHead>
                    <TableHead className="w-[200px]">Addresses</TableHead>
                    <TableHead className="w-[150px]">Signal Quality</TableHead>
                    <TableHead className="w-[110px]">{t("common.status")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {buses.map((b, idx) => (
                    <TableRow key={`${b.siteId}:${idx}`} className="hover:bg-muted/30">
                      <TableCell>
                        <p className="text-xs font-medium">{b.siteName}</p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {b.siteId.slice(-8)}
                        </p>
                      </TableCell>
                      <TableCell className="text-[10px] font-mono">
                        <div className="tabular-nums">{formatNumber(b.baud, numLang)} baud</div>
                        <div className="text-[9px] text-muted-foreground">{b.parity}</div>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {formatNumber(b.devices.length, numLang)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {b.addresses.map((a, i) => {
                            const isConflict = b.conflicts.includes(a);
                            return (
                              <Badge
                                key={i}
                                variant="outline"
                                className={
                                  "text-[9px] tabular-nums " +
                                  (isConflict
                                    ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400")
                                }
                              >
                                {isConflict && <AlertTriangle className="mr-0.5 h-2 w-2" />}
                                {formatNumber(a, numLang)}
                              </Badge>
                            );
                          })}
                          {b.addresses.length === 0 && (
                            <span className="text-[10px] text-muted-foreground">—</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Progress
                            value={b.signalQuality}
                            className={
                              "h-1.5 " +
                              (b.signalQuality > 70
                                ? "[&>div]:bg-emerald-500"
                                : b.signalQuality > 40
                                  ? "[&>div]:bg-amber-500"
                                  : "[&>div]:bg-rose-500")
                            }
                          />
                          <span className="text-[10px] tabular-nums text-muted-foreground">
                            {formatNumber(b.signalQuality, numLang)}%
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {b.conflicts.length > 0 ? (
                          <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400 text-[9px]">
                            CONFLICT
                          </Badge>
                        ) : b.signalQuality > 50 ? (
                          <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[9px]">
                            HEALTHY
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[9px]">
                            DEGRADED
                          </Badge>
                        )}
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
 * Tab 4: ESP Reboot
 * ──────────────────────────────────────────────────────────────────────── */

function RebootTab({ gateways, loading, numLang, onReboot, isAdmin }: {
  gateways: EspGateway[];
  loading: boolean;
  numLang: Language;
  onReboot: (delayMs?: number) => void;
  isAdmin: boolean;
}) {
  const t = useT();
  const [confirmTarget, setConfirmTarget] = useState<EspGateway | null>(null);
  const [rebooting, setRebooting] = useState(false);

  const doReboot = async () => {
    if (!confirmTarget) return;
    setRebooting(true);
    try {
      let res;
      if (confirmTarget.source === "iot") {
        res = await apiPatch("/api/fgmp/iot", {
          deviceId: confirmTarget.id,
          action: "reboot",
        });
      } else {
        // For dispensers: use the dispenser control endpoint with RESET
        // which is the closest semantic match to a reboot.
        res = await apiPatch(`/api/fgmp/dispensers/${confirmTarget.id}`, {
          status: "OFFLINE", // mark offline while it reboots
        });
        // Then issue a control RESET via POST (best-effort).
        try {
          await fetch(`/api/fgmp/dispensers/${confirmTarget.id}/control`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: "RESET" }),
            credentials: "include",
          });
        } catch {
          /* swallow — already marked offline */
        }
      }
      if (res.ok) {
        toast.success(`Reboot sent to ${confirmTarget.espId}`);
        setConfirmTarget(null);
        onReboot(3000);
      } else {
        toast.error("Reboot failed", { description: res.error });
      }
    } finally {
      setRebooting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-emerald-500" />
          ESP Device Reboot
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {loading && gateways.length === 0 ? (
          <RegistrySkeleton cols={5} />
        ) : gateways.length === 0 ? (
          <EmptyState icon={RefreshCw} title="No ESP devices" description="No ESP devices available to reboot." />
        ) : (
          <div className="max-h-[600px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>ESP Device ID</TableHead>
                  <TableHead className="hidden md:table-cell">{t("common.site")}</TableHead>
                  <TableHead className="hidden lg:table-cell w-[100px]">{t("iot.firmware")}</TableHead>
                  <TableHead className="w-[120px]">Last Comm</TableHead>
                  <TableHead className="w-[100px]">{t("common.status")}</TableHead>
                  <TableHead className="w-[110px] text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gateways.map((g) => (
                  <TableRow key={`${g.source}:${g.id}`} className="hover:bg-muted/30">
                    <TableCell>
                      <p className="font-mono text-[11px] font-medium">{g.espId}</p>
                      <p className="text-[10px] text-muted-foreground">{g.source}</p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs">{g.siteName}</TableCell>
                    <TableCell className="hidden lg:table-cell text-[10px] font-mono">{g.firmware}</TableCell>
                    <TableCell className="text-[10px] text-muted-foreground">
                      {g.lastCommMs ? timeAgo(new Date(g.lastCommMs).toISOString(), numLang) : "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={g.status} className="h-5 text-[9px]" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm" variant="outline"
                        className="h-7 px-2 text-[10px]"
                        disabled={!isAdmin}
                        onClick={() => setConfirmTarget(g)}
                      >
                        <RefreshCw className="mr-1 h-3 w-3" />
                        Reboot
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <AlertDialog open={!!confirmTarget} onOpenChange={(o) => !o && setConfirmTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-amber-500" />
              Confirm ESP Reboot
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will send a reboot command to the ESP device. It will be temporarily unavailable during the restart.
              <br />
              <span className="font-mono text-[11px] text-foreground">{confirmTarget?.espId}</span>
              {" · "}
              <span className="text-xs">{confirmTarget?.siteName}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rebooting}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void doReboot(); }}
              disabled={rebooting}
              className="bg-amber-500 hover:bg-amber-600 text-white"
            >
              {rebooting ? "…" : "Reboot Now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Shared small components
 * ──────────────────────────────────────────────────────────────────────── */

function RssiBar({ rssi, numLang }: { rssi: number; numLang: Language }) {
  // Map RSSI [-100, -30] → [0, 100]%
  const pct = Math.max(0, Math.min(100, Math.round(((rssi + 100) / 70) * 100)));
  const color = pct > 70 ? "bg-emerald-500" : pct > 40 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex items-center gap-1.5">
      <Wifi className={"h-3 w-3 " + (pct > 70 ? "text-emerald-500" : pct > 40 ? "text-amber-500" : "text-rose-500")} />
      <div className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
        <div className={"h-full " + color} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground">
        {formatNumber(rssi, numLang)}dBm
      </span>
    </div>
  );
}

function RegistrySkeleton({ cols }: { cols: number }) {
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

function nextFw(current: string, latest: string): string {
  const m = current.match(/v(\d+)\.(\d+)\.(\d+)/);
  if (!m) return latest;
  const [, maj, min, pat] = m;
  return `v${maj}.${min}.${Number(pat) + 1}`;
}
