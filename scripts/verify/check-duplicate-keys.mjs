#!/usr/bin/env node
/**
 * Duplicate object-key detector (Phase 3).
 *
 * A duplicated `where:` key is the one scoping mistake that TYPECHECKS CLEANLY.
 * JavaScript object literals keep the LAST value, so
 *
 *     db.x.findFirst({ where: { id, tenantId }, where: { id } })
 *
 * silently discards the tenant filter and compiles without complaint. It has
 * been hit independently by three agents during this phase, so it gets an
 * explicit check rather than reliance on review.
 *
 * Why this lives in the repo and not /tmp: an agent's authoritative work list
 * in /tmp was found overwritten by another agent during Phase 3. Treat
 * `npx node scripts/verify/check-duplicate-keys.mjs <dir>` as the check, and note that
 * it is a LOOK-HERE pattern match, not a proof — the authoritative control is
 * still the type signature of asTenant/asTenantForAnotherTenant.
 *
 * Usage: node scripts/verify/check-duplicate-keys.mjs src/app/api/fgmp
 */
import fs from "node:fs";
import path from "node:path";

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|\.next|\.git/.test(full)) walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const root = process.argv[2] ?? "src";
let findings = 0;

for (const file of walk(root)) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // Find the start of an object literal.
    const start = line.match(/^\s*where:\s*\{|^\s*(const|let)\s+\w+\s*=\s*\{\s*$/);
    if (!start) return;
    let depth = 0;
    let started = false;
    const block = [];
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") { depth++; started = true; }
        else if (ch === "}") depth--;
      }
      block.push(lines[j]);
      if (started && depth <= 0) break;
    }
    const keys = [...block.join("\n").matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((x) => x[1]);
    const seen = new Set();
    const dups = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    if (dups.length) {
      console.log(`${file}:${i + 1}  duplicate key(s): ${[...new Set(dups)].join(", ")}`);
      findings++;
    }
  });
}

console.log(findings ? `\n${findings} object literal(s) with duplicate keys` : "no duplicate object keys found");
process.exit(findings ? 1 : 0);