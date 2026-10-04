"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
  fill?: boolean;
}

export function Sparkline({ data, width = 120, height = 32, color, className, fill }: SparklineProps) {
  // Stable per-instance gradient id. Math.random() in the render body produced a
  // new id on every render (visible flicker) and is a latent SSR hydration
  // mismatch, since the server and client renders would disagree.
  const gid = `spark-${useId().replace(/:/g, "")}`;
  if (!data.length) return <div className={cn("text-xs text-muted-foreground", className)}>—</div>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = width / Math.max(1, data.length - 1);
  const points = data.map((d, i) => `${i * step},${height - ((d - min) / range) * (height - 4) - 2}`);
  const path = `M ${points.join(" L ")}`;
  const stroke = color ?? "currentColor";
  const areaPath = `${path} L ${width},${height} L 0,${height} Z`;

  return (
    <svg width={width} height={height} className={cn("overflow-visible", className)}>
      {fill && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.3} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#${gid})`} stroke="none" />
        </>
      )}
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
