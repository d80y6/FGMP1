"use client";

import { create } from "zustand";
import { useEffect } from "react";
import { translate, translateFmt, type Language } from "@/lib/fgmp/i18n";

/**
 * Language store — persists the active language (EN/AR) to localStorage and
 * syncs the document's `dir` attribute so the entire layout flips to RTL
 * when Arabic is selected.
 *
 * SSR-safe: defaults to English on the server and during the first client
 * render, then hydrates from localStorage inside a useEffect (mirrors the
 * use-favorites / use-site-notes pattern).
 */

const STORAGE_KEY = "fgmp:lang";

interface LanguageState {
  lang: Language;
  hydrated: boolean;
  setLang: (lang: Language) => void;
  toggle: () => void;
  hydrate: () => void;
}

function readFromStorage(): Language {
  if (typeof window === "undefined") return "en";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "ar" ? "ar" : "en";
  } catch {
    return "en";
  }
}

function writeToStorage(lang: Language): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
}

/** Apply dir + lang attributes to <html> so Tailwind logical properties + browser RTL kick in. */
function syncDocumentAttrs(lang: Language): void {
  if (typeof document === "undefined") return;
  const dir = lang === "ar" ? "rtl" : "ltr";
  document.documentElement.setAttribute("dir", dir);
  document.documentElement.setAttribute("lang", lang);
}

export const useLanguage = create<LanguageState>((set, get) => ({
  lang: "en",
  hydrated: false,
  setLang: (lang) => {
    writeToStorage(lang);
    syncDocumentAttrs(lang);
    set({ lang });
  },
  toggle: () => {
    const next: Language = get().lang === "en" ? "ar" : "en";
    writeToStorage(next);
    syncDocumentAttrs(next);
    set({ lang: next });
  },
  hydrate: () => {
    const lang = readFromStorage();
    syncDocumentAttrs(lang);
    set({ lang, hydrated: true });
  },
}));

/**
 * Convenience hook: returns a `t(key)` function bound to the current language.
 * Re-renders whenever the language changes.
 */
export function useT() {
  const lang = useLanguage((s) => s.lang);
  return (key: string): string => translate(key, lang);
}

/**
 * Convenience hook: returns a `tf(key, vars)` function that translates AND
 * interpolates `{name}` placeholders from the provided vars object. Useful
 * for templates like `"{n} alarms"`.
 */
export function useTF() {
  const lang = useLanguage((s) => s.lang);
  return (key: string, vars: Record<string, string | number>): string =>
    translateFmt(key, lang, vars);
}

/**
 * Mount once near the top of the client tree (e.g. inside AppShell) to
 * hydrate the language from localStorage and keep <html dir> in sync.
 */
export function useLanguageHydration(): void {
  const hydrate = useLanguage((s) => s.hydrate);
  const lang = useLanguage((s) => s.lang);

  // Hydrate once on mount, then keep <html dir> in sync on every language change.
  useEffect(() => {
    if (!useLanguage.getState().hydrated) hydrate();
    else syncDocumentAttrs(lang);
    // Cross-tab sync: listen for storage events on our key.
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) hydrate();
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [hydrate, lang]);
}

/** Direction-aware class helper. Returns "rtl" or "ltr" for conditional styling. */
export function useDir(): "rtl" | "ltr" {
  const lang = useLanguage((s) => s.lang);
  return lang === "ar" ? "rtl" : "ltr";
}

/**
 * Returns true when Arabic-Indic numerals (٠١٢٣٤٥٦٧٨٩) should be rendered
 * instead of Western (Latin) digits. Defaults to true when language is AR;
 * can be overridden via the `fgmp:arabicNumerals` localStorage flag
 * ("true"/"false"). Respects the override even when language is EN (e.g.
 * a user who wants Western numerals while in AR mode).
 */
export function useArabicNumerals(): boolean {
  const lang = useLanguage((s) => s.lang);
  if (typeof window === "undefined") return lang === "ar";
  try {
    const override = window.localStorage.getItem("fgmp:arabicNumerals");
    if (override === "true") return true;
    if (override === "false") return false;
  } catch {
    /* ignore */
  }
  return lang === "ar";
}

const ARABIC_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];

/**
 * Convert Western digits (0-9) in a string to Arabic-Indic (٠-٩).
 * Leaves non-digit characters untouched. Useful for localizing numeric
 * labels, KPI chips, and timestamps when language is AR.
 */
export function toArabicNumerals(input: string): string {
  return input.replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)] ?? d);
}

/**
 * Format a number for display in the given language.
 *  - For "ar": converts the digits to Arabic-Indic (٠١٢٣٤٥٦٧٨٩).
 *  - For "en": leaves the digits as Western (Latin).
 *
 * Accepts a number or string. Non-numeric strings pass through with digits
 * converted (so `$1,234.5` → `$١٬٢٣٤٫٥` style — though we don't localize
 * the thousands separator or decimal point here, only the digits).
 */
export function formatNumber(n: number | string, lang: Language): string {
  const s = typeof n === "number" ? n.toLocaleString("en-US") : n;
  return lang === "ar" ? toArabicNumerals(s) : s;
}
