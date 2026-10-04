"use client";

import { useCountUp } from "@/lib/fgmp/use-count-up";
import { cn } from "@/lib/utils";

interface AnimatedNumberProps {
  value: number;
  decimals?: number;
  duration?: number;
  className?: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Inline animated number — count-up on value change.
 * Use anywhere a numeric KPI is displayed.
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  duration = 700,
  className,
  prefix,
  suffix,
}: AnimatedNumberProps) {
  const text = useCountUp(value, { decimals, duration });
  return (
    <span className={cn("tabular-nums", className)}>
      {prefix}
      {text}
      {suffix}
    </span>
  );
}
