#!/usr/bin/env node
/**
 * Phase 3 helper: wrap a `Promise.all([...])` of db calls in asTenant(user, …).
 *
 * Many Phase 3 routes share one shape — a single `Promise.all([...])` of
 * findMany/count calls, several carrying `include: { site }`. Scoping each
 * element individually is error-prone; this rewrites the whole array into one
 * transaction so every element AND every nested relation is scoped together.
 *
 * It is deliberately a LOOK-HERE pattern match, not a proof. After running it
 * you must still read the diff, because it cannot know whether a nested
 * relation needs a filter of its own. The authoritative control is the type
 * signature of asTenant, not this script.
 *
 * Usage: node scripts/wrap-promise-all.mjs <file> <userVar> <dbImportLine>
 */
import fs from "node:fs";

const [, , file, userVar = "me"] = process.argv;
if (!file) {
  console.error("usage: node scripts/wrap-promise-all.mjs <file> [userVar]");
  process.exit(2);
}

let src = fs.readFileSync(file, "utf8");
const before = src;

// 1. db.<model>.<op>( -> tx.<model>.<op>(   (only inside query position)
src = src.replace(/\bdb\.([a-z][A-Za-z]*)\.(findMany|findFirst|findUnique|count|aggregate|groupBy|create|update|updateMany|delete|deleteMany|upsert)\(/g, "tx.$1.$2(");

// 2. db.X.count() with NO args, e.g. db.site.count()  -> tx.site.count()
src = src.replace(/\bdb\.([a-z][A-Za-z]*)\.count\(\)/g, "tx.$1.count()");

// 3. Wrap the Promise.all itself.
src = src.replace(
  /await Promise\.all\(\[([\s\S]*?)\]\);/g,
  (_m, body) => `await asTenant(${userVar}, (tx) =>\n      Promise.all([${body}]),\n    );`,
);

if (src === before) {
  console.log(`${file}: no change`);
  process.exit(0);
}
fs.writeFileSync(file, src);
console.log(`${file}: wrapped`);