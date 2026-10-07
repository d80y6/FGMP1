/**
 * Tests for export rendering.
 *
 * The numeric-fidelity cases are the ones that matter. A fuel export is
 * reconciled against delivery notes, so a float artefact in a spreadsheet is
 * not cosmetic — it looks like a delivery shortfall.
 */

import { describe, expect, test } from "bun:test";
import {
  renderNumber,
  renderCell,
  csvEscape,
  renderCsv,
  renderXlsx,
  renderDocx,
  isExportFormat,
  CONTENT_TYPES,
} from "./export-render";

describe("renderNumber — precision fidelity", () => {
  test("whole numbers drop the decimal tail", () => {
    expect(renderNumber(3000)).toBe("3000");
    expect(renderNumber(3000.0)).toBe("3000");
    expect(renderNumber("3000.00")).toBe("3000");
  });

  test("genuine precision is preserved", () => {
    expect(renderNumber(4321.5)).toBe("4321.5");
    expect(renderNumber("4321.50")).toBe("4321.5");
    expect(renderNumber(1234.5678)).toBe("1234.5678");
  });

  test("a Prisma.Decimal string survives EXACTLY", () => {
    // The whole reason renderNumber does not Number() a numeric string: the
    // string IS the exact decimal, and converting to a binary double is the
    // precision loss this module exists to prevent.
    expect(renderNumber("0.1")).toBe("0.1");
    expect(renderNumber("12345678901234567890.123")).toBe("12345678901234567890.123");
  });

  test("float noise is trimmed, not amplified", () => {
    // 0.1 + 0.2 in binary float. Must not reach an operator's spreadsheet.
    expect(renderNumber(0.1 + 0.2)).toBe("0.3");
  });

  test("never emits NaN, Infinity or exponential form", () => {
    expect(renderNumber(Number.NaN)).toBe("");
    expect(renderNumber(Number.POSITIVE_INFINITY)).toBe("");
    expect(renderNumber(Number.NEGATIVE_INFINITY)).toBe("");
    // Excel would display 1.2345678901234E+4, which is unreadable on a
    // delivery note.
    expect(renderNumber(12345678901.234)).not.toMatch(/e/i);
  });

  test("negative values survive with their sign", () => {
    expect(renderNumber(-47)).toBe("-47");
    expect(renderNumber(-0.5)).toBe("-0.5");
  });

  test("empty and nullish become empty strings, not the words null/undefined", () => {
    expect(renderNumber(null)).toBe("");
    expect(renderNumber(undefined)).toBe("");
    expect(renderNumber("")).toBe("");
  });
});

