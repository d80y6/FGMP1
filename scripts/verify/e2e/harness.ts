/**
 * ─────────────────────────────────────────────────────────────────────────────
 * End-to-end HTTP test harness
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS
 *
 * Every previous phase verified at the query or type layer: `tsc` passes,
 * `eslint` passes, the RLS suite proves the policies block cross-tenant access.
 * None of that demonstrated that a ROUTE works. Three defects in this programme
 * were invisible to all of them:
 *
 *   - `POST /api/fgmp/iot/ingest` returned 500 for every request since Phase 0,
 *     because a sessionless route called `bootstrap()`.
 *   - `GET /api/fgmp/realtime/snapshot` had the identical bug.
 *   - The engine held an empty platform because geography loaded through
 *     revoked tables — invisible until a real request needed real data.
 *
 * All three compiled, linted, and type-checked. Only issuing a request found
 * them. So this harness issues REAL HTTP requests against a REAL server, with
 * REAL authenticated sessions, against a REAL PostgreSQL instance.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM
 *
 * A passing route here means: the request was issued over HTTP, the session was
 * genuine, the database was live, and the response was what the code says. It
 * does not mean the UI renders it, that a browser can reach it, or that the
 * behaviour is desirable — only that the endpoint does what it claims.
 *
 * ── WHY SESSIONS COME FROM A REAL LOGIN ────────────────────────────────────
 *
 * This harness originally minted NextAuth JWTs locally with `jose`. It was
 * documented as "hermetic" and it was worthless.
 *
 * Minting a token requires reproducing three things exactly: the signing secret,
 * the issuer, and the claim shape. When the server and the harness disagreed on
 * any one of them, every single route returned 401 — and the sweep reported
 * "61 routes, 61 failures", which reads like a catastrophic outage and was
 * actually a harness that could not authenticate.
 *
 * That is the dangerous shape of failure: a test harness that fails everything
 * looks like a product that fails everything, and the two are indistinguishable
 * from the output alone. Worse, no route was actually exercised, so the sweep
 * proved nothing about a single endpoint.
 *
 * The issuer in particular was not a typo but a landmine. `NEXTAUTH_URL` was
 * unset in the server environment, so NextAuth defaulted the issuer to
 * `http://localhost:3000` while the harness minted `http://127.0.0.1:3080`.
 * Next.js also loads `.env` at runtime and its value OVERRIDES the exported
 * environment, so the secret the harness read could silently differ from the one
 * the server used — no way to detect from inside the harness.
 *
 * A real login has none of these problems because it asks the server which
 * cookie it issued instead of guessing. It costs one HTTP round-trip per
 * distinct user, which is a rounding error against the value of testing the
 * credential path at all — the credential callback is a route like any other
 * and it was previously untested by construction.
 */


import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

/** Base URL of the running server under test. */
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3210";

/**
 * Log in over HTTP and return a `Cookie:` header the server will accept.
 *
 * Two-step because that is how NextAuth v4 works with the credentials provider:
 * `GET /api/auth/csrf` issues a token the callback requires, then
 * `POST /api/auth/callback/credentials` exchanges credentials for the session
 * cookie. The cookie name differs between HTTP and HTTPS, so the `Set-Cookie`
 * header is parsed rather than assuming the development name.
 *
 * This deliberately exercises the credential callback. A harness that forges a
 * token tests every route EXCEPT the one that decides who gets in.
 */
export async function sessionCookieFor(
  email: string,
  password: string,
): Promise<string> {
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  if (!csrfRes.ok) {
    throw new Error(`GET /api/auth/csrf returned ${csrfRes.status}; cannot authenticate`);
  }
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  if (!csrfToken) throw new Error("csrf endpoint returned no token");

  // The CSRF cookie must be forwarded VERBATIM, as `value|hash`, and it is NOT
  // the same value as the `csrfToken` in the JSON body — the JSON token is the
  // first half of that pair. Reconstructing the cookie from the body token (the
  // obvious implementation) sends a value the server cannot match, and NextAuth
  // answers with a 302 to `/api/auth/signin?csrf=true`.
  //
  // That failure is quiet and misleading: it is a 302, not a 4xx, so a harness
  // that only checks the status code sees a "successful" login and reports 61
  // unauthenticated requests against 61 routes.
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).find((c) =>
    c.startsWith("next-auth.csrf-token"),
  );
  if (!csrfCookie) {
    throw new Error("csrf endpoint issued no csrf cookie; cannot complete a login");
  }

  // `json: "true"` is deliberately NOT sent. With it, NextAuth returns a JSON
  // response instead of issuing the session cookie, which looks like a
  // successful login and then fails every subsequent request with 401.
  const login = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: csrfCookie.split(";")[0]!,
    },
    body: new URLSearchParams({ csrfToken, email, password }).toString(),
  });

  // Success is a 302 carrying the session cookie. A 302 to
  // `/api/auth/signin?csrf=true` is a CSRF rejection, not a login — treating
  // both as "redirected" is what let the first version of this harness report a
  // clean sweep while every request was unauthenticated.
  const location = login.headers.get("location") ?? "";
  if (location.includes("csrf=true")) {
    throw new Error("login rejected: CSRF token mismatch (redirected to signin?csrf=true)");
  }
  if (![200, 302].includes(login.status)) {
    throw new Error(`login for ${email} returned ${login.status}: ${(await login.text()).slice(0, 200)}`);
  }

  const setCookies = login.headers.getSetCookie?.() ?? [];
  const session = setCookies.find((c) => c.includes("session-token"));
  if (!session) {
    throw new Error(
      `login for ${email} returned ${login.status} but issued no session cookie ` +
        `(redirect: ${location || "none"})`,
    );
  }
  // Strip attributes; only name=value belongs in a Cookie header.
  return session.split(";")[0]!;
}

