"use client";

/**
 * FGMP Breadcrumbs (#11)
 * ─────────────────────────────────────────────────────────────────────────
 * A small, reusable navigation trail used by detail sheets (Site, Region)
 * and other drill-downs. Renders an ordered list of items separated by
 * chevrons; the last item is the current page (no link, bold foreground).
 *
 * Behavior:
 *  - LTR: chevrons point right (ChevronRight), trail reads left-to-right.
 *  - RTL (Arabic mode): chevrons point left (ChevronLeft) AND the visual
 *    order is reversed via flex-row-reverse so the root sits at the right
 *    edge and the current page sits at the left edge — mirroring the
 *    natural reading direction.
 *
 * Links use plain `<a href>` tags so navigation works as a full page
 * transition (the app's `/?view=X` URLs are page-level routes). This
 * keeps the component dependency-free (no router import) and reusable
 * from server-rendered contexts.
 *
 * Accessibility:
 *  - <nav aria-label> identifies the breadcrumb landmark.
 *  - <ol>/<li> provides a semantic list structure.
 *  - The current page uses `aria-current="page"` so screen readers
 *    announce "current page" when focused.
 */

import { Fragment } from "react";
import { ChevronRight, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, useDir } from "@/lib/fgmp/use-language";

export interface BreadcrumbItem {
  /** Visible label for the crumb. */
  label: string;
  /** Optional href. When omitted, the crumb is rendered as the current page (no link). */
  href?: string;
}

export interface BreadcrumbsProps {
  /** Trail from root → current. The last item is the current page. */
  items: BreadcrumbItem[];
  /** Optional className for the <nav> wrapper. */
  className?: string;
}

export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  const t = useT();
  const dir = useDir();
  const isRtl = dir === "rtl";

  if (!items || items.length === 0) return null;

  const Chevron = isRtl ? ChevronLeft : ChevronRight;

  return (
    <nav
      aria-label={t("common.breadcrumbs")}
      className={cn(
        "flex min-w-0 items-center",
        isRtl && "flex-row-reverse",
        className,
      )}
    >
      <ol className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          const isCurrent = isLast && !item.href;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable position in a static trail
            <Fragment key={`${item.label}-${i}`}>
              <li className="flex min-w-0 items-center">
                {item.href && !isLast ? (
                  <a
                    href={item.href}
                    className="truncate rounded-sm px-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
                  >
                    {item.label}
                  </a>
                ) : isCurrent ? (
                  <span
                    aria-current="page"
                    className="truncate px-0.5 font-medium text-foreground"
                    title={item.label}
                  >
                    {item.label}
                  </span>
                ) : (
                  <span className="truncate px-0.5" title={item.label}>
                    {item.label}
                  </span>
                )}
              </li>
              {!isLast && (
                <li aria-hidden="true" className="flex shrink-0 items-center">
                  <Chevron className={cn("h-3 w-3 text-muted-foreground/60", isRtl && "rotate-0")} />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
