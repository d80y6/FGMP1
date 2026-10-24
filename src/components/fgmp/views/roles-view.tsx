"use client";

import { useMemo, useState } from "react";
import {
  ShieldCheck, KeyRound, Check, Asterisk, UserCircle2, Lock,
} from "lucide-react";
import { useFgmp } from "@/lib/fgmp/store";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useT, useArabicNumerals, formatNumber, useTF } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { roleLabel } from "@/lib/fgmp/labels";
import { ROLE_PERMISSIONS, ALL_ROLES } from "@/lib/fgmp/rbac-core";
import type { Role } from "@/lib/fgmp/types";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */


/** Capability groups (prefixes) shown as columns in the matrix. */
const CAPABILITY_GROUPS: { prefix: string; label: string }[] = [
  { prefix: "view", label: "Views" },
  { prefix: "alarm", label: "Alarms" },
  { prefix: "gen", label: "Generators" },
  { prefix: "ticket", label: "Tickets" },
  { prefix: "delivery", label: "Deliveries" },
  { prefix: "dispenser", label: "Dispensers" },
];

/** All distinct capabilities across every role (excluding "*"). */
function allDistinctCapabilities(): string[] {
  const set = new Set<string>();
  ALL_ROLES.forEach((r) => {
    ROLE_PERMISSIONS[r].capabilities.forEach((c) => {
      if (c !== "*") set.add(c);
    });
  });
  return Array.from(set).sort();
}

/** Whether a role has at least one capability in a given group prefix. */
function roleHasGroup(role: Role, prefix: string): boolean {
  const caps = ROLE_PERMISSIONS[role].capabilities;
  if (caps.includes("*")) return true;
  return caps.some((c) => c === prefix || c.startsWith(`${prefix}:`));
}

/** Group a role's capabilities by prefix; returns a sorted map. */
function groupCapabilities(role: Role): { prefix: string; items: string[] }[] {
  const caps = ROLE_PERMISSIONS[role].capabilities;
  if (caps.includes("*")) return [{ prefix: "*", items: ["*"] }];
  const buckets = new Map<string, string[]>();
  caps.forEach((c) => {
    const idx = c.indexOf(":");
    const prefix = idx === -1 ? c : c.slice(0, idx);
    const arr = buckets.get(prefix) ?? [];
    arr.push(c);
    buckets.set(prefix, arr);
  });
  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([prefix, items]) => ({ prefix, items: items.sort() }));
}

/* ────────────────────────────────────────────────────────────────────────
 * Main view
 * ──────────────────────────────────────────────────────────────────────── */

