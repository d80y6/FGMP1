/**
 * Platform audit trail, and the tenant-visible half of support activity.
 *
 * ── WHY TWO SINKS AND NOT ONE ───────────────────────────────────────────────
 * A support session produces two records with two different audiences and two
 * different retention rules:
 *
 *   PlatformAuditLog — global, readable only by SUPERADMIN, and deliberately
 *      NOT tenant-scoped. It must survive the tenant being deleted, so it has no
 *      foreign keys to Tenant or User. Its job is to answer "which operator
 *      looked at which customer, when, and why" for the platform operator.
 *
 *   AuditLog (the tenant's own) — written INSIDE `withTenant(targetTenantId)`,
 *      so it lands inside that tenant's RLS boundary and appears in the
 *      tenant's own audit view. Its job is to make support access VISIBLE TO
 *      THE CUSTOMER rather than only to the platform. A support capability the
 *      customer cannot see is the kind of thing that ends up in a regulator's
 *      question.
 *
 * ── WHY THE TENANT NOTICE DOES NOT CARRY THE OPERATOR'S userId ──────────────
 * `AuditLog.userId` is a foreign key to `User`. The operator lives in the
 * platform tenant; the notice lives in the customer tenant. Setting the FK
 * would (a) make the customer's audit row depend on a row in another tenant
 * that can be deleted, and (b) make the audit route's `include: { user }` join
 * return null under RLS anyway, because the joined User row is filtered out.
 * The operator's identity therefore travels in `details` as text, which is
 * exactly how the tenant's UI renders it — and the authoritative actor record
 * is the `PlatformAuditLog` row plus the `SupportSession` itself.
 *
 * ── WHY WRITES HERE CANNOT TAKE DOWN THE THING THEY RECORD ──────────────────
 * The platform sink logs and counts failures instead of throwing: an operator
 * halfway through diagnosing a production incident must not be thrown out
 * because the audit table is full. It does NOT swallow them: every failure
 * increments a counter that a health check can assert on, and `audit.ts`
 * already established that reasoning for the tenant trail.
 *
 * The tenant notice sink DOES throw, and the caller decides — because "the
 * customer was not told" is a decision that belongs at the call site, not in
 * the sink.
 */

import { db } from "@/lib/db";
import { withTenant } from "@/lib/fgmp/tenant-context";
import type { PlatformAuditSink, TenantNoticeSink } from "./support-session";

let failedPlatformWrites = 0;

/**
 * Count of platform audit rows that could not be persisted.
 *
 * A monitoring check should assert this is zero. Same contract as
 * `auditFailures()` in audit.ts and `supportSessionFailures()` in
 * support-session.ts: the number exists so the claim "the trail is complete" is
 * checkable.
 */
export function platformAuditFailures(): number {
  return failedPlatformWrites;
}

/** Test hook. */
export function __resetPlatformAuditFailures(): void {
  failedPlatformWrites = 0;
}

export const platformAudit: PlatformAuditSink = {
  async record(entry) {
    try {
      await db.platformAuditLog.create({
        data: {
          actorUserId: entry.actorUserId,
          actorEmail: entry.actorEmail,
          action: entry.action,
          targetTenantId: entry.targetTenantId ?? null,
          supportSessionId: entry.supportSessionId ?? null,
          // JSON text, same shape as AuditLog.details. Serialised here rather
          // than at each call site so an un-serialisable value cannot produce a
          // half-written row.
          detail: JSON.stringify(entry.detail ?? {}),
          ip: entry.ip ?? null,
          createdAt: entry.at,
        },
      });
    } catch (err) {
      failedPlatformWrites += 1;
      // Loud: the operator's session continues, but the gap is countable and
      // it is in the application log with the action that was lost.
      console.error(
        `[platform-audit] FAILED to record ${entry.action} for tenant ${entry.targetTenantId ?? "-"} (total failures: ${failedPlatformWrites})`,
        err,
      );
    }
  },
};

/**
 * Write a support notice into the tenant's own audit log.
 *
 * Runs inside `withTenant`, so RLS accepts the row because the tenant context
 * IS the tenant the notice names. There is no bypass here: this is an ordinary
 * tenant-scoped write performed by a platform component.
 */
export const tenantNotice: TenantNoticeSink = {
  async record(entry) {
    await withTenant(entry.tenantId, async (tx) => {
      await tx.auditLog.create({
        data: {
          tenantId: entry.tenantId,
          // See the file header: the operator lives in another tenant, so the
          // FK is deliberately left null and the identity is in `details`.
          userId: null,
          action: entry.action,
          entity: "SupportSession",
          entityId: entry.supportSessionId,
          details: JSON.stringify({
            ...entry.detail,
            actorUserId: entry.actorUserId,
            actorKind: "platform-support",
          }),
          ip: entry.ip ?? null,
        },
      });
    });
  },
};
