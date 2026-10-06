import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
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
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Signals that the target user was no longer resolvable inside the writing
 * tenant's scope between the authorising read and the write itself.
 *
 * A distinct type so the catch above can distinguish "refused" from a genuine
 * database error — a real error must still propagate rather than be reported to
 * the caller as a 404.
 */
class CrossTenantResetError extends Error {}

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(200),
});

/**
 * POST /api/fgmp/users/[id]/reset-password
 * Hashes a new password with bcryptjs and stores it as passwordHash.
 * SUPER_OR_ADMIN. Cannot reset own password via this endpoint (use the
 * password-change flow). Tenant-admins cannot reset a SUPERADMIN's password.
 *
 * Rate-limited at MUTATION_LIMIT: `bcrypt.hash(password, 10)` costs ~100ms
 * of blocking CPU per call, so an unbounded endpoint here is a cheap CPU-DoS
 * amplifier — a handful of concurrent admin sessions can saturate the event
 * loop and stall every other request in the process.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await bootstrap();
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  const me = auth.user;

  const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
  if (!rl.success) {
    const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  const { id } = await ctx.params;

  if (id === me.id) {
    return NextResponse.json(
      { error: "Use the password-change flow to reset your own password" },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // ── Tenant scoping ──────────────────────────────────────────────────────
  // This writes a CREDENTIAL, so the scoping is security-critical rather than
  // cosmetic. The lookup is scoped by tenantId IN THE QUERY: `User` is
  // FORCE-RLS protected, so the unscoped `findUnique` returned null for every
  // user and `assertTenantOwned` below was comparing against nothing — the
  // Phase 0 check was inert, not merely weak.
  //
  // Scoping in the where clause also makes "other tenant" and "no such user"
  // indistinguishable: both yield null here and fall through to the same 404,
  // so this endpoint cannot be used to discover valid user ids.
  const existing = await asTenant(me, (tx) =>
    tx.user.findFirst({ where: { id, tenantId: me.tenantId } }),
  );
  // Kept as defence in depth — the query above already scopes by tenantId.
  const denied = assertTenantOwned(existing, me);
  if (denied) return denied;

  // Tenant-admins cannot reset a SUPERADMIN's password.
  if (!isSuperAdminUser(me) && existing?.role === "SUPERADMIN") {
    return NextResponse.json(
      { error: "Tenant administrators cannot modify super-admin accounts", code: "CANNOT_MODIFY_SUPERADMIN" },
      { status: 403 },
    );
  }

  if (!existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // bcrypt.hash costs ~100ms of blocking CPU, so it is computed OUTSIDE any
  // transaction: holding a pooled connection (and its row locks) open for that
  // long would serialise every other request in the process. The ordering is
  // unchanged from before — read, authorise, hash, write — so the guard still
  // runs before any expensive work.
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  // Re-scope by tenant AND id on the write. `update` takes a unique selector, so
  // tenantId cannot be part of it; the assertion below re-checks ownership
  // inside the same transaction that performs the write, so a row changing
  // tenants between the read and the write cannot be clobbered.
  let wrote = false;
  try {
    await asTenant(me, async (tx) => {
      const owner = await tx.user.findFirst({
        where: { id, tenantId: me.tenantId },
        select: { id: true },
      });
      if (!owner) throw new CrossTenantResetError();
      await tx.user.update({ where: { id: owner.id }, data: { passwordHash } });
      wrote = true;
    });
  } catch (err) {
    // A refusal must become a 404 identical to "no such user"; anything else is
    // a real failure and is re-thrown so it is not disguised as a 404.
    if (!(err instanceof CrossTenantResetError)) throw err;
  }
  if (!wrote) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await audit({
    userId: me.id,
    tenantId: me.tenantId,
    action: "USER_RESET_PASSWORD",
    entity: "User",
    entityId: id,
    details: { by: me.email },
  });

  const res = NextResponse.json({ ok: true });
  applyRateLimitHeaders(res.headers, rl);
  return res;
}
