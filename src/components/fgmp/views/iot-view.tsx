"use client";

import { useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Cpu, Wifi, Search, RefreshCw, Radio, HardDriveDownload } from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPatch } from "@/lib/fgmp/use-api";
import { TruncationNote } from "@/components/fgmp/truncation-note";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { StatusBadge } from "@/components/fgmp/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import type { IoTDeviceRow } from "@/lib/fgmp/types";
import { translate } from "@/lib/fgmp/i18n";
import { ResourceError } from "@/components/fgmp/resource-error";

const PROTOCOLS = ["RS485", "MODBUS_RTU", "MODBUS_TCP", "MQTT", "HTTP", "SNMP"];
const TYPES = ["FUEL_SENSOR", "GENERATOR_CONTROLLER", "BATTERY_SENSOR", "POWER_METER", "ENVIRONMENTAL"];

/** Resolve an IoT device type enum value to its localized display label. */
function iotTypeLabel(type: string, lang: Language): string {
  const key = `iot.type.${type}`;
  const translated = translate(key, lang);
  return translated === key ? (type ?? "").replace(/_/g, " ") : translated;
}

/** Resolve an IoT protocol enum value to its localized display label. */
function iotProtocolLabel(proto: string, lang: Language): string {
  const key = `iot.protocol.${proto}`;
  const translated = translate(key, lang);
  return translated === key ? (proto ?? "").replace(/_/g, " ") : translated;
}

