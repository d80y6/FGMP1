#!/usr/bin/env node
/**
 * Find routes that call bootstrap() but do NOT authenticate via a NextAuth
 * session (Phase 3).
 *
 * bootstrap() resolves the authenticated user and THROWS when there is no
 * session — that is the Phase 0.3 fail-closed behaviour and it is correct. But a
 * route authenticated by something else (a service token, an API key, a
 * webhook signature) has no session, so its bootstrap() call throws for every
 * request. Two live instances were found this way:
 *
 *   POST /api/fgmp/iot/ingest          (x-api-key)
 *   GET  /api/fgmp/realtime/snapshot   (x-service-token)
 *
 * Both were dead in production and invisible in review, because neither
 * handler ever READ the value bootstrap() threw over.
 *
 * The signal is a route that calls bootstrap() and has NO session guard
 * anywhere in the file. It is a look-here heuristic, not a proof: a route could
 * legitimately delegate auth to a helper this cannot see. But every hit is
 * worth opening the file and checking.
 *
 * Usage: node scripts/find-non-session-bootstrap.mjs
 */
import fs from "node:fs";
import path from "node:path";

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/node_modules|\.next|\.git/.test(full)) walk(full, acc);
    } else if (/route\.tsx?$/.test(e.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const root = "src/app";
const routes = walk(root);
const hits = [];
let withBootstrap = 0;

for (const file of routes) {
  const src = fs.readFileSync(file, "utf8");
  if (!/await bootstrap\(\)/.test(src)) continue;
  withBootstrap++;

  // Session-based guards. requireAuth/requireRole read the NextAuth session and
  // return a SessionUser, so bootstrap() will find one.
  const sessionGuard =
    /requireAuth\s*\(/.test(src) ||
    /requireRole\s*\(/.test(src) ||
    /getServerSession\s*\(/.test(src) ||
    /isSuperAdminUser\s*\(/.test(src);

  if (sessionGuard) continue;

  // No session guard: what DOES it check?
  const mechanisms = [];
  if (/x-api-key|IOT_API_KEY/.test(src)) mechanisms.push("x-api-key");
  if (/x-service-token|REALTIME_SERVICE_TOKEN/.test(src)) mechanisms.push("x-service-token");
  if (/signature|hmac|webhook/i.test(src)) mechanisms.push("signature/webhook");
  hits.push({ file, mechanisms });
}

console.log(`routes calling bootstrap(): ${withBootstrap} of ${routes.length}`);
console.log(`routes with NO session guard: ${hits.length}\n`);
for (const h of hits) {
  console.log(`  ${h.file}`);
  console.log(`      authenticates via: ${h.mechanisms.join(", ") || "UNKNOWN — inspect"}`);
}
process.exit(hits.length ? 1 : 0);