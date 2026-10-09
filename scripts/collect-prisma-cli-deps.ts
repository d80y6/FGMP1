/**
 * Collect the Prisma CLI's transitive dependency closure for the runtime image.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `prisma migrate deploy` runs through @prisma/config, which has a deep
 * dependency closure of its own. The Dockerfile used to hand-enumerate a few of
 * those packages, and the image still failed to boot — twice, in sequence:
 *
 *   error: Cannot find package 'effect'    from '@prisma/config/dist/index.js'
 *   error: Cannot find package 'pure-rand' from 'fast-check/lib/check/runner/…'
 *
 * The second failure is the instructive one: `pure-rand` is a dependency of
 * `fast-check`, which was itself in the hand-written list. Fixing it by adding
 * one more line would have been fixing the symptom, and the next Prisma release
 * would have produced a third.
 *
 * So this walks the INSTALLED tree — the `dependencies` field of each package's
 * package.json, breadth-first from the CLI entry points — and emits the real
 * closure. It cannot drift, because it is derived from what is actually
 * installed rather than from what someone believed was installed.
 *
 * Run in the builder stage:
 *   bun scripts/collect-prisma-cli-deps.ts
 * Produces:
 *   /tmp/prisma-cli-deps/node_modules/…  a copy of each package
 *   /tmp/prisma-cli-deps/packages.txt     one package name per line
 */

import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const NODE_MODULES = process.env.P5_NM ?? "/app/node_modules";
const OUT = "/tmp/prisma-cli-deps";

/** Entry points for the CLI. `prisma` re-exports @prisma/config's loader. */
const ROOTS = ["prisma", "@prisma/config"];

interface PackageJson {
  dependencies?: Record<string, string>;
}

function readPackageJson(name: string): PackageJson | null {
  const p = join(NODE_MODULES, name, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

const closure = new Set<string>();
const missing: string[] = [];
const queue: string[] = [...ROOTS];

while (queue.length > 0) {
  // pop() is typed `T | undefined`; the length guard above makes it defined,
  // but TypeScript cannot see that, so narrow it explicitly.
  const name = queue.pop();
  if (name === undefined) break;
  if (closure.has(name)) continue;
  const pkg = readPackageJson(name);
  if (!pkg) {
    missing.push(name);
    continue;
  }
  closure.add(name);
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (!closure.has(dep)) queue.push(dep);
  }
}

if (missing.length > 0) {
  // Not fatal on its own — an optional or platform-specific dependency may be
  // absent. Logged so an unexplained CLI failure can be traced back here.
  console.log(`[prisma-cli-deps] ${missing.length} dependency/dependencies not present: ${missing.join(", ")}`);
}

const names = [...closure].sort();
mkdirSync(join(OUT, "node_modules"), { recursive: true });

for (const name of names) {
  const src = join(NODE_MODULES, name);
  if (!existsSync(src)) continue;
  // Copy into the same relative layout, so scoped names keep their directory.
  const dest = join(OUT, "node_modules", name);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: false });
}

writeFileSync(join(OUT, "packages.txt"), `${names.join("\n")}\n`);

console.log(`[prisma-cli-deps] copied ${names.length} package(s) into ${OUT}`);
