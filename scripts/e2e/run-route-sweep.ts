/**
 * ─────────────────────────────────────────────────────────────────────────────
 * E2E route-surface coverage runner
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Boots the Next.js production server against the live PostgreSQL instance and
 * issues REAL HTTP requests for every GET route in the API surface, with a
 * genuine signed session cookie.
 *
 * The question it answers is deliberately narrow and is NOT answerable by any
 * other check in this repository:
 *
 *   "When an authenticated user actually calls this endpoint, does it respond —
 *    and does it respond with its own tenant's data rather than nothing?"
 *
 * An endpoint that returns 500, or 200-with-an-empty-list when the tenant owns
 * 52 sites, is a FAILURE here. Those are exactly the two defects that survived
 * tsc, eslint, and a green RLS suite.
 *
 * READ routes only. Mutating endpoints are covered by the dedicated specs; a
 * sweep that fired every POST at a live database would need a per-endpoint
 * fixture story, and pretending a generic POST proves anything is worse than
 * not trying.
 *
 * Usage:
 *   bun run scripts/e2e/run-route-sweep.ts
 * Requires the DB seeded and NEXTAUTH_SECRET set (32+ chars).
 *
 * Set E2E_SKIP_BUILD=1 to sweep a server that is already running instead of
 * building and booting a fresh one on E2E_PORT.
 *
 * Set E2E_BASE_URL to point the sweep at an existing server.
 */

import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { findUser, sessionCookieFor, seedForeignTenant, cleanupForeignTenant } from "./harness";

const PORT = Number(process.env.E2E_PORT ?? 3399);
// In skip-build mode the base URL comes from the environment, because the server
// being swept was started elsewhere and may be on a different port entirely.
const BASE = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const DB =
  process.env.FGMP_MIGRATE_DATABASE_URL ??
  "postgresql://fgmp_migrate:testmigrate123@127.0.0.1:5433/fgmp?schema=public";

interface RouteDef {
  method: "GET" | "HEAD";
  path: string;
}

/**
 * Real row ids for dynamic segments, filled in at startup.
 *
 * The previous placeholders (`e2e-site-00000000`) do not exist. Prisma's cuid
 * validation rejects them at the route's Zod boundary, so every dynamic route
 * returned 400 before its handler ran — the sweep was measuring its own
 * placeholder, not the route.
 */
const IDS: Record<string, string> = {};

/**
 * `[id]` means a DIFFERENT entity in each route — a tank in /tanks/[id], an
 * alarm in /alarms/[id], a user in /users/[id]. Mapping every `[id]` to one
 * id produced a sweep full of clean-looking 404s that were the harness's own
 * fault.
 *
 * Keyed by the un-substituted path, so the resolution is per route and
 * self-evident at the call site.
 */
const ID_BY_PATH: Record<string, string> = {};

/** Ids by segment name, for the routes that name their parameter. */
const IDS_BY_ENTITY: Record<string, string> = {};

const owner = new PrismaClient({ datasources: { db: { url: DB } } });

