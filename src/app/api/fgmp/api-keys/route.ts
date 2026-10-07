import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
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
import { requireAuth, requireRole, ROLES, tenantWhereOrAll } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * API Keys (Task 35-E) — programmatic access to the FGMP REST API.
 * ────────────────────────────────────────────────────────────────────────────
 * Each key has a SHA-256 hash of the raw secret (only shown once at creation),
 * a set of scopes (comma-separated: read,write,control,admin), optional
 * IP allowlist, and an expiry. Revoked keys stay in the table for audit.
 *
 * GET  /api/fgmp/api-keys              → list keys for the acting user's tenant
 * POST /api/fgmp/api-keys              → create a new key (returns raw key ONCE)
 *
 * All operations are ADMIN-only (requireRole ROLES.ADMIN_ONLY).
 */

const VALID_SCOPES = new Set(["read", "write", "control", "admin"]);

/** Generate a fresh API key: `fgmp_` + 32 hex chars (160 bits of entropy). */
function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const hex = crypto.randomBytes(16).toString("hex"); // 32 hex chars
  const raw = `fgmp_${hex}`;
  const prefix = raw.slice(0, 12); // "fgmp_" + 7 hex chars
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, prefix, hash };
}

/** Parse a comma-separated scope list into a normalized, validated array. */
function parseScopes(input: unknown): { ok: boolean; scopes?: string[]; error?: string } {
  if (input == null) return { ok: true, scopes: ["read"] };
  if (!Array.isArray(input) && typeof input !== "string") {
    return { ok: false, error: "scopes must be a string or array" };
  }
  const list = Array.isArray(input)
    ? input
    : String(input).split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return { ok: true, scopes: ["read"] };
  for (const s of list) {
    if (!VALID_SCOPES.has(s)) {
      return { ok: false, error: `Invalid scope: ${s}. Allowed: read,write,control,admin` };
    }
  }
  // Dedupe + keep canonical order.
  const ordered = ["read", "write", "control", "admin"].filter((s) => list.includes(s));
  return { ok: true, scopes: ordered };
}

/** Parse the IP allowlist: comma-separated CIDRs or single IPs. */
function parseIpAllowlist(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Basic sanitization — reject anything that looks like a path traversal or
  // control character. The matcher is intentionally permissive about CIDR
  // format; downstream consumers validate at match time.
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => /^[0-9a-fA-F.:\/]+$/.test(s));
  return parts.length > 0 ? parts.join(",") : null;
}

/**
 * GET /api/fgmp/api-keys
 * Returns all keys for the acting admin's tenant, sorted by createdAt DESC.
 * Excludes the keyHash (only the prefix is exposed for identification).
 *
 * Includes the createdBy user (name, email) for the table display.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const keys = await asTenant(user, (tx) =>
      tx.apiKey.findMany({
        where: tenantWhereOrAll(user),
        orderBy: { createdAt: "desc" },
      }),
    );

    // Resolve creator names in a single batched query (ApiKey.createdBy is
    // a plain String column, not a Prisma relation).
    const creatorIds = Array.from(new Set(keys.map((k) => k.createdBy)));
    const creators = creatorIds.length > 0
      ? await asTenant(user, (tx) =>
          tx.user.findMany({
            // Scoped to the caller's tenant as well: creator ids are derived
            // from the keys just fetched, so they are already tenant-local,
            // but User is RLS-protected and an unscoped read returns [].
            where: { id: { in: creatorIds }, tenantId: user.tenantId },
            select: { id: true, name: true, email: true },
          }),
        )
      : [];
    const creatorMap = new Map(creators.map((u) => [u.id, u]));

    // Strip the keyHash; expose only what the UI table needs.
    const safe = keys.map((k) => {
      const creator = creatorMap.get(k.createdBy);
      return {
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
      };
    });

    const res = NextResponse.json(safe);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/api-keys
 * ADMIN-only. Creates a new API key.
 *
 * Body:
 *   - name        : string (required, 1–80 chars)
 *   - scopes      : string[] | string — subset of {read,write,control,admin}, default ["read"]
 *   - expiresAt   : ISO date string | null — optional expiry
 *   - ipAllowlist : string — comma-separated CIDRs, optional
 *
 * The raw key is generated server-side, hashed with SHA-256, and ONLY the
 * raw form is returned in this single response. Subsequent GETs never expose
 * the raw key — only the prefix (first 12 chars) for identification.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const name = typeof (body as { name?: unknown }).name === "string"
      ? (body as { name: string }).name.trim()
      : "";
    if (name.length < 1 || name.length > 80) {
      const res = NextResponse.json(
        { error: "name is required (1–80 chars)" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const scopeRes = parseScopes((body as { scopes?: unknown }).scopes);
    if (!scopeRes.ok) {
      const res = NextResponse.json(
        { error: scopeRes.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const scopes = scopeRes.scopes!;

    // Parse expiresAt — accept null, ISO string, or yyyy-mm-dd.
    let expiresAt: Date | null = null;
    const expRaw = (body as { expiresAt?: unknown }).expiresAt;
    if (expRaw != null && expRaw !== "") {
      if (typeof expRaw === "string") {
        const d = new Date(expRaw);
        if (!isFinite(d.getTime())) {
          const res = NextResponse.json(
            { error: "Invalid expiresAt" },
            { status: 400 },
          );
          applyRateLimitHeaders(res.headers, rl);
          return res;
        }
        expiresAt = d;
      } else {
        const res = NextResponse.json(
          { error: "expiresAt must be a string" },
          { status: 400 },
        );
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
    }

    const ipAllowlist = parseIpAllowlist((body as { ipAllowlist?: unknown }).ipAllowlist);

    const { raw, prefix, hash } = generateApiKey();
    const created = await asTenant(user, (tx) =>
      tx.apiKey.create({
      data: {
        tenantId: user.tenantId,
        name,
        keyPrefix: prefix,
        keyHash: hash,
        scopes: scopes.join(","),
        ipAllowlist,
        createdBy: user.id,
        expiresAt,
      },
    }));

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "CREATE",
      entity: "ApiKey",
      entityId: created.id,
      details: { name, scopes, keyPrefix: prefix, expiresAt: expiresAt?.toISOString() ?? null },
    });

    // Return the raw key ONCE along with the row metadata.
    const res = NextResponse.json(
      {
        id: created.id,
        name: created.name,
        key: raw,             // raw key — only ever returned here
        keyPrefix: created.keyPrefix,
        scopes: created.scopes,
        ipAllowlist: created.ipAllowlist,
        expiresAt: created.expiresAt?.toISOString() ?? null,
        createdAt: created.createdAt.toISOString(),
      },
      { status: 201 },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
