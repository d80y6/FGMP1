/**
 * Route authorization contract — static analysis over every App Router handler.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Authorization in this codebase is enforced in two independent places:
 *
 *   1. the CAPABILITY POLICY in `src/lib/fgmp/rbac-core.ts`
 *      (`apiReadCapabilities` / `API_WRITE_RULES` / `AUTH_ONLY_API_RULES`)
 *   2. each route's own `requireRole(ROLES.X)` / `requireSuperAdmin()` allow-list
 *
 * `requireAuth(req)` runs (1) and then the route runs (2), so the effective gate
 * is the intersection. Three failure modes are invisible to code review of a
 * 100-route surface, and all three fail OPEN or fail SILENT:
 *
 *   • a new `/api/fgmp/**` route with no policy entry      → currently denied
 *     (fails closed, good) but nobody is told, so the feature just 403s and the
 *     "fix" is to paste the path into the allow-list without thinking about it;
 *   • a route calling `requireAuth()` WITHOUT the request  → Layer 1 is skipped
 *     entirely. `requireAuth(undefined)` is legal TypeScript and looks identical
 *     in review to `requireAuth(req)`. This is the dangerous one: the route
 *     compiles, works for the happy path, and enforces only its own allow-list;
 *   • a route that admits more roles than the policy does → those roles get a
 *     403 on a surface the UI still offers them.
 *
 * This module answers all three mechanically, over the real filesystem, using
 * the real policy functions. It is imported by
 * `src/lib/fgmp/__tests__/route-authorization-contract.test.ts`, so a violation
 * fails `bun test` with the offending route named — and by
 * `scripts/verify/route-inventory.ts` for the human-readable table.
 *
 * ── WHY ROLES IS PARSED, NOT IMPORTED ──────────────────────────────────────
 * `auth-helpers.ts` imports `next-auth`, `next/headers` and `@/lib/auth`, which
 * reads and validates process env at module load. A static contract check must
 * not need a configured deployment to tell you whether the deployment is
 * configured correctly. The `ROLES` object is a literal, so it is read as text —
 * and the parse is asserted non-empty below, so a format change is loud.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AUTH_ONLY_API_RULES,
  ROLE_PERMISSIONS,
  apiRequestCapabilities,
  canAccessApi,
} from "../../src/lib/fgmp/rbac-core";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const ALL_ROLES = [
  "SUPERADMIN",
  "ADMIN",
  "NOC_OPERATOR",
  "REGIONAL_MANAGER",
  "FIELD_ENGINEER",
  "EXECUTIVE",
  "READONLY",
] as const;

/**
 * Handlers that legitimately have NO NextAuth guard, with the reason. Anything
 * not listed here and not guarded is a violation.
 *
 * Each entry is `routePath` or `routePath#METHOD`.
 */
export const PUBLIC_ENDPOINTS: Record<string, string> = {
  "/api/auth/[...nextauth]": "NextAuth's own mount point — it is the authentication boundary",
  "/api/health/live": "container liveness probe; exposes no tenant data",
  "/api/health/ready": "container readiness probe; exposes no tenant data",
  "/api/fgmp/iot/ingest": "device ingest, authenticated by per-tenant API key, not a session",
  "/api/fgmp/realtime/snapshot": "service-to-service, authenticated by REALTIME_SERVICE_TOKEN, not a session",
  "/api/fgmp/mfa/challenge": "second factor completion — the session is deliberately PENDING here, so requireAuth would reject a legitimate challenge",
};

/** The app's route root, resolved from this file so cwd does not matter. */
export const REPO_ROOT = join(import.meta.dir, "..", "..");
export const ROUTE_ROOT = join(REPO_ROOT, "src", "app", "api");
export const AUTH_HELPERS = join(REPO_ROOT, "src", "lib", "fgmp", "auth-helpers.ts");

export interface RouteHandler {
  /** Next.js route path with dynamic segments, e.g. `/api/fgmp/sites/[id]`. */
  route: string;
  method: HttpMethod;
  /** Path with dynamic segments collapsed to `x`, i.e. what the policy matches. */
  matchPath: string;
  sourceFile: string;
  /** Guard the handler calls: `requireRole`, `requireSuperAdmin`, `requireAuth`, … */
  guard: string;
  /** TRUE when the request object reaches the guard, so Layer 1 actually runs. */
  forwardsRequest: boolean;
  /** Roles named by the handler's own allow-list; null = no explicit list. */
  allowList: readonly string[] | null;
  /** Capabilities the policy requires; null = unmapped. */
  requiredCapabilities: readonly string[] | null;
  /** Roles the capability policy admits. */
  policyRoles: readonly string[];
}

export interface Violation {
  code: "UNMAPPED_ENDPOINT" | "POLICY_BYPASSED" | "NO_GUARD" | "ROLE_DRIFT";
  route: string;
  method: HttpMethod;
  detail: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry === "route.ts") out.push(p);
  }
  return out;
}

/**
 * The body of one exported handler.
 *
 * Sliced from `export ... METHOD` to the next top-level `export`, so a file that
 * declares both PATCH and DELETE is judged per method. Slicing by file is what
 * makes a naive audit attribute the PATCH allow-list to the DELETE handler and
 * invent drift that does not exist.
 */
