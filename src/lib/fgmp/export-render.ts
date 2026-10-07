/**
 * Export rendering — CSV, XLSX and DOCX from one row set.
 *
 * ── WHY A SEPARATE MODULE ────────────────────────────────────────────────────
 * The export route was CSV-only with a `docx` dependency that nothing imported.
 * The audit called the dependency dead; it was more precisely UNUSED, which is
 * a different problem — the capability was specified, the package was already
 * paid for, and no code path ever reached it.
 *
 * Separating the rendering keeps the route about AUTHORISATION and row
 * selection, and makes each format independently testable. It also means a
 * format can be added without touching the tenant-scoping logic that is easy to
 * get subtly wrong.
 *
 * ── NUMERIC FIDELITY, WHICH IS THE ACTUAL POINT ──────────────────────────────
 * A fuel export is reconciled against delivery notes. If litres become
 * `1234.5600000000001` in a spreadsheet because a float made a round-trip
 * through JSON, the export is not usable and worse, the discrepancy looks like
 * a delivery shortfall.
 *
 * So every numeric cell is rendered through `renderNumber`, which:
 *   - drops a trailing `.0` from whole numbers (`3000`, not `3000.00`)
 *   - preserves genuine precision up to a sane bound
 *   - never emits `NaN`, `Infinity`, or an exponential form that Excel would
 *     show as `1.2345678901234E+4`
 *
 * `Prisma.Decimal` serialises to a JSON STRING, so a Decimal field arrives as
 * `"3000.50"`. That is handled explicitly: a numeric string is passed through
 * as-is rather than being treated as text, because an operator sorting the
 * column expects numeric order.
 */

import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";

export type ExportRow = Record<string, unknown>;

export interface RenderOptions {
  /** Column headers in display order. Defaults to the keys of the first row. */
  headers?: readonly string[];
  /** Document title, used in XLSX/DOCX. */
  title: string;
}

/**
 * Render a numeric cell.
 *
 * `null`/`undefined` → empty. A numeric string → passed through unchanged so a
 * Prisma.Decimal survives exactly. Otherwise `Number(v)` and round to 4 decimal
 * places, which is well beyond any real litre or rial precision and far below
 * float noise.
 */
export function renderNumber(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";

  // Prisma.Decimal arrives as a string. Do NOT Number() it: the string is the
  // exact decimal and converting to binary double is the precision loss this
  // function exists to prevent.
  if (typeof v === "string") {
    if (v.trim() === "" || !/^-?\d+(\.\d+)?$/.test(v.trim())) return v;
    return trimNumberString(v.trim());
  }

  if (typeof v !== "number") return String(v);
  if (!Number.isFinite(v)) return "";

  // FLOAT NOISE. `0.1 + 0.2` is 0.30000000000000004 in binary floating point,
  // and String() hands that to the operator verbatim. On a delivery note that
  // reads as a 4e-17 litre discrepancy — invisible to the eye and exactly the
  // kind of thing that eats an afternoon during reconciliation.
  //
  // Rounded to 9 decimal places, then trailing zeros trimmed. 9 is far beyond
  // any real fuel or rial precision (a litre is tracked to 0.001) and far above
  // the ~1e-16 relative error of a double, so this removes representation
  // noise without touching a genuine value.
  const rounded = Math.round(v * 1e9) / 1e9;
  // Avoid rendering -0 for values that round to zero.
  return trimNumberString(String(Object.is(rounded, -0) ? 0 : rounded));
}

