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
export function DecorativeChart({ children }: { children: ReactNode }) {
  return <div aria-hidden="true">{children}</div>;
}
