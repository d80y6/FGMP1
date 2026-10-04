import { db } from "@/lib/db";

export async function audit(params: {
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  details?: Record<string, unknown>;
  tenantId?: string;
  ip?: string;
}) {
  try {
    await db.auditLog.create({
      data: {
        tenantId: params.tenantId ?? "t-default",
        userId: params.userId ?? null,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId ?? null,
        details: JSON.stringify(params.details ?? {}),
        ip: params.ip ?? null,
      },
    });
  } catch (e) {
    // never let audit failure break the request
    console.error("[audit] failed", e);
  }
}