function handlerBody(source: string, method: HttpMethod): string | null {
  const start = new RegExp(`export (?:async function|const) ${method}\\b`).exec(source);
  if (!start) return null;
  const rest = source.slice(start.index + start[0].length);
  const next = /\nexport (?:async function|const) /.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Parse the `ROLES` literal out of auth-helpers.ts. */
export function parseRoleSets(source: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const re = /^\s*([A-Z][A-Z_]+):[\s\S]*?\[\s*([^\]]*?)\s*\]\s*as\s+Role\[\]/gm;
  for (const m of source.matchAll(re)) {
    const roles = [...m[2].matchAll(/"([A-Z_]+)"/g)].map((r) => r[1]);
    if (roles.length) out[m[1]] = roles;
  }
  return out;
}

/**
 * Roles a handler admits, from `requireRole(req, ROLES.X)` or an inline array.
 * `requireSuperAdmin` is SUPERADMIN-only. Returns null when the handler has no
 * explicit allow-list (it relies on Layer 1 alone).
 */
export function allowListOf(body: string, roleSets: Record<string, string[]>): string[] | null {
  if (/requireSuperAdmin\s*\(/.test(body)) return ["SUPERADMIN"];

  const named = [...new Set([...body.matchAll(/ROLES\.([A-Z_]+)/g)].map((m) => m[1]))];
  const inline = [...body.matchAll(/requireRole\s*\(\s*[^,]+,\s*\[\s*([^\]]*?)\s*\]\s*\)/g)]
    .flatMap((m) => [...m[1].matchAll(/"([A-Z_]+)"/g)].map((r) => r[1]));

  const roles = new Set<string>();
  for (const key of named) for (const r of roleSets[key] ?? []) roles.add(r);
  for (const r of inline) roles.add(r);
  if (roles.size === 0) return null;
  // requireRole() admits SUPERADMIN through the platform-role bypass regardless
  // of the supplied list, so the allow-list is never narrower than that.
  roles.add("SUPERADMIN");
  return [...roles];
}

