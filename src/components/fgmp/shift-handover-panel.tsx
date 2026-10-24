"use client";

import { useMemo, useState } from "react";
import {
  ClipboardList,
  Plus,
  Check,
  Trash2,
  AlertCircle,
  Sun,
  Moon,
  Sunset,
  Siren,
  AlertTriangle,
  Droplet,
  Building2,
  Clock,
  ChevronDown,
  ChevronUp,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDestructive, useDestructiveConfirm } from "@/components/fgmp/confirm-destructive";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi, apiPost, apiPatch, apiDelete } from "@/lib/fgmp/use-api";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/fgmp/format";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";

/**
 * ShiftHandoverPanel — NOC operator shift handover log.
 *
 * Renders on the NOC Dashboard. Shows:
 *  - The current shift (derived from local hour) + count of OPEN notes
 *    awaiting acknowledgement.
 *  - A "New handover note" composer (shift, priority, notes, ongoing issues,
 *    flagged sites) — opens in a Dialog.
 *  - A scrollable list of recent handover notes with acknowledge / delete
 *    actions and an optional reply.
 *
 * Tenant isolation is enforced server-side; this component just renders what
 * the API returns. Polls every 30s for new notes (handovers are low-volume
 * but operators want to see a new OPEN note appear without manual refresh).
 */

