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

import type { DecimalLike } from "@/lib/fgmp/decimal";
import { quoteCsvField } from "./csv";
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import PDFDocument from "pdfkit";
import arabicReshaper from "arabic-reshaper";
import bidiFactory from "bidi-js";
import { PDF_FONTS } from "./pdf-fonts";

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
 *
 * PHASE 5: widened to accept `DecimalLike` so a Prisma.Decimal OBJECT is
 * rendered as faithfully as its string form. The parameter was `unknown`, and
 * an unknown carrying a Decimal fell through to the `typeof v !== "number"`
 * branch and was emitted via String(v) — which happens to look right for
 * Decimal, and wrong for every other object, since it also swallows
 * `{toString}` wrappers that are not numbers at all. The type is widened here
 * at the definition rather than cast at each call site, because this module's
 * entire purpose is faithful numeric rendering and a cast would defeat it.
 */
export function renderNumber(v: DecimalLike): string {
  if (v === null || v === undefined || v === "") return "";

  // Prisma.Decimal as an object. toString() gives the exact decimal text, and it
  // is then handled by the string branch below — deliberately NOT Number(),
  // because converting to binary double is the precision loss this function
  // exists to prevent.
  if (typeof v === "object") {
    return renderNumber(String(v));
  }

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

/**
 * Escape one CSV field. RFC 4180 + the shared Excel formula-injection guard.
 *
 * The quoting rule lives in `csv.ts` so the client-side exports apply the same
 * guard; this function only adds the export-specific cell rendering (Decimal
 * strings, Dates, arrays, Yes/No booleans) before quoting.
 */
export function csvEscape(v: unknown): string {
  return quoteCsvField(renderCell(v));
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

/**
 * `jszip` loaded once and cached.
 *
 * A bare `await import("jszip")` per call re-resolves the module graph on every
 * export, which made the test suite time out on the 5s per-test budget. The
 * module is a singleton by nature; caching the promise just stops paying for
 * the resolution repeatedly.
 */
type JSZipCtor = typeof import("jszip");
let jszipPromise: Promise<JSZipCtor> | null = null;
function loadJsZip(): Promise<JSZipCtor> {
  // `jszip`'s types export the constructor as a NAMED export, not default, and
  // under `esModuleInterop` the runtime object has both. Use the namespace form
  // so the type and the runtime agree.
  jszipPromise ??= import("jszip").then((m) => (m.default ?? m) as JSZipCtor);
  return jszipPromise;
}

// ──────────────────────────────────────────────────────────────────────────
// PDF
// ──────────────────────────────────────────────────────────────────────────

const bidi = bidiFactory();

/**
 * Shape mixed Arabic/Latin text for PDF.
 *
 * PDF has no text-shaping engine: it draws glyphs in the order
 * they appear. Arabic needs each letter in its contextual form
 * (initial/medial/final) and the whole RTL run reversed, or the
 * document renders disconnected letters in the wrong order —
 * worse than no export at all for an Arabic-speaking operator.
 * arabic-reshaper applies the presentation forms, bidi-js the
 * Unicode Bidirectional Algorithm. The fast path leaves pure
 * Latin/number strings untouched so EN exports stay byte-identical.
 */
function shapeText(text: string): string {
  // U+0600..U+06FF Arabic, U+0750..U+077F supplement, U+FB50..U+FDFF
  // and U+FE70..U+FEFF presentation forms.
  if (!/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)) return text;
  const reshaped = arabicReshaper.reshape(text);
  const levels = bidi.getEmbeddingLevels(reshaped, "rtl");
  return bidi.getReorderedString(reshaped, levels);
}

/** Registered font names inside the PDF document. */
const PDF_FONT_REGULAR = "FGMPArabic";
const PDF_FONT_BOLD = "FGMPArabic-Bold";

/** Row height budget: wrapped cells grow the row. */
const PDF_ROW_HEIGHT = 16;
const PDF_PAGE_MARGIN = 40;

/**
 * Render the row set as a PDF document with the embedded
 * Noto Naskh Arabic face — the proposal's "PDF" export format
 * (§7 التقارير: تصدير CSV, PDF, Excel).
 */
export async function renderPdf(
  rows: readonly ExportRow[],
  opts: RenderOptions,
): Promise<Uint8Array> {
  const headers = opts.headers ?? Object.keys(rows[0] ?? {});
  const doc = new PDFDocument({ size: "landscape", margin: PDF_PAGE_MARGIN });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", () => resolve()));

  // Embedded Arabic faces — the only fonts in the document, so
  // Latin and Arabic text share one typeface family.
  doc.registerFont(PDF_FONT_REGULAR, Buffer.from(PDF_FONTS["NotoNaskhArabic-Regular"], "base64"));
  doc.registerFont(PDF_FONT_BOLD, Buffer.from(PDF_FONTS["NotoNaskhArabic-Bold"], "base64"));

  // Title
  doc.font(PDF_FONT_BOLD).fontSize(14).text(shapeText(opts.title), { align: "center" });
  doc.moveDown();

  // Table geometry: the page is landscape A4; columns share the
  // width equally and wrap to at most two lines.
  const usableWidth = doc.page.width - 2 * PDF_PAGE_MARGIN;
  const colWidth = usableWidth / Math.max(headers.length, 1);
  const tableTop = doc.y;
  const pageHeight = doc.page.height;

  const drawHeader = () => {
    doc.font(PDF_FONT_BOLD).fontSize(8);
    let x = PDF_PAGE_MARGIN;
    for (const h of headers) {
      doc.text(shapeText(String(h)), x, tableTop, { width: colWidth - 4, height: PDF_ROW_HEIGHT, ellipsis: true });
      x += colWidth;
    }
    doc.moveTo(PDF_PAGE_MARGIN, tableTop + PDF_ROW_HEIGHT).lineTo(doc.page.width - PDF_PAGE_MARGIN, tableTop + PDF_ROW_HEIGHT).stroke();
  };
  drawHeader();

  // Rows, paginated
  doc.font(PDF_FONT_REGULAR).fontSize(8);
  let y = tableTop + PDF_ROW_HEIGHT;
  for (const row of rows) {
    if (y + PDF_ROW_HEIGHT > pageHeight - PDF_PAGE_MARGIN) {
      doc.addPage();
      y = PDF_PAGE_MARGIN;
      drawHeader();
      y = tableTop + PDF_ROW_HEIGHT;
      doc.font(PDF_FONT_REGULAR).fontSize(8);
    }
    let x = PDF_PAGE_MARGIN;
    for (const h of headers) {
      doc.text(shapeText(renderCell(row[h])), x, y, { width: colWidth - 4, height: PDF_ROW_HEIGHT, ellipsis: true });
      x += colWidth;
    }
    y += PDF_ROW_HEIGHT;
    doc.moveTo(PDF_PAGE_MARGIN, y).lineTo(doc.page.width - PDF_PAGE_MARGIN, y)
      .strokeColor("#e2e8f0").strokeOpacity(0.6).stroke();
    doc.strokeColor("#000000").strokeOpacity(1);
  }

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

/** MIME types per format. */
export const CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
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
    case "pdf":
      return { body: await renderPdf(rows, opts), contentType: CONTENT_TYPES.pdf };
  }
}

/** Narrow an untrusted string to a known format. Used at the route boundary. */
export function isExportFormat(v: string): v is ExportFormat {
  return v === "csv" || v === "xlsx" || v === "docx" || v === "pdf";
}
