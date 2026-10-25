/**
 * Playwright configuration for the FGMP UI suite.
 *
 * ── WHY THIS IS NOT A DECLARED DEPENDENCY ────────────────────────────────
 * `@playwright/test` is installed on demand by the `ui` CI job
 * (`npm i --no-save @playwright/test axe-core`). It is a browser-automation
 * tool used by one job, not something the application imports, and pinning it
 * into `dependencies`/`devDependencies` would put ~40 MB of browser tooling on
 * every `bun install` — including the Docker image build, where it is never
 * used. The alternative (declaring it and installing browsers anyway) trades
 * a few lines of YAML for a slower image build on every deploy.
 *
 * ── RUNNING IT ───────────────────────────────────────────────────────────
 *
 *   # In CI, or anywhere a browser can be downloaded:
 *   npm i --no-save @playwright/test axe-core
 *   npx playwright install --with-deps chromium
 *   FGMP_E2E_AUTH=1 npx playwright test
 *
 * Locally against an already-running server:
 *   PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test
 *
 * `tsconfig.json` excludes this file and `tests/e2e/` on purpose: the app's
 * typecheck runs on a machine where Playwright is not installed (it is
 * installed by the `ui` job only), so including them would fail `tsc` with
 * "Cannot find module '@playwright/test'". Playwright compiles the spec itself.
 *
 * The suite has two halves. The PUBLIC half (sign-in surface: rendering,
 * keyboard, responsive, RTL, accessibility) needs nothing but a server. The
 * AUTHENTICATED half needs a seeded database plus demo credentials, so it
 * skips itself unless FGMP_E2E_AUTH=1. That split is deliberate: a run that
 * cannot authenticate must not report the authenticated assertions as passing.
 */

import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";

/**
 * Some sandboxes cannot download a browser. `CHROMIUM_PATH` points the suite at
 * a Chromium that is already on disk (for example the one `@sparticuz/chromium`
 * unpacks). In CI it stays unset and Playwright uses its own build.
 */
const executablePath = process.env.CHROMIUM_PATH;

export default defineConfig({
  testDir: "tests/e2e",
  // `.e2e.ts`, not `.spec.ts`: `bun test` globs `*.spec.ts` and would try to run
  // Playwright's `test()` inside bun's runner, where it is not a test function.
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // A failed browser test in CI is usually a real defect; one retry separates
  // that from a cold-start flake without hiding it behind a high retry count.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
