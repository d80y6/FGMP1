"use client";

import { useState, useCallback } from "react";
import { ShieldCheck, ShieldAlert, Play, RefreshCw, CheckCircle2, XCircle, Building2, Users, AlertCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi } from "@/lib/fgmp/use-api";
import { canAccessApi, hasCapability } from "@/lib/fgmp/rbac-core";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { useT, useTF } from "@/lib/fgmp/use-language";

// ── Types (mirror the API response) ────────────────────────────────────────
interface TenantCensus {
  tenantId: string;
  tenantName: string;
  tenantCode: string;
  country: string;
  counts: Record<string, number>;
  listScoped: Record<string, number>;
}

interface ResourceTest {
  resource: string;
  resourceId: string | null;
  resourceLabel: string | null;
  sourceTenant: string;
  targetTenant: string;
  recordFound: boolean;
  crossTenantDenied: boolean | null;
  platformHelperPermits: boolean | null;
  reason?: string;
  pass: boolean;
}

interface CrossTenantTestGroup {
  sourceTenant: string;
  targetTenant: string;
  tests: ResourceTest[];
}

interface IsolationReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tenantCount: number;
  tenants: TenantCensus[];
  crossTenantTests: CrossTenantTestGroup[];
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    measured: number;
    unmeasured: number;
    sampledChecksPassed: boolean;
    verdictBasis: string;
  };
}

const RESOURCE_LABELS: Record<string, string> = {
  site: "Site",
  alarm: "Alarm",
  generator: "Generator",
  tank: "Fuel Tank",
  battery: "Battery Bank",
  user: "User",
  suppression: "Alarm Suppression",
  apiKey: "API Key",
};

const COUNT_LABELS: Record<string, string> = {
  users: "Users",
  sites: "Sites",
  alarms: "Alarms",
  generators: "Generators",
  tanks: "Tanks",
  batteries: "Batteries",
  dispensers: "Dispensers",
  deliveries: "Deliveries",
  tickets: "Maintenance",
  iotDevices: "IoT Devices",
  suppressions: "Suppressions",
  auditLogs: "Audit Logs",
  notifications: "Notifications",
  regions: "Regions",
  apiKeys: "API Keys",
  shiftHandovers: "Shift Handovers",
  gateways: "Gateways",
};

