import { NextRequest, NextResponse } from "next/server";
import { listAllGrants } from "@/lib/fgmp/platform-store";
import { errorResponse } from "@/lib/fgmp/api-error";
import { rowsToCsv } from "@/lib/fgmp/csv";
import { rateLimitByUser, READ_LIMIT } from "@/lib/fgmp/rate-limit";
import { requireSuperAdmin } from "@/lib/fgmp/support-request";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/platform/grants[?tenant=t-…][&format=csv]
 *
 * The grant inventory as one reviewable artifact: every user, in every tenant,
 * with their role and account state. This is the "review export" half of grant
 * hygiene — the other two halves are enforced on the user routes themselves
 * (no self-grant, last-admin protection; see lib/fgmp/grant-guards.ts).
 *
 * ── WHY THIS IS SUPERADMIN-ONLY AND NOT A TENANT ROUTE ─────────────────────
 * A tenant admin reviewing their own staff is `GET /api/fgmp/users`. This route
 * exists for the platform-level question "who can do what across the whole
 * installation", which is a different question with a different audience. It is
 * also the input to an access review: a CSV that can be diffed between quarters
 * is more useful than a screen that can be looked at once.
 *
 * ── WHY IT FANS OUT PER TENANT ─────────────────────────────────────────────
 * There is no bypass role on this path. `User` is FORCE-RLS protected, so the
 * only way to read all tenants as `fgmp_app` is one scoped read per tenant with
 * `withTenant`. That is O(tenants) queries — acceptable for an export run by
 * hand, and it keeps the property that nothing in the request path can read
 * across tenants without setting a context first.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;

  const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
  if (!rl.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const url = new URL(req.url);
  const tenantFilter = url.searchParams.get("tenant");
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();

  try {
    const rows = await listAllGrants(tenantFilter);

    // Aggregate counts by role are the part a reviewer actually reads; they are
    // computed here rather than in the client so the export is self-describing.
    const summary = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.role] = (acc[r.role] ?? 0) + 1;
      return acc;
    }, {});

    if (format === "csv") {
      const csv = rowsToCsv([
        ["tenant_id", "tenant_name", "tenant_code", "user_id", "email", "name", "role", "active", "last_login_at", "created_at"],
        ...rows.map((r) => [
          r.tenantId,
          r.tenantName,
          r.tenantCode,
          r.userId,
          r.email,
          r.name,
          r.role,
          r.active ? "yes" : "no",
          r.lastLoginAt ? r.lastLoginAt.toISOString() : "",
          r.createdAt.toISOString(),
        ]),
      ]);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="fgmp-grants-${new Date().toISOString().slice(0, 10)}.csv"`,
          // An access review is sensitive; keep it out of shared caches.
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      totals: { users: rows.length, byRole: summary },
      grants: rows,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