export function RolesView() {
  const me = useFgmp((s) => s.me);
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";

  // Selected role for the detail panel — defaults to the current user's role.
  const myRole = (me?.role ?? "READONLY") as Role;
  const [selectedRole, setSelectedRole] = useState<Role>(myRole);

  const allCaps = useMemo(() => allDistinctCapabilities(), []);
  const myCapsCount = useMemo(() => {
    const caps = ROLE_PERMISSIONS[myRole].capabilities;
    return caps.includes("*") ? allCaps.length : caps.length;
  }, [myRole, allCaps.length]);

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.roles")}
        description={t("desc.roles")}
        icon={<ShieldCheck className="h-5 w-5" />}
        tone="emerald"
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="All Roles"
          value={formatNumber(ALL_ROLES.length, numLang)}
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <KpiCard
          label="Capabilities"
          value={formatNumber(allCaps.length, numLang)}
          icon={<KeyRound className="h-4 w-4" />}
          tone="good"
        />
        <KpiCard
          label="Your Role"
          value={roleLabel(myRole, numLang)}
          icon={<UserCircle2 className="h-4 w-4" />}
          tone="warn"
        />
        <KpiCard
          label="Your Capabilities"
          value={formatNumber(myCapsCount, numLang)}
          icon={<Lock className="h-4 w-4" />}
          tone="info"
        />
      </div>

      {/* Matrix table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t("roles.capabilityMatrix")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="max-h-[480px]">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead className="sticky left-0 bg-card z-10">Role</TableHead>
                  {CAPABILITY_GROUPS.map((g) => (
                    <TableHead key={g.prefix} className="text-center w-[110px]">{g.label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {ALL_ROLES.map((r) => {
                  const isWildcard = ROLE_PERMISSIONS[r].capabilities.includes("*");
                  const isMine = r === myRole;
                  const isSelected = r === selectedRole;
                  return (
                    <TableRow
                      key={r}
                      className={cn(
                        "cursor-pointer transition-colors",
                        isSelected ? "bg-emerald-500/5" : "hover:bg-muted/30",
                      )}
                      onClick={() => setSelectedRole(r)}
                    >
                      <TableCell className="sticky left-0 bg-card z-10">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{roleLabel(r, numLang)}</span>
                          {isMine && (
                            <Badge variant="outline" className="h-4 px-1 text-[9px] border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                              YOU
                            </Badge>
                          )}
                          {isWildcard && (
                            <Badge variant="outline" className="h-4 px-1 text-[9px] border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                              <Asterisk className="h-2.5 w-2.5 mr-0.5" />WILDCARD
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      {CAPABILITY_GROUPS.map((g) => {
                        const has = roleHasGroup(r, g.prefix);
                        return (
                          <TableCell key={g.prefix} className="text-center">
                            {isWildcard ? (
                              <span className="inline-flex items-center justify-center text-amber-500">
                                <Asterisk className="h-3.5 w-3.5" />
                              </span>
                            ) : has ? (
                              <span className="inline-flex items-center justify-center text-emerald-500">
                                <Check className="h-4 w-4" />
                              </span>
                            ) : (
                              <span className="text-muted-foreground/30">—</span>
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Detail panel for the selected role */}
      <RoleDetailPanel role={selectedRole} lang={numLang} isMine={selectedRole === myRole} />

      {/* Legend */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 p-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-emerald-500" />
            {t("roles.groupGranted")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Asterisk className="h-3 w-3 text-amber-500" />
            WILDCARD — grants all capabilities (ADMIN)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground/30">—</span>
            {t("roles.notGranted")}
          </span>
          <span className="ml-auto">
            Click a row to inspect that role&apos;s full capability list below.
          </span>
        </CardContent>
      </Card>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Sub-components
 * ──────────────────────────────────────────────────────────────────────── */

function RoleDetailPanel({
  role, lang, isMine,
}: { role: Role; lang: Language; isMine: boolean }) {
  const meta = ROLE_PERMISSIONS[role];
  const t = useT();
  const tFmt = useTF();
  const groups = useMemo(() => groupCapabilities(role), [role]);
  const isWildcard = meta.capabilities.includes("*");

  return (
    <Card className="border-emerald-500/20">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
            {roleLabel(role, lang)}
            {isMine && (
              <Badge variant="outline" className="text-[10px] border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">{t("roles.yourRole")}</Badge>
            )}
            {isWildcard && (
              <Badge variant="outline" className="text-[10px] border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <Asterisk className="h-2.5 w-2.5 mr-0.5" />WILDCARD
              </Badge>
            )}
          </CardTitle>
          <Badge variant="outline" className="text-[10px] tabular-nums">
            {formatNumber(isWildcard ? ALL_ROLES.flatMap((r) => ROLE_PERMISSIONS[r].capabilities).filter((c, i, arr) => c !== "*" && arr.indexOf(c) === i).length : meta.capabilities.length, lang)} capabilities
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{meta.description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {isWildcard ? (
          <Alert tone="amber">
            <Asterisk className="h-4 w-4" />
            <div>
              <p className="font-medium text-sm">{t("roles.wildcardAccess")}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {tFmt("roles.wildcardNote", { star: "*", fn: "hasCapability()" })}
              </p>
            </div>
          </Alert>
        ) : null}

        {groups.map((g) => (
          <div key={g.prefix} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="text-[10px] font-mono uppercase tracking-wide border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
              >
                {g.prefix}:
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {formatNumber(g.items.length, lang)} capabilit{g.items.length === 1 ? "y" : "ies"}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.items.map((c) => (
                <Badge
                  key={c}
                  variant="outline"
                  className="font-mono text-[10px] py-1"
                  dir="ltr"
                >
                  {c}
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Tiny inline alert component (emerald/amber styling only — does not import
 * the shadcn Alert which is wired to destructive styling).
 */
function Alert({
  tone, children,
}: { tone: "amber" | "emerald"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border p-3",
        tone === "amber"
          ? "border-amber-500/30 bg-amber-500/5"
          : "border-emerald-500/30 bg-emerald-500/5",
      )}
    >
      {children}
    </div>
  );
}
