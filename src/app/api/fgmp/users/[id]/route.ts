import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, bootstrap } from "@/lib/fgmp";
import {
  requireRole,
  ROLES,
  assertTenantOwned,
  isSuperAdminUser,
} from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Shared per-request limiter for this route.
 *
 * `users/[id]` does not itself run bcrypt (that lives in
 * `[id]/reset-password` and `POST /users`), but every mutating verb here
 * changes another user's account — role, active flag, identity — so it is
 * rate-limited at the same MUTATION_LIMIT budget as every other mutation in
 * the API. Reads use READ_LIMIT. Without this, an authenticated admin (or a
 * hijacked admin session) could enumerate or churn the entire roster with no
 * throttle at all.
 */
function limitFor(req: NextRequest, me: { id: string }, mutating: boolean) {
  const cfg = mutating ? MUTATION_LIMIT : READ_LIMIT;
  const rl = rateLimitByUser(req, me.id, cfg.limit, cfg.windowMs);
  if (!rl.success) {
    const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }
  return null;
}

const VALID_ROLES = [
  "SUPERADMIN",
  "ADMIN",
  "NOC_OPERATOR",
  "REGIONAL_MANAGER",
  "FIELD_ENGINEER",
  "EXECUTIVE",
  "READONLY",
] as const;

const updateUserSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  role: z.enum(VALID_ROLES).optional(),
  phone: z.string().max(40).optional().nullable(),
  active: z.boolean().optional(),
});

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  phone: true,
  active: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  tenantId: true,
  tenant: { select: { name: true } },
} as const;

/**
 * Guard helper (Task 49): tenant administrators may never read or mutate a
 * SUPERADMIN account, even within their own tenant. SUPERADMIN callers bypass
 * this entirely. Returns a 403 NextResponse when the action is forbidden, or
 * `null` when allowed.
 */
function guardSuperAdminTarget(
  target: { role?: string } | null,
  me: { role?: string },
): NextResponse | null {
  if (isSuperAdminUser(me)) return null;
  if (target?.role === "SUPERADMIN") {
    return NextResponse.json(
      { error: "Tenant administrators cannot modify super-admin accounts", code: "CANNOT_MODIFY_SUPERADMIN" },
      { status: 403 },
    );
  }
  return null;
}

/**
 * GET /api/fgmp/users/[id]
 * Returns a single user by id. SUPERADMIN + ADMIN only. SUPERADMIN can read
 * any user cross-tenant; ADMIN is scoped to their own tenant (and cannot
 * read SUPERADMIN accounts).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await bootstrap();
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  const limited = limitFor(req, me, false);
  if (limited) return limited;
  const { id } = await ctx.params;
  const user = await db.user.findUnique({ where: { id }, select: userSelect });
  const denied = assertTenantOwned(user, me);
  if (denied) return denied;
  const guarded = guardSuperAdminTarget(user, me);
  if (guarded) return guarded;
  return NextResponse.json(user);
}

/**
 * PUT /api/fgmp/users/[id]
 * Update user fields (name, role, phone, active). NOT password.
 * SUPER_OR_ADMIN. SUPERADMIN may edit any user cross-tenant; ADMIN is scoped
 * to their own tenant and can never touch a SUPERADMIN account or promote a
 * user to SUPERADMIN. Prevents admins from locking themselves out by
 * deactivating their own account via this endpoint.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await bootstrap();
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  const limited = limitFor(req, me, true);
  if (limited) return limited;
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Tenant-admins cannot promote a user to SUPERADMIN.
  if (!isSuperAdminUser(me) && parsed.data.role === "SUPERADMIN") {
    return NextResponse.json(
      { error: "Only super-admins can grant the super-admin role", code: "CANNOT_ASSIGN_SUPERADMIN" },
      { status: 403 },
    );
  }

  const existing = await db.user.findUnique({ where: { id } });
  const denied = assertTenantOwned(existing, me);
  if (denied) return denied;
  const guarded = guardSuperAdminTarget(existing, me);
  if (guarded) return guarded;

  if (id === me.id && parsed.data.active === false) {
    return NextResponse.json(
      { error: "You cannot deactivate your own account" },
      { status: 400 },
    );
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.role !== undefined) data.role = parsed.data.role;
  if (parsed.data.phone !== undefined) data.phone = parsed.data.phone;
  if (parsed.data.active !== undefined) data.active = parsed.data.active;

  const updated = await db.user.update({
    where: { id },
    data,
    select: userSelect,
  });

  await audit({
    userId: me.id,
    tenantId: me.tenantId,
    action: "USER_UPDATE",
    entity: "User",
    entityId: id,
    details: data,
  });

  return NextResponse.json(updated);
}

/**
 * PATCH /api/fgmp/users/[id]
 * Toggle the active flag. Body: { active: boolean }.
 * SUPER_OR_ADMIN. Cannot deactivate self. Tenant-admins cannot touch
 * SUPERADMIN accounts.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await bootstrap();
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  const limited = limitFor(req, me, true);
  if (limited) return limited;
  const { id } = await ctx.params;

  let body: { active?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body?.active !== "boolean") {
    return NextResponse.json({ error: "Missing 'active' boolean" }, { status: 400 });
  }

  if (id === me.id && body.active === false) {
    return NextResponse.json(
      { error: "You cannot deactivate your own account" },
      { status: 400 },
    );
  }

  const existing = await db.user.findUnique({ where: { id } });
  const denied = assertTenantOwned(existing, me);
  if (denied) return denied;
  const guarded = guardSuperAdminTarget(existing, me);
  if (guarded) return guarded;

  const updated = await db.user.update({
    where: { id },
    data: { active: body.active },
    select: userSelect,
  });

  await audit({
    userId: me.id,
    tenantId: me.tenantId,
    action: body.active ? "USER_ACTIVATE" : "USER_DEACTIVATE",
    entity: "User",
    entityId: id,
    details: { active: body.active },
  });

  return NextResponse.json(updated);
}

/**
 * DELETE /api/fgmp/users/[id]
 * Soft-delete by setting active=false. Hard deletes are not supported.
 * SUPER_OR_ADMIN. Cannot soft-delete self. Tenant-admins cannot touch
 * SUPERADMIN accounts.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await bootstrap();
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  const limited = limitFor(req, me, true);
  if (limited) return limited;
  const { id } = await ctx.params;

  if (id === me.id) {
    return NextResponse.json(
      { error: "You cannot deactivate your own account" },
      { status: 400 },
    );
  }

  const existing = await db.user.findUnique({ where: { id } });
  const denied = assertTenantOwned(existing, me);
  if (denied) return denied;
  const guarded = guardSuperAdminTarget(existing, me);
  if (guarded) return guarded;

  const updated = await db.user.update({
    where: { id },
    data: { active: false },
    select: userSelect,
  });

  await audit({
    userId: me.id,
    tenantId: me.tenantId,
    action: "USER_DEACTIVATE",
    entity: "User",
    entityId: id,
    details: { softDelete: true },
  });

  return NextResponse.json(updated);
}
