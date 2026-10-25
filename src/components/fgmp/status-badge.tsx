"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/fgmp/use-language";

const STATUS_STYLES: Record<string, string> = {
  ONLINE: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  OPERATIONAL: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  OK: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  RUNNING: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  STOPPED: "bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30",
  DEGRADED: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  MAINTENANCE: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  LOW: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  EMPTY: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
  CRITICAL: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
  FAULT: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
  FAILURE: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
  OFFLINE: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
  REPLACEMENT_DUE: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
  PROVISIONING: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  // alarms
  OPEN: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
  ACKNOWLEDGED: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  ESCALATED: "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30",
  RESOLVED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  // deliveries
  SCHEDULED: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  IN_TRANSIT: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
  DELIVERED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  VERIFIED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  DISCREPANCY: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
  CANCELLED: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30",
  // tickets
  DONE: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  IN_PROGRESS: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  // severity
  L1: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  L2: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30",
  L3: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
};

// Status values that represent an ACTIVE / dynamic state (still in motion,
// still drawing power, still open) — these get a tiny pulsing dot to signal
// "live" to the operator at a glance. Static/closed states (RESOLVED,
// DELIVERED, OFFLINE, CANCELLED, etc.) keep their shape glyph but no pulse.
const DYNAMIC_STATUSES = new Set([
  "RUNNING", "DISPENSING", "OPEN", "IN_PROGRESS", "IN_TRANSIT",
  "ESCALATED", "PROVISIONING", "ACKNOWLEDGED", "SCHEDULED",
]);

// High-severity statuses get a subtle drop-shadow so they pop visually
// against busy table rows. Used sparingly — only for things the operator
// must not miss (L3 alarms, OPEN, CRITICAL, FAULT, OFFLINE, DISCREPANCY).
const HIGH_SEVERITY = new Set([
  "L3", "OPEN", "CRITICAL", "FAULT", "FAILURE", "OFFLINE", "EMPTY",
  "DISCREPANCY", "ESCALATED",
]);

// Colorblind accessibility (#13): each status category gets a distinct SHAPE
// in addition to its color, so users with red/green color deficiency can
// still distinguish statuses. Shapes are rendered as a tiny inline SVG
// before the label.
//   ●  circle   = healthy / good / operational
//   ▲  triangle = warning / degraded / in-progress
//   ■  square   = critical / fault / offline / error
//   ◆  diamond  = neutral / stopped / cancelled / scheduled
//   —  dash     = unknown / fallback
type ShapeKind = "circle" | "triangle" | "square" | "diamond" | "dash";

const STATUS_SHAPES: Record<string, ShapeKind> = {
  // healthy
  ONLINE: "circle", OPERATIONAL: "circle", OK: "circle", RUNNING: "circle",
  RESOLVED: "circle", DELIVERED: "circle", VERIFIED: "circle", DONE: "circle",
  // warning
  DEGRADED: "triangle", MAINTENANCE: "triangle", LOW: "triangle",
  ACKNOWLEDGED: "triangle", IN_PROGRESS: "triangle",
  REPLACEMENT_DUE: "triangle", L1: "triangle", L2: "triangle",
  // critical
  EMPTY: "square", CRITICAL: "square", FAULT: "square", FAILURE: "square",
  OFFLINE: "square", OPEN: "square", DISCREPANCY: "square", L3: "square",
  ESCALATED: "square",
  // neutral
  STOPPED: "diamond", CANCELLED: "diamond",
  SCHEDULED: "diamond", PROVISIONING: "diamond", IN_TRANSIT: "diamond",
};

function ShapeGlyph({ kind, className }: { kind: ShapeKind; className?: string }) {
  const common = cn("inline-block h-2.5 w-2.5 shrink-0", className);
  switch (kind) {
    case "circle":
      return <span className={cn(common, "rounded-full bg-current")} aria-hidden="true" />;
    case "square":
      return <span className={cn(common, "bg-current")} aria-hidden="true" />;
    case "triangle":
      return (
        <svg className={common} viewBox="0 0 10 10" aria-hidden="true" fill="currentColor">
          <polygon points="5,0 10,9 0,9" />
        </svg>
      );
    case "diamond":
      return (
        <svg className={common} viewBox="0 0 10 10" aria-hidden="true" fill="currentColor">
          <polygon points="5,0 10,5 5,10 0,5" />
        </svg>
      );
    case "dash":
    default:
      return <span className={cn(common, "rounded-sm bg-current opacity-50")} aria-hidden="true" style={{ height: "2px", marginTop: "4px" }} />;
  }
}

