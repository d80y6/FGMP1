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

/** A failure of "the shell did not appear" must say what DID appear. */
async function dumpState(page: Page): Promise<string> {
  const state = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.replace(/\s+/g, " ").slice(0, 400),
    navs: [...document.querySelectorAll("nav")].map(
      (n) => `${n.getAttribute("aria-label") ?? "(unnamed)"}:${(n.textContent ?? "").trim().slice(0, 120)}`,
    ),
    anchors: [...document.querySelectorAll("a")].slice(0, 8).map((a) => a.getAttribute("href") ?? ""),
    dialogs: document.querySelectorAll('[role="dialog"]').length,
  }));
  return JSON.stringify(state);
}

async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/email/i).fill(who.email);
  await dialog.getByLabel(/password/i).fill(who.password);
  await dialog.getByRole("button", { name: /sign in|تسجيل الدخول/i }).click();
  const nav = page.getByRole("navigation", { name: /primary navigation|التنقل الرئيسي/i });
  try {
    await expect(nav).toBeVisible({ timeout: 30_000 });
  } catch {
    throw new Error(`sign-in did not reach the shell. page state: ${await dumpState(page)}`);
  }
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

    const nav = page.getByRole("navigation", { name: /primary navigation/i });
    const links = nav.getByRole("link");
    const count = await links.count();
    // Dump the rendered nav when the count is wrong, rather than leaving a bare
    // "expected > 20, received 0" to be guessed at.
    if (count <= 20) throw new Error(`nav has ${count} links: ${await dumpState(page)}`);

    // Every nav destination is addressable, not just clickable: a real href is
    // what makes middle-click, "open in new tab" and bookmarking work.
    expect(await links.first().getAttribute("href")).toMatch(/^\/\?view=/);

    // Each link's accessible name comes from its visible label. (The old
    // `aria-label` duplicated it and hid the alarm count.)
    const unnamed = await links.evaluateAll((els) =>
      els.filter((el) => !(el.textContent ?? "").trim()).length,
    );
    expect(unnamed, "nav links with no accessible name").toBe(0);

    const sites = nav.locator('a[href="/?view=sites"]');
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

    await sheet.locator('a[href="/?view=fuel"]').click();
    await expect(sheet).toBeHidden();
  });

  test("READONLY never receives administrative navigation or requests", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (r) => requested.push(r.url()));
    await page.goto("/");
    await signIn(page, READONLY);

    const nav = page.getByRole("navigation", { name: /primary navigation/i });
    for (const view of ["users", "tenants", "api-keys", "roles", "system-settings"]) {
      await expect(nav.locator(`a[href="/?view=${view}"]`), `${view} must not be offered`).toHaveCount(0);
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
