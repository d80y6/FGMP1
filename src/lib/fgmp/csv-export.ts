// Client-side CSV export utilities for the FGMP platform.
//
// These helpers generate RFC 4180-compliant CSV strings entirely in the
// browser (no backend round-trip) and trigger a file download via a
// temporary <a> element + Blob URL. A UTF-8 BOM is prepended so that
// Microsoft Excel correctly detects the encoding when opening the file
// (critical for Arabic site names + alarm messages).
//
// Two parallel APIs are exposed:
//
//   1. Legacy 2D-array API (kept for the alarms / dispensers / maintenance
//      views that already use it):
//        downloadCsv(rows: (string|number)[][], filename: string)
//      where `rows` already includes the header row as its first element.
//
//   2. Column-aware record API (#43-C) — used by the reusable
//      <ExportButton/> component:
//        toCsv(rows: Record<string, any>[], columns: CsvColumn[]): string
//        downloadCsv(filename, rows, columns)
//      where `columns` declares { key, label } pairs that drive both the
//      header row and the per-row field extraction. This is the preferred
//      API for new callers — it keeps the export metadata declarative and
//      lets the parent pass already-localized labels.

import { csvEscape, rowsToCsv } from "./csv";

/**
 * Column descriptor for the record-based CSV API.
 *
 * `key`   — path on each row object (currently a flat property name; nested
 *           paths aren't supported to keep the runtime simple).
 * `label` — already-localized header text written to the CSV's first row.
 */
export interface CsvColumn {
  key: string;
  label: string;
}

/**
 * CSV escaping and row joining live in the shared `csv` module so the browser
 * exports and the server export route cannot drift (in particular, the
 * formula-injection guard used to exist only server-side). Re-exported here to
 * keep existing importers working.
 */
export { csvEscape, rowsToCsv };

/**
 * Convert an array of record rows + a column descriptor list into a CSV
 * string (header row first, then one row per record).
 *
 * For each row, the value at `row[column.key]` is extracted and run
 * through `csvEscape`. Missing keys render as empty cells so the column
 * count stays consistent.
 *
 * Returns the CSV body WITHOUT a BOM (the BOM is added by `downloadCsv`
 * at the moment the Blob is built — keeping `toCsv` pure makes it
 * unit-testable and lets callers compose multiple CSV sections if needed).
 */
export function toCsv(rows: Record<string, unknown>[], columns: CsvColumn[]): string {
  const header = columns.map((c) => c.label);
  const lines: string[] = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    const line = columns
      .map((c) => {
        const v = row?.[c.key];
        return csvEscape(v);
      })
      .join(",");
    lines.push(line);
  }
  return lines.join("\r\n");
}

/**
 * Internal helper: build a UTF-8 BOM-prefixed CSV Blob URL, click a
 * temporary <a download> element to trigger the browser save dialog, then
 * revoke the URL. Shared by both `downloadCsv` overloads so the download
 * mechanics stay in one place.
 */
function triggerCsvDownload(filename: string, csvBody: string): void {
  // Prepend a UTF-8 BOM (\uFEFF) so Excel opens the file as UTF-8 instead
  // of falling back to the system code page (which mangles non-ASCII chars
  // like Arabic site names or accented governorate labels).
  const csv = `\uFEFF${csvBody}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  // The link must be in the DOM for Firefox to fire the download.
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Release the blob URL on the next tick so the click has time to register.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Trigger a browser download of the given rows as a CSV file.
 *
 * Two call signatures are supported (TypeScript overloads resolve by arg
 * shape — the first argument being a `string` selects the column-aware
 * record API; an array selects the legacy 2D-array API):
 *
 *   downloadCsv(rows: (string|number)[][], filename: string)
 *     Legacy API. `rows` already includes the header row as element 0.
 *
 *   downloadCsv(filename: string, rows: Record<string, any>[], columns: CsvColumn[])
 *     #43-C record API. The header is derived from `columns[*].label` and
 *     each row is projected through `columns[*].key`.
 *
 * In both cases the filename has `.csv` appended if it isn't already
 * present, and the file is served as `text/csv;charset=utf-8;` with a
 * UTF-8 BOM so Excel detects the encoding correctly.
 */
export function downloadCsv(rows: (string | number)[][], filename: string): void;
export function downloadCsv(filename: string, rows: Record<string, unknown>[], columns: CsvColumn[]): void;
export function downloadCsv(first: unknown, second: unknown, third?: CsvColumn[]): void {
  // Column-aware record API: downloadCsv(filename, rows, columns)
  if (typeof first === "string") {
    const filename = first;
    const rows = second as Record<string, unknown>[];
    const columns = third ?? [];
    triggerCsvDownload(filename, toCsv(rows, columns));
    return;
  }
  // Legacy 2D-array API: downloadCsv(rows, filename)
  const rows = first as (string | number)[][];
  const filename = second as string;
  triggerCsvDownload(filename, rowsToCsv(rows));
}

/**
 * Build a timestamp string suitable for embedding in an export filename:
 * `YYYY-MM-DD-HHMM` in the user's local timezone (not UTC — operators
 * reading the filename expect it to match their wall clock).
 *
 * Example: `2026-07-07-2105` for 7 July 2026, 21:05 local.
 */
export function csvTimestamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}${min}`;
}

/**
 * Build the standard FGMP export filename: `fgmp-{type}-{timestamp}.csv`
 *
 * The timestamp includes the local date + HHMM so repeated exports within
 * the same minute don't clobber each other when downloaded to the same
 * folder. Example: `fgmp-alarms-2026-07-07-2105.csv`.
 */
export function csvFilename(type: string): string {
  return `fgmp-${type}-${csvTimestamp()}.csv`;
}

/**
 * Build the legacy FGMP export filename: `fgmp-{type}-{YYYY-MM-DD}.csv`
 *
 * Kept for backward compat with the alarms / dispensers / maintenance
 * views that already use it (date-only — no time component). New code
 * should prefer {@link csvFilename} which includes the time of day.
 *
 * Example: `fgmp-alarms-2025-01-15.csv`
 */
export function exportFilename(type: string): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `fgmp-${type}-${today}.csv`;
}
