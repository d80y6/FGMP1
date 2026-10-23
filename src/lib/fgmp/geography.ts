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

/**
 * Attach tenant-filtered geography NAMES to a list of rows that carry the ids.
 *
 * `prisma.site.findMany({ include: { governorate: true } })` is no longer
 * available: migration 20261007000000 revoked SELECT on Governorate and District
 * from `fgmp_app`, because those two tables carry no `tenantId` and therefore had
 * no RLS protecting them. Reading them through Prisma now fails at the database
 * with `permission denied for table Governorate`, which surfaced as a 500 on
 * GET /api/fgmp/sites.
 *
 * That 500 was the revocation working as designed — the route had simply not
 * been migrated with it. This helper is the supported replacement: one read of
 * `v_geography`, filtered by tenant, mapped onto the caller's rows.
 *
 * A row whose ids do not resolve is returned with null names rather than being
 * dropped. Dropping would silently change the length of a list a caller is about
 * to page, and an id that is genuinely missing is a data problem to surface, not
 * a row to hide.
 */
export async function attachGeographyNames<T extends {
  regionId: string | null;
  governorateId: string | null;
  districtId: string | null;
  region?: { id: string; name: string } | null;
}>(
  tx: { $queryRawUnsafe<T2>(sql: string, ...params: unknown[]): Promise<T2> },
  rows: readonly T[],
): Promise<
  Array<
    T & {
      region: { id: string; name: string } | null;
      governorate: { id: string; name: string } | null;
      district: { id: string; name: string } | null;
    }
  >
> {
  const regionIds = rows.map((r) => r.regionId).filter((x): x is string => !!x);

  const byRegion = new Map<string, string>();
  const byGov = new Map<string, string>();
  const byDistrict = new Map<string, string>();

  // One query for all three name sets rather than three round-trips per page.
  // `WHERE current_setting(...)` is already inside the view, so this stays
  // tenant-filtered and fails closed with no tenant context.
  const names = await tx.$queryRawUnsafe<
    Array<{ regionId: string; regionName: string; governorateId: string | null; governorateName: string | null; districtId: string | null; districtName: string | null }>
  >(
    `SELECT "regionId", "regionName", "governorateId", "governorateName", "districtId", "districtName"
       FROM "v_geography"`,
  );
  for (const n of names) {
    if (n.governorateId && n.governorateName) byGov.set(n.governorateId, n.governorateName);
    if (n.districtId && n.districtName) byDistrict.set(n.districtId, n.districtName);
  }
  for (const id of regionIds) {
    if (!byRegion.has(id)) {
      const hit = names.find((n) => n.regionId === id);
      if (hit) byRegion.set(id, hit.regionName);
    }
  }

  return rows.map((r) => {
    // Resolve each name once. `has()` followed by `get()!` reads the same map
    // twice and asserts what it just checked; a single lookup that yields a
    // string-or-undefined expresses the same thing without the assertion.
    const regionName = r.regionId ? byRegion.get(r.regionId) : undefined;
    const governorateName = r.governorateId ? byGov.get(r.governorateId) : undefined;
    const districtName = r.districtId ? byDistrict.get(r.districtId) : undefined;
    return {
      ...r,
      region: r.regionId && regionName ? { id: r.regionId, name: regionName } : r.region ?? null,
      governorate: r.governorateId && governorateName ? { id: r.governorateId, name: governorateName } : null,
      district: r.districtId && districtName ? { id: r.districtId, name: districtName } : null,
    };
  });
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