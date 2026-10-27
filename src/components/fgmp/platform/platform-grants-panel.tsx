"use client";

/**
 * The access-grant inventory — the surface behind `GET /api/fgmp/platform/grants`.
 *
 * ── WHY THIS SCREEN EXISTS ─────────────────────────────────────────────────
 * The route shipped before the screen did: a super-admin could fetch the grant
 * export with `curl`, and the Roles screen showed what each ROLE may do. Neither
 * answered the question an access review actually asks — "which PEOPLE hold
 * which role, in which tenant, and is that account still live?". The route was
 * therefore a capability with no product surface: correct, tested, and
 * unreachable. This is the missing half.
 *
 * ── WHY IT FANS OUT AND IS THEREFORE SLOW ──────────────────────────────────
 * `User` is FORCE-RLS protected and there is no bypass role on this path, so the
 * route performs one scoped read per tenant. On two tenants that is instant; on
 * fifty it is a visible second. The screen says so instead of pretending: the
 * table shows what arrived, the role totals are computed by the server, and the
 * CSV export runs the same query so the file and the screen can never disagree.
 *
 * ── WHY THE UI GATES ON `view:tenants` ─────────────────────────────────────
 * The API policy row for `/api/fgmp/platform/grants` requires `view:tenants`,
 * which only the platform wildcard grants. The gate here is derived from the
 * same capability rather than from a role literal, so the screen cannot outlive
 * a change to the matrix: drop the capability and the panel renders nothing
 * before it issues a request. (`useApi` also refuses the fetch for the same
 * reason — belt and braces, because a 403-driven empty table reads like "no
 * grants exist".)
 */

