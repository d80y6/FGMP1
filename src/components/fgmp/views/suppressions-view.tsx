"use client";

/**
 * Alarm Suppressions view (Task 32-B)
 * ────────────────────────────────────────────────────────────────────────────
 * NOC operator / admin panel for managing maintenance windows that mute
 * specific alarm types per site (or tenant-wide). Active suppressions are
 * matched by the alarm engine BEFORE raising an alarm, so a planned
 * maintenance window does not produce a flood of false-positive alarms.
 *
 * Layout:
 *   1. Header (SectionHeader) with "Create Suppression" button.
 *   2. KPI strip: active-now count, tenant-wide count, past total.
 *   3. Active suppressions grid (color-coded by remaining time).
 *   4. Past suppressions accordion (collapsible table, max 50 rows).
 *   5. Create dialog with site/type selectors, reason textarea, time
 *      presets (1h / 2h / 4h / 8h / 24h), react-hook-form + zod resolver.
 *
 * Auto-refreshes every 30s so countdowns stay fresh without manual F5.
 *
 * RBAC: the view itself is reachable by anyone with `view:suppressions`
 * (ADMIN, NOC_OPERATOR, REGIONAL_MANAGER). The create / extend / cancel
 * actions call ROLES.ALARM_OPS-guarded endpoints; DELETE is ADMIN-only.
 */

import { useState, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ShieldOff, Plus, X, Clock, Calendar, AlertTriangle, History,
  ShieldAlert, Hourglass, Ban, Globe,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPost, apiPatch, apiDelete } from "@/lib/fgmp/use-api";
import { SectionHeader } from "@/components/fgmp/section-header";
import { useLiveNow } from "@/lib/fgmp/use-now";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "sonner";
import { ConfirmDestructive, useDestructiveConfirm } from "@/components/fgmp/confirm-destructive";
import { fmtDateTime } from "@/lib/fgmp/format";
import { useT, useDir, useArabicNumerals, formatNumber, toArabicNumerals } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { alarmTypeLabel } from "@/lib/fgmp/labels";

/* ────────────────────────────────────────────────────────────────────────
 * Types & constants
 * ──────────────────────────────────────────────────────────────────────── */

interface SuppressionRow {
  id: string;
  tenantId: string;
  siteId: string | null;
  alarmType: string | null;
  reason: string;
  createdBy: string;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  site?: { id: string; name: string; code: string } | null;
  user?: { id: string; name: string; email: string } | null;
}

/** Alarm types offered in the create dialog. Matches the engine's type
 *  catalog so the chosen value actually matches what raiseAlarm() emits. */
const ALARM_TYPES = [
  "FUEL_LOW",
  "FUEL_CRITICAL",
  "GEN_OFFLINE",
  "GEN_FAILURE",
  "GEN_OVERHEAT",
  "BATT_LOW_VOLTAGE",
  "BATT_FAILURE",
  "COMM_LOSS",
] as const;

const ROLE_OK = new Set(["ADMIN", "NOC_OPERATOR", "REGIONAL_MANAGER"]);

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */


