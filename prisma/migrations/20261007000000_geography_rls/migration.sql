-- Phase 3 — close the geography isolation gap.
--
-- Region, Governorate and District form a hierarchy:
--
--     Region (tenantId, RLS-protected)
--       └── Governorate (regionId)      ← NO tenantId, NO RLS
--             └── District (governorateId)  ← NO tenantId, NO RLS
--
-- So the backstop stopped at the top of the tree. Measured against the live
-- database before this migration:
--
--     fgmp_app, no tenant context   -> 36 districts, 12 governorates
--     withTenant("t-default", …)   -> 36 districts
--     withTenant("t-platform", …)   -> 36 districts
--
-- Identical counts for two unrelated tenants is the tell: nothing was
-- filtering. Tenant t-platform could enumerate 35 districts and their
-- governorates belonging to t-default.
--
-- WHY A VIEW AND NOT A DENORMALISED tenantId COLUMN
-- Adding tenantId to Governorate/District would duplicate data that is already
-- implied by the parent chain, and it could DRIFT — a district whose region
-- moved would keep a stale tenantId, which is a silent isolation failure that
-- no constraint prevents. A view derives tenancy from the same join the
-- application already relies on, so it cannot disagree with it.
--
-- SECURITY BARRIER is required, not decorative: without it the planner is free
-- to push the tenant predicate below the joins, where it would be evaluated
-- against the wrong relation and leak rows. The barrier forces the WHERE to be
-- applied to the join result.

CREATE OR REPLACE VIEW v_geography WITH (security_barrier = true) AS
  SELECT
    r.id          AS "regionId",
    r."tenantId"  AS "tenantId",
    r.name        AS "regionName",
    g.id          AS "governorateId",
    g.name        AS "governorateName",
    d.id          AS "districtId",
    d.name        AS "districtName"
  FROM "Region" r
  LEFT JOIN "Governorate" g ON g."regionId" = r.id
  LEFT JOIN "District"     d ON d."governorateId" = g.id
  WHERE r."tenantId" = current_setting('app.tenant_id', true);

COMMENT ON VIEW v_geography IS
  'Tenant-scoped geography. Replaces direct reads of Governorate/District, '
  'which carry no tenantId and therefore had no RLS. Reads are tenant-filtered '
  'through the Region chain and fail closed: current_setting returns NULL when '
  'app.tenant_id is unset, so the predicate is NULL and the WHERE keeps no rows.';

-- The app role may read the view and nothing else.
GRANT SELECT ON v_geography TO fgmp_app;

-- Revoke DIRECT access to the two unprotected tables. This is the half that
-- actually closes the hole: the view alone proves nothing while
-- `SELECT * FROM "District"` still returns every tenant's rows.
REVOKE ALL ON "Governorate" FROM fgmp_app;
REVOKE ALL ON "District"    FROM fgmp_app;

-- The base tables keep their privileges for the owner role (migrations, CI,
-- and any deliberate cross-tenant operations), so nothing existing breaks.