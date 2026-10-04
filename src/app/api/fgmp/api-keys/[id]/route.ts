import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES, assertTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * API Keys → single-key endpoints (Task 35-E).
 * ────────────────────────────────────────────────────────────────────────────
 * GET   /api/fgmp/api-keys/[id]   → fetch a single key (no raw key exposed)
 * PATCH /api/fgmp/api-keys/[id]   → revoke the key (set revoked=true, revokedAt=now)
 *
 * The PATCH body is interpreted as a revoke action — only `{ revoked: true }`
 * or `{ action: "revoke" }` is accepted. Key secrets are immutable once
 * created; if a key is compromised the operator must revoke + create a new one.
 *
 * All operations are ADMIN-only and tenant-scoped: a key belonging to another
 * tenant returns 404 (so existence is never leaked).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id } = await ctx.params;
    const k = await db.apiKey.findUnique({ where: { id } });
    const denied = assertTenantOwned(k, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!k) {
      const res = NextResponse.json({ error: "API key not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Resolve creator (plain-string FK, not a Prisma relation).
    const creator = k.createdBy
      ? await db.user.findUnique({
          where: { id: k.createdBy },
          select: { id: true, name: true, email: true },
        })
      : null;

    const res = NextResponse.json({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      scopes: k.scopes,
      ipAllowlist: k.ipAllowlist,
      createdBy: k.createdBy,
      creatorName: creator?.name ?? null,
      creatorEmail: creator?.email ?? null,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      expiresAt: k.expiresAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      revoked: k.revoked,
      createdAt: k.createdAt.toISOString(),
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/api-keys/[id]
 * ADMIN-only. Revoke the key. Body:
 *   { revoked: true }   — preferred shape (mirrors the model field)
 *   { action: "revoke" } — alternative
 *
 * Idempotent: revoking an already-revoked key just re-stamps revokedAt and
 * returns 200. The keyHash + keyPrefix are preserved for audit history.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id } = await ctx.params;
    const existing = await db.apiKey.findUnique({ where: { id } });
    const denied = assertTenantOwned(existing, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "API key not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const wantsRevoke =
      (body as { revoked?: unknown }).revoked === true ||
      (body as { action?: unknown }).action === "revoke";
    if (!wantsRevoke) {
      const res = NextResponse.json(
        { error: "Only revoke is supported (body: { revoked: true })" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const now = new Date();
    const updated = await db.apiKey.update({
      where: { id },
      data: { revoked: true, revokedAt: now },
    });

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "CONTROL",
      entity: "ApiKey",
      entityId: id,
      details: {
        name: existing.name,
        keyPrefix: existing.keyPrefix,
        revokedAt: now.toISOString(),
      },
    });

    const res = NextResponse.json({
      ok: true,
      id: updated.id,
      revoked: updated.revoked,
      revokedAt: updated.revokedAt?.toISOString() ?? null,
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
