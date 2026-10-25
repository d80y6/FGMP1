"use client";

import type { ReactNode } from "react";

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
  if (!label) return <div aria-hidden="true">{children}</div>;
  return (
    <div role="img" aria-label={label}>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}
