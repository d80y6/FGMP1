-- CI-only, disposable resource ownership fixture. Never run against a production DB.
-- The caller stays in the seeded t-default tenant; every target below belongs to
-- a distinct customer tenant so the HTTP suite can probe real rows cross-tenant.
BEGIN;

INSERT INTO "Tenant" (id, name, code, country, "createdAt", "updatedAt")
VALUES ('t-idor-target', 'Authorization IDOR target fixture', 'AUTHZ-IDOR-TARGET', 'Test', now(), now())
ON CONFLICT DO NOTHING;

INSERT INTO "Region" (id, "tenantId", name, "createdAt")
VALUES ('r-idor-target', 't-idor-target', 'IDOR fixture region', now())
ON CONFLICT DO NOTHING;

INSERT INTO "Governorate" (id, "regionId", name, "createdAt")
VALUES ('g-idor-target', 'r-idor-target', 'IDOR fixture governorate', now())
ON CONFLICT DO NOTHING;

INSERT INTO "District" (id, "governorateId", name, "createdAt")
VALUES ('d-idor-target', 'g-idor-target', 'IDOR fixture district', now())
ON CONFLICT DO NOTHING;

INSERT INTO "Site" (
  id, "tenantId", code, name, "regionId", "governorateId", "districtId",
  latitude, longitude, address, "createdAt", "updatedAt"
)
VALUES (
  's-idor-target', 't-idor-target', 'AUTHZ-IDOR-SITE', 'IDOR fixture site',
  'r-idor-target', 'g-idor-target', 'd-idor-target',
  15.3, 44.2, 'Disposable CI authorization fixture', now(), now()
)
ON CONFLICT DO NOTHING;

INSERT INTO "User" (
  id, "tenantId", email, name, role, "passwordHash", active, "createdAt", "updatedAt"
)
VALUES (
  'u-idor-target', 't-idor-target', 'idor-target@fgmp.telecom', 'IDOR fixture user',
  'ADMIN', NULL, true, now(), now()
)
ON CONFLICT DO NOTHING;

COMMIT;
