/**
 * ─────────────────────────────────────────────────────────────────────────────
 * GEOGRAPHY READS — through the RLS-filtered `v_geography` view
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY A VIEW AND NOT THE BASE TABLES
 * -----------------------------------
 * `Region` is directly tenant-scoped and RLS-filtered. `Governorate` and
 * `District` carry NO tenantId of their own — tenancy reaches them only through
 * Region — so Phase 1 could not put a `tenant_isolation` policy on them: the
 * column the policy needs does not exist. That left them readable by anyone
 * holding the app credential, across every tenant.
 *
 * The fix (migration 20261007000000_geography_rls) adds a `security_barrier`
 * view that resolves the hierarchy and filters on `Region."tenantId"`, and
 * REVOKEs all access to the base tables from `fgmp_app`. The view is the ONLY
 * way the application can reach geography now, and it is tenant-filtered by
 * construction rather than by a filter the caller might forget.
 *
 * ── WHY $queryRaw INSTEAD OF A PRISEDMA MODEL ──────────────────────────────
 * Prisma has no model for a view: there is no table it introspects, so the
 * relation would have to be maintained by hand in the schema and kept in sync
 * with the migration. A view whose definition is the security boundary should
 * have exactly one definition, in the migration. Reading it with $queryRaw keeps
 * that boundary in one place and removes a schema object that could drift from
 * the SQL that actually enforces isolation.
 *
 * Every call must run INSIDE `withTenant` — the view filters on
 * `current_setting('app.tenant_id')`, so without a context it returns nothing.
 */

/** One row of `v_geography`: a Region joined to its Governorates/Districts. */
export interface GeographyRow {
  regionId: string;
  tenantId: string;
  regionName: string;
  /** Null when a region has no governorates yet (the view uses LEFT JOIN). */
  governorateId: string | null;
  governorateName: string | null;
  districtId: string | null;
  districtName: string | null;
}

/**
 * Resolve a full Region → Governorate → District path for a tenant, in one
 * read against the view.
 *
 * This replaces the previous three independent `findUnique` calls. Those were
 * not merely unscoped — they were read through the ambient client on tables
 * that no policy protected, so the comment claiming the enclosing Region read
 * "gated" them was wrong. The Region check gated whether the WRITE proceeded;
 * it did nothing to the governorate and district reads, which returned any
 * tenant's rows. A caller could therefore pair their own region with another
 * tenant's district.
 *
 * Returns null when any element is missing or is not this tenant's, which the
 * caller turns into a 400/404. Because the view is already tenant-filtered, a
 * cross-tenant id is indistinguishable from a nonexistent one — which is the
 * correct behaviour, and avoids disclosing that the id exists elsewhere.
 */
export async function resolveGeographyPath(
  tx: {
    $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T>;
  },
  params: { regionId: string; governorateId: string; districtId: string },
): Promise<{
  regionName: string;
  governorateName: string;
  districtName: string;
} | null> {
  // A single row must match all three ids AND the hierarchy between them.
  // Matching `regionId` + `governorateId` + `districtId` on one view row proves
  // the chain is internally consistent — that the governorate belongs to that
  // region and the district to that governorate — which three independent
  // lookups could not.
  const rows = await tx.$queryRawUnsafe<GeographyRow[]>(
    `SELECT "regionId", "tenantId", "regionName", "governorateId", "governorateName",
            "districtId", "districtName"
       FROM "v_geography"
      WHERE "regionId" = $1 AND "governorateId" = $2 AND "districtId" = $3
      LIMIT 1`,
    params.regionId,
    params.governorateId,
    params.districtId,
  );
  const row = rows[0];
  if (!row || !row.governorateName || !row.districtName) return null;
  return {
    regionName: row.regionName,
    governorateName: row.governorateName,
    districtName: row.districtName,
  };
}

/**
 * List a tenant's districts, optionally filtered by governorate or region.
 *
 * Used by the geography picker routes so an operator can only ever be offered
 * their own tenant's districts.
 */
export async function listDistricts(
  tx: { $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> },
  filter: { governorateId?: string; regionId?: string } = {},
): Promise<Array<{ id: string; name: string; governorateId: string; governorateName: string; regionId: string }>> {
  const clauses = [`"districtId" IS NOT NULL`];
  const params: unknown[] = [];
  if (filter.governorateId) {
    params.push(filter.governorateId);
    clauses.push(`"governorateId" = $${params.length}`);
  }
  if (filter.regionId) {
    params.push(filter.regionId);
    clauses.push(`"regionId" = $${params.length}`);
  }
  return tx.$queryRawUnsafe<
    Array<{ id: string; name: string; governorateId: string; governorateName: string; regionId: string }>
  >(
    `SELECT "districtId" AS id, "districtName" AS name, "governorateId",
            "governorateName", "regionId"
       FROM "v_geography"
      WHERE ${clauses.join(" AND ")}
      ORDER BY "regionName", "governorateName", "districtName"`,
    ...params,
  );
}

/** List a tenant's governorates, optionally filtered by region. */
export async function listGovernorates(
  tx: { $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> },
  filter: { regionId?: string } = {},
): Promise<Array<{ id: string; name: string; regionId: string; regionName: string }>> {
  const params: unknown[] = [];
  let regionClause = "";
  if (filter.regionId) {
    params.push(filter.regionId);
    regionClause = `AND "regionId" = $${params.length}`;
  }
  return tx.$queryRawUnsafe<Array<{ id: string; name: string; regionId: string; regionName: string }>>(
    `SELECT DISTINCT "governorateId" AS id, "governorateName" AS name, "regionId", "regionName"
       FROM "v_geography"
      WHERE "governorateId" IS NOT NULL ${regionClause}
      ORDER BY "regionName", "governorateName"`,
    ...params,
  );
}