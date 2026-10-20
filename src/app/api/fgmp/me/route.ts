import { NextRequest, NextResponse } from "next/server";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { ROLE_PERMISSIONS, ALL_ROLES } from "@/lib/fgmp/rbac";
import { requireRole } from "@/lib/fgmp/auth-helpers";
import { rateLimitByUser, applyRateLimitHeaders, READ_LIMIT } from "@/lib/fgmp/rate-limit";
import { PREVIEW_ROLES } from "@/lib/fgmp/role-preview";
import type { Role } from "@/lib/fgmp/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/me
 * Returns the authenticated user's profile + RBAC envelope.
 *
 * Role preview (proposal §8.16): when a preview overlay is
 * active, `role` is the EFFECTIVE (previewed) role and the
 * response also carries `permanentRole` (the DB-backed role)
 * and `previewRole`. The client renders the interface from the
 * effective role and offers the one-click return to the
 * permanent one.
 *
 * Requires any authenticated session.
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

  // The permanent role always comes from the DB — the preview
  // overlay lives in a cookie and never touches the User row.
  const dbUser = await asTenant(user, (tx) =>
    tx.user.findFirst({
      where: { id: user.id, tenantId: user.tenantId },
      select: { id: true, name: true, email: true, role: true, tenantId: true, lastLoginAt: true },
    }),
  );
  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  const permanentRole = dbUser.role as Role;
  const effectiveRole = (user.role ?? permanentRole) as Role;
  const previewRole = (user.previewRole ?? null) as Role | null;
  return NextResponse.json({
    id: dbUser.id,
    name: dbUser.name,
    email: dbUser.email,
    // Effective role = preview overlay when active.
    role: effectiveRole,
    permanentRole,
    previewRole,
    tenantId: dbUser.tenantId,
    // The previewable set: the six tenant roles of the proposal's
    // switcher. SUPERADMIN is platform-level and not previewable.
    roles: (permanentRole === "ADMIN" || permanentRole === "SUPERADMIN")
      ? PREVIEW_ROLES
      : [permanentRole],
    permissions: ROLE_PERMISSIONS[effectiveRole],
  });
}
