import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { bootstrap } from "@/lib/fgmp";
import {
  asTenant,
  asTenantForAnotherTenant,
  resolveTenantScope,
  type TenantScopedClient,
} from "@/lib/fgmp/route-tenant";
import {
  requireRole,
  ROLES,
  can,
  isSuperAdminUser,
  requireTenantId,
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
import { PLATFORM_TENANT_ID, superAdminPlacement } from "@/lib/fgmp/platform-identity";

export const dynamic = "force-dynamic";

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
 * A super-admin must NAME the tenant to read another one (`?tenant=t-…`): their
 * session carries `t-platform`, and a session that carried every tenant would
 * make "which tenant am I acting as" unknowable. Without the parameter they see
 * their own tenant, exactly like everybody else. Everyone else is pinned to
 * their own tenant and any `?tenant=` is ignored rather than refused.
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
  // Authorise before touching the database. `bootstrap()` runs
  // `engine.ensureAllTenants()`, so it throws when the database is unreachable —
  // and when it ran first, an unauthenticated request came back 500 instead of
  // 401, which reads like a server fault rather than "log in".
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  await bootstrap();
  try {
    const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
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

    const scope = resolveTenantScope(me, searchParams.get("tenant"));
    // User roster access is the explicit named-tenant administration exception.
    // The selected tenant comes from the scope resolver, never an unfiltered
    // SUPERADMIN list branch.
    const where = { tenantId: scope.tenantId };
    // ── Tenant scoping ────────────────────────────────────────────────────
    // The explicit row filter and transaction context are both derived from
    // the scope resolver. A cross-tenant roster is available only when the
    // super-admin names its tenant; no unfiltered list branch exists.
    const [users, total] = await scope.run((tx) =>
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
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  await bootstrap();
  const superAdmin = isSuperAdminUser(me);

  const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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

  // Granting the platform role is a CAPABILITY, not a role-name comparison.
  //
  // `user:grant-superadmin` is declared in `SUPERADMIN_ONLY_CAPABILITIES`
  // (rbac-core.ts) — only SUPERADMIN holds it, through the `*` wildcard — and
  // `__tests__/platform-tier-parity.test.ts` fails if any other role is given
  // it. Until this check existed the capability was declared and enforced
  // NOWHERE: the guard below compared the caller's role string to "SUPERADMIN"
  // in three separate places (here, `users/[id]` and `grant-guards.ts`), so the
  // matrix could have been edited to grant the key to a new platform role and
  // nothing would have changed. One declared capability, one enforced check.
  if (role === "SUPERADMIN" && !can(me, "user:grant-superadmin")) {
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
  const existing = await asTenant(me, (tx) =>
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
      // A super-admin account lives in the platform tenant — always. This used
      // to be `clientTenantId || PLATFORM_TENANT_ID`, which quietly honoured a
      // customer tenant id: the resulting account's ordinary session would then
      // be scoped to that customer, i.e. standing access to its operational
      // data with no support session, no reason and no expiry. The placement
      // rule (and why it refuses rather than relocates) is in
      // lib/fgmp/platform-identity.ts.
      const placement = superAdminPlacement(clientTenantId);
      if (!placement.ok) {
        return NextResponse.json(
          { error: placement.error, code: placement.code },
          { status: placement.status },
        );
      }
      tenantId = placement.tenantId;
    } else if (!clientTenantId) {
      return NextResponse.json(
        { error: "tenantId is required when creating users as super-admin" },
        { status: 400 },
      );
    } else {
      tenantId = clientTenantId;
    }
  } else {
    // Not a super-admin, so the only legal tenant is the caller's own. Fail
    // closed rather than building a filter from a possibly-absent tenant.
    tenantId = requireTenantId(me);
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
  //
  // ── TWO PATHS, AND WHY THIS USED TO 500 ──────────────────────────────────
  // The call was `asTenantForAnotherTenant(me, tenantId, …)` for EVERY caller.
  // That helper asserts SUPERADMIN at the point the privilege is exercised — by
  // design, so a cross-tenant context cannot be obtained by accident — which
  // means a tenant ADMIN creating a user in their OWN tenant reached the
  // assertion and threw. The route's own error handler turned that into a
  // **500 on POST /api/fgmp/users**: the single most ordinary write a tenant
  // administrator makes ("add a colleague") was broken, and broken in the way
  // that looks like an outage rather than a refusal.
  //
  // The helper was right; the call site was wrong. A super-admin's target may be
  // a client-supplied tenant, which is exactly what the helper exists for. A
  // tenant admin's target is already forced to their own tenant three lines
  // above (`requireTenantId(me)`), so it takes the ordinary `asTenant(me, …)`
  // path — the same context, obtained without claiming a privilege they do not
  // have. Neither branch can widen: the non-super branch cannot name a tenant at
  // all, and the super branch is the only one that reads `clientTenantId`.
  const create = async (tx: TenantScopedClient) => {
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
  };
  const { tenant, user } = superAdmin
    ? await asTenantForAnotherTenant(me, tenantId, create)
    : await asTenant(me, create);
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
