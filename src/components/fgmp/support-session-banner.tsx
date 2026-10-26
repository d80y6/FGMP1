"use client";

/**
 * The banner that must never be missing.
 *
 * ── WHY A BANNER IS A SECURITY CONTROL AND NOT DECORATION ──────────────────
 * A support session lets one operator see a customer's data. The most likely
 * failure is not a broken filter — it is an operator who forgot the session was
 * open and kept reading after the phone call ended. Three things answer that:
 * expiry (the session ends itself), the single-tenant rule (they cannot wander
 * to another tenant), and this banner (they cannot forget where they are).
 *
 * So the banner is deliberately:
 *   * rendered from the SERVER's view (`/support-sessions/current` re-checks the
 *     signed cookie AND the row on every poll), not from client state that a
 *     reload could lose;
 *   * impossible to dismiss without ending the session — the only button is
 *     "End support session";
 *   * loud, with the tenant, the mode and the remaining time always visible.
 *
 * It renders nothing when there is no session, including for the 99.9% of users
 * who are not super-admins: the request is simply not made for them.
 *
 * Polling rather than a one-shot fetch: the session can be ended in another tab
 * or expire while this tab sits idle, and a banner that outlives its session is
 * exactly the false assurance this component exists to prevent.
 */

import { useCallback, useState } from "react";
import { useSession } from "next-auth/react";
import { ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useApi } from "@/lib/fgmp/use-api";
import { useFgmp } from "@/lib/fgmp/store";
import { useT, useTF } from "@/lib/fgmp/use-language";
import { isSuperAdmin } from "@/lib/fgmp/rbac-core";

interface ActiveSupport {
  id: string;
  tenantId: string;
  tenantName?: string | null;
  mode: "READ" | "WRITE";
  reason: string;
  ticketRef: string | null;
  expiresAt: string;
}

/** Re-check every 60s: often enough to notice an expiry or a remote end,
 *  rarely enough to cost nothing. */
const POLL_MS = 60_000;

function minutesLeft(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
}

export function SupportSessionBanner() {
  const t = useT();
  const tFmt = useTF();
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const effectiveRole = useFgmp((s) => s.me?.role ?? null);
  // Platform support sessions are super-admin-only at the API
  // (`requireSuperAdmin`), and that is the one place a role identity — not a
  // capability — is the right test: the overlay exists precisely so a
  // super-admin can act AS another role, so a capability derived from the
  // effective role would be false during the very session the banner reports.
  // Both the session role and the effective role must be super-admin, and the
  // shared helper keeps this literal in one place.
  const isSuper = isSuperAdmin(role);
  const canManageSupport = isSuper && isSuperAdmin(effectiveRole);

  const { data, refetch } = useApi<{ active: ActiveSupport | null }>(
    canManageSupport ? "/api/fgmp/platform/support-sessions/current" : null,
    { interval: POLL_MS, deps: [role] },
  );
  const [ending, setEnding] = useState(false);

  const end = useCallback(async () => {
    if (!canManageSupport) return;
    setEnding(true);
    try {
      await fetch("/api/fgmp/platform/support-sessions/current", {
        method: "DELETE",
        credentials: "same-origin",
      });
      refetch();
    } finally {
      setEnding(false);
    }
  }, [canManageSupport, refetch]);

  const active = data?.active ?? null;
  if (!canManageSupport || !active) return null;

  const mins = minutesLeft(active.expiresAt);
  const write = active.mode === "WRITE";

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2 text-xs sm:px-4 " +
        (write
          ? "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300")
      }
    >
      <ShieldAlert className="h-4 w-4 shrink-0" />
      <span className="font-semibold">{t("support.session")}</span>
      <span className="opacity-80">{t("support.actingAs")}</span>
      <Badge variant="outline" className="font-mono text-[10px]">
        {active.tenantName ?? active.tenantId}
      </Badge>
      <Badge className={write ? "bg-rose-600 text-white text-[10px]" : "bg-amber-600 text-white text-[10px]"}>
        {active.mode}
      </Badge>
      <span className="min-w-0 flex-1 truncate opacity-90" title={active.reason}>
        {active.reason}
        {active.ticketRef ? ` · ${active.ticketRef}` : ""}
      </span>
      <span className="tabular-nums opacity-80">{mins > 0 ? tFmt("support.minsLeft", { n: mins }) : t("support.expiring")}</span>
      <Button
        size="sm"
        variant={write ? "destructive" : "outline"}
        className="h-6 gap-1 px-2 text-[11px]"
        onClick={() => void end()}
        disabled={ending}
      >
        <X className="h-3 w-3" />
        {ending ? "Ending…" : "End support session"}
      </Button>
    </div>
  );
}
