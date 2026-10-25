/**
 * Shared browser-test helpers.
 *
 * Not named `*.e2e.ts` on purpose: Playwright's `testMatch` is `**\/*.e2e.ts`,
 * so this file is imported rather than collected as a test file.
 *
 * Everything here runs against the real application — a real server, a real
 * database in CI, real cookies. Nothing is stubbed, and a helper that cannot
 * reach the state it needs throws with the page's actual content rather than
 * returning a default that would make a test pass.
 */

import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { join } from "node:path";

// Resolved from the working directory (the repo root, where Playwright is
// launched) rather than from a module URL: these files are transpiled to
// CommonJS by Playwright, so `import.meta.url` is not available.
export const AXE =
  process.env.AXE_PATH ?? join(process.cwd(), "node_modules", "axe-core", "axe.min.js");

export const AUTH = process.env.FGMP_E2E_AUTH === "1";

export const SUPERADMIN = { email: "superadmin@fgmp.telecom", password: "Super@2026" };
export const ADMIN = { email: "admin@fgmp.telecom", password: "Admin@2026" };
// The least-privileged account the seed actually creates. There is no READONLY
// user in either seeder — a READONLY account is made through the UI — so a test
// that signed in as one would be testing an account that does not exist.
export const FIELD_ENGINEER = { email: "field.engineer@fgmp.telecom", password: "Admin@2026" };

export type Credentials = { email: string; password: string };

export const VIEWPORTS = [
  [320, 568],
  [375, 812],
  [390, 844],
  [768, 1024],
  [1024, 768],
  [1366, 768],
  [1440, 900],
  [1920, 1080],
] as const;

export type Overflow = { doc: number; client: number; culprits: string[] };

/** Anything that keeps the page from scrolling horizontally is fine; a scrollbar
 *  is not. A 1px tolerance absorbs sub-pixel rounding, not a broken layout. */
export async function horizontalOverflow(page: Page): Promise<Overflow> {
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

export type AxeViolation = { id: string; impact?: string | null; nodes: number; targets: string[] };

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

export async function axeViolations(page: Page): Promise<AxeViolation[]> {
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
export async function dialogBox(page: Page) {
  const box = await page.getByRole("dialog").boundingBox();
  if (!box) throw new Error("dialog has no bounding box");
  return box;
}

/** A failure of "the shell did not appear" must say what DID appear. */
export async function dumpState(page: Page): Promise<string> {
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

export async function signIn(page: Page, who: Credentials): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/email/i).fill(who.email);
  await dialog.getByLabel(/password/i).fill(who.password);
  await dialog.getByRole("button", { name: /sign in|تسجيل الدخول/i }).click();
  // The header is visible at every width; the sidebar is `hidden lg:block`, so
  // waiting on the nav landmark made every 375px test fail on a correct layout.
  // Sign-out is in the header for every authenticated session.
  try {
    await expect(page.getByRole("button", { name: /sign out|تسجيل الخروج/i })).toBeVisible({
      timeout: 30_000,
    });
  } catch {
    throw new Error(`sign-in did not reach the shell. page state: ${await dumpState(page)}`);
  }
}

/**
 * Sign in once and hand back the cookies, so a sweep over 27 views does not
 * repeat a 2-second form submission 27 times.
 */
type SessionState = {
  cookies: Awaited<ReturnType<BrowserContext["cookies"]>>;
  origins: Awaited<ReturnType<BrowserContext["storageState"]>>["origins"];
};

/**
 * Memoised per e-mail address. The sweep signs in 56 times without this — once
 * per view per role — and each sign-in is a real form submission.
 */
const sessionCache = new Map<string, Promise<SessionState>>();

export async function sessionState(browser: Browser, who: Credentials): Promise<SessionState> {
  const cached = sessionCache.get(who.email);
  if (cached) return cached;
  const created = createSession(browser, who);
  sessionCache.set(who.email, created);
  // A failed sign-in must not poison the cache for later tests in the run.
  created.catch(() => sessionCache.delete(who.email));
  return created;
}

async function createSession(browser: Browser, who: Credentials): Promise<SessionState> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("/");
    await signIn(page, who);
    const state = await context.storageState();
    return { cookies: state.cookies, origins: state.origins };
  } finally {
    await context.close();
  }
}

/**
 * Wait until the page has stopped fetching and the lazy view has mounted.
 *
 * `networkidle` is unusable here: the dashboard polls, so there is never a
 * 500 ms window with no network activity at all. Instead this counts in-flight
 * requests to the app's own API and waits for the count to reach zero, then
 * waits for the skeleton placeholders to disappear. Both waits are bounded —
 * a view that never settles is reported by the caller, not hung on here.
 */
export async function settle(page: Page, maxMs = 20_000): Promise<{ settled: boolean; skeletons: number }> {
  const inflight = new Set<string>();
  const onRequest = (r: { url(): string }) => {
    if (r.url().includes("/api/")) inflight.add(r.url());
  };
  const onDone = (r: { url(): string }) => inflight.delete(r.url());
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);

  const deadline = Date.now() + maxMs;
  try {
    await page.waitForLoadState("domcontentloaded");
    // Let the lazy chunk mount and its first fetch start.
    await page.waitForTimeout(500);
    while (Date.now() < deadline) {
      if (inflight.size === 0) {
        await page.waitForTimeout(400);
        if (inflight.size === 0) break;
      } else {
        await page.waitForTimeout(150);
      }
    }
    const skeletons = await page.locator("[class*='animate-pulse']").count();
    const skeletonDeadline = Date.now() + 8000;
    while (Date.now() < skeletonDeadline && (await page.locator("[class*='animate-pulse']").count()) > 0) {
      await page.waitForTimeout(200);
    }
    // "Settled" means the view put something in `main` — not that the clock had
    // time left. A page that polls forever would otherwise expire the deadline
    // and be reported as unrendered when it had rendered fine.
    const rendered = await page.evaluate(() => {
      const main = document.querySelector("main");
      return !!main && (main.innerText ?? "").trim().length > 20;
    });
    return { settled: rendered, skeletons };
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onDone);
    page.off("requestfailed", onDone);
  }
}

/** The visible heading the view is presenting, for a report that names screens. */
export async function primaryHeading(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;
    const h = main.querySelector("h1") ?? main.querySelector("h2");
    return (h?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  });
}
