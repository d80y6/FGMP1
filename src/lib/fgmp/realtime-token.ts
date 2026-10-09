/**
 * Short-lived signed tokens for the realtime websocket handshake.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The realtime mini-service previously accepted ANY socket connection: its
 * middleware only rejected a client that *claimed* `role: "server"` with a bad
 * secret, so omitting `auth` entirely connected freely. Because the service
 * polls the global `/api/fgmp/realtime/snapshot` endpoint (which returns every
 * tenant's fleet), any unauthenticated browser could subscribe and read the
 * whole platform cross-tenant.
 *
 * Browsers cannot present the NextAuth session cookie to the realtime service,
 * so instead the Next.js app mints a short-lived, HMAC-signed token carrying
 * the caller's identity, and the service verifies the signature. The service
 * needs no database access and no knowledge of NextAuth.
 *
 * The signature is over the payload, so a client cannot claim another tenantId
 * or a SUPERADMIN role — and even if it did, the service only uses `tid` to
 * choose which slice of the snapshot to send.
 *
 * ── Format ─────────────────────────────────────────────────────────────────
 *   base64url(payloadJson) "." base64url(hmacSha256(payloadJson, secret))
 *
 * NOTE: the realtime service carries its own copy of `verifyRealtimeToken()`
 * (see mini-services/realtime/index.ts). It is duplicated deliberately — the
 * service is a separate process with no access to src/. Keep the two in sync.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

export interface RealtimeTokenPayload {
  /** Subject — the user id. */
  sub: string;
  /** Tenant id — determines which snapshot slice the socket may receive. */
  tid: string;
  /** Role, for logging/observability only. Never used for authorization. */
  role: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

/** Browser tokens are short-lived; the client re-mints on socket reconnect. */
export const REALTIME_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Resolve the shared signing secret. Fails closed — there is deliberately no
 * default, because a published default would let anyone mint a valid token.
 */
export function realtimeTokenSecret(): string {
  const secret = process.env.REALTIME_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "REALTIME_TOKEN_SECRET is missing or too short (min 32 chars). " +
        "Generate one with `openssl rand -base64 32` and set it for BOTH the " +
        "app and the fgmp-realtime service.",
    );
  }
  return secret;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
}

/** Sign a payload into a compact token. */
export function signRealtimeToken(
  payload: RealtimeTokenPayload,
  secret: string = realtimeTokenSecret(),
): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

/**
 * Mint a token for an authenticated user. Throws if the secret is unset so a
 * misconfigured deployment fails loudly instead of disabling socket auth.
 */
export function issueRealtimeToken(user: {
  id: string;
  role: string;
  tenantId: string;
}): string {
  return signRealtimeToken({
    sub: user.id,
    tid: tenantIdOrThrow(user.tenantId),
    role: user.role,
    exp: Date.now() + REALTIME_TOKEN_TTL_MS,
  });
}

/**
 * Verify a token's signature and expiry. Returns the payload, or null.
 *
 * The signature comparison is constant-time, and the MAC is checked BEFORE the
 * payload is parsed so a forged token is never JSON-decoded.
 */
export function verifyRealtimeToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): RealtimeTokenPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let expected: Buffer;
  try {
    expected = createHmac("sha256", secret).update(body).digest();
  } catch {
    return null;
  }
  let provided: Buffer;
  try {
    provided = fromB64url(sig);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let payload: RealtimeTokenPayload;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload?.sub !== "string" ||
    typeof payload?.tid !== "string" ||
    typeof payload?.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp <= now) return null;
  return payload;
}