export function TenantIsolationView() {
  const t = useT();
  const tFmt = useTF();
  const me = useFgmp((s) => s.me);
  const { data: report, loading, error } = useApi<IsolationReport>("/api/fgmp/admin/tenant-isolation-test");
  const [running, setRunning] = useState(false);
  const [localReport, setLocalReport] = useState<IsolationReport | null>(null);

  const current = localReport ?? report;

  const runTest = useCallback(async () => {
    setRunning(true);
    setLocalReport(null);
    try {
      // SUPERADMIN-only (view:tenant-isolation). The render guard above hides the
      // view, and useApi refuses to fetch for anyone else; this click path needs
      // the same gate so a stale handler cannot issue the request either.
      if (!canAccessApi(me?.role, "/api/fgmp/admin/tenant-isolation-test", "GET")) {
        throw new Error("insufficient capability");
      }
      const r = await fetch("/api/fgmp/admin/tenant-isolation-test", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as IsolationReport;
      setLocalReport(data);
    } catch (err) {
      console.error("Tenant isolation test failed:", err);
    } finally {
      setRunning(false);
    }
  }, [me?.role]);

  // Access guard — `view:tenant-isolation`, a SUPERADMIN-only capability (held
  // through the wildcard). Same capability the nav filter and the API use.
  if (me && !hasCapability(me.role, "view:tenant-isolation")) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <Card className="max-w-md p-8 text-center">
          <ShieldAlert className="mx-auto mb-4 h-12 w-12 text-amber-500" />
          <h2 className="mb-2 text-xl font-semibold">{t("tenants.superadminOnly")}</h2>
          <p className="text-sm text-muted-foreground">{t("isolation.superadminOnly")}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <ShieldCheck className="h-7 w-7 text-emerald-500" />
            {t("nav.tenantIsolation") || "Tenant Isolation"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Run a helper-level isolation diagnostic over sampled database rows.
            This checks ownership helpers and selected list filters; it does not execute
            every HTTP route or grant super-admin access to customer records.
          </p>
        </div>
        <Button onClick={runTest} disabled={running || loading} size="lg" className="shrink-0">
          {running || loading ? (
            <><RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Running...</>
          ) : (
            <><Play className="mr-2 h-4 w-4" /> {t("isolation.runTest")}</>
          )}
        </Button>
      </div>

      {error && (
        <Card className="border-rose-500/30 bg-rose-500/5 p-4">
          <div className="flex items-center gap-2 text-rose-700 dark:text-rose-400">
            <AlertCircle className="h-5 w-5" />
            <span className="font-medium">{t("isolation.loadFailed")}</span>
            <span className="text-sm">{error}</span>
          </div>
        </Card>
      )}

      {(running || loading) && !current && (
        <Card className="p-6">
          <Skeleton className="mb-3 h-8 w-48" />
          <div className="grid gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
          <Skeleton className="mt-4 h-64 w-full" />
        </Card>
      )}

      {current && (
        <>
          {/* Summary banner */}
          <Card className={`p-5 ${current.summary.sampledChecksPassed ? "border-emerald-500/40 bg-emerald-500/5" : current.summary.failed > 0 ? "border-rose-500/40 bg-rose-500/5" : "border-amber-500/40 bg-amber-500/5"}`}>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-3">
                {current.summary.sampledChecksPassed ? (
                  <CheckCircle2 className="h-10 w-10 text-emerald-500" />
                ) : current.summary.failed > 0 ? (
                  <XCircle className="h-10 w-10 text-rose-500" />
                ) : (
                  <AlertCircle className="h-10 w-10 text-amber-500" />
                )}
                <div>
                  <div className="text-lg font-semibold">
                    {current.summary.sampledChecksPassed
                      ? "Sampled Helper Checks Passed"
                      : current.summary.failed > 0
                        ? "Sampled Helper Check Failed"
                        : "Sampled Helper Check Incomplete"}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {tFmt("isolation.summaryLine", {
                      passed: current.summary.passed, failed: current.summary.failed,
                      unmeasured: current.summary.unmeasured, tenants: current.tenantCount, ms: current.durationMs,
                    })}
                    <div className="mt-1 text-xs">{current.summary.verdictBasis}</div>
                  </div>
                </div>
              </div>
              <div className="flex gap-6">
                <div className="text-center">
                  <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{current.summary.passed}</div>
                  <div className="text-xs text-muted-foreground">Passed</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-rose-700 dark:text-rose-400">{current.summary.failed}</div>
                  <div className="text-xs text-muted-foreground">Failed</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-amber-700 dark:text-amber-400">{current.summary.unmeasured}</div>
                  <div className="text-xs text-muted-foreground">Unmeasured</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold">{current.tenantCount}</div>
                  <div className="text-xs text-muted-foreground">Tenants</div>
                </div>
              </div>
            </div>
          </Card>

          {/* Per-tenant census */}
          <Card className="p-5">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
              <Building2 className="h-5 w-5 text-primary" />{t("isolation.census")}</h2>
            <ScrollRegion label={t("isolation.census")} className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2 font-medium">Tenant</th>
                    <th className="p-2 font-medium">Code</th>
                    {Object.entries(COUNT_LABELS).map(([k, label]) => (
                      <th key={k} className="p-2 text-right font-medium">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {current.tenants.map((tn) => (
                    <tr key={tn.tenantId} className="border-b last:border-0 hover:bg-muted/50">
                      <td className="p-2 font-medium">
                        {tn.tenantName}
                        {tn.tenantCode === "PLATFORM" && (
                          <Badge className="ml-2 bg-amber-500/15 text-amber-700 dark:text-amber-400 text-[10px]">PLATFORM</Badge>
                        )}
                      </td>
                      <td className="p-2 text-muted-foreground">{tn.tenantCode}</td>
                      {Object.keys(COUNT_LABELS).map((k) => (
                        <td key={k} className="p-2 text-right tabular-nums">
                          {tn.counts[k] ?? 0}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </Card>

          {/* Cross-tenant test results */}
          <Card className="p-5">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
              <ShieldAlert className="h-5 w-5 text-primary" />{t("isolation.crossTenant")}</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              For each tenant pair, sampled rows are tested against ownership helpers.
              These are helper-level checks only: a super-admin helper result is not
              route authorization. Platform access still requires a documented,
              explicitly named control-plane or support path.
            </p>
            <div className="space-y-4">
              {current.crossTenantTests.map((group, i) => (
                <div key={i} className="rounded-lg border">
                  <div className="border-b bg-muted/30 px-4 py-2 text-sm font-medium">
                    {group.sourceTenant} → {group.targetTenant}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {tFmt("isolation.groupSummary", {
                        passed: group.tests.filter((x) => x.recordFound && x.pass).length,
                        failed: group.tests.filter((x) => x.recordFound && !x.pass).length,
                        unmeasured: group.tests.filter((x) => !x.recordFound).length,
                      })}
                    </span>
                  </div>
                  <div className="divide-y">
                    {group.tests.map((test, j) => (
                      <div key={j} className="flex items-center gap-3 px-4 py-2 text-sm">
                        {!test.recordFound ? (
                          <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
                        ) : test.pass ? (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                        ) : (
                          <XCircle className="h-4 w-4 shrink-0 text-rose-500" />
                        )}
                        <div className="w-28 shrink-0 font-medium">
                          {RESOURCE_LABELS[test.resource] ?? test.resource}
                        </div>
                        <div className="flex-1 truncate text-muted-foreground" title={test.reason ?? test.resourceId ?? "No sample row found"}>
                          {test.resourceLabel}
                        </div>
                        <div className="flex shrink-0 gap-4 text-xs">
                          {!test.recordFound ? (
                            <span className="text-amber-700 dark:text-amber-400" title={test.reason}>{t("isolation.notMeasured")}</span>
                          ) : (
                            <>
                              <span className={test.crossTenantDenied ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}>
                                Cross-tenant: {test.crossTenantDenied ? "Denied ✓" : "Allowed ✗"}
                              </span>
                              <span className="text-muted-foreground" title={t("isolation.ownershipTooltip")}>
                                {t("isolation.platformHelper")}: {test.platformHelperPermits ? t("isolation.permits") : t("isolation.denies")}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {current.crossTenantTests.length === 0 && (
                <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                  <AlertCircle className="mx-auto mb-2 h-8 w-8" />{t("isolation.noTests")}</div>
              )}
            </div>
          </Card>

          {/* List-view scoping audit */}
          <Card className="p-5">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
              <Users className="h-5 w-5 text-primary" />{t("isolation.scopingAudit")}</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              {tFmt("isolation.scopingAuditDesc", { fn1: "tenantWhereOrAll", fn2: "siteTenantWhereOrAll" })}
            </p>
            <ScrollRegion label={t("isolation.scopingAudit")} className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2 font-medium">Tenant</th>
                    <th className="p-2 text-right font-medium">Sites (list)</th>
                    <th className="p-2 text-right font-medium">Sites (census)</th>
                    <th className="p-2 text-right font-medium">Alarms (list)</th>
                    <th className="p-2 text-right font-medium">Alarms (census)</th>
                    <th className="p-2 text-right font-medium">Gens (list)</th>
                    <th className="p-2 text-right font-medium">Gens (census)</th>
                    <th className="p-2 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {current.tenants.map((tn) => {
                    const sitesMatch = tn.listScoped.sitesList === tn.counts.sites;
                    const alarmsMatch = tn.listScoped.alarmsList === tn.counts.alarms;
                    const gensMatch = tn.listScoped.generatorsList === tn.counts.generators;
                    const allMatch = sitesMatch && alarmsMatch && gensMatch;
                    return (
                      <tr key={tn.tenantId} className="border-b last:border-0 hover:bg-muted/50">
                        <td className="p-2 font-medium">{tn.tenantName}</td>
                        <td className="p-2 text-right tabular-nums">{tn.listScoped.sitesList}</td>
                        <td className="p-2 text-right tabular-nums text-muted-foreground">{tn.counts.sites}</td>
                        <td className="p-2 text-right tabular-nums">{tn.listScoped.alarmsList}</td>
                        <td className="p-2 text-right tabular-nums text-muted-foreground">{tn.counts.alarms}</td>
                        <td className="p-2 text-right tabular-nums">{tn.listScoped.generatorsList}</td>
                        <td className="p-2 text-right tabular-nums text-muted-foreground">{tn.counts.generators}</td>
                        <td className="p-2 text-center">
                          {allMatch ? (
                            <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-500" />
                          ) : (
                            <XCircle className="mx-auto h-4 w-4 text-rose-500" />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollRegion>
          </Card>

          <div className="text-xs text-muted-foreground">
            {tFmt("isolation.generatedAt", { when: new Date(current.finishedAt).toLocaleString() })}
          </div>
        </>
      )}

      {!current && !running && !loading && !error && (
        <Card className="p-12 text-center">
          <ShieldCheck className="mx-auto mb-4 h-16 w-16 text-muted-foreground/50" />
          <h3 className="mb-2 text-lg font-semibold">{t("isolation.noReport")}</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            {t("isolation.noReportHint")}
          </p>
          <Button onClick={runTest}>
            <Play className="mr-2 h-4 w-4" /> {t("isolation.run")}
          </Button>
        </Card>
      )}

      {/* The hidden `<button className="sr-only" aria-hidden onClick={refetch}>`
          that used to sit here was dead code twice over: nothing ever clicked
          it (useApi already polls on its own), and a focusable <button> inside
          aria-hidden is `aria-hidden-focus` — the finding the sweep reported on
          this view as the truncated "tenant-isolation (SUPERADMIN): axe ari…".
          Removed rather than hidden further: an element no user can reach and
          no code invokes is not a control. */}
    </div>
  );
}

TenantIsolationView.displayName = "TenantIsolationView";
