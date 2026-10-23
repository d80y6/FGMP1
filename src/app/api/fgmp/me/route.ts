import { NextRequest, NextResponse } from "next/server";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { ROLE_PERMISSIONS, ALL_ROLES } from "@/lib/fgmp/rbac-core";
import { requireRole } from "@/lib/fgmp/auth-helpers";
import { errorResponse } from "@/lib/fgmp/api-error";
import { rateLimitByUser, applyRateLimitHeaders, READ_LIMIT } from "@/lib/fgmp/rate-limit";
import { PREVIEW_ROLES } from "@/lib/fgmp/role-preview";
import type { Role } from "@/lib/fgmp/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/me
 * Returns the authenticated user's profile + RBAC envelope. The role preview
 * overlay is signed in an httpOnly cookie and never changes the User row.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ALL_ROLES as unknown as Role[]);
  if (auth.error) return auth.error;
  const { user } = auth;

  const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
  if (!rl.success) {
    const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  try {
    // This endpoint needs one user row only. Avoid bootstrap(), which used to
    // enumerate and hydrate every tenant on each /me request (including the
    // request fired from every authenticated AppShell mount).
    const dbUser = await asTenant(user, (tx) =>
      tx.user.findFirst({
        where: { id: user.id, tenantId: user.tenantId },
        select: { id: true, name: true, email: true, role: true, tenantId: true },
      }),
    );
    if (!dbUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    const permanentRole = dbUser.role as Role;
    const effectiveRole = (user.role ?? permanentRole) as Role;
    const previewRole = (user.previewRole ?? null) as Role | null;
    const res = NextResponse.json({
      id: dbUser.id,
      name: dbUser.name,
      email: dbUser.email,
      role: effectiveRole,
      permanentRole,
      previewRole,
      tenantId: dbUser.tenantId,
      roles: permanentRole === "ADMIN" || permanentRole === "SUPERADMIN"
        ? PREVIEW_ROLES
        : [permanentRole],
      permissions: ROLE_PERMISSIONS[effectiveRole],
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
