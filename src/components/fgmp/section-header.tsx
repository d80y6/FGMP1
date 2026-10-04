"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Accent color tone for the icon container. Defaults to "primary". */
  tone?: "primary" | "emerald" | "rose" | "amber" | "sky" | "violet";
}

const TONE_ICON: Record<string, string> = {
  primary: "bg-primary/10 text-primary",
  emerald: "bg-emerald-500/10 text-emerald-500 dark:text-emerald-400",
  rose: "bg-rose-500/10 text-rose-500 dark:text-rose-400",
  amber: "bg-amber-500/10 text-amber-500 dark:text-amber-400",
  sky: "bg-sky-500/10 text-sky-500 dark:text-sky-400",
  violet: "bg-violet-500/10 text-violet-500 dark:text-violet-400",
};

const TONE_GLOW: Record<string, string> = {
  primary: "bg-primary/10",
  emerald: "bg-emerald-500/10",
  rose: "bg-rose-500/10",
  amber: "bg-amber-500/10",
  sky: "bg-sky-500/10",
  violet: "bg-violet-500/10",
};

export function SectionHeader({
  title,
  description,
  icon,
  actions,
  className,
  tone = "primary",
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "relative flex flex-col gap-3 overflow-hidden rounded-xl border bg-card/50 p-4 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
    >
      {/* Subtle radial accent in the top-left corner */}
      <div
        className={cn(
          "pointer-events-none absolute -left-12 -top-12 h-32 w-32 rounded-full blur-2xl",
          TONE_GLOW[tone]
        )}
      />
      <div className="relative flex items-start gap-3">
        {icon && (
          <div
            className={cn(
              "mt-0.5 rounded-xl p-2.5 ring-1 ring-inset ring-border/50",
              TONE_ICON[tone]
            )}
          >
            {icon}
          </div>
        )}
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="relative flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
