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

import { test, expect } from "@playwright/test";

// Shared with the per-view sweep (views.e2e.ts). One copy of the sign-in,
// axe and overflow logic, so the two suites cannot drift apart.
import {
  AUTH,
  ADMIN,
  FIELD_ENGINEER,
  SUPERADMIN,
  VIEWPORTS,
  axeViolations,
  dialogBox,
  dumpState,
  horizontalOverflow,
  signIn,
} from "./lib";

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

  test("a non-administrative role receives no administrative navigation or requests", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (r) => requested.push(r.url()));
    await page.goto("/");
    await signIn(page, FIELD_ENGINEER);

    const nav = page.getByRole("navigation", { name: /primary navigation/i });
    for (const view of ["users", "tenants", "api-keys", "roles", "system-settings"]) {
      await expect(nav.locator(`a[href="/?view=${view}"]`), `${view} must not be offered`).toHaveCount(0);
    }
    expect(requested.filter((u) => /\/api\/fgmp\/(users|tenants|api-keys)\b/.test(u))).toEqual([]);
  });

  /**
   * D-26 — the header must fit the window it is rendered in.
   *
   * The header was a single non-wrapping row of ~15 controls with a 1614px
   * minimum. Past that it did not scroll or wrap: controls continued past the
   * right edge, where nothing can reach them. At 1440×900 `Switch role` began
   * at x=1422 and Sign out at x=1578, so an ADMIN on a 1440px laptop could not
   * sign out; at 390px eight controls were off-screen, including the language
   * switch and the live-feed pause.
   *
   * The assertion is reachability, not a layout shape: every visible header
   * control's box must lie inside the viewport. It is deliberately independent
   * of which control moved into the overflow menu.
   */
  test("no header control is rendered outside the viewport", async ({ page }) => {
    await page.goto("/");
    await signIn(page, ADMIN);
    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height });
      const offenders = await page.evaluate(() => {
        const vw = window.innerWidth;
        const header = document.querySelector("header");
        if (!header) return ["<no header>"];
        return [...header.querySelectorAll<HTMLElement>("a, button, [role='combobox'], [role='status']")]
          .filter((el) => {
            const s = getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden") return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.right > vw + 1 || r.left < -1);
          })
          .map((el) => {
            const r = el.getBoundingClientRect();
            const name = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40);
            return `${width}px: ${name} @${Math.round(r.left)}..${Math.round(r.right)}`;
          });
      });
      expect(offenders, offenders.join("; ")).toEqual([]);
    }
  });

  /** The overflow menu is the reason the row fits: on a phone the actions that
   *  left the header must still be reachable, named, and keyboard-operable. */
  test("the header overflow menu offers the actions the narrow header omits", async ({ page }) => {
    await page.goto("/");
    await signIn(page, ADMIN);
    await page.setViewportSize({ width: 390, height: 844 });

    const trigger = page.getByTestId("header-overflow-trigger");
    await expect(trigger).toBeVisible();
    await trigger.click();
    const menu = page.getByTestId("header-overflow-menu");
    await expect(menu).toBeVisible();
    // Language: the only route to the Arabic UI, previously off-screen at 390px.
    await expect(menu.getByRole("menuitemradio", { name: /english/i })).toBeVisible();
    await expect(menu.getByRole("menuitemradio", { name: /arabic|العربية/i })).toBeVisible();
    // Pause: the live-feed control.
    await expect(menu.getByRole("menuitem", { name: /pause live|resume live/i })).toBeVisible();

    // Keyboard: Escape closes and returns focus to the trigger.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    // Same accessibility bar as the rest of the shell.
    await trigger.click();
    const violations = await axeViolations(page);
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });

  /** D-27 — a widget whose first fetch was aborted must retry, not hang.
   *  Both of these were stuck in their loading skeleton forever while the
   *  endpoints answered 200 to a direct fetch. */
  test("dashboard widgets leave their loading state", async ({ page }) => {
    await page.goto("/");
    await signIn(page, ADMIN);
    await page.goto("/?view=dashboard");
    const runout = page.locator("main").getByText(/fuel runout eta|وقت نفاد الوقود/i).first();
    await expect(runout).toBeVisible({ timeout: 30_000 });
    // The card renders rows (or its own honest empty state) once the request
    // settles; a skeleton has neither.
    await expect(page.locator("main .animate-pulse")).toHaveCount(0, { timeout: 30_000 });
  });

  test("dashboard has no WCAG 2.2 AA violations", async ({ page }) => {
    await page.goto("/");
    // ADMIN, not SUPERADMIN: the super-admin belongs to the platform tenant,
    // whose dashboard is legitimately empty. Measuring contrast on a screen with
    // no data would be measuring the empty state and calling it the dashboard.
    await signIn(page, ADMIN);
    const violations = await axeViolations(page);
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });
});
