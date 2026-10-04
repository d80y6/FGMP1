"use client";

import { useEffect, useRef } from "react";
import { useFgmp, type ViewKey } from "@/lib/fgmp/store";

interface ShortcutConfig {
  onNavigate: (view: ViewKey) => void;
  onToggleLive: () => void;
  onOpenCommand: () => void;
  onToggleTheme: () => void;
}

const NAV_SHORTCUTS: Record<string, ViewKey> = {
  d: "dashboard",
  s: "sites",
  f: "fuel",
  g: "generators",
  b: "batteries",
  a: "alarms",
  i: "inventory",
  o: "iot",
  m: "maintenance",
  n: "analytics",
  r: "reports",
  u: "audit",
};

/**
 * Global keyboard shortcuts hook for FGMP.
 * Shortcuts:
 *   G + <key>  — Navigate to view (G D = Dashboard, G S = Sites, etc.)
 *   ?          — Open command palette
 *   L          — Toggle live/pause feed
 *   T          — Cycle theme (System → Light → Dark)
 *   Esc        — Close any open dialog/sheet
 *
 * Shortcuts are disabled when typing in an input, textarea, or contenteditable,
 * or when a command palette/dialog is open.
 */
export function useKeyboardShortcuts(config: ShortcutConfig) {
  const livePaused = useFgmp((s) => s.livePaused);
  // Callers pass an object literal (AppShell builds it inline), so `config` has
  // a new identity on every render. Depending on it re-registered the global
  // keydown listener on every render — ~1x/sec while AppShell re-rendered for
  // its 1Hz clock. Keep the latest config in a ref instead and let the effect
  // read `configRef.current` at event time. This effect is declared first so
  // the ref is refreshed before the listener is (re)attached.
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  });

  useEffect(() => {
    let gPressed = false;
    let gTimer: ReturnType<typeof setTimeout> | null = null;

    const isTyping = (e: KeyboardEvent): boolean => {
      const target = e.target as HTMLElement;
      if (!target) return false;
      const tag = target.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable ||
        target.getAttribute("role") === "combobox" ||
        target.getAttribute("role") === "option"
      );
    };

    const isModifierPressed = (e: KeyboardEvent): boolean =>
      e.metaKey || e.ctrlKey || e.altKey;

    const handler = (e: KeyboardEvent) => {
      // Never intercept when typing or using modifiers
      if (isTyping(e) || isModifierPressed(e)) return;

      const key = e.key.toLowerCase();

      // 'G' prefix for navigation (G then another key within 800ms)
      if (key === "g" && !gPressed) {
        gPressed = true;
        if (gTimer) clearTimeout(gTimer);
        gTimer = setTimeout(() => {
          gPressed = false;
        }, 800);
        e.preventDefault();
        return;
      }

      // If 'G' was pressed, expect a nav key
      if (gPressed) {
        gPressed = false;
        if (gTimer) clearTimeout(gTimer);
        const view = NAV_SHORTCUTS[key];
        if (view) {
          e.preventDefault();
          configRef.current.onNavigate(view);
        }
        return;
      }

      // Single-key shortcuts
      switch (key) {
        case "?":
          e.preventDefault();
          configRef.current.onOpenCommand();
          break;
        case "l":
          e.preventDefault();
          configRef.current.onToggleLive();
          break;
        case "t":
          e.preventDefault();
          configRef.current.onToggleTheme();
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      if (gTimer) clearTimeout(gTimer);
    };
  }, [livePaused]);
}

/**
 * Keyboard help data — used by the command palette and a help dialog.
 */
export const KEYBOARD_SHORTCUTS = [
  { keys: "G D", description: "Go to NOC Dashboard", category: "Navigation" },
  { keys: "G S", description: "Go to Site Management", category: "Navigation" },
  { keys: "G F", description: "Go to Fuel Monitoring", category: "Navigation" },
  { keys: "G G", description: "Go to Generators", category: "Navigation" },
  { keys: "G B", description: "Go to Batteries", category: "Navigation" },
  { keys: "G A", description: "Go to Alarm Management", category: "Navigation" },
  { keys: "G I", description: "Go to Inventory & Supply", category: "Navigation" },
  { keys: "G O", description: "Go to IoT Devices", category: "Navigation" },
  { keys: "G M", description: "Go to Maintenance", category: "Navigation" },
  { keys: "G N", description: "Go to Analytics", category: "Navigation" },
  { keys: "G R", description: "Go to Reports", category: "Navigation" },
  { keys: "G U", description: "Go to Audit Log", category: "Navigation" },
  { keys: "?", description: "Open command palette", category: "Actions" },
  { keys: "L", description: "Toggle live/pause telemetry feed", category: "Actions" },
  { keys: "T", description: "Cycle theme (System → Light → Dark)", category: "Actions" },
  { keys: "⌘K", description: "Open command palette (anywhere)", category: "Actions" },
  { keys: "Esc", description: "Close dialog or sheet", category: "Actions" },
];
