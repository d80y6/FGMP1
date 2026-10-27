/**
 * The full MFA enrolment flow, over HTTP, against a live server.
 *
 * ── WHY A SCRIPT AND NOT A UNIT TEST ───────────────────────────────────────
 * Everything here has a unit test. What no unit test can show is that the FIVE
 * endpoints and the NextAuth callback compose into a flow a human can complete —
 * and that is the thing that was broken: `/mfa/challenge` could never resolve a
 * token under FORCE RLS, so a enrolled account could not finish signing in. The
 * unit suite was green the whole time because it asserted the SQL string, not
 * the behaviour.
 *
 * So this walks the real path with a real session and a REAL database:
 *
 *   1. sign in with a password                     → full session
 *   2. POST /mfa/enrol                             → base32 secret + otpauth URI
 *   3. compute a code with an INDEPENDENT TOTP     → the server must accept it
 *   4. POST /mfa/verify-enrol                      → 10 backup codes, shown once
 *   5. sign in AGAIN                               → PENDING session only
 *   6. POST /mfa/challenge-request                 → challenge token
 *   7. POST /mfa/challenge (fresh code)            → verified
 *   8. sign in with `mfaProof` = the token         → FULL session again
 *   9. GET /api/fgmp/me                            → 200 with a role, not 403
 *  10. POST /mfa/disable (code + reason)           → the account is restored
 *
 * Step 3 is the reason for the independent implementation: `totp.ts` has been
 * wrong before (it HMACed base32 TEXT rather than the decoded key) while its own
 * tests passed, because RFC 6238's test vectors use an ASCII key. An
 * implementation written from the RFC, inside this file, sharing no code with
 * the one under test, is what makes the check mean something.
 *
 * Step 10 is not cleanup theatre: leaving the test account enrolled would make
 * every later run of `rbac-live-walk.ts` fail at the login step, and would
 * quietly leave a shared demo credential behind a second factor.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *   FGMP_BASE_URL=http://localhost:3000 \
 *   MFA_TEST_EMAIL=field.engineer@fgmp.telecom \
 *   MFA_TEST_PASSWORD='…' \
 *   bun run scripts/verify/mfa-live-flow.ts
 *
 * Refuses to run without the variables rather than reporting a green tick for a
 * flow it never executed.
 */

import { createHmac } from "node:crypto";

const BASE = process.env.FGMP_BASE_URL;
const EMAIL = process.env.MFA_TEST_EMAIL;
const PASSWORD = process.env.MFA_TEST_PASSWORD;

if (!BASE || !EMAIL || !PASSWORD) {
  console.error(
    "[mfa] Set FGMP_BASE_URL, MFA_TEST_EMAIL and MFA_TEST_PASSWORD. A flow check that " +
      "silently passes when it cannot reach a server manufactures evidence.",
  );
  process.exit(2);
}

/* ── An independent TOTP (RFC 6238), sharing no code with src/lib/fgmp/mfa ── */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function referenceTotp(secret: string, unixSeconds: number, period = 30, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(0, 0);
  counter.writeUInt32BE(Math.floor(unixSeconds / period), 4);
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/* ── HTTP ────────────────────────────────────────────────────────────────── */

type Jar = Map<string, string>;
let failures = 0;

function record(step: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${step} — ${detail}`);
}

function cookieHeader(jar: Jar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorb(jar: Jar, res: Response): void {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function post(jar: Jar, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieHeader(jar) },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  absorb(jar, res);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function get(jar: Jar, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: cookieHeader(jar) }, redirect: "manual" });
  absorb(jar, res);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** Sign in. `mfaProof` completes a second factor when the account has one. */
async function signIn(mfaProof?: string): Promise<{ jar: Jar; status: number; pending: boolean }> {
  const jar: Jar = new Map();
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`, { headers: { cookie: cookieHeader(jar) } });
  absorb(jar, csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const form = new URLSearchParams({
    csrfToken,
    email: EMAIL as string,
    password: PASSWORD as string,
    callbackUrl: BASE as string,
    json: "true",
  });
  if (mfaProof) form.set("mfaProof", mfaProof);

  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar) },
    body: form,
    redirect: "manual",
  });
  absorb(jar, res);

  // `session.user.mfaPending` is the only honest way to read "did we get a real
  // session or a placeholder" — NextAuth still issues a cookie either way.
  const session = await get(jar, "/api/auth/session");
  const user = (session.json.user ?? {}) as { role?: string; mfaPending?: boolean };
  return { jar, status: res.status, pending: user.mfaPending === true || !user.role };
}

