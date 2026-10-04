"use client";

/**
 * FGMP reusable empty-state component.
 *
 * Centered layout for the "no data to show" / "no results match your filters"
 * scenarios that appear across the dashboard views. Replaces the dozens of
 * bespoke `<div className="text-center text-muted-foreground">…</div>`
 * blocks scattered through the views with one consistent, polished layout.
 *
 * Polish (#43-D):
 *   - Subtle dashed border + tinted background pattern for visual breathing
 *     room around the empty content (previously bare centered text).
 *   - Larger icon container with tone-coloured gradient ring.
 *   - Larger vertical padding (`py-12`) so empty states feel deliberate,
 *     not like an accidental blank.
 *   - Smooth fade-in on mount via motion-safe CSS animation.
 *
 * Props:
 *   - icon:       Lucide icon component (e.g. `ShieldCheck`)
 *   - title:      short bold headline (e.g. t("alarms.noAlarms"))
 *   - description: longer muted helper text (e.g. t("alarms.noAlarmsHint"))
 *   - action:     optional ReactNode — typically a <Button> to clear filters
 *                 or to navigate to a related view
 *   - compact:    when true, shrinks padding (for inline panel empties)
 *
 * Task 33-C. Styling polish Task 43-D.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  /** Compact variant: smaller padding for inline panel empties. */
  compact?: boolean;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 text-center",
        // Subtle dashed border + tinted background pattern for visual breathing
        // room around the empty content. Matches the card border radius.
        "rounded-lg border border-dashed border-border/70 bg-muted/20",
        // Larger default padding so empty states feel deliberate (py-12 per
        // spec); compact variant shrinks for inline panel empties.
        compact ? "py-8" : "py-12",
        // Smooth fade-in on mount — respects prefers-reduced-motion.
        "animate-slide-in-up motion-reduce:animate-none",
        className,
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-muted to-muted/40 text-muted-foreground ring-1 ring-border/60">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
