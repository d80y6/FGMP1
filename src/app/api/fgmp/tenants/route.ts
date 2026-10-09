import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
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
 * Returns all tenants (sorted by name ASC) with counts of users, sites and
 * suppressions. Any authenticated session may list tenants — ADMIN-only
 * mutations are enforced on POST/PATCH/DELETE.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    void user;
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // SUPERADMIN sees all tenants; everyone else only sees their own.
    // The Tenant model is keyed by its own `id` — it has no `tenantId`
    // column — so a non-super-admin is pinned on `id`, not `tenantId`.
    // ── Why this needs a tenant context even though Tenant has no RLS ────────
    // `Tenant` is keyed by its own `id` and carries no `tenantId` column, so the
    // row itself is readable unscoped. The `_count` relations are NOT: users,
    // sites and suppressions all carry `tenantId` and are FORCE-RLS protected,
    // and Prisma resolves relation counts through nested queries on the
    // ambient client. Measured:
    //
    //     unscoped -> _count: { users: 0, sites: 0, suppressions: 0 }
    //     scoped   -> _count: { users: 5, sites: 52, suppressions: 0 }
    //
    // So without this the endpoint reported that a 52-site tenant had no users
    // and no sites — a silent, plausible-looking wrong answer rather than an
    // error.
    //
    // A non-superadmin is still pinned to their own `id`; a superadmin listing
    // all tenants gets counts scoped to THEIR tenant, which is the honest
    // answer for counts they are not entitled to see. The tenant list itself is
    // platform-level and deliberately not scoped.
    const tenants = await asTenant(user, (tx) =>
      tx.tenant.findMany({
        where: isSuperAdminUser(user) ? {} : { id: user.tenantId },
        orderBy: { name: "asc" },
        select: tenantSelect,
      }),
    );
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
    const { user } = await bootstrap();
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
