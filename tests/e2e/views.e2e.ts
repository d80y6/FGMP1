/**
 * Every view, in a real browser — the audit that D-06 said had not been done.
 *
 * The existing `ui.e2e.ts` covers the shell: navigation, the mobile sheet, the
 * role filter and the dashboard's accessibility. That left 27 screens whose
 * layouts, tables, forms and empty states had never been rendered by a browser
 * in any run. This file renders all of them.
 *
 * What it checks per view, and why each one is checked rather than assumed:
 *
 *   renders          the view's own content is in `main`, and the sign-in
 *                    dialog is not covering it (that was D-11's symptom)
 *   pageerror        an uncaught exception during render — the view is broken,
 *                    whatever it looks like
 *   console.error    React's own warnings arrive here; a key-less list or a
 *                    controlled/uncontrolled flip does not fail anything else
 *   HTTP 5xx         a view that asks for data and gets a server error is
 *                    showing the operator a lie or an empty table
 *   overflow         a table wider than the phone is the commonest mobile
 *                    defect in a dense operations product
 *   axe              WCAG 2.2 A/AA, serious and critical only — the same rule
 *                    set the dashboard test uses, applied to every screen
 *   tiny text        D-10: 9–10px type is a product decision, but the count
 *                    per screen is a fact, and it is printed in the report
 *
 * A SKIP IS A SKIP. Without a seeded database the authenticated sweep cannot
 * run; it reports skip and claims nothing.
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
  primaryHeading,
  sessionState,
  settle,
  type AxeViolation,
} from "./lib";

/**
 * Mirrors `NAV` in `src/components/fgmp/app-shell.tsx`.
 *
 * Duplicated deliberately: if the two lists drift, the nav/RBAC test below
 * fails, and a sweep that silently stopped covering a screen would be worse
 * than one that has to be edited when a screen is added.
 */
const VIEWS = [
  "dashboard",
  "sites",
  "fuel",
  "dispensers",
  "edge-firmware",
  "generators",
  "batteries",
  "alarms",
  "suppressions",
  "asset-registry",
  "inventory",
  "iot",
  "maintenance",
  "analytics",
  "fuel-forecast",
  "consumption-patterns",
  "reports",
  "audit",
  "users",
  "tenants",
  "geography",
  "roles",
  "system-settings",
  "api-keys",
  "system-health",
  "tenant-isolation",
  "preferences",
] as const;

/** From `ROLES.ADMIN.capabilities` in `src/lib/fgmp/rbac-core.ts`: every
 *  `view:*` key except the two the matrix reserves for SUPERADMIN. */
const SUPERADMIN_ONLY = new Set(["tenants", "tenant-isolation"]);

const ADMIN_VIEWS = VIEWS.filter((v) => !SUPERADMIN_ONLY.has(v));

type Row = {
  view: string;
  role: string;
  heading: string;
  renders: boolean;
  pageErrors: string[];
  consoleErrors: string[];
  http4xx: string[];
  http5xx: string[];
  overflowDesktop: string | null;
  overflowMobile: string | null;
  axe: AxeViolation[];
  tinyText: { tiny: number; total: number };
  dialogs: number;
};

const rows: Row[] = [];

function reportFile(): string {
  return join(process.cwd(), "test-results", "views-report.md");
}

function renderReport(): string {
  const lines: string[] = [];
  const violationTotal = rows.reduce((n, r) => n + r.axe.length, 0);
  lines.push("# Per-view sweep", "");
  lines.push(`Views rendered: **${rows.length}** · axe violations: **${violationTotal}**`, "");
  lines.push(
    "| View | Role | Heading | Renders | axe | 4xx | 5xx | Console | Overflow 1440 | Overflow 390 | <11px text |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const r of rows) {
    const axe = r.axe.length
      ? r.axe.map((v) => `${v.id}(${v.impact ?? "?"}×${v.nodes})`).join(", ")
      : "—";
    const tiny = r.tinyText.total ? `${r.tinyText.tiny}/${r.tinyText.total}` : "—";
    lines.push(
      `| ${r.view} | ${r.role} | ${r.heading || "—"} | ${r.renders ? "yes" : "**NO**"} | ${axe} | ${r.http4xx.length || "—"} | ${r.http5xx.length || "—"} | ${r.consoleErrors.length || "—"} | ${r.overflowDesktop ?? "—"} | ${r.overflowMobile ?? "—"} | ${tiny} |`,
    );
  }
  const details: string[] = [];
  for (const r of rows) {
    const problems: string[] = [];
    if (r.pageErrors.length) problems.push(`pageerror: ${r.pageErrors.join(" | ")}`);
    if (r.consoleErrors.length) problems.push(`console: ${r.consoleErrors.join(" | ")}`);
    if (r.http5xx.length) problems.push(`5xx: ${r.http5xx.join(", ")}`);
    if (r.axe.length) problems.push(`axe: ${r.axe.map((v) => `${v.id} @ ${v.targets.join(", ")}`).join(" | ")}`);
    if (r.overflowDesktop) problems.push(`overflow@1440: ${r.overflowDesktop}`);
    if (r.overflowMobile) problems.push(`overflow@390: ${r.overflowMobile}`);
    if (problems.length) details.push(`- **${r.view}** (${r.role}): ${problems.join(" · ")}`);
  }
  if (details.length) {
    lines.push("", "## Details", "", ...details);
  }
  return lines.join("\n");
}

