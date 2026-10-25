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
import { useTheme } from "next-themes";
import { useT } from "@/lib/fgmp/use-language";
import { toast } from "sonner";

const NAV_ITEMS: { key: ViewKey; label: string; icon: LucideIcon; cap: string; group: string; shortcut?: string }[] = [
  { key: "dashboard", label: "NOC Dashboard", icon: LayoutDashboard, cap: "view:dashboard", group: "Operations", shortcut: "G D" },
  { key: "sites", label: "Site Management", icon: Building2, cap: "view:sites", group: "Operations", shortcut: "G S" },
  { key: "fuel", label: "Fuel Monitoring", icon: Droplet, cap: "view:fuel", group: "Monitoring", shortcut: "G F" },
  { key: "generators", label: "Generators", icon: Zap, cap: "view:generators", group: "Monitoring", shortcut: "G G" },
  { key: "batteries", label: "Batteries", icon: BatteryCharging, cap: "view:batteries", group: "Monitoring", shortcut: "G B" },
  { key: "alarms", label: "Alarm Management", icon: Siren, cap: "view:alarms", group: "Monitoring", shortcut: "G A" },
  { key: "inventory", label: "Inventory & Supply", icon: Truck, cap: "view:inventory", group: "Logistics", shortcut: "G I" },
  { key: "iot", label: "IoT Devices", icon: Cpu, cap: "view:iot", group: "Logistics", shortcut: "G O" },
  { key: "maintenance", label: "Maintenance", icon: Wrench, cap: "view:maintenance", group: "Logistics", shortcut: "G M" },
  { key: "dispensers", label: "Fuel Dispensers", icon: Fuel, cap: "view:dispensers", group: "Monitoring", shortcut: "G P" },
  { key: "edge-firmware", label: "Edge & Firmware", icon: HardDrive, cap: "view:edge-firmware", group: "Monitoring", shortcut: "G E" },
  { key: "asset-registry", label: "Asset Registry", icon: Layers, cap: "view:asset-registry", group: "Logistics", shortcut: "G R" },
  { key: "analytics", label: "Analytics", icon: TrendingUp, cap: "view:analytics", group: "Insights", shortcut: "G N" },
  { key: "fuel-forecast", label: "Fuel Forecast", icon: GitBranch, cap: "view:fuel-forecast", group: "Insights", shortcut: "G C" },
  { key: "consumption-patterns", label: "Consumption Patterns", icon: BarChart3, cap: "view:consumption-patterns", group: "Insights", shortcut: "G X" },
  { key: "reports", label: "Reports", icon: FileText, cap: "view:reports", group: "Insights", shortcut: "G R" },
  { key: "tenants", label: "Tenants", icon: Building2, cap: "view:tenants", group: "Administration", shortcut: "G T" },
  { key: "geography", label: "Geography", icon: Map, cap: "view:geography", group: "Administration", shortcut: "G Y" },
  { key: "roles", label: "Roles & Permissions", icon: ShieldCheck, cap: "view:roles", group: "Administration", shortcut: "G L" },
  { key: "system-settings", label: "System Settings", icon: Settings, cap: "view:system-settings", group: "Administration", shortcut: "G ," },
  { key: "api-keys", label: "API Keys", icon: KeyRound, cap: "view:api-keys", group: "Administration", shortcut: "G K" },
  { key: "audit", label: "Audit Log", icon: ScrollText, cap: "view:audit", group: "Insights", shortcut: "G U" },
];

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
  const [query, setQuery] = useState("");

  const role = me?.role ?? "READONLY";
  const visibleNav = useMemo(() => NAV_ITEMS.filter((n) => hasCapability(role, n.cap)), [role]);

  const navigate = useCallback((v: ViewKey) => {
    if (!hasCapability(role, `view:${v}`)) return;
    setView(v);
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", v);
    router.replace(`/?${params.toString()}`, { scroll: false });
    onOpenChange(false);
  }, [router, searchParams, setView, onOpenChange, role]);

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
            <span>{livePaused ? "Resume live telemetry feed" : "Pause live telemetry feed"}</span>
            <CommandShortcut>Space</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => { setTheme(resolvedTheme === "dark" ? "light" : "dark"); onOpenChange(false); }} className="gap-2">
            {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            <span>{t("common.toggleTheme")} {resolvedTheme === "dark" ? "light" : "dark"}</span>
            <CommandShortcut>⌘ J</CommandShortcut>
          </CommandItem>
          {me && Array.isArray(me.roles) && me.roles.length > 1 && (
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
                  {r === role && <CommandShortcut>current</CommandShortcut>}
                </CommandItem>
              ))}
            </>
          )}
        </CommandGroup>

        <CommandSeparator />

        {/* Navigation */}
        <CommandGroup heading={t("cmdpal.navigate")}>
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = view === item.key;
            return (
              <CommandItem
                key={item.key}
                value={`go ${item.label}`}
                onSelect={() => navigate(item.key)}
                className="gap-2"
              >
                <Icon className={`h-4 w-4 ${active ? "text-primary" : "text-muted-foreground"}`} />
                <span>{t("common.goTo")} {item.label}</span>
                {active && <CommandShortcut>current</CommandShortcut>}
                {!active && item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
              </CommandItem>
            );
          })}
        </CommandGroup>

        {/* Site search */}
        {filteredSites.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={query.trim() ? `Sites matching "${query}"` : "Sites"}>
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
                  <span className="shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-medium">{s.status}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {/* Recent alarms */}
        {recentAlarms.length > 0 && (
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
                  <span className="shrink-0 text-[9px] font-bold">{e.severity}</span>
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