async function main(): Promise<void> {
  console.log(`[mfa] ${BASE} as ${EMAIL}`);

  // 1. A password-only sign-in, which must NOT be a full session on an enrolled
  //    account. On a fresh account there is no factor yet, so it is full.
  const first = await signIn();
  const me1 = await get(first.jar, "/api/fgmp/me");
  record("sign in with password", me1.status === 200, `GET /me → ${me1.status}`);

  // 2. Begin enrolment.
  const enrol = await post(first.jar, "/api/fgmp/mfa/enrol", {});
  const secret = typeof enrol.json.secret === "string" ? enrol.json.secret : "";
  const uri = typeof enrol.json.otpauthUri === "string" ? enrol.json.otpauthUri : "";
  record(
    "POST /mfa/enrol returns a base32 secret and an otpauth URI",
    enrol.status === 200 && /^[A-Z2-7]{32,}$/.test(secret) && uri.startsWith("otpauth://totp/"),
    `status ${enrol.status}, secret ${secret.slice(0, 6)}…, uri ${uri.slice(0, 22)}…`,
  );
  if (!secret) {
    console.error("[mfa] cannot continue without a secret");
    process.exit(1);
  }

  // 3. An INDEPENDENTLY computed code must be accepted.
  const code = referenceTotp(secret, Math.floor(Date.now() / 1000));
  const verify = await post(first.jar, "/api/fgmp/mfa/verify-enrol", { code });
  const backupCodes = Array.isArray(verify.json.backupCodes) ? (verify.json.backupCodes as string[]) : [];
  record(
    "verify-enrol accepts an independently-computed code",
    verify.status === 200 && verify.json.enrolled === true,
    `status ${verify.status}, code ${code}`,
  );
  record("recovery codes issued once", backupCodes.length === 10, `${backupCodes.length} codes`);

  const status = await get(first.jar, "/api/fgmp/mfa/status");
  record(
    "GET /mfa/status reports the enrolment",
    status.status === 200 && status.json.enabled === true && status.json.backupCodesRemaining === 10,
    `enabled=${String(status.json.enabled)} remaining=${String(status.json.backupCodesRemaining)}`,
  );

  // 4. The NEXT sign-in must be pending: the factor is now REQUIRED. This is the
  //    assertion that would have failed before the resolver fix — and it is also
  //    the one a user experiences as "locked out".
  const second = await signIn();
  record("a fresh password-only sign-in is PENDING", second.pending, `pending=${second.pending}`);
  const pendingMe = await get(second.jar, "/api/fgmp/me");
  record(
    "the pending session is refused on a protected route",
    pendingMe.status === 401 || pendingMe.status === 403,
    `GET /me → ${pendingMe.status}`,
  );

  // 5. Ask for a challenge, then exchange a fresh code for a proof.
  const req = await post(second.jar, "/api/fgmp/mfa/challenge-request", {});
  const challengeToken = typeof req.json.challengeToken === "string" ? req.json.challengeToken : "";
  record(
    "the pending session can request a challenge",
    req.status === 200 && challengeToken.length > 10,
    `status ${req.status}`,
  );

  let verified = false;
  if (challengeToken) {
    const fresh = referenceTotp(secret, Math.floor(Date.now() / 1000));
    const done = await post(second.jar, "/api/fgmp/mfa/challenge", { challengeToken, code: fresh });
    verified = done.status === 200 && done.json.verified === true;
    record(
      "the challenge accepts a freshly computed code",
      verified,
      `status ${done.status}, method=${String(done.json.method ?? "-")}`,
    );
  }

  // 6. Re-authenticate WITH the proof: this is the step that actually mints the
  //    full session, and the one that silently never worked.
  if (verified) {
    const third = await signIn(challengeToken);
    const me3 = await get(third.jar, "/api/fgmp/me");
    record(
      "sign in with mfaProof yields a FULL session",
      !third.pending && me3.status === 200 && typeof me3.json.role === "string",
      `pending=${third.pending}, GET /me → ${me3.status}, role=${String(me3.json.role ?? "-")}`,
    );

    // 7. Restore the account: disabling requires possession, which we have.
    const disableCode = referenceTotp(secret, Math.floor(Date.now() / 1000));
    const off = await post(third.jar, "/api/fgmp/mfa/disable", {
      code: disableCode,
      reason: "automated live MFA flow check — restoring the demo account",
    });
    record("POST /mfa/disable turns the factor off", off.status === 200, `status ${off.status}`);

    const after = await signIn();
    const me4 = await get(after.jar, "/api/fgmp/me");
    record(
      "a password-only sign-in works again afterwards",
      !after.pending && me4.status === 200,
      `pending=${after.pending}, GET /me → ${me4.status}`,
    );
  }

  if (failures > 0) {
    console.error(`\n[mfa] ${failures} step(s) failed`);
    process.exit(1);
  }
  console.log("\n[mfa] the whole enrolment → challenge → full-session flow works");
}

await main();
