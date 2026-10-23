import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { resolveTenantScope } from "@/lib/fgmp/route-tenant";
import {
  countOtherActiveSuperAdmins,
  countOtherActiveTenantAdmins,
  evaluateGrantChange,
  removesRole,
} from "@/lib/fgmp/grant-guards";
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
/**
 * `async` is load-bearing, not incidental.
 *
 * `rateLimitByUser` became async when the limiter moved to Redis (Phase 5), so
 * this function awaits it. Without `async` the `await` is a syntax error —
 * `tsc` catches it, but only because the compiler looks at this file. A helper
 * of this shape that is NOT awaited at the call site would instead return a
 * Promise, and `if (!rl.success)` would be false for every request because a
 * Promise has no `.success` — silently disabling rate limiting on this route.
 * Hence: async, awaited, and the response checked.
 */
async function limitFor(req: NextRequest, me: { id: string }, mutating: boolean) {
  const cfg = mutating ? MUTATION_LIMIT : READ_LIMIT;
  const rl = await rateLimitByUser(req, me.id, cfg.limit, cfg.windowMs);
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
  // Authorise before touching the database. `bootstrap()` runs
  // `engine.ensureAllTenants()`, so it throws when the database is unreachable —
  // and when it ran first, an unauthenticated request came back 500 instead of
  // 401, which reads like a server fault rather than "log in".
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  await bootstrap();
  const limited = await limitFor(req, me, false);
  if (limited) return limited;
  const { id } = await ctx.params;
  // ── Tenant scoping ──────────────────────────────────────────────────────
  // Scoped in the QUERY, not filtered after the fetch. assertTenantOwned
  // compares record.tenantId after the row is read, and under FORCE RLS the
  // unscoped read returned null for EVERY user, so that check — and
  // guardSuperAdminTarget below — were comparing against nothing. The Phase 0
  // IDOR fixes were inert rather than merely weak.
  //
  // Cross-tenant and non-existent ids are both null here, so this cannot be
  // used to enumerate user ids.
  const scope = resolveTenantScope(me, new URL(req.url).searchParams.get("tenant"));
  const user = await scope.run((tx) =>
    tx.user.findFirst({ where: { id, tenantId: scope.tenantId }, select: userSelect }),
  );
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
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  await bootstrap();
  const limited = await limitFor(req, me, true);
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

  // A super-admin may name the tenant (`?tenant=`); everybody else is pinned to
  // their own. See resolveTenantScope for why naming is required rather than
  // inferred.
  const scope = resolveTenantScope(me, new URL(req.url).searchParams.get("tenant"));

  const existing = await scope.run((tx) => tx.user.findFirst({ where: { id, tenantId: scope.tenantId } }));
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

  // Privilege rules (self-grant, last administrator, last super-admin). The
  // counts are read in the same tenant context as the write below.
  if (existing) {
    const next = { role: parsed.data.role, active: parsed.data.active };
    const needsTenantCount = removesRole(existing, next);
    const otherActiveAdminsInTenant = needsTenantCount
      ? await scope.run((tx) => countOtherActiveTenantAdmins(tx, scope.tenantId, existing.id))
      : 0;
    const otherActiveSuperAdmins =
      needsTenantCount && existing.role === "SUPERADMIN"
        ? await countOtherActiveSuperAdmins(existing.id)
        : 0;
    const refusal = evaluateGrantChange({
      actorId: me.id,
      actorRole: me.role,
      targetId: existing.id,
      targetRole: existing.role,
      targetActive: existing.active,
      newRole: parsed.data.role,
      newActive: parsed.data.active,
      otherActiveAdminsInTenant,
      otherActiveSuperAdmins,
    });
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: refusal.status });
    }
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.role !== undefined) data.role = parsed.data.role;
  if (parsed.data.phone !== undefined) data.phone = parsed.data.phone;
  if (parsed.data.active !== undefined) data.active = parsed.data.active;

  // `update` takes a unique selector so tenantId cannot be part of it. The
  // ownership re-read below happens in the SAME transaction as the write, so a
  // row that changed tenants between the authorising read and this write cannot
  // be clobbered.
  const updated = await scope.run(async (tx) => {
    const owned = await tx.user.findFirst({
      where: { id, tenantId: scope.tenantId },
      select: { id: true },
    });
    if (!owned) return null;
    return tx.user.update({ where: { id: owned.id }, data, select: userSelect });
  });
  if (!updated) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await audit({
    userId: me.id,
    tenantId: scope.tenantId,
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
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  await bootstrap();
  const limited = await limitFor(req, me, true);
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

  const scope = resolveTenantScope(me, new URL(req.url).searchParams.get("tenant"));

  const existing = await scope.run((tx) => tx.user.findFirst({ where: { id, tenantId: scope.tenantId } }));
  const denied = assertTenantOwned(existing, me);
  if (denied) return denied;
  const guarded = guardSuperAdminTarget(existing, me);
  if (guarded) return guarded;

  // Deactivating the last administrator would leave the tenant with nobody who
  // can manage it; the same rule as PUT, applied to the flag this route owns.
  if (existing && existing.role === "ADMIN" && body.active === false) {
    const others = await scope.run((tx) => countOtherActiveTenantAdmins(tx, scope.tenantId, existing.id));
    const refusal = evaluateGrantChange({
      actorId: me.id,
      actorRole: me.role,
      targetId: existing.id,
      targetRole: existing.role,
      targetActive: existing.active,
      newActive: body.active,
      otherActiveAdminsInTenant: others,
      otherActiveSuperAdmins: 0,
    });
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: refusal.status });
    }
  }
  if (existing && existing.role === "SUPERADMIN" && body.active === false) {
    const others = await countOtherActiveSuperAdmins(existing.id);
    const refusal = evaluateGrantChange({
      actorId: me.id,
      actorRole: me.role,
      targetId: existing.id,
      targetRole: existing.role,
      targetActive: existing.active,
      newActive: body.active,
      otherActiveAdminsInTenant: 0,
      otherActiveSuperAdmins: others,
    });
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: refusal.status });
    }
  }

  // Ownership re-asserted inside the writing transaction — `update` takes a
  // unique selector so tenantId cannot be part of it.
  const updated = await scope.run(async (tx) => {
    const owned = await tx.user.findFirst({
      where: { id, tenantId: scope.tenantId },
      select: { id: true },
    });
    if (!owned) return null;
    return tx.user.update({ where: { id: owned.id }, data: { active: body.active }, select: userSelect });
  });
  if (!updated) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await audit({
    userId: me.id,
    tenantId: scope.tenantId,
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
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  await bootstrap();
  const limited = await limitFor(req, me, true);
  if (limited) return limited;
  const { id } = await ctx.params;

  if (id === me.id) {
    return NextResponse.json(
      { error: "You cannot deactivate your own account" },
      { status: 400 },
    );
  }

  const scope = resolveTenantScope(me, new URL(req.url).searchParams.get("tenant"));

  const existing = await scope.run((tx) => tx.user.findFirst({ where: { id, tenantId: scope.tenantId } }));
  const denied = assertTenantOwned(existing, me);
  if (denied) return denied;
  const guarded = guardSuperAdminTarget(existing, me);
  if (guarded) return guarded;

  // Soft-delete is a deactivation, so the last-administrator rule applies here
  // too. Guarding only PATCH and PUT would leave this hole open.
  if (existing && (existing.role === "ADMIN" || existing.role === "SUPERADMIN")) {
    const otherAdmins =
      existing.role === "ADMIN"
        ? await scope.run((tx) => countOtherActiveTenantAdmins(tx, scope.tenantId, existing.id))
        : 0;
    const otherSupers =
      existing.role === "SUPERADMIN" ? await countOtherActiveSuperAdmins(existing.id) : 0;
    const refusal = evaluateGrantChange({
      actorId: me.id,
      actorRole: me.role,
      targetId: existing.id,
      targetRole: existing.role,
      targetActive: existing.active,
      newActive: false,
      otherActiveAdminsInTenant: otherAdmins,
      otherActiveSuperAdmins: otherSupers,
    });
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: refusal.status });
    }
  }

  // Ownership re-asserted inside the writing transaction — `update` takes a
  // unique selector so tenantId cannot be part of it.
  const updated = await scope.run(async (tx) => {
    const owned = await tx.user.findFirst({
      where: { id, tenantId: scope.tenantId },
      select: { id: true },
    });
    if (!owned) return null;
    return tx.user.update({ where: { id: owned.id }, data: { active: false }, select: userSelect });
  });
  if (!updated) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await audit({
    userId: me.id,
    tenantId: scope.tenantId,
    action: "USER_DEACTIVATE",
    entity: "User",
    entityId: id,
    details: { softDelete: true },
  });

  return NextResponse.json(updated);
}
