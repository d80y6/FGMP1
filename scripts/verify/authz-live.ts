/**
 * Live authorization matrix — real HTTP, real sessions, real database.
 *
 * ── WHAT THIS PROVES THAT THE UNIT TESTS CANNOT ────────────────────────────
 * `route-authorization-contract.test.ts` proves the two policy layers agree and
 * that no route is unmapped. It cannot prove that the ROUTE actually returns 403
 * — that needs a running server, a real NextAuth session and a real database.
 * This script probes one endpoint per representative API-policy shape for each role.
 * It is not a per-handler inventory or a cross-tenant resource-ownership test.
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
 *   • Most POST/PUT/PATCH bodies are deliberately incomplete, so an authorized
 *     call stops at validation with 400 and a denied call stops at the guard.
 *     The role-preview probe only mutates the discarded response cookie.
 * The status classes therefore separate cleanly:
 *     401 / 403                → DENIED   (authorization refused)
 *     other 4xx / 2xx          → ALLOWED (authorization passed; the request then
 *                                          failed its own validation or found
 *                                          nothing — which is the point)
 *     408 / 429 / 5xx / no response → INCONCLUSIVE, never counted as a pass.
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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canAccessApi } from "../../src/lib/fgmp/rbac-core";
import { classifyWalkControl, type WalkControlVerdict } from "./rbac-live-walk-logic";

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
  NOC_OPERATOR: "noc.operator@fgmp.telecom",
  REGIONAL_MANAGER: "regional.manager@fgmp.telecom",
  FIELD_ENGINEER: "field.engineer@fgmp.telecom",
  EXECUTIVE: "cto@fgmp.telecom",
  // The live RBAC walk creates this disposable seeded-test user before this
  // matrix runs. It is intentionally not part of the production seed set.
  READONLY: "readonly.walk@fgmp.telecom",
};

/** A literal that cannot be a real row id. */
const GHOST = "__authz_probe_does_not_exist__";
const REQUEST_TIMEOUT_MS = 15_000;

interface Probe {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** Body for write probes: valid JSON, deliberately failing validation. */
  body?: unknown;
  /** Query string appended for GET probes whose policy depends on it. */
  note?: string;
}

/**
 * Representative probes for the currently declared (method, policy) shapes.
 * This deliberately does not claim every exported handler has a live probe;
 * route-inventory contracts cover handler coverage, and tenant IDOR needs its
 * own fixtures and resource-level verification.
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

interface Result {
  role: Role;
  probe: Probe;
  status: number;
  expected: boolean;
  verdict: WalkControlVerdict;
}

function passwordFor(role: Role): string | undefined {
  return process.env[`FGMP_AUTHZ_PASSWORD_${role}`] ?? process.env.FGMP_AUTHZ_PASSWORD;
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function baseUrl(): string {
  const v = process.env.FGMP_BASE_URL;
  if (!v) {
    console.error(
      "FGMP_BASE_URL is not set.\n\n" +
        "This script performs a REAL end-to-end authorization matrix: it signs in as each\n" +
        "seeded role over HTTP and calls representative API-policy probes, so it needs a running deployment\n" +
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
 * Sign in through NextAuth, verify the expected account identity and return the
 * session cookie plus the database-resolved permanent role. Returns null when
 * no reliable identity can be established.
 */
