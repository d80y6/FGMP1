/**
 * Live authorization matrix — real HTTP, real sessions, real database.
 *
 * ── WHAT THIS PROVES THAT THE UNIT TESTS CANNOT ────────────────────────────
 * `route-authorization-contract.test.ts` proves the two policy layers agree and
 * that no route is unmapped. It cannot prove that the ROUTE actually returns 403
 * — that needs a running server, a real NextAuth session and a real database.
 * This script does exactly that, for every role × every endpoint.
 *
 * ── WHY IT REFUSES TO RUN WITHOUT CONFIGURATION ────────────────────────────
 * A verification script that silently passes when it cannot reach anything is
 * worse than no script: it manufactures the evidence the brief asks for. If
 * `FGMP_BASE_URL` is unset this exits non-zero with an explanation rather than
 * printing a green tick.
 *
 * ── WHY THE PROBES ARE NON-DESTRUCTIVE ─────────────────────────────────────
 * The brief forbids destructive production operations, so:
 *   • every id used is a literal that does not exist (`__authz_probe__`), so an
 *     authorized DELETE/PATCH reaches the handler and gets 404 — the handler's
 *     own "not found" path — without touching a row;
 *   • POST bodies are deliberately incomplete, so an authorized call stops at
 *     validation with 400 and a denied call stops at the guard with 403.
 * The status classes therefore separate cleanly:
 *     401 / 403                → DENIED   (authorization refused)
 *     anything else            → ALLOWED  (authorization passed; the request then
 *                                          failed its own validation or found
 *                                          nothing — which is the point)
 *   429                        → ALLOWED but rate-limited; reported separately,
 *                                never counted as a pass for a DENIED expectation.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *   FGMP_BASE_URL=http://localhost:3000 \
 *   FGMP_AUTHZ_PASSWORD_ADMIN='…' \
 *   bun run scripts/verify/authz-live.ts
 *
 * Credentials default to the seeded demo e-mails; give each role its own
 * password variable, or a single `FGMP_AUTHZ_PASSWORD` shared by the demo users.
 * The script never prints a password and never prints a session cookie.
 */

import { canAccessApi } from "../../src/lib/fgmp/rbac-core";

const ROLES = [
  "SUPERADMIN",
  "ADMIN",
  "NOC_OPERATOR",
  "REGIONAL_MANAGER",
  "FIELD_ENGINEER",
  "EXECUTIVE",
  "READONLY",
] as const;
type Role = (typeof ROLES)[number];

/** Seeded demo accounts (scripts/supabase/03-seed.sql). */
const DEMO_EMAIL: Record<Role, string> = {
  SUPERADMIN: "superadmin@fgmp.telecom",
  ADMIN: "admin@fgmp.telecom",
  NOC_OPERATOR: "noc@fgmp.telecom",
  REGIONAL_MANAGER: "regional@fgmp.telecom",
  FIELD_ENGINEER: "field@fgmp.telecom",
  EXECUTIVE: "exec@fgmp.telecom",
  READONLY: "readonly@fgmp.telecom",
};

/** A literal that cannot be a real row id. */
const GHOST = "__authz_probe_does_not_exist__";

interface Probe {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** Body for write probes: valid JSON, deliberately failing validation. */
  body?: unknown;
  /** Query string appended for GET probes whose policy depends on it. */
  note?: string;
}

/**
 * One probe per (method, policy shape). Deliberately not every route: the
 * question is whether each POLICY RULE is enforced, and routes that share a
 * prefix share a rule. Add entries when you add rules.
 */
