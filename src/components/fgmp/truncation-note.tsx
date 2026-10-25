"use client";

import { useTF } from "@/lib/fgmp/use-language";

/**
 * Says out loud that a list is showing only part of its content.
 *
 * WHY. Nine views cap a table at 40–200 rows for rendering cost:
 * `filtered.slice(0, 100)`. On a tenant with 140 sites, the 100th row looks
 * exactly like the last row there is — no scrollbar edge, no count, nothing.
 * An operator filtering for a site that happens to sit at index 101 concludes
 * the site does not exist. That is a data-integrity *impression* created by a
 * rendering decision, which is the worst kind.
 *
 * Renders nothing when the whole list fits, so the common case adds no noise.
 * The count is on the operator's side of the cap: "showing 100 of 140" tells
 * them to filter, which is the only way to reach row 101 in a capped list.
 */
export function TruncationNote({
  shown,
  total,
  className,
}: {
  shown: number;
  total: number;
  className?: string;
}) {
  const tFmt = useTF();
  if (total <= shown) return null;
  return (
    <p
      // Not a live region: it appears with the data, and announcing a row count
      // on every filter keystroke would be hostile. It is reachable text.
      className={
        "border-t px-3 py-2 text-[11px] text-muted-foreground " + (className ?? "")
      }
    >
      {tFmt("common.truncatedList", { shown, total })}
    </p>
  );
}
