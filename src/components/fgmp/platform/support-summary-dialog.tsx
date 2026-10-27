"use client";

/**
 * The support-session summary — the surface behind
 * `GET|POST /api/fgmp/platform/support/[tenant]/summary`.
 *
 * ── WHY THE DIALOG ASKS THE SERVER WHETHER A SESSION IS OPEN ───────────────
 * It would be simple to pass "a session exists" in from the row that launched
 * this dialog, and it would be wrong: the session can expire, or be ended in
 * another tab, between the click and the request. So the dialog reads
 * `/platform/support-sessions/current` first and shows what the SERVER says.
 * Three states follow from that, and each is rendered distinctly:
 *
 *   1. no session              → the tenant's name, and a button to open one
 *   2. session for another tenant → the service refuses; say so, offer "end it"
 *   3. session for this tenant → the summary, and (if WRITE) a note composer
 *
 * ── WHY THE NOTE IS THE ONLY WRITE ─────────────────────────────────────────
 * The POST appends to the TENANT's own audit log. It changes no business state
 * and it lands where the customer can read it, which is the whole point of a
 * support visit: the customer finds out it happened, from the record, without
 * anybody remembering to tell them. Anything that changes business state is a
 * different decision and is not offered here.
 *
 * ── WHY THE SUMMARY IS COUNTS AND ALARMS, NOT DATA ─────────────────────────
 * That is what the route returns, deliberately. Row-level access to a tenant's
 * entities belongs on the tenant's own routes; this screen is orientation
 * ("is the tenant healthy, what is alarming") and stops there.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, ClipboardList, ShieldAlert, Stethoscope } from "lucide-react";
import { apiPost, useApi } from "@/lib/fgmp/use-api";
import { hasCapability } from "@/lib/fgmp/rbac-core";
import { useFgmp } from "@/lib/fgmp/store";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { EmptyState } from "@/components/fgmp/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { fmtDateTime } from "@/lib/fgmp/format";
import { useT, useTF, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { toast } from "sonner";

interface ActiveSupport {
  id: string;
  tenantId: string;
  mode: "READ" | "WRITE";
  reason: string;
  ticketRef: string | null;
  expiresAt: string;
}

interface SummaryPayload {
  supportSession: { id: string; mode: string; reason: string; ticketRef: string | null; expiresAt: string };
  tenant: { id: string; name: string; code: string; country: string };
  counts: {
    users: number;
    sites: number;
    tanks: number;
    generators: number;
    openAlarms: number;
    openTickets: number;
    deliveries: number;
  };
  recentAlarms: {
    id: string;
    type: string;
    severity: string;
    status: string;
    message: string;
    createdAt: string;
    site: { name: string } | null;
  }[];
}

/** Mirrors SUPPORT_REASON_MIN in lib/fgmp/support-session.ts for the note body. */
const NOTE_MIN = 3;

