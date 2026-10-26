"use client";

import { memo, useEffect, useMemo, useRef, type ComponentType } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  LayoutDashboard, Building2, Droplet, Zap, BatteryCharging, Siren,
  Truck, TrendingUp, FileText, Cpu, Wrench, ScrollText, Fuel, Users,
  Pause, Play, Activity, ShieldCheck, Radio, Command, Search, Keyboard,
  Loader2, LogOut, ShieldOff, Bell,
  HardDrive, GitBranch, BarChart3, Map, KeyRound,
  Settings, Layers, Menu,
} from "lucide-react";
import { useSession, signOut } from "next-auth/react";
import { toast } from "sonner";
import { useFgmp, type ViewKey, type Me } from "@/lib/fgmp/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useTheme } from "next-themes";
import { useState } from "react";
import { hasCapability, isSuperAdmin, ROLE_PERMISSIONS } from "@/lib/fgmp/rbac-core";
import { nextRoleAnnouncement } from "@/lib/fgmp/role-announcement";
import { NAV_ENTRIES, NAV_GROUPS, type NavEntry, type NavGroupId } from "@/lib/fgmp/navigation";
import { PREVIEW_ROLES } from "@/lib/fgmp/role-preview-constants";
import type { Role } from "@/lib/fgmp/types";
import dynamic from "next/dynamic";

// LoginDialog drags react-hook-form + zod + @hookform/resolvers into the graph.
// It is only mounted for an unauthenticated session, so lazy-load it instead of
// shipping those deps in the first-load chunk.
const LoginDialog = dynamic(
  () => import("@/components/fgmp/auth/login-dialog").then((m) => ({ default: m.LoginDialog })),
  { ssr: false },
);
// ── All views are lazy-loaded (dynamic imports) ──────────────────────────
// Each view is a separate chunk compiled on demand. This keeps the initial
// / page compilation light (only app-shell + the active view compile) and
// prevents the OOM killer from triggering when all 27 views compile at once.
const ViewLoader = () => (
  <div className="flex min-h-[400px] items-center justify-center">
    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
  </div>
);
// The views take no props (they read the store), so the loader contract is a
// component with none — written out rather than `any`, which would let a
// renamed or prop-taking export slip past the type gate.
const dyn = (imp: () => Promise<{ default: ComponentType<Record<string, never>> }>) =>
  dynamic(imp, { loading: ViewLoader, ssr: false });
const DashboardView = dyn(() => import("@/components/fgmp/views/dashboard-view").then(m => ({ default: m.DashboardView })));
const SitesView = dyn(() => import("@/components/fgmp/views/sites-view").then(m => ({ default: m.SitesView })));
const FuelView = dyn(() => import("@/components/fgmp/views/fuel-view").then(m => ({ default: m.FuelView })));
const GeneratorsView = dyn(() => import("@/components/fgmp/views/generators-view").then(m => ({ default: m.GeneratorsView })));
const BatteriesView = dyn(() => import("@/components/fgmp/views/batteries-view").then(m => ({ default: m.BatteriesView })));
const AlarmsView = dyn(() => import("@/components/fgmp/views/alarms-view").then(m => ({ default: m.AlarmsView })));
const InventoryView = dyn(() => import("@/components/fgmp/views/inventory-view").then(m => ({ default: m.InventoryView })));
const AnalyticsView = dyn(() => import("@/components/fgmp/views/analytics-view").then(m => ({ default: m.AnalyticsView })));
const ReportsView = dyn(() => import("@/components/fgmp/views/reports-view").then(m => ({ default: m.ReportsView })));
const IotView = dyn(() => import("@/components/fgmp/views/iot-view").then(m => ({ default: m.IotView })));
const MaintenanceView = dyn(() => import("@/components/fgmp/views/maintenance-view").then(m => ({ default: m.MaintenanceView })));
const AuditView = dyn(() => import("@/components/fgmp/views/audit-view").then(m => ({ default: m.AuditView })));
const UsersView = dyn(() => import("@/components/fgmp/views/users-view").then(m => ({ default: m.UsersView })));
const SystemHealthView = dyn(() => import("@/components/fgmp/views/system-health-view").then(m => ({ default: m.SystemHealthView })));
const SuppressionsView = dyn(() => import("@/components/fgmp/views/suppressions-view").then(m => ({ default: m.SuppressionsView })));
const PreferencesView = dyn(() => import("@/components/fgmp/views/preferences-view").then(m => ({ default: m.PreferencesView })));
const DispensersView = dyn(() => import("@/components/fgmp/views/dispensers-view").then(m => ({ default: m.DispensersView })));
const AssetRegistryView = dyn(() => import("@/components/fgmp/views/asset-registry-view").then(m => ({ default: m.AssetRegistryView })));
const EdgeFirmwareView = dyn(() => import("@/components/fgmp/views/edge-firmware-view").then(m => ({ default: m.EdgeFirmwareView })));
const FuelForecastView = dyn(() => import("@/components/fgmp/views/fuel-forecast-view").then(m => ({ default: m.FuelForecastView })));
const ConsumptionPatternsView = dyn(() => import("@/components/fgmp/views/consumption-patterns-view").then(m => ({ default: m.ConsumptionPatternsView })));
const TenantsView = dyn(() => import("@/components/fgmp/views/tenants-view").then(m => ({ default: m.TenantsView })));
const GeographyView = dyn(() => import("@/components/fgmp/views/geography-view").then(m => ({ default: m.GeographyView })));
const RolesView = dyn(() => import("@/components/fgmp/views/roles-view").then(m => ({ default: m.RolesView })));
const SystemSettingsView = dyn(() => import("@/components/fgmp/views/system-settings-view").then(m => ({ default: m.SystemSettingsView })));
const ApiKeysView = dyn(() => import("@/components/fgmp/views/api-keys-view").then(m => ({ default: m.ApiKeysView })));
const TenantIsolationView = dyn(() => import("@/components/fgmp/views/tenant-isolation-view").then(m => ({ default: m.TenantIsolationView })));