// Status values that should be looked up under the `status.*` namespace
// (with the raw value lowercased) — i.e. plain status labels.
// Other values are looked up under severity.* / alarm.* / etc.
// We try multiple namespaces in order; first hit wins; fallback to raw value.
const LOOKUP_NAMESPACES = ["status", "severity", "alarm", "common", "tank", "battery", "generator", "delivery", "ticket"] as const;

export function StatusBadge({ value, className, showShape = true }: { value: string; className?: string; showShape?: boolean }) {
  const t = useT();
  const style = STATUS_STYLES[value] ?? "bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30";
  const shape = STATUS_SHAPES[value] ?? "dash";
  const isDynamic = DYNAMIC_STATUSES.has(value);
  const isHighSeverity = HIGH_SEVERITY.has(value);

  // Resolve the display label via i18n. Try several namespaces so a single
  // StatusBadge component can render site statuses (status.online), alarm
  // severities (severity.l3), alarm statuses (alarm.OPEN → "Open"), tank
  // statuses (tank.full), battery statuses (battery.healthy), delivery
  // statuses (delivery.scheduled), and ticket statuses (ticket.open) without
  // the caller having to specify which dictionary to use. Falls back to the
  // raw value (with underscores turned to spaces) when no key matches.
  const label = resolveStatusLabel(value, t);

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-medium tracking-wide transition-colors",
        style,
        // Subtle drop-shadow for high-severity statuses so they pop in busy tables.
        isHighSeverity && "shadow-sm shadow-rose-500/20",
        className,
      )}
    >
      {showShape && <ShapeGlyph kind={shape} />}
      {isDynamic && (
        // Tiny pulsing dot for active/dynamic statuses (RUNNING, OPEN, …).
        // Respects prefers-reduced-motion via the motion-reduce: prefix.
        <span
          className="animate-pulse-soft motion-reduce:animate-none -ms-0.5 h-1.5 w-1.5 rounded-full bg-current opacity-80"
          aria-hidden="true"
        />
      )}
      {label}
    </Badge>
  );
}

/**
 * Resolve a status/severity/enum value to a translated display label.
 * Tries several i18n namespaces in order; the first matching key wins.
 * Falls back to the raw value with underscores replaced by spaces when
 * no translation key is found.
 *
 * Lookup order (case-insensitive value):
 *   1. status.{value.toLowerCase()}       — e.g. status.online, status.offline
 *   2. severity.{value.toLowerCase()}     — e.g. severity.l1, severity.l3
 *   3. alarm.{value}                      — e.g. alarm.OPEN (alarm statuses)
 *   4. common.{value.toLowerCase()}       — common.* catch-all
 *   5. tank.{value.toLowerCase()}         — tank.full, tank.critical
 *   6. battery.{value.toLowerCase()}      — battery.healthy, battery.charging
 *   7. generator.{value.toLowerCase()}    — generator.running, generator.fault
 *   8. delivery.{value.toLowerCase()}     — delivery.scheduled, delivery.delivered
 *   9. ticket.{value.toLowerCase()}       — ticket.open, ticket.done
 *  10. raw value with underscores → spaces
 */
function resolveStatusLabel(value: string, t: (key: string) => string): string {
  if (!value) return "";
  const lower = value.toLowerCase();
  for (const ns of LOOKUP_NAMESPACES) {
    const key = `${ns}.${lower}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return value.replace(/_/g, " ");
}

export function severityDot(severity: string) {
  if (severity === "L3") return "bg-rose-500";
  if (severity === "L2") return "bg-orange-500";
  return "bg-amber-500";
}
