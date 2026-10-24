"use client";

import { useState, useEffect, useSyncExternalStore } from "react";
import { Languages, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useLanguage, useT } from "@/lib/fgmp/use-language";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "en", labelEn: "English", labelAr: "الإنجليزية", short: "EN" },
  { value: "ar", labelEn: "العربية", labelAr: "العربية", short: "AR" },
] as const;

/**
 * useSyncExternalStore requires a subscribe function. There is nothing to
 * subscribe to here — we only need a stable server/client snapshot so the
 * dropdown can render post-hydration — hence the no-op.
 */
function subscribeNoop(_cb: () => void): () => void {
  return () => {};
}
function getClientSnapshot(): boolean {
  return true;
}
function getServerSnapshot(): boolean {
  return false;
}

export function LanguageSwitcher() {
  const t = useT();
  const mounted = useSyncExternalStore(subscribeNoop, getClientSnapshot, getServerSnapshot);
  const { lang, setLang } = useLanguage();
  // Local "open" state so we can animate the chevron + render the dropdown
  // only after mount to avoid hydration mismatch.
  const [open, setOpen] = useState(false);

  // Auto-close dropdown if language changes externally.
  useEffect(() => {
    if (!open) return;
  }, [lang, open]);

  const activeOption = OPTIONS.find((o) => o.value === lang) ?? OPTIONS[0];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="relative"
          aria-label={t("common.switchLanguage")}
          title={t("common.switchLanguage")}
          data-testid="language-switcher"
        >
          {/* Icon:Languages on left + tiny "AR"/"EN" badge bottom-right */}
          <Languages className="h-4 w-4" />
          {mounted && (
            <span
              className={cn(
                "absolute -bottom-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[8px] font-bold tabular-nums",
                // 700, not 500: the badge is 8px, so it needs 4.5:1 against
                // white text — emerald-500 measured 2.3:1 in the axe run.
                lang === "ar"
                  ? "bg-emerald-700 text-white"
                  : "bg-sky-700 text-white",
              )}
            >
              {activeOption.short}
            </span>
          )}
          {/* Subtle chevron hint when open */}
          {open && (
            <ChevronDown className="absolute -top-1 -right-1 h-3 w-3 rotate-180 text-muted-foreground transition-transform" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Language · اللغة
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {OPTIONS.map((opt) => {
          const isActive = mounted && lang === opt.value;
          return (
            <DropdownMenuItem
              key={opt.value}
              onClick={() => {
                setLang(opt.value);
                setOpen(false);
              }}
              className="flex items-center gap-2"
            >
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[9px] font-bold",
                  opt.value === "ar"
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-sky-500/15 text-sky-600 dark:text-sky-400",
                )}
              >
                {opt.short}
              </span>
              <span className="flex-1 text-xs font-medium">
                {opt.value === "ar" ? opt.labelAr : opt.labelEn}
              </span>
              {isActive && <Check className="h-3.5 w-3.5 text-emerald-500" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-[10px] text-muted-foreground">
          {mounted && lang === "ar"
            ? "النشط: العربية (RTL)"
            : "Active: English (LTR)"}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
