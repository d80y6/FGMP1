"use client";

/**
 * The platform trail — the surface behind `GET /api/fgmp/platform/audit`.
 *
 * ── WHY IT IS NOT THE AUDIT VIEW ───────────────────────────────────────────
 * `audit-view.tsx` reads `/api/fgmp/audit`, which is the TENANT's trail: rows
 * that live inside one tenant's RLS boundary and that the customer is meant to
 * read. This screen reads `PlatformAuditLog`, which is a different table with a
 * different audience — cross-tenant rows that survive the customer's deletion.
 * Merging the two would either leak platform records to a tenant or bury a
 * tenant's own trail under support noise, so they stay separate and the labels
 * say which is which.
 *
 * ── WHAT IT IS FOR ─────────────────────────────────────────────────────────
 * "Which operator looked at which customer, when, and why." That question is
 * the audit of the support-session path itself, which is the one place a
 * platform role can read another tenant's data. A control nobody reviews is a
 * control that exists on paper, so the review has a screen.
 *
 * ── PAGING ─────────────────────────────────────────────────────────────────
 * The route caps `limit` at 500 and returns `X-Total-Count`. This panel pages by
 * offset rather than pulling everything: a trail is append-only and grows
 * forever, so "load all" is a promise the screen cannot keep. It shows the
 * window it has ("showing 1–200"), and the Older/Newer buttons move it. It does
 * NOT show a total, because `useApi` does not surface response headers and
 * inventing a total from a page length would be a lie exactly when the answer
 * matters.
 */