async function visit(
  browser: Browser,
  who: "ADMIN" | "SUPERADMIN",
  state: Awaited<ReturnType<typeof sessionState>>,
  view: string,
): Promise<Row> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: { cookies: state.cookies, origins: state.origins },
  });
  const page: Page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const http4xx: string[] = [];
  const http5xx: string[] = [];

  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // A missing image or favicon is reported by Chromium as a console error on
    // every page that 404s one, and it is not what this sweep is measuring.
    // Anything the APP logs — a failed fetch, a React warning, an exception
    // caught and printed — is kept.
    if (/^Failed to load resource/.test(text) && !text.includes("/api/")) return;
    consoleErrors.push(text.slice(0, 300));
  });
  page.on("response", (res) => {
    const url = res.url();
    if (!url.includes("/api/")) return;
    const status = res.status();
    if (status >= 500) http5xx.push(`${status} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
    else if (status >= 400) http4xx.push(`${status} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  });

  try {
    await page.goto(`/?view=${view}`);
    const { settled } = await settle(page);
    if (!settled) throw new Error(`${view} never settled: ${await dumpState(page)}`);

    const heading = await primaryHeading(page);
    const dialogs = await page.locator('[role="dialog"]').count();
    const renders = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return false;
      return (main.innerText ?? "").trim().length > 40;
    });

    const wide = await horizontalOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const narrow = await horizontalOverflow(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(200);

    const axe = await axeViolations(page);
    const serious = axe.filter((v) => v.impact === "serious" || v.impact === "critical");

    const tinyText = await page.evaluate(() => {
      const root = document.querySelector("main") ?? document.body;
      let tiny = 0;
      let total = 0;
      for (const el of root.querySelectorAll("*")) {
        const hasText = [...el.childNodes].some(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 1,
        );
        if (!hasText) continue;
        const fs = Number.parseFloat(getComputedStyle(el as Element).fontSize);
        if (!Number.isFinite(fs)) continue;
        total += 1;
        if (fs < 11) tiny += 1;
      }
      return { tiny, total };
    });

    const overflowText = (o: { doc: number; client: number; culprits: string[] }) =>
      o.doc > o.client + 1 ? `+${o.doc - o.client}px ${o.culprits.join(",")}` : null;

    return {
      view,
      role: who,
      heading,
      renders,
      pageErrors,
      consoleErrors,
      http4xx: [...new Set(http4xx)],
      http5xx: [...new Set(http5xx)],
      overflowDesktop: overflowText(wide),
      overflowMobile: overflowText(narrow),
      axe: serious,
      tinyText,
      dialogs,
    };
  } finally {
    await context.close();
  }
}

/** One row, checked the same way, for both roles. */
async function sweep(
  browser: Browser,
  who: "ADMIN" | "SUPERADMIN",
  credentials: typeof ADMIN,
  views: readonly string[],
) {
  const state = await sessionState(browser, credentials);
  for (const view of views) {
    const row = await visit(browser, who, state, view);
    rows.push(row);
    // The report is written after every view so a mid-sweep failure still
    // leaves the screens that did run on disk.
    mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
    writeFileSync(reportFile(), renderReport(), "utf8");

    const where = `${view} (${who})`;
    expect(row.renders, `${where} rendered nothing${row.heading ? "" : " and no heading"}`).toBe(true);
    expect(row.dialogs, `${where} left a dialog open`).toBe(0);
    expect(row.pageErrors, `${where} threw during render`).toEqual([]);
    expect(row.consoleErrors, `${where} logged errors`).toEqual([]);
    expect(row.http5xx, `${where} received a server error`).toEqual([]);
    expect(row.overflowDesktop, `${where} overflows at 1440`).toBeNull();
    expect(row.overflowMobile, `${where} overflows at 390`).toBeNull();
    expect(
      row.axe.map((v) => `${v.id}[${v.impact}] ${v.targets.join(", ")}`),
      `${where} has WCAG 2.2 AA violations`,
    ).toEqual([]);
  }
}

