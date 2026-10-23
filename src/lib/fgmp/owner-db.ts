/**
 * Which connection system-level work (seeding) runs on.
 *
 * ── WHY THIS IS A MODULE AND NOT A LINE OF CODE ─────────────────────────────
 * It WAS a line of code, and it was silently wrong:
 *
 *     //const url = process.env.FGMP_MIGRATE_DATABASE_URL;
 *     const url = process.env.DATABASE_URL;
 *
 * With the owner URL commented out, `systemDb()` built its "owner" client from
 * the app's RLS-enforced role. Every seed then died on the first insert with
 *
 *     ERROR: new row violates row-level security policy for table "User"
 *
 * which is precisely the failure the owner client exists to avoid, and it
 * looked like a migration or policy bug rather than a one-line edit. The seed
 * is a documented deploy step (`bun run db:seed`), so the deployment path was
 * broken for every correctly configured environment while every local run
 * without RLS kept working.
 *
 * Keeping the precedence in one exported, tested function is what makes that
 * regression visible: a test asserts the owner URL wins, so commenting it out
 * again fails CI instead of failing the first production seed.
 */

/**
 * The environment this decision reads.
 *
 * A plain record rather than a two-property interface: TypeScript's "weak type"
 * rule rejects `process.env` (which shares no declared property with a narrower
 * interface), and `Record<string, string | undefined>` is exactly what Node
 * supplies.
 */
import { PrismaClient } from "@prisma/client";
import { configurePoolUrl } from "@/lib/db";

export type OwnerDbEnv = Record<string, string | undefined>;

const globalForPrivilegedPools = globalThis as unknown as {
  __fgmpPrivilegedPools?: Map<string, PrismaClient>;
};

const privilegedLogLevels = [
  { level: "warn" as const, emit: "stdout" as const },
  { level: "error" as const, emit: "stdout" as const },
];

/**
 * Shared singleton factory for privileged (`fgmp_ops` / `fgmp_migrate`)
 * PrismaClient instances.
 *
 * Consolidating all cross-tenant system helpers (`auth-identity`, `audit`,
 * `rbac`, `realtime-emitter`, `scheduler`, `seed`, `health`,
 * `tenant-isolation-test`) onto ONE pooled singleton per DSN (capped at
 * `connection_limit=1` on serverless and long-lived servers) prevents
 * 8 separate pools of 5–9 connections each from exhausting a 15-connection
 * hosted PostgreSQL pool.
 */
export function getPrivilegedDb(
  rawUrl: string,
  env: OwnerDbEnv = process.env,
): PrismaClient {
  const normalizedUrl = configurePoolUrl(rawUrl, { defaultLimit: 1, env });
  if (!globalForPrivilegedPools.__fgmpPrivilegedPools) {
    globalForPrivilegedPools.__fgmpPrivilegedPools = new Map();
  }
  const cache = globalForPrivilegedPools.__fgmpPrivilegedPools;
  const existing = cache.get(normalizedUrl);
  if (existing) return existing;
  const created = new PrismaClient({
    datasources: { db: { url: normalizedUrl } },
    log: privilegedLogLevels,
  });
  cache.set(normalizedUrl, created);
  return created;
}

/**
 * Shared ops/owner client for narrow cross-tenant system operations, or `null`
 * when neither `FGMP_OPS_DATABASE_URL` nor `FGMP_MIGRATE_DATABASE_URL` is set.
 */
export function getOpsDb(env: OwnerDbEnv = process.env): PrismaClient | null {
  const raw =
    env.FGMP_OPS_DATABASE_URL ||
    env.FGPS_OPS_DATABASE_URL ||
    env.FGMP_MIGRATE_DATABASE_URL ||
    undefined;
  if (!raw) return null;
  return getPrivilegedDb(raw, env);
}

/** Disconnect all process-shared privileged clients during graceful shutdown. */
export async function disconnectPrivilegedDbs(): Promise<void> {
  const pools = globalForPrivilegedPools.__fgmpPrivilegedPools;
  if (!pools) return;
  await Promise.all([...pools.values()].map((client) => client.$disconnect()));
  pools.clear();
}

/**
 * The owner/superuser URL for system-level work, if one is configured.
 *
 * Owner URL first, because RLS is FORCE-enabled on every tenant-carrying table:
 * the app role cannot insert a tenant row without a per-request tenant context,
 * and seeding spans two tenants plus the tenant table itself.
 *
 * Falls back to DATABASE_URL only when no owner credential exists at all, so
 * local development without RLS still works. Under RLS that fallback fails
 * loudly at the first write rather than writing anywhere unexpected.
 *
 * Empty strings are treated as absent: `FGMP_MIGRATE_DATABASE_URL=` in a .env
 * file is a very easy mistake, and Prisma would accept it as "no URL".
 */
export function resolveOwnerDbUrl(env: OwnerDbEnv = process.env): string | undefined {
  return env.FGMP_MIGRATE_DATABASE_URL || env.DATABASE_URL || undefined;
}

/** Whether the owner credential (as opposed to the app-role fallback) is present. */
export function hasOwnerDbUrl(env: OwnerDbEnv = process.env): boolean {
  return Boolean(env.FGMP_MIGRATE_DATABASE_URL);
}
