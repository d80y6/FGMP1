import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { listTenantRegistry, tenantCountsAll } from "@/lib/fgmp/platform-store";
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

const createTenantSchema = z.object({
  name: z.string().min(2).max(120),
  code: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[A-Z0-9-]+$/i, "code must be alphanumeric/dash"),
  country: z.string().min(2).max(80),
});

/**
 * GET /api/fgmp/tenants
 * Returns tenant registry metadata (sorted by name ASC) with scoped counts.
 * Listing the platform tenant registry is SUPERADMIN-only, matching the
 * tenant-management navigation capability; tenant-scoped users do not make
 * this request. POST/PATCH/DELETE are also SUPERADMIN-only.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap(auth.user);
    void user;
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // ── The registry is platform metadata; the COUNTS are tenant data ──────
    // `Tenant` carries no tenantId and is outside RLS, so the registry itself
    // can be read unscoped. Its relations cannot: `_count` resolves through
    // nested queries, and doing that inside `asTenant(me, …)` resolved every
    // tenant's counts in the CALLER's context. Measured before this change: a
    // super-admin saw the fleet list with `users: 0` for tenants that had five.
    //
    // So the list is read once and the counts are read per tenant, inside that
    // tenant's own context. A non-superadmin only ever sees their own row, so
    // the fan-out costs nothing for them.
    const isSuper = isSuperAdminUser(user);
    const registry = await listTenantRegistry();
    const visible = isSuper ? registry : registry.filter((t) => t.id === user.tenantId);
    // THREE queries for the whole page, not three per tenant. `tenantCountsAll`
    // groups by tenantId on the ops connection (aggregate NUMBERS only, never a
    // row set — see its doc comment and docs/SECURITY.md §3). The previous loop
    // opened one transaction per tenant, so this endpoint got slower as the
    // platform gained customers.
    const counts = await tenantCountsAll(visible.map((t) => t.id));
    const tenants: Array<Record<string, unknown>> = visible.map((t) => ({
      ...t,
      _count: counts.get(t.id) ?? { users: 0, sites: 0, suppressions: 0 },
    }));
    const res = NextResponse.json(tenants);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/tenants
 * Create a new tenant organization. SUPERADMIN-only (Task 49 — only the
 * platform super-admin may provision new tenants; tenant admins no longer
 * can). Validates with createTenantSchema (name, code, country). Enforces
 * unique name + code at the DB layer (Prisma P2002 → 409 handled by
 * errorResponse) plus a cheap pre-check that surfaces a clearer field-level
 * error to the UI.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.SUPERADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap(auth.user);
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const parsed = createTenantSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { name, code, country } = parsed.data;

    // Enforce unique name + code (cheap pre-check; DB constraint is the
    // authoritative guard).
    // `Tenant` itself carries no tenantId column and is outside RLS, so this
    // uniqueness probe needs no tenant context of its own. It still runs inside
    // asTenant() so the route holds no raw `db` reference at all — a single
    // unscoped client handle in a file is how the 300-call class of bug keeps
    // growing back, and the ESLint rule exists to keep that from being possible.
    const existing = await asTenant(user, (tx) =>
      tx.tenant.findFirst({
        where: { OR: [{ name }, { code }] },
        select: { id: true, name: true, code: true },
      }),
    );
    if (existing) {
      const field = existing.name === name ? "name" : "code";
      const res = NextResponse.json(
        { error: `${field === "name" ? "Name" : "Code"} already in use`, field },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const tenant = await asTenant(user, (tx) =>
      tx.tenant.create({
        data: { name, code, country },
        select: tenantSelect,
      }),
    );

    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "TENANT_CREATE",
      entity: "Tenant",
      entityId: tenant.id,
      details: { name, code, country },
    });

    const res = NextResponse.json(tenant, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