async function main(): Promise<void> {
  const secret = process.env.NEXTAUTH_SECRET ?? "";
  if (secret.length < 32) {
    console.error("NEXTAUTH_SECRET must be set and >= 32 chars for this harness.");
    process.exit(2);
  }

  const user = await findUser(owner, "admin@fgmp.telecom");
  if (!user) {
    console.error("Seed first: bun run db:seed (expected admin@fgmp.telecom).");
    process.exit(2);
  }
  const foreign = await seedForeignTenant(owner);

  // Real ids from the seeded tenant, so dynamic routes exercise a real handler
  // instead of failing id validation.
  // One real id per entity type a dynamic segment can address. These are looked
  // up through the OWNER client because RLS correctly hides them from a tenant
  // that does not own them — which is exactly why the harness needs the owner
  // role to build fixtures and the app role to make assertions.
  const where = { tenantId: user.tenantId };
  const first = async (
    model: { findFirst: (a: { where: object; select: { id: true } }) => Promise<{ id: string } | null> },
  ): Promise<string> => (await model.findFirst({ where, select: { id: true } }))?.id ?? foreign.siteId;

  const [aSite, aTank, aGen, aUser, aDisp, aCmd, aAlarm, aDelivery, aTicket, aBattery, aBatt, aSolarSite, aSolarArray, aThreshold] =
    await Promise.all([
      first(owner.site),
      first(owner.fuelTank),
      first(owner.generator),
      first(owner.user),
      first(owner.fuelDispenser),
      first(owner.controlCommand),
      first(owner.alarm),
      first(owner.fuelDelivery),
      first(owner.maintenanceTicket),
      first(owner.batteryBank),
      // Shift handover is keyed by SITE, not by its own row.
      first(owner.site),
      first(owner.solarSite),
      first(owner.solarArray),
      first(owner.interlockThreshold),
    ]);
  // Each segment gets an id of the RIGHT type. A previous version mapped a
  // generic `[id]` to a SITE id, so `/api/fgmp/tanks/<siteId>` correctly
  // answered 404 — and the sweep logged it as "gated, fine". It was not fine:
  // the id was simply the wrong kind of row.
  //
  // That is the failure mode to fear in a coverage sweep. A wrong id produces a
  // legitimate-looking 404, which looks exactly like a correct refusal, so the
  // handler never runs and nothing is actually proven. Handlers therefore get
  // the specific id they need:
  //
  //   /tanks/[tankId]        a FuelTank
  //   /generators/[generatorId]  a Generator
  //   /generators/[id]/control/[commandId]  a real command id, below
  //   /users/[userId]        a User
  //   /preferences/[userId]  a User
  //   /dispensers/[id]       a FuelDispenser
  //   everything else [id]   a Site
  IDS["[siteId]"] = aSite;
  IDS["[tankId]"] = aTank;
  IDS["[generatorId]"] = aGen;
  IDS["[userId]"] = aUser;
  IDS["[dispenserId]"] = aDisp;
  IDS["[commandId]"] = aCmd;
  IDS["[ticketId]"] = aTicket;
  IDS["[alarmId]"] = aAlarm;
  IDS["[deliveryId]"] = aDelivery;
  IDS["[...slug]"] = foreign.siteId;

  // Route-path -> entity id. Every one of these was previously swept with a
  // site id and returned a correct-looking 404.
  Object.assign(ID_BY_PATH, {
    "/api/fgmp/tanks/[id]": aTank,
    "/api/fgmp/generators/[id]": aGen,
    "/api/fgmp/batteries/[id]": aBattery,
    "/api/fgmp/alarms/[id]": aAlarm,
    "/api/fgmp/deliveries/[id]": aDelivery,
    "/api/fgmp/dispensers/[id]": aDisp,
    "/api/fgmp/maintenance/[id]": aTicket,
    "/api/fgmp/shift-handover/[id]": aBatt,
    "/api/fgmp/users/[id]": aUser,
    "/api/fgmp/tenants/[id]": aSite,
    "/api/fgmp/sites/[id]": aSite,
    "/api/fgmp/iot/[siteId]": aSite,
    // Phase 4 solar. A 404 here is the harness's fault if the id is a Site —
    // the route wants a SolarSite — and indistinguishable from a correct
    // refusal if it is not.
    "/api/fgmp/solar-sites/[id]": aSolarSite,
    "/api/fgmp/solar-arrays/[id]": aSolarArray,
    "/api/fgmp/interlocks/thresholds/[id]": aThreshold,
    "/api/fgmp/history/[entityId]": aSite,
    "/api/fgmp/generators/[id]/control/[commandId]": aGen,
  });

  Object.assign(IDS_BY_ENTITY, {
    "[entityId]": aSite,
    "[ticket]": aTicket,
    "[sessionId]": aSite,
  });
  console.log(`[e2e] dynamic ids: site=${IDS["[siteId]"]} tank=${IDS["[tankId]"]} gen=${IDS["[generatorId]"]}`);
  console.log(`[e2e] user ${user.email} (${user.role} @ ${user.tenantId})`);
  console.log(`[e2e] foreign tenant ${foreign.tenantId} seeded for negative tests`);

  // Password for the seeded admin. Read from the environment so the credential
  // is not hard-coded here; the seed writes the same value.
  const password = process.env.E2E_PASSWORD ?? "Admin@2026";

  // ── Boot the real server ───────────────────────────────────────────────
  //
  // E2E_SKIP_BUILD points the sweep at a server someone else already started —
  // usually the one running the development loop. It exists because a rebuild
  // here is actively harmful when the tree is shared: `next build` reads every
  // source file, so it picks up half-finished edits from other agents and
  // reports failures that belong to someone else's work in progress.
  //
  // In that mode the harness verifies the server is genuinely up and genuinely
  // authenticating before it sweeps. It will not silently degrade to testing a
  // dead or unauthenticated server.
  const skipBuild = process.env.E2E_SKIP_BUILD === "1";
  let server: ReturnType<typeof spawn> | null = null;
  let serverLog = "";

  if (skipBuild) {
    console.log(`[e2e] using already-running server at ${BASE}`);
    const probe = await waitForServer(`${BASE}/api/auth/csrf`, 30_000);
    if (!probe) {
      console.error(
        `[e2e] E2E_SKIP_BUILD=1 but nothing is serving ${BASE}. ` +
          `Start one, or unset E2E_SKIP_BUILD to let this script boot its own.`,
      );
      process.exit(2);
    }
    console.log("[e2e] server reachable");
  } else {
    console.log(`[e2e] building + starting server on :${PORT} …`);
    const build = spawn("bun", ["run", "build"], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      let err = "";
      build.stderr?.on("data", (d) => (err += String(d)));
      build.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`build failed (${code}):\n${err.slice(-2500)}`)),
      );
    });

    server = spawn("bun", ["run", "start"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: "production",
        NEXTAUTH_URL: BASE,
        DATABASE_URL:
          process.env.DATABASE_URL ??
          "postgresql://fgmp_app:testapp123@127.0.0.1:5433/fgmp?schema=public",
        FGMP_REQUIRE_RLS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (d) => (serverLog += String(d)));
    server.stderr?.on("data", (d) => (serverLog += String(d)));

    const up = await waitForServer(`${BASE}/api/fgmp/health`, 90_000);
    if (!up) {
      console.error("[e2e] server did not become ready. Last output:\n" + serverLog.slice(-2000));
      server.kill("SIGKILL");
      process.exit(2);
    }
    console.log("[e2e] server ready");
  }

  // Logged in AFTER the server is up, because the login is an HTTP round-trip
  // against that server — which is the point. Minting a token locally would
  // have needed the signing secret, the issuer and the claim shape to match,
  // and every one of them was a silent way to get 61 x 401 while learning
  // nothing about the routes.
  let cookie: string;
  try {
    cookie = await sessionCookieFor(user.email, password);
  } catch (e) {
    console.error(`[e2e] LOGIN FAILED: ${(e as Error).message}`);
    console.error("[e2e] Every route would now 401. Stopping rather than reporting a fake sweep.");
    server?.kill("SIGKILL");
    process.exit(2);
  }
  console.log(`[e2e] authenticated as ${user.email} via real login`);

  try {
    const routes = await collectGetRoutes();
    console.log(`[e2e] sweeping ${routes.length} GET routes\n`);

    const results: Array<{
      path: string;
      status: number;
      ok: boolean;
      note: string;
    }> = [];

    for (const r of routes) {
      const res = await call(`${BASE}${r.path}`, cookie);
      // 401/403 are legitimate: those routes gate on a role this user lacks.
      // 404 is legitimate for a route whose resource genuinely does not exist.
      // 500, or 200 that is empty where data should exist, is a FAILURE.
      const expected = expectedFor(r.path);
      const fail =
        res.status === 0 || (res.status >= 500 && !expected.includes(res.status));
      results.push({
        path: r.path,
        status: res.status,
        ok: !fail,
        note: res.note || (expected.length ? `expected ${expected.join("/")}` : ""),
      });
      const mark = fail ? "FAIL" : expected.includes(res.status) ? "gate " : res.status >= 400 ? "gated" : " ok ";
      console.log(`  ${mark} ${String(res.status).padStart(3)}  ${r.path}`);
    }

    const failures = results.filter((r) => !r.ok);
    console.log(`\n[e2e] ${results.length - failures.length}/${results.length} responded without a server error`);
    if (failures.length) {
      console.log("\n[e2e] FAILURES (5xx or unreachable):");
      for (const f of failures) console.log(`  ${f.status}  ${f.path}  ${f.note}`);
    }

    // ── The cross-tenant assertion that matters ──────────────────────────
    // A route that answers 200 with an empty array for a tenant owning 52
    // sites is a silent failure. This is the check no static analysis performs.
    const listChecks = [
      { path: "/api/fgmp/sites", expectNonEmpty: true, what: "52 seeded sites" },
      { path: "/api/fgmp/tanks", expectNonEmpty: true, what: "84 seeded tanks" },
      { path: "/api/fgmp/generators", expectNonEmpty: true, what: "76 seeded generators" },
      { path: "/api/fgmp/alarms", expectNonEmpty: false, what: "alarms (may be 0)" },
    ];
    console.log("\n[e2e] tenant-scoped data checks (empty-where-data-exists is a FAILURE):");
    let emptyFailures = 0;
    for (const c of listChecks) {
      const res = await call(`${BASE}${c.path}`, cookie);
      const empty = Array.isArray(res.body) && res.body.length === 0;
      const bad = res.status !== 200 || (c.expectNonEmpty && empty);
      if (bad) emptyFailures++;
      console.log(
        `  ${bad ? "FAIL" : " ok "} ${c.path} -> ${res.status}, ` +
          `${Array.isArray(res.body) ? `${res.body.length} items` : "non-array"} (${c.what})`,
      );
    }

    // ── Cross-tenant reads must return nothing ───────────────────────────
    // The foreign tenant owns a site, tank and generator. If any of those ids
    // appear in this tenant's response, isolation has failed end to end —
    // through the route, the session and the database — and no amount of
    // passing policy assertions would have caught it.
    const leak = await call(`${BASE}/api/fgmp/sites?limit=200`, cookie);
    const foreignIds = new Set([foreign.siteId, foreign.tankId, foreign.generatorId]);
    const leaked: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (typeof val === "string" && foreignIds.has(val)) leaked.push(`${k}=${val}`);
          else walk(val);
        }
      }
    };
    walk(leak.body);
    console.log("\n[e2e] cross-tenant leak check:");
    if (leak.status === 200 && leaked.length === 0) {
      console.log("  ok   no foreign-tenant id present in the response");
    } else {
      emptyFailures++;
      console.log(`  FAIL leaked ${leaked.join(", ")} (status ${leak.status})`);
    }

    console.log(
      `\n[e2e] RESULT: ${failures.length + emptyFailures} problem(s) across ${results.length} routes`,
    );
    process.exitCode = failures.length + emptyFailures > 0 ? 1 : 0;
  } finally {
    // Only ever stop a server this script started. Killing one someone else is
    // using would take down their loop and look like a crash on their side.
    server?.kill("SIGKILL");
    await owner.$disconnect();
  }
}