test.describe("authenticated · every view", () => {
  test.skip(!AUTH, "needs a seeded database: set FGMP_E2E_AUTH=1");

  test.afterAll(() => {
    mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
    writeFileSync(reportFile(), renderReport(), "utf8");
    // Printed as well as written: CI publishes the job log on failure, and the
    // table is the point.
    console.log(`\n${renderReport()}\n`);
  });

  for (const view of ADMIN_VIEWS) {
    test(`ADMIN · ${view}`, async ({ browser }) => {
      await sweep(browser, "ADMIN", ADMIN, [view]);
    });
  }

  // The other 22 views render the same components for SUPERADMIN as for ADMIN;
  // what differs is the data (the platform tenant is legitimately empty) and
  // the buttons the role unlocks. Those are covered by the ADMIN sweep, so this
  // one spends its page loads where the rendering genuinely differs: the two
  // reserved views, and three screens whose controls are role-conditional.
  for (const view of [...SUPERADMIN_ONLY, "dashboard", "users", "system-settings"]) {
    test(`SUPERADMIN · ${view}`, async ({ browser }) => {
      await sweep(browser, "SUPERADMIN", SUPERADMIN, [view]);
    });
  }
});

/**
 * A hidden nav link is not an authorization boundary (D-06, and the brief's own
 * rule). Typing the URL is what a curious operator does next, and the view is
 * what has to refuse.
 */
test.describe("authenticated · a reserved view refuses a direct URL", () => {
  test.skip(!AUTH, "needs a seeded database: set FGMP_E2E_AUTH=1");

  for (const view of ["tenants", "tenant-isolation"]) {
    test(`ADMIN · /?view=${view} is refused, not rendered`, async ({ browser }) => {
      const state = await sessionState(browser, ADMIN);
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        storageState: { cookies: state.cookies, origins: state.origins },
      });
      const page = await context.newPage();
      const requests: string[] = [];
      page.on("request", (r) => {
        if (r.url().includes("/api/")) requests.push(r.url());
      });
      try {
        await page.goto(`/?view=${view}`);
        await settle(page);
        const main = (await page.locator("main").innerText()).replace(/\s+/g, " ");
        expect(main, `${view} did not refuse a tenant administrator`).toMatch(
          /access denied|not authorised|not authorized|only super-admins|تم رفض الوصول|فقط المدير الأعلى/i,
        );
        // The refusal must be a UI decision backed by the server, not only a
        // hidden button: the view must not have fetched the reserved endpoint.
        expect(
          requests.filter((u) => /\/api\/fgmp\/(tenants|admin\/tenant-isolation-test)\b/.test(u)),
          `${view} fetched a reserved endpoint`,
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});

/**
 * Nav and RBAC agree about all 27 views, not just the five the shell test names.
 *
 * The sweep above renders whatever the URL says; this one asserts what the
 * sidebar is willing to offer, which is the other half of the same question.
 */
test.describe("authenticated · navigation matches the permission matrix", () => {
  test.skip(!AUTH, "needs a seeded database: set FGMP_E2E_AUTH=1");

  async function navViews(browser: Browser, who: typeof ADMIN): Promise<string[]> {
    const state = await sessionState(browser, who);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: { cookies: state.cookies, origins: state.origins },
    });
    const page = await context.newPage();
    try {
      await page.goto("/");
      await settle(page);
      const hrefs = await page
        .getByRole("navigation", { name: /primary navigation|التنقل الرئيسي/i })
        .getByRole("link")
        .evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
      return hrefs.map((h) => (h.match(/view=([^&]+)/) ?? [])[1]).filter(Boolean) as string[];
    } finally {
      await context.close();
    }
  }

  test("ADMIN is offered every view except the two reserved for SUPERADMIN", async ({ browser }) => {
    const offered = await navViews(browser, ADMIN);
    expect(offered.sort()).toEqual([...ADMIN_VIEWS].sort());
  });

  test("SUPERADMIN is offered all 27", async ({ browser }) => {
    const offered = await navViews(browser, SUPERADMIN);
    expect(offered.sort()).toEqual([...VIEWS].sort());
  });
});
