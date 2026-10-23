/**
 * Readiness probe implementation.
 *
 * Lives outside `src/app/api` on purpose: route handlers are lint-restricted
 * from importing the raw Prisma client, because under FORCE RLS an unscoped
 * query silently returns zero rows. That guard is correct for request paths and
 * wrong for this one — a readiness check must not be tenant-scoped; it asks the
 * database a catalogue-level question that belongs to no tenant:
 *
 *   SELECT 1                          → the role can connect
 *   to_regclass('public."Tenant"')    → the migrations have been applied
 *
 * Both are answered from the system catalogue, so no tenant policy applies and
 * no row data is read.
 */

import { db } from "@/lib/db";

/** A dependency check that hangs is "not ready"; the probe must not hang with it. */
export const READINESS_TIMEOUT_MS = 3_000;

export type ReadinessReason =
  | "ok"
  | "db_unreachable"
  | "schema_missing"
  | "timeout";

export async function checkReadiness(): Promise<ReadinessReason> {
  const probe = (async (): Promise<ReadinessReason> => {
    const rows = await db.$queryRaw<{ ok: number; tenant: string | null }[]>`
      SELECT 1 AS ok, to_regclass('public."Tenant"')::text AS tenant
    `;
    const row = rows[0];
    if (!row) return "db_unreachable";
    if (!row.tenant) return "schema_missing";
    return "ok";
  })().catch((): ReadinessReason => "db_unreachable");

  const timer = new Promise<ReadinessReason>((resolve) => {
    const t = setTimeout(() => resolve("timeout"), READINESS_TIMEOUT_MS);
    // Do not keep the process alive just for the timer.
    if (typeof t === "object" && "unref" in t) t.unref();
  });

  return Promise.race([probe, timer]);
}
