"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun, ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/fgmp/use-language";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type ThemeOption = "system" | "light" | "dark";

const OPTIONS: { value: ThemeOption; label: string; icon: typeof Monitor }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

// SSR-safe "mounted" flag: returns false during SSR + first paint, true on the
// client afterwards. useSyncExternalStore avoids the react-hooks/set-state-in-effect
// lint rule that an empty useEffect + setMounted(true) pattern would trip.
const subscribeNoop = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * ThemeSwitcher — header dropdown for System / Light / Dark theme selection.
 *
 * Trigger button shows the current *resolved* theme icon (Sun when dark-mode is
 * active so the user knows they can switch to light, Moon otherwise) with a tiny
 * ChevronDown badge in the corner to hint it's a dropdown. Items show a Check
 * icon when they match the user's *preference* (theme, not resolvedTheme) so
 * picking "System" is highlighted even when the OS happens to resolve to dark.
 *
 * The `mounted` guard prevents SSR/CSR hydration mismatches: next-themes can
 * only read localStorage + matchMedia on the client, so we render a stable
 * Moon placeholder during SSR + first paint and swap to the real icon after
 * mount.
 */
export function ThemeSwitcher() {
  const t = useT();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    subscribeNoop,
    getClientSnapshot,
    getServerSnapshot,
  );

  const currentPref = (theme ?? "system") as ThemeOption;
  const active = (resolvedTheme ?? "dark") as "light" | "dark";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="relative"
          aria-label={t("common.switchTheme")}
          title={t("common.switchTheme")}
          data-testid="theme-switcher"
        >
          {/* Stable placeholder during SSR to avoid hydration mismatch */}
          {mounted ? (
            active === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )
          ) : (
            <Moon className="h-4 w-4" />
          )}
          <ChevronDown className="pointer-events-none absolute bottom-0.5 end-0.5 h-2.5 w-2.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Theme
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const isSelected = currentPref === opt.value;
          return (
            <DropdownMenuItem
              key={opt.value}
              onSelect={() => setTheme(opt.value)}
              className="cursor-pointer"
            >
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1">{opt.label}</span>
              {isSelected && (
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              )}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-[10px] text-muted-foreground">
          Active: <span className="font-mono">{mounted ? active : "—"}</span>
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
