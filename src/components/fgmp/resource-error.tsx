"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/fgmp/use-language";

interface ResourceErrorProps {
  /** Raw error string from `useApi` / the store, e.g. `HTTP 403 · /api/fgmp/alarms`. */
  error: string | null | undefined;
  /** Optional retry affordance. Omit for read-only screens with no way to retry. */
  onRetry?: () => void;
  /** Extra context rendered under the message, e.g. "Alarms · 12 rows cached". */
  description?: string;
  className?: string;
  /** Render inline (inside a card) rather than as a centred block. */
  compact?: boolean;
}

/**
 * Split `HTTP 403 · /api/fgmp/alarms` into its status and endpoint halves so the
 * two can be styled and announced separately. Anything that isn't a status code
 * (a network TypeError, an aborted fetch) is shown verbatim.
 */
function parseError(error: string): { status: string | null; endpoint: string | null } {
  const m = error.match(/^HTTP\s+(\d{3})\s*·?\s*(.*)$/);
  if (!m) return { status: null, endpoint: null };
  const endpoint = m[2].trim();
  return { status: m[1], endpoint: endpoint || null };
}

/**
 * The single error surface every view uses instead of silently rendering an
 * empty or stale table.
 *
 * `useApi` deliberately keeps the last good `data` when a request fails, so a
 * 401/403/429/500 would otherwise leave a cached table on screen behind a
 * healthy-looking header. Rendering this makes the failure explicit without
 * discarding the data the view already has.
 */
export function ResourceError({ error, onRetry, description, className, compact }: ResourceErrorProps) {
  const t = useT();
  if (!error) return null;
  const { status, endpoint } = parseError(error);

  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        "flex items-start gap-3 rounded-lg border border-rose-500/30 bg-rose-500/[0.06] text-sm text-rose-700 dark:text-rose-300",
        compact ? "px-3 py-2" : "px-4 py-3",
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {t("common.error")}
          {status && (
            <span className="ml-1.5 font-mono text-xs tabular-nums" dir="ltr">
              {status}
            </span>
          )}
        </p>
        <p className="mt-0.5 break-words text-xs text-muted-foreground">
          {endpoint ? (
            <span className="font-mono" dir="ltr">
              {endpoint}
            </span>
          ) : (
            error
          )}
          {description && <span className="mt-0.5 block">{description}</span>}
        </p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}