"use client";

import { useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Wrench, Plus, CheckCircle2, Calendar, User, Flag, X, Download } from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPost } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { StatusBadge } from "@/components/fgmp/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { fmtDateTime, timeAgo } from "@/lib/fgmp/format";
import { downloadCsv, exportFilename } from "@/lib/fgmp/csv-export";
import { cn } from "@/lib/utils";
import { MaintenanceGantt } from "@/components/fgmp/maintenance-gantt";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { translate } from "@/lib/fgmp/i18n";
import { ResourceError } from "@/components/fgmp/resource-error";

/** Resolve a maintenance ticket type enum value to its localized display label. */
function maintenanceTypeLabel(type: string, lang: Language): string {
  if (!type) return "";
  const key = `maintenance.type.${type}`;
  const translated = translate(key, lang);
  return translated === key ? type.replace(/_/g, " ") : translated;
}

/** Resolve a maintenance asset kind enum value to its localized display label. */
function maintenanceAssetKindLabel(kind: string, lang: Language): string {
  if (!kind) return "";
  const key = `maintenance.assetKind.${kind}`;
  const translated = translate(key, lang);
  return translated === key ? kind.replace(/_/g, " ") : translated;
}

/** Resolve a maintenance ticket status enum value to its localized display label. */
function maintenanceStatusLabel(status: string, lang: Language): string {
  if (!status) return "";
  const key = `status.${status.toLowerCase()}`;
  const translated = translate(key, lang);
  return translated === key ? status.replace(/_/g, " ") : translated;
}

const PRIORITY_TONE: Record<string, string> = {
  P1: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  P2: "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  P3: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  P4: "border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-400",
};

const STATUS_BORDER: Record<string, string> = {
  OPEN: "border-l-2 border-l-sky-500",
  SCHEDULED: "border-l-2 border-l-amber-500",
  IN_PROGRESS: "border-l-2 border-l-violet-500",
  DONE: "border-l-2 border-l-emerald-500",
};

const STATUS_BADGE_DETAIL: Record<string, string> = {
  OPEN: "border-sky-500/40 bg-sky-500/15 text-sky-600 dark:text-sky-400",
  SCHEDULED: "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400",
  IN_PROGRESS: "border-violet-500/40 bg-violet-500/15 text-violet-600 dark:text-violet-400",
  DONE: "border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
};

