/**
 * Session-scoped role preview (proposal §8.16 — معاينة الأدوار وإعادة الضبط).
 *
 * The proposal is explicit about the contract:
 *
 *   "معاينة الواجهة بدور مختلف مؤقتاً دون أي تغيير دائم في قاعدة
 *    البيانات … يبقى الدور الأصلي محفوظاً في الجلسة … عند إعادة
 *    تسجيل الدخول، يعود المستخدم تلقائياً إلى دوره الدائم."
 *
 *   "Preview the interface as a different role TEMPORARILY, WITHOUT
 *    any permanent change to the database … the original role stays
 *    preserved in the session … on re-login the user automatically
 *    returns to their permanent role."
 *
 * The previous implementation PATCHed the User row, which violated
 * every clause of that contract: the change was permanent, it was
 * indistinguishable from a real role reassignment in the audit trail,
 * and a re-login kept the previewed role.
 *
 * This module replaces it with a signed, short-lived, user-bound
 * overlay token carried in an httpOnly cookie:
 *
 *   1. NO DB WRITE — the User row is never touched, so the permanent
 *      role survives reloads, re-logins and the preview's expiry.
 *   2. BOUND — the token's `sub` must equal the session user's id, so
 *      a leaked token is useless to anyone else; and it is signed
 *      with NEXTAUTH_SECRET, so it cannot be forged without the app
 *      secret.
 *   3. SHORT-LIVED — 15 minutes, after which the overlay silently
 *      ends and the permanent role applies again.
 *   4. SCOPED — only the six tenant roles are previewable. SUPERADMIN
 *      is a platform-level, cross-tenant role and is deliberately
 *      excluded from the preview set (the proposal's switcher lists
 *      exactly six roles).
 *
 * The server applies the overlay in requireAuth() (auth-helpers.ts),
 * so every requireRole()/can() check on every route honours the
 * preview with zero per-route changes.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { JWT_SECRET_CONFIGURED } from "@/lib/auth";
import type { Role } from "./types";

/**
 * The six roles the proposal's role-preview switcher offers
 * (مدير النظام، مشغّل مركز العمليات، مدير إقليمي، مهندس ميداني،
 * تنفيذي، للقراءة فقط). SUPERADMIN is platform-level and is
 * deliberately NOT previewable.
 */
export const PREVIEW_ROLES: Role[] = [
  "ADMIN",
  "NOC_OPERATOR",
  "REGIONAL_MANAGER",
  "FIELD_ENGINEER",
  "EXECUTIVE",
  "READONLY",
];

/** Cookie + header name carrying the preview overlay token. */
export const PREVIEW_COOKIE = "fgmp_preview_role";

/** 15 minutes — long enough to explore a role, short enough that a
 *  forgotten preview cannot outlive a working session. */
export const PREVIEW_TTL_SEC = 15 * 60;

interface PreviewPayload {
  sub: string;   // session user id the overlay is bound to
  pr: Role;      // previewed role
  iat: number;   // issued-at (epoch seconds)
  exp: number;   // expiry (epoch seconds)
}

function previewSecret(): string | null {
  // Reuse the NextAuth secret: it is already required for session
  // signing, so preview tokens inherit the same deployment-level
  // key management without a second secret to rotate. The same
  // length/configured check auth.ts applies to session signing
  // gates preview signing too — no secret, no overlay.
  return JWT_SECRET_CONFIGURED ? (process.env.NEXTAUTH_SECRET ?? null) : null;
}

/** Sign a preview overlay token for `userId`. Returns null when the
 *  app secret is not configured (preview is then disabled). */
export function signPreviewToken(userId: string, role: Role): string | null {
  const secret = previewSecret();
  if (!secret) return null;
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload: PreviewPayload = {
    sub: userId,
    pr: role,
    iat: now,
    exp: now + PREVIEW_TTL_SEC,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payloadB64}`)
    .digest("base64url");
  return `${header}.${payloadB64}.${signature}`;
}

/**
 * Verify a preview token and return the previewed role — but ONLY
 * when every guarantee holds:
 *   - the signature is valid (HMAC-SHA256, constant-time compare)
 *   - the token has not expired
 *   - the token is bound to THIS session user (`sub` matches)
 *   - the previewed role is one of the six previewable roles
 *
 * Any failure returns null, which makes requireAuth fall back to the
 * permanent session role — fail closed, never fail open.
 */
export function verifyPreviewToken(token: string, expectedUserId: string): Role | null {
  const secret = previewSecret();
  if (!secret || !token || !expectedUserId) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payloadB64, signature] = parts;

  const expected = createHmac("sha256", secret).update(`${header}.${payloadB64}`).digest("base64url");
  const got = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;

  let payload: PreviewPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as PreviewPayload;
  } catch {
    return null;
  }

  if (payload.sub !== expectedUserId) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  if (!PREVIEW_ROLES.includes(payload.pr)) return null;
  return payload.pr;
}
