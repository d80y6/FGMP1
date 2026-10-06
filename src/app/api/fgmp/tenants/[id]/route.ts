import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, isSuperAdminUser } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

const tenantSelect = {
  id: true,
  name: true,
  code: true,
  country: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { users: true, sites: true, suppressions: true } },
} as const;

const updateTenantSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  code: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[A-Z0-9-]+$/i, "code must be alphanumeric/dash")
    .optional(),
  country: z.string().min(2).max(80).optional(),
});

/**
 * GET /api/fgmp/tenants/[id]
 * Returns a single tenant by id with counts. Any authenticated session.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;
  // ── Tenant scoping ────────────────────────────────────────────────────
  // `Tenant` has no tenantId column and no RLS, so the ROW reads fine
  // unscoped — but `tenantSelect` includes _count over users/sites/
  // suppressions, which ARE FORCE-protected and resolve on this same client.
  // Measured unscoped vs scoped: {users:0, sites:0} vs {users:5, sites:52}.
  // So without the context this route reported that a 52-site tenant had no
  // users and no sites, behind a 200.
  //
  // The tenantId used is the ACTOR's, never the `:id` path parameter: a tenant
  // admin must not be able to read another tenant's user/site counts by
  // editing the URL.
    const tenant = await asTenant(me, (tx) =>
      tx.tenant.findUnique({ where: { id }, select: tenantSelect }),
    );
    // SUPERADMIN can read any tenant; everyone else only their own.
    //
    // `user` here was the pre-Phase-1 `const { user } = await bootstrap()`
    // binding, which no longer exists — so this read a ReferenceError and the
    // 404 branch below it was unreachable. The actor is `me` (from the
    // session), and it must stay `me`: this is the authorisation check that
    // decides whether a SUPERADMIN sees another tenant's counts.
    if (!isSuperAdminUser(me) && (!tenant || tenant.id !== me.tenantId)) {
      const res = NextResponse.json({ error: "Tenant not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (!tenant) {
      const res = NextResponse.json({ error: "Tenant not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const res = NextResponse.json(tenant);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/tenants/[id]
 * Update tenant mutable fields (name, code, country). SUPERADMIN-only
 * (Task 49 — only the platform super-admin may edit tenant organizations;
 * tenant admins no longer can). Enforces unique name + code when changed.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.SUPERADMIN_ONLY);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const parsed = updateTenantSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = parsed.data;
    if (Object.keys(data).length === 0) {
      const res = NextResponse.json({ error: "No fields to update" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const existing = await asTenant(me, (tx) =>
      tx.tenant.findUnique({ where: { id }, select: tenantSelect }),
    );
    if (!existing) {
      const res = NextResponse.json({ error: "Tenant not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // Enforce unique name + code if either is being changed.
    if (data.name || data.code) {
      const clash = await asTenant(me, (tx) => tx.tenant.findFirst({
        where: {
          AND: [
            { id: { not: id } },
            {
              OR: [
                data.name ? { name: data.name } : {},
                data.code ? { code: data.code } : {},
              ],
            },
          ],
        },
        select: { id: true, name: true, code: true },
      }));
      if (clash) {
        const field = data.name && clash.name === data.name ? "name" : "code";
        const res = NextResponse.json(
          { error: `${field === "name" ? "Name" : "Code"} already in use`, field },
          { status: 409 },
        );
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
    }

    const updated = await asTenant(me, (tx) => tx.tenant.update({
      where: { id },
      data,
      select: tenantSelect,
    }),
    );

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "TENANT_UPDATE",
      entity: "Tenant",
      entityId: id,
      details: data as Record<string, unknown>,
    });

    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/tenants/[id]
 * Hard-delete a tenant. SUPERADMIN-only (Task 49). The schema has no
 * onDelete: Cascade on Tenant → User/Site relations (they reference
 * Tenant.id without explicit cascade), so a tenant with dependent rows
 * cannot be deleted at the DB layer. To prevent accidental mass data loss
 * we explicitly pre-check the counts and refuse deletion if the tenant
 * still has users or sites — the super-admin must reassign/retire them
 * first.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.SUPERADMIN_ONLY);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;

    // ── This count is a SAFETY GATE, not a display value ────────────────────
    // The delete is refused when the tenant still owns users or sites, and that
    // decision is made from `_count` over two FORCE-RLS-protected relations.
    // Read unscoped they return 0 for a tenant that demonstrably has 5 users
    // and 52 sites (measured), so the guard read "no users, no sites" and
    // would have ALLOWED the delete of a populated tenant. The destructive
    // action then hits the FK layer instead of being refused cleanly with a
    // 409 — data-loss semantics decided by a query that had silently stopped
    // returning rows.
    //
    // The actor's tenant context is used, never the `:id` path parameter.
    const existing = await asTenant(me, (tx) =>
      tx.tenant.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          code: true,
          _count: { select: { users: true, sites: true, suppressions: true } },
        },
      }),
    );
    if (!existing) {
      const res = NextResponse.json({ error: "Tenant not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Safety: refuse to delete tenants that still own data. Deleting a tenant
    // that still has users/sites would either cascade-destructively (data
    // loss) or fail at the FK layer. Force the admin to clean up first.
    if (existing._count.users > 0 || existing._count.sites > 0) {
      const res = NextResponse.json(
        {
          error:
            "Cannot delete a tenant with users or sites. Reassign or remove them first.",
          counts: existing._count,
        },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Re-check inside the deleting transaction. `delete` takes a unique
    // selector so tenantId cannot be part of it; the counts are re-read in the
    // SAME transaction that performs the delete, so a user or site created
    // between the guard and this statement cannot slip a populated tenant
    // through the safety gate.
    const deleted = await asTenant(me, async (tx) => {
      const stillOwns = await tx.tenant.findUnique({
        where: { id },
        select: { _count: { select: { users: true, sites: true } } },
      });
      if (!stillOwns) return "missing" as const;
      if (stillOwns._count.users > 0 || stillOwns._count.sites > 0) {
        return "populated" as const;
      }
      await tx.tenant.delete({ where: { id } });
      return "deleted" as const;
    });
    if (deleted === "missing") {
      const res = NextResponse.json({ error: "Tenant not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (deleted === "populated") {
      const res = NextResponse.json(
        {
          error:
            "Cannot delete a tenant with users or sites. Reassign or remove them first.",
        },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "TENANT_DELETE",
      entity: "Tenant",
      entityId: id,
      details: { name: existing.name, code: existing.code },
    });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
