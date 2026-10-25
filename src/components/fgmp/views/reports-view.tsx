"use client";

import { useMemo, useState } from "react";
import { FileText, FileSpreadsheet, FileType2, Calendar } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApi } from "@/lib/fgmp/use-api";
import { TruncationNote } from "@/components/fgmp/truncation-note";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { StatusBadge } from "@/components/fgmp/status-badge";
import { ExportButton } from "@/components/fgmp/export-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fmtDateTime, fmtDateTimeShort } from "@/lib/fgmp/format";
import { csvFilename, type CsvColumn } from "@/lib/fgmp/csv-export";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import type { ReportsPayload } from "@/lib/fgmp/types";
import { alarmTypeLabel, commandTypeLabel } from "@/lib/fgmp/labels";



const PERIODS = [
  { value: "daily", labelKey: "reports.daily" },
  { value: "weekly", labelKey: "reports.weekly" },
  { value: "monthly", labelKey: "reports.monthly" },
  { value: "quarterly", labelKey: "reports.quarterly" },
  { value: "annual", labelKey: "reports.annual" },
];

export function ReportsView() {
  const [period, setPeriod] = useState("daily");
  // Export format for the server-rendered reports
  // (proposal §7: CSV / PDF / Excel).
  const [exportFormat, setExportFormat] = useState<"csv" | "xlsx" | "pdf">("csv");
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const { data, loading } = useApi<ReportsPayload>(`/api/fgmp/reports?period=${period}`, { deps: [period] });

  const s = data?.summary;
  const sevData = s ? [
    { name: "L1", value: s.alarmsBySeverity.L1, fill: "#f59e0b" },
    { name: "L2", value: s.alarmsBySeverity.L2, fill: "#f97316" },
    { name: "L3", value: s.alarmsBySeverity.L3, fill: "#f43f5e" },
  ] : [];

  // Long-format (Metric | Value) export of the summary KPI block — one row
  // per summary metric, mirroring the six KPI cards rendered in the report
  // header. Values are formatted the same way as the cards so the CSV
  // matches what the operator sees on screen (numbers localized per the
  // active language). Pure client-side via <ExportButton/>.
  const summaryExportRows = useMemo(() => {
    if (!s) return [];
    return [
      { metric: t("reports.sites"), value: formatNumber(s.totalSites, numLang) },
      { metric: t("reports.generatorsRunning"), value: `${formatNumber(s.generatorsRunning, numLang)} / ${formatNumber(s.totalGenerators, numLang)}` },
      { metric: t("reports.fuel"), value: `${formatNumber(s.fuelPct, numLang)}% · ${formatNumber((s.totalFuelLitres / 1000).toFixed(1), numLang)}k L` },
      { metric: t("reports.alarms"), value: `${formatNumber(s.alarmsTotal, numLang)} (L3: ${formatNumber(s.alarmsBySeverity.L3, numLang)})` },
      { metric: t("reports.deliveries"), value: `${formatNumber(s.deliveriesTotal, numLang)} (${formatNumber(s.deliveriesVerified, numLang)} ${t("reports.verified")}, ${formatNumber((s.volumeDelivered / 1000).toFixed(1), numLang)}k L)` },
      { metric: t("reports.maintenance"), value: `${formatNumber(s.ticketsTotal, numLang)} (${formatNumber(s.ticketsDone, numLang)} ${t("reports.done")})` },
    ];
  }, [s, t, numLang]);
  const summaryExportColumns: CsvColumn[] = [
    { key: "metric", label: t("csv.metric") },
    { key: "value", label: t("csv.value") },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.reports")}
        description={t("desc.reports")}
        icon={<FileText className="h-5 w-5" />}
        actions={
          <Select label={t("reports.period")} value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[150px]"><Calendar className="mr-1.5 h-4 w-4" /><SelectValue /></SelectTrigger>
            <SelectContent>{PERIODS.map((p) => <SelectItem key={p.value} value={p.value}>{t(p.labelKey)}</SelectItem>)}</SelectContent>
          </Select>
        }
      />

      {loading && <p className="text-sm text-muted-foreground">{t("reports.generating")}</p>}

      {s && (
        <>
          {/* Report meta + export */}
          <Card>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold capitalize">{period} {t("reports.operationsReport")}</p>
                <p className="text-xs text-muted-foreground">{fmtDateTime(s.from, numLang)} → {fmtDateTime(s.to, numLang)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select label={t("reports.exportFormat")} value={exportFormat} onValueChange={(v) => setExportFormat(v as "csv" | "xlsx" | "pdf")}>
                  <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="csv">CSV</SelectItem>
                    <SelectItem value="xlsx">Excel</SelectItem>
                    <SelectItem value="pdf">PDF</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={() => window.open(`/api/fgmp/export?type=sites&format=${exportFormat}`, "_blank")}><FileType2 className="mr-1.5 h-4 w-4" />{t("reports.sitesCsv")}</Button>
                <Button variant="outline" size="sm" onClick={() => window.open(`/api/fgmp/export?type=tanks&format=${exportFormat}`, "_blank")}><FileType2 className="mr-1.5 h-4 w-4" />{t("reports.tanksCsv")}</Button>
                <Button variant="outline" size="sm" onClick={() => window.open(`/api/fgmp/export?type=generators&format=${exportFormat}`, "_blank")}><FileType2 className="mr-1.5 h-4 w-4" />{t("reports.generatorsCsv")}</Button>
                <Button variant="outline" size="sm" onClick={() => window.open(`/api/fgmp/export?type=batteries&format=${exportFormat}`, "_blank")}><FileType2 className="mr-1.5 h-4 w-4" />{t("reports.batteriesCsv")}</Button>
                <ExportButton
                  filename={csvFilename(`report-${period}`)}
                  rows={summaryExportRows}
                  columns={summaryExportColumns}
                  disabled={!s}
                  label={t("common.exportReport")}
                />
                <Button variant="secondary" size="sm" onClick={() => toastPrint()}><FileSpreadsheet className="mr-1.5 h-4 w-4" />{t("reports.printPdf")}</Button>
              </div>
            </CardContent>
          </Card>

          {/* Summary KPIs */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <KpiCard label={t("reports.sites")} value={formatNumber(s.totalSites, numLang)} />
            <KpiCard label={t("reports.generatorsRunning")} value={`${formatNumber(s.generatorsRunning, numLang)} / ${formatNumber(s.totalGenerators, numLang)}`} tone="good" />
            <KpiCard label={t("reports.fuel")} value={`${formatNumber(s.fuelPct, numLang)}%`} unit={`${formatNumber((s.totalFuelLitres / 1000).toFixed(1), numLang)}k L`} tone="info" />
            <KpiCard label={t("reports.alarms")} value={formatNumber(s.alarmsTotal, numLang)} tone={s.alarmsTotal > 0 ? "danger" : "good"} hint={`L3: ${formatNumber(s.alarmsBySeverity.L3, numLang)}`} />
            <KpiCard label={t("reports.deliveries")} value={formatNumber(s.deliveriesTotal, numLang)} unit={`${formatNumber((s.volumeDelivered / 1000).toFixed(1), numLang)}k L`} tone="good" hint={`${formatNumber(s.deliveriesVerified, numLang)} ${t("reports.verified")}`} />
            <KpiCard label={t("reports.maintenance")} value={formatNumber(s.ticketsTotal, numLang)} unit={`${formatNumber(s.ticketsDone, numLang)} ${t("reports.done")}`} tone="info" />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t("reports.alarmsBySeverity")}</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart tabIndex={-1} data={sevData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="currentColor" strokeOpacity={0.3} />
                    <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} allowDecimals={false} />
                    <Tooltip contentStyle={{ fontSize: 12 }} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>{sevData.map((e, i) => <Cell key={i} fill={e.fill} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t("reports.detailedRecords")}</CardTitle></CardHeader>
              <CardContent className="p-0">
                <Tabs defaultValue="alarms">
                  <TabsList className="mx-3 mt-2">
                    <TabsTrigger value="alarms" className="text-xs">{t("reports.alarmsTab")} ({formatNumber(data.alarms.length, numLang)})</TabsTrigger>
                    <TabsTrigger value="deliveries" className="text-xs">{t("reports.deliveriesTab")} ({formatNumber(data.deliveries.length, numLang)})</TabsTrigger>
                    <TabsTrigger value="tickets" className="text-xs">{t("reports.maintenanceTab")} ({formatNumber(data.tickets.length, numLang)})</TabsTrigger>
                    <TabsTrigger value="commands" className="text-xs">{t("reports.commandsTab")} ({formatNumber(data.commands.length, numLang)})</TabsTrigger>
                  </TabsList>
                  <ScrollArea className="h-[280px]">
                    <TabsContent value="alarms" className="m-0 p-2">
                      <Table>
                        <TableHeader><TableRow><TableHead>{t("alarms.type")}</TableHead><TableHead>{t("alarms.site")}</TableHead><TableHead className="w-[70px]">{t("alarms.sev")}</TableHead><TableHead className="w-[120px]">{t("reports.when")}</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {data.alarms.slice(0, 50).map((a) => (
                            <TableRow key={a.id}><TableCell className="text-[11px] font-mono">{alarmTypeLabel(a.type, numLang)}</TableCell><TableCell className="text-xs">{a.site?.name}</TableCell><TableCell><StatusBadge value={a.severity} className="h-5 text-[10px]" /></TableCell><TableCell className="text-[10px] text-muted-foreground">{fmtDateTimeShort(a.createdAt, numLang)}</TableCell></TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <TruncationNote shown={50} total={data.alarms.length} />
                    </TabsContent>
                    <TabsContent value="deliveries" className="m-0 p-2">
                      <Table>
                        <TableHeader><TableRow><TableHead>{t("reports.do")}</TableHead><TableHead>{t("alarms.site")}</TableHead><TableHead className="w-[80px]">{t("inventory.volume")}</TableHead><TableHead className="w-[90px]">{t("alarms.status")}</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {data.deliveries.slice(0, 50).map((d) => (
                            <TableRow key={d.id}><TableCell className="font-mono text-[11px]">{d.doNumber}</TableCell><TableCell className="text-xs">{d.site?.name}</TableCell><TableCell className="text-xs tabular-nums">{formatNumber(Math.round(d.volumeDeliveredLitres ?? d.volumeOrderedLitres), numLang)}L</TableCell><TableCell><StatusBadge value={d.status} className="h-5 text-[10px]" /></TableCell></TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <TruncationNote shown={50} total={data.deliveries.length} />
                    </TabsContent>
                    <TabsContent value="tickets" className="m-0 p-2">
                      <Table>
                        <TableHeader><TableRow><TableHead>{t("maintenance.title")}</TableHead><TableHead>{t("alarms.site")}</TableHead><TableHead className="w-[70px]">{t("maintenance.priority")}</TableHead><TableHead className="w-[90px]">{t("alarms.status")}</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {data.tickets.slice(0, 50).map((t) => (
                            <TableRow key={t.id}><TableCell className="text-xs">{t.title}</TableCell><TableCell className="text-xs">{t.site?.name}</TableCell><TableCell><Badge variant="outline" className="h-5 text-[10px]">{t.priority}</Badge></TableCell><TableCell><StatusBadge value={t.status} className="h-5 text-[10px]" /></TableCell></TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <TruncationNote shown={50} total={data.tickets.length} />
                    </TabsContent>
                    <TabsContent value="commands" className="m-0 p-2">
                      <Table>
                        <TableHeader><TableRow><TableHead>{t("reports.command")}</TableHead><TableHead>{t("reports.generator")}</TableHead><TableHead className="w-[90px]">{t("alarms.status")}</TableHead><TableHead className="w-[120px]">{t("reports.when")}</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {data.commands.slice(0, 50).map((c) => (
                            <TableRow key={c.id}><TableCell className="text-[11px] font-mono">{commandTypeLabel(c.command, numLang)}</TableCell><TableCell className="text-xs">{c.generator?.label}</TableCell><TableCell><StatusBadge value={c.status} className="h-5 text-[10px]" /></TableCell><TableCell className="text-[10px] text-muted-foreground">{fmtDateTimeShort(c.issuedAt, numLang)}</TableCell></TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <TruncationNote shown={50} total={data.commands.length} />
                    </TabsContent>
                  </ScrollArea>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function toastPrint() {
  if (typeof window !== "undefined") window.print();
}
