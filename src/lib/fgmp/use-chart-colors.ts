"use client";
import { useEffect, useState } from "react";

function getIsDark() {
  return document.documentElement.classList.contains("dark");
}

export function useChartColors() {
  const [isDark, setIsDark] = useState(() => getIsDark());
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setIsDark(getIsDark()));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  // Read CSS vars at call time so theme switches are reflected
  const cv = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return {
    emerald: cv("--chart-emerald") || "#10b981",
    sky: cv("--chart-sky") || "#0ea5e9",
    amber: cv("--chart-amber") || "#f59e0b",
    rose: cv("--chart-rose") || "#f43f5e",
    violet: cv("--chart-violet") || "#8b5cf6",
    muted: cv("--chart-muted") || "#64748b",
    grid: cv("--chart-grid") || "#1e293b",
    text: cv("--chart-text") || "#94a3b8",
  };
}
