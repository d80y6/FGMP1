"use client";

/**
 * The current time, as a React value.
 *
 * `Date.now()` inside a component body or a `useMemo` is impure: the same render
 * inputs produce different output depending on when React happens to run, which
 * is exactly what the React Compiler's purity check flags. In practice it is
 * also a hydration hazard — the server renders one timestamp and the browser
 * another.
 *
 * This hook reads a shared clock through `useSyncExternalStore`, which is the
 * supported way to consume an external, mutable source:
 *
 *   const now = useNow();
 *   const minutesAgo = (now - new Date(item.createdAt).getTime()) / 60_000;
 *
 * One interval per cadence serves every consumer, and it only runs while
 * something is subscribed. Renders are identical for a given `now`, so a
 * memoised list does not recompute on every re-render of a parent.
 *
 * ── WHY 30 SECONDS BY DEFAULT ───────────────────────────────────────────────
 * Nearly every use in this codebase is a coarse, human-readable quantity ("4
 * minutes ago", "expires in 2 hours", an hour bucket in a heatmap). Ten seconds
 * would re-render several lists six times as often for a label nobody can read
 * that precisely; a minute is the coarsest interval that still keeps "1 minute
 * ago" honest.
 *
 * ── AND WHY THERE IS A SECOND CADENCE ───────────────────────────────────────
 * A live countdown is the one case that genuinely needs seconds, and dropping it
 * to 30 s makes the text jump by half a minute at a time — visibly broken. The
 * suppressions view asks for `useLiveNow()` and previously ran a 5 s timer of its
 * own; this only replaces that timer. Do not reach for it to make a coarse label
 * smoother, and do not add a third cadence without deleting one of these.
 */
import { useSyncExternalStore } from "react";

/**
 * Seeded at module load, never inside render.
 *
 * `getServerSnapshot` returns 0 so the server and the hydration pass agree;
 * React switches to this value once the client has hydrated. The zero is
 * therefore never shown to a user — it exists only to keep the markup stable
 * for the one render where React must compare server output with client output.
 */
let current = Date.now();

interface Clock {
  subscribe: (listener: () => void) => () => void;
}

function createClock(intervalMs: number): Clock {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    current = Date.now();
    for (const listener of listeners) listener();
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        // Refresh immediately for the first subscriber: the module may have been
        // loaded long ago, and no interval has been running to keep this fresh.
        tick();
        timer = setInterval(tick, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

/**
 * Declared once, at module scope: `useSyncExternalStore` requires a stable
 * subscribe identity, and creating the clocks here keeps every render pure.
 */
const coarseClock = createClock(30_000);
const liveClock = createClock(5_000);

function getSnapshot(): number {
  return current;
}

function getServerSnapshot(): number {
  return 0;
}

/**
 * Milliseconds since the epoch, refreshed every 30 s.
 *
 * The value is shared: two components reading it observe the same timestamp in
 * the same commit, so their relative-time labels never disagree.
 */
export function useNow(): number {
  return useSyncExternalStore(coarseClock.subscribe, getSnapshot, getServerSnapshot);
}

/** Milliseconds since the epoch, refreshed every 5 s — for live countdowns. */
export function useLiveNow(): number {
  return useSyncExternalStore(liveClock.subscribe, getSnapshot, getServerSnapshot);
}