import { CommandPalette } from "@/components/fgmp/command-palette";
import { NotificationCenter } from "@/components/fgmp/notification-center";
import { KeyboardHelpDialog } from "@/components/fgmp/keyboard-help-dialog";
import { MiniStatusIndicator } from "@/components/fgmp/mini-status-indicator";
import { SystemHealthIndicator } from "@/components/fgmp/system-health-indicator";
import { PinnedSitesWidget } from "@/components/fgmp/pinned-sites-widget";
import { QuickAccessPopover } from "@/components/fgmp/quick-access-popover";
import { HeaderOverflowMenu } from "@/components/fgmp/header-overflow-menu";
import { ThemeSwitcher } from "@/components/fgmp/theme-switcher";
import { LanguageSwitcher } from "@/components/fgmp/language-switcher";
import { SupportSessionBanner } from "@/components/fgmp/support-session-banner";
import { useKeyboardShortcuts } from "@/lib/fgmp/use-keyboard-shortcuts";
import { useRealtime } from "@/lib/fgmp/use-realtime";
import { useT, useTF, useLanguageHydration, useDir, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";

// Nav items use i18n keys; the label rendered is `t(tKey)`. The LIST itself is
// not defined here — it lives in `@/lib/fgmp/navigation`, because the command
// palette carried a second, shorter copy of it and the two had drifted apart
// (28 entries here, 22 there: suppressions, users, system-health,
// tenant-isolation and preferences were unreachable from the palette). Icons
// stay in this file: they are presentation, not policy.
const NAV_ICONS: Record<ViewKey, typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  sites: Building2,
  fuel: Droplet,
  dispensers: Fuel,
  "edge-firmware": HardDrive,
  generators: Zap,
  batteries: BatteryCharging,
  alarms: Siren,
  suppressions: ShieldOff,
  "asset-registry": Layers,
  inventory: Truck,
  iot: Cpu,
  maintenance: Wrench,
  analytics: TrendingUp,
  "fuel-forecast": GitBranch,
  "consumption-patterns": BarChart3,
  reports: FileText,
  audit: ScrollText,
  users: Users,
  tenants: Building2,
  geography: Map,
  roles: ShieldCheck,
  "system-settings": Settings,
  "api-keys": KeyRound,
  "system-health": Activity,
  "tenant-isolation": ShieldCheck,
  preferences: Bell,
};

const GROUP_TKEYS: Record<NavGroupId, string> = Object.fromEntries(
  NAV_GROUPS.map((g) => [g.id, g.tKey]),
) as Record<NavGroupId, string>;

type ShellNavEntry = NavEntry & { icon: typeof LayoutDashboard; groupTKey: string };

const NAV: ShellNavEntry[] = NAV_ENTRIES.map((e) => ({
  ...e,
  icon: NAV_ICONS[e.key],
  groupTKey: GROUP_TKEYS[e.group],
}));

// `dyn()` returns `ComponentType` (next/dynamic with ssr:false), which under
// React 19 types returns ReactNode rather than ReactElement — so the previous
// `() => React.ReactElement` annotation rejected all 28 entries.
const VIEW_COMPONENTS: Record<ViewKey, React.ComponentType> = {
  dashboard: DashboardView,
  sites: SitesView,
  fuel: FuelView,
  generators: GeneratorsView,
  batteries: BatteriesView,
  alarms: AlarmsView,
  inventory: InventoryView,
  analytics: AnalyticsView,
  reports: ReportsView,
  iot: IotView,
  maintenance: MaintenanceView,
  audit: AuditView,
  users: UsersView,
  "system-health": SystemHealthView,
  suppressions: SuppressionsView,
  preferences: PreferencesView,
  dispensers: DispensersView,
  "asset-registry": AssetRegistryView,
  "edge-firmware": EdgeFirmwareView,
  "fuel-forecast": FuelForecastView,
  "consumption-patterns": ConsumptionPatternsView,
  tenants: TenantsView,
  geography: GeographyView,
  roles: RolesView,
  "system-settings": SystemSettingsView,
  "api-keys": ApiKeysView,
  "tenant-isolation": TenantIsolationView,
};

