"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Takes a Recharts chart out of the accessibility tree — used only where the
 * same numbers are already on screen as text.
 *
 * WHY THIS EXISTS. Recharts hard-codes `role="img"` on every pie sector
 * (`node_modules/recharts/lib/shape/Sector.js` sets it after the props spread,
 * so a caller cannot override it) and gives it no accessible name. axe reports
 * that as `svg-img-alt` (serious) once per sector: a screen-reader user is told
 * "image" five times and learns nothing. Two honest fixes exist —
 *
 *   1. name the graphic, and
 *   2. drop the graphic when a text equivalent is already rendered.
 *
 * Every chart using this wrapper is a donut whose legend is printed directly
 * beneath it (band name · count, severity · count). Reading the legend gives
 * exactly what the doughnut shows, so exposing the sectors again only adds
 * noise. Charts that do NOT have a text equivalent must not use this wrapper:
 * give the `<svg>` an `aria-label` and a `<title>` instead.
 */
export function DecorativeChart({
  children,
  label,
}: {
  children: ReactNode;
  /** Required when the chart carries information that is NOT printed as text
   *  elsewhere. The graphic is then announced once, by name, instead of as a
   *  stream of unnamed sectors or points. */
  label?: string;
}) {
  // Two attributes make this airtight, and both are needed:
  //
  //   aria-hidden       silences the hard-coded role="img" on every sector and
  //                     point (the thing axe reports as svg-img-alt);
  //   tabIndex={-1}     on the CHART itself (passed by the call site), because
  //                     Recharts puts tabindex="0" on its root <svg> by default
  //                     — and a tab stop inside aria-hidden is a different
  //                     violation (aria-hidden-focus). The axe check looks at
  //                     the TAB ORDER, so -1 is enough.
  if (!label) return <Hidden>{children}</Hidden>;
  return (
    <div role="img" aria-label={label}>
      <Hidden>{children}</Hidden>
    </div>
  );
}

/**
 * The suppressed wrapper.
 *
 * `aria-hidden` alone was not enough. Recharts builds its own DOM at render
 * time, and somewhere under a PieChart there is a focusable node whose exact
 * identity depends on the chart and the data — the sweep reported
 * `aria-hidden-focus` on the dashboard and on fuel, the two views with a
 * doughnut, and moved between builds. Chasing the node in Recharts' internals
 * would have been a fix that breaks on the next minor release.
 *
 * So the subtree is made non-interactive three ways, each of which is
 * independently sufficient for a different consumer:
 *
 *   aria-hidden  tells assistive tech to skip it (the svg-img-alt fix);
 *   inert        removes it from the tab order and from hit-testing entirely
 *                (the aria-hidden-focus fix, and honest: a decorative chart
 *                should not be operable);
 *   the effect   strips a non-negative tabindex from any descendant that
 *                Recharts or a future version puts back, because `inert` is
 *                not honoured by every tool that inspects the DOM.
 */
function Hidden({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>("[tabindex]")) {
      if ((el.getAttribute("tabindex") ?? "-1").startsWith("-")) continue;
      el.setAttribute("tabindex", "-1");
    }
  }, [children]);

  return (
    <div ref={ref} aria-hidden="true" inert>
      {children}
    </div>
  );
}
