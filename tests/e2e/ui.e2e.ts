/**
 * FGMP UI suite — real browser, real server, no mocked network.
 *
 * Two halves, and the split matters:
 *
 *   PUBLIC      the sign-in surface. Runs anywhere a server is up.
 *   AUTHENTICATED  the shell and its views. Needs a seeded database and the
 *                  demo credentials, so it skips itself unless FGMP_E2E_AUTH=1.
 *
 * A skip is reported as a skip. Nothing here is silently downgraded to a mock:
 * if the database is missing, the authenticated assertions do not run and the
 * run does not claim they passed.
 *
 * What this suite is *for*: it encodes the behaviours that were fixed and that
 * a unit test cannot see — that navigation adds history (so Back returns to the
 * previous view instead of leaving the application), that the mobile nav is a
 * real dialog with an accessible name and a recognisable trigger, and that no
 * horizontal overflow appears at any supported viewport.
 */

import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";

// Resolved from the working directory (the repo root, where Playwright is
// launched) rather than from a module URL: this file is transpiled to CommonJS
// by Playwright, so `import.meta.url` is not available in it.
const AXE =
  process.env.AXE_PATH ?? join(process.cwd(), "node_modules", "axe-core", "axe.min.js");

const AUTH = process.env.FGMP_E2E_AUTH === "1";
const SUPERADMIN = { email: "superadmin@fgmp.telecom", password: "Super@2026" };
const READONLY = { email: "readonly@fgmp.telecom", password: "Admin@2026" };

const VIEWPORTS = [
  [320, 568],
  [375, 812],
  [390, 844],
  [768, 1024],
  [1024, 768],
  [1366, 768],
  [1440, 900],
  [1920, 1080],
] as const;

/** Anything that keeps the page from scrolling horizontally is fine; a scrollbar
 *  is not. A 1px tolerance absorbs sub-pixel rounding, not a broken layout. */
async function horizontalOverflow(page: Page): Promise<{ doc: number; client: number; culprits: string[] }> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const culprits = [...document.querySelectorAll("body *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1);
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 2).join(".")}`);
    return { doc: de.scrollWidth, client: de.clientWidth, culprits };
  });
}

type AxeViolation = { id: string; impact?: string | null; nodes: number; targets: string[] };
type AxeGlobal = {
  run: (
    ctx: Document,
    opts: { runOnly: { type: string; values: string[] } },
  ) => Promise<{
    violations: {
      id: string;
      impact?: string | null;
      nodes: { target?: (string | number)[] }[];
    }[];
  }>;
};

async function axeViolations(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: AxeGlobal }).axe;
    const r = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      // The count alone says "something is wrong"; the selectors say where.
      targets: v.nodes.slice(0, 4).map((n) => (n.target ?? []).join(" ")),
    }));
  });
}

/** Bounding box or a failure — avoids a non-null assertion the linter forbids. */
async function dialogBox(page: Page) {
  const box = await page.getByRole("dialog").boundingBox();
  if (!box) throw new Error("dialog has no bounding box");
  return box;
}

async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/email/i).fill(who.email);
  await dialog.getByLabel(/password/i).fill(who.password);
  await dialog.getByRole("button", { name: /sign in|تسجيل الدخول/i }).click();
  await expect(page.getByRole("navigation", { name: /primary navigation|التنقل الرئيسي/i })).toBeVisible({ timeout: 30_000 });
}

test.describe("public · sign-in surface", () => {
  test("renders the sign-in dialog with labelled fields", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/email/i)).toBeVisible();
    await expect(dialog.getByLabel(/password/i)).toBeVisible();
    await expect(dialog.getByRole("button", { name: /sign in|تسجيل الدخول/i })).toBeVisible();
    expect(errors, "uncaught errors on the sign-in surface").toEqual([]);
  });

  test("moves focus into the dialog, and the form is keyboard-operable", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    // Tab must not escape to the page behind a modal dialog.
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  });

  test("does not overflow at any supported viewport", async ({ page }) => {
    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await page.goto("/");
      await expect(page.getByRole("dialog")).toBeVisible();
      const { doc, client, culprits } = await horizontalOverflow(page);
      expect(doc, `${width}x${height}: ${culprits.join(", ")}`).toBeLessThanOrEqual(client + 1);
      const box = await dialogBox(page);
      expect(box.width, `${width}x${height}: dialog wider than the viewport`).toBeLessThanOrEqual(width);
    }
  });

  test("Arabic renders RTL, inside the viewport, with no overflow", async ({ page, context }) => {
    await context.addInitScript(() => window.localStorage.setItem("fgmp:lang", "ar"));
    await page.goto("/");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.dir), { timeout: 10_000 })
      .toBe("rtl");
    const { doc, client } = await horizontalOverflow(page);
    expect(doc).toBeLessThanOrEqual(client + 1);
    const box = await dialogBox(page);
    const viewport = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
  });

  test("has no WCAG 2.2 AA violations", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("dialog")).toBeVisible();
    const violations = await axeViolations(page);
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });
});

test.describe("authenticated · shell and navigation", () => {
  test.skip(!AUTH, "needs a seeded database: set FGMP_E2E_AUTH=1");

  test("navigation renders as links, and Back returns to the previous view", async ({ page }) => {
    await page.goto("/");
    await signIn(page, SUPERADMIN);

    const links = page.getByRole("navigation", { name: /primary navigation/i }).getByRole("link");
    expect(await links.count()).toBeGreaterThan(20);

    // Every nav destination is addressable, not just clickable: a real href is
    // what makes middle-click, "open in new tab" and bookmarking work.
    const first = links.first();
    expect(await first.getAttribute("href")).toMatch(/^\/\?view=/);

    const sites = page.getByRole("link", { name: /sites|المواقع/i });
    await sites.click();
    await expect(page).toHaveURL(/view=sites/);
    await expect(sites).toHaveAttribute("aria-current", "page");

    // The defect this proves fixed: navigation used `router.replace`, so Back
    // left the application entirely instead of returning to the previous view.
    await page.goBack();
    await expect(page).not.toHaveURL(/view=sites/);
    await expect(page.getByRole("navigation", { name: /primary navigation/i })).toBeVisible();
  });

  test("mobile navigation opens a named dialog with a recognisable trigger", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await signIn(page, SUPERADMIN);

    const trigger = page.getByRole("button", { name: /open navigation|فتح قائمة التنقل/i });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    // A dialog with no accessible name is announced as just "dialog".
    expect((await sheet.getAttribute("aria-label")) ?? (await sheet.innerText())).toBeTruthy();

    await sheet.getByRole("link", { name: /fuel|الوقود/i }).first().click();
    await expect(sheet).toBeHidden();
  });

  test("READONLY never receives administrative navigation or requests", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (r) => requested.push(r.url()));
    await page.goto("/");
    await signIn(page, READONLY);

    for (const name of [/^users$|المستخدمون/i, /^tenants$|المستأجرون/i, /^api keys$|مفاتيح/i]) {
      await expect(page.getByRole("navigation", { name: /primary navigation/i }).getByRole("link", { name })).toHaveCount(0);
    }
    expect(requested.filter((u) => /\/api\/fgmp\/(users|tenants|api-keys)\b/.test(u))).toEqual([]);
  });

  test("dashboard has no WCAG 2.2 AA violations", async ({ page }) => {
    await page.goto("/");
    await signIn(page, SUPERADMIN);
    const violations = await axeViolations(page);
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });
});