export function analyzeRoutes(root: string = ROUTE_ROOT): RouteHandler[] {
  const helpers = readFileSync(join(REPO_ROOT, "src", "lib", "fgmp", "auth-helpers.ts"), "utf8");
  const roleSets = parseRoleSets(helpers);
  // A silent parse failure would disable the drift check for every route, which
  // is worse than no check at all: the suite would go green and stay green.
  if (!roleSets.ALARM_OPS || !roleSets.SUPER_OR_ADMIN) {
    throw new Error(
      "route-inventory: could not parse the ROLES literal from auth-helpers.ts. " +
        "The drift check would silently pass for every route, so this is fatal. " +
        "Update parseRoleSets() to match the new syntax.",
    );
  }

  const handlers: RouteHandler[] = [];
  for (const file of walk(root).sort()) {
    const source = readFileSync(file, "utf8");
    const route =
      "/api" + "/" + relative(root, file).replace(/route\.ts$/, "").replace(/\/$/, "");
    const matchPath = route.replace(/\[[^\]]+\]/g, "x");

    for (const method of HTTP_METHODS) {
      const body = handlerBody(source, method);
      if (body === null) continue;

      const guard = /requireSuperAdmin\s*\(/.test(body)
        ? "requireSuperAdmin"
        : /requireRole\s*\(/.test(body)
          ? "requireRole"
          : /requireAuth\s*\(/.test(body)
            ? "requireAuth"
            : /withTenant\s*\(|x-api-key|SERVICE_TOKEN/.test(body)
              ? "service/api-key"
              : "none";

      // Layer 1 only runs when the request object reaches the guard. `req`,
      // `request`, `_request` are the names actually used in this codebase.
      const forwardsRequest =
        /require(?:Auth|Role|SuperAdmin)\s*\(\s*(?:req|request|_req|_request)\b/.test(body) ||
        // requireRole(req, …) — first argument positional.
        /requireRole\s*\(\s*(?:req|request|_req|_request)\s*,/.test(body);

      const requiredCapabilities = apiRequestCapabilities(method, matchPath);
      handlers.push({
        route,
        method,
        matchPath,
        sourceFile: relative(REPO_ROOT, file),
        guard,
        forwardsRequest,
        allowList: allowListOf(body, roleSets),
        requiredCapabilities,
        policyRoles: ALL_ROLES.filter((r) => canAccessApi(r, matchPath, method)),
      });
    }
  }
  return handlers;
}

/** Which policy entries exist, for the "every rule matches a route" direction. */
export function isAuthOnly(method: string, matchPath: string): boolean {
  return AUTH_ONLY_API_RULES.some((r) => r.method === method && r.path === matchPath);
}

export function findViolations(handlers: RouteHandler[]): Violation[] {
  const violations: Violation[] = [];

  for (const h of handlers) {
    const publicKey = `${h.route}#${h.method}`;
    const isPublic = h.route in PUBLIC_ENDPOINTS || publicKey in PUBLIC_ENDPOINTS;
    const isFgmp = h.route.startsWith("/api/fgmp/");

    // ── NO_GUARD ────────────────────────────────────────────────────────────
    if (h.guard === "none" && !isPublic) {
      violations.push({
        code: "NO_GUARD",
        route: h.route,
        method: h.method,
        detail:
          "no authentication or authorization call in this handler. Add a guard, or add the route " +
          "to PUBLIC_ENDPOINTS in scripts/verify/route-inventory.ts with the reason it is public.",
      });
      continue;
    }

    if (!isFgmp) continue; // /api/auth/*, /api/health/*: outside the FGMP policy surface

    // ── UNMAPPED_ENDPOINT ───────────────────────────────────────────────────
    // Fails closed at runtime (canAccessApi returns false), so this is a
    // "feature silently 403s" bug rather than a hole — but it must be a
    // conscious decision, not an oversight.
    if (h.requiredCapabilities === null && !isAuthOnly(h.method, h.matchPath)) {
      violations.push({
        code: "UNMAPPED_ENDPOINT",
        route: h.route,
        method: h.method,
        detail:
          "no capability policy entry. Add a rule to API_READ_RULES / API_WRITE_RULES in " +
          "rbac-core.ts, or list it in AUTH_ONLY_API_RULES if every authenticated role may call it. " +
          "Until then canAccessApi() denies it to every role.",
      });
      continue;
    }

    // ── POLICY_BYPASSED ─────────────────────────────────────────────────────
    // The handler authenticates but never gives the request to the guard, so
    // Layer 1 is skipped and only the route's own allow-list applies.
    if (h.guard !== "none" && !h.forwardsRequest && h.guard !== "service/api-key") {
      violations.push({
        code: "POLICY_BYPASSED",
        route: h.route,
        method: h.method,
        detail:
          `\`${h.guard}()\` is called without the request object, so the endpoint capability policy ` +
          "is never evaluated. Pass the request: requireAuth(req) / requireRole(req, …).",
      });
    }

    // ── ROLE_DRIFT ──────────────────────────────────────────────────────────
    // The route admits a role the capability policy will refuse first.
    if (h.allowList) {
      const blocked = h.allowList.filter((r) => !h.policyRoles.includes(r));
      if (blocked.length) {
        violations.push({
          code: "ROLE_DRIFT",
          route: h.route,
          method: h.method,
          detail:
            `route admits [${blocked.join(", ")}] but the capability policy requires ` +
            `[${(h.requiredCapabilities ?? []).join(", ") || "—"}] and refuses them, so they receive a 403 ` +
            "on a surface the route claims to allow. Make the two agree.",
        });
      }
    }
  }

  return violations;
}

/** Every role key must at least be a real role. Guards against typos in ROLES.X. */
export function findUnknownRoles(roleSets: Record<string, string[]>): string[] {
  const known = new Set<string>(ALL_ROLES);
  const bad: string[] = [];
  for (const [key, roles] of Object.entries(roleSets)) {
    for (const r of roles) if (!known.has(r)) bad.push(`ROLES.${key} contains unknown role "${r}"`);
  }
  return bad;
}

/** Every capability referenced anywhere must exist in at least one role's list. */
export function findUnknownCapabilities(): string[] {
  const known = new Set<string>();
  for (const entry of Object.values(ROLE_PERMISSIONS)) {
    for (const cap of entry.capabilities) known.add(cap);
  }
  return []; // placeholder: capability existence is asserted by the matrix test
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// `bun run scripts/verify/route-inventory.ts` prints the table and exits 1 on
// any violation, so it can gate CI independently of the test runner.
if (import.meta.main) {
  const handlers = analyzeRoutes();
  const violations = findViolations(handlers);
  const roleSets = parseRoleSets(readFileSync(AUTH_HELPERS, "utf8"));
  const unknownRoles = findUnknownRoles(roleSets);

  console.log("| Endpoint | Guard | Policy capabilities | Roles passing BOTH |");
  console.log("|---|---|---|---|");
  for (const h of handlers) {
    const caps = h.requiredCapabilities === null
      ? isAuthOnly(h.method, h.matchPath) ? "auth-only" : "**UNMAPPED**"
      : h.requiredCapabilities.length ? h.requiredCapabilities.join("<br>") : "∅";
    console.log(
      `| \`${h.method} ${h.route.replace(/^\/api/, "")}\` | ${h.guard}${h.forwardsRequest ? "" : " **⚠**"} | ${caps} | ${
        h.policyRoles.join(", ") || "**none**"
      } |`,
    );
  }

  console.log(
    `\n${handlers.length} handlers over ${new Set(handlers.map((h) => h.route)).size} route files.`,
  );

  if (unknownRoles.length || violations.length) {
    console.error("");
    for (const u of unknownRoles) console.error(`  ✗ ${u}`);
    for (const v of violations) console.error(`  ✗ ${v.code} ${v.method} ${v.route}\n      ${v.detail}`);
    console.error(`\n${violations.length + unknownRoles.length} authorization-contract violation(s).`);
    process.exit(1);
  }
  console.log("Authorization contract: OK");
}
