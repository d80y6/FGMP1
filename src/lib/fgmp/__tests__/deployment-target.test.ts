/**
 * One application host, and the repository has to say so.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * FGMP has been deployed on Netlify, Vercel, Render and Cloudflare, in that
 * order of discovery. Every platform left configuration behind: a blueprint, a
 * `vercel.json`, a health-check path tuned to one provider's probe. Deleted
 * files leave no trace, so the next person to run the deployment doc has to
 * guess which of four descriptions is the live one — and a stale blueprint is
 * worse than a missing one, because it looks supported.
 *
 * The project's answer is now a single target: Cloudflare Workers via OpenNext.
 * This test is the part of that decision a compiler can enforce:
 *
 *   1. no other platform's manifest exists;
 *   2. the build script is the Cloudflare build;
 *   3. `wrangler.jsonc` still names the Worker the way the service binding does;
 *   4. the deployment doc does not describe a retired platform as a target.
 *
 * It says nothing about whether the Worker is *deployed* — that is not a fact a
 * repository can hold, and claiming it from a file would be exactly the kind of
 * unverified statement this audit exists to remove.
 *
 * Run: bun test src/lib/fgmp/__tests__/deployment-target.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("deployment target", () => {
  test("no retired platform manifest is present", () => {
    const retired = [
      "render.yaml",
      "render.yml",
      "vercel.json",
      "netlify.toml",
      ".netlify",
      "app.json", // Heroku
      "fly.toml",
    ];
    const present = retired.filter((f) => existsSync(join(ROOT, f)));
    assert.deepEqual(present, [], `retired deploy manifests are back: ${present.join(", ")}`);
  });

  test("the build script is the Cloudflare/OpenNext build", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts.build, "opennextjs-cloudflare build");
    assert.match(pkg.scripts.deploy ?? "", /opennextjs-cloudflare deploy/);
  });

  test("wrangler.jsonc names the Worker and its self-reference consistently", () => {
    // The service binding must point at the Worker's own name; OpenNext's
    // Next.js server calls itself through it, and a mismatch is a runtime 500
    // on every request that renders a page.
    const raw = read("wrangler.jsonc");
    const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
      name: string;
      main: string;
      compatibility_flags?: string[];
      assets?: { directory?: string; binding?: string };
      services?: { binding: string; service: string }[];
    };
    assert.equal(json.name, "fgmp1");
    assert.equal(json.main, ".open-next/worker.js");
    assert.ok(json.compatibility_flags?.includes("nodejs_compat"), "nodejs_compat is required by the pg adapter");
    assert.equal(json.assets?.directory, ".open-next/assets");
    assert.equal(json.assets?.binding, "ASSETS");
    const self = json.services?.find((s) => s.binding === "WORKER_SELF_REFERENCE");
    assert.ok(self, "WORKER_SELF_REFERENCE binding is missing");
    assert.equal(self?.service, json.name, "self-reference must name the Worker itself");
  });

  test("the deployment doc describes Cloudflare, not a retired platform", () => {
    const doc = read("docs/DEPLOYMENT.md");
    // A heading like "## 4. Render" is the failure mode: an operator reads
    // sections, not prose, and a section titled with a retired platform is an
    // instruction to use it.
    const headings = doc.split("\n").filter((l) => /^#{2,3}\s/.test(l));
    const retiredHeading = headings.filter((h) => /\b(Render|Netlify|Vercel)\b/.test(h));
    assert.deepEqual(retiredHeading, [], `retired platform still has a section: ${retiredHeading.join(" | ")}`);

    assert.match(doc, /Cloudflare Workers/);
    // The retired platforms may only appear in prose that says they are gone.
    // Checked per paragraph, not per line: prose is wrapped at 80 columns, so
    // "Netlify, Vercel and Render were / retired" is ONE sentence split by a
    // newline by an editor, not a claim that they are current.
    for (const paragraph of doc.split(/\n\s*\n/)) {
      if (!/\b(Render|Netlify|Vercel)\b/.test(paragraph)) continue;
      assert.match(
        paragraph,
        /retired|deleted|no longer|end of life/i,
        `docs/DEPLOYMENT.md still treats a retired platform as current: "${paragraph.trim().slice(0, 120)}…"`,
      );
    }
  });

  test("no source file references the retired blueprint", () => {
    // A comment pointing at `render.yaml` sends the next reader to a file that
    // does not exist. Historical documents under docs/history/ are exempt: they
    // are records of what was true then, not instructions.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (["node_modules", ".next", ".git", "history"].includes(entry)) continue;
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx|md|yml|yaml|json|mjs)$/.test(entry)) continue;
        const text = readFileSync(path, "utf8");
        if (/render\.yaml/.test(text) && !/deleted|retired|no longer/i.test(text)) {
          offenders.push(path.slice(ROOT.length + 1));
        }
      }
    };
    walk(join(ROOT, "src"));
    walk(join(ROOT, "docs"));
    walk(join(ROOT, "scripts"));
    assert.deepEqual(offenders, [], `files still point at the deleted blueprint: ${offenders.join(", ")}`);
  });
});