async function signIn(
  url: string,
  email: string,
  password: string,
): Promise<{ cookie: string; role: string } | null> {
  try {
    // 1. CSRF token, with its cookie.
    const csrfRes = await fetch(`${url}/api/auth/csrf`, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!csrfRes.ok) return null;
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (loginRes.status !== 200 && loginRes.status !== 302) return null;

    // 3. Collect the session cookie(s) and verify the expected account resolves.
    const sessionCookies = (loginRes.headers.getSetCookie?.() ?? [])
      .filter((c) => /session-token|next-auth/i.test(c))
      .map((c) => c.split(";")[0]);
    if (sessionCookies.length === 0) return null;
    const cookie = sessionCookies.join("; ");

    const session = await fetch(`${url}/api/auth/session`, { headers: { cookie }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const sessionJson = (await session.json()) as { user?: { email?: string } } | null;
    if (sessionJson?.user?.email?.toLowerCase() !== email.toLowerCase()) return null;

    // Verify the database-resolved role before attributing endpoint outcomes to
    // the requested role. An account with a changed role must not silently
    // populate the wrong row of the matrix.
    const profile = await fetch(`${url}/api/fgmp/me`, { headers: { cookie }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!profile.ok) return null;
    const profileJson = (await profile.json()) as { role?: string; permanentRole?: string; email?: string };
    if (profileJson.email?.toLowerCase() !== email.toLowerCase()) return null;
    return { cookie, role: profileJson.permanentRole ?? profileJson.role ?? "" };
  } catch {
    // A failed login/network probe is not an authorization pass. The caller
    // records the role as unavailable and the process exits nonzero.
    return null;
  }
}

async function probe(url: string, cookie: string | null, p: Probe): Promise<number> {
  try {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (p.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${url}${p.path}`, {
      method: p.method,
      headers,
      body: p.body === undefined ? undefined : JSON.stringify(p.body),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.status;
  } catch {
    // 0 is reserved as the transport-failure marker by the shared classifier.
    return 0;
  }
}

async function main(): Promise<void> {
  const url = baseUrl();

  const results: Result[] = [];
  const unavailable: Role[] = [];
  const identityMismatches: { expectedRole: Role; actualRole: string; email: string }[] = [];

  // Unauthenticated baseline first: every /api/fgmp endpoint must refuse a
  // request that carries no session at all. Kept separate from `results` so it
  // is never counted as a role row. 429/5xx/network failures are inconclusive,
  // not evidence that the guard denied the request.
  const anonymous: { probe: Probe; status: number; verdict: WalkControlVerdict }[] = [];
  for (const p of PROBES) {
    const status = await probe(url, null, p);
    anonymous.push({ probe: p, status, verdict: classifyWalkControl(false, status) });
  }

  for (const role of ROLES) {
    const password = passwordFor(role);
    if (!password) {
      unavailable.push(role);
      continue;
    }
    const session = await signIn(url, DEMO_EMAIL[role], password);
    if (!session) {
      console.error(
        `\n! could not sign in as ${role} (${DEMO_EMAIL[role]}).\n` +
          `  In production the seeded demo password is refused unless FGMP_ALLOW_DEMO_CREDENTIALS=1;\n` +
          `  rotate it with scripts/set-password.ts and pass the new one in FGMP_AUTHZ_PASSWORD_${role}.\n`,
      );
      unavailable.push(role);
      continue;
    }
    if (session.role !== role) {
      identityMismatches.push({ expectedRole: role, actualRole: session.role, email: DEMO_EMAIL[role] });
      continue;
    }

    for (const p of PROBES) {
      const status = await probe(url, session.cookie, p);
      const expected = canAccessApi(role, p.path, p.method);
      results.push({
        role,
        probe: p,
        status,
        expected,
        verdict: classifyWalkControl(expected, status),
      });
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const byRole = new Map<Role, Result[]>();
  for (const r of results) {
    if (!byRole.has(r.role)) byRole.set(r.role, []);
    byRole.get(r.role)!.push(r);
  }

  const anonymousMismatches = anonymous.filter((r) => r.verdict === "wrong");
  const anonymousInconclusive = anonymous.filter((r) => r.verdict === "unknown");
  console.log("\nAnonymous baseline (each probe must be denied):");
  if (!anonymousMismatches.length && !anonymousInconclusive.length) {
    console.log("  PASS — every probe was refused");
  }
  for (const r of anonymousMismatches) {
    console.log(`  MISMATCH ${r.probe.method} ${r.probe.path} → HTTP ${r.status}`);
  }
  for (const r of anonymousInconclusive) {
    console.log(`  INCONCLUSIVE ${r.probe.method} ${r.probe.path} → HTTP ${r.status}`);
  }

  for (const issue of identityMismatches) {
    console.log(
      `\nIDENTITY MISMATCH: ${issue.email} authenticated as ${issue.actualRole || "<no role>"}; expected ${issue.expectedRole}.`,
    );
  }

  for (const [role, rows] of byRole) {
    const mismatches = rows.filter((r) => r.verdict === "wrong");
    const inconclusive = rows.filter((r) => r.verdict === "unknown");
    console.log(
      `\n${role}: ${rows.length - mismatches.length - inconclusive.length}/${rows.length} observable probes matched` +
        (mismatches.length ? `; ${mismatches.length} mismatch(es)` : "") +
        (inconclusive.length ? `; ${inconclusive.length} inconclusive` : ""),
    );
    for (const result of mismatches) {
      console.log(
        `  MISMATCH ${result.probe.method} ${result.probe.path} → HTTP ${result.status}` +
          ` (expected ${result.expected ? "ALLOW" : "DENY"})`,
      );
    }
    for (const result of inconclusive) {
      console.log(`  INCONCLUSIVE ${result.probe.method} ${result.probe.path} → HTTP ${result.status}`);
    }
  }

  if (unavailable.length) {
    console.log(
      `\nRoles without observable credentials/session (NOT verified): ${unavailable.join(", ")}\n` +
        "  Supply FGMP_AUTHZ_PASSWORD_<ROLE> for each role. These missing rows are not passes.",
    );
  }

  const mismatches =
    anonymousMismatches.length + results.filter((r) => r.verdict === "wrong").length + identityMismatches.length;
  const inconclusive = anonymousInconclusive.length + results.filter((r) => r.verdict === "unknown").length;
  const total = anonymous.length + results.length;
  const reportPath = argValue("--json");
  const summary = { total, mismatches, inconclusive, unavailable, identityMismatches, anonymous, results };
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({ base: url, generatedAt: new Date().toISOString(), ...summary }, null, 2));
    console.log(`[authz-live] wrote ${reportPath}`);
  }

  console.log(`\n${total} HTTP probes: ${mismatches} mismatch(es), ${inconclusive} inconclusive, ${unavailable.length} unavailable role(s).`);
  if (unavailable.length) {
    console.error("INCOMPLETE — at least one role could not be exercised.");
    process.exitCode = 3;
  } else if (mismatches) {
    process.exitCode = 1;
  } else if (inconclusive) {
    console.error("INCONCLUSIVE — rate-limited/unavailable probes are not passes.");
    process.exitCode = 2;
  } else {
    console.log(`[authz-live] all ${ROLES.length} roles matched the representative API policy probes`);
  }
}

void main();