import { useMemo, useState } from "react";
import { ScrollText, ShieldAlert, ShieldCheck, Users, Search } from "lucide-react";
import { useApi } from "@/lib/fgmp/use-api";
import { hasCapability } from "@/lib/fgmp/rbac-core";
import { useFgmp } from "@/lib/fgmp/store";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { ResourceError } from "@/components/fgmp/resource-error";
import { EmptyState } from "@/components/fgmp/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fmtDateTime } from "@/lib/fgmp/format";
import { translate } from "@/lib/fgmp/i18n";
import { useT, useTF, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";

/**
 * Every action the platform sink is written with today. Derived from
 * `support-session.ts`, not guessed: `SUPPORT_SESSION_START` and
 * `SUPPORT_SESSION_END` are the only two `platformAudit.record(...)` calls in
 * the tree. An action outside this list still renders — `auditActionLabel`
 * falls back to the raw value — so adding a writer does not need this file.
 */
const PLATFORM_ACTIONS = ["SUPPORT_SESSION_START", "SUPPORT_SESSION_END"] as const;

const PAGE_SIZE = 200;

interface PlatformAuditRow {
  id: string;
  actorUserId: string;
  actorEmail: string;
  action: string;
  targetTenantId: string | null;
  supportSessionId: string | null;
  /** Parsed server-side: an object, or the raw string if it would not parse. */
  detail: unknown;
  ip: string | null;
  createdAt: string;
}

function auditActionLabel(action: string, lang: Language): string {
  const key = `platform.audit.action.${action}`;
  const translated = translate(key, lang);
  return translated === key ? action.replace(/_/g, " ") : translated;
}

/** Render `detail` without pretending to know its shape. */
function detailText(detail: unknown): string {
  if (detail === null || detail === undefined) return "—";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function PlatformAuditPanel({ tenants }: { tenants: { id: string; name: string }[] }) {
  const me = useFgmp((s) => s.me);
  const t = useT();
  const tFmt = useTF();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";

  /** Same capability the API policy names for `/api/fgmp/platform/audit`. */
  const canReview = me ? hasCapability(me.role, "view:tenants") : false;

  const [action, setAction] = useState<string>("all");
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (action !== "all") params.set("action", action);
  if (tenantFilter !== "all") params.set("tenant", tenantFilter);

  const url = canReview ? `/api/fgmp/platform/audit?${params.toString()}` : null;
  const { data, loading, error, refetch } = useApi<PlatformAuditRow[]>(url, {
    deps: [action, tenantFilter, offset],
  });

  const rows = useMemo(() => data ?? [], [data]);
  const tenantName = useMemo(() => {
    const map = new Map(tenants.map((tnt) => [tnt.id, tnt.name]));
    return (id: string | null) => (id ? map.get(id) ?? id : "—");
  }, [tenants]);

  const stats = useMemo(
    () => ({
      total: rows.length,
      starts: rows.filter((r) => r.action === "SUPPORT_SESSION_START").length,
      ends: rows.filter((r) => r.action === "SUPPORT_SESSION_END").length,
      operators: new Set(rows.map((r) => r.actorUserId)).size,
    }),
    [rows],
  );

  if (!canReview) return null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* These four describe the PAGE, not the installation: the route pages
            by offset, so anything else would claim knowledge it does not have. */}
        <KpiCard label={t("platform.audit.events")} value={formatNumber(stats.total, numLang)} icon={<ScrollText className="h-4 w-4" />} />
        <KpiCard label={t("platform.audit.starts")} value={formatNumber(stats.starts, numLang)} icon={<ShieldAlert className="h-4 w-4" />} tone="warn" />
        <KpiCard label={t("platform.audit.ends")} value={formatNumber(stats.ends, numLang)} icon={<ShieldCheck className="h-4 w-4" />} tone="good" />
        <KpiCard label={t("platform.audit.actors")} value={formatNumber(stats.operators, numLang)} icon={<Users className="h-4 w-4" />} tone="info" />
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ScrollText className="h-4 w-4 text-amber-500" />
              {t("platform.tab.audit")}
            </CardTitle>
            <p className="mt-1 max-w-2xl text-[11px] text-muted-foreground">{t("platform.audit.desc")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              label={t("platform.audit.action")}
              value={action}
              onValueChange={(v) => {
                setAction(v);
                setOffset(0);
              }}
            >
              <SelectTrigger className="h-9 w-[210px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("platform.audit.allActions")}</SelectItem>
                {PLATFORM_ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {auditActionLabel(a, numLang)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              label={t("platform.audit.tenant")}
              value={tenantFilter}
              onValueChange={(v) => {
                setTenantFilter(v);
                setOffset(0);
              }}
            >
              <SelectTrigger className="h-9 w-[200px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("platform.audit.allTenants")}</SelectItem>
                {tenants.map((tnt) => (
                  <SelectItem key={tnt.id} value={tnt.id}>
                    {tnt.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <ResourceError error={error} onRetry={refetch} compact />

          {loading && !data ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={Search} title={t("platform.audit.empty")} compact />
          ) : (
            <ScrollArea className="max-h-[560px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead className="w-[160px]">{t("platform.audit.when")}</TableHead>
                    <TableHead>{t("platform.audit.action")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("platform.audit.actor")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("platform.audit.tenant")}</TableHead>
                    <TableHead className="w-[80px]">{t("platform.audit.detail")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    // The detail row is the audit record's own text — the
                    // reason an operator gave, which is the part a reviewer
                    // reads. Collapsed by default so the table stays scannable.
                    <TableRow
                      key={r.id}
                      className="cursor-pointer hover:bg-muted/30"
                      onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    >
                      <TableCell className="text-[10px] tabular-nums text-muted-foreground" dir="ltr">
                        {fmtDateTime(r.createdAt, numLang)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            r.action.endsWith("_START")
                              ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[10px]"
                              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[10px]"
                          }
                        >
                          {auditActionLabel(r.action, numLang)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-[11px]" dir="ltr">
                        {r.actorEmail || r.actorUserId}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-[11px]">
                        {tenantName(r.targetTenantId)}
                      </TableCell>
                      <TableCell className="text-[10px] text-muted-foreground">
                        {expanded === r.id ? "−" : "+"}
                      </TableCell>
                    </TableRow>
                  ))}
                  {rows.map((r) =>
                    expanded === r.id ? (
                      <TableRow key={`${r.id}-detail`} className="bg-muted/20">
                        <TableCell colSpan={5} className="py-2">
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-muted-foreground" dir="ltr">
                            {detailText(r.detail)}
                            {r.ip ? `\n\nip: ${r.ip}` : ""}
                            {r.supportSessionId ? `\nsession: ${r.supportSessionId}` : ""}
                          </pre>
                        </TableCell>
                      </TableRow>
                    ) : null,
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              {tFmt("platform.audit.showing", { from: offset + (rows.length ? 1 : 0), to: offset + rows.length })}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                disabled={offset === 0}
                onClick={() => {
                  setExpanded(null);
                  setOffset(Math.max(0, offset - PAGE_SIZE));
                }}
              >
                {t("platform.audit.newer")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                // A short page means there is nothing older; a full page might
                // still be the last one, which costs one empty click and never
                // hides a row.
                disabled={rows.length < PAGE_SIZE}
                onClick={() => {
                  setExpanded(null);
                  setOffset(offset + PAGE_SIZE);
                }}
              >
                {t("platform.audit.older")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