export interface ShiftHandoverNote {
  id: string;
  tenantId: string;
  authorId: string;
  authorName: string;
  authorRole: string;
  shift: "MORNING" | "EVENING" | "NIGHT";
  status: "OPEN" | "ACKNOWLEDGED";
  priority: "P1" | "P2" | "P3";
  notes: string;
  ongoingIssues: string | null;
  flaggedSiteIds: string | null;
  openAlarmsCount: number;
  criticalSitesCount: number;
  avgFuelPct: number;
  acknowledgedById: string | null;
  acknowledgedAt: string | null;
  acknowledgedNote: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ShiftHandoverResponse {
  notes: ShiftHandoverNote[];
  openCount: number;
}

/** Derive the current shift from the local hour. 6–14 Morning, 14–22 Evening, else Night. */
function currentShift(): "MORNING" | "EVENING" | "NIGHT" {
  const h = new Date().getHours();
  if (h >= 6 && h < 14) return "MORNING";
  if (h >= 14 && h < 22) return "EVENING";
  return "NIGHT";
}

const SHIFT_ICON = {
  MORNING: Sun,
  EVENING: Sunset,
  NIGHT: Moon,
} as const;

const PRIORITY_TONE: Record<string, string> = {
  P1: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  P2: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  P3: "border-slate-500/30 bg-slate-500/5 text-slate-600 dark:text-slate-400",
};

const SHIFT_TONE: Record<string, string> = {
  MORNING: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  EVENING: "border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  NIGHT: "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
};

export function ShiftHandoverPanel() {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const me = useFgmp((s) => s.me);
  const { data, refetch } = useApi<ShiftHandoverResponse>("/api/fgmp/shift-handover?limit=20", {
    interval: 30000,
  });

  const [composerOpen, setComposerOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [ackReply, setAckReply] = useState<Record<string, string>>({});

  const notes = data?.notes ?? [];
  const openCount = data?.openCount ?? 0;
  const curShift = currentShift();
  const CurShiftIcon = SHIFT_ICON[curShift];

  const canCreate = useMemo(() => {
    if (!me) return false;
    // ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER can create.
    return ["ADMIN", "NOC_OPERATOR", "REGIONAL_MANAGER", "FIELD_ENGINEER"].includes(me.role);
  }, [me]);

  const canDelete = me?.role === "ADMIN";

  const shiftLabel = (s: string) =>
    s === "MORNING" ? t("handover.shiftMorning") : s === "EVENING" ? t("handover.shiftEvening") : t("handover.shiftNight");

  async function handleAcknowledge(id: string) {
    const reply = ackReply[id]?.trim() || undefined;
    const res = await apiPatch(`/api/fgmp/shift-handover/${id}`, {
      action: "acknowledge",
      acknowledgedNote: reply,
    });
    if (res.ok) {
      toast.success(t("handover.acknowledgedToast"));
      setAckReply((m) => { const n = { ...m }; delete n[id]; return n; });
      setExpandedId(null);
      refetch();
    } else {
      toast.error(t("handover.ackFailed"), { description: res.error });
    }
  }

  // The last `window.confirm` in the application. It blocked the event loop,
  // could not be styled or translated (the string it showed was only correct in
  // the language the page loaded in), and gave the operator no consequence
  // beyond "are you sure". Split into ask/perform so the shared dialog can own
  // the confirmation — the shape every other destructive action already uses.
  const confirmDelete = useDestructiveConfirm();
  // Which note is being confirmed. Kept beside the dialog rather than inside it
  // because the confirm handler needs the id after the dialog has closed.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  async function performDelete(id: string) {
    confirmDelete.setBusy(true);
    // DELETE /api/fgmp/shift-handover/[id] is ADMIN-only (settings:manage).
    // apiDelete refuses it locally for every other role, so the request is never
    // issued even if this handler is reached by a stale render or a confirmation
    // dialog that was opened before a role change.
    const res = await apiDelete(`/api/fgmp/shift-handover/${id}`);
    confirmDelete.settle();
    if (res.ok) {
      toast.success(t("handover.deletedToast"));
      refetch();
    } else {
      toast.error(t("handover.deleteFailed"), { description: res.error });
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4 text-sky-500" />
            {t("handover.title")}
          </CardTitle>
          {/* Current shift badge */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold", SHIFT_TONE[curShift])}>
                <CurShiftIcon className="h-3 w-3" />
                {t("handover.currentShift")}: {shiftLabel(curShift)}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t("handover.subtitle")}</TooltipContent>
          </Tooltip>
          {openCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold text-rose-600 dark:text-rose-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500" />
                  {formatNumber(openCount, numLang)} {t("handover.openAwaiting")}
                </span>
              </TooltipTrigger>
              <TooltipContent>{t("handover.openAwaiting")}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canCreate && (
            <Button size="sm" className="h-7 text-xs" onClick={() => setComposerOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("handover.new")}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {notes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <ClipboardList className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-sm font-medium text-muted-foreground">{t("handover.empty")}</p>
            <p className="max-w-xs text-xs text-muted-foreground/80">{t("handover.emptyDesc")}</p>
          </div>
        ) : (
          <ScrollArea className="max-h-[420px]">
            <div className="space-y-2 px-3 pb-3">
              {notes.map((n) => {
                const isExpanded = expandedId === n.id;
                const isOwn = me?.id === n.authorId;
                const ShiftIcon = SHIFT_ICON[n.shift];
                const flagged = n.flaggedSiteIds ? n.flaggedSiteIds.split(",").filter(Boolean) : [];
                return (
                  <div
                    key={n.id}
                    className={cn(
                      "group relative rounded-lg border bg-background/40 transition-all duration-200",
                      "animate-slide-in-up motion-reduce:animate-none",
                      n.status === "OPEN" ? "border-l-2 border-l-sky-500" : "border-l-2 border-l-transparent opacity-80",
                      n.priority === "P1" && n.status === "OPEN" && "ring-1 ring-rose-500/20",
                    )}
                  >
                    {/* Top row: shift + priority + status + time */}
                    <div className="flex items-center gap-1.5 px-3 pt-2.5">
                      <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide", SHIFT_TONE[n.shift])}>
                        <ShiftIcon className="h-3 w-3" />
                        {shiftLabel(n.shift)}
                      </span>
                      <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-bold", PRIORITY_TONE[n.priority])}>
                        {n.priority}
                      </span>
                      <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold",
                        n.status === "OPEN"
                          ? "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400"
                          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400")}>
                        {n.status === "OPEN" ? t("handover.open") : t("handover.acknowledged")}
                      </span>
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {timeAgo(n.createdAt, numLang)}
                      </span>
                    </div>

                    {/* Author row */}
                    <div className="flex items-center gap-1.5 px-3 pt-1.5 text-[11px]">
                      <span className="font-medium text-foreground">{n.authorName}</span>
                      <span className="rounded bg-muted/60 px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">{n.authorRole}</span>
                    </div>

                    {/* Notes body — truncated unless expanded */}
                    <div className="px-3 py-2">
                      <p className={cn("whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90", !isExpanded && "line-clamp-3")}>
                        {n.notes}
                      </p>
                      {n.ongoingIssues && (isExpanded || n.priority === "P1") && (
                        <div className="mt-2 rounded border border-amber-500/20 bg-amber-500/5 p-2">
                          <p className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                            <AlertCircle className="h-3 w-3" />
                            {t("handover.ongoingIssues")}
                          </p>
                          <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/80">{n.ongoingIssues}</p>
                        </div>
                      )}
                    </div>

                    {/* Network snapshot at handover — compact KPI strip */}
                    <div className="mx-3 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/20 px-2 py-1.5 text-[10px]">
                      <span className="font-semibold uppercase tracking-wide text-muted-foreground/80">{t("handover.snapshotAtHandover")}:</span>
                      <span className="inline-flex items-center gap-1" title={t("handover.openAlarms")}>
                        <Siren className="h-3 w-3 text-rose-500" />
                        <span className="tabular-nums">{formatNumber(n.openAlarmsCount, numLang)}</span>
                        <span className="text-muted-foreground">{t("handover.openAlarms")}</span>
                      </span>
                      <span className="inline-flex items-center gap-1" title={t("handover.criticalSites")}>
                        <AlertTriangle className="h-3 w-3 text-amber-500" />
                        <span className="tabular-nums">{formatNumber(n.criticalSitesCount, numLang)}</span>
                        <span className="text-muted-foreground">{t("handover.criticalSites")}</span>
                      </span>
                      <span className="inline-flex items-center gap-1" title={t("handover.avgFuel")}>
                        <Droplet className="h-3 w-3 text-sky-500" />
                        <span className="tabular-nums">{formatNumber(n.avgFuelPct, numLang)}%</span>
                        <span className="text-muted-foreground">{t("handover.avgFuel")}</span>
                      </span>
                      {flagged.length > 0 && (
                        <span className="inline-flex items-center gap-1" title={t("handover.flaggedSite")}>
                          <Building2 className="h-3 w-3 text-violet-500" />
                          <span className="tabular-nums">{formatNumber(flagged.length, numLang)}</span>
                          <span className="text-muted-foreground">{t("handover.flaggedSite")}</span>
                        </span>
                      )}
                    </div>

                    {/* Acknowledgement reply (if acknowledged) */}
                    {n.status === "ACKNOWLEDGED" && n.acknowledgedNote && n.acknowledgedAt && (
                      <div className="mx-3 mb-2 rounded border border-emerald-500/20 bg-emerald-500/5 p-2">
                        <p className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                          <Check className="h-3 w-3" />
                          {t("handover.acknowledgedBy")} · {timeAgo(n.acknowledgedAt, numLang)}
                        </p>
                        <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/80">{n.acknowledgedNote}</p>
                      </div>
                    )}

                    {/* Action row */}
                    <div className="flex items-center gap-1 border-t px-3 py-1.5">
                      {n.status === "OPEN" && !isOwn && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => setExpandedId(isExpanded ? null : n.id)}
                        >
                          {isExpanded ? <ChevronUp className="mr-1 h-3 w-3" /> : <ChevronDown className="mr-1 h-3 w-3" />}
                          {isExpanded ? t("handover.collapse") : t("handover.acknowledge")}
                        </Button>
                      )}
                      {n.status === "OPEN" && isOwn && (
                        <span className="text-[10px] italic text-muted-foreground">{t("handover.youCantAckOwn")}</span>
                      )}
                      {n.status === "ACKNOWLEDGED" && n.acknowledgedAt && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                          <Check className="h-3 w-3" />
                          {t("handover.acknowledgedBy")} {timeAgo(n.acknowledgedAt, numLang)}
                        </span>
                      )}
                      <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {new Date(n.createdAt).toLocaleString(numLang === "ar" ? "ar" : "en-US", {
                          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                        })}
                      </span>
                      {canDelete && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600"
                              onClick={() => {
                                setPendingDeleteId(n.id);
                                confirmDelete.ask({
                                  title: t("handover.delete"),
                                  description: t("handover.confirmDelete"),
                                  cancelLabel: t("common.cancel"),
                                  confirmLabel: t("common.delete"),
                                });
                              }}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{t("handover.delete")}</TooltipContent>
                        </Tooltip>
                      )}
                    </div>

                    {/* Acknowledge form (expanded) */}
                    {isExpanded && n.status === "OPEN" && !isOwn && (
                      <div className="space-y-2 border-t bg-muted/20 px-3 py-2.5">
                        <Label className="text-[11px] font-medium text-foreground">{t("handover.acknowledgedNoteLabel")}</Label>
                        <Textarea
                          value={ackReply[n.id] ?? ""}
                          onChange={(e) => setAckReply((m) => ({ ...m, [n.id]: e.target.value }))}
                          rows={2}
                          maxLength={1000}
                          placeholder={t("handover.acknowledgedNotePlaceholder")}
                          className="min-h-[56px] resize-y text-xs leading-relaxed"
                        />
                        <div className="flex items-center justify-end gap-2">
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setExpandedId(null); setAckReply((m) => { const n2 = { ...m }; delete n2[n.id]; return n2; }); }}>
                            {t("handover.cancel")}
                          </Button>
                          <Button size="sm" className="h-7 text-xs" onClick={() => handleAcknowledge(n.id)}>
                            <Check className="mr-1 h-3.5 w-3.5" />
                            {t("handover.acknowledge")}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>

      <ConfirmDestructive
        {...confirmDelete.dialogProps}
        onCancel={() => {
          setPendingDeleteId(null);
          confirmDelete.settle();
        }}
        onConfirm={() => {
          const id = pendingDeleteId;
          setPendingDeleteId(null);
          if (id) void performDelete(id);
        }}
      />

      {composerOpen && (
        <HandoverComposer
          key="handover-composer"
          open={composerOpen}
          onOpenChange={setComposerOpen}
          defaultShift={curShift}
          onCreated={() => { setComposerOpen(false); refetch(); }}
        />
      )}
    </Card>
  );
}

// ── Composer dialog ────────────────────────────────────────────────────────
function HandoverComposer({
  open,
  onOpenChange,
  defaultShift,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultShift: "MORNING" | "EVENING" | "NIGHT";
  onCreated: () => void;
}) {
  const t = useT();
  const [shift, setShift] = useState<"MORNING" | "EVENING" | "NIGHT">(defaultShift);
  const [priority, setPriority] = useState<"P1" | "P2" | "P3">("P3");
  const [notes, setNotes] = useState("");
  const [ongoingIssues, setOngoingIssues] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // The composer is conditionally mounted with a stable key, so it always
  // starts fresh from `defaultShift` when opened — no sync effect needed.

  const notesEmpty = notes.trim().length < 3;

  async function handleSubmit() {
    if (notesEmpty || submitting) return;
    setSubmitting(true);
    const res = await apiPost("/api/fgmp/shift-handover", {
      shift,
      priority,
      notes: notes.trim(),
      ongoingIssues: ongoingIssues.trim() || undefined,
    });
    setSubmitting(false);
    if (res.ok) {
      toast.success(t("handover.createdToast"));
      setNotes("");
      setOngoingIssues("");
      setPriority("P3");
      onCreated();
    } else {
      toast.error(t("handover.createFailed"), { description: res.error });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-sky-500" />
            {t("handover.new")}
          </DialogTitle>
          <DialogDescription>{t("handover.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Shift + Priority row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("handover.shift")}</Label>
              <Select value={shift} onValueChange={(v) => setShift(v as "MORNING" | "EVENING" | "NIGHT")}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MORNING">{t("handover.shiftMorning")}</SelectItem>
                  <SelectItem value="EVENING">{t("handover.shiftEvening")}</SelectItem>
                  <SelectItem value="NIGHT">{t("handover.shiftNight")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("handover.priority")}</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as "P1" | "P2" | "P3")}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="P1">P1</SelectItem>
                  <SelectItem value="P2">P2</SelectItem>
                  <SelectItem value="P3">P3</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Notes (required) */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t("handover.notes")} <span className="text-rose-500">*</span></Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={5}
              maxLength={4000}
              placeholder={t("handover.notesPlaceholder")}
              className="min-h-[120px] resize-y text-sm leading-relaxed"
            />
            <p className="text-right font-mono text-[10px] tabular-nums text-muted-foreground">{notes.length}/4000</p>
          </div>

          {/* Ongoing issues (optional) */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t("handover.ongoingIssues")}</Label>
            <Textarea
              value={ongoingIssues}
              onChange={(e) => setOngoingIssues(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder={t("handover.ongoingIssuesPlaceholder")}
              className="min-h-[72px] resize-y text-sm leading-relaxed"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <X className="mr-1 h-4 w-4" />
            {t("handover.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={notesEmpty || submitting}>
            <Plus className="mr-1 h-4 w-4" />
            {t("handover.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
