/**
 * Numeral localisation — one implementation of the Arabic-Indic digit mapping
 * and of locale-aware number formatting.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The same three-line digit replacement was copied into `use-language.ts`,
 * `format.ts`, `dispensers-view.tsx` and `suppressions-view.tsx`. Four copies
 * of one mapping is not a style problem: `formatNumber` (client hook module)
 * and `fmtNum` (pure formatting module) also disagreed on fraction handling,
 * so the same value could render with different precision depending on which
 * helper a component happened to import.
 *
 * Pure and dependency-free: safe on the server, in a client bundle, and in a
 * test. The React-aware hooks live in `use-language.ts` and re-export these
 * functions so existing imports keep working.
 */

import type { Language } from "./i18n";

export const ARABIC_INDIC_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"] as const;

/** Convert Western digits (0-9) in a string to Arabic-Indic (٠-٩). */
export function toArabicNumerals(input: string): string {
  return input.replace(/[0-9]/g, (d) => ARABIC_INDIC_DIGITS[Number(d)] ?? d);
}

/**
 * Localise a number (or an already-formatted numeric string) for display.
 *
 * `digits` controls the maximum fraction digits. Omit it to keep the
 * platform's historical default (`toLocaleString("en-US")`, up to three
 * fraction digits); pass `0` for whole numbers. Only the digits are
 * localised — thousands separators stay Western, matching every existing
 * surface in the app.
 */
export function formatNumber(
  n: number | string,
  lang: Language,
  digits?: number,
): string {
  const s =
    typeof n === "number"
      ? n.toLocaleString(
          "en-US",
          digits === undefined
            ? undefined
            : { maximumFractionDigits: digits, minimumFractionDigits: 0 },
        )
      : n;
  return lang === "ar" ? toArabicNumerals(s) : s;
}
