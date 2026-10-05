import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import {
  requireRole,
  ROLES,
  tenantWhereOrAll,
  isSuperAdminUser,
} from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
  MUTATION_LIMIT,
  parseIntParam,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";

export const dynamic = "force-dynamic";

// Platform tenant that owns SUPERADMIN accounts (see seed.ts).
const PLATFORM_TENANT_ID = "t-platform";

const VALID_ROLES = [
  "SUPERADMIN",
  "ADMIN",
  "NOC_OPERATOR",
  "REGIONAL_MANAGER",
  "FIELD_ENGINEER",
  "EXECUTIVE",
  "READONLY",
] as const;

const createUserSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  role: z.enum(VALID_ROLES),
  phone: z.string().max(40).optional().nullable(),
  password: z.string().min(8).max(200),
  // Optional — only honored for SUPERADMIN callers. ADMIN callers always
  // create users in their own tenant regardless of this field.
  tenantId: z.string().max(60).optional(),
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
 * GET /api/fgmp/users
 * Returns the tenant roster (sorted by name ASC) with tenant name.
 *
 * ── SECURITY ───────────────────────────────────────────────────────────────
 * This list used to use a bare `requireAuth()`, so *every* role — including
 * READONLY and EXECUTIVE — could read the full roster of their tenant:
 * email, phone, `lastLoginAt` (i.e. who is online and when), role, and the
 * tenant name. Its sibling `GET /api/fgmp/users/[id]` already required
 * `SUPER_OR_ADMIN`, so the list was strictly weaker than the detail view —
 * an inversion. It now requires the same `ROLES.SUPER_OR_ADMIN` set.
 *
 * SUPERADMIN still sees users across ALL tenants (`tenantWhereOrAll`);
 * everyone else is pinned to their own tenant.
 *
 * Query params (all optional):
 *   - limit  : page size, default 500, max 1000 (`parseIntParam`, so junk
 *              input falls back to the default instead of reaching Prisma
 *              as NaN and 500ing).
 *   - offset : page offset, default 0.
 *
 * The response stays a bare JSON array — `users-view.tsx` types the payload
 * as `UserRow[]` — so the total row count is exposed as the `X-Total-Count`
 * response header instead of an envelope.
 */