export function IotView() {
  const { snapshot, tick } = useFgmp(useShallow((s) => ({ snapshot: s.snapshot, tick: s.tick })));
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const { data: devices, error: devicesError, refetch } = useApi<IoTDeviceRow[]>("/api/fgmp/iot", { interval: 8000 });
  const [q, setQ] = useState("");
  const [protocol, setProtocol] = useState("all");
  const [type, setType] = useState("all");
  const [ota, setOta] = useState<{ id: string; name: string; current: string } | null>(null);
  const [otaFw, setOtaFw] = useState("v3.2.0");

  const filtered = useMemo(() => {
    let list = devices ?? [];
    if (protocol !== "all") list = list.filter((d) => d.protocol === protocol);
    if (type !== "all") list = list.filter((d) => d.type === type);
    if (q) list = list.filter((d) => `${d.name} ${d.serialNo} ${d.vendor} ${d.site?.name}`.toLowerCase().includes(q.toLowerCase()));
    return list;
  }, [devices, q, protocol, type]);

  if (!snapshot) return null;
  const online = (devices ?? []).filter((d) => d.liveStatus === "ONLINE").length;
  const offline = (devices ?? []).filter((d) => d.liveStatus === "OFFLINE").length;
  const byProto = PROTOCOLS.map((p) => ({ p, n: (devices ?? []).filter((d) => d.protocol === p).length }));

  const doOta = async () => {
    if (!ota) return;
    const res = await apiPatch("/api/fgmp/iot", { deviceId: ota.id, action: "ota", firmware: otaFw });
    if (res.ok) { toast.success(`${t("iot.otaQueued")} ${ota.name}`, { description: `${t("iot.targetFirmwareLabel")}: ${otaFw}` }); setOta(null); refetch(); tick(30); }
    else toast.error(t("iot.otaFailed"), { description: res.error });
  };
  const reboot = async (id: string, name: string) => {
    const res = await apiPatch("/api/fgmp/iot", { deviceId: id, action: "reboot" });
    if (res.ok) { toast.success(`${t("iot.rebootSent")} ${name}`); refetch(); tick(20); }
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.iot")}
        description={t("desc.iot")}
        icon={<Cpu className="h-5 w-5" />}
        /* No export button: `GET /api/fgmp/export` has no IoT dataset, and this
           screen used to download SITE records under an export label. The
           `view:iot` grant that made that possible is gone from the export rule
           too (rbac-core.ts EXPORT_TYPE_CAPABILITIES). */
      />

      <ResourceError error={devicesError} onRetry={refetch} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label={t("iot.totalDevices")} value={formatNumber(devices?.length ?? 0, numLang)} icon={<Cpu className="h-4 w-4" />} />
        <KpiCard label={t("iot.online")} value={formatNumber(online, numLang)} icon={<Wifi className="h-4 w-4" />} tone="good" />
        <KpiCard label={t("iot.offline")} value={formatNumber(offline, numLang)} icon={<Wifi className="h-4 w-4" />} tone={offline ? "danger" : "good"} />
        <KpiCard label={t("iot.protocols")} value={formatNumber(PROTOCOLS.length, numLang)} icon={<Radio className="h-4 w-4" />} tone="info" />
        <KpiCard label={t("iot.avgSignal")} value={`${formatNumber(Math.round((devices ?? []).reduce((a, d) => a + d.signalRssi, 0) / (devices?.length || 1)), numLang)} dBm`} icon={<Radio className="h-4 w-4" />} />
        <KpiCard label={t("iot.otaPending")} value={formatNumber((devices ?? []).filter((d) => d.otaStatus === "IN_PROGRESS").length, numLang)} icon={<HardDriveDownload className="h-4 w-4" />} tone="warn" />
      </div>

      {/* Protocol distribution */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">{t("iot.protocolDistribution")}</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {byProto.map((b) => (
              <div key={b.p} className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
                <Radio className="h-4 w-4 text-emerald-500" />
                <span className="text-xs font-medium">{iotProtocolLabel(b.p, numLang)}</span>
                <Badge variant="secondary" className="text-[10px]">{formatNumber(b.n, numLang)}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Device table */}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
          <CardTitle className="text-sm">{t("iot.deviceRegistry")} ({formatNumber(filtered.length, numLang)})</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("iot.search")} className="h-9 w-[200px] pl-8" />
            </div>
            <Select label={t("iot.protocol")} value={protocol} onValueChange={setProtocol}>
              <SelectTrigger className="h-9 w-[140px] text-xs"><SelectValue placeholder={t("iot.protocolPlaceholder")} /></SelectTrigger>
              <SelectContent><SelectItem value="all">{t("iot.allProtocols")}</SelectItem>{PROTOCOLS.map((p) => <SelectItem key={p} value={p}>{iotProtocolLabel(p, numLang)}</SelectItem>)}</SelectContent>
            </Select>
            <Select label={t("iot.deviceType")} value={type} onValueChange={setType}>
              <SelectTrigger className="h-9 w-[170px] text-xs"><SelectValue placeholder={t("iot.typePlaceholder")} /></SelectTrigger>
              <SelectContent><SelectItem value="all">{t("iot.allTypes")}</SelectItem>{TYPES.map((tp) => <SelectItem key={tp} value={tp}>{iotTypeLabel(tp, numLang)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[600px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>{t("iot.device")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("alarms.site")}</TableHead>
                  <TableHead className="w-[130px]">{t("iot.deviceType")}</TableHead>
                  <TableHead className="w-[110px]">{t("iot.protocol")}</TableHead>
                  <TableHead className="hidden lg:table-cell w-[120px]">{t("iot.ipUnit")}</TableHead>
                  <TableHead className="hidden lg:table-cell w-[90px]">{t("iot.firmware")}</TableHead>
                  <TableHead className="w-[70px]">{t("iot.signal")}</TableHead>
                  <TableHead className="w-[80px]">{t("alarms.status")}</TableHead>
                  <TableHead className="w-[150px] text-right">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.slice(0, 100).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <p className="text-xs font-medium">{d.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{d.serialNo}</p>
                      <p className="text-[10px] text-muted-foreground">{d.vendor}</p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs">{d.site?.name}</TableCell>
                    <TableCell><Badge variant="outline" className="text-[10px]">{iotTypeLabel(d.type, numLang)}</Badge></TableCell>
                    <TableCell className="text-[11px]">{iotProtocolLabel(d.protocol, numLang)}</TableCell>
                    <TableCell className="hidden lg:table-cell text-[10px] text-muted-foreground">{d.ipAddress}{d.modbusUnit ? ` · u${formatNumber(d.modbusUnit, numLang)}` : ""}</TableCell>
                    <TableCell className="hidden lg:table-cell text-[10px]">{d.firmware}</TableCell>
                    <TableCell className="text-[10px] tabular-nums">{formatNumber(d.signalRssi, numLang)}dBm</TableCell>
                    <TableCell><StatusBadge value={d.liveStatus} className="h-5 text-[10px]" /></TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => { setOta({ id: d.id, name: d.name, current: d.firmware }); setOtaFw(nextFw(d.firmware)); }}>
                          <HardDriveDownload className="mr-1 h-3 w-3" />{t("iot.ota")}
                        </Button>
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => reboot(d.id, d.name)} aria-label={t("iot.rebootDevice")} title={t("iot.rebootDevice")}><RefreshCw className="h-3 w-3" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <TruncationNote shown={100} total={filtered.length} />
        </CardContent>
      </Card>

      {/* OTA dialog */}
      <Dialog open={!!ota} onOpenChange={(v) => !v && setOta(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><HardDriveDownload className="h-4 w-4 text-emerald-500" />{t("iot.otaFirmwareUpdate")}</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t("iot.deviceLabel")}: <b className="text-foreground">{ota?.name}</b></p>
            <p className="text-xs text-muted-foreground">{t("iot.currentLabel")}: <span className="font-mono">{ota?.current}</span> → {t("iot.targetLabel")}: <span className="font-mono">{otaFw}</span></p>
            <Label className="text-xs">{t("iot.targetFirmware")}</Label>
            <Input value={otaFw} onChange={(e) => setOtaFw(e.target.value)} />
            <div className="rounded border bg-muted/30 p-2 text-[11px] text-muted-foreground">{t("iot.otaStagingNote")}</div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOta(null)}>{t("common.cancel")}</Button>
            <Button onClick={doOta} className="bg-emerald-500 hover:bg-emerald-600 text-white"><HardDriveDownload className="mr-1.5 h-4 w-4" />{t("iot.deployOta")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function nextFw(current: string): string {
  const m = current.match(/v(\d+)\.(\d+)\.(\d+)/);
  if (!m) return "v3.0.0";
  const [, maj, min, pat] = m;
  return `v${maj}.${min}.${Number(pat) + 1}`;
}
