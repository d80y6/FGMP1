// Driver: node --experimental-strip-types scripts/dev/bun-test-run.mjs <file.test.ts> [...more]
// Registers the bun:test shim, imports each test file, then executes
// the collected suites and prints a summary.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
register("./bun-test-resolve.mjs", pathToFileURL(repo + "/scripts/"));

const { __collect } = await import("./bun-test-shim.mjs");

let pass = 0, fail = 0;
const failures = [];

async function runSuite(suite, prefix) {
  for (const h of suite.beforeAll) await h();
  for (const t of suite.tests) {
    const full = `${prefix} › ${t.name}`;
    try {
      for (const h of suite.beforeEach) await h();
      await t.fn();
      for (const h of suite.afterEach) await h();
      pass++;
    } catch (err) {
      fail++;
      failures.push({ full, err });
    }
  }
  for (const s of suite.children ?? []) await runSuite(s, `${prefix} › ${s.name}`);
  for (const h of suite.afterAll) await h();
}

const files = process.argv.slice(2);
for (const f of files) {
  try {
    await import(pathToFileURL(path.resolve(f)).href);
  } catch (err) {
    fail++;
    failures.push({ full: `IMPORT ${f}`, err });
  }
}

const root = __collect();
for (const s of root.suites) await runSuite(s, s.name);

for (const { full, err } of failures) {
  console.log(`✗ ${full}\n    ${err.message?.split("\n").slice(0, 3).join("\n    ")}`);
}
console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed  (${files.length} file(s))`);
process.exit(fail ? 1 : 0);
