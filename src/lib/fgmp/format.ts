// Shared formatting helpers.
//
// Locale-aware: timeAgo / fmtDateTime / fmtDate / fmtLitres all accept an
// optional `lang` parameter ("en" | "ar") that controls:
//   - which translation template is used for relative time strings
//   - which Intl locale is used for absolute date/time formatting
//   - whether Western or Arabic-Indic numerals are emitted
//
// The `lang` argument is optional and defaults to "en" so existing callers
// that don't pass it keep working. New code should pass the active language
// (typically from `useLanguage()` or `useArabicNumerals()`).
//
// For SSR safety, no module-level mutable state is used. The active language
// is threaded through explicitly.

import { translateFmt, type Language } from "@/lib/fgmp/i18n";
import { formatNumber, toArabicNumerals } from "./numerals";

/** Localize a number/string for display per the given language. */
function localize(s: string, lang: Language): string {
  return lang === "ar" ? toArabicNumerals(s) : s;
}

/**
 * Relative time formatter.
 *   EN: "just now" / "5s ago" / "3m ago" / "2h ago" / "1d ago"
 *   AR: "الآن" / "منذ ٥ ثانية" / "منذ ٣ دقيقة" / "منذ ٢ ساعة" / "منذ ١ يوم"
 */
export function timeAgo(ts: number | string | Date, lang: Language = "en"): string {
  const t = typeof ts === "number" ? ts : new Date(ts).getTime();
  const diff = Date.now() - t;
  if (diff < 0) return translateFmt("time.justNow", lang, {});
  const s = Math.floor(diff / 1000);
  if (s < 60) {
    return localize(translateFmt("time.secondsAgo", lang, { n: s }), lang);
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return localize(translateFmt("time.minutesAgo", lang, { n: m }), lang);
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return localize(translateFmt("time.hoursAgo", lang, { n: h }), lang);
  }
  const d = Math.floor(h / 24);
  return localize(translateFmt("time.daysAgo", lang, { n: d }), lang);
}

export function fmtNum(n: number, digits = 0, lang: Language = "en"): string {
  return formatNumber(n, lang, digits);
}

/**
 * Litres formatter. Localized digits in AR mode. Suffix unit "L" is universal.
 *   - n >= 1000 → "{n.n}k L"
 *   - n < 1000  → "{n} L"
 */
export function fmtLitres(n: number, lang: Language = "en"): string {
  if (n >= 1000) return `${localize((n / 1000).toFixed(1), lang)}k L`;
  return `${localize(String(Math.round(n)), lang)} L`;
}

/**
 * Absolute date+time formatter. Uses "en-GB" locale (DD/MM/YYYY HH:MM:SS) in
 * EN mode and "ar-SA" with Arabic-Indic numerals in AR mode. Both use the
 * Asia/Aden timezone for consistency with platform telemetry.
 */
export function fmtDateTime(ts: number | string | Date, lang: Language = "en"): string {
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (lang === "ar") {
    // ar-SA-u-nu-arab → Arabic-Indic numerals; calendar stays Gregorian for
    // industrial telemetry consistency. Falls back gracefully if the runtime
    // doesn't support the unicode extension.
    try {
      const s = d.toLocaleString("ar-SA-u-nu-arab", { hour12: false, timeZone: "Asia/Aden" });
      return s || d.toLocaleString("en-GB", { hour12: false, timeZone: "Asia/Aden" });
    } catch {
      return d.toLocaleString("en-GB", { hour12: false, timeZone: "Asia/Aden" });
    }
  }
  return d.toLocaleString("en-GB", { hour12: false, timeZone: "Asia/Aden" });
}

/**
 * Absolute date formatter. Uses "en-GB" (DD/MM/YYYY) or "ar-SA" with
 * Arabic-Indic numerals.
 */
export function fmtDate(ts: number | string | Date, lang: Language = "en"): string {
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (lang === "ar") {
    try {
      const s = d.toLocaleDateString("ar-SA-u-nu-arab", { timeZone: "Asia/Aden" });
      return s || d.toLocaleDateString("en-GB", { timeZone: "Asia/Aden" });
    } catch {
      return d.toLocaleDateString("en-GB", { timeZone: "Asia/Aden" });
    }
  }
  return d.toLocaleDateString("en-GB", { timeZone: "Asia/Aden" });
}

/**
 * Time-of-day formatter (HH:MM:SS) in the platform timezone.
 * `fmtDateTime` covers dates; this covers the clock-only case that the system
 * health view previously implemented locally (and, in the Arabic fallback,
 * without a timezone — so the same log line could render in two zones).
 */
export function fmtTime(ts: number | string | Date, lang: Language = "en"): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return typeof ts === "string" ? ts : "";
  if (lang === "ar") {
    try {
      return d.toLocaleTimeString("ar-SA-u-nu-arab", { hour12: false, timeZone: "Asia/Aden" })
        || d.toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Aden" });
    } catch {
      return d.toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Aden" });
    }
  }
  return d.toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Aden" });
}
