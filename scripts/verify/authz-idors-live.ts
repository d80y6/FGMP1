/**
 * Live, non-destructive cross-tenant IDOR and privilege-escalation checks.
 *
 * Run only against the disposable CI/test database after
 * `authz-idors-fixtures.sql` has created a second tenant with real Site and User
 * rows. The authenticated principal is the seeded ADMIN in t-default; every
 * target id belongs to t-idor-target. Write probes use valid bodies so an
 * incorrectly unscoped handler would actually reach its write path. A separate
 * privileged DB assertion verifies the fixture and caller were not changed.
 *
 * This is real HTTP against the running app and database, not a static route
 * contract. It still covers only these two resource families, not every API.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const REQUEST_TIMEOUT_MS = 15_000;
const FIXTURE_SITE = "s-idor-target";
const FIXTURE_USER = "u-idor-target";
const TARGET_TENANT = "t-idor-target";

type Probe = {
  label: string;
  method: "GET" | "PUT" | "PATCH" | "DELETE";
  path: string;
  expectedStatus: number;
  body?: unknown;
};

const PROBES: Probe[] = [
  {
    label: "read another tenant's real site",
    method: "GET",
    path: `/api/fgmp/sites/${FIXTURE_SITE}`,
    expectedStatus: 404,
  },
  {
    label: "update another tenant's real site",
    method: "PATCH",
    path: `/api/fgmp/sites/${FIXTURE_SITE}`,
    expectedStatus: 404,
    body: { name: "IDOR ATTACKED SITE" },
  },
  {
    label: "delete another tenant's real site",
    method: "DELETE",
    path: `/api/fgmp/sites/${FIXTURE_SITE}`,
    expectedStatus: 404,
  },
  {
    label: "read another tenant's real user",
    method: "GET",
    path: `/api/fgmp/users/${FIXTURE_USER}`,
    expectedStatus: 404,
  },
  {
    label: "ignore a tenant query that attempts to widen ADMIN scope",
    method: "GET",
    path: `/api/fgmp/users/${FIXTURE_USER}?tenant=${TARGET_TENANT}`,
    expectedStatus: 404,
  },
  {
    label: "update another tenant's real user despite a forged tenant query",
    method: "PUT",
    path: `/api/fgmp/users/${FIXTURE_USER}?tenant=${TARGET_TENANT}`,
    expectedStatus: 404,
    body: { name: "IDOR ATTACKED USER" },
  },
  {
    label: "deactivate another tenant's real user",
    method: "DELETE",
    path: `/api/fgmp/users/${FIXTURE_USER}`,
    expectedStatus: 404,
  },
  {
    label: "promote the caller into the platform role",
    method: "PUT",
    path: "/api/fgmp/users/u-admin-1",
    expectedStatus: 403,
    body: { role: "SUPERADMIN" },
  },
];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function signInAsAdmin(base: string, password: string): Promise<string> {
  const signal = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const csrfResponse = await fetch(`${base}/api/auth/csrf`, { signal: signal() });
  if (!csrfResponse.ok) throw new Error(`CSRF endpoint returned HTTP ${csrfResponse.status}`);
  const csrfToken = (await csrfResponse.json() as { csrfToken?: string }).csrfToken;
  if (!csrfToken) throw new Error("CSRF token was not returned");

  const csrfCookies = csrfResponse.headers.getSetCookie?.() ?? [];
  const loginResponse = await fetch(`${base}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      cookie: csrfCookies.map((cookie) => cookie.split(";")[0]).join("; "),
    },
    body: new URLSearchParams({
      csrfToken,
      email: "admin@fgmp.telecom",
      password,
      callbackUrl: base,
      json: "true",
    }),
    redirect: "manual",
    signal: signal(),
  });
  if (loginResponse.status !== 200 && loginResponse.status !== 302) {
    throw new Error(`Admin credentials were rejected (HTTP ${loginResponse.status})`);
  }
  const sessionCookies = (loginResponse.headers.getSetCookie?.() ?? [])
    .filter((cookie) => /session-token|next-auth/i.test(cookie))
    .map((cookie) => cookie.split(";")[0]);
  if (!sessionCookies.length) throw new Error("No session cookie was issued");
  const cookie = sessionCookies.join("; ");

  const sessionResponse = await fetch(`${base}/api/auth/session`, { headers: { cookie }, signal: signal() });
  const session = await sessionResponse.json() as { user?: { email?: string } };
  if (session.user?.email?.toLowerCase() !== "admin@fgmp.telecom") {
    throw new Error("Session did not resolve to the seeded ADMIN email");
  }
  const profileResponse = await fetch(`${base}/api/fgmp/me`, { headers: { cookie }, signal: signal() });
  if (!profileResponse.ok) throw new Error(`Profile check returned HTTP ${profileResponse.status}`);
  const profile = await profileResponse.json() as {
    role?: string;
    permanentRole?: string;
    tenantId?: string;
    email?: string;
  };
  if (
    profile.email?.toLowerCase() !== "admin@fgmp.telecom" ||
    profile.permanentRole !== "ADMIN" ||
    profile.tenantId !== "t-default"
  ) {
    throw new Error(
      `Unexpected caller principal (role=${profile.permanentRole ?? profile.role}, tenant=${profile.tenantId})`,
    );
  }
  return cookie;
}

async function main(): Promise<void> {
  const base = requiredEnv("FGMP_BASE_URL").replace(/\/$/, "");
  const password = requiredEnv("FGMP_AUTHZ_PASSWORD_ADMIN");
  const cookie = await signInAsAdmin(base, password);
  const results: { label: string; method: string; path: string; expectedStatus: number; status: number }[] = [];

  for (const probe of PROBES) {
    let status = 0;
    try {
      const response = await fetch(`${base}${probe.path}`, {
        method: probe.method,
        headers: {
          cookie,
          ...(probe.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: probe.body === undefined ? undefined : JSON.stringify(probe.body),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = response.status;
    } catch {
      // 0 is an explicit transport-failure marker and always fails this suite.
      status = 0;
    }
    results.push({
      label: probe.label,
      method: probe.method,
      path: probe.path,
      expectedStatus: probe.expectedStatus,
      status,
    });
    console.log(`${status === probe.expectedStatus ? "PASS" : "FAIL"} ${probe.method} ${probe.path}: HTTP ${status} (expected ${probe.expectedStatus})`);
  }

  const failures = results.filter((result) => result.status !== result.expectedStatus);
  const reportPath = process.argv.includes("--json")
    ? process.argv[process.argv.indexOf("--json") + 1]
    : undefined;
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      base,
      caller: { email: "admin@fgmp.telecom", role: "ADMIN", tenantId: "t-default" },
      targetTenant: TARGET_TENANT,
      total: results.length,
      failures,
      results,
    }, null, 2));
    console.log(`[authz-idors-live] wrote ${reportPath}`);
  }

  console.log(`\n${results.length} live IDOR/escalation probes; ${failures.length} mismatch(es).`);
  if (failures.length) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(`[authz-idors-live] INCOMPLETE: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
