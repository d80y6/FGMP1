"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useRouter, useSearchParams } from "next/navigation";
import {
  LayoutDashboard, Building2, Droplet, Zap, BatteryCharging, Siren,
  Truck, TrendingUp, FileText, Cpu, Wrench, ScrollText, Fuel,
  Search, CornerDownLeft, Moon, Sun, Pause, Play, ArrowRight,
  MapPin, AlertTriangle, HardDrive, GitBranch, BarChart3, Map,
  KeyRound, Settings, Layers, ShieldCheck, type LucideIcon,
} from "lucide-react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList, CommandSeparator, CommandShortcut,
} from "@/components/ui/command";
import { useFgmp, type ViewKey } from "@/lib/fgmp/store";
import { hasCapability } from "@/lib/fgmp/rbac-core";
import { useCanView, useCan } from "@/lib/fgmp/use-access";
import { NAV_ENTRIES } from "@/lib/fgmp/navigation";
import { useTheme } from "next-themes";
import { useT, useTF } from "@/lib/fgmp/use-language";
import { toast } from "sonner";

// Icons stay here; the ENTRIES come from the shared table. The palette used to
// keep a private list of 22 views while the sidebar listed 28, so five screens
// (suppressions, users, system-health, tenant-isolation, preferences) could not
// be reached from the palette at all, and a capability added to one list was
// silently missing from the other.
const ICONS: Record<ViewKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  sites: Building2,
  fuel: Droplet,
  dispensers: Fuel,
  "edge-firmware": HardDrive,
  generators: Zap,
  batteries: BatteryCharging,
  alarms: Siren,
  suppressions: ShieldCheck,
  "asset-registry": Layers,
  inventory: Truck,
  iot: Cpu,
  maintenance: Wrench,
  analytics: TrendingUp,
  "fuel-forecast": GitBranch,
  "consumption-patterns": BarChart3,
  reports: FileText,
  audit: ScrollText,
  users: ShieldCheck,
  tenants: Building2,
  geography: Map,
  roles: ShieldCheck,
  "system-settings": Settings,
  "api-keys": KeyRound,
  "system-health": HardDrive,
  "tenant-isolation": ShieldCheck,
  preferences: ShieldCheck,
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { snapshot, me, view, setView, livePaused, toggleLive, switchRole } = useFgmp(useShallow((s) => ({ snapshot: s.snapshot, me: s.me, view: s.view, setView: s.setView, livePaused: s.livePaused, toggleLive: s.toggleLive, switchRole: s.switchRole })));
  const { resolvedTheme, setTheme } = useTheme();
  const t = useT();
  const tFmt = useTF();
  const [query, setQuery] = useState("");

  const role = me?.role ?? "READONLY";
  const can = useCan();
  // Filter on `role` only: labels are rendered through `t()` at paint time, so a
  // language switch re-renders them without invalidating the memo (and `useT()`
  // returns a fresh function on every render, so depending on it would defeat
  // the memo entirely).
  const visibleNav = useMemo(
    () => NAV_ENTRIES.filter((n) => hasCapability(role, n.cap)),
    [role],
  );
  // The palette has three kinds of result — views, sites and alarms — and only
  // the first was capability-filtered. The other two navigated to views the
  // role may not open, and because the shell refuses to mount a view the role
  // lacks, pressing such a row did nothing at all: a listed site that cannot
  // be opened. Each group is now gated on the view it navigates to.
  const canView = useCanView();

  const navigate = useCallback((v: ViewKey) => {
    if (!canView(v)) return;
    setView(v);
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", v);
    router.replace(`/?${params.toString()}`, { scroll: false });
    onOpenChange(false);
  }, [router, searchParams, setView, onOpenChange, canView]);

  // Reset query when closed
  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => setQuery(""), 150);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Keyboard shortcut: Cmd/Ctrl+K to toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
      // Escape closes
      if (e.key === "Escape" && open) onOpenChange(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onOpenChange]);

  // Derived together from `snapshot` so the empty-array fallbacks keep a stable
  // identity: rebuilt on every render they would invalidate `filteredSites`
  // (and everything downstream) even when the data has not changed.
  const { sites, events } = useMemo(
    () => ({ sites: snapshot?.sites ?? [], events: snapshot?.events ?? [] }),
    [snapshot],
  );
  const filteredSites = useMemo(() => {
    if (!query.trim()) return sites.slice(0, 6);
    const q = query.toLowerCase();
    return sites.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.code.toLowerCase().includes(q) ||
      s.region.toLowerCase().includes(q) ||
      s.governorate.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [sites, query]);

  const recentAlarms = useMemo(() => {
    // EventItem carries `message` + a `meta` bag, not the alarm-shaped
    // title/subtitle/severity triple. Project the real fields onto the
    // display shape the "Recent Alarms" group below renders.
    // (Note: `Map` here would resolve to the lucide icon imported above, so
    // this uses a plain record instead of the Map constructor.)
    const siteNameById: Record<string, string> = Object.fromEntries(
      sites.map((s) => [s.id, s.name]),
    );
    return events
      .filter((e) => e.kind === "alarm")
      .slice(0, 6)
      .map((e) => ({
        id: e.id,
        title: e.message,
        subtitle: siteNameById[e.siteId] ?? e.siteId,
        severity: typeof e.meta?.severity === "string" ? e.meta.severity : "",
      }));
  }, [events, sites]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder={t("common.searchPlaceholder")}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>{t("common.noResults")}</CommandEmpty>

        {/* Quick actions */}
        <CommandGroup heading={t("cmdpal.quickActions")}>
          <CommandItem onSelect={() => { toggleLive(); onOpenChange(false); }} className="gap-2">
            {livePaused ? <Play className="h-4 w-4 text-emerald-500" /> : <Pause className="h-4 w-4 text-amber-500" />}
            <span>{livePaused ? t("cmdpal.resumeLive") : t("cmdpal.pauseLive")}</span>
            <CommandShortcut>Space</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => { setTheme(resolvedTheme === "dark" ? "light" : "dark"); onOpenChange(false); }} className="gap-2">
            {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            <span>{t("common.toggleTheme")} {resolvedTheme === "dark" ? "light" : "dark"}</span>
            <CommandShortcut>⌘ J</CommandShortcut>
          </CommandItem>
          {/* Previewing a role is POST /api/fgmp/me/preview-role, which requires
              `role:preview` (and, server-side, a permanent ADMIN). The list used
              to render for anyone whose `me.roles` had two entries; every press
              then 403'd. A control that cannot succeed is not rendered. */}
          {me && can("role:preview") && Array.isArray(me.roles) && me.roles.length > 1 && (
            <>
              <CommandSeparator />
              {me.roles.map((r) => (
                <CommandItem
                  key={r}
                  onSelect={() => {
                    switchRole(r).catch(() => {
                      toast.error(t("auth.invalidCredentials"));
                    });
                    onOpenChange(false);
                  }}
                  className="gap-2"
                >
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  <span>{t("common.switchRole")} {r.replace(/_/g, " ")}</span>
                  {r === role && <CommandShortcut>{t("cmdpal.current")}</CommandShortcut>}
                </CommandItem>
              ))}
            </>
          )}
        </CommandGroup>

        <CommandSeparator />

        {/* Navigation */}
        <CommandGroup heading={t("cmdpal.navigate")}>
          {visibleNav.map((item) => {
            const Icon = ICONS[item.key];
            const active = view === item.key;
            const label = t(item.tKey);
            return (
              <CommandItem
                key={item.key}
                value={`go ${label}`}
                onSelect={() => navigate(item.key)}
                className="gap-2"
              >
                <Icon className={`h-4 w-4 ${active ? "text-primary" : "text-muted-foreground"}`} />
                <span>{t("common.goTo")} {label}</span>
                {active && <CommandShortcut>{t("cmdpal.current")}</CommandShortcut>}
                {!active && item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
              </CommandItem>
            );
          })}
        </CommandGroup>

        {/* Site search — every row navigates to the Sites view, so it is shown
            only to a role that may open Sites. */}
        {canView("sites") && filteredSites.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={query.trim() ? tFmt("cmdpal.sitesMatching", { q: query }) : t("cmdpal.sites")}>
              {filteredSites.map((s) => (
                <CommandItem
                  key={s.id}
                  value={`site ${s.name} ${s.code} ${s.region} ${s.governorate}`}
                  onSelect={() => { navigate("sites"); }}
                  className="gap-2"
                >
                  <MapPin className={`h-4 w-4 shrink-0 ${s.status === "ONLINE" ? "text-emerald-500" : s.status === "DEGRADED" ? "text-amber-500" : "text-rose-500"}`} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{s.name}</span>
                    <span className="truncate text-[10px] text-muted-foreground">{s.code} · {s.governorate}, {s.region}</span>
                  </div>
                  <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium">{s.status}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {/* Recent alarms — same rule: the row exists to open the Alarms view. */}
        {canView("alarms") && recentAlarms.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("cmdpal.recentAlarms")}>
              {recentAlarms.map((e, i) => (
                <CommandItem
                  key={`${e.id}-${i}`}
                  value={`alarm ${e.title} ${e.subtitle}`}
                  onSelect={() => navigate("alarms")}
                  className="gap-2"
                >
                  <AlertTriangle className={`h-4 w-4 shrink-0 ${e.severity === "L3" ? "text-rose-500" : e.severity === "L2" ? "text-amber-500" : "text-sky-500"}`} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{e.title}</span>
                    <span className="truncate text-[10px] text-muted-foreground">{e.subtitle}</span>
                  </div>
                  <span className="shrink-0 text-[10px] font-bold">{e.severity}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading={t("cmdpal.help")}>
          <CommandItem onSelect={() => onOpenChange(false)} className="gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">{t("common.openPalette")}</span>
            <CornerDownLeft className="ml-auto h-3 w-3 text-muted-foreground" />
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
