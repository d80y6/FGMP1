/**
 * Enum → localized label, in one place.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `alarmTypeLabel` existed six times, `roleLabel` three times and
 * `commandTypeLabel` twice, each a private copy of the same three lines:
 * look up `<namespace>.<value>` in the dictionary, and fall back to the raw
 * value with underscores turned into spaces when the key is missing.
 *
 * Copies of a fallback rule drift silently: one copy returns "" for a null
 * value while another crashes on `null.replace`, and a new namespace gets
 * added to five files but not the sixth. The rule is the same for every enum,
 * so it lives here once and callers pass the namespace.
 *
 * The fallback is deliberately not an error: an unmapped enum value should
 * still be legible to an operator ("FUEL_CRITICAL" → "FUEL CRITICAL") rather
 * than render as a missing-key string.
 */

import { translate, type Language } from "./i18n";

/**
 * Translate `<namespace>.<value>`, falling back to a humanized raw value.
 *
 * @param namespace dictionary prefix (`alarm`, `command`, `role`, …)
 * @param value     enum value as stored (`FUEL_THEFT`, `SUPERADMIN`, …)
 * @param lang      active language
 * @param opts.lowerKey lowercase the value before building the key (roles are
 *                      stored uppercase but keyed lowercase in the dictionary)
 */
export function enumLabel(
  namespace: string,
  value: string | null | undefined,
  lang: Language,
  opts: { lowerKey?: boolean } = {},
): string {
  if (!value) return "";
  const key = `${namespace}.${opts.lowerKey ? value.toLowerCase() : value}`;
  const translated = translate(key, lang);
  return translated === key ? value.replace(/_/g, " ") : translated;
}

/** `alarm.<TYPE>` → localized alarm type. */
export function alarmTypeLabel(
  type: string | null | undefined,
  lang: Language,
): string {
  return enumLabel("alarm", type, lang);
}

/** `command.<COMMAND>` → localized remote-control command name. */
export function commandTypeLabel(
  cmd: string | null | undefined,
  lang: Language,
): string {
  return enumLabel("command", cmd, lang);
}

/** `role.<lowercased role>` → localized role name. */
export function roleLabel(
  role: string | null | undefined,
  lang: Language,
): string {
  return enumLabel("role", role, lang, { lowerKey: true });
}
