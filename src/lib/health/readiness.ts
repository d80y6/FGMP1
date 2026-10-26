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
 *
 * ── TWO FAILURES, TWO NAMES ─────────────────────────────────────────────────
 * The database layer is imported DYNAMICALLY and the import is inside the guard.
 * A static import would mean that a bundle missing the generated Prisma client —
 * or a runtime where the PostgreSQL driver cannot be resolved, which is a real
 * risk on workerd — made this probe fail to LOAD, i.e. answer `500` exactly when
 * an operator needs it to answer `503` with a reason. `runtime_unavailable`
 * ("redeploy with a correct bundle") and `db_unreachable` ("the network, the
 * credential or the database") are different operator actions and are reported
 * as different reasons.
 */

import { firstConfigProblem } from "@/lib/fgmp/config-health";

/** A dependency check that hangs is "not ready"; the probe must not hang with it. */
export const READINESS_TIMEOUT_MS = 3_000;

export type ReadinessReason =
  | "ok"
  | "db_unreachable"
  | "schema_missing"
  | "timeout"
  /**
   * The deployment's own configuration is wrong — the database role bypasses
   * RLS, a required variable is missing, or the session lifetime is not a
   * number. Reported BEFORE the database is touched, because no query result
   * is meaningful from a process that must not serve (see
   * src/lib/fgmp/config-health.ts). The route publishes the problem CODE, never
   * the problem detail: this endpoint is unauthenticated.
   */
  | "config_invalid"
  /**
   * `src/lib/db.ts` could not even be LOADED — the Prisma client was not
   * generated into the bundle, or the PostgreSQL driver cannot be resolved in
   * this runtime.
   *
   * That failure used to be indistinguishable from a normal 500: the route
   * module imported the database layer statically, so the throw happened while
   * the route itself was being evaluated and the probe answered
   * `500 Internal Server Error`. A readiness probe that cannot outlive the
   * dependency it is probing is not a probe. The import is therefore dynamic and
   * guarded, and this reason says exactly what happened.
   */
  | "runtime_unavailable";

export async function checkReadiness(): Promise<ReadinessReason> {
  if (firstConfigProblem()) return "config_invalid";

  const probe = (async (): Promise<ReadinessReason> => {
    // Dynamic on purpose: a static import would make THIS module — and the route
    // that imports it — fail to load whenever the database layer cannot, which
    // is the case this check exists to report.
    const { db } = await import("@/lib/db");
    const rows = await db.$queryRaw<{ ok: number; tenant: string | null }[]>`
      SELECT 1 AS ok, to_regclass('public."Tenant"')::text AS tenant
    `;
    const row = rows[0];
    if (!row) return "db_unreachable";
    if (!row.tenant) return "schema_missing";
    return "ok";
  })().catch((err: unknown): ReadinessReason =>
    // A module-resolution / client-initialisation failure is a different
    // operator action ("the bundle is wrong, redeploy") from an unreachable
    // database ("the network or the credential is wrong"). Prisma and the driver
    // report the first with a `code`-less Error whose message names the missing
    // module or the driver; anything else is treated as an unreachable database,
    // which is the safe default.
    /Cannot find (module|package|name)|PrismaClientInitializationError|did not initialize|is not implemented|not supported (in|by) this runtime|cloudflare:sockets/i.test(
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    )
      ? "runtime_unavailable"
      : "db_unreachable",
  );

  const timer = new Promise<ReadinessReason>((resolve) => {
    const t = setTimeout(() => resolve("timeout"), READINESS_TIMEOUT_MS);
    // Do not keep the process alive just for the timer.
    if (typeof t === "object" && "unref" in t) t.unref();
  });

  return Promise.race([probe, timer]);
}