/** A tenant that owns nothing, for negative-path tests. */
export const FOREIGN_TENANT_ID = "t-e2e-foreign";

/**
 * Create a second tenant with its own site, tank and generator.
 *
 * Cross-tenant tests need a victim tenant that genuinely exists and genuinely
 * owns rows. Without one, a "cross-tenant read returns nothing" assertion
 * passes vacuously — which is exactly the failure mode that hid the tenant
 * isolation test. The foreign rows are created through the OWNER client because
 * RLS correctly refuses to write another tenant's rows.
 */
export async function seedForeignTenant(db: PrismaClient): Promise<{
  tenantId: string;
  siteId: string;
  tankId: string;
  generatorId: string;
}> {
  const now = Date.now();
  const suffix = String(now).slice(-8);
  const tenantId = FOREIGN_TENANT_ID;

  // Purge leftovers FIRST, and via the ordered helper rather than a bare tenant
  // delete. Region.tenantId is ON DELETE RESTRICT, so removing the tenant while
  // geography rows still reference it fails — the constraint is correct, and
  // the delete ORDER is what has to be right.
  await cleanupForeignTenant(db);

  await db.tenant.create({
    data: { id: tenantId, name: "E2E Foreign", code: `E2E-${suffix}`, country: "YE" },
  });
  const region = await db.region.create({
    data: { id: `e2e-region-${suffix}`, tenantId, name: `E2E Region ${suffix}` },
  });
  const gov = await db.governorate.create({
    data: { id: `e2e-gov-${suffix}`, regionId: region.id, name: `E2E Gov ${suffix}` },
  });
  const district = await db.district.create({
    data: { id: `e2e-dist-${suffix}`, governorateId: gov.id, name: `E2E Dist ${suffix}` },
  });
  const site = await db.site.create({
    data: {
      id: `e2e-site-${suffix}`,
      tenantId,
      code: `E2E-${suffix}`,
      name: `E2E Foreign Site`,
      regionId: region.id,
      governorateId: gov.id,
      districtId: district.id,
      latitude: 15.3694,
      longitude: 44.191,
      // Site.name and Site.address are both NOT NULL and have no default. An
      // `as never` cast on this create hid the first omission, so the required
      // fields are spelled out here rather than suppressed.
      address: "E2E Foreign Address",
    },
  });
  const tank = await db.fuelTank.create({
    data: {
      id: `e2e-tank-${suffix}`,
      tenantId,
      siteId: site.id,
      label: "Foreign Tank",
      capacityLitres: 5000,
      currentLitres: 4321,
      calibration: "1.0",
      lowThreshold: 500,
      criticalThreshold: 200,
    },
  });
  const generator = await db.generator.create({
    data: {
      id: `e2e-gen-${suffix}`,
      tenantId,
      siteId: site.id,
      label: "Foreign Gen",
      manufacturer: "E2E",
      model: "E2E-1",
      ratedPowerKw: 100,
      status: "STOPPED",
    },
  });

  return { tenantId, siteId: site.id, tankId: tank.id, generatorId: generator.id };
}

export async function cleanupForeignTenant(db: PrismaClient): Promise<void> {
  // Children first, and the ORDER matters: District -> Governorate -> Region ->
  // Tenant. Each references the one above with ON DELETE RESTRICT, so deleting
  // a parent before its children fails. This is the same trap the RLS suite hit
  // when InterlockOverride went missing from its purge list and the symptom
  // surfaced a run later as a bogus policy failure.
  await db.sensorReading.deleteMany({ where: { siteId: { startsWith: "e2e-site-" } } });
  await db.fuelDelivery.deleteMany({ where: { siteId: { startsWith: "e2e-site-" } } });
  await db.site.deleteMany({ where: { id: { startsWith: "e2e-site-" } } });
  await db.district.deleteMany({ where: { id: { startsWith: "e2e-dist-" } } });
  await db.governorate.deleteMany({ where: { id: { startsWith: "e2e-gov-" } } });
  await db.region.deleteMany({ where: { id: { startsWith: "e2e-region-" } } });
  await db.tenant.deleteMany({ where: { id: FOREIGN_TENANT_ID } });
}

/** Find a seeded user by email through the OWNER client (RLS hides them). */
export async function findUser(
  db: PrismaClient,
  email: string,
): Promise<{ id: string; email: string; role: string; tenantId: string } | null> {
  const u = await db.user.findUnique({ where: { email } });
  return u ? { id: u.id, email: u.email, role: u.role, tenantId: u.tenantId } : null;
}

/** Assert helper that produces a readable failure instead of a bare throw. */
export function expectEqual(
  actual: unknown,
  expected: unknown,
  what: string,
): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${what}: expected ${e}, got ${a}`);
  }
}

export { NextRequest, bcrypt };