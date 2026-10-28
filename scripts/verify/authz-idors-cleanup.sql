-- Remove only the deterministic disposable rows created by
-- authz-idors-fixtures.sql. Safe to call after either a pass or failure.
BEGIN;
DELETE FROM "Site" WHERE id = 's-idor-target' AND "tenantId" = 't-idor-target';
DELETE FROM "User" WHERE id = 'u-idor-target' AND "tenantId" = 't-idor-target';
DELETE FROM "District" WHERE id = 'd-idor-target';
DELETE FROM "Governorate" WHERE id = 'g-idor-target';
DELETE FROM "Region" WHERE id = 'r-idor-target' AND "tenantId" = 't-idor-target';
DELETE FROM "Tenant" WHERE id = 't-idor-target' AND code = 'AUTHZ-IDOR-TARGET';
COMMIT;
