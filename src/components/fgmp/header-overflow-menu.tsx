"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import {
  Activity,
  Check,
  CirclePause,
  CirclePlay,
  Keyboard,
  Languages,
  MoreHorizontal,
  Monitor,
  Moon,
  ShieldCheck,
  Sun,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { hasCapability } from "@/lib/fgmp/rbac-core";
import { useT, useDir, useLanguage, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import type { Kpis, Role } from "@/lib/fgmp/types";
import { cn } from "@/lib/utils";

/**
 * Header overflow — "More actions".
 *
 * WHY THIS EXISTS (D-26)
 * ----------------------
 * The header was one non-wrapping row of ~15 controls with a fixed 1440px
 * budget of 1614px. Past that budget the row did not scroll and did not wrap:
 * the controls simply continued past the right edge of the window, where they
 * are unreachable by mouse, keyboard and screen reader alike. Measured at
 * 1440×900, `Switch role` began at x=1422 and `Sign out` at x=1578 — an ADMIN
 * could not sign out on a 1440px laptop. On a 390px phone eight controls were
 * off-screen, including the language switch (the only way to reach the Arabic
 * UI) and the live-feed pause.
 *
 * The fix is progressive disclosure rather than a smaller font: the wide
 * header keeps every control inline, and below a breakpoint the same actions
 * become named items in this menu. Each item is hidden at the width where its
 * inline counterpart is visible (`2xl:`/`xl:`/`lg:`), so a control is never
 * duplicated — it is in exactly one place at any given width.
 *
 * Nothing here is a new capability: every item drives the store action or
 * navigation the inline control already used.
 */

const subscribeNoop = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

type Props = {
  kpis: Kpis | null;
  livePaused: boolean;
  onToggleLive: () => void;
  onOpenShortcuts: () => void;
  onOpenSystemHealth: () => void;
  /** Effective role. The role switch is an ADMIN/SUPERADMIN preview tool. */
  role: Role | null;
  /** Roles this account may switch to; empty for ordinary operators. */
  roles: Role[];
  onSwitchRole: (role: Role) => void;
};

export function HeaderOverflowMenu({
  kpis,
  livePaused,
  onToggleLive,
  onOpenShortcuts,
  onOpenSystemHealth,
  role,
  roles,
  onSwitchRole,
}: Props) {
  const t = useT();
  const dir = useDir();
  const { theme, setTheme } = useTheme();
  const { lang, setLang } = useLanguage();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const mounted = useSyncExternalStore(subscribeNoop, getClientSnapshot, getServerSnapshot);

  // `role:preview` — the capability the preview endpoint enforces, instead of a
  // second copy of the ADMIN/SUPERADMIN list.
  const canSwitchRole = !!role && hasCapability(role, "role:preview");
  const themeOptions = [
    { value: "system" as const, label: t("common.themeSystem"), icon: Monitor },
    { value: "light" as const, label: t("common.themeLight"), icon: Sun },
    { value: "dark" as const, label: t("common.themeDark"), icon: Moon },
  ];

  return (
    <DropdownMenu dir={dir} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="2xl:hidden"
          aria-label={t("common.moreActions")}
          title={t("common.moreActions")}
          data-testid="header-overflow-trigger"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64" data-testid="header-overflow-menu">
        {/* The KPI snapshot leaves the header below 2xl because four chips plus
            their labels need ~360px. The numbers themselves stay available
            here, and the dashboard shows the same figures with context. */}
        {kpis && (
          <>
            <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground xl:hidden">
              {t("common.snapshot")}
            </DropdownMenuLabel>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-2 pb-1 text-xs xl:hidden">
              <SnapshotItem label={t("kpi.sites")} value={`${formatNumber(kpis.onlineSites, numLang)}/${formatNumber(kpis.totalSites, numLang)}`} />
              <SnapshotItem label={t("kpi.alarms")} value={formatNumber(kpis.openAlarms, numLang)} />
              <SnapshotItem label={t("kpi.fuel")} value={`${formatNumber(kpis.fuelPct, numLang)}%`} />
              <SnapshotItem label={t("kpi.gens")} value={`${formatNumber(kpis.generatorsRunning, numLang)}/${formatNumber(kpis.generatorsTotal, numLang)}`} />
            </div>
            <DropdownMenuSeparator className="xl:hidden" />
          </>
        )}

        <DropdownMenuItem className="lg:hidden" onSelect={onToggleLive}>
          {livePaused ? <CirclePlay className="h-4 w-4" /> : <CirclePause className="h-4 w-4" />}
          <span className="flex-1">{livePaused ? t("common.resumeLive") : t("common.pauseLive")}</span>
        </DropdownMenuItem>

        {canSwitchRole && (
          <>
            <DropdownMenuSeparator className="2xl:hidden" />
            <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground 2xl:hidden">
              {t("common.switchRole")}
            </DropdownMenuLabel>
            <div className="2xl:hidden">
              {roles.map((r) => {
                const key = `role.${r.toLowerCase()}`;
                const translated = t(key);
                const label = translated === key ? r.replace(/_/g, " ") : translated;
                return (
                  <DropdownMenuItem
                    key={r}
                    onSelect={() => onSwitchRole(r)}
                    className="text-xs"
                    role="menuitemradio"
                    aria-checked={r === role}
                  >
                    <ShieldCheck
                      className={cn(
                        "h-3.5 w-3.5",
                        r === role ? "text-emerald-500" : "text-muted-foreground",
                      )}
                    />
                    <span className="flex-1">{label}</span>
                    {r === role && <Check className="h-3.5 w-3.5 text-emerald-500" />}
                  </DropdownMenuItem>
                );
              })}
            </div>
          </>
        )}

        <DropdownMenuSeparator className="lg:hidden" />
        <DropdownMenuLabel className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground lg:hidden">
          <Languages className="h-3 w-3" aria-hidden="true" />
          {t("common.language")}
        </DropdownMenuLabel>
        {([
          { value: "en" as const, label: t("common.english") },
          { value: "ar" as const, label: t("common.arabic") },
        ]).map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onSelect={() => setLang(opt.value)}
            className="lg:hidden"
            aria-checked={mounted && lang === opt.value}
            role="menuitemradio"
          >
            <span className="flex-1">{opt.label}</span>
            {mounted && lang === opt.value && <Check className="h-3.5 w-3.5 text-emerald-500" />}
          </DropdownMenuItem>
        ))}

        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground lg:hidden">
          {t("common.theme")}
        </DropdownMenuLabel>
        {themeOptions.map((opt) => {
          const Icon = opt.icon;
          const isSelected = theme === opt.value;
          return (
            <DropdownMenuItem
              key={opt.value}
              onSelect={() => setTheme(opt.value)}
              className="lg:hidden"
              aria-checked={isSelected}
              role="menuitemradio"
            >
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1">{opt.label}</span>
              {isSelected && <Check className="h-3.5 w-3.5 text-emerald-500" />}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator className="2xl:hidden" />
        <DropdownMenuItem className="2xl:hidden" onSelect={onOpenShortcuts}>
          <Keyboard className="h-4 w-4" />
          <span className="flex-1">{t("common.keyboardShortcuts")}</span>
        </DropdownMenuItem>
        {canSwitchRole && (
          <DropdownMenuItem className="2xl:hidden" onSelect={onOpenSystemHealth}>
            <Activity className="h-4 w-4" />
            <span className="flex-1">{t("systemHealth.title")}</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One KPI pair inside the overflow menu. Read-only: the value is the same
 *  number the header chip shows, not a control. */
function SnapshotItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 rounded px-1 py-0.5">
      <span className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="font-mono text-xs font-medium tabular-nums">{value}</span>
    </div>
  );
}
