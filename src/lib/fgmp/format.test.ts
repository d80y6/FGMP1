/**
 * Regression tests for the shared money/duration formatters (D-28).
 *
 * THE DEFECT
 * ----------
 * `dispensers-view.tsx` formatted the Yemeni-rial revenue KPI and every
 * transaction duration with its own helpers, and both applied
 * `toArabicNumerals()` unconditionally while taking a `lang` argument they
 * only half-used (`formatDuration(sec, _lang)` — the parameter was literally
 * named `_lang` and ignored). With the Arabic-numeral preference on, the
 * ENGLISH interface rendered `١١٩,٩٩٦ YER` and `١:٠٧` durations, and the
 * revenue KPI wrapped to two lines because Arabic-Indic glyphs are wider.
 *
 * The rule pinned here: digits follow the requested language, the currency
 * suffix comes from the dictionary, and nothing converts digits for English.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { fmtYer, fmtDurationSeconds, fmtDateTimeShort } from "./format";
import { toArabicNumerals } from "./numerals";

describe("fmtYer", () => {
  test("English keeps Western digits and the Latin suffix", () => {
    assert.equal(fmtYer(119996, "en"), "119,996 YER");
    assert.equal(fmtYer(0, "en"), "0 YER");
  });

  test("Arabic localises both digits and suffix", () => {
    assert.equal(fmtYer(119996, "ar"), `${toArabicNumerals("119,996")} ر.ي`);
  });

  test("rounds to whole rials — the currency has no minor unit in use", () => {
    assert.equal(fmtYer(1046.6, "en"), "1,047 YER");
  });
});

describe("fmtDurationSeconds", () => {
  test("English keeps Western digits", () => {
    assert.equal(fmtDurationSeconds(67, "en"), "1:07");
    assert.equal(fmtDurationSeconds(3725, "en"), "1:02:05");
  });

  test("Arabic localises the digits", () => {
    assert.equal(fmtDurationSeconds(67, "ar"), toArabicNumerals("1:07"));
  });

  test("degenerate input renders a zero duration, never NaN", () => {
    assert.equal(fmtDurationSeconds(0, "en"), "0:00");
    assert.equal(fmtDurationSeconds(-5, "en"), "0:00");
    assert.equal(fmtDurationSeconds(Number.NaN, "en"), "0:00");
    assert.equal(fmtDurationSeconds(Number.POSITIVE_INFINITY, "en"), "0:00");
  });
});

describe("fmtTimeShort / fmtDateTimeShort", () => {
  test("minute precision keeps the date, so the cell is not a fragment", () => {
    const ts = Date.UTC(2026, 9, 25, 20, 20, 41);
    const out = fmtDateTimeShort(ts, "en");
    // Date + HH:MM, no seconds, no chopped locale punctuation.
    assert.match(out, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  });

  test("Arabic localises the digits of both halves", () => {
    const ts = Date.UTC(2026, 9, 25, 20, 20, 41);
    assert.match(fmtDateTimeShort(ts, "ar"), /[\u0660-\u0669]/);
  });
});
