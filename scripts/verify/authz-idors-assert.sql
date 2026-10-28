-- Assert API probes did not mutate/delete the disposable cross-tenant targets
-- or escalate the caller. The psql session uses the CI migration/ops role.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Site"
    WHERE id = 's-idor-target'
      AND "tenantId" = 't-idor-target'
      AND code = 'AUTHZ-IDOR-SITE'
      AND name = 'IDOR fixture site'
  ) THEN
    RAISE EXCEPTION 'cross-tenant site changed or disappeared during API probes';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "User"
    WHERE id = 'u-idor-target'
      AND "tenantId" = 't-idor-target'
      AND role = 'ADMIN'
      AND active = true
      AND name = 'IDOR fixture user'
  ) THEN
    RAISE EXCEPTION 'cross-tenant user changed or disappeared during API probes';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "User"
    WHERE id = 'u-admin-1'
      AND "tenantId" = 't-default'
      AND role = 'ADMIN'
      AND active = true
  ) THEN
    RAISE EXCEPTION 'tenant administrator was escalated, moved, or deactivated';
  END IF;
END $$;
