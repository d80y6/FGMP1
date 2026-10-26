"use client";

/**
 * FGMP First-run Onboarding Checklist (#9)
 * ─────────────────────────────────────────────────────────────────────────
 * A dismissible setup card shown to users who can administer the tenant
 * (`view:users` — the capability behind the user list it needs) on the
 * dashboard when the platform has "empty" data — i.e., the operator has just installed FGMP
 * and hasn't yet added sites, generators, tanks, team members, or alarm
 * thresholds.
 *
 * Show conditions (all must be true):
 *  - the role holds `view:users` (only tenant administrators see the setup
 *    prompt; a role that cannot read the user list cannot finish item 4)
 *  - `snapshot` has loaded
 *  - The platform is "empty": < 3 sites, OR < 1 generator, OR < 1 tank,
 *    OR ≤ 1 user (i.e., only the admin themselves)
 *  - The user has not dismissed the card (localStorage
 *    `fgmp-onboarding-dismissed` = "true")
 *
 * The card shows a 6-item checklist with a progress bar at the top and a
 * "Dismiss" (×) button in the top-right corner. Each item has:
 *  - A circular checkbox (filled emerald when complete, slate ring when not)
 *  - A label
 *  - A "Go" button that navigates to the relevant view (sites, asset-registry,
 *    users, alarms, dashboard)
 *
 * Completion checks:
 *  1. Add your first site        → snapshot.sites.length >= 1
 *  2. Register a generator       → snapshot.generators.length >= 1
 *  3. Create a fuel tank         → snapshot.tanks.length >= 1
 *  4. Invite a team member       → users.length >= 2 (admin + 1 invitee)
 *     (snapshot has no `users` array; fetched separately from
 *     /api/fgmp/users — only fetched when the checklist is visible)
 *  5. Configure an alarm threshold → alarms.length >= 1 (proxy; any alarm in
 *     the system implies a threshold has triggered at some point). Falls
 *     back to a "visit alarm settings" manual link if no alarms exist.
 *  6. Review the dashboard       → visitedViews.length >= 3 distinct views
 *     (tracked via localStorage `fgmp-views-visited`, populated by the
 *     always-mounted <ViewVisitTracker /> in page.tsx)
 *
 * Architecture notes:
 *  - All user-facing strings come from `useT()` + the `onboarding.*`
 *    dictionary section (no hardcoded English).
 *  - Numerics (progress count, "X/6") use `formatNumber(n, numLang)` so
 *    Arabic-Indic digits render in AR mode.
 *  - localStorage reads use `useSyncExternalStore` (the React-recommended
 *    pattern for external stores) so the card re-renders when the
 *    `fgmp-onboarding-dismissed` flag or the `fgmp-views-visited` set
 *    changes from another component or tab. No `setState` is called inside
 *    `useEffect` (avoids the `react-hooks/set-state-in-effect` lint rule).
 *  - The "Go" buttons use `setView` from the FGMP store + `router.replace`
 *    to mirror AppShell's `navigate()` pattern — no full page reload, the
 *    URL updates, and the live snapshot state is preserved.
 *  - Color palette: emerald (complete / progress bar), amber (pending /
 *    in-progress), slate (neutral). No indigo/blue per project palette.
 */

import type React from "react";
import { useSyncExternalStore, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Building2,
  Zap,
  Droplet,
  Users,
  Bell,
  LayoutDashboard,
  X,
  Check,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useFgmp, type ViewKey } from "@/lib/fgmp/store";
import { hasCapability } from "@/lib/fgmp/rbac-core";
import { useCanView } from "@/lib/fgmp/use-access";
import { useApi } from "@/lib/fgmp/use-api";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";

const DISMISS_KEY = "fgmp-onboarding-dismissed";
const VIEWS_KEY = "fgmp-views-visited";

/* ── localStorage external store adapters ──────────────────────────── */

function subscribeOnboarding(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => cb();
  window.addEventListener("storage", handler);
  window.addEventListener("fgmp-onboarding-dismissed-changed", handler);
  return () => {
    window.removeEventListener("storage", handler);
    window.removeEventListener("fgmp-onboarding-dismissed-changed", handler);
  };
}

function getDismissedSnapshot(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function subscribeViews(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => cb();
  window.addEventListener("storage", handler);
  window.addEventListener("fgmp-views-visited-changed", handler);
  return () => {
    window.removeEventListener("storage", handler);
    window.removeEventListener("fgmp-views-visited-changed", handler);
  };
}

function getViewsRawSnapshot(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(VIEWS_KEY) ?? "";
  } catch {
    return "";
  }
}