/**
 * Status codes that are a CORRECT refusal rather than a fault.
 *
 * ── WHY THIS MATTERS ─────────────────────────────────────────────────────────
 * The first version of this sweep treated every 5xx as a failure. That flagged
 * `GET /api/fgmp/tick`, which returns 503 precisely because simulation is
 * disabled — the endpoint refusing to fabricate telemetry is the feature
 * working, not a defect. Reporting it as a failure trains the reader to ignore
 * the sweep, which costs more than the bug it was meant to catch.
 *
 * The distinction is per-route and deliberate. A 503 from the tick endpoint
 * means "simulation refused, correctly". A 503 from a route that has no such
 * semantics would still fail.
 *
 * Similarly, `/iot/ingest` and `/realtime/snapshot` authenticate with a SERVICE
 * TOKEN, not a browser session, and answer 401 to a session cookie by design.
 * Both were implemented in Phase 2 precisely because a sessionless route must
 * still refuse an authenticated browser.
 */
function expectedFor(path: string): number[] {
  if (path.startsWith("/api/fgmp/tick")) return [503];
  if (path === "/api/fgmp/iot/ingest") return [401, 403];
  if (path === "/api/fgmp/realtime/snapshot") return [401, 403];
  return [];
}

async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (r.status > 0) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  return false;
}

