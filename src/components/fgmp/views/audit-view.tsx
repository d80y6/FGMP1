"use client";

import { useMemo, useState } from "react";
import { ScrollText, Search, ShieldCheck, User, Activity, FileQuestion } from "lucide-react";
import { useApi } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { EmptyState } from "@/components/fgmp/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fmtDateTime, timeAgo } from "@/lib/fgmp/format";
import { cn } from "@/lib/utils";
import { useT, useDir, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { roleLabel } from "@/lib/fgmp/labels";
import { translate } from "@/lib/fgmp/i18n";

const ACTIONS = ["CREATE", "UPDATE", "DELETE", "CONTROL", "ACK", "RESOLVE", "BULK_ACK", "BULK_RESOLVE", "LOGIN", "LOGOUT", "EXPORT", "CONFIG", "SEED", "OTA", "REBOOT", "DELIVERY_CREATE", "DELIVERY_VERIFY", "DELIVERY_DISPATCH", "TICKET_CREATE", "TICKET_COMPLETE", "NOTIF_DISMISS", "NOTIF_DISMISS_ALL"];

/** Resolve an audit action enum value to its localized display label. */
function auditActionLabel(action: string, lang: Language): string {
  if (!action) return "";
  const key = `audit.action.${action}`;
  const translated = translate(key, lang);
  return translated === key ? action.replace(/_/g, " ") : translated;
}


const ACTION_TONE: Record<string, string> = {
  CONTROL: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  ACK: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  RESOLVE: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  DELETE: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  OTA: "border-purple-500/40 bg-purple-500/10 text-purple-600 dark:text-purple-400",
  REBOOT: "border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
};

export function AuditView() {
  const [q, setQ] = useState("");
  const [action, setAction] = useState("all");
  const t = useT();
  const dir = useDir();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const { data: logs } = useApi<any[]>(`/api/fgmp/audit?limit=500${action !== "all" ? `&action=${action}` : ""}`, { interval: 8000 });

  const filtered = useMemo(() => {
    let list = logs ?? [];
    if (q) list = list.filter((l) => `${l.action} ${l.entity} ${l.entityId ?? ""} ${l.user?.name ?? ""} ${JSON.stringify(l.details)}`.toLowerCase().includes(q.toLowerCase()));
    return list;
  }, [logs, q]);

  const actionCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const l of logs ?? []) m[l.action] = (m[l.action] ?? 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [logs]);

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.audit")}
        description={t("desc.audit")}
        icon={<ScrollText className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
        <KpiCard label={t("audit.totalEvents")} value={formatNumber(logs?.length ?? 0, numLang)} icon={<Activity className="h-4 w-4" />} />
        <KpiCard label={t("audit.controlCommands")} value={formatNumber((logs ?? []).filter((l) => l.action === "CONTROL").length, numLang)} icon={<ShieldCheck className="h-4 w-4" />} tone="info" />
        <KpiCard label={t("audit.alarmActions")} value={formatNumber((logs ?? []).filter((l) => l.action === "ACK" || l.action === "RESOLVE").length, numLang)} icon={<ShieldCheck className="h-4 w-4" />} tone="warn" />
        <KpiCard label={t("audit.deliveries")} value={formatNumber((logs ?? []).filter((l) => l.action.startsWith("DELIVERY")).length, numLang)} icon={<ShieldCheck className="h-4 w-4" />} tone="good" />
        <KpiCard label={t("audit.configChanges")} value={formatNumber((logs ?? []).filter((l) => l.action === "OTA" || l.action === "REBOOT" || l.action === "CONFIG").length, numLang)} icon={<ShieldCheck className="h-4 w-4" />} tone="info" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("audit.topActions")}</CardTitle></CardHeader>
          <CardContent className="p-3">
            <div className="space-y-2">
              {actionCounts.map(([a, n]) => (
                <div key={a} className="flex items-center gap-2">
                  <div className="w-32 truncate text-xs font-medium">{auditActionLabel(a, numLang)}</div>
                  <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                    <div className="h-full bg-emerald-500/70" style={{ width: `${Math.min(100, (n / (logs?.length || 1)) * 200)}%` }} />
                  </div>
                  <div className="w-8 text-right text-xs tabular-nums text-muted-foreground">{formatNumber(n, numLang)}</div>
                </div>
              ))}
              {actionCounts.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">{t("audit.noEvents")}</p>}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-sm">{t("audit.trail")} ({formatNumber(filtered.length, numLang)})</CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("audit.search")} className="h-9 w-[220px] pl-8" />
              </div>
              <Select value={action} onValueChange={setAction}>
                <SelectTrigger className="h-9 w-[160px] text-xs"><SelectValue placeholder={t("audit.action")} /></SelectTrigger>
                <SelectContent><SelectItem value="all">{t("audit.allActions")}</SelectItem>{ACTIONS.map((a) => <SelectItem key={a} value={a}>{auditActionLabel(a, numLang)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[560px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead className="w-[140px]">{t("audit.action")}</TableHead>
                    <TableHead className="w-[120px]">{t("audit.entity")}</TableHead>
                    <TableHead>{t("audit.details")}</TableHead>
                    <TableHead className="hidden md:table-cell w-[150px]">{t("audit.user")}</TableHead>
                    <TableHead className="hidden lg:table-cell w-[130px]">{t("audit.ip")}</TableHead>
                    <TableHead className="w-[130px]">{t("audit.when")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.slice(0, 200).map((l) => (
                    <TableRow key={l.id} className="transition-colors hover:bg-muted/30">
                      <TableCell><Badge variant="outline" className={cn("h-5 text-[9px]", ACTION_TONE[l.action] ?? "border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-400")}>{auditActionLabel(l.action, numLang)}</Badge></TableCell>
                      <TableCell><span className="text-xs font-medium">{l.entity}</span>{l.entityId && <p className="font-mono text-[9px] text-muted-foreground">{formatNumber(l.entityId.slice(-8), numLang)}</p>}</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground"><pre className="max-w-md truncate font-mono">{typeof l.details === "string" ? l.details : JSON.stringify(l.details)}</pre></TableCell>
                      <TableCell className="hidden md:table-cell"><div className="flex items-center gap-1.5 text-[11px]"><User className="h-3 w-3 text-muted-foreground" />{l.user?.name ?? t("cmdHistory.system")}<Badge variant="outline" className="h-4 px-1 text-[8px]">{roleLabel(l.user?.role ?? "", numLang)}</Badge></div></TableCell>
                      <TableCell className="hidden lg:table-cell font-mono text-[10px] text-muted-foreground tabular-nums" dir="ltr">{l.ip ?? "—"}</TableCell>
                      <TableCell className="text-[10px] text-muted-foreground"><p>{timeAgo(l.createdAt, numLang)}</p><p className="text-[9px]">{fmtDateTime(l.createdAt, numLang).slice(5, 16)}</p></TableCell>
                    </TableRow>
                  ))}
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="p-0">
                        <EmptyState
                          icon={FileQuestion}
                          title={t("audit.noMatch")}
                          description={q || action !== "all" ? t("audit.search") : undefined}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
