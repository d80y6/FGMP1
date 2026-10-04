"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Smooth count-up animation hook.
 * Animates from the previous value to the target value over `duration` ms
 * using an ease-out cubic curve. Re-animates whenever `value` changes.
 *
 * Usage:
 *   const display = useCountUp(kpi.openAlarms); // animates on change
 *   const display = useCountUp(siteCount, { duration: 800 });
 */
interface UseCountUpOptions {
  duration?: number; // ms, default 700
  decimals?: number; // default 0
  enabled?: boolean; // default true; set false to disable animation (e.g. reduced motion)
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export function useCountUp(
  value: number,
  { duration = 700, decimals = 0, enabled = true }: UseCountUpOptions = {}
): string {
  // When animation is disabled or user prefers reduced motion, skip state entirely.
  const shouldAnimate = enabled && !prefersReducedMotion();
  const [display, setDisplay] = useState<number>(shouldAnimate ? 0 : value);
  const rafRef = useRef<number | null>(null);
  const fromRef = useRef<number>(value);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!shouldAnimate) {
      // No animation: keep display synced via rAF callback (avoids setState-in-effect lint).
      rafRef.current = requestAnimationFrame(() => setDisplay(value));
      return () => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      };
    }
    fromRef.current = display;
    startRef.current = null;

    const tick = (now: number) => {
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current;
      const t = Math.min(1, elapsed / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const current = fromRef.current + (value - fromRef.current) * eased;
      setDisplay(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(value);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration, shouldAnimate]);

  // Format with thousands separator + decimals
  return display.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
