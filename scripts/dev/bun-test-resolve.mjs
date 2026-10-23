// Resolve hook: bun:test → shim, @/x → <repo>/src/x,
// and extensionless relative imports get .ts/.tsx resolution like bun/tsx.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tryFile(p) {
  for (const cand of [p, p + ".ts", p + ".tsx", p + ".js", p + ".mjs", p + "/index.ts"]) {
    try { if (fs.statSync(cand).isFile()) return cand; } catch {}
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "bun:test") {
    return { url: pathToFileURL(path.join(repo, "scripts/dev/bun-test-shim.mjs")).href, shortCircuit: true };
  }
  // bun allows cache-busting query strings on relative imports
  // ("../auth?cfg=0.92"); node's resolver does not — drop them.
  const clean = specifier.replace(/\?.*$/, "");
  let target = null;
  if (clean.startsWith("@/")) {
    target = tryFile(path.join(repo, "src", clean.slice(2)));
  } else if ((clean.startsWith("./") || clean.startsWith("../")) && context.parentURL) {
    const base = path.dirname(fileURLToPath(context.parentURL));
    target = tryFile(path.resolve(base, clean));
  }
  if (target) return { url: pathToFileURL(target).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
