import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
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
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";

export const dynamic = "force-dynamic";

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

  const existing = await db.user.findUnique({ where: { id } });
  const denied = assertTenantOwned(existing, me);
  if (denied) return denied;

  // Tenant-admins cannot reset a SUPERADMIN's password.
  if (!isSuperAdminUser(me) && existing?.role === "SUPERADMIN") {
    return NextResponse.json(
      { error: "Tenant administrators cannot modify super-admin accounts", code: "CANNOT_MODIFY_SUPERADMIN" },
      { status: 403 },
    );
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  await db.user.update({
    where: { id },
    data: { passwordHash },
  });

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