export async function GET(req: NextRequest) {
  await bootstrap();
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { searchParams } = new URL(req.url);
    const limit = parseIntParam(searchParams.get("limit"), {
      min: 1,
      max: 1000,
      fallback: 500,
    });
    const offset = parseIntParam(searchParams.get("offset"), {
      min: 0,
      max: 1_000_000,
      fallback: 0,
    });

    const where = tenantWhereOrAll(me);
    // ── Tenant scoping ────────────────────────────────────────────────────
    // `tenantWhereOrAll` builds a WHERE, but a WHERE alone does NOT satisfy
    // RLS: the policy USING is ANDed with it and current_setting is NULL, so
    // this returned zero users and an X-Total-Count of 0 for every caller
    // while returning HTTP 200.
    //
    // Scoped to the CALLER's tenant. A super-admin's unfiltered list is a
    // deliberate cross-tenant capability and is preserved via the where clause;
    // the counts for a non-superadmin cannot reach another tenant's rows.
    const [users, total] = await asTenant(me.tenantId, (tx) =>
      Promise.all([
        tx.user.findMany({
          where,
          orderBy: { name: "asc" },
          select: userSelect,
          take: limit,
          skip: offset,
        }),
        tx.user.count({ where }),
      ]),
    );

    const res = NextResponse.json(users);
    res.headers.set("X-Total-Count", String(total));
    res.headers.set("X-Limit", String(limit));
    res.headers.set("X-Offset", String(offset));
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/users
 * Create a new user. Validates with zod and hashes password with bcryptjs.
 *
 * Authorization matrix (Task 49):
 *   - SUPERADMIN: may create users of ANY role (incl. SUPERADMIN) in ANY
 *     tenant. `tenantId` is required in the body unless the role is
 *     SUPERADMIN (defaults to the platform tenant).
 *   - ADMIN: may create users of any role EXCEPT SUPERADMIN, only in their
 *     OWN tenant. Any client-supplied `tenantId` is ignored.
 *
 * Rate-limited at MUTATION_LIMIT: `bcrypt.hash(password, 10)` burns ~100ms
 * of CPU per call, so an unbounded endpoint here is a cheap DoS amplifier —
 * a single admin session could saturate the event loop with concurrent
 * hashes. The generic MUTATION_LIMIT (60/min) is the same budget every other
 * mutation already uses.
 */
export async function POST(req: NextRequest) {
  await bootstrap();
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  const superAdmin = isSuperAdminUser(me);

  const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
  if (!rl.success) {
    const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { name, email, role, phone, password, tenantId: clientTenantId } = parsed.data;

  // Tenant-admins cannot grant the platform super-admin role.
  if (!superAdmin && role === "SUPERADMIN") {
    return NextResponse.json(
      { error: "Only super-admins can grant the super-admin role", code: "CANNOT_ASSIGN_SUPERADMIN" },
      { status: 403 },
    );
  }

  // Enforce unique email.
  //
  // Scoped by `email` only, deliberately: email must be unique platform-wide,
  // not merely per tenant, and a caller probing for a taken address should be
  // refused regardless of which tenant holds it. Read inside the caller's own
  // tenant context so the probe cannot be used to confirm addresses in OTHER
  // tenants — that would turn a 409 into a cross-tenant enumeration oracle.
  const existing = await asTenant(me.tenantId, (tx) =>
    tx.user.findUnique({ where: { email } }),
  );
  if (existing) {
    return NextResponse.json({ error: "Email already in use" }, { status: 409 });
  }

  // Resolve the effective tenant:
  //   - ADMIN: always their own tenant (ignore client-supplied value).
  //   - SUPERADMIN: use the supplied tenantId; default new SUPERADMINs to the
  //     platform tenant; require an explicit tenantId for any other role.
  let tenantId: string;
  if (superAdmin) {
    if (role === "SUPERADMIN") {
      tenantId = clientTenantId || PLATFORM_TENANT_ID;
    } else if (!clientTenantId) {
      return NextResponse.json(
        { error: "tenantId is required when creating users as super-admin" },
        { status: 400 },
      );
    } else {
      tenantId = clientTenantId;
    }
  } else {
    tenantId = me.tenantId;
  }

  // bcrypt.hash costs ~100ms of blocking CPU, so it is computed BEFORE any
  // transaction is opened: holding a pooled connection (and its row locks) for
  // that long would serialise every other request in the process. Ordering is
  // unchanged from before — validate, authorise, hash, write.
  const passwordHash = await bcrypt.hash(password, 10);

  // Tenant existence check and the insert share one transaction, so a tenant
  // cannot be deleted between them. `Tenant` carries no tenantId and is
  // outside RLS; the `User` insert is what the policy governs.
  //
  // `tenantId` above is either the caller's own or a super-admin's explicit
  // choice — a tenant admin supplying someone else's id is rejected with 403
  // before this point.
  const { tenant, user } = await asTenant(tenantId, async (tx) => {
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!t) return { tenant: null, user: null };
    const created = await tx.user.create({
      data: {
        name,
        email,
        role,
        phone: phone ?? null,
        passwordHash,
        tenantId,
      },
      select: userSelect,
    });
    return { tenant: t, user: created };
  });
  if (!tenant) {
    return NextResponse.json({ error: "Unknown tenantId" }, { status: 400 });
  }

  await audit({
    userId: me.id,
    tenantId,
    action: "USER_CREATE",
    entity: "User",
    entityId: user.id,
    details: { name, email, role, tenantId },
  });

  const res = NextResponse.json(user, { status: 201 });
  applyRateLimitHeaders(res.headers, rl);
  return res;
}