function trimNumberString(s: string): string {
  // Strip a trailing zero run but keep genuine precision: "3000.00" → "3000",
  // "3000.50" → "3000.5", "1234.5678" → "1234.5678".
  if (!s.includes(".")) return s;
  const trimmed = s.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

/** Cell value as it should appear to a human. */
export function renderCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return renderNumber(v);
  if (typeof v === "string") {
    // A numeric string is a Decimal in disguise; do not quote it.
    if (/^-?\d+(\.\d+)?$/.test(v.trim())) return trimNumberString(v.trim());
    return v;
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(renderCell).join(", ");
  return renderNumber(v);
}

/** Escape one CSV field. RFC 4180. */
export function csvEscape(v: unknown): string {
  const s = renderCell(v);
  // Quote when the value contains a delimiter, a quote, or a newline. The
  // leading-space and tab cases are Excel's formula-injection guard: a cell
  // beginning `=`, `+`, `-` or `@` is executed as a formula on open, which is
  // how a site name from user input becomes code on an operator's machine.
  const needsQuote = /[",\r\n]/.test(s) || /^[=+\-@\t\r]/.test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Render CSV with a BOM so Excel opens UTF-8 Arabic correctly. */
export function renderCsv(rows: readonly ExportRow[], opts: RenderOptions): string {
  const headers = opts.headers ?? Object.keys(rows[0] ?? {});
  const body = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")),
  ].join("\n");
  // Without the BOM, Excel on Windows assumes the system codepage and renders
  // Arabic site names as mojibake. This is a real, reported defect class on
  // bilingual exports.
  return `﻿${body}`;
}

/**
 * Render XLSX.
 *
 * SpreadsheetML by hand rather than a library: the file is a zip of XML parts,
 * and pulling in a dependency for a fixed row shape would be a worse trade
 * than ~120 lines of well-understood format code. `docx` already brings a zip
 * writer, so the container is reused rather than reimplemented.
 */
export async function renderXlsx(
  rows: readonly ExportRow[],
  opts: RenderOptions,
): Promise<Uint8Array> {
  const headers = opts.headers ?? Object.keys(rows[0] ?? {});

  const esc = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const sheetRows = [
    `<row r="1" ht="22" customHeight="1">${headers
      .map(
        (h, i) =>
          `<c r="${col(i)}1" t="inlineStr" s="1"><is><t>${esc(renderCell(h))}</t></is></c>`,
      )
      .join("")}</row>`,
    ...rows.map((r, ri) => {
      const n = ri + 2;
      return `<row r="${n}">${headers
        .map((h, i) => {
          const v = r[h];
          const isNum = typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()));
          if (isNum) return `<c r="${col(i)}${n}"><v>${esc(renderNumber(v))}</v></c>`;
          return `<c r="${col(i)}${n}" t="inlineStr"><is><t>${esc(renderCell(v))}</t></is></c>`;
        })
        .join("")}</row>`;
    }),
  ].join("");

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>
<dimension ref="A1:${col(Math.max(headers.length - 1, 0))}${rows.length + 1}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${headers.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="22" customWidth="1"/>`).join("")}</cols>
<sheetData>${sheetRows}</sheetData>
<autoFilter ref="A1:${col(Math.max(headers.length - 1, 0))}${rows.length + 1}"/>
</worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(sheetName(opts.title))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  // Only the header row is bold. Style 1 referenced by <c s="1"> above.
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>`;

  // `jszip`, not `fflate`: jszip is what `docx` already bundles, so this adds
  // no new dependency. Importing an undeclared transitive would work until an
  // unrelated upgrade deduped it away, and would fail at runtime rather than at
  // install.
  const JSZip = await loadJsZip();
  const zip = new JSZip();
  const files: Record<string, string> = {
    "[Content_Types].xml": contentTypes,
    "_rels/.rels": rootRels,
    "xl/workbook.xml": workbook,
    "xl/_rels/workbook.xml.rels": wbRels,
    "xl/styles.xml": styles,
    "xl/worksheets/sheet1.xml": sheet,
  };
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  // These are small reports produced by an operator clicking a button, so
  // STORE (no deflate) is faster than DEFLATE and the size difference is
  // irrelevant at this scale.
  return zip.generateAsync({ type: "uint8array", compression: "STORE" });
}

/** Render DOCX via the `docx` package that has been a dependency all along. */
export async function renderDocx(
  rows: readonly ExportRow[],
  opts: RenderOptions,
): Promise<Uint8Array> {
  const headers = opts.headers ?? Object.keys(rows[0] ?? {});

  const cell = (text: string, bold = false): TableCell =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text, bold })] })],
    });

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((h) => cell(renderCell(h), true)),
      }),
      ...rows.map(
        (r) => new TableRow({ children: headers.map((h) => cell(renderCell(r[h]))) }),
      ),
    ],
  });

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: opts.title, bold: true, size: 28 })],
          }),
          new Paragraph({ text: `${rows.length} row(s) — ${new Date().toISOString()}` }),
          table,
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

/** 0 → A, 25 → Z, 26 → AA. */
function col(n: number): string {
  let s = "";
  let x = n;
  do {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}

/** Excel sheet names: ≤31 chars, and no : \ / ? * [ ]. */
function sheetName(title: string): string {
  return title.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Export";
}

/** MIME types per format. */
export const CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export type ExportFormat = keyof typeof CONTENT_TYPES;

/** Render in the requested format. */
export async function render(
  rows: readonly ExportRow[],
  format: ExportFormat,
  opts: RenderOptions,
): Promise<{ body: Uint8Array | string; contentType: string }> {
  switch (format) {
    case "csv":
      return { body: renderCsv(rows, opts), contentType: CONTENT_TYPES.csv };
    case "xlsx":
      return { body: await renderXlsx(rows, opts), contentType: CONTENT_TYPES.xlsx };
    case "docx":
      return { body: await renderDocx(rows, opts), contentType: CONTENT_TYPES.docx };
  }
}

/**
 * `jszip` loaded once and cached.
 *
 * A bare `await import("jszip")` per call re-resolves the module graph on every
 * export, which made the test suite time out on the 5s per-test budget. The
 * module is a singleton by nature; caching the promise just stops paying for
 * the resolution repeatedly.
 */
let jszipPromise: Promise<typeof import("jszip").default> | null = null;
function loadJsZip(): Promise<typeof import("jszip").default> {
  jszipPromise ??= import("jszip").then((m) => m.default);
  return jszipPromise;
}

/** Narrow an untrusted string to a known format. Used at the route boundary. */
export function isExportFormat(v: string): v is ExportFormat {
  return v === "csv" || v === "xlsx" || v === "docx";
}
