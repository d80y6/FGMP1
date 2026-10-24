-- Tenant-scoped system settings.
--
-- ── THE DEFECT THIS FIXES ────────────────────────────────────────────────────
-- "SystemSetting" was a GLOBAL table: `key` was unique platform-wide and there
-- was no tenantId. The settings API, however, is tenant-scoped: PATCH
-- /api/fgmp/settings requires ROLES.ADMIN_ONLY and the handler writes inside
-- `withTenant(me.tenantId, …)`. With no tenant column there was nothing for that
-- context to constrain, so the tenant context was decorative.
--
-- Measured against a live database (two tenants, both with an ADMIN):
--
--   tenant A  PATCH /api/fgmp/settings {"key":"platformName","value":"OWNED-BY-TENANT-A"}
--   tenant B  GET   /api/fgmp/settings?category=BRANDING
--             → "platformName": "OWNED-BY-TENANT-A"
--
-- One tenant administrator could rewrite every other tenant's alarm thresholds,
-- escalation timers and branding. That is a multi-tenant isolation failure in
-- configuration data, not just a cosmetic one: PLATFORM-category keys
-- (sessionTimeoutMin, maxSitesPerTenant, enableOta) are platform policy.
--
-- ── THE MODEL ───────────────────────────────────────────────────────────────
--   tenantId = <tenant>  → that tenant's override. Uniqueness is (tenantId, key).
--   tenantId = NULL      → a platform default inherited by every tenant. Rows in
--                          this state are read-only to the application role;
--                          they are written by the seed/owner path.
--
-- Existing rows are migrated with tenantId = NULL. That is the only safe choice:
-- a global row cannot be attributed to a tenant, and deleting it would destroy
-- configuration. Its value therefore becomes the inherited default, which is
-- exactly what every tenant saw before this migration — no tenant's effective
-- configuration changes on upgrade.
--
-- ── POLICY SHAPE ────────────────────────────────────────────────────────────
--   SELECT      : own rows + platform defaults (NULL). Platform defaults are
--                 non-sensitive by definition — every tenant could read them
--                 before this migration.
--   INSERT      : WITH CHECK requires a tenant match, so `fgmp_app` cannot mint
--                 a new platform-wide default (nor write another tenant's row).
--   UPDATE      : USING restricts which rows may be touched, WITH CHECK stops a
--                 row being re-pointed at another tenant mid-update.
--   DELETE      : same USING clause as UPDATE.
--
-- The FORCE flag matters for the same reason it does everywhere else in this
-- schema: without FORCE the table owner skips its own policies.

-- 1. Column + referential integrity.
ALTER TABLE "SystemSetting" ADD COLUMN "tenantId" TEXT;

ALTER TABLE "SystemSetting"
  ADD CONSTRAINT "SystemSetting_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Uniqueness moves from platform-wide to per-tenant.
--    Dropping the old unique index is required: with it in place, two tenants
--    could not hold the same key, which is the whole point of the change.
DROP INDEX IF EXISTS "SystemSetting_key_key";

CREATE UNIQUE INDEX "SystemSetting_tenantId_key_key" ON "SystemSetting"("tenantId", "key");

-- Lookups are always (tenant, key) or (tenant, category); the NULL-tenant
-- default rows are matched by key, which the composite index still covers as a
-- leading-column prefix (`tenantId IS NULL` is matched by the btree).
CREATE INDEX "SystemSetting_tenantId_category_idx" ON "SystemSetting"("tenantId", "category");

-- 3. Row level security.
ALTER TABLE "SystemSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SystemSetting" FORCE  ROW LEVEL SECURITY;

CREATE POLICY system_setting_read ON "SystemSetting"
  FOR SELECT
  USING (
    "tenantId" IS NULL
    OR "tenantId" = current_setting('app.tenant_id', true)
  );

CREATE POLICY system_setting_insert ON "SystemSetting"
  FOR INSERT
  WITH CHECK (
    "tenantId" IS NOT NULL
    AND "tenantId" = current_setting('app.tenant_id', true)
  );

CREATE POLICY system_setting_update ON "SystemSetting"
  FOR UPDATE
  USING (
    "tenantId" IS NOT NULL
    AND "tenantId" = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    "tenantId" IS NOT NULL
    AND "tenantId" = current_setting('app.tenant_id', true)
  );

CREATE POLICY system_setting_delete ON "SystemSetting"
  FOR DELETE
  USING (
    "tenantId" IS NOT NULL
    AND "tenantId" = current_setting('app.tenant_id', true)
  );