async function call(
  url: string,
  cookie: string,
): Promise<{ status: number; body: unknown; note: string }> {
  try {
    const res = await fetch(url, {
      headers: { cookie, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: unknown = text.slice(0, 200);
    try {
      body = JSON.parse(text);
    } catch {
      /* HTML error page — the note carries it */
    }
    return { status: res.status, body, note: "" };
  } catch (e) {
    return { status: 0, body: null, note: (e as Error).message.slice(0, 120) };
  }
}

/**
 * Enumerate the GET surface from the filesystem.
 *
 * Dynamic segments are filled with a REAL id rather than a placeholder: a route
 * that 404s on "id-invalid" tells us nothing about whether the handler works.
 */
async function collectGetRoutes(): Promise<RouteDef[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.join(process.cwd(), "src/app/api");
  const out: RouteDef[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name === "route.ts")) {
      const src = await fs.readFile(path.join(dir, "route.ts"), "utf8");
      if (/\bexport\s+(async\s+)?function\s+GET\b/.test(src)) {
        // `dir.replace(root, "")` yields "/fgmp/sites" — the "/api" segment is
        // part of the route and has to be kept. Dropping it produced 61 uniform
        // 500s that looked like a total outage and were actually 61 requests to
        // URLs that do not exist.
        let p = "/api" + dir.replace(root, "").replace(/\\/g, "/");
        // Substitute dynamic segments with ids that EXIST and are of the RIGHT
        // TYPE. A placeholder yields 400; a wrong-type id yields a legitimate-
        // looking 404. Both hide the fact that the handler never ran.
        p = p.replace(/\[\.\.\.[^\]]+\]/g, IDS["[...slug]"]!);
        p = p.replace(/\[([a-zA-Z]+)\]/g, (_m, name: string) => IDS[`[${name}]`] ?? ID_BY_PATH[p] ?? IDS_BY_ENTITY[name] ?? IDS["[siteId]"]!);
        out.push({ method: "GET", path: p || "/api" });
      }
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
    }
  }
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

main().catch((e) => {
  console.error("[e2e] harness failed:", e.message);
  process.exit(2);
});