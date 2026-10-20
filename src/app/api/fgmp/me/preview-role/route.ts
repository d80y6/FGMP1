import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/fgmp/auth-helpers";
import { ROLE_PERMISSIONS } from "@/lib/fgmp/rbac";
import { audit } from "@/lib/fgmp/audit";
import { rateLimitByUser, applyRateLimitHeaders, MUTATION_LIMIT } from "@/lib/fgmp/rate-limit";
import {
  PREVIEW_COOKIE,
  PREVIEW_ROLES,
  PREVIEW_TTL_SEC,
  signPreviewToken,
} from "@/lib/fgmp/role-preview";

/** The preview endpoints stay reachable while ANY preview is
 *  active, so the operator can always leave the preview.
 *  Gating therefore looks at the PERMANENT role, never the
 *  effective (previewed) one. */
function permanentRoleOf(user: { permanentRole?: string; role?: string }): Role {
  return (user.permanentRole ?? user.role ?? "READONLY") as Role;
}
function isPermanentAdmin(user: { permanentRole?: string; role?: string }): boolean {
  const r = permanentRoleOf(user);
  return r === "ADMIN" || r === "SUPERADMIN";
}
import { switchRoleSchema, validateBody } from "@/lib/fgmp/schemas";
import type { Role } from "@/lib/fgmp/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/fgmp/me/preview-role — enter a role preview.
 *
 * Issues a signed, 15-minute, user-bound overlay token and
 * sets it as an httpOnly cookie. NOTHING is written to the
 * database: the permanent role is preserved, the preview ends
 * on its own at expiry, and a fresh login starts from the
 * permanent role — exactly the contract of proposal §8.16
 * (معاينة الأدوار وإعادة الضبط).
 *
 * Requires SUPER_OR_ADMIN. SUPERADMIN is not previewable.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const { user } = auth;
  if (!isPermanentAdmin(user)) {
    const res = NextResponse.json(
      { error: "Forbidden", code: "INSUFFICIENT_ROLE", required: ["ADMIN"], actual: user.role },
      { status: 403 },
    );
    return res;
  }

  const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
  if (!rl.success) {
    const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  const body = await req.json().catch(() => ({}));
  const r = validateBody(switchRoleSchema, body);
  if (!r.success) {
    return NextResponse.json({ error: "Validation failed", details: r.error }, { status: 400 });
  }
  const { role } = r.data;

  // Only the six previewable tenant roles.
  if (!PREVIEW_ROLES.includes(role)) {
    return NextResponse.json(
      { error: "Role is not previewable", code: "ROLE_NOT_PREVIEWABLE" },
      { status: 400 },
    );
  }
  // NB: SUPERADMIN cannot be previewed — it is not a member
  // of PREVIEW_ROLES, so the check above already rejects it.

  const permanentRole = (user.permanentRole ?? user.role) as Role;
  const requestedRole = role as Role;
  // Previewing the permanent role is a no-op, not an error.
  if (requestedRole === permanentRole) {
    const res = NextResponse.json({
      role: permanentRole,
      permanentRole,
      previewRole: null,
      roles: (permanentRole === "ADMIN" || permanentRole === "SUPERADMIN")
        ? PREVIEW_ROLES
        : [permanentRole],
      permissions: ROLE_PERMISSIONS[permanentRole],
    });
    res.cookies.delete(PREVIEW_COOKIE);
    return res;
  }

  const token = signPreviewToken(user.id, role);
  if (!token) {
    return NextResponse.json(
      { error: "Role preview is not configured on this deployment", code: "PREVIEW_UNAVAILABLE" },
      { status: 503 },
    );
  }

  await audit({
    userId: user.id,
    tenantId: user.tenantId,
    action: "PREVIEW_ROLE_ENTER",
    entity: "session",
    details: { from: permanentRole, to: role, ttlSec: PREVIEW_TTL_SEC },
  });

  const res = NextResponse.json({
    role,
    permanentRole,
    previewRole: role,
    roles: PREVIEW_ROLES,
    permissions: ROLE_PERMISSIONS[role],
    expiresInSec: PREVIEW_TTL_SEC,
  });
  res.cookies.set({
    name: PREVIEW_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: PREVIEW_TTL_SEC,
  });
  applyRateLimitHeaders(res.headers, rl);
  return res;
}

/**
 * DELETE /api/fgmp/me/preview-role — leave the role preview.
 *
 * Clears the overlay cookie so the session immediately enforces
 * the permanent role again (the proposal's "العودة إلى مدير" /
 * Return-to-Admin button). No DB row was ever changed, so there
 * is nothing to restore — only the cookie to drop.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const { user } = auth;
  if (!isPermanentAdmin(user)) {
    const res = NextResponse.json(
      { error: "Forbidden", code: "INSUFFICIENT_ROLE", required: ["ADMIN"], actual: user.role },
      { status: 403 },
    );
    return res;
  }

  const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
  if (!rl.success) {
    const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  const permanentRole = (user.permanentRole ?? user.role) as Role;
  await audit({
    userId: user.id,
    tenantId: user.tenantId,
    action: "PREVIEW_ROLE_EXIT",
    entity: "session",
    details: { returnedTo: permanentRole },
  });

  const res = NextResponse.json({ ok: true, role: permanentRole });
  res.cookies.delete(PREVIEW_COOKIE);
  applyRateLimitHeaders(res.headers, rl);
  return res;
}
