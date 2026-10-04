"use client";

/**
 * FGMP View Visit Tracker
 * ─────────────────────────────────────────────────────────────────────────
 * A zero-render component that records each visited view (dashboard, sites,
 * alarms, …) into localStorage `fgmp-views-visited` as a JSON array of unique
 * view keys. Mounted once near the app root (alongside <AppShell /> in
 * page.tsx) so it stays alive across view switches — the per-view components
 * (DashboardView, etc.) unmount when the user navigates away, so they can't
 * track visits themselves.
 *
 * The OnboardingChecklist (#9) reads this localStorage set to determine
 * whether the user has visited ≥3 distinct views ("Review the dashboard"
 * item).
 *
 * Implementation notes:
 *  - Uses `useFgmp(s => s.view)` to subscribe to view changes.
 *  - On every view change, the new view is appended to the persisted set
 *    (deduped) via a useEffect that writes to localStorage. No setState is
 *    called inside the effect — only a side-effectful write to localStorage.
 *  - SSR-safe: the effect only runs in the browser; the initial server
 *    render is a no-op.
 */

import { useEffect } from "react";
import { useFgmp } from "@/lib/fgmp/store";

const STORAGE_KEY = "fgmp-views-visited";

function readVisited(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeVisited(views: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    /* ignore quota / privacy mode errors */
  }
}

export function ViewVisitTracker() {
  const view = useFgmp((s) => s.view);

  useEffect(() => {
    if (!view) return;
    const visited = readVisited();
    if (!visited.includes(view)) {
      visited.push(view);
      writeVisited(visited);
      // Notify any listeners (e.g. the OnboardingChecklist) that the set
      // changed — same-tab updates don't fire native `storage` events.
      window.dispatchEvent(new CustomEvent("fgmp-views-visited-changed"));
    }
  }, [view]);

  return null;
}
