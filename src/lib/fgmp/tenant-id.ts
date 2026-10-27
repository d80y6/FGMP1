/**
 * Coerce a possibly absent tenant id to the non-optional form a scoped query
 * requires, failing closed if there is none. Kept dependency-free so identity
 * narrowing can fail closed without importing Prisma or opening a database.
 *
 * SessionUser.tenantId is optional because a pending MFA session must not carry
 * tenant authority. Never use a non-null assertion here: withTenant would set
 * an invalid/NULL context, potentially making a denial look like an empty
 * result. The MFA route guard is an additional defense, not a replacement for
 * validating the tenant at the query-context boundary.
 */
export function tenantIdOrThrow(tenantId: string | undefined | null): string {
  if (typeof tenantId === "string" && tenantId.trim() !== "") return tenantId.trim();
  throw new Error(
    "[route-tenant] A tenant-scoped call was made without a tenant id. This " +
      "happens when a session is pending multi-factor authentication: such a " +
      "session deliberately carries no tenant and must not be able to query " +
      "anything.",
  );
}
