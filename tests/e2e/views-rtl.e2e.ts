/**
 * Every view, in Arabic — the direction nothing has ever rendered.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `views.e2e.ts` renders all 30 surfaces, but only in the default language.
 * That leaves the RTL layout of 27 screens **never executed**: the ledger has
 * said "RTL: inspected statically" since round 2, and static inspection is not
 * evidence. A product that ships an Arabic UI has a second layout, and until
 * this file it had never been on a screen.
 *
 * What RTL actually changes in this app, and therefore what this sweep tests:
 *
 *   - `dir="rtl"` reverses flex rows, table columns and scroll origins, so any
 *     physical class (`ml`/`mr`, `text-left`/`text-right`, `left-0`) now points
 *     the wrong way. The tree held ~400 of them and zero logical equivalents
 *     when this file was written — see D-27, and its guard;
 *   - a time axis (the Gantt, the 24-hour heatmap) must NOT mirror, so those
 *     two grids pin `dir="ltr"` and are asserted to keep it;
 *   - tables, toolbars and the sticky Gantt label column mirror, which is
 *     exactly where a width tuned for LTR breaks;
 *   - Arabic strings are not the same length as their English source, so a
 *     button sized to its label can overflow;
 *   - `dir="rtl"` changes how bidi text and numbers lay out.
 *
 * WHAT IT ASSERTS (hard failures)
 *   dir/lang applied        `html[dir=rtl][lang=ar]`. Without this the run is
 *                           measuring English twice, which is worse than not
 *                           running at all — so it fails loudly.
 *   Arabic is on screen     `main` contains Arabic script. If the dictionary
 *                           failed to load, every label is English and the
 *                           layout being tested is a counterfeit.
 *   renders / pageerror / console.error / 5xx
 *                           same signals as the LTR sweep.
 *   overflow at 1440 + 390  RTL is where LTR-tuned widths break.
 *   axe WCAG 2.2 AA         the same serious/critical rule set.
 *
 * WHAT IT REPORTS BUT DOES NOT FAIL ON
 *   Latin prose in `main`. Seeded data is legitimately English — site names,
 *   operator names, hardware models, emails — and no static rule can separate
 *   "data that happens to be Latin" from "a string nobody translated", because
 *   at render time they are identical. The count and up to three examples are
 *   printed per view so a human can look; failing on it would either need an
 *   allowlist of seeded values (which would go stale) or would fail on correct
 *   output. The static i18n guard is the enforcement; this is the observation.
 *
 * A SKIP IS A SKIP. Without a seeded database this cannot run.
 */

import { test, expect, type Browser, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  AUTH,
  ADMIN,
  SUPERADMIN,
  axeViolations,
  dumpState,
  horizontalOverflow,
  settle,
  sessionState,
  type AxeViolation,
} from "./lib";

/** Mirrors `VIEWS` in `views.e2e.ts`, which mirrors `NAV` in `app-shell.tsx`. */
const VIEWS = [
  "dashboard", "sites", "fuel", "dispensers", "edge-firmware", "generators",
  "batteries", "alarms", "suppressions", "asset-registry", "inventory", "iot",
  "maintenance", "analytics", "fuel-forecast", "consumption-patterns", "reports",
  "audit", "users", "tenants", "geography", "roles", "system-settings",
  "api-keys", "system-health", "tenant-isolation", "preferences",
] as const;

const SUPERADMIN_ONLY = new Set(["tenants", "tenant-isolation"]);
const ADMIN_VIEWS = VIEWS.filter((v) => !SUPERADMIN_ONLY.has(v));

/** `fgmp:lang` — the key `src/lib/fgmp/use-language.ts` persists to. */
const LANG_KEY = "fgmp:lang";

type RtlRow = {
  view: string;
  role: string;
  dir: string;
  lang: string;
  arabicChars: number;
  latinProse: number;
  latinSamples: string[];
  renders: boolean;
  pageErrors: string[];
  consoleErrors: string[];
  http5xx: string[];
  overflowDesktop: string | null;
  overflowMobile: string | null;
  axe: AxeViolation[];
};

const rows: RtlRow[] = [];

function reportFile(): string {
  return join(process.cwd(), "test-results", "views-rtl-report.md");
}