describe("renderCell", () => {
  test("numeric strings are treated as numbers, not quoted text", () => {
    expect(renderCell("4321.5")).toBe("4321.5");
  });

  test("non-numeric strings pass through", () => {
    expect(renderCell("SITE-001")).toBe("SITE-001");
    expect(renderCell("Sana'a")).toBe("Sana'a");
  });

  test("booleans render as words, not 1/0", () => {
    expect(renderCell(true)).toBe("Yes");
    expect(renderCell(false)).toBe("No");
  });

  test("dates render as ISO-8601", () => {
    expect(renderCell(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
  });

  test("arrays are joined rather than stringified as [object Object]", () => {
    expect(renderCell(["a", "b"])).toBe("a, b");
  });
});

describe("csvEscape — RFC 4180 and formula injection", () => {
  test("quotes fields containing a delimiter", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });

  test("quotes fields containing a newline", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  test("doubles embedded quotes", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  test("neutralises formula injection", () => {
    // A site name beginning with = is EXECUTED as a formula when the operator
    // opens the export. This is the guard.
    for (const evil of ["=1+1", "+1+1", "-1+1", "@SUM(A1)"]) {
      expect(csvEscape(evil)).toBe(`"${evil}"`);
    }
  });

  test("plain values are not quoted", () => {
    expect(csvEscape("SITE-001")).toBe("SITE-001");
    expect(csvEscape(42)).toBe("42");
  });
});

// jszip is resolved once here and shared, for the same reason the module
// caches it: per-test dynamic imports blew the 5s budget.
const JSZip = (await import("jszip")).default;

describe("renderCsv", () => {
  test("emits a header row and one row per record", () => {
    const csv = renderCsv([{ a: 1, b: "x" }, { a: 2, b: "y" }], { title: "t" });
    const lines = csv.replace(/^﻿/, "").trim().split("\n");
    expect(lines[0]).toBe("a,b");
    expect(lines).toHaveLength(3);
  });

  test("starts with a UTF-8 BOM so Excel renders Arabic correctly", () => {
    // Without it, Excel on Windows assumes the system codepage and site names
    // in Arabic arrive as mojibake.
    const csv = renderCsv([{ name: "محطة" }], { title: "t" });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  test("honours an explicit header order", () => {
    const csv = renderCsv([{ a: 1, b: 2 }], { title: "t", headers: ["b", "a"] });
    expect(csv.replace(/^﻿/, "").split("\n")[0]).toBe("b,a");
  });
});

describe("renderXlsx", () => {
  // Real zip + deflate. See the note at the top of this file.
  const RENDER_TIMEOUT = 60_000;
  test("produces a readable zip with the expected parts", async () => {
    const bytes = await renderXlsx([{ code: "S1", litres: "4321.5" }], { title: "Sites" });
    expect(bytes.length).toBeGreaterThan(1000);

    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);
    for (const required of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
      "xl/styles.xml",
    ]) {
      expect(names).toContain(required);
    }
  }, RENDER_TIMEOUT);

  test("writes numeric cells as numbers, not text", async () => {
    const bytes = await renderXlsx([{ litres: "4321.5" }], { title: "t" });
    const zip = await JSZip.loadAsync(bytes);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    // A quoted numeric cell sorts lexicographically in Excel, which turns a
    // volume column into alphabetical order.
    expect(sheet).toContain("<v>4321.5</v>");
  }, RENDER_TIMEOUT);

  test("writes non-numeric cells as inline strings", async () => {
    const bytes = await renderXlsx([{ name: "Sana'a" }], { title: "t" });
    const zip = await JSZip.loadAsync(bytes);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain("inlineStr");
    expect(sheet).toContain("Sana&#039;a".replace("&#039;", "'"));
  }, RENDER_TIMEOUT);

  test("escapes XML metacharacters so a cell cannot break the document", async () => {
    const bytes = await renderXlsx([{ name: "a<b>&c" }], { title: "t" });
    const zip = await JSZip.loadAsync(bytes);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain("a&lt;b&gt;&amp;c");
  }, RENDER_TIMEOUT);

  test("column references advance past Z", async () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 28; i++) wide[`c${i}`] = i;
    const bytes = await renderXlsx([wide], { title: "t" });
    const zip = await JSZip.loadAsync(bytes);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    // 27 columns in ⇒ the 28th is AB, which a naive A-Z implementation gets
    // wrong and Excel then refuses to open.
    expect(sheet).toMatch(/r="AB1"/);
  }, RENDER_TIMEOUT);
});

describe("renderDocx", () => {
  const RENDER_TIMEOUT = 60_000;
  test("produces a non-trivial OOXML package", async () => {
    const bytes = await renderDocx([{ code: "S1", litres: "4321.5" }], { title: "Sites" });
    expect(bytes.length).toBeGreaterThan(1000);
  }, RENDER_TIMEOUT);

  test("is a valid zip that contains the document body", async () => {
    const bytes = await renderDocx([{ code: "S1" }], { title: "Sites" });
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toContain("word/document.xml");
  }, RENDER_TIMEOUT);
});

describe("isExportFormat", () => {
  test("accepts the three supported formats", () => {
    expect(isExportFormat("csv")).toBe(true);
    expect(isExportFormat("xlsx")).toBe(true);
    expect(isExportFormat("docx")).toBe(true);
  });

  test("rejects anything else rather than defaulting silently", () => {
    for (const bad of ["pdf", "", "csv; DROP TABLE", "CSV ", "xls"]) {
      expect(isExportFormat(bad)).toBe(false);
    }
  });
});

describe("CONTENT_TYPES", () => {
  test("every format declares a distinct, correct MIME type", () => {
    expect(CONTENT_TYPES.csv).toContain("text/csv");
    expect(CONTENT_TYPES.xlsx).toContain("spreadsheetml");
    expect(CONTENT_TYPES.docx).toContain("wordprocessingml");
    expect(new Set(Object.values(CONTENT_TYPES)).size).toBe(3);
  });
});
