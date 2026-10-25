"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A scroll container that joins the tab order **only when it actually
 * scrolls**.
 *
 * WHY. axe's `scrollable-region-focusable` (WCAG 2.1.1) fails a box whose
 * content overflows when that box cannot be reached with the keyboard: a
 * keyboard-only user can see that there is more content and has no way to get
 * to it. The usual fix — `tabIndex={0}` on every wrapper — is the wrong trade:
 * a table that fits creates an empty tab stop that a screen reader announces as
 * a nameless group, and a page with a dozen tables becomes a dozen dead stops.
 *
 * So the stop is conditional on measured overflow. The measurement runs on
 * mount, on container resize, on content resize (the first element child — a
 * table widens without the wrapper resizing) and on DOM mutation (rows added by
 * a live refresh). Nothing is measured during render, so no layout thrash.
 *
 * When the caller supplies `label`, the box is exposed as a `region` and is
 * announced with that name; without one it stays a plain focusable container,
 * which still satisfies the rule. Callers that can name the content should.
 */
function ScrollRegion({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { label?: string }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = React.useState(false)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return

    let frame = 0
    const measure = () => {
      // +1 absorbs sub-pixel rounding: a 0.4px overflow is not a scroll.
      setOverflowing(
        el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
      )
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }

    measure()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    const first = el.firstElementChild
    if (first) ro.observe(first)
    const mo = new MutationObserver(schedule)
    mo.observe(el, { childList: true, subtree: true })

    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
    }
  }, [])

  const named = overflowing && Boolean(label)

  return (
    <div
      ref={ref}
      data-slot="scroll-region"
      data-overflowing={overflowing ? "" : undefined}
      role={named ? "region" : undefined}
      aria-label={named ? label : undefined}
      tabIndex={overflowing ? 0 : undefined}
      className={cn(
        overflowing &&
          "focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export { ScrollRegion }
