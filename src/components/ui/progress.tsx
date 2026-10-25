"use client"

import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

/**
 * `role="progressbar"` takes its name from aria-label/aria-labelledby — the
 * value it reports ("63%") is not a name, so an unlabelled bar is announced as
 * "progress bar, 63" with no indication of 63 WHAT. `label` is required for the
 * same reason it is on Select: a new bar that forgets it is a type error.
 */
function Progress({
  className,
  value,
  label,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  /** Accessible name, e.g. "Heap usage". Pass the visible label next to it. */
  label: string
}) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      aria-label={label}
      className={cn(
        "bg-primary/20 relative h-2 w-full overflow-hidden rounded-full",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-primary h-full w-full flex-1 transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
