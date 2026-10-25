"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/**
 * A single-choice filter, rendered as a segmented control.
 *
 * WHY NOT <Tabs>. These controls were built from the Tabs primitive, but they
 * are not tabs: nothing is hidden in a panel, the same list is re-filtered. A
 * Tab trigger promises `aria-controls` → a panel id, and with no panel to point
 * at, axe reports `aria-valid-attr-value` (critical) on every screen that uses
 * one — generators, alarms and maintenance all carried it. The Tabs role also
 * tells a screen reader "tab 1 of 3, use arrow keys to switch panels", which is
 * the wrong model for a filter operating on one table.
 *
 * A ToggleGroup of type "single" renders `role="radiogroup"` with
 * `role="radio"` + `aria-checked` children — the same interaction, the correct
 * semantics, and no id references to dangle. The visual result is unchanged:
 * the same muted track, the same raised selected pill.
 */
export function FilterTabs({
  value,
  onValueChange,
  label,
  className,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name for the group, e.g. "Ticket status". Required: an unnamed
   *  radiogroup is announced as "group" with no hint of what it filters. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // Radix reports "" when the active item is clicked again. A filter has no
      // empty state — the caller's current value stays selected.
      onValueChange={(next) => {
        if (next) onValueChange(next);
      }}
      aria-label={label}
      className={cn(
        "inline-flex h-8 w-fit items-center justify-center gap-0.5 rounded-lg bg-muted p-[3px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </ToggleGroup>
  );
}

export function FilterTab({ value, children }: { value: string; children: ReactNode }) {
  return (
    <ToggleGroupItem
      value={value}
      className={cn(
        "inline-flex h-full min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1",
        "text-xs font-medium whitespace-nowrap transition-[color,box-shadow]",
        "hover:bg-background/40 hover:text-foreground",
        "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      )}
    >
      {children}
    </ToggleGroupItem>
  );
}