export function MaintenanceView() {
  const { snapshot, tick } = useFgmp(useShallow((s) => ({ snapshot: s.snapshot, tick: s.tick })));
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const [status, setStatus] = useState("OPEN,SCHEDULED,IN_PROGRESS");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const { data: tickets, error: ticketsError, refetch } = useApi<any[]>(`/api/fgmp/maintenance?status=${status}`, { interval: 8000 });

  const counts = useMemo(() => ({
    open: (tickets ?? []).filter((t) => t.status === "OPEN").length,
    scheduled: (tickets ?? []).filter((t) => t.status === "SCHEDULED").length,
    inProgress: (tickets ?? []).filter((t) => t.status === "IN_PROGRESS").length,
    done: (tickets ?? []).filter((t) => t.status === "DONE").length,
    total: (tickets ?? []).length,
  }), [tickets]);

  const selectedTicket = useMemo(
    () => (tickets ?? []).find((t) => t.id === selectedTicketId) ?? null,
    [tickets, selectedTicketId],
  );

  if (!snapshot) return null;
  const k = snapshot.kpis;

  const complete = async (id: string) => {
    const res = await apiPost("/api/fgmp/maintenance", { action: "complete", ticketId: id });
    if (res.ok) { toast.success(t("maintenance.completedToast")); refetch(); tick(20); }
  };

  // Export the *currently-filtered* maintenance ticket list to CSV.
  // The `tickets` array is already server-side filtered by the active status
  // tab (Active / Done / All) via the `?status=` query param on the API URL.
  // Pure client-side Blob download — no backend round-trip.
  const handleExportTickets = () => {
    try {
      const list = tickets ?? [];
      if (list.length === 0) {
        toast.error(t("maintenance.noTicketsToExport"));
        return;
      }
      const header = [
        t("maintenance.priority"),
        t("maintenance.title"),
        t("maintenance.type"),
        t("alarms.siteCode"),
        t("alarms.siteName"),
        t("maintenance.asset"),
        t("maintenance.assignee"),
        t("alarms.status"),
        t("inventory.scheduledAt"),
        t("common.created"),
        t("maintenance.notes"),
      ];
      const rows: (string | number)[][] = [header];
      for (const t of list) {
        rows.push([
          t.priority ?? "",
          t.title ?? "",
          maintenanceTypeLabel(t.type ?? "", numLang),
          t.site?.code ?? "",
          t.site?.name ?? "",
          maintenanceAssetKindLabel(t.assetKind ?? "", numLang),
          t.assignedTo?.name ?? "",
          maintenanceStatusLabel(t.status ?? "", numLang),
          t.scheduledFor ? fmtDateTime(t.scheduledFor, numLang) : "",
          t.createdAt ? fmtDateTime(t.createdAt, numLang) : "",
          t.description ?? "",
        ]);
      }
      downloadCsv(rows, exportFilename("maintenance"));
      toast.success(`${formatNumber(list.length, numLang)} ${t("maintenance.exportedToast")}`);
    } catch (err) {
      toast.error(`${t("maintenance.exportFailed")}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Generators due for maintenance from engine
  const dueGens = snapshot.generators.filter((g) => g.runtimeHours >= g.nextMaintenanceHrs - 20).map((g) => ({ ...g, site: snapshot.sites.find((s) => s.id === g.siteId)?.name }));

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.maintenance")}
        description={t("desc.maintenance")}
        icon={<Wrench className="h-5 w-5" />}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportTickets}
              disabled={(tickets ?? []).length === 0}
              data-testid="export-maintenance-csv"
              title={(tickets ?? []).length === 0 ? t("maintenance.noTicketsHint") : `${formatNumber((tickets ?? []).length, numLang)} ${t("alarms.exportAlarms")}`}
            >
              <Download className="mr-1.5 h-4 w-4" /> {t("common.export")}
            </Button>
            <CreateTicketDialog open={createOpen} onOpenChange={setCreateOpen} sites={snapshot.sites} generators={snapshot.generators} onCreated={() => { refetch(); setCreateOpen(false); }} />
          </>
        }
      />

      <ResourceError error={ticketsError} onRetry={refetch} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard label={t("maintenance.openTickets")} value={formatNumber(k.openTickets, numLang)} icon={<Wrench className="h-4 w-4" />} tone={k.openTickets > 0 ? "warn" : "good"} />
        <KpiCard label={t("maintenance.open")} value={formatNumber(counts.open, numLang)} icon={<Flag className="h-4 w-4" />} tone="warn" />
        <KpiCard label={t("maintenance.scheduled")} value={formatNumber(counts.scheduled, numLang)} icon={<Calendar className="h-4 w-4" />} tone="info" />
        <KpiCard label={t("maintenance.inProgress")} value={formatNumber(counts.inProgress, numLang)} icon={<Wrench className="h-4 w-4" />} tone="info" />
        <KpiCard label={t("maintenance.dueSoon")} value={formatNumber(dueGens.length, numLang)} icon={<Calendar className="h-4 w-4" />} tone={dueGens.length ? "warn" : "good"} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm">{t("maintenance.tickets")} ({formatNumber(tickets?.length ?? 0, numLang)})</CardTitle>
            <Tabs value={status} onValueChange={setStatus}>
              <TabsList className="h-8">
                <TabsTrigger value="OPEN,SCHEDULED,IN_PROGRESS" className="text-xs">{t("common.active")}</TabsTrigger>
                <TabsTrigger value="DONE" className="text-xs">{t("maintenance.done")}</TabsTrigger>
                <TabsTrigger value="OPEN,SCHEDULED,IN_PROGRESS,DONE" className="text-xs">{t("common.all")}</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="p-0">
            {/* Ticket stats mini bar */}
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t("maintenance.ticketsLabel")}:</span>
              <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400">{formatNumber(counts.open, numLang)} {t("maintenance.open")}</span>
              <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">{formatNumber(counts.scheduled, numLang)} {t("maintenance.scheduled")}</span>
              <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400">{formatNumber(counts.inProgress, numLang)} {t("maintenance.inProgress")}</span>
              <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">{formatNumber(counts.done, numLang)} {t("maintenance.done")}</span>
            </div>
            <ScrollArea className="h-[520px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead className="w-[60px]">{t("maintenance.pri")}</TableHead>
                    <TableHead>{t("maintenance.title")}</TableHead>
                    <TableHead className="hidden md:table-cell w-[110px]">{t("maintenance.type")}</TableHead>
                    <TableHead className="hidden lg:table-cell w-[140px]">{t("maintenance.assignee")}</TableHead>
                    <TableHead className="w-[90px]">{t("alarms.status")}</TableHead>
                    <TableHead className="hidden md:table-cell w-[100px]">{t("maintenance.scheduled")}</TableHead>
                    <TableHead className="w-[90px] text-right">{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(tickets ?? []).map((tk) => (
                    <TableRow key={tk.id} className={cn("transition-all hover:shadow-md hover:border-border", STATUS_BORDER[tk.status])}>
                      <TableCell><Badge variant="outline" className={cn("h-5 text-[9px]", PRIORITY_TONE[tk.priority])}>{tk.priority}</Badge></TableCell>
                      <TableCell>
                        <p className="text-xs font-medium">{tk.title}</p>
                        <p className="text-[10px] text-muted-foreground">{tk.site?.name} · {maintenanceAssetKindLabel(tk.assetKind, numLang)}</p>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-[11px]">{maintenanceTypeLabel(tk.type, numLang)}</TableCell>
                      <TableCell className="hidden lg:table-cell text-[11px] text-muted-foreground">{tk.assignedTo?.name ?? "—"}</TableCell>
                      <TableCell><StatusBadge value={tk.status} className="h-5 text-[9px]" /></TableCell>
                      <TableCell className="hidden md:table-cell text-[10px] text-muted-foreground">{tk.scheduledFor ? timeAgo(tk.scheduledFor, numLang) : "—"}</TableCell>
                      <TableCell className="text-right">
                        {tk.status !== "DONE" && (
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-emerald-600 hover:bg-emerald-500/10" onClick={() => complete(tk.id)}>
                            <CheckCircle2 className="mr-1 h-3 w-3" />{t("maintenance.complete")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {(tickets ?? []).length === 0 && <TableRow><TableCell colSpan={7} className="py-12 text-center text-sm text-muted-foreground">{t("maintenance.noTickets")}</TableCell></TableRow>}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Calendar className="h-4 w-4 text-amber-500" /> {t("maintenance.predictive")}</CardTitle></CardHeader>
          <CardContent className="p-3">
            <div className="max-h-[500px] space-y-2 overflow-y-auto">
              {dueGens.map((g) => (
                <div key={g.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{g.label}</span>
                    <Badge variant="outline" className="h-4 px-1 text-[8px] border-amber-500/40 text-amber-600 dark:text-amber-400">{t("maintenance.due")}</Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{g.site} · {g.manufacturer}</p>
                  <div className="mt-1.5 flex items-center justify-between text-[10px]">
                    <span className="text-muted-foreground">{t("maintenance.runtime")}: <b className="text-foreground">{formatNumber(Math.round(g.runtimeHours), numLang)}h</b></span>
                    <span className="text-muted-foreground">{t("maintenance.next")}: <b className="text-amber-600 dark:text-amber-400">{formatNumber(Math.round(g.nextMaintenanceHrs), numLang)}h</b></span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-amber-500" style={{ width: `${Math.min(100, (g.runtimeHours / g.nextMaintenanceHrs) * 100)}%` }} />
                  </div>
                </div>
              ))}
              {dueGens.length === 0 && <p className="py-8 text-center text-xs text-muted-foreground">{t("maintenance.noGensDue")}</p>}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Calendar className="h-4 w-4 text-violet-500" />
            {t("maintenance.gantt")}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("maintenance.ganttDesc")}
          </p>
        </CardHeader>
        <CardContent>
          <MaintenanceGantt tickets={tickets ?? []} onTicketClick={(id) => setSelectedTicketId(id)} />
        </CardContent>
      </Card>

      {/* Ticket Detail Card */}
      {selectedTicket && (
        <div className="animate-slide-in-up rounded-xl border bg-card/50 backdrop-blur p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold">{selectedTicket.title}</h3>
              <Badge variant="outline" className={cn("h-5 text-[9px]", PRIORITY_TONE[selectedTicket.priority])}>
                {selectedTicket.priority}
              </Badge>
              <Badge variant="outline" className={cn("h-5 text-[9px]", STATUS_BADGE_DETAIL[selectedTicket.status] ?? "")}>
                {maintenanceStatusLabel(selectedTicket.status, numLang)}
              </Badge>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setSelectedTicketId(null)} className="h-7 w-7 p-0">
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("alarms.site")}</p>
              <p className="text-sm font-medium">{selectedTicket.site?.name ?? "—"}</p>
              <p className="text-[10px] text-muted-foreground">{selectedTicket.site?.code ?? ""}</p>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("maintenance.asset")}</p>
              <p className="text-sm font-medium">{maintenanceAssetKindLabel(selectedTicket.assetKind, numLang)}</p>
              <p className="text-[10px] text-muted-foreground">{maintenanceTypeLabel(selectedTicket.type, numLang)}</p>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("alarms.status")}</p>
              <Badge variant="outline" className={cn("mt-0.5 h-5 text-[9px]", STATUS_BADGE_DETAIL[selectedTicket.status] ?? "")}>
                {maintenanceStatusLabel(selectedTicket.status, numLang)}
              </Badge>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("maintenance.scheduled")}</p>
              <p className="text-sm font-medium">{selectedTicket.scheduledFor ? fmtDateTime(selectedTicket.scheduledFor, numLang) : "—"}</p>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("maintenance.completedAt")}</p>
              <p className="text-sm font-medium">{selectedTicket.completedAt ? fmtDateTime(selectedTicket.completedAt, numLang) : "—"}</p>
            </div>
            {selectedTicket.assignedTo?.name && (
              <div className="rounded-lg border bg-muted/30 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("maintenance.assignedTo")}</p>
                <p className="flex items-center gap-1 text-sm font-medium">
                  <User className="h-3 w-3 text-muted-foreground" />
                  {selectedTicket.assignedTo.name}
                </p>
              </div>
            )}
          </div>

          {(selectedTicket.description || selectedTicket.notes) && (
            <div className="mt-3 rounded-lg border bg-muted/30 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("maintenance.notes")}</p>
              <p className="mt-0.5 text-sm">{selectedTicket.description || selectedTicket.notes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CreateTicketDialog({ open, onOpenChange, sites, generators, onCreated }: {
  open: boolean; onOpenChange: (v: boolean) => void; sites: any[]; generators: any[]; onCreated: () => void;
}) {
  const t = useT();
  const [siteId, setSiteId] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("PREVENTIVE");
  const [priority, setPriority] = useState("P3");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const siteGens = generators.filter((g) => g.siteId === siteId);

  const submit = async () => {
    if (!siteId || !title) { toast.error(t("maintenance.siteTitleRequired")); return; }
    const gen = siteGens[0];
    setBusy(true);
    const res = await apiPost("/api/fgmp/maintenance", { action: "create", siteId, assetKind: "GENERATOR", assetId: gen?.id ?? "", type, priority, title, description });
    setBusy(false);
    if (res.ok) { toast.success(t("maintenance.ticketCreated")); onCreated(); setTitle(""); setDescription(""); }
    else toast.error(t("maintenance.createFailed"), { description: res.error });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild><Button size="sm"><Plus className="mr-1.5 h-4 w-4" />{t("maintenance.newTicket")}</Button></DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t("maintenance.createTicket")}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Label className="text-xs">{t("maintenance.site")}</Label>
            <Select value={siteId} onValueChange={setSiteId}><SelectTrigger><SelectValue placeholder={t("inventory.selectSite")} /></SelectTrigger><SelectContent className="max-h-60">{sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.code} · {s.name}</SelectItem>)}</SelectContent></Select>
          </div>
          <div>
            <Label className="text-xs">{t("maintenance.type")}</Label>
            <Select value={type} onValueChange={setType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="PREVENTIVE">{t("maintenance.typePreventive")}</SelectItem><SelectItem value="CORRECTIVE">{t("maintenance.typeCorrective")}</SelectItem><SelectItem value="OIL_CHANGE">{t("maintenance.typeOilChange")}</SelectItem><SelectItem value="INSPECTION">{t("maintenance.typeInspection")}</SelectItem><SelectItem value="CALIBRATION">{t("maintenance.typeCalibration")}</SelectItem></SelectContent></Select>
          </div>
          <div>
            <Label className="text-xs">{t("maintenance.priority")}</Label>
            <Select value={priority} onValueChange={setPriority}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="P1">{t("maintenance.p1Critical")}</SelectItem><SelectItem value="P2">{t("maintenance.p2High")}</SelectItem><SelectItem value="P3">{t("maintenance.p3Medium")}</SelectItem><SelectItem value="P4">{t("maintenance.p4Low")}</SelectItem></SelectContent></Select>
          </div>
          <div className="col-span-2">
            <Label className="text-xs">{t("maintenance.title")}</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("maintenance.titlePlaceholder")} />
          </div>
          <div className="col-span-2">
            <Label className="text-xs">{t("maintenance.description")}</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("maintenance.cancel")}</Button>
          <Button onClick={submit} disabled={busy}>{busy ? t("maintenance.creating") : t("maintenance.createTicketBtn")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
