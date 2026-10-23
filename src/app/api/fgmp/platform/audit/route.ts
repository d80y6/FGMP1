import { NextRequest, NextResponse } from "next/server";
import { listPlatformAudit } from "@/lib/fgmp/platform-store";
import { errorResponse } from "@/lib/fgmp/api-error";
import { parseIntParam, rateLimitByUser, READ_LIMIT } from "@/lib/fgmp/rate-limit";
import { requireSuperAdmin } from "@/lib/fgmp/support-request";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/platform/audit
 *
 * The platform trail: who opened a support session, for which tenant, why, and
 * when they closed it. Readable by SUPERADMIN only.
 *
 * ── WHY THIS IS A SEPARATE TABLE FROM THE TENANT AUDIT LOG ─────────────────
 * `AuditLog` is FORCE-RLS protected and scoped to one tenant, which makes it
 * exactly the wrong place to answer a cross-tenant question: "which operator
 * touched which customer". It is also the wrong place for records that must
 * outlive a tenant deletion — a support session that read a deleted tenant's
 * data is precisely the record an investigation needs afterwards.
 *
 * `PlatformAuditLog` has no foreign keys to Tenant or User for that reason, and
 * it is append-only for the application role: the migration grants SELECT and
 * INSERT to `fgmp_app` and withholds UPDATE and DELETE. A trail the code that
 * writes it could also rewrite is not a trail.
 *
 * Filters: `actor` (user id), `tenant`, `action`, `limit` (max 500), `offset`.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;

  const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
  if (!rl.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const limit = parseIntParam(searchParams.get("limit"), { min: 1, max: 500, fallback: 200 });
  const offset = parseIntParam(searchParams.get("offset"), { min: 0, max: 1_000_000, fallback: 0 });
  const actor = searchParams.get("actor");
  const tenant = searchParams.get("tenant");
  const action = searchParams.get("action");

  try {
    const { entries, total } = await listPlatformAudit({ limit, offset, actor, tenant, action });

    const res = NextResponse.json(
      entries.map((e) => ({
        ...e,
        // Stored as text for the same reason AuditLog.details is; parsed here so
        // the UI does not have to. A malformed row is returned as its raw
        // string rather than dropped — a gap must be visible.
        detail: safeParse(e.detail),
      })),
    );
    res.headers.set("X-Total-Count", String(total));
    res.headers.set("X-Limit", String(limit));
    res.headers.set("X-Offset", String(offset));
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
