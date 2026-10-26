"use client";

import { useEffect, useRef } from "react";
import { useFgmp, type ViewKey } from "@/lib/fgmp/store";
import { NAV_ENTRIES } from "@/lib/fgmp/navigation";

interface ShortcutConfig {
  onNavigate: (view: ViewKey) => void;
  onToggleLive: () => void;
  onOpenCommand: () => void;
  onToggleTheme: () => void;
}

/**
 * `G <letter>` → view, derived from the shared nav table.
 *
 * This used to be a hand-written map covering 12 views while the command
 * palette ADVERTISED shortcuts for 21 — G P (dispensers), G E (edge), G C
 * (forecast), G X (patterns), G T (tenants), G Y (geography), G L (roles) and
 * G K (api keys) were printed next to the menu item and bound to nothing, and
 * `G R` was printed twice (asset registry and reports) with only one of the two
 * implemented. Deriving both the binding and the printed hint from
 * `NAV_ENTRIES` makes "the key is shown" and "the key works" the same fact.
 *
 * Two entries legitimately have no shortcut (users, system-settings and the
 * no-letter surfaces); they simply do not appear in the help dialog either.
 */
const NAV_SHORTCUTS: Record<string, ViewKey> = Object.fromEntries(
  NAV_ENTRIES.filter((e) => /^G [A-Z]$/.test(e.shortcut ?? "")).map((e) => [
    // Lower-case key: `handler` compares `e.key.toLowerCase()`.
    (e.shortcut as string).slice(2).toLowerCase(),
    e.key,
  ]),
) as Record<string, ViewKey>;

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
/**
 * Keyboard help data — used by the command palette and the help dialog.
 *
 * `cap` is the capability the shortcut acts through. A navigation shortcut is
 * only usable by a role that may open the view it names, and the shell's
 * `navigate()` refuses the rest — so listing "G N — Analytics" to a NOC
 * operator (no `view:analytics`) documents a key that does nothing. The help
 * dialog filters on this field; the keys themselves are already gated where
 * they are bound.
 */
export const KEYBOARD_SHORTCUTS: {
  keys: string;
  /** Literal text for the few non-view rows. */
  description?: string;
  /** i18n key, used by the navigation rows (their label is the nav entry's). */
  descKey?: string;
  category: string;
  categoryKey?: string;
  cap?: string;
}[] = [
  // Navigation rows come from the nav table, so the help dialog can only list a
  // key that is actually bound (see NAV_SHORTCUTS above) and can only list it to
  // a role that may open the view (`cap`). A hand-written copy here would be the
  // fourth place a view's name, key and capability had to agree.
  ...NAV_ENTRIES.filter((e) => /^G [A-Z]$/.test(e.shortcut ?? "")).map((e) => ({
    keys: e.shortcut as string,
    descKey: e.tKey,
    category: "Navigation",
    categoryKey: "keyboard.category.navigation",
    cap: e.cap,
  })),
  { keys: "?", descKey: "keyboard.action.openPalette", category: "Actions", categoryKey: "keyboard.category.actions" },
  { keys: "L", descKey: "keyboard.action.toggleLive", category: "Actions", categoryKey: "keyboard.category.actions" },
  { keys: "T", descKey: "keyboard.action.cycleTheme", category: "Actions", categoryKey: "keyboard.category.actions" },
  { keys: "⌘K", descKey: "keyboard.action.openPaletteAnywhere", category: "Actions", categoryKey: "keyboard.category.actions" },
  { keys: "Esc", descKey: "keyboard.action.closeDialog", category: "Actions", categoryKey: "keyboard.category.actions" },
];
