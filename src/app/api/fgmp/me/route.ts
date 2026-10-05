import { NextRequest, NextResponse } from "next/server";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { ROLE_PERMISSIONS, ALL_ROLES } from "@/lib/fgmp/rbac";
import { requireRole, isSuperAdminUser, ROLES } from "@/lib/fgmp/auth-helpers";
import type { Role } from "@/lib/fgmp/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/me
 * Returns the authenticated user's profile + RBAC envelope (roles + the
 * capability list for their active role). Reads the latest role from the DB
 * (not the JWT) so role switches are reflected immediately.
 *
 * Requires any authenticated session.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ALL_ROLES as unknown as Role[]);
  if (auth.error) return auth.error;
  const { user } = auth;

  // Re-read the user from the DB so we pick up role changes from PATCH.
  //
  // Scoped to the caller's OWN tenant, consistent with `auth-identity.ts`,
  // which reads the same row through a client that can see it. The difference
  // is deliberate and worth stating: `findUserIdentity` runs in the JWT
  // callback BEFORE a tenant is established, so it cannot use withTenant. Here
  // the session already carries `user.tenantId`, so the read is properly
  // scoped — no second identity pattern is invented here.
  const dbUser = await asTenant(user.tenantId, (tx) =>
    tx.user.findFirst({
      where: { id: user.id, tenantId: user.tenantId },
      select: { id: true, name: true, email: true, role: true, tenantId: true, lastLoginAt: true },
    }),
  );
  if (!dbUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  const role = dbUser.role as Role;
  return NextResponse.json({
    id: dbUser.id,
    name: dbUser.name,
    email: dbUser.email,
    role,
    tenantId: dbUser.tenantId,
    roles: (role === "ADMIN" || role === "SUPERADMIN") ? ALL_ROLES : [role],
    permissions: ROLE_PERMISSIONS[role],
  });
}

/**
 * PATCH /api/fgmp/me
 * Switch the caller's active role (demo / admin debug feature). Updates the
 * DB user row; the JWT is refreshed separately via useSession().update() in
 * AppShell so subsequent API calls enforce the new role.
 *
 * Requires SUPER_OR_ADMIN (Task 49 — both the platform super-admin and
 * tenant administrators can switch their own role for demo/debug). A caller
 * may not select SUPERADMIN unless they already hold it.
 */
export async function PATCH(req: Request) {
  const auth = await requireRole(req, [...ROLES.SUPER_OR_ADMIN]);
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const body = await req.json().catch(() => ({}));
  const { role } = body;
  if (!ALL_ROLES.includes(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }
  // Tenant-admins cannot promote themselves to the platform super-admin role.
  // Same guard as users/route.ts and users/[id]/route.ts — without it this
  // endpoint is a one-request path from ADMIN to cross-tenant superadmin,
  // because it writes to the caller's own user row.
  if (!isSuperAdminUser(user) && role === "SUPERADMIN") {
    return NextResponse.json(
      { error: "Only super-admins can grant the super-admin role", code: "CANNOT_ASSIGN_SUPERADMIN" },
      { status: 403 },
    );
  }
  const updated = await asTenant(user.tenantId, (tx) =>
    tx.user.update({
      // Scoped in the QUERY, not filtered afterwards. Under FORCE RLS an
      // unscoped update matches nothing, so `update` would have thrown rather
      // than silently succeeded — but scoping here also means a caller cannot
      // pass an id belonging to another tenant.
      where: { id: user.id, tenantId: user.tenantId },
      data: { role },
      select: { id: true, name: true, email: true, role: true, tenantId: true },
    }),
  );
  return NextResponse.json({
    ...updated,
    role: updated.role as Role,
    roles: ALL_ROLES,
    permissions: ROLE_PERMISSIONS[updated.role as Role],
  });
}