/** Format a millisecond duration as "1h 5m" / "3m 10s" / "expired". */
function fmtDuration(ms: number, lang: Language): string {
  const neg = ms < 0;
  const abs = Math.abs(ms);
  const totalSec = Math.floor(abs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  let s2: string;
  if (h > 0) s2 = `${h}h ${m}m`;
  else if (m > 0) s2 = `${m}m ${s}s`;
  else s2 = `${s}s`;
  return (neg ? "-" : "") + (lang === "ar" ? toArabicNumerals(s2) : s2);
}

/** Color tone for an active suppression card based on remaining time. */
function toneFor(now: number, endsAt: number, startsAt: number): "good" | "warn" | "danger" {
  if (now > endsAt) return "danger"; // expired but still active (needs cleanup)
  if (now < startsAt) return "warn"; // not yet started
  const remaining = endsAt - now;
  if (remaining > 60 * 60 * 1000) return "good"; // >1h remaining
  return "warn"; // <1h remaining
}

/* ────────────────────────────────────────────────────────────────────────
 * Create form schema
 * ──────────────────────────────────────────────────────────────────────── */

const createSchema = z.object({
  siteId: z.string().optional().or(z.literal("")),
  alarmType: z.string().optional().or(z.literal("")),
  reason: z.string().min(3, "reasonTooShort").max(500),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
});
type CreateForm = z.infer<typeof createSchema>;

const ALL_SITES_VALUE = "__all__";
const ALL_TYPES_VALUE = "__all__";

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function SuppressionsView() {
  const { me, snapshot } = useFgmp(useShallow((s) => ({ me: s.me, snapshot: s.snapshot })));
  const t = useT();
  const dir = useDir();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const [createOpen, setCreateOpen] = useState(false);

  // Phase 5 task 4 — confirm dialog state.
  const confirmDelete = useDestructiveConfirm();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // Countdowns tick from the shared 5 s clock instead of a bespoke timer, so
  // every card in the list agrees on "now" and no component owns an interval.
  const now = useLiveNow();

  const { data: suppressions, loading, refetch } = useApi<SuppressionRow[]>(
    "/api/fgmp/suppressions",
    { interval: 30000 },
  );

  const sites = snapshot?.sites ?? [];

  const { active, expired } = useMemo(() => {
    const list = suppressions ?? [];
    const activeList: SuppressionRow[] = [];
    const expiredList: SuppressionRow[] = [];
    for (const s of list) {
      if (!s.isActive) { expiredList.push(s); continue; }
      // Active but window already ended counts as "expired" for the UI:
      // operators should see it in the past list so they can delete it.
      const endsAt = new Date(s.endsAt).getTime();
      if (endsAt < now && now - endsAt > 60_000) {
        expiredList.push(s);
      } else {
        activeList.push(s);
      }
    }
    return { active: activeList, expired: expiredList.slice(0, 50) };
  }, [suppressions, now]);

  const stats = useMemo(() => {
    const activeNow = active.filter((s) => {
      const start = new Date(s.startsAt).getTime();
      const end = new Date(s.endsAt).getTime();
      return now >= start && now <= end;
    }).length;
    return {
      activeNow,
      tenantWide: active.filter((s) => s.siteId === null).length,
      expiredTotal: (suppressions ?? []).length - active.length,
    };
  }, [active, suppressions, now]);

  // RBAC gate — only the three roles listed in the spec may manage
  // suppressions. Other authenticated users (e.g. FIELD_ENGINEER /
  // EXECUTIVE / READONLY) see an access-denied notice. The nav itself
  // is already hidden from them via the capability matrix, but this is
  // a defense-in-depth check in case the view is opened via URL.
  if (me && !ROLE_OK.has(me.role)) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>{t("suppressions.accessDenied")}</AlertTitle>
          <AlertDescription>{t("suppressions.accessDeniedDescription")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const handleExtend = async (id: string) => {
    const row = active.find((s) => s.id === id);
    if (!row) return;
    const newEnd = new Date(new Date(row.endsAt).getTime() + 60 * 60 * 1000).toISOString();
    const res = await apiPatch(`/api/fgmp/suppressions/${id}`, { endsAt: newEnd });
    if (res.ok) {
      toast.success(t("suppressions.extended"));
      refetch();
    } else {
      toast.error(res.error ?? "Error");
    }
  };

  const handleCancel = async (id: string) => {
    const res = await apiPatch(`/api/fgmp/suppressions/${id}`, { isActive: false });
    if (res.ok) {
      toast.success(t("suppressions.cancelled"));
      refetch();
    } else {
      toast.error(res.error ?? "Error");
    }
  };

  // Phase 5 task 4 — gated by ConfirmDestructive instead of window.confirm.
  // Split into perform/ask: a controlled dialog has to be opened by state and
  // the action has to run from its confirm handler, which the old
  // "if (!confirm) return; …" shape could not do.
  const performDelete = async (id: string) => {
    confirmDelete.setBusy(true);
    // `apiDelete`, not a raw `fetch`. This handler was reading `res.error`,
    // which does not exist on a `Response` — the error body is still an
    // unread stream until something parses it. Every other delete in this
    // codebase goes through the helper, which parses the JSON body and returns
    // `{ ok, error, status }`; a raw fetch here would have shown the operator a
    // generic toast while discarding the server's actual reason.
    const res = await apiDelete(`/api/fgmp/suppressions/${id}`);
    confirmDelete.settle();
    setPendingDeleteId(null);
    if (res.ok) {
      toast.success(t("suppressions.deleted"));
      refetch();
    } else {
      toast.error(res.error ?? t("common.error"));
    }
  };

  const askDelete = (id: string) => {
    setPendingDeleteId(id);
    confirmDelete.ask({
      title: t("confirm.deleteTitle"),
      description: t("suppressions.deleteConfirm"),
      cancelLabel: t("confirm.cancel"),
      confirmLabel: t("confirm.deleteTitle"),
    });
  };

  return (
    <>
    <div className="space-y-4">
      <SectionHeader
        title={t("suppressions.title")}
        description={t("suppressions.subtitle")}
        icon={<ShieldOff className="h-5 w-5" />}
        tone="amber"
        actions={
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">{t("suppressions.create")}</span>
          </Button>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard
          label={t("suppressions.totalActive")}
          value={formatNumber(stats.activeNow, numLang)}
          icon={<ShieldOff className="h-4 w-4" />}
          tone={stats.activeNow > 0 ? "warn" : "good"}
        />
        <KpiCard
          label={t("suppressions.totalAllSites")}
          value={formatNumber(stats.tenantWide, numLang)}
          icon={<Globe className="h-4 w-4" />}
          tone="info"
        />
        <KpiCard
          label={t("suppressions.totalExpired")}
          value={formatNumber(stats.expiredTotal, numLang)}
          icon={<History className="h-4 w-4" />}
          tone="default"
        />
      </div>

      {/* Active suppressions grid */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldOff className="h-4 w-4 text-amber-500" />
            {t("suppressions.active")}
            <Badge variant="secondary" className="ml-1 h-5 text-[10px]">
              {formatNumber(active.length, numLang)}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading && !suppressions ? (
            <ActiveSkeleton />
          ) : active.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10">
                <ShieldOff className="h-5 w-5 text-emerald-500" />
              </div>
              <p className="text-sm text-muted-foreground">{t("suppressions.noActive")}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {active.map((s) => (
                <ActiveCard
                  key={s.id}
                  row={s}
                  lang={numLang}
                  onExtend={() => handleExtend(s.id)}
                  onCancel={() => handleCancel(s.id)}
                  onDelete={() => askDelete(s.id)}
                  canDelete={me?.role === "ADMIN"}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Past / expired suppressions accordion */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4 text-muted-foreground" />
            {t("suppressions.pastSuppressions")}
            <Badge variant="outline" className="ml-1 h-5 text-[10px]">
              {formatNumber(expired.length, numLang)}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {expired.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("suppressions.noExpired")}</p>
          ) : (
            <Accordion type="single" collapsible>
              <AccordionItem value="past">
                <AccordionTrigger className="text-xs">
                  {t("suppressions.pastSuppressions")}
                </AccordionTrigger>
                <AccordionContent>
                  <div className="max-h-96 overflow-y-auto">
                    <Table>
                      <TableHeader className="sticky top-0 bg-card">
                        <TableRow>
                          <TableHead className="text-xs">{t("suppressions.site")}</TableHead>
                          <TableHead className="text-xs">{t("suppressions.alarmType")}</TableHead>
                          <TableHead className="hidden md:table-cell text-xs">{t("suppressions.reason")}</TableHead>
                          <TableHead className="hidden sm:table-cell text-xs">{t("suppressions.window")}</TableHead>
                          <TableHead className="hidden lg:table-cell text-xs">{t("suppressions.createdBy")}</TableHead>
                          <TableHead className="w-[60px] text-xs text-right">{t("common.delete")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {expired.map((s) => (
                          <TableRow key={s.id}>
                            <TableCell className="text-xs">
                              <span className="font-medium">{s.site?.name ?? t("suppressions.allSites")}</span>
                              {s.site?.code && (
                                <span className="ml-1 text-[10px] text-muted-foreground">{s.site.code}</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs">
                              {s.alarmType ? alarmTypeLabel(s.alarmType, numLang) : t("suppressions.allTypes")}
                            </TableCell>
                            <TableCell className="hidden md:table-cell text-xs text-muted-foreground max-w-[280px] truncate">
                              {s.reason}
                            </TableCell>
                            <TableCell className="hidden sm:table-cell text-[10px] text-muted-foreground" dir="ltr">
                              {fmtDateTime(s.startsAt, numLang)} → {fmtDateTime(s.endsAt, numLang)}
                            </TableCell>
                            <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                              {s.user?.name ?? "—"}
                            </TableCell>
                            <TableCell className="text-right">
                              {me?.role === "ADMIN" && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-rose-700 dark:hover:text-rose-400"
                                  onClick={() => askDelete(s.id)}
                                  aria-label={t("common.delete")}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}
        </CardContent>
      </Card>

      <CreateSuppressionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => { refetch(); setCreateOpen(false); }}
        sites={sites}
        lang={numLang}
        t={t}
        dir={dir}
      />
    </div>

      {/* Phase 5 task 4 — replaces window.confirm. */}
      <ConfirmDestructive
        {...confirmDelete.dialogProps}
        onCancel={() => {
          setPendingDeleteId(null);
          confirmDelete.settle();
        }}
        onConfirm={() => {
          if (pendingDeleteId) void performDelete(pendingDeleteId);
          setPendingDeleteId(null);
        }}
      />
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Sub-components
 * ──────────────────────────────────────────────────────────────────────── */

function ActiveSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-44" />
      ))}
    </div>
  );
}

interface ActiveCardProps {
  row: SuppressionRow;
  lang: Language;
  onExtend: () => void;
  onCancel: () => void;
  onDelete: () => void;
  canDelete: boolean;
}

function ActiveCard({ row, lang, onExtend, onCancel, onDelete, canDelete }: ActiveCardProps) {
  const t = useT();
  const now = useLiveNow();
  const start = new Date(row.startsAt).getTime();
  const end = new Date(row.endsAt).getTime();
  const tone = toneFor(now, end, start);
  const remaining = end - now;
  const startsIn = start - now;

  const TONE: Record<string, { border: string; bg: string; chip: string; ring: string; label: string }> = {
    good: {
      border: "border-emerald-500/30",
      bg: "bg-emerald-500/5",
      chip: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      ring: "ring-emerald-500/30",
      label: t("suppressions.active"),
    },
    warn: {
      border: "border-amber-500/30",
      bg: "bg-amber-500/5",
      chip: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      ring: "ring-amber-500/30",
      label: t("suppressions.active"),
    },
    danger: {
      border: "border-rose-500/30",
      bg: "bg-rose-500/5",
      chip: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400",
      ring: "ring-rose-500/30",
      label: t("suppressions.expired"),
    },
  };
  const toneCls = TONE[tone];

  return (
    <div className={`rounded-lg border ${toneCls.border} ${toneCls.bg} p-3 ring-1 ${toneCls.ring} transition-shadow hover:shadow-md`}>
      {/* Header row: site name + tone chip */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {row.siteId === null ? (
              <Globe className="h-3.5 w-3.5 text-sky-500 shrink-0" />
            ) : (
              <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="truncate text-sm font-semibold">
              {row.site?.name ?? t("suppressions.allSites")}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <AlertTriangle className="h-3 w-3" />
            <span className="truncate">
              {row.alarmType ? alarmTypeLabel(row.alarmType, lang) : t("suppressions.allTypes")}
            </span>
          </div>
        </div>
        <Badge variant="outline" className={`shrink-0 text-[10px] ${toneCls.chip}`}>
          {toneCls.label}
        </Badge>
      </div>

      {/* Reason */}
      <p className="mt-2 line-clamp-2 text-xs text-foreground/80" title={row.reason}>
        {row.reason}
      </p>

      {/* Time window */}
      <div className="mt-2.5 rounded-md border border-border/60 bg-background/60 p-2 text-[10px]" dir="ltr">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span>{fmtDateTime(row.startsAt, lang)} → {fmtDateTime(row.endsAt, lang)}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          {now < start ? (
            <Hourglass className="h-3 w-3 text-amber-500" />
          ) : now > end ? (
            <Ban className="h-3 w-3 text-rose-500" />
          ) : (
            <Hourglass className="h-3 w-3 text-emerald-500" />
          )}
          <span className="font-medium tabular-nums" dir={lang === "ar" ? "rtl" : "ltr"}>
            {now < start
              ? `${t("suppressions.startsIn")} ${fmtDuration(startsIn, lang)}`
              : now > end
                ? `${t("suppressions.expiredAgo")} ${fmtDuration(-remaining, lang)}`
                : `${t("suppressions.remaining")} ${fmtDuration(remaining, lang)}`}
          </span>
        </div>
      </div>

      {/* Created by */}
      <p className="mt-2 text-[10px] text-muted-foreground">
        {t("suppressions.createdBy")}: <span className="font-medium text-foreground/80">{row.user?.name ?? "—"}</span>
      </p>

      {/* Actions */}
      <div className="mt-2.5 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          onClick={onExtend}
          disabled={now > end}
        >
          <Clock className="mr-1 h-3 w-3" />
          {t("suppressions.extend")} +1h
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px] text-rose-700 dark:text-rose-400 hover:bg-rose-500/10"
          onClick={onCancel}
        >
          <X className="mr-1 h-3 w-3" />
          {t("suppressions.cancel")}
        </Button>
        {canDelete && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 w-7 p-0 text-muted-foreground hover:text-rose-700 dark:hover:text-rose-400"
            onClick={onDelete}
            aria-label={t("common.delete")}
          >
            <Ban className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Create dialog
 * ──────────────────────────────────────────────────────────────────────── */

interface CreateDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
  sites: { id: string; name: string; code: string }[];
  lang: Language;
  t: (k: string) => string;
  dir: "rtl" | "ltr";
}

function CreateSuppressionDialog({ open, onOpenChange, onCreated, sites, lang, t, dir }: CreateDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  // Default start = now, default end = now + 2h, both in the local
  // <input type="datetime-local"> format (YYYY-MM-DDTHH:MM).
  const nowLocal = () => toLocalInput(new Date());
  const plusHours = (h: number) => toLocalInput(new Date(Date.now() + h * 60 * 60 * 1000));

  const form = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      siteId: ALL_SITES_VALUE,
      alarmType: ALL_TYPES_VALUE,
      reason: "",
      startsAt: nowLocal(),
      endsAt: plusHours(2),
    },
  });

  // Reset form defaults whenever the dialog is (re)opened so the
  // time presets always reflect "now".
  useEffect(() => {
    if (open) {
      form.reset({
        siteId: ALL_SITES_VALUE,
        alarmType: ALL_TYPES_VALUE,
        reason: "",
        startsAt: nowLocal(),
        endsAt: plusHours(2),
      });
    }
  }, [open, form]);

  const applyPreset = (h: number) => {
    form.setValue("startsAt", nowLocal());
    form.setValue("endsAt", plusHours(h));
  };

  const onSubmit = async (values: CreateForm) => {
    setSubmitting(true);
    try {
      const siteId = !values.siteId || values.siteId === ALL_SITES_VALUE ? null : values.siteId;
      const alarmType = !values.alarmType || values.alarmType === ALL_TYPES_VALUE ? null : values.alarmType;
      // Convert local datetime-local string to ISO (interpreted as Asia/Aden
      // for display purposes, but stored as UTC instants in the DB).
      const startsAt = new Date(values.startsAt).toISOString();
      const endsAt = new Date(values.endsAt).toISOString();
      const res = await apiPost("/api/fgmp/suppressions", {
        siteId,
        alarmType,
        reason: values.reason,
        startsAt,
        endsAt,
      });
      if (res.ok) {
        toast.success(t("suppressions.created"));
        form.reset();
        onCreated();
      } else {
        const err = (res.data as { error?: string } | undefined)?.error;
        toast.error(err ?? res.error ?? "Error");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) form.reset(); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("suppressions.createTitle")}</DialogTitle>
          <DialogDescription>{t("suppressions.subtitle")}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            {/* Site selector */}
            <FormField
              control={form.control}
              name="siteId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">{t("suppressions.site")}</FormLabel>
                  <FormControl>
                    <Select label={t("suppressions.site")} value={field.value ?? ALL_SITES_VALUE} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL_SITES_VALUE}>
                          <span className="flex items-center gap-1.5">
                            <Globe className="h-3 w-3" /> {t("suppressions.allSites")}
                          </span>
                        </SelectItem>
                        {sites.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name} <span className="text-[10px] text-muted-foreground">({s.code})</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />

            {/* Alarm type selector */}
            <FormField
              control={form.control}
              name="alarmType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">{t("suppressions.alarmType")}</FormLabel>
                  <FormControl>
                    <Select label={t("suppressions.alarmType")} value={field.value ?? ALL_TYPES_VALUE} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL_TYPES_VALUE}>{t("suppressions.allTypes")}</SelectItem>
                        {ALARM_TYPES.map((at) => (
                          <SelectItem key={at} value={at}>{alarmTypeLabel(at, lang)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />

            {/* Reason */}
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">{t("suppressions.reason")}</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={3}
                      placeholder={t("suppressions.enterReason")}
                      className="text-sm"
                    />
                  </FormControl>
                  <FormMessage className="text-xs">
                    {field.value && field.value.length < 3 ? t("suppressions.reasonTooShort") : undefined}
                  </FormMessage>
                </FormItem>
              )}
            />

            {/* Quick presets */}
            <div>
              <Label className="text-xs text-muted-foreground">{t("suppressions.presets")}</Label>
              <div className="mt-1 flex flex-wrap gap-1.5" dir={dir}>
                {([
                  [1, "suppressions.oneHour"],
                  [2, "suppressions.twoHours"],
                  [4, "suppressions.fourHours"],
                  [8, "suppressions.eightHours"],
                  [24, "suppressions.twentyFourHours"],
                ] as const).map(([h, key]) => (
                  <Button
                    key={h}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => applyPreset(h)}
                  >
                    {t(key)}
                  </Button>
                ))}
              </div>
            </div>

            {/* Start + End datetime-local */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="startsAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t("suppressions.startTime")}</FormLabel>
                    <FormControl>
                      <Input type="datetime-local" {...field} className="h-9" dir="ltr" />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endsAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t("suppressions.endTime")}</FormLabel>
                    <FormControl>
                      <Input type="datetime-local" {...field} className="h-9" dir="ltr" />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "…" : t("suppressions.create")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** Format a Date as a value for <input type="datetime-local">: YYYY-MM-DDTHH:MM */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
