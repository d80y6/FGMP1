"use client";

import * as React from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  downloadCsv,
  type CsvColumn,
} from "@/lib/fgmp/csv-export";
import { useT } from "@/lib/fgmp/use-language";

/**
 * ExportButton — reusable one-click CSV export trigger.
 *
 * Wraps the column-aware {@link downloadCsv} API in a shadcn Button with a
 * Download icon, a localized tooltip, and an optional loading state. Pure
 * client-side: no backend round-trip, the file is built from the supplied
 * `rows` + `columns` and offered to the browser as a `text/csv` Blob
 * download. The CSV is UTF-8 BOM-prefixed so Microsoft Excel opens it
 * correctly even when the data contains Arabic site names or alarm
 * messages.
 *
 * The parent owns the data: pass the *already-filtered* rows so the
 * export matches exactly what the operator sees on screen. Pass already-
 * localized column labels (use `t(...)` from {@link useT}) so the
 * exported header matches the user's UI language.
 *
 * Props:
 *  - `filename`  — full filename including extension; `.csv` is appended
 *                  automatically if missing. Use {@link csvFilename} to
 *                  build the standard `fgmp-{type}-{timestamp}.csv` form.
 *  - `rows`      — array of record objects to export (post-filter).
 *  - `columns`   — column descriptors; `label` becomes the CSV header
 *                  cell, `key` selects the field on each row.
 *  - `disabled`  — greys out the button (e.g. when rows is empty).
 *  - `loading`   — shows a spinner + `aria-busy` for async data fetches.
 *  - `label`     — optional override for the button text (defaults to
 *                  `t("common.export")` which renders "Export CSV" / "تصدير CSV").
 *  - `tooltip`   — optional override for the tooltip (defaults to
 *                  `t("common.exportTooltip")`).
 *  - `className` — extra classes for the underlying Button.
 *  - `onExported` — optional callback fired after the download is
 *                   triggered (e.g. for showing a toast).
 *
 * Accessibility:
 *  - `aria-label` is set to the same string as the visible label + the
 *    tooltip text so screen readers announce the action clearly.
 *  - `aria-busy` reflects the `loading` prop.
 *  - The button is keyboard-focusable and triggers on Enter/Space
 *    (default `<button>` behaviour).
 *
 * Hover effect:
 *  - The Download icon gets a subtle downward bounce (`group-hover:translate-y-0.5`)
 *    so the affordance reads as "download" rather than just "open".
 *  - The button itself uses shadcn's `outline` variant which already
 *    applies `hover:bg-accent hover:text-accent-foreground`; we layer a
 *    `hover:shadow-sm` on top for a slightly elevated feel.
 */
export interface ExportButtonProps {
  filename: string;
  rows: Record<string, unknown>[];
  columns: CsvColumn[];
  disabled?: boolean;
  loading?: boolean;
  label?: string;
  tooltip?: string;
  className?: string;
  onExported?: () => void;
}

export function ExportButton({
  filename,
  rows,
  columns,
  disabled = false,
  loading = false,
  label,
  tooltip,
  className,
  onExported,
}: ExportButtonProps) {
  const t = useT();
  const labelText = label ?? t("common.export");
  const tooltipText = tooltip ?? t("common.exportTooltip");

  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled || loading) return;
      if (rows.length === 0) return;
      try {
        downloadCsv(filename, rows, columns);
        onExported?.();
      } catch {
        // Swallow — the download is best-effort and any Blob/URL error
        // would be confusing to surface as a toast. The parent can pass
        // an `onExported` callback if it wants post-download telemetry.
      }
    },
    [filename, rows, columns, disabled, loading, onExported],
  );

  const isDisabled = disabled || loading || rows.length === 0;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClick}
            disabled={isDisabled}
            aria-busy={loading || undefined}
            aria-label={`${labelText} — ${tooltipText}`}
            data-testid="export-csv-button"
            className={cn(
              "group transition-all hover:bg-muted hover:shadow-sm",
              "active:scale-[0.98]",
              className,
            )}
          >
            {loading ? (
              <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Download className="me-1.5 h-4 w-4 transition-transform duration-200 group-hover:translate-y-0.5" />
            )}
            {loading ? t("common.exporting") : labelText}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[280px] text-center">
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
