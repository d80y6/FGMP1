"use client";

import { cn } from "@/lib/utils";

interface GaugeProps {
  value: number; // 0..100
  size?: number;
  label?: string;
  sublabel?: string;
  tone?: "auto" | "fuel";
  className?: string;
}

export function Gauge({ value, size = 140, label, sublabel, tone = "fuel", className }: GaugeProps) {
  const v = Math.max(0, Math.min(100, value));
  const r = (size - 16) / 2;
  const cx = size / 2;
  const cy = size / 2;
  // semicircle arc from 180° to 0°
  const circumference = Math.PI * r;
  const dash = (v / 100) * circumference;
  const color = v <= 12 ? "#f43f5e" : v <= 25 ? "#f59e0b" : "#10b981";

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <div className="relative" style={{ width: size, height: size / 2 + 14 }}>
        <svg width={size} height={size / 2 + 14} className="overflow-visible">
          <path
            d={`M ${8} ${cy} A ${r} ${r} 0 0 1 ${size - 8} ${cy}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={10}
            strokeLinecap="round"
            className="text-muted/40"
          />
          <path
            d={`M ${8} ${cy} A ${r} ${r} 0 0 1 ${size - 8} ${cy}`}
            fill="none"
            stroke={tone === "fuel" ? color : "currentColor"}
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
            style={{ transition: "stroke-dasharray 0.6s ease" }}
          />
          <text x={cx} y={cy - 6} textAnchor="middle" className="fill-foreground text-2xl font-bold">
            {Math.round(v)}%
          </text>
        </svg>
      </div>
      {label && <p className="text-sm font-medium">{label}</p>}
      {sublabel && <p className="text-xs text-muted-foreground">{sublabel}</p>}
    </div>
  );
}

interface BarGaugeProps {
  value: number; // 0..100
  className?: string;
  showLabel?: boolean;
}

export function BarGauge({ value, className, showLabel }: BarGaugeProps) {
  const v = Math.max(0, Math.min(100, value));
  const color = v <= 12 ? "bg-rose-500" : v <= 25 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all duration-500", color)} style={{ width: `${v}%` }} />
      </div>
      {showLabel && <span className="w-9 text-end text-xs font-medium tabular-nums">{Math.round(v)}%</span>}
    </div>
  );
}
