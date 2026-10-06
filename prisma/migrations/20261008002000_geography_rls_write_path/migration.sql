-- Phase 3 follow-up — make geography writable AND tenant-filtered.
--
-- ── WHY THIS MIGRATION EXISTS ────────────────────────────────────────────────
-- 20261007000000 correctly closed a real isolation hole: Governorate and District
-- carry no tenantId, so nothing filtered them, and t-platform could enumerate
-- t-default's districts. It added the `v_geography` view and then did
--
--     REVOKE ALL ON "Governorate" FROM fgmp_app;
--     REVOKE ALL ON "District"    FROM fgmp_app;
--
-- REVOKE ALL was the right call for READ and it worked. But `ALL` also removed
-- INSERT, UPDATE and DELETE, and roughly ten route handlers legitimately write
-- geography — creating a governorate, renaming a district, cascading a delete
-- off a region. Those handlers began failing with
--
--     ERROR: permission denied for table Governorate
--
-- which reached the client as a 500. Two sites routes failed on the READ path
-- for the same reason (`include: { governorate: true }`).
--
-- The fix is NOT to hand the privileges back. Undo the grant and the hole
-- reopens. The fix is to give these two tables the same thing every other table
-- in this schema has: a tenantId-derived RLS policy. Then
--
--   * reads are filtered by tenant instead of denied outright,
--   * writes are permitted, because they now run inside a tenant context and
--     the USING/WITH CHECK clauses decide whether they may,
--   * and there is still no path by which `fgmp_app` sees another tenant's rows.
--
-- ── WHY THE POLICY CAN BE WRITTEN AT ALL ─────────────────────────────────────
-- Governorate has no tenantId. It is reachable to exactly one region, and
-- Region DOES carry tenantId and has FORCE RLS. So tenancy is derived by a
-- subquery against the parent rather than read from the row:
--
--     "regionId" IN (SELECT id FROM "Region" WHERE "tenantId" = current_setting(...))
--
-- This is safe for the same reason the view is: Region's own policy filters the
-- subquery, so the subquery can only ever return the caller's own regions. There
-- is no denormalised tenantId to drift out of sync with the parent.
--
-- District reaches Region through Governorate, so its policy is a subquery
-- through two hops. Under plain (non-security-barrier) semantics the planner is
-- free to push the inner predicates down, and each hop is already RLS-protected
-- on its own, so the rewrite cannot widen the result — but the hop is written
-- explicitly to keep that reasoning local to this migration instead of relying
-- on both tables happening to have policies.

ALTER TABLE "Governorate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Governorate" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "District"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "District"    FORCE  ROW LEVEL SECURITY;

-- Read: only rows reachable from a region the caller owns.
CREATE POLICY governorate_tenant_select ON "Governorate"
  FOR SELECT
  USING (
    "regionId" IN (
      SELECT r.id FROM "Region" r
      WHERE r."tenantId" = current_setting('app.tenant_id', true)
    )
  );

-- Write: the row must belong to the caller's region both before and after the
-- change. WITH CHECK is what stops a caller moving a governorate INTO another
-- tenant's region, which USING alone would not catch.
CREATE POLICY governorate_tenant_write ON "Governorate"
  FOR INSERT
  WITH CHECK (
    "regionId" IN (
      SELECT r.id FROM "Region" r
      WHERE r."tenantId" = current_setting('app.tenant_id', true)
    )
  );

CREATE POLICY governorate_tenant_update ON "Governorate"
  FOR UPDATE
  USING (
    "regionId" IN (
      SELECT r.id FROM "Region" r
      WHERE r."tenantId" = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    "regionId" IN (
      SELECT r.id FROM "Region" r
      WHERE r."tenantId" = current_setting('app.tenant_id', true)
    )
  );

CREATE POLICY governorate_tenant_delete ON "Governorate"
  FOR DELETE
  USING (
    "regionId" IN (
      SELECT r.id FROM "Region" r
      WHERE r."tenantId" = current_setting('app.tenant_id', true)
    )
  );

-- District: two hops, via Governorate to Region.
CREATE POLICY district_tenant_select ON "District"
  FOR SELECT
  USING (
    "governorateId" IN (
      SELECT g.id FROM "Governorate" g
      WHERE g."regionId" IN (
        SELECT r.id FROM "Region" r
        WHERE r."tenantId" = current_setting('app.tenant_id', true)
      )
    )
  );

CREATE POLICY district_tenant_write ON "District"
  FOR INSERT
  WITH CHECK (
    "governorateId" IN (
      SELECT g.id FROM "Governorate" g
      WHERE g."regionId" IN (
        SELECT r.id FROM "Region" r
        WHERE r."tenantId" = current_setting('app.tenant_id', true)
      )
    )
  );

CREATE POLICY district_tenant_update ON "District"
  FOR UPDATE
  USING (
    "governorateId" IN (
      SELECT g.id FROM "Governorate" g
      WHERE g."regionId" IN (
        SELECT r.id FROM "Region" r
        WHERE r."tenantId" = current_setting('app.tenant_id', true)
      )
    )
  )
  WITH CHECK (
    "governorateId" IN (
      SELECT g.id FROM "Governorate" g
      WHERE g."regionId" IN (
        SELECT r.id FROM "Region" r
        WHERE r."tenantId" = current_setting('app.tenant_id', true)
      )
    )
  );

CREATE POLICY district_tenant_delete ON "District"
  FOR DELETE
  USING (
    "governorateId" IN (
      SELECT g.id FROM "Governorate" g
      WHERE g."regionId" IN (
        SELECT r.id FROM "Region" r
        WHERE r."tenantId" = current_setting('app.tenant_id', true)
      )
    )
  );

-- Privileges are restored, but now they are policed. This is the difference
-- between "cannot read another tenant" and "cannot read another tenant AND
-- cannot write geography either".
GRANT SELECT, INSERT, UPDATE, DELETE ON "Governorate" TO fgmp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "District"    TO fgmp_app;

COMMENT ON POLICY governorate_tenant_select ON "Governorate" IS
  'Tenancy is derived through Region. Region carries tenantId and has FORCE RLS, so this subquery can only ever return the caller''s own regions. No tenantId is denormalised onto Governorate, so there is nothing to drift.';