function dismissOnboarding(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISS_KEY, "true");
    window.dispatchEvent(new CustomEvent("fgmp-onboarding-dismissed-changed"));
  } catch {
    /* ignore */
  }
}

/* ── Checklist item type ───────────────────────────────────────────── */

interface ChecklistItem {
  key: string;
  label: string;
  href: ViewKey;
  icon: React.ReactNode;
  complete: boolean;
}

/* ── Component ─────────────────────────────────────────────────────── */

export function OnboardingChecklist() {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const router = useRouter();
  const searchParams = useSearchParams();

  const { me, snapshot } = useFgmp(useShallow((s) => ({ me: s.me, snapshot: s.snapshot })));
  const role = me?.role;

  // Subscribe to localStorage flags so the card re-renders when the user
  // dismisses it (here or in another tab) or when ViewVisitTracker adds a
  // new view to the visited set.
  const dismissedRaw = useSyncExternalStore(
    subscribeOnboarding,
    getDismissedSnapshot,
    () => null,
  );
  const viewsRaw = useSyncExternalStore(
    subscribeViews,
    getViewsRawSnapshot,
    () => "",
  );

  const visitedViews = useMemo<string[]>(() => {
    if (!viewsRaw) return [];
    try {
      const parsed = JSON.parse(viewsRaw);
      return Array.isArray(parsed)
        ? parsed.filter((v) => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  }, [viewsRaw]);

  // The checklist is a setup prompt for whoever can administer the tenant —
  // `view:users`, the capability that reads /api/fgmp/users. Hooks remain
  // unconditional; a role without it passes null rather than issuing a request
  // the server would refuse.
  // `me` is null until the session envelope arrives, so `role` is
  // `Role | undefined` here — no session must mean "no user administration",
  // not a capability lookup on undefined.
  const canAdministerUsers = role ? hasCapability(role, "view:users") : false;
  // Each checklist row ends in a "Go" button that opens another view, so the
  // list is filtered to the destinations this role can actually reach. Today
  // every viewer holds all six (the card is `view:users`-gated), which is
  // exactly why the coupling went unnoticed — the next capability change would
  // have left a row pointing at a view the shell refuses to mount.
  const canView = useCanView();
  const { data: users } = useApi<unknown[]>(
    canAdministerUsers ? "/api/fgmp/users" : null,
    { interval: 30000 },
  );
  // Fetch a single alarm to check the "threshold configured" proxy. Using
  // limit=1 keeps the payload tiny.
  const { data: alarmsSample } = useApi<unknown[]>("/api/fgmp/alarms?limit=1", { interval: 30000 });

  // Show only to tenant administrators, and only with a loaded snapshot. We
  // don't early-return before the hooks above — hooks must run unconditionally.
  if (!canAdministerUsers || !snapshot) return null;

  const userCount = users?.length ?? 0;
  const alarmCount = alarmsSample?.length ?? 0;

  // Show condition: platform has "empty" data — at least one of these is true:
  // < 3 sites, OR < 1 generator, OR < 1 tank, OR ≤ 1 user (only the admin).
  // For the user count we wait until the user list has actually loaded,
  // otherwise the card would flash briefly while the fetch is in-flight
  // (null user list reads as count=0, which would falsely trigger the
  // "only admin" branch).
  const usersLoaded = users !== null;
  const platformIsEmpty =
    snapshot.sites.length < 3 ||
    snapshot.generators.length < 1 ||
    snapshot.tanks.length < 1 ||
    (usersLoaded && userCount <= 1);

  if (!platformIsEmpty) return null;
  if (dismissedRaw === "true") return null;

  const allItems: ChecklistItem[] = [
    {
      key: "site",
      label: t("onboarding.addItemSite"),
      href: "sites",
      icon: <Building2 className="h-4 w-4" />,
      complete: snapshot.sites.length >= 1,
    },
    {
      key: "generator",
      label: t("onboarding.addItemGenerator"),
      href: "asset-registry",
      icon: <Zap className="h-4 w-4" />,
      complete: snapshot.generators.length >= 1,
    },
    {
      key: "tank",
      label: t("onboarding.addItemTank"),
      href: "asset-registry",
      icon: <Droplet className="h-4 w-4" />,
      complete: snapshot.tanks.length >= 1,
    },
    {
      key: "user",
      label: t("onboarding.addItemUser"),
      href: "users",
      icon: <Users className="h-4 w-4" />,
      complete: userCount >= 2,
    },
    {
      key: "alarm",
      label: t("onboarding.addItemAlarm"),
      href: "alarms",
      icon: <Bell className="h-4 w-4" />,
      complete: alarmCount >= 1,
    },
    {
      key: "dashboard",
      label: t("onboarding.addItemDashboard"),
      href: "dashboard",
      icon: <LayoutDashboard className="h-4 w-4" />,
      complete: visitedViews.length >= 3,
    },
  ];
  // `filter` on a typed array keeps `ChecklistItem`; annotating before the
  // filter is what makes that true (an annotated array literal that is then
  // filtered widens to the literal's inferred element type).
  const items: ChecklistItem[] = allItems.filter((i) => canView(i.href));

  const completedCount = items.filter((i) => i.complete).length;
  const totalCount = items.length;
  const progressPct = Math.round((completedCount / totalCount) * 100);

  // Navigate to a view — mirrors AppShell's `navigate()` so the URL updates
  // and the live snapshot state is preserved (no full page reload).
  const go = (v: ViewKey) => {
    if (!canView(v)) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", v);
    router.replace(`/?${params.toString()}`, { scroll: false });
  };

  const handleDismiss = () => {
    dismissOnboarding();
  };

  return (
    <Card
      className="overflow-hidden border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.04] via-transparent to-amber-500/[0.03] shadow-sm"
      role="region"
      aria-label={t("common.onboardingTitle")}
    >
      <CardHeader className="gap-2 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-base">
                {t("common.onboardingTitle")}
              </CardTitle>
              <CardDescription className="mt-0.5 text-xs">
                {t("common.onboardingSubtitle")}
              </CardDescription>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={handleDismiss}
            aria-label={t("common.dismissOnboarding")}
            title={t("common.dismissOnboarding")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Progress bar */}
        <div className="mt-2 flex items-center gap-3">
          <Progress
            value={progressPct}
            label={t("onboarding.progressLabel")}
            // Override the indicator color to emerald (default `bg-primary`
            // is slate/neutral in this theme). The shadcn Progress wrapper
            // doesn't expose an indicatorClassName prop, so we target the
            // indicator's data-slot via a Tailwind arbitrary variant.
            className="h-1.5 flex-1 bg-muted [&>[data-slot=progress-indicator]]:bg-emerald-500"
          />
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 tabular-nums",
              completedCount === totalCount
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
            )}
            aria-label={t("onboarding.progressLabel")}
          >
            {formatNumber(completedCount, numLang)} / {formatNumber(totalCount, numLang)}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        <ol className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {items.map((item) => (
            <li key={item.key}>
              <div
                className={cn(
                  "group flex items-center gap-2.5 rounded-lg border p-2.5 transition-colors",
                  item.complete
                    ? "border-emerald-500/20 bg-emerald-500/[0.04]"
                    : "border-border/60 bg-card/40 hover:bg-muted/40",
                )}
              >
                {/* Circular checkbox */}
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    item.complete
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : "border-muted-foreground/40 bg-transparent text-transparent",
                  )}
                  aria-hidden="true"
                >
                  {item.complete && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>

                {/* Icon + label */}
                <span
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                    item.complete
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : "bg-muted/60 text-muted-foreground",
                  )}
                  aria-hidden="true"
                >
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-xs font-medium",
                      item.complete ? "text-foreground" : "text-foreground/90",
                    )}
                    title={item.label}
                  >
                    {item.label}
                  </span>
                  <span
                    className={cn(
                      "block text-[10px] leading-tight",
                      item.complete
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-muted-foreground",
                    )}
                  >
                    {item.complete ? t("onboarding.complete") : t("onboarding.incomplete")}
                  </span>
                </span>

                {/* Go button */}
                <Button
                  size="sm"
                  variant={item.complete ? "ghost" : "outline"}
                  className="h-7 shrink-0 px-2 text-[11px]"
                  onClick={() => go(item.href)}
                  aria-label={`${t("onboarding.go")}: ${item.label}`}
                >
                  {t("onboarding.go")}
                  <ArrowRight className="ms-1 h-3 w-3 rtl:rotate-180" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
