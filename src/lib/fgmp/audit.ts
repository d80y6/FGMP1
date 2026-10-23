/**
 * Audit trail writer.
 *
 * ── WHY THIS IS NOT "log to console and carry on" ───────────────────────────
 * Under Phase 1's FORCE RLS the old implementation wrote through the ambient
 * `db` (the non-owner `fgmp_app` role) with no tenant context, so
 * `db.auditLog.create()` was rejected by WITH CHECK — and the surrounding
 * `catch` swallowed that error and returned normally. Measured: audit() resolved
 * successfully and wrote 0 rows.
 *
 * The result was that every mutating action across 80+ routes was unauditable,
 * with no error anywhere. For a compliance trail, SILENT LOSS is the one
 * unacceptable outcome: a trail that is quietly empty is worse than no trail,
 * because it looks like evidence exists.
 *
 * ── THE FAILURE MODE CHOSEN, AND WHY ───────────────────────────────────────
 * Three options were considered:
 *
 *   1. Throw. Rejected: ~80 routes call audit() after their mutation. A throw
 *      here turns a completed, correct state change into a 500, so the operator
 *      retries and may double-apply. An audit subsystem must not be able to
 *      corrupt the business operation it is recording.
 *
 *   2. Swallow (the old behaviour). Rejected: silent loss of a compliance trail.
 *
 *   3. Fall back to a durable owner-path write, and make the primary failure
 *      LOUD. CHOSEN. The fallback lands the row on a connection that is not
 *      RLS-restricted, so the record survives; and because that write can also
 *      fail, `audit()` additionally records a hard, countable failure that
 *      health checks and logs can assert on. Neither failure is silent.
 *
 * The fallback is a genuinely cross-tenant-capable write and is scoped as
 * tightly as the auth lookup (see src/lib/auth-identity.ts for the same
 * reasoning): it writes ONE AuditLog row, with the tenantId the CALLER supplies.
 * It cannot be used to read, list or modify any other table.
 */

import type { PrismaClient } from "@prisma/client";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { getOpsDb } from "@/lib/fgmp/owner-db";

export interface AuditParams {
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  details?: Record<string, unknown>;
  tenantId?: string;
  ip?: string;
}

/**
 * Counter of audit writes that could NOT be persisted by any path.
 *
 * A monitoring check should assert this is zero. It exists so "the audit trail
 * is complete" is a checkable statement rather than an assumption — which is
 * precisely what went wrong before.
 */
let failedWrites = 0;

export function auditFailureCount(): number {
  return failedWrites;
}

/** Reset the failure counter. For tests only. */
export function resetAuditFailureCount(): void {
  failedWrites = 0;
}

/**
 * Owner/ops connection used ONLY as the audit fallback.
 *
 * Prefers the ops role over the migrate role: audit writes are operational
 * traffic, not schema changes, so the least-privileged cross-tenant role is the
 * right one when it is available. Shares the bounded `getOpsDb()` pool so
 * audit writes do not allocate a separate connection pool.
 */
function fallbackDb(): PrismaClient {
  const ops = getOpsDb();
  if (!ops) {
    throw new Error(
      "audit fallback requires FGMP_OPS_DATABASE_URL or FGMP_MIGRATE_DATABASE_URL; " +
        "without it an RLS-rejected audit row is lost",
    );
  }
  return ops;
}

/**
 * Resolve the caller's IP for the audit trail (proposal §8.12,
 * Figure 21 — the audit screen shows عنوان IP per action).
 *
 * Next.js exposes the request headers through `headers()`
 * anywhere inside the request scope, so audit() can resolve
 * the IP WITHOUT a request parameter — which is why none of
 * the ~80 call sites change. Outside a request scope (tests,
 * scripts, the scheduler) this throws and resolves to null,
 * which is the honest answer.
 *
 * x-forwarded-for is trusted because the gateway (Caddyfile)
 * REWRITES it to the TCP peer on every proxied request, so a
 * client-supplied value never reaches the app.
 */
async function resolveCallerIp(): Promise<string | null> {
  try {
    const h = await headers();
    const fwd = h.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0].trim();
    return h.get("x-real-ip");
  } catch {
    return null;
  }
}

export async function audit(params: AuditParams): Promise<void> {
  const data = {
    tenantId: params.tenantId ?? "t-default",
    userId: params.userId ?? null,
    action: params.action,
    entity: params.entity,
    entityId: params.entityId ?? null,
    details: JSON.stringify(params.details ?? {}),
    // An explicit ip (edge ingest paths that already parsed
    // it) wins; otherwise resolve it from the request scope.
    ip: params.ip ?? (await resolveCallerIp()),
  };

  try {
    // Preferred path: the ambient client, which is tenant-scoped when the caller
    // established a context. Correct and least-privileged when it works.
    await db.auditLog.create({ data });
    return;
  } catch (primaryErr) {
    // Do NOT throw. The business mutation has already happened; failing the
    // request here would invite a retry that re-applies it.
    console.error(
      `[audit] primary write rejected for ${params.action} on ${params.entity}; ` +
        `falling back to the owner connection`,
      primaryErr,
    );
  }

  try {
    await fallbackDb().auditLog.create({ data });
    console.warn(
      `[audit] ${params.action} on ${params.entity} was recorded via the OWNER ` +
        `fallback, not the tenant-scoped connection. This means the caller did ` +
        `not establish a tenant context — the same defect that makes 300+ route ` +
        `queries silently return zero rows.`,
    );
  } catch (fallbackErr) {
    // Both paths failed. This is the genuinely unacceptable case and it is
    // counted, logged at error level, and never swallowed.
    failedWrites++;
    console.error(
      `[audit] AUDIT WRITE LOST — ${params.action} on ${params.entity} ` +
        `(entityId=${params.entityId ?? "-"}) could not be persisted by either ` +
        `the tenant-scoped or the owner connection. This is a compliance-trail ` +
        `gap and must be investigated. ` +
        `auditFailureCount()=${failedWrites}`,
      fallbackErr,
    );
  }
}

/** Close the fallback connection on shutdown. */
export async function closeAuditClient(): Promise<void> {
  // The fallback pool is shared process-wide with auth, scheduler and health.
  // It is disconnected by disconnectPrivilegedDbs() during graceful shutdown.
}