export function SupportSummaryDialog({
  target,
  onOpenChange,
  onRequestSession,
}: {
  target: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  /** Opens the session dialog for the same tenant. Owned by the parent view. */
  onRequestSession: (tenant: { id: string; name: string }) => void;
}) {
  const me = useFgmp((s) => s.me);
  const t = useT();
  const tFmt = useTF();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";

  /**
   * `requireSuperAdmin` guards every route this dialog calls, and the capability
   * that means "platform tier" here is `view:tenants` — the same one the API
   * policy row names. Derived from the matrix, never from a role literal.
   */
  const canUseSupport = me ? hasCapability(me.role, "view:tenants") : false;

  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // The composer is reset by REMOUNTING, not by an effect: the parent renders
  // this dialog with `key={target?.id}`, so opening it for another tenant
  // destroys this state. A note written for tenant A therefore cannot be
  // submitted against tenant B, and there is no effect ordering to get wrong.
  const targetId = target?.id ?? null;

  const { data: current } = useApi<{ active: ActiveSupport | null }>(
    canUseSupport && target ? "/api/fgmp/platform/support-sessions/current" : null,
    { deps: [targetId] },
  );
  const active = current?.active ?? null;
  const matches = !!active && !!target && active.tenantId === target.id;

  const { data: summary, loading, error, refetch } = useApi<SummaryPayload>(
    canUseSupport && target && matches
      ? `/api/fgmp/platform/support/${encodeURIComponent(target.id)}/summary`
      : null,
    { deps: [targetId, active?.id] },
  );

  const counts = useMemo(() => summary?.counts ?? null, [summary]);
  const tooShort = note.trim().length < NOTE_MIN;

  const saveNote = async () => {
    if (!target || !matches || tooShort) return;
    setSaving(true);
    try {
      const res = await apiPost(
        `/api/fgmp/platform/support/${encodeURIComponent(target.id)}/summary`,
        { note: note.trim() },
      );
      if (res.ok) {
        toast.success(t("support.summary.noteSaved"));
        setNote("");
        refetch();
      } else {
        toast.error(res.error ?? t("common.error"));
      }
    } finally {
      setSaving(false);
    }
  };

  if (!canUseSupport) return null;

  const writable = active?.mode === "WRITE";

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-sky-600 dark:text-sky-400" />
            {tFmt("support.summary.title", { name: target?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>{t("support.summary.desc")}</DialogDescription>
        </DialogHeader>

        {!matches ? (
          <div className="space-y-3">
            <Alert>
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>{t("support.summary.noSession")}</AlertTitle>
              <AlertDescription>{active ? t("support.summary.wrongTenant") : ""}</AlertDescription>
            </Alert>
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => {
                  if (target) onRequestSession(target);
                  onOpenChange(false);
                }}
              >
                <ShieldAlert className="me-1.5 h-4 w-4" />
                {t("support.summary.openSession")}
              </Button>
            </div>
          </div>
        ) : loading && !summary ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : error || !summary || !counts ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("common.error")}</AlertTitle>
            <AlertDescription>{error ?? ""}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Badge variant="outline" className="font-mono text-[10px]" dir="ltr">
                {summary.tenant.code}
              </Badge>
              <Badge
                className={
                  writable
                    ? "bg-rose-600 text-white text-[10px]"
                    : "bg-amber-600 text-white text-[10px]"
                }
              >
                {t("support.summary.mode")}: {active?.mode}
              </Badge>
              <span className="truncate" title={active?.reason ?? ""}>
                {active?.reason}
              </span>
              <span className="ms-auto">
                {tFmt("support.summary.expiresAt", {
                  when: fmtDateTime(summary.supportSession.expiresAt, numLang),
                })}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <KpiCard label={t("support.summary.users")} value={formatNumber(counts.users, numLang)} />
              <KpiCard label={t("support.summary.sites")} value={formatNumber(counts.sites, numLang)} />
              <KpiCard label={t("support.summary.tanks")} value={formatNumber(counts.tanks, numLang)} />
              <KpiCard label={t("support.summary.generators")} value={formatNumber(counts.generators, numLang)} />
              <KpiCard
                label={t("support.summary.openAlarms")}
                value={formatNumber(counts.openAlarms, numLang)}
                tone={counts.openAlarms > 0 ? "danger" : "good"}
              />
              <KpiCard label={t("support.summary.openTickets")} value={formatNumber(counts.openTickets, numLang)} tone="warn" />
              <KpiCard label={t("support.summary.deliveries")} value={formatNumber(counts.deliveries, numLang)} />
            </div>

            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("support.summary.recentAlarms")}
              </p>
              {summary.recentAlarms.length === 0 ? (
                <EmptyState icon={AlertTriangle} title={t("support.summary.noAlarms")} compact />
              ) : (
                <ul className="max-h-[180px] space-y-1 overflow-auto rounded-md border p-2">
                  {summary.recentAlarms.map((a) => (
                    <li key={a.id} className="flex items-start gap-2 text-[11px]">
                      <Badge
                        variant="outline"
                        className={
                          a.severity === "CRITICAL"
                            ? "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400 text-[10px]"
                            : "text-[10px]"
                        }
                      >
                        {a.severity}
                      </Badge>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{a.site?.name ?? "—"}</span>
                        <span className="ms-1.5 text-muted-foreground">{a.message}</span>
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground" dir="ltr">
                        {fmtDateTime(a.createdAt, numLang)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-1.5 rounded-md border p-2.5">
              <Label htmlFor="support-note" className="flex items-center gap-1.5 text-xs">
                <ClipboardList className="h-3.5 w-3.5" />
                {t("support.summary.note")}
              </Label>
              <p className="text-[10px] text-muted-foreground">{t("support.summary.noteHint")}</p>
              <Textarea
                id="support-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("support.summary.notePlaceholder")}
                rows={2}
                maxLength={1000}
                disabled={!writable || saving}
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">
                  {!writable
                    ? t("support.summary.readOnly")
                    : tooShort
                      ? t("support.summary.tooShort")
                      : `${note.trim().length}/1000`}
                </span>
                <Button size="sm" className="h-7 text-[11px]" onClick={saveNote} disabled={!writable || tooShort || saving}>
                  {t("support.summary.noteSave")}
                </Button>
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