const PROBES: Probe[] = [
  { method: "GET", path: "/api/fgmp/state" },
  { method: "GET", path: "/api/fgmp/sites" },
  { method: "GET", path: "/api/fgmp/sites/" + GHOST },
  { method: "POST", path: "/api/fgmp/sites", body: {} },
  { method: "DELETE", path: "/api/fgmp/sites/" + GHOST },
  { method: "GET", path: "/api/fgmp/generators" },
  { method: "POST", path: "/api/fgmp/generators/" + GHOST + "/control", body: {} },
  { method: "GET", path: "/api/fgmp/alarms" },
  { method: "POST", path: "/api/fgmp/alarms", body: {} },
  { method: "GET", path: "/api/fgmp/users" },
  { method: "POST", path: "/api/fgmp/users", body: {} },
  { method: "PUT", path: "/api/fgmp/users/" + GHOST, body: {} },
  { method: "DELETE", path: "/api/fgmp/users/" + GHOST },
  { method: "GET", path: "/api/fgmp/tenants" },
  { method: "POST", path: "/api/fgmp/tenants", body: {} },
  { method: "GET", path: "/api/fgmp/platform/audit" },
  { method: "GET", path: "/api/fgmp/platform/support-sessions" },
  { method: "POST", path: "/api/fgmp/platform/support-sessions", body: {} },
  { method: "GET", path: "/api/fgmp/health" },
  { method: "GET", path: "/api/fgmp/settings" },
  { method: "PATCH", path: "/api/fgmp/settings", body: {} },
  { method: "GET", path: "/api/fgmp/audit" },
  { method: "GET", path: "/api/fgmp/analytics?projection=dashboard" },
  { method: "GET", path: "/api/fgmp/analytics?projection=analytics" },
  { method: "GET", path: "/api/fgmp/reports" },
  { method: "GET", path: "/api/fgmp/reports?period=daily" },
  { method: "GET", path: "/api/fgmp/export?type=sites" },
  { method: "GET", path: "/api/fgmp/export?type=users" },
  { method: "GET", path: "/api/fgmp/dispensers" },
  { method: "POST", path: "/api/fgmp/dispensers/" + GHOST + "/control", body: {} },
  { method: "POST", path: "/api/fgmp/notifications", body: {} },
  { method: "POST", path: "/api/fgmp/tick", body: {} },
  { method: "POST", path: "/api/fgmp/maintenance", body: {} },
  { method: "GET", path: "/api/fgmp/admin/tenant-isolation-test" },
  { method: "GET", path: "/api/fgmp/me" },
  { method: "GET", path: "/api/fgmp/mfa/status" },
  { method: "POST", path: "/api/fgmp/me/preview-role", body: { role: "READONLY" } },
];

type Outcome = "ALLOWED" | "DENIED" | "RATE_LIMITED" | "ERROR";

interface Result {
  role: Role;
  probe: Probe;
  status: number;
  outcome: Outcome;
  expected: boolean;
  ok: boolean;
}

function passwordFor(role: Role): string | undefined {
  return process.env[`FGMP_AUTHZ_PASSWORD_${role}`] ?? process.env.FGMP_AUTHZ_PASSWORD;
}

function baseUrl(): string {
  const v = process.env.FGMP_BASE_URL;
  if (!v) {
    console.error(
      "FGMP_BASE_URL is not set.\n\n" +
        "This script performs a REAL end-to-end authorization matrix: it signs in as each\n" +
        "seeded role over HTTP and calls every endpoint, so it needs a running deployment\n" +
        "with a seeded database. It refuses to run (rather than printing a pass) because an\n" +
        "unverified matrix must never look like a verified one.\n\n" +
        "  FGMP_BASE_URL=http://localhost:3000 FGMP_AUTHZ_PASSWORD='Admin@2026' \\\n" +
        "    bun run scripts/verify/authz-live.ts\n\n" +
        "See docs/AUTHZ.md §Verification for the full procedure, including the\n" +
        "FGMP_ALLOW_DEMO_CREDENTIALS=1 requirement when NODE_ENV=production.",
    );
    process.exit(2);
  }
  return v.replace(/\/$/, "");
}

/**
 * Sign in through NextAuth's credentials flow and return the session cookie.
 * Returns null when the deployment rejects the credentials.
 */
