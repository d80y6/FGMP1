/**
 * CSV field escaping — one implementation shared by the browser download
 * helpers, the server export route, and the site-comparison export.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Three copies existed: `csv-export.ts` (client), `export-render.ts` (server),
 * and an inline one in `site-comparison-tool.tsx`. Only the server copy guarded
 * against formula injection, so a site name beginning `=` was neutralised in
 * one export path and executed as a formula in the others. Escaping is a
 * correctness boundary, so it lives in one pure module.
 *
 * RFC 4180: quote fields containing a delimiter, quote, CR or LF; double
 * embedded quotes. On top of that, quote any field beginning with `=`, `+`,
 * `-`, `@` or a tab — Excel/Sheets would otherwise evaluate it as a formula
 * when the operator opens the file.
 */

/** Quote one already-stringified field when RFC 4180 or Excel requires it. */
export function quoteCsvField(field: string): string {
  const needsQuote = /[",\r\n]/.test(field) || /^[=+\-@\t\r]/.test(field);
  if (!needsQuote) return field;
  return `"${field.replace(/"/g, '""')}"`;
}

/**
 * Convert any value to a CSV-safe field.
 *
 * Null/undefined → empty string; booleans → `true`/`false`; everything else
 * goes through `String(value)` before quoting.
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return quoteCsvField(typeof value === "string" ? value : String(value));
}

/**
 * Join a 2D array of cells into a CSV body with CRLF row endings.
 * The first row is treated as the header by convention; this function does
 * not care. No BOM — callers add it when building the download/response.
 */
export function rowsToCsv(rows: readonly (readonly (string | number)[])[]): string {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}