export function AppShell() {
  const t = useT();
  const dir = useDir();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const router = useRouter();
  const searchParams = useSearchParams();
  // ── NextAuth session (Task 31-A) ────────────────────────────────────────
  // The session is the single source of truth for the authenticated user.
  // We mirror it into the Zustand store (setMe) so existing consumers that
  // read `me` from useFgmp() keep working unchanged.
  const { data: session, status } = useSession();
  const sessionUser = session?.user;
  // Subscribe to individual slices rather than the whole store: `useFgmp()`
  // with no selector re-renders AppShell — and therefore the sidebar, the KPI
  // chips and the view host — on EVERY store write, including the 5s snapshot
  // poll that replaces `snapshot` wholesale.
  const init = useFgmp((s) => s.init);
  const snapshot = useFgmp((s) => s.snapshot);
  const me = useFgmp((s) => s.me);
  const setMe = useFgmp((s) => s.setMe);
  const view = useFgmp((s) => s.view);
  const setView = useFgmp((s) => s.setView);
  const refresh = useFgmp((s) => s.refresh);
  const livePaused = useFgmp((s) => s.livePaused);
  const toggleLive = useFgmp((s) => s.toggleLive);
  const switchRole = useFgmp((s) => s.switchRole);
  const returnToPermanentRole = useFgmp((s) => s.returnToPermanentRole);
  const lastTickAt = useFgmp((s) => s.lastTickAt);
  // Realtime (hosted Apinator channels). When livePaused, suspend the socket
  // so "Pause live" halts BOTH the polling refresh and the event push.
  const { connected: rtConnected } = useRealtime({ enabled: !livePaused && status === "authenticated" });
  const { setTheme, theme } = useTheme();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Announced role changes (D-09) ───────────────────────────────────────
  // A role change silently rewrites the navigation and every permission-gated
  // control. A sighted operator notices the menu shrink; a screen-reader user
  // gets nothing, and the panel they were using may have just vanished
  // underneath them. The live region below announces it once.
  const tFmt = useTF();
  const [roleAnnouncement, setRoleAnnouncement] = useState("");
  const announcedRoleRef = useRef<string | null>(null);

  // i18n hydration (call once near top of client tree).
  useLanguageHydration();

  // ── Auth-gated bootstrap (Task 31-A) ────────────────────────────────────
  // Only seed the engine + start polling once we have an authenticated
  // session. Unauthenticated/loading users see a LoginDialog / spinner
  // instead of the app shell.
  //
  // `me` is in the dependency list because the store now refuses to fetch
  // `/api/fgmp/state` for an identity it does not know (see store.loadState).
  // These two effects run in declaration order, so on a fresh sign-in this one
  // fires while `me` is still null; it must run AGAIN once the effect below has
  // established the identity, or the dashboard would never receive a snapshot.
  useEffect(() => {
    if (status === "authenticated" && me) init();
  }, [init, status, me]);

  // Announce a role change, and only a CHANGE. The first resolution of the
  // identity is the sign-in itself — the operator knows what they just did, and
  // announcing it would talk over the app's own "signed in" state. Keyed on the
  // role, not on `me`, so a refetch that returns the same role stays silent.
  useEffect(() => {
    const next = nextRoleAnnouncement(announcedRoleRef.current, me?.role);
    announcedRoleRef.current = next.previous;
    if (!next.changed || !me?.role) return;
    const roleKey = `role.${me.role.toLowerCase()}`;
    const translated = t(roleKey);
    setRoleAnnouncement(
      tFmt("auth.roleChanged", {
        role: translated === roleKey ? me.role.replace(/_/g, " ") : translated,
      }),
    );
  }, [me?.role, t, tFmt]);

  // Push the session user into the Zustand store so legacy consumers
  // (command-palette, site-notes-panel, users-view, …) keep reading `me`
  // from useFgmp() without needing to know about NextAuth.
  useEffect(() => {
    if (status !== "authenticated" || !sessionUser) {
      setMe(null);
      return;
    }
    const role = (sessionUser.role as Role) ?? "READONLY";
    const derivedMe: Me = {
      id: sessionUser.id,
      name: sessionUser.name,
      email: sessionUser.email,
      role,
      // A PENDING MFA session deliberately carries no tenant. Rather than
      // fabricating "" — which would produce a `Me` that LOOKS scoped and
      // matches no rows — leave it unset and let the guard refuse the request.
      // The client is redirected to the challenge anyway.
      ...(sessionUser.tenantId ? { tenantId: sessionUser.tenantId } : { tenantId: undefined as unknown as string }),
      // Whoever holds `role:preview` can preview the six tenant roles of
      // the proposal's switcher (§8.16) — the same capability POST
      // /api/fgmp/me/preview-role enforces. For everyone else we expose just
      // their own role so the switcher renders as a read-only badge rather than
      // a dropdown whose every option the server would refuse.
      roles: hasCapability(role, "role:preview") ? PREVIEW_ROLES : [role],
      permissions: ROLE_PERMISSIONS[role],
    };
    setMe(derivedMe);
    // Reconcile with the server envelope: a role preview
    // survives a reload via its cookie, and the effective
    // role/permissions must match what the API enforces.
    fetch("/api/fgmp/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((serverMe) => { if (serverMe) setMe(serverMe); })
      .catch(() => { /* keep the session-derived envelope */ });
  }, [sessionUser, status, setMe]);

  // Role preview (proposal §8.16): the overlay lives in a
  // signed httpOnly cookie read by requireAuth() on the server.
  // The session/JWT role is the PERMANENT role and is never
  // rewritten, so a re-login automatically returns to it.

  // Data refresh — READ ONLY.
  //
  // Phase 2 removed the request-driven `POST /api/fgmp/tick` from this loop.
  // It used to fire every 5s for every operator whose socket was down, which
  // meant the BROWSER was driving the telemetry clock: open the dashboard and
  // the platform advanced, close it and time stopped. That is request-driven
  // state mutation — two operators watching the same site advanced it twice as
  // fast, and an idle platform stopped generating data entirely.
  //
  // The clock is now the server's alone (`ensureScheduler()`, wired at startup).
  // What remains here is a plain read of current state, so a disconnected or
  // read-only session still refreshes its own dashboard. It cannot advance
  // anything, and it is the same `refresh()` for every role.
  //
  // Apinator events refresh state immediately. A slow safety reconciliation
  // remains in place if a push is missed: 60s while the private channel is
  // subscribed, 30s while disconnected. The old unconditional 5s setInterval
  // kept queuing /state calls while the prior DB request was still running,
  // which exhausted the hosted database's 15-connection allowance.
  useEffect(() => {
    if (status !== "authenticated" || !sessionUser || livePaused) {
      if (pollRef.current) clearTimeout(pollRef.current);
      pollRef.current = null;
      return;
    }

    let cancelled = false;
    let delayMs = rtConnected ? 60_000 : 30_000;

    const schedule = () => {
      if (cancelled) return;
      pollRef.current = setTimeout(() => void poll(), delayMs);
    };
    const poll = async () => {
      pollRef.current = null;
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        schedule();
        return;
      }
      await refresh();
      if (cancelled) return;
      delayMs = useFgmp.getState().error
        ? Math.min(Math.max(delayMs * 2, 30_000), 120_000)
        : rtConnected
          ? 60_000
          : 30_000;
      schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || cancelled) return;
      if (pollRef.current) clearTimeout(pollRef.current);
      pollRef.current = setTimeout(() => void poll(), 250);
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
      pollRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh, livePaused, status, sessionUser, rtConnected]);

  // clock lives in <HeaderClock/> (own state) so the 1Hz tick does not
  // re-render AppShell — and therefore the whole view tree — every second.

  const role = me?.role ?? "READONLY";


  // URL parameters, keyboard shortcuts and child components are all untrusted
  // navigation inputs. Never mount a view unless the effective role has its
  // view capability.
  //
  // A denied URL is NOT silently rewritten to the dashboard. It stays in the
  // address bar and the content area explains the refusal, because (a) an
  // operator who was sent a link deserves to know a permission denied, not
  // that the app "went somewhere else", and (b) the URL a colleague with the
  // right role needs is the one that was typed. Security is unchanged either
  // way: the view component is never mounted, and the API endpoints behind it
  // enforce the same matrix server-side.
  //
  // Derived during render instead of stored: a denial is a function of
  // (session, effective role, URL), and keeping a copy in state meant the
  // effect had to write state on every navigation — the exact pattern that
  // desynchronises a URL from what is on screen.
  const requestedView = searchParams.get("view") as ViewKey | null;
  const deniedView: ViewKey | null =
    me && requestedView && VIEW_COMPONENTS[requestedView] && !hasCapability(role, `view:${requestedView}`)
      ? requestedView
      : null;

  useEffect(() => {
    if (!me) return; // Wait for the session-derived effective role.
    const requested = searchParams.get("view") as ViewKey | null;
    if (!requested || !VIEW_COMPONENTS[requested]) return;
    if (!hasCapability(role, `view:${requested}`)) return; // rendered as a refusal, never mounted
    if (requested !== view) setView(requested);
  }, [me, role, searchParams, view, setView]);

  const navigate = (v: ViewKey) => {
    if (!hasCapability(role, `view:${v}`)) return;
    setView(v);
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", v);
    // `push`, not `replace`: with `replace` the fifteen-hop trip through the
    // sidebar left no history at all, so Back left the application instead of
    // returning to the previous view. Denied URLs are still normalised with
    // `replace` in the effect above — that is a correction, not a navigation.
    router.push(`/?${params.toString()}`, { scroll: false });
    setMobileNavOpen(false);
  };

  // Global keyboard shortcuts
  useKeyboardShortcuts({
    onNavigate: navigate,
    onToggleLive: toggleLive,
    onOpenCommand: () => setCmdOpen(true),
    onToggleTheme: () => {
      const order: ("system" | "light" | "dark")[] = ["system", "light", "dark"];
      const current = (theme ?? "system") as "system" | "light" | "dark";
      const next = order[(order.indexOf(current) + 1) % order.length];
      setTheme(next);
    },
  });

  // Tenant registry and isolation views are platform-level surfaces; the
  // capability matrix grants `view:tenants` / `view:tenant-isolation` only
  // through SUPERADMIN's wildcard, so the capability filter alone is the
  // policy. It used to be restated here as a second role check — two copies of
  // one rule, which is how a nav entry and its view drift apart.
  const visibleNav = useMemo(
    () => NAV.filter((n) => hasCapability(role, n.cap)),
    [role],
  );
  const grouped = useMemo(() => {
    const m: Record<string, ShellNavEntry[]> = {};
    for (const n of visibleNav) (m[n.group] ??= []).push(n);
    return m;
  }, [visibleNav]);

  const k = snapshot?.kpis;
  const safeView = hasCapability(role, `view:${view}`) ? view : "dashboard";
  const ViewComponent = VIEW_COMPONENTS[safeView] ?? DashboardView;
  const hasSnapshot = snapshot !== null;
  const liveToggleLabel = livePaused ? t("common.paused") : t("common.live");

  // ── Auth gate (Task 31-A) ────────────────────────────────────────────────
  // While NextAuth resolves the session (server-side cookie round-trip) we
  // render a full-screen spinner. Unauthenticated users see the LoginDialog
  // and nothing else — every feature (including proposal download) requires
  // an authenticated session.
  if (status === "loading") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("auth.signingIn")}</p>
      </div>
    );
  }
  if (status === "unauthenticated" || !sessionUser) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-4">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md">
            <Fuel className="h-6 w-6" />
          </div>
          <div>
            <p className="text-lg font-bold tracking-tight">{t("brand.name")}</p>
            <p className="text-sm text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>{t("auth.requiresAuth")}</p>
          </div>
        </div>
        <LoginDialog
          open
          onSuccess={() => {
            // signIn({ redirect: false }) resolves as soon as the server has set
            // the cookie, but the <SessionProvider> around this tree keeps the
            // session it fetched at mount — which was "nobody". Nothing pushed
            // into it, so the dialog stayed on screen over a session that
            // existed. Observed in CI: six successful sign-ins in the server log
            // while the browser still showed the form.
            //
            // A full reload makes the server the authority on who is signed in,
            // and drops every piece of in-memory state belonging to the previous
            // identity (store snapshot, cached view, command history) — which is
            // the behaviour account switching needs anyway.
            window.location.reload();
          }}
        />
      </div>
    );
  }

  // ── Identity gate (D-1) ───────────────────────────────────────────────────
  // Reaching here means NextAuth has a session AND a session user. It does NOT
  // mean this component knows the EFFECTIVE identity: `me` is populated by the
  // effect above, which runs after this render. Without this gate the shell
  // paints one frame with `role = "READONLY"` over whatever `snapshot` the
  // previous identity left in the store — one tenant's data (or, for a former
  // SUPERADMIN, every tenant's) shown to the account that just signed in.
  //
  // `me?.role ?? "READONLY"` below is still the right fallback for a RESOLVED
  // identity whose role is somehow absent; it is not a stand-in for "not
  // resolved yet".
  if (!me) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("auth.signingIn")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Skip-to-content link — keyboard a11y (bypasses 27 nav items) */}
      <a href="#main-content" className="skip-link">{t("common.skipToContent")}</a>

      {/* Role-change announcement (D-09). `sr-only`, polite, and empty until a
          change happens: an always-populated live region is announced on every
          navigation and trains the user to ignore it. `aria-atomic` makes the
          reader deliver the whole sentence rather than the diff. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {roleAnnouncement}
      </div>

      {/* Platform support access banner. Renders nothing unless a support
          session is open; when one is, it is the only thing on the page that
          cannot be dismissed without ending the session. */}
      <SupportSessionBanner />

      {/* Top header */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex h-14 min-w-0 items-center gap-2 px-3 sm:px-4">
          {/* Mobile nav trigger */}
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger asChild>
              {/* A hamburger, not a chevron. `ChevronRight` on a left drawer reads as
                  "expand"/"next step" and, under RTL, points at the wrong edge
                  entirely — the one control a phone user needs to find the other
                  27 views was the least recognisable icon in the header. */}
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label={t("common.openNavigation")}
                title={t("common.openNavigation")}
              >
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side={dir === "rtl" ? "right" : "left"} className="w-72 p-0">
              {/* Radix dialogs have no accessible name without a title; the sheet
                  is a dialog, so the mobile navigation was announced as just
                  "dialog". Visually hidden, not omitted. */}
              <SheetTitle className="sr-only">{t("nav.primary")}</SheetTitle>
              <SidebarContent
                grouped={grouped}
                view={view}
                navigate={navigate}
                me={me}
                canSeeSites={hasCapability(role, "view:sites")}
              />
            </SheetContent>
          </Sheet>

          {/* Brand */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm">
              <Fuel className="h-5 w-5" />
            </div>
            <div className="hidden md:block">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold tracking-tight">{t("brand.name")}</span>
                {/* Identity badge, not an access gate: it says which role the
                    session holds, so a literal comparison is the correct test
                    here (via the shared helper rather than a bare string). */}
                {isSuperAdmin(role) && (
                  <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 text-[10px]">SUPER</Badge>
                )}
                <Badge variant="secondary" className="hidden h-4 px-1 text-[10px] font-medium md:inline-flex">v2.4</Badge>
              </div>
              <p className="text-[10px] leading-none text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>{t("brand.tagline")}</p>
            </div>
          </div>

          {/* Live status + KPI chips */}
          <div className="ml-2 hidden min-w-0 items-center gap-2 lg:flex">
            <div
              // Connection state is the one status an operator needs while
              // looking somewhere else on the page: "LIVE" silently becoming
              // "Reconnecting…" means the numbers on screen are frozen, and
              // nothing announced that.
              role="status"
              aria-live="polite"
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
                livePaused
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : rtConnected
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
              )}
              title={
                livePaused
                  ? t("common.paused")
                  : rtConnected
                    ? t("common.realtimeConnected")
                    : t("common.realtimeDisconnected")
              }
            >
              <Radio className={cn("h-3 w-3", !livePaused && rtConnected && "animate-pulse", !livePaused && !rtConnected && "animate-pulse")} />
              {livePaused
                ? t("common.paused")
                : rtConnected
                  ? t("common.live")
                  : t("common.reconnecting")}
            </div>
            {k && <MiniStatusIndicator kpis={k} />}
            {k && (
              <div className="hidden items-center gap-2 xl:flex">
                <KpiChip label={t("kpi.sites")} value={`${formatNumber(k.onlineSites, numLang)}/${formatNumber(k.totalSites, numLang)}`} tone="good" />
                <KpiChip label={t("kpi.alarms")} value={formatNumber(k.openAlarms, numLang)} tone={k.openAlarms > 0 ? "danger" : "good"} />
                <KpiChip label={t("kpi.fuel")} value={`${formatNumber(k.fuelPct, numLang)}%`} tone={k.fuelPct < 25 ? "danger" : "info"} />
                <KpiChip label={t("kpi.gens")} value={`${formatNumber(k.generatorsRunning, numLang)}/${formatNumber(k.generatorsTotal, numLang)}`} tone="info" />
              </div>
            )}
          </div>

          <div className="flex-1" />

          {/* Command palette trigger */}
          <button
            onClick={() => setCmdOpen(true)}
            className="hidden items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted lg:flex"
            title={t("common.search")}
            aria-label={t("common.search")}
          >
            <Search className="h-3.5 w-3.5" />
            <span>{t("common.search")}</span>
            <kbd className="ml-4 inline-flex items-center gap-0.5 rounded border bg-background px-1 py-0.5 text-[10px] font-medium" dir="ltr">
              <Command className="h-2.5 w-2.5" />K
            </kbd>
          </button>
          <Button variant="outline" size="icon" className="lg:hidden" onClick={() => setCmdOpen(true)} aria-label={t("common.search")} title={t("common.search")}>
            <Search className="h-4 w-4" />
          </Button>

          {/* Quick Access popover (#18) — pinned + recently-visited sites one
              click away. Mounted right after the global search so it reads as
              a "site jump" shortcut next to the cmd-K palette.
              `view:sites` only: every row in it opens a site. */}
          {hasCapability(role, "view:sites") && (
            <div className="hidden sm:flex">
              <QuickAccessPopover />
            </div>
          )}

          {/* Clock — self-contained so its 1Hz state never re-renders AppShell */}
          <HeaderClock />

          {/* Live System Health mini-indicator (Task 33-B)
              `view:system-health` only — a role without that capability cannot
              read /api/fgmp/health, so the widget would show "Checking…"
              forever for them. Gated on the capability rather than on the ADMIN
              role literal, which used to hide it from SUPERADMIN (the wildcard
              holder) while still offering the nav entry. */}
          {hasCapability(role, "view:system-health") && (
            <div className="hidden 2xl:block">
              <SystemHealthIndicator onClick={() => navigate("system-health")} />
            </div>
          )}

          {/* Notification center */}
          <NotificationCenter />

          {/* Live toggle — label from the same t() keys the adjacent status badge
              uses, so it stays correct in the Arabic locale. */}
          <Button variant="outline" size="icon" className="hidden lg:inline-flex" onClick={toggleLive} aria-label={liveToggleLabel} title={liveToggleLabel}>
            {livePaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </Button>

          {/* Theme switcher (System / Light / Dark) */}
          <div className="hidden lg:block">
            <ThemeSwitcher />
          </div>

          {/* Language switcher (EN / AR) */}
          <div className="hidden lg:block">
            <LanguageSwitcher />
          </div>

          {/* Keyboard shortcuts help */}
          <Button variant="outline" size="icon" className="hidden 2xl:inline-flex" onClick={() => setHelpOpen(true)} aria-label={t("common.keyboardShortcuts")} title={`${t("common.keyboardShortcuts")} (?)`}>
            <Keyboard className="h-4 w-4" />
          </Button>

          {/* Role preview switcher (proposal §8.16 — معاينة الأدوار
              وإعادة الضبط). ADMIN + SUPERADMIN may preview any of
              the six tenant roles. The preview is SESSION-SCOPED:
              it is served from a signed cookie overlay, the DB row
              is never written, and a re-login returns to the
              permanent role automatically. Non-admins see a
              read-only role badge (dropdown disabled). */}
          {me && (
            <>
              {/* العودة إلى مدير — Return to Admin. Amber, and
                  visible exactly while the effective role differs
                  from the permanent one. One click ends the
                  preview; no re-login is required. */}
              {me.previewRole && me.permanentRole && me.previewRole !== me.permanentRole && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-1.5 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 dark:text-amber-400"
                  onClick={() => {
                    returnToPermanentRole().catch(() => {
                      toast.error(t("auth.invalidCredentials"));
                    });
                  }}
                  aria-label={t("auth.returnToAdmin")}
                  title={t("auth.returnToAdminHint")}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {t("auth.returnToAdmin")}
                </Button>
              )}
              <div className="hidden items-center 2xl:flex">
              <Select label={t("users.role")}
                value={role}
                // `role:preview` is the capability POST /api/fgmp/me/preview-role
                // enforces. While a preview is active the effective role is the
                // previewed one (which may lack it), so the switcher must stay
                // enabled for the operator to switch again or leave.
                disabled={!hasCapability(role, "role:preview") && !me.previewRole}
                onValueChange={(v) => {
                  switchRole(v as typeof role).catch(() => {
                    toast.error(t("auth.invalidCredentials"));
                  });
                }}
              >
                <SelectTrigger className="h-9 w-[170px] gap-1 text-xs" aria-label={t("common.switchRole")}>
                  <ShieldCheck className={`h-3.5 w-3.5 ${me.previewRole ? "text-amber-500" : "text-emerald-500"}`} />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Array.isArray(me.roles)
                      ? me.roles
                      : typeof role === "string"
                        ? [role]
                        : []
                  ).map((r) => {
                    const roleKey = `role.${r.toLowerCase()}`;
                    const roleTr = t(roleKey);
                    const label = roleTr === roleKey ? r.replace(/_/g, " ") : roleTr;
                    return <SelectItem key={r} value={r} className="text-xs">{label}</SelectItem>;
                  })}
                </SelectContent>
              </Select>
              </div>
            </>
          )}

          {/* Overflow: the same actions as named items wherever the inline
              control above is hidden by a breakpoint (D-26). */}
          <HeaderOverflowMenu
            kpis={k ?? null}
            livePaused={livePaused}
            onToggleLive={toggleLive}
            onOpenShortcuts={() => setHelpOpen(true)}
            onOpenSystemHealth={() => navigate("system-health")}
            role={role}
            roles={Array.isArray(me?.roles) && me.roles.length > 0 ? me.roles : role ? [role] : []}
            onSwitchRole={(next) => {
              switchRole(next).catch(() => {
                toast.error(t("auth.invalidCredentials"));
              });
            }}
          />

          {/* Sign out (Task 31-A) */}
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              signOut({ redirect: false });
              toast.success(t("auth.logoutSuccess"));
            }}
            aria-label={t("auth.signOut")}
            title={t("auth.signOut")}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* Body: sidebar + content */}
      <div className="flex flex-1">
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 border-r bg-card/40 lg:block">
          <SidebarContent
            grouped={grouped}
            view={view}
            navigate={navigate}
            me={me}
            canSeeSites={hasCapability(role, "view:sites")}
          />
        </aside>

        <main id="main-content" className="flex min-w-0 flex-1 flex-col" tabIndex={-1}>
          <div className="flex-1 px-3 py-4 sm:px-5 sm:py-6">
            <div className="mx-auto max-w-[1600px]">
              {deniedView ? (
                <AccessDeniedPanel view={deniedView} role={role} onBack={() => navigate("dashboard")} />
              ) : (
                <ViewHost Component={ViewComponent} hasSnapshot={hasSnapshot} />
              )}
            </div>
          </div>

          {/* Sticky footer */}
          <footer className="mt-auto border-t bg-card/40">
            <div className="mx-auto flex max-w-[1600px] flex-col gap-1 px-4 py-3 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-foreground">{t("brand.name")}</span>
                <span dir={dir === "rtl" ? "rtl" : undefined}>· {t("brand.tenant")}</span>
                <span className="hidden sm:inline">· {t("brand.tenant")}: <span className="font-mono">{t("brand.tenantCode")}</span></span>
                {/* Real counts from the snapshot. These were hardcoded to
                    "52 sites · 84 tanks · 76 generators" regardless of data. */}
                {k && (
                  <span className="hidden md:inline" dir={dir === "rtl" ? "rtl" : undefined}>
                    · {formatNumber(k.totalSites, numLang)} {t("footer.sites")} · {formatNumber(k.totalTanks, numLang)} {t("footer.tanks")} · {formatNumber(k.generatorsTotal, numLang)} {t("footer.generators")}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3 text-emerald-500" /> {t("footer.security")}</span>
                {lastTickAt > 0 && (
                  <span className="flex items-center gap-1.5 font-mono" dir="ltr" title={t("common.livePolling")}>
                    {!livePaused && rtConnected && (
                      <span className="relative flex h-2 w-2" aria-hidden="true">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                      </span>
                    )}
                    {t("footer.tick")} {new Date(lastTickAt).toLocaleTimeString("en-GB", { hour12: false })}
                  </span>
                )}
              </div>
            </div>
          </footer>
        </main>
      </div>

      {/* Command palette (Cmd+K) */}
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />

      {/* Keyboard shortcuts help dialog (?) */}
      <KeyboardHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

/**
 * The content shown when the URL asks for a view the effective role may not
 * open. Deliberately NOT an empty page or a silent redirect: it names the
 * screen that was refused, states the role that lacks it, and offers the one
 * navigation that is always allowed. The role name shown is the *effective*
 * role, so a Super Admin previewing a lesser role sees the preview's ceiling —
 * the same number the server uses.
 */
function AccessDeniedPanel({ view, role, onBack }: { view: ViewKey; role: string; onBack: () => void }) {
  const t = useT();
  const tFmt = useTF();
  const dir = useDir();
  const labelKey = NAV.find((n) => n.key === view)?.tKey ?? `nav.${view}`;
  const viewLabel = t(labelKey);
  const roleKey = `role.${role.toLowerCase()}`;
  const roleLabel = t(roleKey) === roleKey ? role.replace(/_/g, " ") : t(roleKey);
  return (
    <div
      role="alert"
      aria-labelledby="access-denied-title"
      className="mx-auto mt-6 flex max-w-lg flex-col items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 px-6 py-10 text-center"
      dir={dir === "rtl" ? "rtl" : undefined}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/10" aria-hidden="true">
        <ShieldOff className="h-6 w-6 text-rose-700 dark:text-rose-400" />
      </span>
      <h1 id="access-denied-title" className="text-lg font-semibold text-foreground">
        {t("access.deniedTitle")}
      </h1>
      <p className="text-sm text-muted-foreground">
        {tFmt("access.deniedBody", { view: viewLabel, role: roleLabel })}
      </p>
      <p className="font-mono text-xs text-muted-foreground" dir="ltr">{`view:${view}`}</p>
      <Button variant="outline" onClick={onBack} className="mt-1 gap-2">
        {t("access.deniedBack")}
      </Button>
    </div>
  );
}

function SidebarContent({ grouped, view, navigate, me, canSeeSites }: {
  grouped: Record<string, ShellNavEntry[]>;
  view: ViewKey;
  navigate: (v: ViewKey) => void;
  me: { name: string; role: string } | null;
  /** `view:sites` — the pinned-sites list is a list of links into that view. */
  canSeeSites: boolean;
}) {
  const t = useT();
  const dir = useDir();
  return (
    <div className="flex h-full flex-col">
      <nav aria-label={t("nav.primary")} className="flex-1 overflow-y-auto px-2 py-3">
        {Object.entries(grouped).map(([group, items]) => (
          <div key={group} className="mb-3">
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" dir={dir === "rtl" ? "rtl" : undefined}>
              {t(items[0].groupTKey)}
            </p>
            {items.map((item) => {
              const Icon = item.icon;
              const active = view === item.key;
              const descKey = `desc.${item.key}`;
              const desc = t(descKey);
              const hasDesc = desc && desc !== descKey;
              return (
                <a
                  key={item.key}
                  href={`/?view=${item.key}`}
                  onClick={(e) => {
                    // A real link, not a button: cmd/ctrl-click, middle-click and
                    // "open in new tab" now work, and the element announces itself
                    // as navigation rather than as a button.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    navigate(item.key);
                  }}
                  className={cn(
                    "group relative mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-all duration-150",
                    active
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    // Hover: slide the icon slightly right (translate-x-0.5).
                    "hover:translate-x-0",
                  )}
                  dir={dir === "rtl" ? "rtl" : undefined}
                  title={hasDesc ? `${t(item.tKey)} — ${desc}` : undefined}
                  aria-current={active ? "page" : undefined}
                >
                  {/* Active item: subtle left-border accent (3px) in the primary color.
                      RTL flips automatically via dir attribute + left/right auto. */}
                  {active && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-primary rtl:left-auto rtl:right-0"
                    />
                  )}
                  <Icon className={cn("h-4 w-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5", active && "text-primary")} />
                  <span className="truncate">{t(item.tKey)}</span>
                  {item.key === "alarms" && <AlarmCountBadge />}
                </a>
              );
            })}
          </div>
        ))}
      </nav>
      {/* Same rule as the header popover: a pinned-sites list is a list of
          links into the Sites view. */}
      {canSeeSites && (
        <div className="border-t px-2 py-2">
          <PinnedSitesWidget />
        </div>
      )}
      {me && (
        <div className="border-t p-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-slate-500 to-slate-700 text-xs font-bold text-white">
              {me.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{me.name}</p>
              <p className="truncate text-[10px] text-muted-foreground">
                {(() => {
                  const roleKey = `role.${me.role.toLowerCase()}`;
                  const roleTr = t(roleKey);
                  return roleTr === roleKey ? me.role.replace(/_/g, " ") : roleTr;
                })()}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AlarmCountBadge() {
  // Derived scalar selector: re-renders only when the count itself changes,
  // rather than on every unrelated store write.
  const n = useFgmp((s) => s.snapshot?.kpis.openAlarms ?? 0);
  const tFmt = useTF();
  if (n === 0) return null;
  // Refreshed badge style: rounded-full, min-width to center single/double
  // digits, subtle rose drop-shadow so the alarm count pops at a glance.
  return (
    <span
      className="ml-auto inline-flex min-w-[20px] items-center justify-center rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-rose-700 dark:text-rose-400 shadow-sm shadow-rose-500/20 dark:text-rose-400"
    >
      <span aria-hidden="true">{n}</span>
      {/* The visible digit alone would be read as "3" inside the nav link.
          The link's name is its text content, so the count needs a spoken
          form — localized, and hidden from the visual layout. */}
      <span className="sr-only">{tFmt("nav.openAlarms", { n })}</span>
    </span>
  );
}

function KpiChip({ label, value, tone }: { label: string; value: React.ReactNode; tone: "good" | "danger" | "info" | "warn" }) {
  const tones = {
    good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    danger: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
    info: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  };
  return (
    <div className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs", tones[tone])}>
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
      <span className="font-bold tabular-nums">{value}</span>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />)}
      </div>
      <div className="h-96 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}

/**
 * Header clock, isolated so its 1Hz tick only re-renders this leaf.
 *
 * It used to be `const [clock, setClock] = useState("")` in AppShell itself,
 * which meant every second AppShell re-rendered and pushed a new element tree
 * through the sidebar, the KPI chips and the active view — the dashboard alone
 * mounts a 577-line SVG map plus six recharts.
 */
function HeaderClock() {
  const [clock, setClock] = useState("");
  useEffect(() => {
    const update = () => {
      setClock(new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Aden" }) + " AST");
    };
    update();
    const i = setInterval(update, 1000);
    return () => clearInterval(i);
  }, []);
  return (
    // Peripheral: it has no place in the budget until the header is wide
    // (D-26). The overflow menu carries nothing that depends on it.
    <div className="hidden items-center gap-1.5 font-mono text-xs text-muted-foreground 2xl:flex">
      <Activity className="h-3.5 w-3.5" />
      <span className="tabular-nums">{clock}</span>
    </div>
  );
}

/**
 * Memoised host for the active view.
 *
 * Both props are stable: `Component` comes from the module-level
 * VIEW_COMPONENTS map (identity only changes when the user switches view) and
 * `hasSnapshot` is a boolean. Without this, any AppShell re-render re-rendered
 * the entire view subtree even though nothing it depends on had changed.
 *
 * The views still re-render themselves from their own Zustand subscriptions —
 * this only blocks re-renders that are pushed down from AppShell.
 */
const ViewHost = memo(function ViewHost({ Component, hasSnapshot }: {
  Component: React.ComponentType;
  hasSnapshot: boolean;
}) {
  return hasSnapshot ? <Component /> : <LoadingSkeleton />;
});