async function signIn(url: string, email: string, password: string): Promise<string | null> {
  // 1. CSRF token, with its cookie.
  const csrfRes = await fetch(`${url}/api/auth/csrf`, { redirect: "manual" });
  const csrfCookies = csrfRes.headers.getSetCookie?.() ?? [];
  const csrfJson = (await csrfRes.json()) as { csrfToken?: string };
  if (!csrfJson.csrfToken) return null;

  // 2. Credential submission.
  const body = new URLSearchParams({
    csrfToken: csrfJson.csrfToken,
    email,
    password,
    callbackUrl: url,
    json: "true",
  });
  const loginRes = await fetch(`${url}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      cookie: csrfCookies.map((c) => c.split(";")[0]).join("; "),
    },
    body,
    redirect: "manual",
  });
  if (loginRes.status !== 200 && loginRes.status !== 302) return null;

  // 3. Collect the session cookie(s) and verify the session actually resolves.
  const sessionCookies = (loginRes.headers.getSetCookie?.() ?? [])
    .filter((c) => /session-token|next-auth/i.test(c))
    .map((c) => c.split(";")[0]);
  if (sessionCookies.length === 0) return null;
  const cookie = sessionCookies.join("; ");

  const me = await fetch(`${url}/api/auth/session`, { headers: { cookie } });
  const meJson = (await me.json()) as { user?: { email?: string } } | null;
  if (!meJson?.user?.email) return null;
  return cookie;
}

function classify(status: number): Outcome {
  if (status === 429) return "RATE_LIMITED";
  if (status === 401 || status === 403) return "DENIED";
  if (status >= 500) return "ERROR";
  return "ALLOWED";
}

async function probe(url: string, cookie: string | null, p: Probe): Promise<number> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (p.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${url}${p.path}`, {
    method: p.method,
    headers,
    body: p.body === undefined ? undefined : JSON.stringify(p.body),
    redirect: "manual",
  });
  return res.status;
}

async function main(): Promise<void> {
  const url = baseUrl();

  const results: Result[] = [];
  const unavailable: Role[] = [];

  // Unauthenticated baseline first: every /api/fgmp endpoint must refuse a
  // request that carries no session at all. Kept separate from `results` so it
  // is never counted as a role row.
  const anonFailures: { probe: Probe; status: number }[] = [];
  for (const p of PROBES) {
    const status = await probe(url, null, p);
    if (classify(status) !== "DENIED") anonFailures.push({ probe: p, status });
  }

  for (const role of ROLES) {
    const password = passwordFor(role);
    if (!password) {
      unavailable.push(role);
      continue;
    }
    const cookie = await signIn(url, DEMO_EMAIL[role], password);
    if (!cookie) {
      console.error(
        `\n! could not sign in as ${role} (${DEMO_EMAIL[role]}).\n` +
          `  In production the seeded demo password is refused unless FGMP_ALLOW_DEMO_CREDENTIALS=1;\n` +
          `  rotate it with scripts/set-password.ts and pass the new one in FGMP_AUTHZ_PASSWORD_${role}.\n`,
      );
      unavailable.push(role);
      continue;
    }

    for (const p of PROBES) {
      const status = await probe(url, cookie, p);
      const outcome = classify(status);
      const expected = canAccessApi(role, p.path, p.method);
      results.push({
        role,
        probe: p,
        status,
        outcome,
        expected,
        ok: expected ? outcome === "ALLOWED" || outcome === "RATE_LIMITED" : outcome === "DENIED",
      });
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const byRole = new Map<Role, Result[]>();
  for (const r of results) {
    if (!byRole.has(r.role)) byRole.set(r.role, []);
    byRole.get(r.role)!.push(r);
  }

  console.log("\nAnonymous (must be 401 on every /api/fgmp endpoint):");
  if (anonFailures.length === 0) {
    console.log("  OK — every probe was refused");
  } else {
    for (const f of anonFailures) console.log(`  ✗ ${f.probe.method} ${f.probe.path} → ${f.status}`);
  }

  for (const [role, rows] of byRole) {
    const bad = rows.filter((r) => !r.ok);
    const limited = rows.filter((r) => r.outcome === "RATE_LIMITED");
    console.log(
      `\n${role}: ${rows.length - bad.length}/${rows.length} as expected` +
        (limited.length ? ` (${limited.length} rate-limited)` : ""),
    );
    for (const b of bad) {
      console.log(
        `  ✗ ${b.probe.method} ${b.probe.path} → ${b.status} ${b.outcome}` +
          ` (expected ${b.expected ? "ALLOWED" : "DENIED"})`,
      );
    }
  }

  if (unavailable.length) {
    console.log(
      `\nRoles with no credentials supplied (NOT verified): ${unavailable.join(", ")}\n` +
        "  Supply FGMP_AUTHZ_PASSWORD_<ROLE> for each. These rows are absent from the matrix\n" +
        "  above; do not read a missing row as a pass.",
    );
  }

  const total = results.length;
  const failures = results.filter((r) => !r.ok).length;
  console.log(`\n${total} probes, ${failures} mismatch(es).`);
  if (unavailable.length) {
    console.log(`INCOMPLETE — ${unavailable.length} role(s) could not be exercised.`);
    process.exit(3);
  }
  process.exit(failures === 0 ? 0 : 1);
}

void main();