import { useMemo, useState } from "react";
import { KeyRound, Download, Search, ShieldCheck, UserX, Users } from "lucide-react";
import { useApi } from "@/lib/fgmp/use-api";
import { hasCapability } from "@/lib/fgmp/rbac-core";
import { useFgmp } from "@/lib/fgmp/store";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { ResourceError } from "@/components/fgmp/resource-error";
import { EmptyState } from "@/components/fgmp/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fmtDate } from "@/lib/fgmp/format";
import { roleLabel } from "@/lib/fgmp/labels";
import { useT, useTF, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";

/** Wire shape of `GET /api/fgmp/platform/grants` (dates arrive as ISO strings). */
interface GrantPayload {
  generatedAt: string;
  totals: { users: number; byRole: Record<string, number> };
  grants: {
    tenantId: string;
    tenantName: string;
    tenantCode: string;
    userId: string;
    email: string;
    name: string;
    role: string;
    active: boolean;
    lastLoginAt: string | null;
    createdAt: string;
  }[];
}

/** Keep the rendered table finite; the export is the unfiltered artifact. */
const ROW_CAP = 200;

export function PlatformGrantsPanel({ tenants }: { tenants: { id: string; name: string }[] }) {
  const me = useFgmp((s) => s.me);
  const t = useT();
  const tFmt = useTF();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";

  /**
   * One capability, two jobs: it decides whether this panel renders at all and
   * whether the request is made. A super-admin session in "act as" mode has the
   * effective role of the impersonated tenant user, and `me.role` is that
   * effective role — so a support session cannot use this screen to read the
   * whole installation's grants while pretending to be a customer.
   */
  const canReview = me ? hasCapability(me.role, "view:tenants") : false;

  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [q, setQ] = useState("");

  const url = canReview
    ? `/api/fgmp/platform/grants${tenantFilter !== "all" ? `?tenant=${encodeURIComponent(tenantFilter)}` : ""}`
    : null;
  const { data, loading, error, refetch } = useApi<GrantPayload>(url, {
    interval: 120_000,
    deps: [tenantFilter],
  });

  const grants = useMemo(() => data?.grants ?? [], [data]);

  const filtered = useMemo(() => {
    if (!q) return grants;
    const needle = q.toLowerCase();
    return grants.filter((g) =>
      `${g.name} ${g.email} ${g.role} ${g.tenantName} ${g.tenantCode}`.toLowerCase().includes(needle),
    );
  }, [grants, q]);

  const shown = useMemo(() => filtered.slice(0, ROW_CAP), [filtered]);

  const roleTotals = useMemo(() => {
    const entries = Object.entries(data?.totals.byRole ?? {});
    return entries.sort((a, b) => b[1] - a[1]);
  }, [data]);

  const tenantCount = useMemo(() => {
    const set = new Set(grants.map((g) => g.tenantId));
    return set.size;
  }, [grants]);

  // Not super-admin ⇒ nothing. The nav entry does not exist for a tenant role,
  // and `store.setView()` refuses the view; this is the third layer, for the
  // typed-URL / stale-bundle case, and it renders no heading and no table.
  if (!canReview) return null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label={t("platform.grants.users")}
          value={formatNumber(data?.totals.users ?? 0, numLang)}
          icon={<Users className="h-4 w-4" />}
          tone="info"
        />
        <KpiCard
          label={t("platform.grants.tenants")}
          value={formatNumber(tenantCount, numLang)}
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <KpiCard
          label={t("platform.grants.admins")}
          value={formatNumber(data?.totals.byRole.ADMIN ?? 0, numLang)}
          icon={<KeyRound className="h-4 w-4" />}
          tone="warn"
        />
        <KpiCard
          label={t("platform.grants.inactive")}
          value={formatNumber(grants.filter((g) => !g.active).length, numLang)}
          icon={<UserX className="h-4 w-4" />}
          tone={grants.some((g) => !g.active) ? "danger" : "good"}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <KeyRound className="h-4 w-4 text-emerald-500" />
              {t("platform.tab.grants")}
            </CardTitle>
            <p className="mt-1 max-w-2xl text-[11px] text-muted-foreground">{t("platform.grants.desc")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("platform.grants.search")}
                className="h-9 w-[220px] ps-8"
              />
            </div>
            <Select label={t("platform.grants.filterTenant")} value={tenantFilter} onValueChange={setTenantFilter}>
              <SelectTrigger className="h-9 w-[200px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("platform.grants.allTenants")}</SelectItem>
                {tenants.map((tnt) => (
                  <SelectItem key={tnt.id} value={tnt.id}>
                    {tnt.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/*
              A plain link, not a fetch: the CSV is produced by the same route
              with `format=csv`, so the download needs no client-side
              serialisation and cannot drift from the JSON above. `download`
              plus the server's Content-Disposition keeps it out of the tab.
            */}
            <Button asChild size="sm" variant="outline" title={t("platform.grants.exportHint")}>
              <a
                href={`/api/fgmp/platform/grants?format=csv${tenantFilter !== "all" ? `&tenant=${encodeURIComponent(tenantFilter)}` : ""}`}
                download
              >
                <Download className="me-1.5 h-4 w-4" />
                {t("platform.grants.export")}
              </a>
            </Button>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <ResourceError error={error} onRetry={refetch} compact />

          {roleTotals.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
              <span className="me-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("platform.grants.byRole")}
              </span>
              {roleTotals.map(([role, count]) => (
                <Badge key={role} variant="outline" className="text-[10px]">
                  {roleLabel(role, numLang)}
                  <span className="ms-1.5 tabular-nums text-muted-foreground">
                    {formatNumber(count, numLang)}
                  </span>
                </Badge>
              ))}
            </div>
          )}

          {loading && !data ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <EmptyState icon={KeyRound} title={t("platform.grants.empty")} compact />
          ) : (
            <ScrollArea className="max-h-[560px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>{t("platform.grants.user")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("platform.audit.tenant")}</TableHead>
                    <TableHead className="w-[150px]">{t("platform.grants.role")}</TableHead>
                    <TableHead className="hidden lg:table-cell w-[120px]">{t("platform.grants.lastLogin")}</TableHead>
                    <TableHead className="w-[90px]">{t("platform.grants.state")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((g) => (
                    <TableRow key={`${g.tenantId}:${g.userId}`} className="hover:bg-muted/30">
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-xs font-medium">{g.name}</span>
                          <span className="text-[10px] text-muted-foreground" dir="ltr">
                            {g.email}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className="text-[11px]">{g.tenantName}</span>
                        <Badge variant="outline" className="ms-1.5 font-mono text-[10px]" dir="ltr">
                          {g.tenantCode}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">
                          {roleLabel(g.role, numLang)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-[10px] text-muted-foreground" dir="ltr">
                        {g.lastLoginAt ? fmtDate(g.lastLoginAt, numLang) : t("platform.grants.never")}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={
                            g.active
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-[10px]"
                              : "bg-muted text-muted-foreground text-[10px]"
                          }
                        >
                          {g.active ? t("common.active") : t("common.inactive")}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}

          {/*
            The cap is stated, not silent: a reviewer who sees 200 rows and
            assumes they saw everything will sign off a grant they never
            looked at. `TruncationNote` renders nothing when the list fits.
          */}
          <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
            {tFmt("platform.grants.capped", {
              shown: shown.length,
              total: filtered.length,
            })}
            {data && (
              <span className="ms-2 opacity-80">
                {tFmt("platform.grants.generatedAt", { when: fmtDate(data.generatedAt, numLang) })}
              </span>
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