function renderReport(): string {
  const lines: string[] = [];
  const violations = rows.reduce((n, r) => n + r.axe.length, 0);
  lines.push("# Per-view sweep — Arabic (RTL)", "");
  const expected = VIEWS.length;
  const unmeasured = rows.filter((r) => r.dir === "?").length;
  lines.push(
    `Views attempted: **${rows.length}** of ${expected} · axe violations: **${violations}** · ` +
      `all in \`dir=rtl\`: **${rows.every((r) => r.dir === "rtl") ? "yes" : "NO"}**` +
      (unmeasured ? ` · never measured: **${unmeasured}**` : ""),
    "",
  );
  lines.push(
    "| View | Role | dir | Arabic chars | Latin prose (data, reported only) | axe | Overflow 1440 | Overflow 390 |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const r of rows) {
    lines.push(
      `| \`${r.view}\` | ${r.role} | ${r.dir} | ${r.arabicChars} | ${r.latinProse}` +
        `${r.latinSamples.length ? ` — e.g. “${r.latinSamples[0]}”` : ""} | ` +
        `${r.axe.length ? r.axe.map((v) => `${v.id}×${v.nodes}`).join(", ") : "—"} | ` +
        `${r.overflowDesktop ?? "—"} | ${r.overflowMobile ?? "—"} |`,
    );
  }
  lines.push("");
  lines.push(
    "Latin prose is **not** a failure: seeded site names, operator names and " +
      "hardware models are legitimately English, and at render time they are " +
      "indistinguishable from an untranslated string. The static guard " +
      "(`untranslated-text.test.ts`) is the enforcement; this column exists so a " +
      "human can spot a panel that never translated.",
  );
  return lines.join("\n");
}

async function visitRtl(
  browser: Browser,
  who: "ADMIN" | "SUPERADMIN",
  state: Awaited<ReturnType<typeof sessionState>>,
  view: string,
): Promise<RtlRow> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: { cookies: state.cookies, origins: state.origins },
  });

  // Seed the language BEFORE any app script runs, which is precisely the state
  // an Arabic-speaking operator returns to: the store hydrates from this key.
  // Setting it after load would test the switcher, not the layout.
  await context.addInitScript(
    ([key]) => {
      try {
        window.localStorage.setItem(key, "ar");
      } catch {
        /* private mode: the assertion below will catch the consequence */
      }
    },
    [LANG_KEY],
  );

  const page: Page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const http5xx: string[] = [];

  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/^Failed to load resource/.test(text) && !text.includes("/api/")) return;
    consoleErrors.push(text.slice(0, 300));
  });
  page.on("response", (res) => {
    const url = res.url();
    if (!url.includes("/api/")) return;
    if (res.status() >= 500) http5xx.push(`${res.status()} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  });

  try {
    await page.goto(`/?view=${view}`);
    // The sign-out control is bilingual in this app, hence the alternation.
    await expect(
      page.getByRole("button", { name: /sign out|تسجيل الخروج/i }),
      `${view}: the stored session did not authenticate this page`,
    ).toBeVisible({ timeout: 30_000 });
    const { settled } = await settle(page);
    if (!settled) throw new Error(`${view} never settled in RTL: ${await dumpState(page)}`);

    const attrs = await page.evaluate(() => ({
      dir: document.documentElement.getAttribute("dir") ?? "",
      lang: document.documentElement.getAttribute("lang") ?? "",
    }));

    const scan = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return { renders: false, arabicChars: 0, latinProse: 0, latinSamples: [] as string[] };

      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      let arabicChars = 0;
      const prose: string[] = [];
      let node = walker.nextNode();
      while (node) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) {
          arabicChars += (text.match(/[\u0600-\u06FF]/g) ?? []).length;
          // Two or more Latin words in a row is the shape of a sentence, not a
          // code or a model number. Data is excluded from the verdict (see the
          // header); this only feeds the report column.
          if (/(?:[A-Za-z][A-Za-z'’-]*\s+){1,}[A-Za-z][A-Za-z'’-]*/.test(text) && text.length > 8) {
            prose.push(text.slice(0, 60));
          }
        }
        node = walker.nextNode();
      }
      return {
        renders: (main.innerText ?? "").trim().length > 40,
        arabicChars,
        latinProse: prose.length,
        latinSamples: prose.slice(0, 3),
      };
    });

    const wide = await horizontalOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const narrow = await horizontalOverflow(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(200);

    const axe = (await axeViolations(page)).filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );

    const overflowText = (o: { doc: number; client: number; culprits: string[] }) =>
      o.doc > o.client + 1 ? `+${o.doc - o.client}px ${o.culprits.join(",")}` : null;

    return {
      view,
      role: who,
      dir: attrs.dir,
      lang: attrs.lang,
      arabicChars: scan.arabicChars,
      latinProse: scan.latinProse,
      latinSamples: scan.latinSamples,
      renders: scan.renders,
      pageErrors,
      consoleErrors,
      http5xx: [...new Set(http5xx)],
      overflowDesktop: overflowText(wide),
      overflowMobile: overflowText(narrow),
      axe,
    };
  } finally {
    await context.close();
  }
}

async function checkView(
  browser: Browser,
  who: "ADMIN" | "SUPERADMIN",
  credentials: typeof ADMIN,
  view: string,
): Promise<{ row: RtlRow; problems: string[] }> {
  const where = `${view} (${who}, ar)`;
  let row: RtlRow;
  try {
    const state = await sessionState(browser, credentials);
    row = await visitRtl(browser, who, state, view);
  } catch (err) {
    // A view that never got far enough to be measured still belongs in the
    // report: an artifact listing 24 of 27 views reads like three missing rows
    // unless the failure is written where the reader is looking.
    const row: RtlRow = {
      view, role: who, dir: "?", lang: "?", arabicChars: 0, latinProse: 0, latinSamples: [],
      renders: false, pageErrors: [], consoleErrors: [], http5xx: [],
      overflowDesktop: null, overflowMobile: null, axe: [],
    };
    rows.push(row);
    return {
      row,
      problems: [`${where}: ${String(err instanceof Error ? err.message : err).slice(0, 500)}`],
    };
  }
  rows.push(row);

  const problems: string[] = [];
  // The direction assertion comes first and is absolute. If this fails, every
  // other measurement in this row describes the LTR layout wearing an Arabic
  // label, and reporting it as an RTL result would be a lie.
  if (row.dir !== "rtl") problems.push(`${where}: html[dir] is "${row.dir}", not "rtl"`);
  if (row.lang !== "ar") problems.push(`${where}: html[lang] is "${row.lang}", not "ar"`);
  if (row.arabicChars === 0) {
    problems.push(`${where}: no Arabic character rendered in <main> — the dictionary did not load`);
  }
  if (!row.renders) problems.push(`${where}: rendered nothing in <main>`);
  if (row.pageErrors.length) problems.push(`${where}: pageerror: ${row.pageErrors.join(" | ")}`);
  if (row.consoleErrors.length) problems.push(`${where}: console.error: ${row.consoleErrors.join(" | ")}`);
  if (row.http5xx.length) problems.push(`${where}: HTTP 5xx: ${row.http5xx.join(", ")}`);
  if (row.overflowDesktop) problems.push(`${where}: overflow at 1440 (RTL): ${row.overflowDesktop}`);
  if (row.overflowMobile) problems.push(`${where}: overflow at 390 (RTL): ${row.overflowMobile}`);
  for (const v of row.axe) {
    problems.push(`${where}: axe ${v.id}[${v.impact ?? "?"}] ×${v.nodes} @ ${v.targets.join(", ")}`);
  }
  return { row, problems };
}

test.describe("authenticated · every view in Arabic (RTL)", () => {
  test.skip(!AUTH, "needs a seeded database: set FGMP_E2E_AUTH=1");

  test("all views render in RTL without overflow, errors or WCAG 2.2 AA violations", async ({ browser }) => {
    test.setTimeout(20 * 60_000);
    const problems: string[] = [];

    for (const view of ADMIN_VIEWS) {
      problems.push(...(await checkView(browser, "ADMIN", ADMIN, view)).problems);
    }
    for (const view of [...SUPERADMIN_ONLY, "dashboard", "users"]) {
      problems.push(...(await checkView(browser, "SUPERADMIN", SUPERADMIN, view)).problems);
    }

    mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
    writeFileSync(reportFile(), renderReport(), "utf8");
    console.log(`\n${renderReport()}\n`);

    expect(problems, `${problems.length} problem(s) across ${rows.length} RTL views`).toEqual([]);
  });
});
